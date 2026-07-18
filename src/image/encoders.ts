export async function encodePNG(canvas: OffscreenCanvas): Promise<Blob> {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return blob;
}

export async function encodeJPEG(canvas: OffscreenCanvas, quality = 0.9): Promise<Blob> {
    return canvas.convertToBlob({ type: 'image/jpeg', quality });
}

export async function encodeWebP(canvas: OffscreenCanvas, quality = 0.9): Promise<Blob> {
    return canvas.convertToBlob({ type: 'image/webp', quality });
}

export async function encodeBMP(canvas: OffscreenCanvas): Promise<Blob> {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D context');
    const { width: w, height: h } = canvas;
    const imgData = ctx.getImageData(0, 0, w, h);
    const rowBytes = w * 3;
    const paddedRow = (rowBytes + 3) & ~3;
    const pixelDataSize = paddedRow * h;
    const fileSize = 54 + pixelDataSize;

    const buf = new ArrayBuffer(fileSize);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);

    dv.setUint8(0, 0x42); dv.setUint8(1, 0x4D);
    dv.setUint32(2, fileSize, true);
    dv.setUint32(10, 54, true);
    dv.setUint32(14, 40, true);
    dv.setInt32(18, w, true);
    dv.setInt32(22, -h, true); // top-down
    dv.setUint16(26, 1, true);
    dv.setUint16(28, 24, true);
    dv.setUint32(34, pixelDataSize, true);

    let off = 54;
    const px = imgData.data;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const si = (y * w + x) * 4;
            u8[off++] = px[si + 2]; // B
            u8[off++] = px[si + 1]; // G
            u8[off++] = px[si + 0]; // R
        }
        off += paddedRow - rowBytes;
    }

    return new Blob([buf], { type: 'image/bmp' });
}

export async function encodeTIFF(canvas: OffscreenCanvas): Promise<Blob> {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D context');
    const { width: w, height: h } = canvas;
    const imgData = ctx.getImageData(0, 0, w, h);
    const pixelBytes = w * h * 3;
    const ifdOffset = 8;
    const ifdEntries = 10;
    const ifdSize = 2 + ifdEntries * 12 + 4;
    const stripOffset = ifdOffset + ifdSize;
    const fileSize = stripOffset + pixelBytes;

    const buf = new ArrayBuffer(fileSize);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);

    // Header (little-endian TIFF)
    dv.setUint8(0, 0x49); dv.setUint8(1, 0x49);
    dv.setUint16(2, 42, true);
    dv.setUint32(4, ifdOffset, true);

    let pos = ifdOffset;
    dv.setUint16(pos, ifdEntries, true); pos += 2;

    const writeIFDEntry = (tag: number, type: number, count: number, value: number) => {
        dv.setUint16(pos, tag, true); pos += 2;
        dv.setUint16(pos, type, true); pos += 2;
        dv.setUint32(pos, count, true); pos += 4;
        dv.setUint32(pos, value, true); pos += 4;
    };

    writeIFDEntry(0x0100, 3, 1, w);              // ImageWidth
    writeIFDEntry(0x0101, 3, 1, h);              // ImageLength
    writeIFDEntry(0x0102, 3, 1, 8);              // BitsPerSample (simplified)
    writeIFDEntry(0x0103, 3, 1, 1);              // Compression: none
    writeIFDEntry(0x0106, 3, 1, 2);              // PhotometricInterpretation: RGB
    writeIFDEntry(0x0111, 4, 1, stripOffset);    // StripOffsets
    writeIFDEntry(0x0115, 3, 1, 3);              // SamplesPerPixel
    writeIFDEntry(0x0116, 4, 1, h);              // RowsPerStrip
    writeIFDEntry(0x0117, 4, 1, pixelBytes);     // StripByteCounts
    writeIFDEntry(0x011C, 3, 1, 1);              // PlanarConfiguration: chunky

    dv.setUint32(pos, 0, true); // Next IFD offset (none)

    // Write pixel data (RGB, no alpha)
    let si = 0;
    let di = stripOffset;
    const px = imgData.data;
    for (let i = 0; i < w * h; i++) {
        u8[di++] = px[si];
        u8[di++] = px[si + 1];
        u8[di++] = px[si + 2];
        si += 4;
    }

    return new Blob([buf], { type: 'image/tiff' });
}

export async function encodeICO(canvas: OffscreenCanvas): Promise<Blob> {
    // Use PNG encoding inside ICO container
    const size = Math.min(canvas.width, 256);
    let src = canvas;
    if (canvas.width !== size || canvas.height !== size) {
        src = new OffscreenCanvas(size, size);
        const ctx = src.getContext('2d');
        if (ctx) ctx.drawImage(canvas, 0, 0, size, size);
    }
    const pngBlob = await src.convertToBlob({ type: 'image/png' });
    const pngBuf = new Uint8Array(await pngBlob.arrayBuffer());

    const headerSize = 6 + 16;
    const buf = new ArrayBuffer(headerSize + pngBuf.length);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);

    // ICO header
    dv.setUint16(0, 0, true); // reserved
    dv.setUint16(2, 1, true); // type: ICO
    dv.setUint16(4, 1, true); // image count

    // Directory entry
    dv.setUint8(6, size >= 256 ? 0 : size);  // width
    dv.setUint8(7, size >= 256 ? 0 : size);  // height
    dv.setUint8(8, 0);  // color palette
    dv.setUint8(9, 0);  // reserved
    dv.setUint16(10, 1, true); // color planes
    dv.setUint16(12, 32, true); // bits per pixel
    dv.setUint32(14, pngBuf.length, true); // image data size
    dv.setUint32(18, headerSize, true); // offset

    u8.set(pngBuf, headerSize);
    return new Blob([buf], { type: 'image/x-icon' });
}

export interface GifFrameData {
    readonly data: Uint8ClampedArray | Uint8Array;
    readonly width: number;
    readonly height: number;
}

interface PaletteBox {
    lo: [number, number, number];
    hi: [number, number, number];
    pixels: Int32Array;
    count: number;
}

/**
 * Animated GIF encoder: per-frame median-cut palettes (local color tables),
 * Floyd-Steinberg dithering, frame differencing with transparency, and
 * changed-region cropping.
 */
export class AnimatedGifEncoder {
    private readonly width: number;
    private readonly height: number;
    private parts: Uint8Array<ArrayBuffer>[] = [];
    private frameCount = 0;
    private previous: Uint8ClampedArray | null = null;

    constructor(w: number, h: number) {
        this.width = Math.max(1, Math.floor(w));
        this.height = Math.max(1, Math.floor(h));
    }

    async addFrame(source: ImageBitmap, delayMs: number): Promise<void> {
        const canvas = new OffscreenCanvas(this.width, this.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('AnimatedGifEncoder: 2d context unavailable');
        ctx.drawImage(source, 0, 0, this.width, this.height);
        const imgData = ctx.getImageData(0, 0, this.width, this.height);
        this.addFrameData(imgData, delayMs);
    }

    /** DOM-free frame path; `frame` must match the constructor dimensions. */
    addFrameData(frame: GifFrameData, delayMs: number): void {
        if (frame.width !== this.width || frame.height !== this.height) {
            throw new Error('AnimatedGifEncoder: frame size mismatch');
        }
        if (this.frameCount === 0) this.writeHeader();
        this.frameCount++;
        const rgba = frame.data instanceof Uint8ClampedArray ? frame.data : new Uint8ClampedArray(frame.data);

        // Changed-region bounding box against the previous frame.
        let x0 = 0;
        let y0 = 0;
        let x1 = this.width;
        let y1 = this.height;
        const prev = this.previous;
        if (prev) {
            x0 = this.width; y0 = this.height; x1 = 0; y1 = 0;
            for (let y = 0; y < this.height; y++) {
                const row = y * this.width * 4;
                for (let x = 0; x < this.width; x++) {
                    const i = row + x * 4;
                    if (rgba[i] !== prev[i] || rgba[i + 1] !== prev[i + 1] || rgba[i + 2] !== prev[i + 2]) {
                        if (x < x0) x0 = x;
                        if (x >= x1) x1 = x + 1;
                        if (y < y0) y0 = y;
                        if (y >= y1) y1 = y + 1;
                    }
                }
            }
            if (x0 >= x1 || y0 >= y1) { x0 = 0; y0 = 0; x1 = 1; y1 = 1; } // identical frame: 1px keepalive
        }
        const rw = x1 - x0;
        const rh = y1 - y0;

        const palette = this.buildPalette(rgba, x0, y0, rw, rh);
        const paletteSize = 256; // 255 colors + transparent index 255
        const indexed = this.ditherRegion(rgba, prev, x0, y0, rw, rh, palette);

        // Graphic control: disposal 1 (keep), transparent index when diffing.
        const delay = Math.max(2, Math.round(delayMs / 10));
        this.parts.push(Uint8Array.from([
            0x21, 0xF9, 0x04,
            (1 << 2) | (prev ? 1 : 0),
            delay & 0xFF, (delay >> 8) & 0xFF,
            255, 0,
        ]));

        // Image descriptor with local color table (256 entries).
        const desc = new Uint8Array(10);
        desc[0] = 0x2C;
        desc[1] = x0 & 0xFF; desc[2] = (x0 >> 8) & 0xFF;
        desc[3] = y0 & 0xFF; desc[4] = (y0 >> 8) & 0xFF;
        desc[5] = rw & 0xFF; desc[6] = (rw >> 8) & 0xFF;
        desc[7] = rh & 0xFF; desc[8] = (rh >> 8) & 0xFF;
        desc[9] = 0x80 | 7; // local color table, 2^(7+1) = 256 entries
        this.parts.push(desc);
        const lct = new Uint8Array(paletteSize * 3);
        for (let i = 0; i < palette.length / 3 && i < 255; i++) {
            lct[i * 3] = palette[i * 3];
            lct[i * 3 + 1] = palette[i * 3 + 1];
            lct[i * 3 + 2] = palette[i * 3 + 2];
        }
        this.parts.push(lct);

        this.parts.push(Uint8Array.from([8]));
        const compressed = lzwEncode(indexed, 8);
        for (let i = 0; i < compressed.length; i += 255) {
            const blockLen = Math.min(255, compressed.length - i);
            this.parts.push(Uint8Array.from([blockLen]));
            this.parts.push(compressed.slice(i, i + blockLen));
        }
        this.parts.push(Uint8Array.from([0]));

        const copy = new Uint8ClampedArray(rgba.length);
        copy.set(rgba);
        this.previous = copy;
    }

    async encode(): Promise<Blob> {
        if (this.frameCount === 0) this.writeHeader();
        this.parts.push(Uint8Array.from([0x3B]));
        const blob = new Blob(this.parts as BlobPart[], { type: 'image/gif' });
        this.parts = [];
        this.previous = null;
        this.frameCount = 0;
        return blob;
    }

    private writeHeader(): void {
        this.parts.push(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]));
        const lsd = new Uint8Array(7);
        lsd[0] = this.width & 0xFF; lsd[1] = (this.width >> 8) & 0xFF;
        lsd[2] = this.height & 0xFF; lsd[3] = (this.height >> 8) & 0xFF;
        lsd[4] = 0x70; // no global color table, 8-bit color resolution
        this.parts.push(lsd);
        this.parts.push(Uint8Array.from([0x21, 0xFF, 0x0B]));
        this.parts.push(new TextEncoder().encode('NETSCAPE2.0') as Uint8Array<ArrayBuffer>);
        this.parts.push(Uint8Array.from([3, 1, 0, 0, 0]));
    }

    /** Median-cut palette (up to 255 colors) from the changed region. */
    private buildPalette(rgba: Uint8ClampedArray, x0: number, y0: number, rw: number, rh: number): Uint8Array {
        const total = rw * rh;
        const step = Math.max(1, Math.floor(total / 65536));
        const samples = new Int32Array(Math.ceil(total / step));
        let count = 0;
        for (let p = 0; p < total; p += step) {
            const x = x0 + (p % rw);
            const y = y0 + Math.floor(p / rw);
            const i = (y * this.width + x) * 4;
            samples[count++] = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
        }
        const boxes: PaletteBox[] = [makeBox(samples.subarray(0, count))];
        while (boxes.length < 255) {
            let pick = -1;
            let pickScore = 0;
            for (let i = 0; i < boxes.length; i++) {
                const box = boxes[i];
                const spanR = box.hi[0] - box.lo[0];
                const spanG = box.hi[1] - box.lo[1];
                const spanB = box.hi[2] - box.lo[2];
                const span = Math.max(spanR, spanG, spanB);
                if (span === 0 || box.count < 2) continue;
                const score = box.count * (span + 1);
                if (score > pickScore) { pickScore = score; pick = i; }
            }
            if (pick < 0) break;
            const [a, b] = splitBox(boxes[pick]);
            boxes.splice(pick, 1, a, b);
        }
        const palette = new Uint8Array(boxes.length * 3);
        for (let i = 0; i < boxes.length; i++) {
            const box = boxes[i];
            let r = 0;
            let g = 0;
            let b = 0;
            for (let j = 0; j < box.count; j++) {
                const c = box.pixels[j];
                r += (c >> 16) & 0xFF;
                g += (c >> 8) & 0xFF;
                b += c & 0xFF;
            }
            palette[i * 3] = Math.round(r / box.count);
            palette[i * 3 + 1] = Math.round(g / box.count);
            palette[i * 3 + 2] = Math.round(b / box.count);
        }
        refinePalette(palette, samples.subarray(0, count));
        return palette;
    }

    /** Floyd-Steinberg dither of the region; transparent where unchanged. */
    private ditherRegion(
        rgba: Uint8ClampedArray,
        prev: Uint8ClampedArray | null,
        x0: number,
        y0: number,
        rw: number,
        rh: number,
        palette: Uint8Array,
    ): Uint8Array {
        const colorCount = palette.length / 3;
        const nearestCache = new Int16Array(32768).fill(-1);
        const nearest = (r: number, g: number, b: number): number => {
            const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
            const cached = nearestCache[key];
            if (cached >= 0) return cached;
            let best = 0;
            let bestDist = Infinity;
            for (let i = 0; i < colorCount; i++) {
                const dr = r - palette[i * 3];
                const dg = g - palette[i * 3 + 1];
                const db = b - palette[i * 3 + 2];
                const dist = dr * dr * 2 + dg * dg * 3 + db * db;
                if (dist < bestDist) { bestDist = dist; best = i; }
            }
            nearestCache[key] = best;
            return best;
        };

        const out = new Uint8Array(rw * rh);
        const errR = new Float32Array(rw + 2);
        const errG = new Float32Array(rw + 2);
        const errB = new Float32Array(rw + 2);
        const nextR = new Float32Array(rw + 2);
        const nextG = new Float32Array(rw + 2);
        const nextB = new Float32Array(rw + 2);
        for (let y = 0; y < rh; y++) {
            nextR.fill(0); nextG.fill(0); nextB.fill(0);
            for (let x = 0; x < rw; x++) {
                const src = ((y0 + y) * this.width + (x0 + x)) * 4;
                if (prev
                    && rgba[src] === prev[src]
                    && rgba[src + 1] === prev[src + 1]
                    && rgba[src + 2] === prev[src + 2]) {
                    out[y * rw + x] = 255; // transparent: pixel unchanged
                    continue;
                }
                const r = clamp255(rgba[src] + errR[x + 1]);
                const g = clamp255(rgba[src + 1] + errG[x + 1]);
                const b = clamp255(rgba[src + 2] + errB[x + 1]);
                const idx = nearest(r | 0, g | 0, b | 0);
                out[y * rw + x] = idx;
                const er = r - palette[idx * 3];
                const eg = g - palette[idx * 3 + 1];
                const eb = b - palette[idx * 3 + 2];
                errR[x + 2] += er * (7 / 16); errG[x + 2] += eg * (7 / 16); errB[x + 2] += eb * (7 / 16);
                nextR[x] += er * (3 / 16); nextG[x] += eg * (3 / 16); nextB[x] += eb * (3 / 16);
                nextR[x + 1] += er * (5 / 16); nextG[x + 1] += eg * (5 / 16); nextB[x + 1] += eb * (5 / 16);
                nextR[x + 2] += er * (1 / 16); nextG[x + 2] += eg * (1 / 16); nextB[x + 2] += eb * (1 / 16);
            }
            errR.set(nextR); errG.set(nextG); errB.set(nextB);
        }
        return out;
    }
}

/** Two Lloyd iterations: reassign samples to nearest color, recenter. */
function refinePalette(palette: Uint8Array, samples: Int32Array): void {
    const colorCount = palette.length / 3;
    const sumR = new Float64Array(colorCount);
    const sumG = new Float64Array(colorCount);
    const sumB = new Float64Array(colorCount);
    const num = new Int32Array(colorCount);
    for (let iter = 0; iter < 2; iter++) {
        sumR.fill(0); sumG.fill(0); sumB.fill(0); num.fill(0);
        const cache = new Int16Array(32768).fill(-1);
        for (let s = 0; s < samples.length; s++) {
            const c = samples[s];
            const r = (c >> 16) & 0xFF;
            const g = (c >> 8) & 0xFF;
            const b = c & 0xFF;
            const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
            let best = cache[key];
            if (best < 0) {
                let bestDist = Infinity;
                best = 0;
                for (let i = 0; i < colorCount; i++) {
                    const dr = r - palette[i * 3];
                    const dg = g - palette[i * 3 + 1];
                    const db = b - palette[i * 3 + 2];
                    const dist = dr * dr * 2 + dg * dg * 3 + db * db;
                    if (dist < bestDist) { bestDist = dist; best = i; }
                }
                cache[key] = best;
            }
            sumR[best] += r; sumG[best] += g; sumB[best] += b; num[best]++;
        }
        for (let i = 0; i < colorCount; i++) {
            if (num[i] === 0) continue;
            palette[i * 3] = Math.round(sumR[i] / num[i]);
            palette[i * 3 + 1] = Math.round(sumG[i] / num[i]);
            palette[i * 3 + 2] = Math.round(sumB[i] / num[i]);
        }
    }
}

function clamp255(v: number): number {
    return v < 0 ? 0 : v > 255 ? 255 : v;
}

function makeBox(pixels: Int32Array): PaletteBox {
    const box: PaletteBox = { lo: [255, 255, 255], hi: [0, 0, 0], pixels, count: pixels.length };
    for (let i = 0; i < pixels.length; i++) {
        const c = pixels[i];
        const r = (c >> 16) & 0xFF;
        const g = (c >> 8) & 0xFF;
        const b = c & 0xFF;
        if (r < box.lo[0]) box.lo[0] = r;
        if (r > box.hi[0]) box.hi[0] = r;
        if (g < box.lo[1]) box.lo[1] = g;
        if (g > box.hi[1]) box.hi[1] = g;
        if (b < box.lo[2]) box.lo[2] = b;
        if (b > box.hi[2]) box.hi[2] = b;
    }
    return box;
}

function splitBox(box: PaletteBox): [PaletteBox, PaletteBox] {
    const spanR = box.hi[0] - box.lo[0];
    const spanG = box.hi[1] - box.lo[1];
    const spanB = box.hi[2] - box.lo[2];
    const shift = spanG >= spanR && spanG >= spanB ? 8 : spanR >= spanB ? 16 : 0;
    const sorted = Int32Array.from(box.pixels.subarray(0, box.count));
    sorted.sort((a, b) => ((a >> shift) & 0xFF) - ((b >> shift) & 0xFF));
    const mid = box.count >> 1;
    return [makeBox(sorted.subarray(0, mid)), makeBox(sorted.subarray(mid))];
}

/** GIF LZW with a hashed dictionary (prefix code x next byte). */
function lzwEncode(data: Uint8Array, minCodeSize: number): Uint8Array<ArrayBuffer> {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    const maxCode = 4096;
    const hashSize = 8192;
    const hashCodes = new Int32Array(hashSize);
    const hashKeys = new Int32Array(hashSize);

    let codeSize = minCodeSize + 1;
    let nextCode = eoiCode + 1;
    const output: number[] = [];
    let bitBuf = 0;
    let bitCount = 0;

    const emit = (code: number): void => {
        bitBuf |= code << bitCount;
        bitCount += codeSize;
        while (bitCount >= 8) {
            output.push(bitBuf & 0xFF);
            bitBuf >>= 8;
            bitCount -= 8;
        }
    };
    const resetDict = (): void => {
        hashCodes.fill(-1);
        nextCode = eoiCode + 1;
        codeSize = minCodeSize + 1;
    };

    resetDict();
    emit(clearCode);
    if (data.length === 0) {
        emit(eoiCode);
        if (bitCount > 0) output.push(bitBuf & 0xFF);
        return Uint8Array.from(output);
    }

    let prefix = data[0];
    for (let i = 1; i < data.length; i++) {
        const k = data[i];
        const key = (prefix << 8) | k;
        let h = ((key * 2654435761) >>> 19) & (hashSize - 1);
        let found = -1;
        for (;;) {
            const code = hashCodes[h];
            if (code < 0) break;
            if (hashKeys[h] === key) { found = code; break; }
            h = (h + 1) & (hashSize - 1);
        }
        if (found >= 0) {
            prefix = found;
            continue;
        }
        emit(prefix);
        if (nextCode < maxCode) {
            hashCodes[h] = nextCode;
            hashKeys[h] = key;
            if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
            nextCode++;
        } else {
            emit(clearCode);
            resetDict();
        }
        prefix = k;
    }
    emit(prefix);
    emit(eoiCode);
    if (bitCount > 0) output.push(bitBuf & 0xFF);
    return Uint8Array.from(output);
}

export class APNGEncoder {
    private readonly width: number;
    private readonly height: number;
    private frames: { blob: Blob; delay: number }[] = [];

    constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
    }

    async addFrame(source: ImageBitmap, delayMs: number): Promise<void> {
        const c = new OffscreenCanvas(this.width, this.height);
        const ctx = c.getContext('2d')!;
        ctx.drawImage(source, 0, 0, this.width, this.height);
        const blob = await c.convertToBlob({ type: 'image/png' });
        this.frames.push({ blob, delay: delayMs });
    }

    async encode(): Promise<Blob> {
        if (this.frames.length === 0) throw new Error('No frames');
        if (this.frames.length === 1) return this.frames[0].blob;

        // For simplicity, encode as individual PNGs concatenated via APNG chunks
        const firstPng = new Uint8Array(await this.frames[0].blob.arrayBuffer());

        // Parse first PNG to extract chunks
        const chunks = this.parsePNG(firstPng);
        const result: Uint8Array<ArrayBuffer>[] = [];

        // PNG signature
        result.push(firstPng.subarray(0, 8));

        // IHDR
        const ihdr = chunks.find(c => c.type === 'IHDR');
        if (ihdr) result.push(ihdr.raw);

        // acTL (animation control)
        const actlData = new ArrayBuffer(8);
        const actlDV = new DataView(actlData);
        actlDV.setUint32(0, this.frames.length, false);
        actlDV.setUint32(4, 0, false); // loops (0 = infinite)
        result.push(this.buildPNGChunk('acTL', new Uint8Array(actlData)));

        let seqNum = 0;

        for (let fi = 0; fi < this.frames.length; fi++) {
            const frame = this.frames[fi];
            const delay = frame.delay;

            // fcTL
            const fctlData = new ArrayBuffer(26);
            const fctlDV = new DataView(fctlData);
            fctlDV.setUint32(0, seqNum++, false);
            fctlDV.setUint32(4, this.width, false);
            fctlDV.setUint32(8, this.height, false);
            fctlDV.setUint32(12, 0, false); // x
            fctlDV.setUint32(16, 0, false); // y
            fctlDV.setUint16(20, delay, false); // delay numerator
            fctlDV.setUint16(22, 1000, false); // delay denominator
            fctlDV.setUint8(24, 0); // dispose_op
            fctlDV.setUint8(25, 0); // blend_op
            result.push(this.buildPNGChunk('fcTL', new Uint8Array(fctlData)));

            const pngBuf = new Uint8Array(await frame.blob.arrayBuffer());
            const frameChunks = this.parsePNG(pngBuf);
            const idatChunks = frameChunks.filter(c => c.type === 'IDAT');

            for (const idat of idatChunks) {
                if (fi === 0) {
                    result.push(idat.raw);
                } else {
                    // fdAT
                    const seqBuf = new Uint8Array(4);
                    new DataView(seqBuf.buffer).setUint32(0, seqNum++, false);
                    const fdatPayload = new Uint8Array(4 + idat.data.length);
                    fdatPayload.set(seqBuf, 0);
                    fdatPayload.set(idat.data, 4);
                    result.push(this.buildPNGChunk('fdAT', fdatPayload));
                }
            }
        }

        result.push(this.buildPNGChunk('IEND', new Uint8Array(0)));
        const blob = new Blob(result, { type: 'image/apng' });
        this.frames.length = 0;
        return blob;
    }

    private parsePNG(data: Uint8Array<ArrayBuffer>): { type: string; data: Uint8Array<ArrayBuffer>; raw: Uint8Array<ArrayBuffer> }[] {
        const chunks: { type: string; data: Uint8Array<ArrayBuffer>; raw: Uint8Array<ArrayBuffer> }[] = [];
        let pos = 8; // skip signature
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        while (pos + 12 <= data.length) {
            const length = dv.getUint32(pos, false);
            const type = String.fromCharCode(data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]);
            const chunkData = data.subarray(pos + 8, pos + 8 + length);
            const raw = data.subarray(pos, pos + 12 + length);
            chunks.push({ type, data: chunkData, raw });
            pos += 12 + length;
            if (type === 'IEND') break;
        }
        return chunks;
    }

    private buildPNGChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
        const buf = new Uint8Array(12 + data.length);
        const dv = new DataView(buf.buffer);
        dv.setUint32(0, data.length, false);
        buf[4] = type.charCodeAt(0);
        buf[5] = type.charCodeAt(1);
        buf[6] = type.charCodeAt(2);
        buf[7] = type.charCodeAt(3);
        buf.set(data, 8);
        const crc = this.crc32(buf.subarray(4, 8 + data.length));
        dv.setUint32(8 + data.length, crc, false);
        return buf;
    }

    private crc32(data: Uint8Array): number {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < data.length; i++) {
            c = PNG_CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
        }
        return (c ^ 0xFFFFFFFF) >>> 0;
    }
}

const PNG_CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();
