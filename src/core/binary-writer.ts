export class BinaryWriter {
    private buf: Uint8Array;
    private view: DataView;
    private pos = 0;

    constructor(initialCapacity = 4096) {
        this.buf = new Uint8Array(initialCapacity);
        this.view = new DataView(this.buf.buffer);
    }

    get size(): number { return this.pos; }

    private ensureCapacity(needed: number): void {
        if (this.pos + needed <= this.buf.length) return;
        let newSize = this.buf.length * 2;
        while (newSize < this.pos + needed) newSize *= 2;
        const next = new Uint8Array(newSize);
        next.set(this.buf.subarray(0, this.pos));
        this.buf = next;
        this.view = new DataView(next.buffer);
    }

    writeU8(v: number): void {
        this.ensureCapacity(1);
        this.view.setUint8(this.pos, v & 0xFF);
        this.pos += 1;
    }

    writeU16BE(v: number): void {
        this.ensureCapacity(2);
        this.view.setUint16(this.pos, v & 0xFFFF, false);
        this.pos += 2;
    }

    writeU16LE(v: number): void {
        this.ensureCapacity(2);
        this.view.setUint16(this.pos, v & 0xFFFF, true);
        this.pos += 2;
    }

    writeU32BE(v: number): void {
        this.ensureCapacity(4);
        this.view.setUint32(this.pos, v >>> 0, false);
        this.pos += 4;
    }

    writeU32LE(v: number): void {
        this.ensureCapacity(4);
        this.view.setUint32(this.pos, v >>> 0, true);
        this.pos += 4;
    }

    writeBytes(data: Uint8Array): void {
        this.ensureCapacity(data.length);
        this.buf.set(data, this.pos);
        this.pos += data.length;
    }

    writeASCII(str: string): void {
        this.ensureCapacity(str.length);
        for (let i = 0; i < str.length; i++) this.buf[this.pos++] = str.charCodeAt(i);
    }

    writeZeros(count: number): void {
        this.ensureCapacity(count);
        this.buf.fill(0, this.pos, this.pos + count);
        this.pos += count;
    }

    toUint8Array(): Uint8Array {
        return this.buf.slice(0, this.pos);
    }
}

/** Growable MSB-first bit writer for variable-length codec payloads. */
export class BitSink {
    private buf = new Uint8Array(new ArrayBuffer(1 << 12));
    private len = 0;
    private acc = 0;
    private accBits = 0;

    writeBits(value: number, bits: number): void {
        while (bits > 0) {
            const take = bits > 24 ? 24 : bits;
            const chunk = bits > 24
                ? Math.floor(value / 2 ** (bits - take)) & ((1 << take) - 1)
                : value & ((1 << take) - 1);
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
            this.writeBits(0, 32);
            value -= 32;
        }
        this.writeBits(1, value + 1);
    }

    alignByte(): void {
        if (this.accBits > 0) this.writeBits(0, 8 - this.accBits);
    }

    get bytePosition(): number {
        return this.len;
    }

    /** View of the bytes written so far (byte-aligned content only). */
    bytes(): Uint8Array<ArrayBuffer> {
        return this.buf.subarray(0, this.len);
    }

    /** Copy of the bytes written so far. */
    toUint8Array(): Uint8Array<ArrayBuffer> {
        return this.buf.slice(0, this.len);
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
