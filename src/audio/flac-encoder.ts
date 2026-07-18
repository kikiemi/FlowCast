/** FLAC encoder (RFC 9639): 16-bit, fixed + LPC prediction, Rice coding. */

import { EncodeError } from '../core/errors';

const BLOCK_SIZE = 4096;
const MAX_LPC_ORDER = 8;
const LPC_PRECISION = 14;
const MAX_PARTITION_ORDER = 6;
const MAX_RICE_PARAM = 14;

/** MD5 of the unencoded audio (STREAMINFO signature), RFC 1321. */
class Md5 {
    private readonly state = new Int32Array([0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476]);
    private readonly buffer = new Uint8Array(64);
    private buffered = 0;
    private totalBytes = 0;

    private static readonly S = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    private static readonly K = (() => {
        const k = new Int32Array(64);
        for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
        return k;
    })();

    update(data: Uint8Array): void {
        this.totalBytes += data.length;
        let off = 0;
        if (this.buffered > 0) {
            const take = Math.min(64 - this.buffered, data.length);
            this.buffer.set(data.subarray(0, take), this.buffered);
            this.buffered += take;
            off = take;
            if (this.buffered === 64) {
                this.processBlock(this.buffer, 0);
                this.buffered = 0;
            }
        }
        while (off + 64 <= data.length) {
            this.processBlock(data, off);
            off += 64;
        }
        if (off < data.length) {
            this.buffer.set(data.subarray(off), 0);
            this.buffered = data.length - off;
        }
    }

    digest(): Uint8Array {
        const bitLength = this.totalBytes * 8;
        const pad = new Uint8Array(((this.buffered < 56 ? 56 : 120) - this.buffered) + 8);
        pad[0] = 0x80;
        const lo = bitLength >>> 0;
        const hi = Math.floor(bitLength / 4294967296);
        for (let i = 0; i < 4; i++) pad[pad.length - 8 + i] = (lo >>> (i * 8)) & 0xFF;
        for (let i = 0; i < 4; i++) pad[pad.length - 4 + i] = (hi >>> (i * 8)) & 0xFF;
        this.update(pad);
        const out = new Uint8Array(16);
        for (let i = 0; i < 4; i++) {
            const v = this.state[i];
            out[i * 4] = v & 0xFF;
            out[i * 4 + 1] = (v >>> 8) & 0xFF;
            out[i * 4 + 2] = (v >>> 16) & 0xFF;
            out[i * 4 + 3] = (v >>> 24) & 0xFF;
        }
        return out;
    }

    private processBlock(data: Uint8Array, off: number): void {
        const m = new Int32Array(16);
        for (let i = 0; i < 16; i++) {
            const b = off + i * 4;
            m[i] = data[b] | (data[b + 1] << 8) | (data[b + 2] << 16) | (data[b + 3] << 24);
        }
        let [a, b, c, d] = this.state;
        for (let i = 0; i < 64; i++) {
            let f: number, g: number;
            if (i < 16) { f = (b & c) | (~b & d); g = i; }
            else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
            else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
            else { f = c ^ (b | ~d); g = (7 * i) & 15; }
            const tmp = d;
            d = c;
            c = b;
            const sum = (a + f + Md5.K[i] + m[g]) | 0;
            const s = Md5.S[i];
            b = (b + ((sum << s) | (sum >>> (32 - s)))) | 0;
            a = tmp;
        }
        this.state[0] = (this.state[0] + a) | 0;
        this.state[1] = (this.state[1] + b) | 0;
        this.state[2] = (this.state[2] + c) | 0;
        this.state[3] = (this.state[3] + d) | 0;
    }
}

/** MSB-first bit writer over a growable buffer. */
class FlacBits {
    private buf: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(1 << 16));
    private len = 0;
    private acc = 0;
    private accBits = 0;

    write(value: number, bits: number): void {
        // Values are masked to the field width; callers pass non-negative fields.
        while (bits > 0) {
            const take = Math.min(bits, 24);
            const chunk = bits > 24 ? Math.floor(value / 2 ** (bits - take)) & ((1 << take) - 1) : value & ((1 << take) - 1);
            this.acc = (this.acc << take) | chunk;
            this.accBits += take;
            bits -= take;
            while (this.accBits >= 8) {
                this.push((this.acc >>> (this.accBits - 8)) & 0xFF);
                this.accBits -= 8;
            }
            this.acc &= (1 << this.accBits) - 1;
        }
    }

    writeUnary(value: number): void {
        while (value >= 32) {
            this.write(0, 32);
            value -= 32;
        }
        this.write(1, value + 1);
    }

    alignByte(): void {
        if (this.accBits > 0) this.write(0, 8 - this.accBits);
    }

    get bytePosition(): number {
        return this.len;
    }

    bytes(): Uint8Array<ArrayBuffer> {
        return this.buf.subarray(0, this.len);
    }

    private push(byte: number): void {
        if (this.len === this.buf.length) {
            const next = new Uint8Array(new ArrayBuffer(this.buf.length * 2));
            next.set(this.buf);
            this.buf = next;
        }
        this.buf[this.len++] = byte;
    }
}

const CRC8_TABLE = (() => {
    const table = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        let crc = i;
        for (let bit = 0; bit < 8; bit++) crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xFF : (crc << 1) & 0xFF;
        table[i] = crc;
    }
    return table;
})();

const CRC16_TABLE = (() => {
    const table = new Uint16Array(256);
    for (let i = 0; i < 256; i++) {
        let crc = i << 8;
        for (let bit = 0; bit < 8; bit++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x8005) & 0xFFFF : (crc << 1) & 0xFFFF;
        table[i] = crc;
    }
    return table;
})();

function crc8(data: Uint8Array): number {
    let crc = 0;
    for (let i = 0; i < data.length; i++) crc = CRC8_TABLE[crc ^ data[i]];
    return crc;
}

function crc16(data: Uint8Array): number {
    let crc = 0;
    for (let i = 0; i < data.length; i++) crc = (CRC16_TABLE[(crc >> 8) ^ data[i]] ^ (crc << 8)) & 0xFFFF;
    return crc;
}

function writeUtf8Number(bits: FlacBits, value: number): void {
    if (value < 0x80) {
        bits.write(value, 8);
        return;
    }
    const bytes: number[] = [];
    let v = value;
    let mask = 0xC0;
    let max = 0x20;
    while (v >= max && max > 1) {
        bytes.unshift(0x80 | (v & 0x3F));
        v >>= 6;
        mask = (mask >> 1) | 0x80;
        max >>= 1;
    }
    bytes.unshift((mask & 0xFF) | v);
    for (const byte of bytes) bits.write(byte, 8);
}

function fixedResidual(samples: Int32Array, i: number, order: number): number {
    switch (order) {
        case 0: return samples[i];
        case 1: return samples[i] - samples[i - 1];
        case 2: return samples[i] - 2 * samples[i - 1] + samples[i - 2];
        case 3: return samples[i] - 3 * samples[i - 1] + 3 * samples[i - 2] - samples[i - 3];
        default: return samples[i] - 4 * samples[i - 1] + 6 * samples[i - 2] - 4 * samples[i - 3] + samples[i - 4];
    }
}

interface LpcModel {
    readonly order: number;
    readonly shift: number;
    readonly coefficients: Int32Array;
}

/** Levinson-Durbin LPC from a Welch-windowed autocorrelation. */
function computeLpc(samples: Int32Array, maxOrder: number): LpcModel | null {
    const n = samples.length;
    if (n <= maxOrder * 2) return null;

    const windowed = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const w = 1 - ((i - (n - 1) / 2) / ((n + 1) / 2)) ** 2; // Welch window
        windowed[i] = samples[i] * w;
    }
    const autoc = new Float64Array(maxOrder + 1);
    for (let lag = 0; lag <= maxOrder; lag++) {
        let sum = 0;
        for (let i = lag; i < n; i++) sum += windowed[i] * windowed[i - lag];
        autoc[lag] = sum;
    }
    if (autoc[0] <= 0) return null;

    const lpc = new Float64Array(maxOrder);
    let error = autoc[0];
    let order = 0;
    for (let i = 0; i < maxOrder; i++) {
        let acc = autoc[i + 1];
        for (let j = 0; j < i; j++) acc -= lpc[j] * autoc[i - j];
        const reflection = acc / error;
        error *= 1 - reflection * reflection;
        lpc[i] = reflection;
        for (let j = 0; j < i >> 1; j++) {
            const tmp = lpc[j];
            lpc[j] = tmp - reflection * lpc[i - 1 - j];
            lpc[i - 1 - j] -= reflection * tmp;
        }
        if (i & 1) lpc[i >> 1] -= lpc[i >> 1] * reflection;
        order = i + 1;
        if (error <= 0) break;
    }
    if (order === 0) return null;

    // Quantize coefficients to LPC_PRECISION bits with a common shift.
    let maxCoef = 0;
    for (let i = 0; i < order; i++) maxCoef = Math.max(maxCoef, Math.abs(lpc[i]));
    if (!(maxCoef > 0) || !Number.isFinite(maxCoef)) return null;
    let shift = LPC_PRECISION - 1 - Math.max(0, Math.floor(Math.log2(maxCoef)) + 1);
    shift = Math.max(1, Math.min(15, shift));
    const limit = (1 << (LPC_PRECISION - 1)) - 1;
    const coefficients = new Int32Array(order);
    let err = 0;
    for (let i = 0; i < order; i++) {
        const ideal = lpc[i] * (1 << shift) + err;
        let q = Math.round(ideal);
        if (q > limit) q = limit;
        else if (q < -limit - 1) q = -limit - 1;
        err = ideal - q;
        coefficients[i] = q;
    }
    return { order, shift, coefficients };
}

function lpcResiduals(samples: Int32Array, model: LpcModel, out: Int32Array): void {
    const { order, shift, coefficients } = model;
    for (let i = order; i < samples.length; i++) {
        let prediction = 0;
        for (let j = 0; j < order; j++) prediction += coefficients[j] * samples[i - 1 - j];
        // Predictions stay within int53 for 16-bit input and 14-bit coefficients.
        out[i - order] = samples[i] - Math.floor(prediction / (1 << shift));
    }
}

function riceParamFor(sumAbs: number, count: number): number {
    if (count === 0 || sumAbs === 0) return 0;
    const mean = sumAbs / count;
    let k = 0;
    while ((1 << (k + 1)) < mean * 2 && k < MAX_RICE_PARAM) k++;
    return k;
}

function riceCost(residuals: Int32Array, start: number, end: number, k: number): number {
    let bits = 0;
    for (let i = start; i < end; i++) {
        const v = residuals[i];
        const zigzag = v >= 0 ? v * 2 : -v * 2 - 1;
        bits += (zigzag >>> k) + 1 + k;
    }
    return bits;
}

interface RicePlan {
    readonly partitionOrder: number;
    readonly params: number[];
    readonly bits: number;
}

/** Choose the best Rice partition order and per-partition parameters. */
function planRice(residuals: Int32Array, blockSize: number, predictorOrder: number): RicePlan {
    let best: RicePlan | null = null;
    for (let po = 0; po <= MAX_PARTITION_ORDER; po++) {
        const partitions = 1 << po;
        if (blockSize % partitions !== 0) continue;
        const partSize = blockSize / partitions;
        if (partSize <= predictorOrder) break;
        const params: number[] = [];
        let bits = po === 0 ? 0 : 0;
        let ok = true;
        for (let p = 0; p < partitions; p++) {
            const start = p === 0 ? 0 : p * partSize - predictorOrder;
            const end = (p + 1) * partSize - predictorOrder;
            if (end > residuals.length) { ok = false; break; }
            let sumAbs = 0;
            for (let i = start; i < end; i++) sumAbs += Math.abs(residuals[i]);
            let k = riceParamFor(sumAbs, end - start);
            let cost = riceCost(residuals, start, end, k);
            if (k > 0) {
                const lower = riceCost(residuals, start, end, k - 1);
                if (lower < cost) { k--; cost = lower; }
            }
            if (k + 1 <= MAX_RICE_PARAM) {
                const higher = riceCost(residuals, start, end, k + 1);
                if (higher < cost) { k++; cost = higher; }
            }
            params.push(k);
            bits += 4 + cost;
        }
        if (!ok) continue;
        const total = bits + 3; // partition order field lives in the residual header
        if (!best || total < best.bits) best = { partitionOrder: po, params, bits: total };
    }
    if (!best) throw new EncodeError('FLAC: no valid Rice partitioning');
    return best;
}

function writeResidual(bits: FlacBits, residuals: Int32Array, plan: RicePlan, blockSize: number, predictorOrder: number): void {
    bits.write(0, 2); // Rice coding method (4-bit parameters)
    bits.write(plan.partitionOrder, 4);
    const partitions = 1 << plan.partitionOrder;
    const partSize = blockSize / partitions;
    for (let p = 0; p < partitions; p++) {
        const k = plan.params[p];
        bits.write(k, 4);
        const start = p === 0 ? 0 : p * partSize - predictorOrder;
        const end = (p + 1) * partSize - predictorOrder;
        for (let i = start; i < end; i++) {
            const v = residuals[i];
            const zigzag = v >= 0 ? v * 2 : -v * 2 - 1;
            bits.writeUnary(zigzag >>> k);
            if (k > 0) bits.write(zigzag & ((1 << k) - 1), k);
        }
    }
}

interface SubframePlan {
    readonly kind: 'constant' | 'verbatim' | 'fixed' | 'lpc';
    readonly order: number;
    readonly lpc: LpcModel | null;
    readonly residuals: Int32Array;
    readonly rice: RicePlan | null;
    readonly bits: number;
}

function planSubframe(samples: Int32Array, sampleBits: number): SubframePlan {
    const n = samples.length;
    let constant = true;
    for (let i = 1; i < n; i++) {
        if (samples[i] !== samples[0]) { constant = false; break; }
    }
    if (constant) {
        return { kind: 'constant', order: 0, lpc: null, residuals: new Int32Array(0), rice: null, bits: 8 + sampleBits };
    }

    let best: SubframePlan = {
        kind: 'verbatim', order: 0, lpc: null, residuals: new Int32Array(0), rice: null, bits: 8 + n * sampleBits,
    };

    // Fixed predictors 0-4: pick the order with the smallest residual energy.
    let bestFixedOrder = 0;
    let bestFixedCost = Number.POSITIVE_INFINITY;
    for (let order = 0; order <= 4 && order < n; order++) {
        let cost = 0;
        for (let i = order; i < n; i++) cost += Math.abs(fixedResidual(samples, i, order));
        if (cost < bestFixedCost) { bestFixedCost = cost; bestFixedOrder = order; }
    }
    {
        const order = bestFixedOrder;
        const residuals = new Int32Array(n - order);
        for (let i = order; i < n; i++) residuals[i - order] = fixedResidual(samples, i, order);
        const rice = planRice(residuals, n, order);
        const bits = 8 + order * sampleBits + rice.bits;
        if (bits < best.bits) best = { kind: 'fixed', order, lpc: null, residuals, rice, bits };
    }

    const lpc = computeLpc(samples, Math.min(MAX_LPC_ORDER, n >> 1));
    if (lpc) {
        const residuals = new Int32Array(n - lpc.order);
        lpcResiduals(samples, lpc, residuals);
        const rice = planRice(residuals, n, lpc.order);
        const bits = 8 + lpc.order * sampleBits + 4 + 5 + lpc.order * LPC_PRECISION + rice.bits;
        if (bits < best.bits) best = { kind: 'lpc', order: lpc.order, lpc, residuals, rice, bits };
    }
    return best;
}

function writeSubframe(bits: FlacBits, samples: Int32Array, plan: SubframePlan, sampleBits: number): void {
    bits.write(0, 1); // zero padding bit
    if (plan.kind === 'constant') {
        bits.write(0, 6);
        bits.write(0, 1); // no wasted bits
        bits.write(samples[0] & ((1 << sampleBits) - 1), sampleBits);
        return;
    }
    if (plan.kind === 'verbatim') {
        bits.write(1, 6);
        bits.write(0, 1);
        const mask = (1 << sampleBits) - 1;
        for (let i = 0; i < samples.length; i++) bits.write(samples[i] & mask, sampleBits);
        return;
    }
    const mask = (1 << sampleBits) - 1;
    if (plan.kind === 'fixed') {
        bits.write(0b001000 | plan.order, 6);
        bits.write(0, 1);
        for (let i = 0; i < plan.order; i++) bits.write(samples[i] & mask, sampleBits);
        writeResidual(bits, plan.residuals, plan.rice as RicePlan, samples.length, plan.order);
        return;
    }
    const lpc = plan.lpc as LpcModel;
    bits.write(0b100000 | (lpc.order - 1), 6);
    bits.write(0, 1);
    for (let i = 0; i < lpc.order; i++) bits.write(samples[i] & mask, sampleBits);
    bits.write(LPC_PRECISION - 1, 4);
    bits.write(lpc.shift, 5);
    const coefMask = (1 << LPC_PRECISION) - 1;
    for (let i = 0; i < lpc.order; i++) bits.write(lpc.coefficients[i] & coefMask, LPC_PRECISION);
    writeResidual(bits, plan.residuals, plan.rice as RicePlan, samples.length, lpc.order);
}

function sampleRateCode(rate: number): { code: number; tail: 'none' | 'hz16' } {
    switch (rate) {
        case 88200: return { code: 1, tail: 'none' };
        case 176400: return { code: 2, tail: 'none' };
        case 192000: return { code: 3, tail: 'none' };
        case 8000: return { code: 4, tail: 'none' };
        case 16000: return { code: 5, tail: 'none' };
        case 22050: return { code: 6, tail: 'none' };
        case 24000: return { code: 7, tail: 'none' };
        case 32000: return { code: 8, tail: 'none' };
        case 44100: return { code: 9, tail: 'none' };
        case 48000: return { code: 10, tail: 'none' };
        case 96000: return { code: 11, tail: 'none' };
        default: return { code: 13, tail: 'hz16' }; // 16-bit sample rate in Hz follows
    }
}

export interface FlacEncodeOptions {
    readonly onProgress?: (encodedFrames: number, totalFrames: number) => void;
}

/**
 * Encode interleaved float PCM ([-1, 1]) to a FLAC stream at 16 bits.
 * Per-frame stereo decorrelation (L/R, mid/side, left/side, right/side),
 * fixed and LPC prediction, and partitioned Rice coding; the STREAMINFO
 * block carries the true MD5 of the unencoded samples.
 */
export function encodeFlac(
    pcm: Float32Array,
    sampleRate: number,
    channels: number,
    options: FlacEncodeOptions = {},
): Uint8Array<ArrayBuffer> {
    if (channels < 1 || channels > 8) throw new EncodeError(`encodeFlac: unsupported channel count ${channels}`);
    if (sampleRate < 1 || sampleRate > 655350) throw new EncodeError(`encodeFlac: unsupported sample rate ${sampleRate}`);
    const totalSamples = Math.floor(pcm.length / channels);
    if (totalSamples === 0) throw new EncodeError('encodeFlac: empty input');
    const sampleBits = 16;

    // Quantize once; MD5 covers exactly these samples (little-endian order).
    const quantized: Int32Array[] = [];
    for (let ch = 0; ch < channels; ch++) quantized.push(new Int32Array(totalSamples));
    const md5 = new Md5();
    const md5Chunk = new Uint8Array(Math.min(totalSamples, 4096) * channels * 2);
    for (let start = 0; start < totalSamples; start += 4096) {
        const end = Math.min(totalSamples, start + 4096);
        let w = 0;
        for (let i = start; i < end; i++) {
            for (let ch = 0; ch < channels; ch++) {
                const v = pcm[i * channels + ch];
                let s = Math.round((v >= 1 ? 1 : v <= -1 ? -1 : v) * 32767);
                if (s > 32767) s = 32767;
                else if (s < -32768) s = -32768;
                quantized[ch][i] = s;
                md5Chunk[w++] = s & 0xFF;
                md5Chunk[w++] = (s >> 8) & 0xFF;
            }
        }
        md5.update(md5Chunk.subarray(0, w));
    }

    const out = new FlacBits();
    // fLaC marker + STREAMINFO (last metadata block).
    out.write(0x66, 8); out.write(0x4C, 8); out.write(0x61, 8); out.write(0x43, 8);
    out.write(1, 1); // last metadata block
    out.write(0, 7); // STREAMINFO
    out.write(34, 24);
    out.write(BLOCK_SIZE, 16);
    out.write(BLOCK_SIZE, 16);
    out.write(0, 24); // min frame size unknown
    out.write(0, 24); // max frame size unknown
    out.write(sampleRate, 20);
    out.write(channels - 1, 3);
    out.write(sampleBits - 1, 5);
    out.write(Math.floor(totalSamples / 4294967296) & 0xF, 4);
    out.write(totalSamples >>> 0, 32);
    const digest = md5.digest();
    for (let i = 0; i < 16; i++) out.write(digest[i], 8);

    const totalFrames = Math.ceil(totalSamples / BLOCK_SIZE) || 1;
    const mid = new Int32Array(BLOCK_SIZE);
    const side = new Int32Array(BLOCK_SIZE);

    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
        const start = frameIndex * BLOCK_SIZE;
        const blockSize = Math.min(BLOCK_SIZE, totalSamples - start) || BLOCK_SIZE;
        const blocks: Int32Array[] = [];
        for (let ch = 0; ch < channels; ch++) blocks.push(quantized[ch].subarray(start, start + blockSize));

        let channelAssignment = channels - 1;
        let plans: SubframePlan[];
        let subframeBits: number[];
        if (channels === 2) {
            const left = blocks[0];
            const right = blocks[1];
            const m = mid.subarray(0, blockSize);
            const s = side.subarray(0, blockSize);
            for (let i = 0; i < blockSize; i++) {
                s[i] = left[i] - right[i];
                m[i] = (left[i] + right[i]) >> 1;
            }
            const planL = planSubframe(left, 16);
            const planR = planSubframe(right, 16);
            const planM = planSubframe(m, 16);
            const planS = planSubframe(s, 17);
            const modes: Array<{ assignment: number; plans: SubframePlan[]; bits: number[]; cost: number }> = [
                { assignment: 1, plans: [planL, planR], bits: [16, 16], cost: planL.bits + planR.bits },
                { assignment: 8, plans: [planL, planS], bits: [16, 17], cost: planL.bits + planS.bits },
                { assignment: 9, plans: [planS, planR], bits: [17, 16], cost: planS.bits + planR.bits },
                { assignment: 10, plans: [planM, planS], bits: [16, 17], cost: planM.bits + planS.bits },
            ];
            modes.sort((a, b) => a.cost - b.cost);
            channelAssignment = modes[0].assignment;
            plans = modes[0].plans;
            subframeBits = modes[0].bits;
        } else {
            plans = blocks.map((block) => planSubframe(block, 16));
            subframeBits = blocks.map(() => 16);
        }

        // Frame header (byte-aligned by construction).
        const frame = new FlacBits();
        frame.write(0b11111111111110, 14);
        frame.write(0, 1); // reserved
        frame.write(0, 1); // fixed block size stream
        const lastBlock = blockSize !== BLOCK_SIZE;
        frame.write(lastBlock ? 7 : 12, 4); // 7 = 16-bit size follows, 12 = 4096
        const sr = sampleRateCode(sampleRate);
        frame.write(sr.code, 4);
        frame.write(channelAssignment, 4);
        frame.write(4, 3); // 16 bits per sample
        frame.write(0, 1); // reserved
        writeUtf8Number(frame, frameIndex);
        if (lastBlock) frame.write(blockSize - 1, 16);
        if (sr.tail === 'hz16') frame.write(sampleRate & 0xFFFF, 16);
        frame.write(crc8(frame.bytes()), 8);

        if (channels === 2) {
            const source = channelAssignment === 1 ? [blocks[0], blocks[1]]
                : channelAssignment === 8 ? [blocks[0], side.subarray(0, blockSize)]
                    : channelAssignment === 9 ? [side.subarray(0, blockSize), blocks[1]]
                        : [mid.subarray(0, blockSize), side.subarray(0, blockSize)];
            for (let ch = 0; ch < 2; ch++) writeSubframe(frame, source[ch], plans[ch], subframeBits[ch]);
        } else {
            for (let ch = 0; ch < channels; ch++) writeSubframe(frame, blocks[ch], plans[ch], subframeBits[ch]);
        }
        frame.alignByte();
        frame.write(crc16(frame.bytes()), 16);

        const frameBytes = frame.bytes();
        for (let i = 0; i < frameBytes.length; i++) out.write(frameBytes[i], 8);
        options.onProgress?.(frameIndex + 1, totalFrames);
    }

    return out.bytes().slice();
}
