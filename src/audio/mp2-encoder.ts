/** MPEG-1 Layer II encoder (ISO/IEC 11172-3). */

import { MemorySink } from '../io/sinks';
import { EncodeError } from '../core/errors';
import type { MpegAudioEncodeOptions } from './mpeg-audio-types';
import { analysisFilterbank, BitWriter, FrameSizer, MPEG1_SAMPLE_RATES } from './mpeg-common';
import {
    type QuantClass, QUANT_CLASSES, chooseAllocTable, SCF_VALUES,
} from './mpeg-layer12-tables';

/** Legal Layer II bitrates per channel mode (ISO 11172-3 2.4.2.3). */
const MP2_BITRATES_MONO: readonly number[] = [32, 48, 56, 64, 80, 96, 112, 128, 160, 192];
const MP2_BITRATES_STEREO: readonly number[] = [64, 96, 112, 128, 160, 192, 224, 256, 320, 384];
const MP2_HEADER_BITRATES: readonly number[] = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];

export function legalMp2Bitrates(channels: number): readonly number[] {
    return channels === 1 ? MP2_BITRATES_MONO : MP2_BITRATES_STEREO;
}

/** Smallest scalefactor that still covers `peak` (largest usable index). */
function scalefactorIndex(peak: number): number {
    if (!(peak > 0)) return 62;
    let index = 0;
    while (index < 62 && SCF_VALUES[index + 1] >= peak) index++;
    return index;
}

/**
 * Map a normalized sample in [-1, 1] to the transmitted code
 * (ISO Annex C: d = a*x + b, then take sampleBits of d as offset binary).
 * Grouped classes use the code as the digit for degrouping; ungrouped codes
 * are what the decoder MSB-inverts back to two's complement.
 */
function quantizeSample(x: number, qc: QuantClass): number {
    const clamped = x >= 1 ? 1 : x <= -1 ? -1 : x;
    const d = qc.a * clamped + qc.b;
    const half = 1 << (qc.sampleBits - 1);
    let code = d >= 0 ? Math.floor(d * half) + half : Math.floor((d + 1) * half);
    if (code > qc.nlevels - 1) code = qc.nlevels - 1;
    else if (code < 0) code = 0;
    return code;
}

interface ScfsiChoice {
    readonly scfsi: number;
    readonly part0: number;
    readonly part1: number;
    readonly part2: number;
    readonly scfBits: number;
}

/**
 * Scalefactor transmission pattern. Near-equal indices merge to the smaller
 * index (larger scalefactor) so normalized samples stay within [-1, 1].
 */
function chooseScfsi(s0: number, s1: number, s2: number): ScfsiChoice {
    const d01 = Math.abs(s0 - s1);
    const d12 = Math.abs(s1 - s2);
    if (d01 <= 1 && d12 <= 1 && Math.abs(s0 - s2) <= 2) {
        const shared = Math.min(s0, s1, s2);
        return { scfsi: 2, part0: shared, part1: shared, part2: shared, scfBits: 6 };
    }
    if (d01 <= 1) {
        const shared = Math.min(s0, s1);
        return { scfsi: 1, part0: shared, part1: shared, part2: s2, scfBits: 12 };
    }
    if (d12 <= 1) {
        const shared = Math.min(s1, s2);
        return { scfsi: 3, part0: s0, part1: shared, part2: shared, scfBits: 12 };
    }
    return { scfsi: 0, part0: s0, part1: s1, part2: s2, scfBits: 18 };
}

/** Absolute threshold of hearing (Terhardt), in dBFS with 0 dBFS = 96 dB SPL. */
function absoluteThresholdDbfs(frequencyHz: number): number {
    const khz = Math.max(frequencyHz, 20) / 1000;
    const spl = 3.64 * Math.pow(khz, -0.8)
        - 6.5 * Math.exp(-0.6 * (khz - 3.3) * (khz - 3.3))
        + 1e-3 * Math.pow(khz, 4);
    return Math.max(spl - 96, -100);
}

export function encodeMP2(
    pcm: Float32Array,
    sampleRate: number,
    channels: number,
    bitrate = 192,
    options: MpegAudioEncodeOptions = {},
): Blob {
    if (channels !== 1 && channels !== 2) {
        throw new EncodeError(`encodeMP2: channels must be 1 or 2, got ${channels}`);
    }
    const srIdx = MPEG1_SAMPLE_RATES.indexOf(sampleRate);
    if (srIdx < 0) {
        throw new EncodeError(`encodeMP2: unsupported sample rate ${sampleRate} (need 32000/44100/48000)`);
    }
    if (!legalMp2Bitrates(channels).includes(bitrate)) {
        throw new EncodeError(`encodeMP2: ${bitrate} kbps is not a legal Layer II bitrate for ${channels}ch`);
    }
    const brIdx = MP2_HEADER_BITRATES.indexOf(bitrate);

    const nch = channels;
    const mode = nch === 1 ? 3 : 0;
    const table = chooseAllocTable(sampleRate, bitrate, nch);
    const sblimit = table.sblimit;
    const bands = nch * sblimit;

    const totalFrames = Math.ceil(pcm.length / nch / 1152);
    const sizer = new FrameSizer(bitrate, sampleRate);
    const sink = new MemorySink();

    // Buffers reused across frames.
    const frame = new Uint8Array(sizer.maxFrameSize);
    const vbuf: Float64Array[] = [];
    for (let ch = 0; ch < nch; ch++) vbuf.push(new Float64Array(512));
    const win64 = new Float64Array(64);
    const subs = new Float64Array(nch * 36 * 32);
    const scfsiChoices: ScfsiChoice[] = new Array<ScfsiChoice>(bands);
    const alloc = new Uint8Array(bands);
    const smr = new Float64Array(bands);
    const mnr = new Float64Array(bands);
    const active = new Uint8Array(bands);

    const ath = new Float64Array(sblimit);
    for (let sb = 0; sb < sblimit; sb++) {
        ath[sb] = absoluteThresholdDbfs((sb + 0.5) * sampleRate / 64);
    }

    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
        const { size: frameSize, padding } = sizer.next();
        frame.fill(0, 0, frameSize);
        const pcmBase = frameIndex * 1152 * nch;

        frame[0] = 0xFF;
        frame[1] = 0xFD;
        frame[2] = (brIdx << 4) | (srIdx << 2) | (padding << 1);
        frame[3] = mode << 6;

        for (let ch = 0; ch < nch; ch++) {
            const chBase = ch * 36 * 32;
            for (let slot = 0; slot < 36; slot++) {
                analysisFilterbank(pcm, pcmBase + slot * 32 * nch + ch, nch, vbuf[ch], subs, chBase + slot * 32, win64);
            }
        }

        let allocBits = 32;
        for (let sb = 0; sb < sblimit; sb++) allocBits += table.nbal[sb] * nch;

        // Scalefactors per part (12 samples each) and SMR per band.
        for (let ch = 0; ch < nch; ch++) {
            for (let sb = 0; sb < sblimit; sb++) {
                const band = ch * sblimit + sb;
                let framePeak = 0;
                let s0 = 62, s1 = 62, s2 = 62;
                for (let part = 0; part < 3; part++) {
                    let peak = 0;
                    const base = ch * 36 * 32 + part * 12 * 32 + sb;
                    for (let slot = 0; slot < 12; slot++) {
                        const v = Math.abs(subs[base + slot * 32]);
                        if (v > peak) peak = v;
                    }
                    if (peak > framePeak) framePeak = peak;
                    const idx = scalefactorIndex(peak);
                    if (part === 0) s0 = idx;
                    else if (part === 1) s1 = idx;
                    else s2 = idx;
                }
                scfsiChoices[band] = chooseScfsi(s0, s1, s2);
                if (framePeak > 1e-9) {
                    active[band] = 1;
                    smr[band] = 20 * Math.log10(framePeak) - ath[sb];
                } else {
                    active[band] = 0;
                    smr[band] = Number.NEGATIVE_INFINITY;
                }
                alloc[band] = 0;
                mnr[band] = Number.NEGATIVE_INFINITY;
            }
        }

        // Greedy allocation: raise the band with the worst mask-to-noise ratio
        // while its next step still fits the remaining bit budget.
        let bitsLeft = frameSize * 8 - allocBits;
        for (; ;) {
            let best = -1;
            let bestMnr = Number.POSITIVE_INFINITY;
            for (let band = 0; band < bands; band++) {
                if (!active[band]) continue;
                const sb = band % sblimit;
                if (alloc[band] + 1 >= table.rows[sb].length) continue;
                const currentMnr = alloc[band] === 0 ? -smr[band] : mnr[band];
                if (currentMnr < bestMnr) {
                    bestMnr = currentMnr;
                    best = band;
                }
            }
            if (best < 0) break;

            const row = table.rows[best % sblimit];
            const current = alloc[best];
            const nextClass = QUANT_CLASSES.get(row[current + 1]);
            if (!nextClass) {
                active[best] = 0;
                continue;
            }
            let cost = nextClass.grouped ? 12 * nextClass.wordBits : 36 * nextClass.wordBits;
            if (current === 0) {
                cost += 2 + scfsiChoices[best].scfBits;
            } else {
                const currentClass = QUANT_CLASSES.get(row[current]);
                if (currentClass) {
                    cost -= currentClass.grouped ? 12 * currentClass.wordBits : 36 * currentClass.wordBits;
                }
            }
            if (cost > bitsLeft) {
                active[best] = 0;
                continue;
            }
            bitsLeft -= cost;
            alloc[best] = current + 1;
            mnr[best] = nextClass.snrDb - smr[best];
        }

        // Bitstream: allocation, scfsi, scalefactors, samples (12 granules of 3).
        const bits = new BitWriter(frame, 4);
        for (let sb = 0; sb < sblimit; sb++) {
            for (let ch = 0; ch < nch; ch++) {
                bits.put(alloc[ch * sblimit + sb], table.nbal[sb]);
            }
        }
        for (let sb = 0; sb < sblimit; sb++) {
            for (let ch = 0; ch < nch; ch++) {
                const band = ch * sblimit + sb;
                if (alloc[band]) bits.put(scfsiChoices[band].scfsi, 2);
            }
        }
        for (let sb = 0; sb < sblimit; sb++) {
            for (let ch = 0; ch < nch; ch++) {
                const band = ch * sblimit + sb;
                if (!alloc[band]) continue;
                const c = scfsiChoices[band];
                if (c.scfsi === 2) {
                    bits.put(c.part0, 6);
                } else if (c.scfsi === 1) {
                    bits.put(c.part0, 6);
                    bits.put(c.part2, 6);
                } else if (c.scfsi === 3) {
                    bits.put(c.part0, 6);
                    bits.put(c.part1, 6);
                } else {
                    bits.put(c.part0, 6);
                    bits.put(c.part1, 6);
                    bits.put(c.part2, 6);
                }
            }
        }
        for (let granule = 0; granule < 12; granule++) {
            const part = granule >> 2;
            const slotBase = granule * 3;
            for (let sb = 0; sb < sblimit; sb++) {
                for (let ch = 0; ch < nch; ch++) {
                    const band = ch * sblimit + sb;
                    const allocIndex = alloc[band];
                    if (!allocIndex) continue;
                    const qc = QUANT_CLASSES.get(table.rows[sb][allocIndex]);
                    if (!qc) throw new EncodeError(`encodeMP2: invalid allocation state at sb=${sb}`);
                    const c = scfsiChoices[band];
                    const scfIdx = part === 0 ? c.part0 : part === 1 ? c.part1 : c.part2;
                    const inv = 1 / SCF_VALUES[scfIdx];
                    const base = ch * 36 * 32 + slotBase * 32 + sb;
                    const q0 = quantizeSample(subs[base] * inv, qc);
                    const q1 = quantizeSample(subs[base + 32] * inv, qc);
                    const q2 = quantizeSample(subs[base + 64] * inv, qc);
                    if (qc.grouped) {
                        bits.put(q0 + qc.nlevels * (q1 + qc.nlevels * q2), qc.wordBits);
                    } else {
                        bits.put(q0, qc.wordBits);
                        bits.put(q1, qc.wordBits);
                        bits.put(q2, qc.wordBits);
                    }
                }
            }
        }

        if (bits.pos > frameSize * 8) {
            throw new EncodeError(`encodeMP2: frame overflow (${bits.pos} > ${frameSize * 8} bits)`);
        }

        sink.write(frame.subarray(0, frameSize));
        options.onProgress?.({ completedFrames: frameIndex + 1, totalFrames });
    }

    return sink.toBlob('audio/mpeg');
}
