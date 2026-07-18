/** MPEG-1/2 Audio Layer I & II shared tables (ISO 11172-3 / 13818-3). */

import { ANALYSIS_WIN } from './mpeg-common';

export interface QuantClass {
    readonly nlevels: number;
    readonly grouped: boolean;
    /** Bits per single sample (code width before grouping). */
    readonly sampleBits: number;
    /** Bits per transmitted word (3 samples when grouped, 1 otherwise). */
    readonly wordBits: number;
    /** Quantization coefficients (a = n / 2^sampleBits, b = a - 1). */
    readonly a: number;
    readonly b: number;
    /** Achieved SNR in dB, ISO Table C.7. */
    readonly snrDb: number;
}

const QUANT_SNR_DB: ReadonlyArray<readonly [number, number]> = [
    [3, 7.00], [5, 11.00], [7, 16.00], [9, 20.84], [15, 25.28], [31, 31.59],
    [63, 37.75], [127, 43.84], [255, 49.89], [511, 55.93], [1023, 61.96],
    [2047, 67.98], [4095, 74.01], [8191, 80.03], [16383, 86.05],
    [32767, 92.01], [65535, 98.01],
];

export const QUANT_CLASSES: ReadonlyMap<number, QuantClass> = (() => {
    const classes = new Map<number, QuantClass>();
    for (const [nlevels, snrDb] of QUANT_SNR_DB) {
        const grouped = nlevels === 3 || nlevels === 5 || nlevels === 9;
        const sampleBits = Math.ceil(Math.log2(nlevels + 1));
        const wordBits = nlevels === 3 ? 5 : nlevels === 5 ? 7 : nlevels === 9 ? 10 : sampleBits;
        const a = nlevels / (1 << sampleBits);
        classes.set(nlevels, { nlevels, grouped, sampleBits, wordBits, a, b: a - 1, snrDb });
    }
    return classes;
})();

// Allocation grids matching ffmpeg mpegaudiodata.c (ISO Tables 3-B.2a..d).
// rows[sb][allocIndex] = nlevels, 0 = no allocation. nbal = log2(row length).
const ROW_1A: readonly number[] = [0, 3, 7, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383, 32767, 65535];
const ROW_1B: readonly number[] = [0, 3, 5, 7, 9, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 65535];
const ROW_1C: readonly number[] = [0, 3, 5, 7, 9, 15, 31, 65535];
const ROW_1D: readonly number[] = [0, 3, 5, 65535];
const ROW_3A: readonly number[] = [0, 3, 5, 9, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383, 32767];
const ROW_3B: readonly number[] = [0, 3, 5, 9, 15, 31, 63, 127];
// MPEG-2 LSF (ISO 13818-3 Table B.1), ffmpeg alloc_table_4.
const ROW_LSF_A: readonly number[] = [0, 3, 5, 7, 9, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383];
const ROW_LSF_C: readonly number[] = [0, 3, 5, 9];

export interface AllocTable {
    readonly sblimit: number;
    readonly rows: ReadonlyArray<readonly number[]>;
    readonly nbal: readonly number[];
}

function makeAllocTable(sblimit: number, rows: ReadonlyArray<readonly number[]>): AllocTable {
    return { sblimit, rows, nbal: rows.map((row) => Math.log2(row.length)) };
}

const GRID_AB: ReadonlyArray<readonly number[]> = [
    ROW_1A, ROW_1A, ROW_1A,
    ROW_1B, ROW_1B, ROW_1B, ROW_1B, ROW_1B, ROW_1B, ROW_1B, ROW_1B,
    ROW_1C, ROW_1C, ROW_1C, ROW_1C, ROW_1C, ROW_1C, ROW_1C, ROW_1C, ROW_1C, ROW_1C, ROW_1C, ROW_1C,
    ROW_1D, ROW_1D, ROW_1D, ROW_1D, ROW_1D, ROW_1D, ROW_1D,
];
const GRID_CD: ReadonlyArray<readonly number[]> = [
    ROW_3A, ROW_3A,
    ROW_3B, ROW_3B, ROW_3B, ROW_3B, ROW_3B, ROW_3B, ROW_3B, ROW_3B, ROW_3B, ROW_3B,
];
const GRID_LSF: ReadonlyArray<readonly number[]> = [
    ROW_LSF_A, ROW_LSF_A, ROW_LSF_A, ROW_LSF_A,
    ROW_3B, ROW_3B, ROW_3B, ROW_3B, ROW_3B, ROW_3B, ROW_3B,
    ROW_LSF_C, ROW_LSF_C, ROW_LSF_C, ROW_LSF_C, ROW_LSF_C, ROW_LSF_C, ROW_LSF_C,
    ROW_LSF_C, ROW_LSF_C, ROW_LSF_C, ROW_LSF_C, ROW_LSF_C, ROW_LSF_C, ROW_LSF_C,
    ROW_LSF_C, ROW_LSF_C, ROW_LSF_C, ROW_LSF_C, ROW_LSF_C,
];

export const TABLE_B2A = makeAllocTable(27, GRID_AB.slice(0, 27));
export const TABLE_B2B = makeAllocTable(30, GRID_AB);
export const TABLE_B2C = makeAllocTable(8, GRID_CD.slice(0, 8));
export const TABLE_B2D = makeAllocTable(12, GRID_CD);
export const TABLE_LSF = makeAllocTable(30, GRID_LSF);

/** Allocation table selection for MPEG-1 Layer II (ISO 11172-3 Table 3-B.2). */
export function chooseAllocTable(sampleRate: number, bitrateKbps: number, channels: number): AllocTable {
    const perChannel = bitrateKbps / channels;
    if (perChannel === 32 || perChannel === 48) {
        return sampleRate === 32000 ? TABLE_B2D : TABLE_B2C;
    }
    if (sampleRate === 48000 || perChannel <= 80) return TABLE_B2A;
    return TABLE_B2B;
}

// Scalefactors, ISO Table 3-B.1: 2^(1 - i/3) for i in [0, 62].
export const SCF_VALUES = new Float64Array(63);
for (let i = 0; i < 63; i++) SCF_VALUES[i] = Math.pow(2, 1 - i / 3);

/**
 * Requantize a Layer I/II sample code to its reconstruction level in [-1, 1):
 * x = (code - floor(L/2)) * 2/L. Algebraically identical to ffmpeg's
 * l1_unscale/l2_unscale_group and the exact inverse of the encoder mapping.
 */
export function requantize(code: number, nlevels: number): number {
    return (code - (nlevels >> 1)) * 2 / nlevels;
}

/**
 * Synthesis window D, ISO 11172-3 Table 3-B.3. The table is exactly 32x the
 * analysis window C (Table 3-C.1), so it is derived from the same trusted
 * coefficients instead of duplicating 512 literals.
 */
export const SYNTHESIS_WINDOW: Float64Array = new Float64Array(512);
for (let i = 0; i < 512; i++) SYNTHESIS_WINDOW[i] = 32 * ANALYSIS_WIN[i];
