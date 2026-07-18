import type { Source } from '../types/io';

export class BlobSource implements Source {
    private readonly blob: Blob;
    readonly size: number;

    constructor(blob: Blob) {
        this.blob = blob;
        this.size = blob.size;
    }

    async read(offset: number, length: number): Promise<Uint8Array> {
        const end = Math.min(offset + length, this.size);
        return new Uint8Array(await this.blob.slice(offset, end).arrayBuffer());
    }
}
