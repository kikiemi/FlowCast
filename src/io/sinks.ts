import type { Sink } from '../types/io';

function copyToArrayBuffer(data: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return copy.buffer;
}

export class MemorySink implements Sink {
    private chunks: ArrayBuffer[] = [];

    write(data: Uint8Array): void {
        this.chunks.push(copyToArrayBuffer(data));
    }

    close(): void { }

    toBlob(mimeType: string): Blob {
        return new Blob(this.chunks, { type: mimeType });
    }

    toUint8Array(): Uint8Array {
        let total = 0;
        for (const c of this.chunks) total += c.byteLength;
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of this.chunks) {
            const chunk = new Uint8Array(c);
            out.set(chunk, off);
            off += chunk.length;
        }
        return out;
    }
}

export class StreamSink implements Sink {
    private writer: FileSystemWritableFileStream;
    private pending: Promise<void> = Promise.resolve();

    constructor(writer: FileSystemWritableFileStream) {
        this.writer = writer;
    }

    write(data: Uint8Array): void {
        const chunk = copyToArrayBuffer(data);
        this.pending = this.pending.then(() => this.writer.write(chunk));
    }

    close(): void {
        this.pending = this.pending.then(() => this.writer.close());
    }

    get done(): Promise<void> { return this.pending; }

    static async fromPicker(suggestedName: string): Promise<StreamSink> {
        const handle = await (window as { showSaveFilePicker?: (opts: Record<string, unknown>) => Promise<FileSystemFileHandle> })
            .showSaveFilePicker!({ suggestedName });
        const writable = await handle.createWritable();
        return new StreamSink(writable);
    }

    static async fromOPFS(name: string): Promise<StreamSink> {
        const root = await navigator.storage.getDirectory();
        const file = await root.getFileHandle(name, { create: true });
        const writable = await file.createWritable();
        return new StreamSink(writable);
    }
}
