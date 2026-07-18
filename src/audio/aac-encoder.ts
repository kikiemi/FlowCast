/**
 * AAC-LC encoder (ISO/IEC 14496-3): long windows only, per-band two-loop
 * quantization with noise shaping, full huffman coding, ADTS or raw output.
 */

import { EncodeError } from '../core/errors';
import { BitSink } from '../core/binary-writer';
import {
    AAC_SAMPLE_RATES, SWB_OFFSET_1024, SF_HUFF_BITS, SF_HUFF_CODES,
    SPECTRAL_BOOKS, type SpectralBook,
} from './aac-tables';

const FRAME_LEN = 1024;
const WINDOW_LEN = 2048;
const SF_OFFSET = 100;
const MAX_QUANT = 8191;
const SF_MAX_DELTA = 60;

/** Radix-2 complex FFT with tabulated twiddles and bit-reversal. */
class Fft {
    private readonly wr: Float64Array;
    private readonly wi: Float64Array;
    private readonly rev: Uint32Array;

    constructor(private readonly n: number) {
        this.wr = new Float64Array(n / 2);
        this.wi = new Float64Array(n / 2);
        for (let i = 0; i < n / 2; i++) {
            const angle = (-2 * Math.PI * i) / n;
            this.wr[i] = Math.cos(angle);
            this.wi[i] = Math.sin(angle);
        }
        this.rev = new Uint32Array(n);
        for (let i = 1, j = 0; i < n; i++) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            this.rev[i] = j;
        }
    }

    run(re: Float64Array, im: Float64Array): void {
        const { n, rev, wr, wi } = this;
        for (let i = 0; i < n; i++) {
            const j = rev[i];
            if (i < j) {
                const tr = re[i]; re[i] = re[j]; re[j] = tr;
                const ti = im[i]; im[i] = im[j]; im[j] = ti;
            }
        }
        for (let len = 2; len <= n; len <<= 1) {
            const half = len >> 1;
            const step = n / len;
            for (let base = 0; base < n; base += len) {
                for (let j = 0; j < half; j++) {
                    const cr = wr[j * step];
                    const ci = wi[j * step];
                    const a = base + j;
                    const b = a + half;
                    const xr = re[b] * cr - im[b] * ci;
                    const xi = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - xr;
                    im[b] = im[a] - xi;
                    re[a] += xr;
                    im[a] += xi;
                }
            }
        }
    }
}

/**
 * Forward MDCT (N = 2048) as a complex rotation plus one FFT:
 * X[k] = Re{ e^{-i 2*pi n0 (k+1/2)/N} * FFT_N(x[n] e^{-i pi n/N})[k] },
 * verified against the definitional transform to double precision.
 */
class Mdct {
    private readonly fft = new Fft(WINDOW_LEN);
    private readonly preR = new Float64Array(WINDOW_LEN);
    private readonly preI = new Float64Array(WINDOW_LEN);
    private readonly postR = new Float64Array(FRAME_LEN);
    private readonly postI = new Float64Array(FRAME_LEN);
    private readonly re = new Float64Array(WINDOW_LEN);
    private readonly im = new Float64Array(WINDOW_LEN);

    constructor() {
        const n0 = WINDOW_LEN / 4 + 0.5;
        for (let n = 0; n < WINDOW_LEN; n++) {
            const angle = (-Math.PI * n) / WINDOW_LEN;
            this.preR[n] = Math.cos(angle);
            this.preI[n] = Math.sin(angle);
        }
        for (let k = 0; k < FRAME_LEN; k++) {
            const angle = (-2 * Math.PI * n0 * (k + 0.5)) / WINDOW_LEN;
            this.postR[k] = Math.cos(angle);
            this.postI[k] = Math.sin(angle);
        }
    }

    run(windowed: Float64Array, out: Float64Array): void {
        const { re, im, preR, preI, postR, postI } = this;
        for (let n = 0; n < WINDOW_LEN; n++) {
            re[n] = windowed[n] * preR[n];
            im[n] = windowed[n] * preI[n];
        }
        this.fft.run(re, im);
        for (let k = 0; k < FRAME_LEN; k++) out[k] = re[k] * postR[k] - im[k] * postI[k];
    }
}

const SINE_WINDOW = (() => {
    const w = new Float64Array(WINDOW_LEN);
    for (let n = 0; n < WINDOW_LEN; n++) w[n] = Math.sin((Math.PI / WINDOW_LEN) * (n + 0.5));
    return w;
})();

function samplingFrequencyIndex(sampleRate: number): number {
    const index = AAC_SAMPLE_RATES.indexOf(sampleRate);
    if (index < 0) throw new EncodeError(`encodeAac: unsupported sample rate ${sampleRate}`);
    return index;
}

interface BandInfo {
    readonly offsets: Uint16Array;
    readonly count: number;
}

function bandLayout(srIndex: number): BandInfo {
    const offsets = SWB_OFFSET_1024[srIndex];
    return { offsets, count: offsets.length - 1 };
}

/** Per-band psychoacoustic thresholds (allowed noise energy). */
function computeThresholds(
    spectrum: Float64Array,
    bands: BandInfo,
    sampleRate: number,
    bitrateKbpsPerChannel: number,
    energyOut: Float64Array,
    thresholdOut: Float64Array,
): void {
    const { offsets, count } = bands;
    for (let b = 0; b < count; b++) {
        let energy = 0;
        for (let k = offsets[b]; k < offsets[b + 1]; k++) energy += spectrum[k] * spectrum[k];
        energyOut[b] = energy;
    }
    // Bitrate-scaled SNR target; higher rates demand cleaner bands.
    const snrDb = Math.min(33, Math.max(12, 8 + bitrateKbpsPerChannel * 0.24));
    const ratio = Math.pow(10, -snrDb / 10);
    for (let b = 0; b < count; b++) {
        let masked = energyOut[b];
        if (b > 0) masked += energyOut[b - 1] * 0.3;
        if (b + 1 < count) masked += energyOut[b + 1] * 0.15;
        const width = offsets[b + 1] - offsets[b];
        // Absolute threshold floor: quiet spectral regions may stay quantized to zero.
        const centerHz = ((offsets[b] + offsets[b + 1]) / 2) * (sampleRate / (2 * FRAME_LEN));
        const athDb = centerHz > 14000 ? -48 : centerHz > 9000 ? -66 : -78;
        const athEnergy = Math.pow(10, athDb / 10) * width * 1.0e6;
        thresholdOut[b] = Math.max(masked * ratio, athEnergy);
    }
}

/** Exact huffman bit count for one quantized band under one codebook. */
function bandBits(book: SpectralBook, quant: Int32Array, start: number, end: number): number {
    const { dim, lav, range, signed, bits } = book;
    const escape = lav === 16;
    let total = 0;
    for (let k = start; k < end; k += dim) {
        let index = 0;
        let signBits = 0;
        let escBits = 0;
        for (let d = 0; d < dim; d++) {
            let v = quant[k + d];
            if (signed) {
                index = index * range + (v + lav);
            } else {
                const mag = v < 0 ? -v : v;
                let coded = mag;
                if (escape && mag >= 16) {
                    coded = 16;
                    let pre = 4;
                    while (1 << (pre + 1) <= mag) pre++;
                    escBits += (pre - 4) + 1 + pre;
                }
                if (!escape && mag > lav) return Number.POSITIVE_INFINITY;
                index = index * range + coded;
                if (mag !== 0) signBits++;
                v = mag;
            }
        }
        total += bits[index] + signBits + escBits;
    }
    return total;
}

/** Smallest usable codebooks for a band, cheapest first. */
function chooseBook(quant: Int32Array, start: number, end: number): { book: number; bits: number } {
    let maxAbs = 0;
    let allZero = true;
    for (let k = start; k < end; k++) {
        const v = quant[k] < 0 ? -quant[k] : quant[k];
        if (v > maxAbs) maxAbs = v;
        if (v !== 0) allZero = false;
    }
    if (allZero) return { book: 0, bits: 0 };
    const candidates: number[] = maxAbs <= 1 ? [1, 2]
        : maxAbs <= 2 ? [3, 4]
            : maxAbs <= 4 ? [5, 6]
                : maxAbs <= 7 ? [7, 8]
                    : maxAbs <= 12 ? [9, 10]
                        : [11];
    let bestBook = candidates[0];
    let bestBits = Number.POSITIVE_INFINITY;
    for (const bookIndex of candidates) {
        const book = SPECTRAL_BOOKS[bookIndex] as SpectralBook;
        const cost = bandBits(book, quant, start, end);
        if (cost < bestBits) {
            bestBits = cost;
            bestBook = bookIndex;
        }
    }
    return { book: bestBook, bits: bestBits };
}

function writeSpectral(sink: BitSink, bookIndex: number, quant: Int32Array, start: number, end: number): void {
    const book = SPECTRAL_BOOKS[bookIndex] as SpectralBook;
    const { dim, lav, range, signed, codes, bits } = book;
    const escape = lav === 16;
    for (let k = start; k < end; k += dim) {
        let index = 0;
        for (let d = 0; d < dim; d++) {
            const v = quant[k + d];
            if (signed) {
                index = index * range + (v + lav);
            } else {
                const mag = v < 0 ? -v : v;
                index = index * range + (escape && mag >= 16 ? 16 : mag);
            }
        }
        sink.writeBits(codes[index], bits[index]);
        if (!signed) {
            for (let d = 0; d < dim; d++) {
                const v = quant[k + d];
                if (v !== 0) sink.writeBits(v < 0 ? 1 : 0, 1);
            }
        }
        if (escape) {
            for (let d = 0; d < dim; d++) {
                const mag = quant[k + d] < 0 ? -quant[k + d] : quant[k + d];
                if (mag >= 16) {
                    let pre = 4;
                    while (1 << (pre + 1) <= mag) pre++;
                    for (let i = 0; i < pre - 4; i++) sink.writeBits(1, 1);
                    sink.writeBits(0, 1);
                    sink.writeBits(mag - (1 << pre), pre);
                }
            }
        }
    }
}

interface ChannelPlan {
    readonly quant: Int32Array;
    readonly scalefactors: Int32Array;
    readonly books: Int32Array;
    globalGain: number;
    maxSfb: number;
    bits: number;
}

class ChannelCoder {
    readonly spectrum = new Float64Array(FRAME_LEN);
    readonly pow34 = new Float64Array(FRAME_LEN);
    readonly energy: Float64Array;
    readonly threshold: Float64Array;
    readonly plan: ChannelPlan;
    private readonly overlap = new Float64Array(FRAME_LEN);
    private readonly windowed = new Float64Array(WINDOW_LEN);
    private readonly mdct = new Mdct();

    readonly sfFloor: Int32Array;

    constructor(private readonly bands: BandInfo) {
        this.energy = new Float64Array(bands.count);
        this.threshold = new Float64Array(bands.count);
        this.sfFloor = new Int32Array(bands.count);
        this.plan = {
            quant: new Int32Array(FRAME_LEN),
            scalefactors: new Int32Array(bands.count),
            books: new Int32Array(bands.count),
            globalGain: 0,
            maxSfb: bands.count,
            bits: 0,
        };
    }

    /** Window previous+current 1024-sample blocks and transform. */
    analyze(current: Float64Array): void {
        const { windowed, overlap } = this;
        for (let n = 0; n < FRAME_LEN; n++) {
            windowed[n] = overlap[n] * SINE_WINDOW[n];
            windowed[FRAME_LEN + n] = current[n] * SINE_WINDOW[FRAME_LEN + n];
        }
        overlap.set(current);
        this.mdct.run(windowed, this.spectrum);
        for (let k = 0; k < FRAME_LEN; k++) {
            const v = this.spectrum[k];
            this.pow34[k] = Math.pow(v < 0 ? -v : v, 0.75);
        }
        // Smallest scalefactor per band that keeps quantized values within
        // MAX_QUANT; searching below it silently clips the reconstruction.
        const { offsets, count } = this.bands;
        for (let b = 0; b < count; b++) {
            let peak = 0;
            for (let k = offsets[b]; k < offsets[b + 1]; k++) {
                if (this.pow34[k] > peak) peak = this.pow34[k];
            }
            this.sfFloor[b] = peak > MAX_QUANT
                ? Math.min(255, Math.ceil(SF_OFFSET + (16 / 3) * Math.log2(peak / MAX_QUANT)))
                : 0;
        }
    }

    channelSfFloor(): number {
        let floor = 0;
        for (let b = 0; b < this.bands.count; b++) {
            if (this.sfFloor[b] > floor) floor = this.sfFloor[b];
        }
        return floor;
    }

    /** Quantize the whole channel with a single scalefactor value. */
    quantizeUniform(sf: number): void {
        const { plan, bands } = this;
        plan.scalefactors.fill(sf);
        plan.globalGain = sf;
        this.quantizeBands(0, bands.count);
    }

    quantizeBands(from: number, to: number): void {
        const { plan, bands, pow34, spectrum } = this;
        const { offsets } = bands;
        for (let b = from; b < to; b++) {
            const sf = plan.scalefactors[b];
            const mult = Math.pow(2, (-3 * (sf - SF_OFFSET)) / 16);
            for (let k = offsets[b]; k < offsets[b + 1]; k++) {
                let q = Math.floor(pow34[k] * mult + 0.4054);
                if (q > MAX_QUANT) q = MAX_QUANT;
                plan.quant[k] = spectrum[k] < 0 ? -q : q;
            }
        }
    }

    /** Quantization noise energy in one band for its current scalefactor. */
    bandNoise(b: number): number {
        const { plan, bands, spectrum } = this;
        const { offsets } = bands;
        const step = Math.pow(2, (plan.scalefactors[b] - SF_OFFSET) / 4);
        let noise = 0;
        for (let k = offsets[b]; k < offsets[b + 1]; k++) {
            const q = plan.quant[k] < 0 ? -plan.quant[k] : plan.quant[k];
            const rec = Math.pow(q, 4 / 3) * step;
            const src = spectrum[k] < 0 ? -spectrum[k] : spectrum[k];
            const d = src - rec;
            noise += d * d;
        }
        return noise;
    }

    /** Codebook choice + total ICS payload bits for the current quantization. */
    measureBits(): number {
        const { plan, bands } = this;
        const { offsets, count } = bands;
        let maxSfb = 0;
        for (let b = count - 1; b >= 0; b--) {
            let nonZero = false;
            for (let k = offsets[b]; k < offsets[b + 1]; k++) {
                if (plan.quant[k] !== 0) { nonZero = true; break; }
            }
            if (nonZero) { maxSfb = b + 1; break; }
        }
        plan.maxSfb = maxSfb;

        let spectralBits = 0;
        for (let b = 0; b < maxSfb; b++) {
            const { book, bits } = chooseBook(plan.quant, offsets[b], offsets[b + 1]);
            plan.books[b] = book;
            spectralBits += bits;
        }

        // Section data: runs of equal codebooks, 4 + 5(+escapes) bits each.
        let sectionBits = 0;
        for (let b = 0; b < maxSfb;) {
            let run = 1;
            while (b + run < maxSfb && plan.books[b + run] === plan.books[b]) run++;
            sectionBits += 4;
            let remaining = run;
            while (remaining >= 31) { sectionBits += 5; remaining -= 31; }
            sectionBits += 5;
            b += run;
        }

        // Scalefactor data: dpcm huffman for non-zero books, chained from global_gain.
        let sfBits = 0;
        let previous = plan.globalGain;
        for (let b = 0; b < maxSfb; b++) {
            if (plan.books[b] === 0) continue;
            const dpcm = plan.scalefactors[b] - previous;
            if (dpcm < -SF_MAX_DELTA || dpcm > SF_MAX_DELTA) return Number.POSITIVE_INFINITY;
            sfBits += SF_HUFF_BITS[dpcm + SF_MAX_DELTA];
            previous = plan.scalefactors[b];
        }

        plan.bits = 8 + sectionBits + sfBits + 3 + spectralBits; // global_gain + pulse/tns/gain flags
        return plan.bits;
    }

    computePsy(sampleRate: number, bitratePerChannel: number): void {
        computeThresholds(this.spectrum, this.bands, sampleRate, bitratePerChannel, this.energy, this.threshold);
    }
}

function writeIcs(sink: BitSink, coder: ChannelCoder, bands: BandInfo, writeIcsInfo: boolean): void {
    const { plan } = coder;
    sink.writeBits(plan.globalGain, 8);
    if (writeIcsInfo) writeIcsInfoBits(sink, plan.maxSfb);

    // section_data
    for (let b = 0; b < plan.maxSfb;) {
        let run = 1;
        while (b + run < plan.maxSfb && plan.books[b + run] === plan.books[b]) run++;
        sink.writeBits(plan.books[b], 4);
        let remaining = run;
        while (remaining >= 31) { sink.writeBits(31, 5); remaining -= 31; }
        sink.writeBits(remaining, 5);
        b += run;
    }

    // scale_factor_data
    let previous = plan.globalGain;
    for (let b = 0; b < plan.maxSfb; b++) {
        if (plan.books[b] === 0) continue;
        const dpcm = plan.scalefactors[b] - previous;
        sink.writeBits(SF_HUFF_CODES[dpcm + SF_MAX_DELTA], SF_HUFF_BITS[dpcm + SF_MAX_DELTA]);
        previous = plan.scalefactors[b];
    }

    sink.writeBits(0, 1); // pulse_data_present
    sink.writeBits(0, 1); // tns_data_present
    sink.writeBits(0, 1); // gain_control_data_present

    for (let b = 0; b < plan.maxSfb; b++) {
        if (plan.books[b] === 0) continue;
        writeSpectral(sink, plan.books[b], plan.quant, bands.offsets[b], bands.offsets[b + 1]);
    }
}

function writeIcsInfoBits(sink: BitSink, maxSfb: number): void {
    sink.writeBits(0, 1); // ics_reserved_bit
    sink.writeBits(0, 2); // window_sequence: ONLY_LONG_SEQUENCE
    sink.writeBits(0, 1); // window_shape: sine
    sink.writeBits(maxSfb, 6);
    sink.writeBits(0, 1); // predictor_data_present
}

export interface AacEncodeOptions {
    readonly onProgress?: (encodedFrames: number, totalFrames: number) => void;
}

export interface AacEncodeResult {
    /** Raw AAC access units (one raw_data_block per 1024 samples). */
    readonly frames: Uint8Array[];
    /** AudioSpecificConfig for MP4 muxing. */
    readonly audioSpecificConfig: Uint8Array;
    readonly sampleRate: number;
    readonly channels: number;
    readonly samplesPerFrame: number;
}

/** Encode interleaved float PCM to AAC-LC access units. */
export function encodeAacLc(
    pcm: Float32Array,
    sampleRate: number,
    channels: number,
    bitrateKbps: number,
    options: AacEncodeOptions = {},
): AacEncodeResult {
    if (channels !== 1 && channels !== 2) {
        throw new EncodeError(`encodeAacLc: unsupported channel count ${channels}`);
    }
    const srIndex = samplingFrequencyIndex(sampleRate);
    const bands = bandLayout(srIndex);
    const totalSamples = Math.floor(pcm.length / channels);
    if (totalSamples === 0) throw new EncodeError('encodeAacLc: empty input');
    const totalFrames = Math.ceil(totalSamples / FRAME_LEN) + 1; // final overlap flush

    const bitrate = Math.max(16 * channels, Math.min(320 * channels, bitrateKbps));
    const targetBits = Math.floor((bitrate * 1000 * FRAME_LEN) / sampleRate);
    const perChannelRate = bitrate / channels;

    const coders: ChannelCoder[] = [];
    for (let ch = 0; ch < channels; ch++) coders.push(new ChannelCoder(bands));
    const block = new Float64Array(FRAME_LEN);
    const frames: Uint8Array[] = [];

    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
        const start = frameIndex * FRAME_LEN;
        for (let ch = 0; ch < channels; ch++) {
            for (let n = 0; n < FRAME_LEN; n++) {
                const idx = start + n;
                // 32768: decoders expect spectra in the 16-bit integer domain.
                // 2: the spec forward MDCT is 2*sum(...); the Mdct class computes
                // the plain sum. Verified end-to-end against ffmpeg's decoder.
                block[n] = idx < totalSamples ? pcm[idx * channels + ch] * 65536 : 0;
            }
            coders[ch].analyze(block);
            coders[ch].computePsy(sampleRate, perChannelRate);
        }

        // Element overhead outside ICS payloads.
        const overhead = channels === 1
            ? 3 + 4 + 7 + 3 /* SCE id+tag, END id, align worst case */
            : 3 + 4 + 1 + 8 + 2 + 3 + 7 + 3; /* CPE id+tag+common_window+ics_info+ms_mask, END, align */
        const payloadTarget = Math.max(200, targetBits - overhead);

        // Inner loop: shared scalefactor fitting the bit budget, never below
        // the clipping floor of any channel.
        let low = 0;
        for (const coder of coders) low = Math.max(low, coder.channelSfFloor());
        let high = 255;
        if (low > high) low = high;
        let fitted = high;
        while (low <= high) {
            const mid = (low + high) >> 1;
            let bits = 0;
            for (const coder of coders) {
                coder.quantizeUniform(mid);
                bits += coder.measureBits();
            }
            if (bits <= payloadTarget) {
                fitted = mid;
                high = mid - 1;
            } else {
                low = mid + 1;
            }
        }
        for (const coder of coders) coder.quantizeUniform(fitted);
        let usedBits = 0;
        for (const coder of coders) usedBits += coder.measureBits();

        // Outer loop: spend remaining bits where noise exceeds the threshold.
        for (let pass = 0; pass < 24; pass++) {
            let worst = -1;
            let worstRatio = 1.0;
            let worstCoder: ChannelCoder | null = null;
            for (const coder of coders) {
                for (let b = 0; b < coder.plan.maxSfb; b++) {
                    if (coder.threshold[b] <= 0) continue;
                    const sf = coder.plan.scalefactors[b];
                    if (coder.plan.globalGain - sf >= SF_MAX_DELTA || sf <= 0) continue;
                    if (sf - 2 < coder.sfFloor[b]) continue;
                    const ratio = coder.bandNoise(b) / coder.threshold[b];
                    if (ratio > worstRatio) {
                        worstRatio = ratio;
                        worst = b;
                        worstCoder = coder;
                    }
                }
            }
            if (!worstCoder || worst < 0) break;
            const plan = worstCoder.plan;
            const savedSf = plan.scalefactors[worst];
            plan.scalefactors[worst] = savedSf - 2;
            worstCoder.quantizeBands(worst, worst + 1);
            let bits = 0;
            for (const coder of coders) bits += coder.measureBits();
            if (bits > payloadTarget) {
                plan.scalefactors[worst] = savedSf;
                worstCoder.quantizeBands(worst, worst + 1);
                for (const coder of coders) coder.measureBits();
                break;
            }
            usedBits = bits;
        }
        void usedBits;

        // Bitstream assembly.
        const sink = new BitSink();
        if (channels === 1) {
            sink.writeBits(0, 3); // SCE
            sink.writeBits(0, 4); // element_instance_tag
            writeIcs(sink, coders[0], bands, true);
        } else {
            const maxSfb = Math.max(coders[0].plan.maxSfb, coders[1].plan.maxSfb);
            for (const coder of coders) {
                for (let b = coder.plan.maxSfb; b < maxSfb; b++) coder.plan.books[b] = 0;
                coder.plan.maxSfb = maxSfb;
            }
            sink.writeBits(1, 3); // CPE
            sink.writeBits(0, 4);
            sink.writeBits(1, 1); // common_window
            writeIcsInfoBits(sink, maxSfb);
            sink.writeBits(0, 2); // ms_mask_present: none
            writeIcs(sink, coders[0], bands, false);
            writeIcs(sink, coders[1], bands, false);
        }
        sink.writeBits(7, 3); // END
        sink.alignByte();
        frames.push(sink.toUint8Array());
        options.onProgress?.(frameIndex + 1, totalFrames);
    }

    // AudioSpecificConfig: AAC-LC, srIndex, channel config.
    const asc = new Uint8Array(2);
    asc[0] = (2 << 3) | (srIndex >> 1);
    asc[1] = ((srIndex & 1) << 7) | (channels << 3);

    return { frames, audioSpecificConfig: asc, sampleRate, channels, samplesPerFrame: FRAME_LEN };
}

/** Wrap raw AAC frames in ADTS headers (MPEG-4, no CRC). */
export function wrapAdts(result: AacEncodeResult): Uint8Array<ArrayBuffer> {
    const srIndex = samplingFrequencyIndex(result.sampleRate);
    let total = 0;
    for (const frame of result.frames) total += frame.length + 7;
    const out = new Uint8Array(new ArrayBuffer(total));
    let pos = 0;
    for (const frame of result.frames) {
        const frameLength = frame.length + 7;
        out[pos] = 0xFF;
        out[pos + 1] = 0xF1;
        out[pos + 2] = (1 << 6) | (srIndex << 2) | ((result.channels >> 2) & 1);
        out[pos + 3] = ((result.channels & 3) << 6) | ((frameLength >> 11) & 3);
        out[pos + 4] = (frameLength >> 3) & 0xFF;
        out[pos + 5] = ((frameLength & 7) << 5) | 0x1F;
        out[pos + 6] = 0xFC;
        out.set(frame, pos + 7);
        pos += frameLength;
    }
    return out;
}
