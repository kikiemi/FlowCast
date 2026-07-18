/** Spec-structured MPEG-1 Layer III encoder core. */

import { MemorySink } from '../../io/sinks';
import { EncodeError } from '../../core/errors';
import type { MpegAudioEncodeOptions } from '../mpeg-audio-types';
import { analysisFilterbank, FrameSizer } from '../mpeg-common';
import {
    type HTable,
        SFB_L, SFC_SLEN, LONG_BLOCK_SCF_BANDS, LONG_BLOCK_SCF_SPLIT, GLOBAL_GAIN_BIAS,
    HT0, HT32, HT33, HTABLES, SR_TAB, BR_TAB, Bits,
    mdct18, applyFrequencyInversion, applyAntialias,
    candidateTables, tableMaxValue,
} from './tables';

/** Largest quantized magnitude representable by any Huffman table (15 + 13-bit linbits). */
const Q_MAX = 8206;
const POW43 = new Float64Array(Q_MAX + 1);
for (let q = 0; q <= Q_MAX; q++) POW43[q] = Math.pow(q, 4 / 3);

function pow43(q: number): number {
    return q <= Q_MAX ? POW43[q] : Math.pow(q, 4 / 3);
}

/** Reusable per-granule buffers; one instance per encodeMP3 call. */
interface GranWork {
    /** |spec| for the current granule. */
    readonly abs: Float64Array;
    /** |spec|^0.75 for the current granule. */
    readonly xr34: Float64Array;
    /** Error weights (loudness emphasis) for the current granule. */
    readonly weight: Float64Array;
    /** Per-band max of xr34 (for the gain lower bound). */
    readonly bandXr34Max: Float64Array;
    /** Quantization workspace and acceptance copies. */
    readonly scratch: Int16Array;
    readonly underQ: Int16Array;
    readonly overQ: Int16Array;
    readonly pickQ: Int16Array;
    readonly bestQ: Int16Array;
    readonly bestSf: Uint8Array;
    /** Gain deduplication (generation-tagged). */
    readonly seenGain: Int32Array;
    seenGeneration: number;
}

function makeGranWork(bandCount: number): GranWork {
    return {
        abs: new Float64Array(576),
        xr34: new Float64Array(576),
        weight: new Float64Array(576),
        bandXr34Max: new Float64Array(bandCount),
        scratch: new Int16Array(576),
        underQ: new Int16Array(576),
        overQ: new Int16Array(576),
        pickQ: new Int16Array(576),
        bestQ: new Int16Array(576),
        bestSf: new Uint8Array(LONG_BLOCK_SCF_BANDS),
        seenGain: new Int32Array(256),
        seenGeneration: 0,
    };
}

/** Fill the per-granule caches from the spectrum. */
function prepareGranule(spec: Float64Array, off: number, sfb_l: number[], work: GranWork): void {
    const { abs, xr34, weight, bandXr34Max } = work;
    let peak = 0;
    for (let i = 0; i < 576; i++) {
        const a = Math.abs(spec[off + i]);
        abs[i] = a;
        xr34[i] = a <= 1e-20 ? 0 : Math.pow(a, 0.75);
        if (a > peak) peak = a;
    }
    const invPeak = peak > 1e-18 ? 1 / peak : 0;
    for (let sfb = 0; sfb < sfb_l.length - 1; sfb++) {
        const bandBoost = sfb < 8 ? 1.5 : 0;
        let bandMax = 0;
        for (let i = sfb_l[sfb]; i < sfb_l[sfb + 1]; i++) {
            weight[i] = 1 + 8 * abs[i] * invPeak + bandBoost;
            if (xr34[i] > bandMax) bandMax = xr34[i];
        }
        bandXr34Max[sfb] = bandMax;
    }
}

/**
 * Quantize one line: q ~ round(|x|^0.75 * istep - 0.0946), then refine +-1
 * against the actual reconstruction levels.
 */
function quantizeLine(absValue: number, xr34: number, istep: number, reconScale: number): number {
    if (absValue <= 1e-20) return 0;
    const x = xr34 * istep - 0.0946;
    const qBase = Math.max(0, Math.round(x));
    let bestQ = 0;
    let bestErr = absValue;
    const qMin = Math.max(0, qBase - 1);
    const qMax = qBase + 1;
    for (let q = qMin; q <= qMax; q++) {
        const recon = q === 0 ? 0 : pow43(q) * reconScale;
        const err = Math.abs(absValue - recon);
        if (err < bestErr - 1e-12 || (Math.abs(err - bestErr) <= 1e-12 && q < bestQ)) {
            bestErr = err;
            bestQ = q;
        }
    }
    return bestQ;
}

function bandQuantizerMul(scalefac: number, scalefacScale: 0 | 1): number {
    return Math.pow(2.0, 0.375 * (scalefacScale + 1) * scalefac);
}

function bandReconMul(scalefac: number, scalefacScale: 0 | 1): number {
    return Math.pow(2.0, -0.5 * (scalefacScale + 1) * scalefac);
}

function quantize(
    spec: Float64Array,
    off: number,
    gain: number,
    q: Int16Array,
    scalefactors: Uint8Array,
    scalefacScale: 0 | 1,
    sfb_l: number[],
    work: GranWork,
): void {
    const baseIstep = Math.pow(2.0, -0.1875 * (gain - GLOBAL_GAIN_BIAS));
    const baseReconScale = Math.pow(2.0, 0.25 * (gain - GLOBAL_GAIN_BIAS));
    const { abs, xr34 } = work;
    for (let sfb = 0; sfb < sfb_l.length - 1; sfb++) {
        const scalefac = sfb < LONG_BLOCK_SCF_BANDS ? scalefactors[sfb] : 0;
        const istep = baseIstep * bandQuantizerMul(scalefac, scalefacScale);
        const reconScale = baseReconScale * bandReconMul(scalefac, scalefacScale);
        for (let i = sfb_l[sfb]; i < sfb_l[sfb + 1]; i++) {
            const vq = quantizeLine(abs[i], xr34[i], istep, reconScale);
            q[i] = spec[off + i] < 0 ? -vq : vq;
        }
    }
}

/** Weighted squared reconstruction error over the granule. */
function reconstructionError(
    gain: number,
    q: Int16Array,
    scalefactors: Uint8Array,
    scalefacScale: 0 | 1,
    sfb_l: number[],
    work: GranWork,
): number {
    const baseReconScale = Math.pow(2.0, 0.25 * (gain - GLOBAL_GAIN_BIAS));
    const { abs, weight } = work;
    let err = 0;
    for (let sfb = 0; sfb < sfb_l.length - 1; sfb++) {
        const scalefac = sfb < LONG_BLOCK_SCF_BANDS ? scalefactors[sfb] : 0;
        const reconScale = baseReconScale * bandReconMul(scalefac, scalefacScale);
        for (let i = sfb_l[sfb]; i < sfb_l[sfb + 1]; i++) {
            const aq = q[i] < 0 ? -q[i] : q[i];
            const diff = abs[i] - pow43(aq) * reconScale;
            err += diff * diff * weight[i];
        }
    }
    return err;
}

function computeRegions(q: Int16Array): [number, number, number] {
    let lastNonZero = -1;
    for (let i = 575; i >= 0; i--) {
        if (q[i] !== 0) {
            lastNonZero = i;
            break;
        }
    }
    let count1End = lastNonZero + 1;
    if (count1End % 2 === 1) count1End++;
    let bigEnd = count1End;
    while (bigEnd >= 4) {
        const a = Math.abs(q[bigEnd - 1]);
        const b = Math.abs(q[bigEnd - 2]);
        const c = Math.abs(q[bigEnd - 3]);
        const d = Math.abs(q[bigEnd - 4]);
        if (a <= 1 && b <= 1 && c <= 1 && d <= 1) bigEnd -= 4;
        else break;
    }
    const bigValues = bigEnd >> 1;
    return [bigValues, bigEnd, count1End];
}

function countBigValueBitsRange(q: Int16Array, pairStart: number, pairEnd: number, table: HTable): number {
    const mv = table.maxval;
    const lb = table.linbits;
    let bits = 0;
    for (let p = pairStart; p < pairEnd; p++) {
        const ax = Math.abs(q[p * 2]);
        const ay = Math.abs(q[p * 2 + 1]);
        const hx = Math.min(ax, mv);
        const hy = Math.min(ay, mv);
        const entry = table.entries[hx * table.xlen + hy];
        if (!entry) return Number.POSITIVE_INFINITY;
        bits += entry[0];
        if (lb > 0 && ax >= mv) bits += lb;
        if (lb > 0 && ay >= mv) bits += lb;
        if (ax) bits++;
        if (ay) bits++;
    }
    return bits;
}

function countCount1Bits(q: Int16Array, count1Start: number, count1End: number, table: 0 | 1): number {
    const ht = table === 0 ? HT32 : HT33;
    let bits = 0;
    for (let i = count1Start; i < count1End; i += 4) {
        const av = Math.abs(q[i]);
        const aw = Math.abs(q[i + 1]);
        const ax = Math.abs(q[i + 2]);
        const ay = Math.abs(q[i + 3]);
        const idx = (av ? 8 : 0) | (aw ? 4 : 0) | (ax ? 2 : 0) | (ay ? 1 : 0);
        bits += ht[idx][0] + av + aw + ax + ay;
    }
    return bits;
}

function regionPairBoundaries(bigValues: number, region0Count: number, region1Count: number, sfb_l: number[]): [number, number] {
    const r0Band = Math.min(region0Count + 1, sfb_l.length - 1);
    const r1Band = Math.min(region0Count + 1 + region1Count + 1, sfb_l.length - 1);
    const region0Pairs = Math.min(bigValues, sfb_l[r0Band] >> 1);
    const region1Pairs = Math.min(bigValues, sfb_l[r1Band] >> 1);
    return [region0Pairs, region1Pairs];
}

function maxValueInPairRange(q: Int16Array, pairStart: number, pairEnd: number): number {
    let max = 0;
    for (let p = pairStart; p < pairEnd; p++) {
        const ax = Math.abs(q[p * 2]);
        const ay = Math.abs(q[p * 2 + 1]);
        if (ax > max) max = ax;
        if (ay > max) max = ay;
    }
    return max;
}

function computeRegionCounts(bigValues: number, sfb_l: number[]): [number, number] {
    const bigEnd = bigValues * 2;
    let bandEnd = 0;
    while (bandEnd < sfb_l.length - 1 && sfb_l[bandEnd + 1] < bigEnd) bandEnd++;
    const region0 = Math.max(0, Math.min(15, Math.floor(bandEnd / 3) - 1));
    const region1 = Math.max(0, Math.min(7, bandEnd - (region0 + 1) - 1));
    return [region0, region1];
}

interface RegionChoice {
    readonly tableSelect: [number, number, number];
    readonly region0Count: number;
    readonly region1Count: number;
    readonly bigValueBits: number;
}

function selectRegionTables(q: Int16Array, bigValues: number, sfb_l: number[]): RegionChoice | null {
    if (bigValues === 0) {
        return { tableSelect: [0, 0, 0], region0Count: 0, region1Count: 0, bigValueBits: 0 };
    }
    const [region0Count, region1Count] = computeRegionCounts(bigValues, sfb_l);
    const [region0Pairs, region1Pairs] = regionPairBoundaries(bigValues, region0Count, region1Count, sfb_l);
    const ranges: [number, number][] = [
        [0, Math.min(bigValues, region0Pairs)],
        [Math.min(bigValues, region0Pairs), Math.min(bigValues, region1Pairs)],
        [Math.min(bigValues, region1Pairs), bigValues],
    ];
    const tableSelect: [number, number, number] = [0, 0, 0];
    let totalBits = 0;
    for (let r = 0; r < 3; r++) {
        const [start, end] = ranges[r];
        if (end <= start) {
            tableSelect[r] = 0;
            continue;
        }
        const maxVal = maxValueInPairRange(q, start, end);
        const candidates = candidateTables(maxVal);
        if (candidates.length === 0) return null;
        let bestBits = Number.POSITIVE_INFINITY;
        let bestTable = -1;
        for (const table of candidates) {
            const bits = countBigValueBitsRange(q, start, end, table);
            if (bits < bestBits) {
                bestBits = bits;
                bestTable = table.id;
            }
        }
        if (bestTable < 0 || !Number.isFinite(bestBits)) return null;
        tableSelect[r] = bestTable;
        totalBits += bestBits;
    }
    return { tableSelect, region0Count, region1Count, bigValueBits: totalBits };
}

interface ScaleFactorProfile {
    readonly scalefacCompress: number;
    readonly scalefacScale: 0 | 1;
    readonly part2Length: number;
    readonly scalefactors: Uint8Array;
}

function pickScaleFactorCompress(scalefactors: Uint8Array, scalefacScale: 0 | 1): ScaleFactorProfile | null {
    let maxSlen1 = 0;
    let maxSlen2 = 0;
    for (let sfb = 0; sfb < LONG_BLOCK_SCF_BANDS; sfb++) {
        if (sfb < LONG_BLOCK_SCF_SPLIT) maxSlen1 = Math.max(maxSlen1, scalefactors[sfb]);
        else maxSlen2 = Math.max(maxSlen2, scalefactors[sfb]);
    }
    let best: ScaleFactorProfile | null = null;
    for (let scalefacCompress = 0; scalefacCompress < SFC_SLEN.length; scalefacCompress++) {
        const [slen1, slen2] = SFC_SLEN[scalefacCompress];
        if (maxSlen1 >= (1 << slen1) || maxSlen2 >= (1 << slen2)) continue;
        const part2Length = LONG_BLOCK_SCF_SPLIT * slen1 + (LONG_BLOCK_SCF_BANDS - LONG_BLOCK_SCF_SPLIT) * slen2;
        if (!best || part2Length < best.part2Length) best = { scalefacCompress, scalefacScale, part2Length, scalefactors };
    }
    return best;
}

interface BandModel {
    readonly thresholds: Float64Array;
    readonly peaks: Float64Array;
}

function buildBandModel(
    sfb_l: number[],
    work: GranWork,
    sampleRate: number,
    bitsPerChannelFrame: number,
): BandModel {
    const thresholds = new Float64Array(LONG_BLOCK_SCF_BANDS);
    const peaks = new Float64Array(LONG_BLOCK_SCF_BANDS);
    const energies = new Float64Array(LONG_BLOCK_SCF_BANDS);
    const tonalOffset = new Float64Array(LONG_BLOCK_SCF_BANDS);
    const { abs } = work;

    for (let sfb = 0; sfb < LONG_BLOCK_SCF_BANDS; sfb++) {
        let energy = 0;
        let peak = 0;
        let sumLog = 0;
        const start = sfb_l[sfb];
        const end = sfb_l[sfb + 1];
        const width = Math.max(1, end - start);
        for (let i = start; i < end; i++) {
            const v = abs[i];
            if (v > peak) peak = v;
            energy += v * v;
            sumLog += Math.log(v + 1e-12);
        }
        energies[sfb] = energy;
        peaks[sfb] = peak;
        const rms = Math.sqrt(energy / width + 1e-30);
        const flatness = Math.exp(sumLog / width) / Math.max(rms, 1e-12);
        // Tonal maskers mask less than noise (TMN ~18 dB vs NMT ~6 dB).
        const tonality = Math.min(1, Math.max(0, (0.6 - flatness) / 0.5));
        tonalOffset[sfb] = 6 + tonality * 12;
    }

    // Spread masking energy across bands: steep toward lower bands, shallow
    // upward, approximating bark-domain slopes on the sfb grid.
    const spread = new Float64Array(LONG_BLOCK_SCF_BANDS);
    for (let sfb = 0; sfb < LONG_BLOCK_SCF_BANDS; sfb++) {
        let acc = energies[sfb];
        let gain = 1;
        for (let j = sfb - 1; j >= 0 && gain > 1e-4; j--) {
            gain *= 0.05; // upward spread from lower-band maskers: -13 dB/band
            acc += energies[j] * gain;
        }
        gain = 1;
        for (let j = sfb + 1; j < LONG_BLOCK_SCF_BANDS && gain > 1e-4; j++) {
            gain *= 0.006; // downward spread from higher-band maskers: -22 dB/band
            acc += energies[j] * gain;
        }
        spread[sfb] = acc;
    }

    // More bits per frame allow a lower noise target.
    const rateBonusDb = Math.min(10, Math.max(-4, (bitsPerChannelFrame - 1600) / 220));
    const binHz = sampleRate / 1152;
    for (let sfb = 0; sfb < LONG_BLOCK_SCF_BANDS; sfb++) {
        const snrDb = tonalOffset[sfb] + rateBonusDb;
        const masked = spread[sfb] * Math.pow(10, -snrDb / 10);
        // Absolute threshold of hearing floor (0 dBFS = 96 dB SPL).
        const centerHz = Math.max(20, ((sfb_l[sfb] + sfb_l[sfb + 1]) / 2) * binHz);
        const khz = centerHz / 1000;
        const athSpl = 3.64 * Math.pow(khz, -0.8)
            - 6.5 * Math.exp(-0.6 * (khz - 3.3) * (khz - 3.3))
            + 1e-3 * Math.pow(khz, 4);
        const athAmp = Math.pow(10, (Math.min(athSpl, 40) - 96) / 20);
        const width = Math.max(1, sfb_l[sfb + 1] - sfb_l[sfb]);
        thresholds[sfb] = Math.max(masked, athAmp * athAmp * width * 0.5, 1e-14);
    }
    return { thresholds, peaks };
}

interface BandNoiseMetrics {
    readonly worstRatio: number;
    readonly totalExcess: number;
    readonly loudExcess: number;
    readonly sortedBands: number[];
}

function evaluateBandNoise(
    gain: number,
    q: Int16Array,
    scalefactors: Uint8Array,
    scalefacScale: 0 | 1,
    sfb_l: number[],
    model: BandModel,
    work: GranWork,
): BandNoiseMetrics {
    const baseReconScale = Math.pow(2.0, 0.25 * (gain - GLOBAL_GAIN_BIAS));
    const { abs } = work;
    const ratios = new Float64Array(LONG_BLOCK_SCF_BANDS);
    let worstRatio = 0;
    let totalExcess = 0;
    let loudExcess = 0;
    for (let sfb = 0; sfb < LONG_BLOCK_SCF_BANDS; sfb++) {
        const reconScale = baseReconScale * bandReconMul(scalefactors[sfb], scalefacScale);
        let noiseEnergy = 0;
        for (let i = sfb_l[sfb]; i < sfb_l[sfb + 1]; i++) {
            const aq = q[i] < 0 ? -q[i] : q[i];
            const diff = abs[i] - pow43(aq) * reconScale;
            noiseEnergy += diff * diff;
        }
        const ratio = noiseEnergy / Math.max(model.thresholds[sfb], 1e-18);
        ratios[sfb] = ratio;
        if (ratio > worstRatio) worstRatio = ratio;
        if (ratio > 1) {
            totalExcess += ratio - 1;
            if (sfb < 11) loudExcess += ratio - 1;
        }
    }
    const sortedBands = Array.from({ length: LONG_BLOCK_SCF_BANDS }, (_, i) => i).sort((a, b) => ratios[b] - ratios[a]);
    return { worstRatio, totalExcess, loudExcess, sortedBands };
}

function nextScalefactors(current: Uint8Array, metrics: BandNoiseMetrics, model: BandModel): Uint8Array | null {
    const next = new Uint8Array(current.length);
    next.set(current);
    let changed = 0;
    for (let rank = 0; rank < metrics.sortedBands.length && rank < 3; rank++) {
        const sfb = metrics.sortedBands[rank];
        const maxSf = model.peaks[sfb] > 0.2 ? 15 : 12;
        const boost = rank === 0 ? 2 : 1;
        if (next[sfb] < maxSf) {
            next[sfb] = Math.min(maxSf, next[sfb] + boost);
            changed++;
        }
        if (changed >= 2) break;
    }
    return changed > 0 ? next : null;
}

function quantizePeakPow(scalefactors: Uint8Array, scalefacScale: 0 | 1, sfb_l: number[], work: GranWork): number {
    let peakPow = 0;
    const { bandXr34Max } = work;
    for (let sfb = 0; sfb < sfb_l.length - 1; sfb++) {
        const scalefac = sfb < LONG_BLOCK_SCF_BANDS ? scalefactors[sfb] : 0;
        const v = bandXr34Max[sfb] * bandQuantizerMul(scalefac, scalefacScale);
        if (v > peakPow) peakPow = v;
    }
    return peakPow;
}

/** Granule encoding result; q and scalefactors live in caller-owned slots. */
interface GranEnc {
    globalGain: number;
    bigValues: number;
    count1Start: number;
    count1End: number;
    tableSelect: [number, number, number];
    region0Count: number;
    region1Count: number;
    count1Table: 0 | 1;
    scalefacCompress: number;
    scalefacScale: 0 | 1;
    part2Length: number;
    part23Length: number;
    error: number;
}

function zeroGranule(): GranEnc {
    return {
        globalGain: 255,
        bigValues: 0,
        count1Start: 0,
        count1End: 0,
        tableSelect: [0, 0, 0],
        region0Count: 0,
        region1Count: 0,
        count1Table: 0,
        scalefacCompress: 0,
        scalefacScale: 0,
        part2Length: 0,
        part23Length: 0,
        error: Number.POSITIVE_INFINITY,
    };
}

function buildGranuleAtGain(
    spec: Float64Array,
    off: number,
    gain: number,
    profile: ScaleFactorProfile,
    sfb_l: number[],
    work: GranWork,
): GranEnc | null {
    const scratch = work.scratch;
    quantize(spec, off, gain, scratch, profile.scalefactors, profile.scalefacScale, sfb_l, work);
    const [bigValues, count1Start, count1End] = computeRegions(scratch);
    const regionTables = selectRegionTables(scratch, bigValues, sfb_l);
    if (!regionTables) return null;
    const count1Bits32 = countCount1Bits(scratch, count1Start, count1End, 0);
    const count1Bits33 = countCount1Bits(scratch, count1Start, count1End, 1);
    const count1Table: 0 | 1 = count1Bits32 <= count1Bits33 ? 0 : 1;
    const part3Length = regionTables.bigValueBits + Math.min(count1Bits32, count1Bits33);
    return {
        globalGain: gain,
        bigValues,
        count1Start,
        count1End,
        tableSelect: regionTables.tableSelect,
        region0Count: regionTables.region0Count,
        region1Count: regionTables.region1Count,
        count1Table,
        scalefacCompress: profile.scalefacCompress,
        scalefacScale: profile.scalefacScale,
        part2Length: profile.part2Length,
        part23Length: profile.part2Length + part3Length,
        error: reconstructionError(gain, scratch, profile.scalefactors, profile.scalefacScale, sfb_l, work),
    };
}

interface GainPick {
    readonly meta: GranEnc;
    /** True when meta satisfied the bit budget (q is in work.underQ, else work.overQ). */
    readonly under: boolean;
}

function findGainForBudget(
    spec: Float64Array,
    off: number,
    targetBudget: number,
    profile: ScaleFactorProfile,
    sfb_l: number[],
    work: GranWork,
): GainPick | null {
    const peakPow = quantizePeakPow(profile.scalefactors, profile.scalefacScale, sfb_l, work);
    let lo = 0;
    if (peakPow > 1e-20) {
        const maxTable = HTABLES[31];
        if (maxTable) {
            const minIstep = (tableMaxValue(maxTable) + 0.5) / peakPow;
            lo = Math.floor(GLOBAL_GAIN_BIAS - Math.log2(minIstep) / 0.1875);
            lo = Math.max(0, Math.min(255, lo));
        }
    }
    let hi = 255;
    const found: { under: GranEnc | null; over: GranEnc | null } = { under: null, over: null };
    work.seenGeneration++;
    const generation = work.seenGeneration;

    const evaluate = (gain: number): GranEnc | null => {
        if (work.seenGain[gain] === generation) return null;
        work.seenGain[gain] = generation;
        const cand = buildGranuleAtGain(spec, off, gain, profile, sfb_l, work);
        if (!cand) return null;
        if (cand.part23Length <= targetBudget) {
            const prev = found.under;
            if (!prev || cand.error < prev.error
                || (cand.error === prev.error && cand.part23Length < prev.part23Length)) {
                found.under = cand;
                work.underQ.set(work.scratch);
            }
        } else {
            const prev = found.over;
            if (!prev || cand.part23Length < prev.part23Length
                || (cand.part23Length === prev.part23Length && cand.error < prev.error)) {
                found.over = cand;
                work.overQ.set(work.scratch);
            }
        }
        return cand;
    };

    for (let iter = 0; iter < 6 && lo <= hi; iter++) {
        const mid = (lo + hi) >> 1;
        const cand = evaluate(mid);
        if (!cand) {
            lo = mid + 1;
            continue;
        }
        if (cand.part23Length > targetBudget) lo = mid + 1;
        else hi = mid - 1;
    }
    const center = found.under ? found.under.globalGain : lo;
    const probeStart = Math.max(0, center - 3);
    const probeEnd = Math.min(255, center + 6);
    for (let g = probeStart; g <= probeEnd; g++) evaluate(g);

    if (found.under) return { meta: found.under, under: true };
    if (found.over) return { meta: found.over, under: false };
    return null;
}

function encodeGranuleFast(
    spec: Float64Array,
    off: number,
    targetBudget: number,
    sfb_l: number[],
    sampleRate: number,
    work: GranWork,
    outQ: Int16Array,
    outSf: Uint8Array,
): GranEnc {
    outQ.fill(0);
    outSf.fill(0);
    if (targetBudget <= 0) return zeroGranule();
    prepareGranule(spec, off, sfb_l, work);
    const model = buildBandModel(sfb_l, work, sampleRate, targetBudget * 2);
    let best: GranEnc | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const scalefacScale of [0, 1] as const) {
        let scalefactors: Uint8Array = new Uint8Array(LONG_BLOCK_SCF_BANDS);
        for (let iter = 0; iter < 3; iter++) {
            const profile = pickScaleFactorCompress(scalefactors, scalefacScale);
            if (!profile || profile.part2Length >= targetBudget) break;
            const pick = findGainForBudget(spec, off, targetBudget, profile, sfb_l, work);
            if (!pick) break;
            const cand = pick.meta;
            const candQ = pick.under ? work.underQ : work.overQ;
            const metrics = evaluateBandNoise(cand.globalGain, candQ, profile.scalefactors, cand.scalefacScale, sfb_l, model, work);
            const score = cand.error + metrics.totalExcess * 450 + metrics.loudExcess * 900 + metrics.worstRatio * 50;
            if (
                !best
                || (cand.part23Length <= targetBudget && best.part23Length > targetBudget)
                || (
                    (cand.part23Length <= targetBudget) === (best.part23Length <= targetBudget)
                    && score < bestScore - 1e-9
                )
            ) {
                best = cand;
                best.error = score;
                bestScore = score;
                work.bestQ.set(candQ);
                work.bestSf.set(profile.scalefactors);
            }
            if (metrics.worstRatio <= 1.05 && metrics.totalExcess <= 0.2) break;
            const next = nextScalefactors(scalefactors, metrics, model);
            if (!next) break;
            scalefactors = next;
        }
    }

    if (!best) return zeroGranule();
    outQ.set(work.bestQ);
    outSf.set(work.bestSf);
    return best;
}

/**
 * Encoder lowpass by per-channel bitrate (kbps -> cutoff Hz). Entries below
 * cover the point where Layer III runs out of bits; higher rates keep full band.
 */
const LOWPASS_TABLE: ReadonlyArray<readonly [number, number]> = [
    [16, 8000], [20, 9200], [24, 10500], [28, 11500], [32, 12500],
    [40, 14000], [48, 15200], [56, 16000], [64, 16800], [80, 17800],
    [96, 18800], [112, 19500], [128, 20200],
];

function lowpassCutoffHz(bitrateKbps: number, channels: number): number {
    const perChannel = bitrateKbps / channels;
    if (perChannel >= 160) return Number.POSITIVE_INFINITY;
    for (const [kbps, hz] of LOWPASS_TABLE) {
        if (perChannel <= kbps) return hz;
    }
    return Number.POSITIVE_INFINITY;
}

function applySimpleLowpass(spec: Float64Array, off: number, cutoffLine: number): void {
    const start = Math.max(0, Math.min(576, cutoffLine));
    for (let i = start; i < 576; i++) spec[off + i] = 0;
}

export function encodeMP3(
    pcm: Float32Array,
    sampleRate: number,
    channels: number,
    bitrate = 128,
    options: MpegAudioEncodeOptions = {},
): Blob {
    if (channels !== 1 && channels !== 2) {
        throw new EncodeError(`encodeMP3: channels must be 1 or 2, got ${channels}`);
    }
    const srIdx = SR_TAB.indexOf(sampleRate);
    if (srIdx < 0) throw new EncodeError(`encodeMP3: unsupported sample rate ${sampleRate} (need 32000/44100/48000)`);
    const brIdx = BR_TAB.indexOf(bitrate);
    if (brIdx < 1) throw new EncodeError(`encodeMP3: unsupported bitrate ${bitrate}`);

    const sfb_l = SFB_L[sampleRate];
    const nch = channels;
    const mono = nch === 1;
    const sideLen = mono ? 17 : 32;
    const totalFrames = Math.ceil(pcm.length / nch / 1152);
    const sizer = new FrameSizer(bitrate, sampleRate);
    const sink = new MemorySink();

    const cutoffHz = lowpassCutoffHz(bitrate, nch);
    const cutoffLine = Number.isFinite(cutoffHz)
        ? Math.min(576, Math.floor((cutoffHz / (sampleRate * 0.5)) * 576))
        : 576;

    // Buffers reused across frames.
    const frame = new Uint8Array(sizer.maxFrameSize);
    const vbuf: Float64Array[] = [];
    for (let ch = 0; ch < nch; ch++) vbuf.push(new Float64Array(512));
    const win64 = new Float64Array(64);
    const prevMdct: Float64Array[] = [];
    for (let ch = 0; ch < nch; ch++) prevMdct.push(new Float64Array(32 * 18));
    const mdctCur = new Float64Array(18);
    const mdctOut = new Float64Array(18);
    const subbands = new Float64Array(nch * 2 * 18 * 32);
    const spec = new Float64Array(nch * 2 * 576);
    const granuleCount = nch * 2;
    const energies = new Float64Array(granuleCount);
    const granQ = new Int16Array(granuleCount * 576);
    const granSf = new Uint8Array(granuleCount * LONG_BLOCK_SCF_BANDS);
    const work = makeGranWork(sfb_l.length - 1);

    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
        const { size: frameSize, padding } = sizer.next();
        frame.fill(0, 0, frameSize);
        const mainSlots = frameSize - 4 - sideLen;
        const pcmBase = frameIndex * 1152 * nch;

        for (let gr = 0; gr < 2; gr++) {
            for (let ch = 0; ch < nch; ch++) {
                const sbBase = (ch * 2 + gr) * 18 * 32;
                for (let ss = 0; ss < 18; ss++) {
                    analysisFilterbank(
                        pcm,
                        pcmBase + (gr * 576 + ss * 32) * nch + ch,
                        nch,
                        vbuf[ch],
                        subbands,
                        sbBase + ss * 32,
                        win64,
                    );
                }
                applyFrequencyInversion(subbands, sbBase);
            }
        }

        for (let ch = 0; ch < nch; ch++) {
            for (let gr = 0; gr < 2; gr++) {
                const sbBase = (ch * 2 + gr) * 18 * 32;
                const spBase = (ch * 2 + gr) * 576;
                for (let sb = 0; sb < 32; sb++) {
                    for (let ss = 0; ss < 18; ss++) mdctCur[ss] = subbands[sbBase + ss * 32 + sb];
                    mdct18(mdctCur, prevMdct[ch].subarray(sb * 18, sb * 18 + 18), mdctOut);
                    for (let k = 0; k < 18; k++) spec[spBase + sb * 18 + k] = mdctOut[k];
                }
                applyAntialias(spec, spBase);
                if (cutoffLine < 576) applySimpleLowpass(spec, spBase, cutoffLine);
            }
        }

        frame[0] = 0xFF;
        frame[1] = 0xFB;
        frame[2] = (brIdx << 4) | (srIdx << 2) | (padding << 1);
        frame[3] = (mono ? 3 : 0) << 6;

        let totalEnergy = 0;
        for (let gi = 0; gi < granuleCount; gi++) {
            const off = gi * 576;
            let energy = 0;
            for (let i = 0; i < 576; i++) {
                const v = spec[off + i];
                energy += v * v;
            }
            energies[gi] = energy;
            totalEnergy += energy;
        }
        const grans: GranEnc[] = new Array<GranEnc>(granuleCount);
        let remainingBits = mainSlots * 8;
        let remainingEnergy = totalEnergy > 1e-18 ? totalEnergy : granuleCount;
        for (let gi = 0; gi < granuleCount; gi++) {
            const granuleEnergy = totalEnergy > 1e-18 ? energies[gi] : 1;
            const granulesLeft = granuleCount - gi;
            const baseShare = Math.floor(remainingBits / Math.max(1, granulesLeft));
            const weightedShare = Math.floor((remainingBits * granuleEnergy) / Math.max(remainingEnergy, 1e-18));
            // part2_3_length is a 12-bit field: a granule can never spend more than 4095 bits.
            const targetBits = Math.max(64, Math.min(4095, remainingBits - 64 * (granulesLeft - 1), Math.max(baseShare, weightedShare)));
            grans[gi] = encodeGranuleFast(
                spec, gi * 576, targetBits, sfb_l, sampleRate, work,
                granQ.subarray(gi * 576, gi * 576 + 576),
                granSf.subarray(gi * LONG_BLOCK_SCF_BANDS, (gi + 1) * LONG_BLOCK_SCF_BANDS),
            );
            remainingBits = Math.max(0, remainingBits - grans[gi].part23Length);
            remainingEnergy = Math.max(1e-18, remainingEnergy - granuleEnergy);
        }

        const si = new Bits(frame, 4);
        si.put(0, 9);
        si.put(0, mono ? 5 : 3);
        for (let ch = 0; ch < nch; ch++) si.put(0, 4);
        for (let gr = 0; gr < 2; gr++) {
            for (let ch = 0; ch < nch; ch++) {
                const g = grans[ch * 2 + gr];
                si.put(g.part23Length, 12);
                si.put(g.bigValues, 9);
                si.put(g.globalGain, 8);
                si.put(g.scalefacCompress, 4);
                si.put(0, 1);
                si.put(g.tableSelect[0], 5);
                si.put(g.tableSelect[1], 5);
                si.put(g.tableSelect[2], 5);
                si.put(g.region0Count, 4);
                si.put(g.region1Count, 3);
                si.put(0, 1);
                si.put(g.scalefacScale, 1);
                si.put(g.count1Table, 1);
            }
        }
        if (si.pos !== (4 + sideLen) * 8) {
            throw new EncodeError(`encodeMP3: side-info mismatch (wrote ${si.pos}, expected ${(4 + sideLen) * 8})`);
        }

        const md = new Bits(frame, 4 + sideLen);
        for (let gr = 0; gr < 2; gr++) {
            for (let ch = 0; ch < nch; ch++) {
                const gi = ch * 2 + gr;
                const g = grans[gi];
                const q = granQ.subarray(gi * 576, gi * 576 + 576);
                const sf = granSf.subarray(gi * LONG_BLOCK_SCF_BANDS, (gi + 1) * LONG_BLOCK_SCF_BANDS);
                const [region0Pairs, region1Pairs] = regionPairBoundaries(g.bigValues, g.region0Count, g.region1Count, sfb_l);
                const count1Ht = g.count1Table === 0 ? HT32 : HT33;
                const [slen1, slen2] = SFC_SLEN[g.scalefacCompress];
                const granuleStartBit = md.pos;

                for (let sfb = 0; sfb < LONG_BLOCK_SCF_BANDS; sfb++) {
                    const slen = sfb < LONG_BLOCK_SCF_SPLIT ? slen1 : slen2;
                    if (slen > 0) md.put(sf[sfb], slen);
                }

                for (let p = 0; p < g.bigValues; p++) {
                    const tableId = p < region0Pairs ? g.tableSelect[0] : (p < region1Pairs ? g.tableSelect[1] : g.tableSelect[2]);
                    const table = HTABLES[tableId] ?? HT0;
                    const mv = table.maxval;
                    const lb = table.linbits;
                    const x = q[p * 2];
                    const y = q[p * 2 + 1];
                    const ax = Math.abs(x);
                    const ay = Math.abs(y);
                    const hx = Math.min(ax, mv);
                    const hy = Math.min(ay, mv);
                    const entry = table.entries[hx * table.xlen + hy];
                    if (!entry) throw new EncodeError(`encodeMP3: missing Huffman entry table=${tableId} x=${hx} y=${hy}`);
                    md.put(entry[1], entry[0]);
                    if (lb > 0 && ax >= mv) md.put(ax - mv, lb);
                    if (ax) md.put(x < 0 ? 1 : 0, 1);
                    if (lb > 0 && ay >= mv) md.put(ay - mv, lb);
                    if (ay) md.put(y < 0 ? 1 : 0, 1);
                }

                for (let i = g.count1Start; i < g.count1End; i += 4) {
                    const v = q[i], w = q[i + 1], x = q[i + 2], y = q[i + 3];
                    const av = Math.abs(v), aw = Math.abs(w), ax = Math.abs(x), ay = Math.abs(y);
                    if (av > 1 || aw > 1 || ax > 1 || ay > 1) {
                        throw new EncodeError(`encodeMP3: invalid count1 tuple at frame=${frameIndex} gr=${gr} ch=${ch}`);
                    }
                    const idx = (av ? 8 : 0) | (aw ? 4 : 0) | (ax ? 2 : 0) | (ay ? 1 : 0);
                    md.put(count1Ht[idx][1], count1Ht[idx][0]);
                    if (av) md.put(v < 0 ? 1 : 0, 1);
                    if (aw) md.put(w < 0 ? 1 : 0, 1);
                    if (ax) md.put(x < 0 ? 1 : 0, 1);
                    if (ay) md.put(y < 0 ? 1 : 0, 1);
                }

                const granuleBits = md.pos - granuleStartBit;
                if (granuleBits !== g.part23Length) {
                    throw new EncodeError(`encodeMP3: main-data length mismatch frame=${frameIndex} gr=${gr} ch=${ch} wrote=${granuleBits} expected=${g.part23Length}`);
                }
            }
        }

        if (md.pos > frameSize * 8) {
            throw new EncodeError(`encodeMP3: main-data overflow (wrote ${md.pos}, available ${frameSize * 8})`);
        }
        sink.write(frame.subarray(0, frameSize));
        options.onProgress?.({ completedFrames: frameIndex + 1, totalFrames });
    }

    return sink.toBlob('audio/mpeg');
}
