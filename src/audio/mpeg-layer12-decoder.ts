/** MPEG-1/2 Audio Layer I & II decoder (ISO 11172-3 / 13818-3). */

import {
    QUANT_CLASSES, TABLE_LSF, chooseAllocTable, SCF_VALUES, requantize,
    SYNTHESIS_WINDOW, type AllocTable,
} from './mpeg-layer12-tables';
import { BitReader } from './mpeg-common';

export interface DecodedMpegAudio {
    readonly channelData: Float32Array[];
    readonly sampleRate: number;
}

const L1_BITRATES_V1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448];
const L2_BITRATES_V1 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
const L1_BITRATES_LSF = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256];
const L2_BITRATES_LSF = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, readonly number[]> = {
    0: [11025, 12000, 8000],
    2: [22050, 24000, 16000],
    3: [44100, 48000, 32000],
};

interface FrameHeader {
    readonly layer: 1 | 2;
    readonly lsf: boolean;
    readonly bitrateKbps: number;
    readonly sampleRate: number;
    readonly channels: number;
    readonly mode: number;
    readonly modeExtension: number;
    readonly crc: boolean;
    readonly frameBytes: number;
    readonly samplesPerFrame: number;
}

function parseHeader(data: Uint8Array, off: number): FrameHeader | null {
    if (off + 4 > data.length) return null;
    if (data[off] !== 0xFF || (data[off + 1] & 0xE0) !== 0xE0) return null;
    const versionBits = (data[off + 1] >> 3) & 3;
    const layerBits = (data[off + 1] >> 1) & 3;
    const crc = ((data[off + 1] & 1) === 0);
    const brIdx = (data[off + 2] >> 4) & 15;
    const srIdx = (data[off + 2] >> 2) & 3;
    const padding = (data[off + 2] >> 1) & 1;
    const mode = (data[off + 3] >> 6) & 3;
    const modeExtension = (data[off + 3] >> 4) & 3;

    if (versionBits === 1 || srIdx === 3 || brIdx === 0 || brIdx === 15) return null;
    if (layerBits !== 3 && layerBits !== 2) return null; // Layers I and II only
    const layer: 1 | 2 = layerBits === 3 ? 1 : 2;
    const lsf = versionBits !== 3;
    const rates = SAMPLE_RATES[versionBits];
    if (!rates) return null;
    const sampleRate = rates[srIdx];

    const bitrateKbps = layer === 1
        ? (lsf ? L1_BITRATES_LSF : L1_BITRATES_V1)[brIdx]
        : (lsf ? L2_BITRATES_LSF : L2_BITRATES_V1)[brIdx];
    if (!bitrateKbps) return null;

    const frameBytes = layer === 1
        ? (Math.floor((12000 * bitrateKbps) / sampleRate) + padding) * 4
        : Math.floor((144000 * bitrateKbps) / sampleRate) + padding;
    if (frameBytes < 8) return null;

    return {
        layer, lsf, bitrateKbps, sampleRate,
        channels: mode === 3 ? 1 : 2,
        mode, modeExtension, crc, frameBytes,
        samplesPerFrame: layer === 1 ? 384 : 1152,
    };
}

/** Skip an ID3v2 tag at the given offset; returns the new offset. */
export function skipId3v2(data: Uint8Array, off: number): number {
    if (off + 10 > data.length) return off;
    if (data[off] !== 0x49 || data[off + 1] !== 0x44 || data[off + 2] !== 0x33) return off;
    const size = ((data[off + 6] & 0x7F) << 21) | ((data[off + 7] & 0x7F) << 14)
        | ((data[off + 8] & 0x7F) << 7) | (data[off + 9] & 0x7F);
    const footer = (data[off + 5] & 0x10) ? 10 : 0;
    return Math.min(data.length, off + 10 + size + footer);
}

/** 32-band polyphase synthesis (ISO 11172-3 2.4.3.2 flow chart). */
class SynthesisFilterbank {
    private readonly v = new Float64Array(1024);
    private static matrix: Float64Array | null = null;

    private static getMatrix(): Float64Array {
        if (!SynthesisFilterbank.matrix) {
            const m = new Float64Array(64 * 32);
            for (let i = 0; i < 64; i++) {
                for (let k = 0; k < 32; k++) {
                    m[i * 32 + k] = Math.cos(((16 + i) * (2 * k + 1) * Math.PI) / 64);
                }
            }
            SynthesisFilterbank.matrix = m;
        }
        return SynthesisFilterbank.matrix;
    }

    /** Convert 32 subband samples into 32 PCM samples. */
    run(subbands: Float64Array, out: Float32Array, outOff: number): void {
        const v = this.v;
        const matrix = SynthesisFilterbank.getMatrix();
        const d = SYNTHESIS_WINDOW;
        v.copyWithin(64, 0, 960);
        for (let i = 0; i < 64; i++) {
            let sum = 0;
            const base = i * 32;
            for (let k = 0; k < 32; k++) sum += matrix[base + k] * subbands[k];
            v[i] = sum;
        }
        for (let j = 0; j < 32; j++) {
            let sum = 0;
            for (let i = 0; i < 8; i++) {
                sum += v[128 * i + j] * d[64 * i + j];
                sum += v[128 * i + 96 + j] * d[64 * i + 32 + j];
            }
            const clipped = sum >= 1 ? 1 : sum <= -1 ? -1 : sum;
            out[outOff + j] = clipped;
        }
    }
}

interface DecodeState {
    readonly synth: SynthesisFilterbank[];
    readonly alloc: Int32Array[];
    readonly scfsi: Int32Array[];
    readonly scf: Int32Array[];
    readonly subbands: Float64Array;
}

function makeState(channels: number): DecodeState {
    return {
        synth: Array.from({ length: channels }, () => new SynthesisFilterbank()),
        alloc: Array.from({ length: channels }, () => new Int32Array(32)),
        scfsi: Array.from({ length: channels }, () => new Int32Array(32)),
        scf: Array.from({ length: channels }, () => new Int32Array(32 * 3)),
        subbands: new Float64Array(2 * 32),
    };
}

function layer2AllocTable(header: FrameHeader): AllocTable {
    if (header.lsf) return TABLE_LSF;
    return chooseAllocTable(header.sampleRate, header.bitrateKbps, header.channels);
}

/** Decode one Layer II frame body into per-channel PCM at pcmOff. */
function decodeLayer2Frame(
    reader: BitReader,
    header: FrameHeader,
    state: DecodeState,
    pcm: Float32Array[],
    pcmOff: number,
): void {
    const table = layer2AllocTable(header);
    const nch = header.channels;
    const sblimit = table.sblimit;
    const bound = header.mode === 1 ? Math.min((header.modeExtension + 1) * 4, sblimit) : sblimit;
    const { alloc, scfsi, scf } = state;

    for (let sb = 0; sb < bound; sb++) {
        for (let ch = 0; ch < nch; ch++) alloc[ch][sb] = reader.read(table.nbal[sb]);
    }
    for (let sb = bound; sb < sblimit; sb++) {
        const shared = reader.read(table.nbal[sb]);
        for (let ch = 0; ch < nch; ch++) alloc[ch][sb] = shared;
    }

    for (let sb = 0; sb < sblimit; sb++) {
        for (let ch = 0; ch < nch; ch++) {
            if (alloc[ch][sb]) scfsi[ch][sb] = reader.read(2);
        }
    }

    for (let sb = 0; sb < sblimit; sb++) {
        for (let ch = 0; ch < nch; ch++) {
            if (!alloc[ch][sb]) continue;
            const pattern = scfsi[ch][sb];
            const base = sb * 3;
            if (pattern === 0) {
                scf[ch][base] = reader.read(6);
                scf[ch][base + 1] = reader.read(6);
                scf[ch][base + 2] = reader.read(6);
            } else if (pattern === 1) {
                const shared = reader.read(6);
                scf[ch][base] = shared;
                scf[ch][base + 1] = shared;
                scf[ch][base + 2] = reader.read(6);
            } else if (pattern === 2) {
                const shared = reader.read(6);
                scf[ch][base] = shared;
                scf[ch][base + 1] = shared;
                scf[ch][base + 2] = shared;
            } else {
                scf[ch][base] = reader.read(6);
                const shared = reader.read(6);
                scf[ch][base + 1] = shared;
                scf[ch][base + 2] = shared;
            }
        }
    }

    const samples = new Float64Array(nch * 3 * 32);
    for (let granule = 0; granule < 12; granule++) {
        const part = granule >> 2;
        samples.fill(0);
        for (let sb = 0; sb < sblimit; sb++) {
            const shared = sb >= bound;
            const chCount = shared ? 1 : nch;
            for (let chIdx = 0; chIdx < chCount; chIdx++) {
                const allocValue = alloc[chIdx][sb];
                if (!allocValue) continue;
                const nlevels = table.rows[sb][allocValue];
                const qc = QUANT_CLASSES.get(nlevels);
                if (!qc) continue;
                let c0: number, c1: number, c2: number;
                if (qc.grouped) {
                    let word = reader.read(qc.wordBits);
                    c0 = word % nlevels; word = (word / nlevels) | 0;
                    c1 = word % nlevels;
                    c2 = (word / nlevels) | 0;
                } else {
                    c0 = reader.read(qc.wordBits);
                    c1 = reader.read(qc.wordBits);
                    c2 = reader.read(qc.wordBits);
                }
                const targets = shared ? nch : 1;
                for (let t = 0; t < targets; t++) {
                    const ch = shared ? t : chIdx;
                    if (!alloc[ch][sb]) continue;
                    const scale = SCF_VALUES[Math.min(62, scf[ch][sb * 3 + part])];
                    const base = ch * 96 + sb;
                    samples[base] = requantize(c0, nlevels) * scale;
                    samples[base + 32] = requantize(c1, nlevels) * scale;
                    samples[base + 64] = requantize(c2, nlevels) * scale;
                }
            }
        }
        for (let ch = 0; ch < nch; ch++) {
            for (let s = 0; s < 3; s++) {
                state.synth[ch].run(
                    samples.subarray(ch * 96 + s * 32, ch * 96 + s * 32 + 32),
                    pcm[ch],
                    pcmOff + (granule * 3 + s) * 32,
                );
            }
        }
    }
}

/** Decode one Layer I frame body into per-channel PCM at pcmOff. */
function decodeLayer1Frame(
    reader: BitReader,
    header: FrameHeader,
    state: DecodeState,
    pcm: Float32Array[],
    pcmOff: number,
): void {
    const nch = header.channels;
    const bound = header.mode === 1 ? Math.min((header.modeExtension + 1) * 4, 32) : 32;
    const { alloc, scf } = state;

    for (let sb = 0; sb < bound; sb++) {
        for (let ch = 0; ch < nch; ch++) alloc[ch][sb] = reader.read(4);
    }
    for (let sb = bound; sb < 32; sb++) {
        const shared = reader.read(4);
        for (let ch = 0; ch < nch; ch++) alloc[ch][sb] = shared;
    }
    for (let sb = 0; sb < 32; sb++) {
        for (let ch = 0; ch < nch; ch++) {
            if (alloc[ch][sb]) scf[ch][sb * 3] = reader.read(6);
        }
    }

    const samples = new Float64Array(nch * 32);
    for (let s = 0; s < 12; s++) {
        samples.fill(0);
        for (let sb = 0; sb < 32; sb++) {
            const shared = sb >= bound;
            const chCount = shared ? 1 : nch;
            for (let chIdx = 0; chIdx < chCount; chIdx++) {
                const allocValue = alloc[chIdx][sb];
                if (!allocValue || allocValue === 15) continue;
                const bits = allocValue + 1;
                const nlevels = (1 << bits) - 1;
                const code = reader.read(bits);
                const targets = shared ? nch : 1;
                for (let t = 0; t < targets; t++) {
                    const ch = shared ? t : chIdx;
                    if (!alloc[ch][sb]) continue;
                    const scale = SCF_VALUES[Math.min(62, scf[ch][sb * 3])];
                    samples[ch * 32 + sb] = requantize(code, nlevels) * scale;
                }
            }
        }
        for (let ch = 0; ch < nch; ch++) {
            state.synth[ch].run(samples.subarray(ch * 32, ch * 32 + 32), pcm[ch], pcmOff + s * 32);
        }
    }
}

/**
 * Decode a raw MPEG-1/2 Layer I or II stream. Skips ID3v2 tags, resyncs over
 * garbage, and drops a truncated final frame. Returns null when no complete
 * frame can be decoded.
 */
export function decodeMpegLayer12(data: Uint8Array): DecodedMpegAudio | null {
    let off = skipId3v2(data, 0);
    let state: DecodeState | null = null;
    let sampleRate = 0;
    let channels = 0;
    const chunks: Float32Array[][] = [];
    let totalSamples = 0;

    while (off + 4 <= data.length) {
        const header = parseHeader(data, off);
        if (!header || off + header.frameBytes > data.length) {
            off++;
            continue;
        }
        // Require the next sync to line up (or end of data) to reject false syncs.
        const next = off + header.frameBytes;
        if (next + 4 <= data.length) {
            const peek = parseHeader(data, next);
            if (!peek && skipId3v2(data, next) === next) {
                off++;
                continue;
            }
        }

        if (!state) {
            sampleRate = header.sampleRate;
            channels = header.channels;
            state = makeState(channels);
        } else if (header.sampleRate !== sampleRate || header.channels !== channels) {
            break; // parameter change mid-stream: stop at the consistent prefix
        }

        const reader = new BitReader(data, (off + (header.crc ? 6 : 4)) * 8);
        const frame = Array.from({ length: channels }, () => new Float32Array(header.samplesPerFrame));
        try {
            if (header.layer === 2) decodeLayer2Frame(reader, header, state, frame, 0);
            else decodeLayer1Frame(reader, header, state, frame, 0);
        } catch {
            // Corrupt frame body (reader overrun): stop at the consistent prefix.
            break;
        }
        chunks.push(frame);
        totalSamples += header.samplesPerFrame;
        off = next;
    }

    if (!state || totalSamples === 0) return null;
    const channelData: Float32Array[] = [];
    for (let ch = 0; ch < channels; ch++) {
        const out = new Float32Array(totalSamples);
        let pos = 0;
        for (const frame of chunks) {
            out.set(frame[ch], pos);
            pos += frame[ch].length;
        }
        channelData.push(out);
    }
    return { channelData, sampleRate };
}
