import type { Sink } from '../types/io';
import type { EncodedChunk } from '../types/media';
import { BinaryWriter } from '../core/binary-writer';

/**
 * Native FLAC container writer. When the encoder provides its stream header
 * (WebCodecs FLAC description = "fLaC" signature + STREAMINFO), it is written
 * verbatim; otherwise a minimal STREAMINFO is synthesized.
 */
export class FLACMuxer {
    private readonly sink: Sink;
    private readonly sampleRate: number;
    private readonly channels: number;
    private readonly bitsPerSample: number;
    private codecConfig: Uint8Array | undefined;
    private headerWritten = false;

    constructor(sink: Sink, sampleRate: number, channels: number, bitsPerSample = 16, codecConfig?: Uint8Array) {
        this.sink = sink;
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.bitsPerSample = bitsPerSample;
        this.codecConfig = codecConfig;
    }

    /** Provide the encoder stream header; effective until the first chunk is written. */
    setCodecConfig(codecConfig: Uint8Array): void {
        if (!this.headerWritten) this.codecConfig = codecConfig;
    }

    addAudioChunk(chunk: EncodedChunk): void {
        if (!this.headerWritten) this.writeHeader();
        this.sink.write(chunk.data);
    }

    finalize(): void {
        if (!this.headerWritten) this.writeHeader();
        this.sink.close();
    }

    private writeHeader(): void {
        this.headerWritten = true;

        const provided = this.codecConfig;
        if (provided && provided.length >= 4
            && provided[0] === 0x66 && provided[1] === 0x4C && provided[2] === 0x61 && provided[3] === 0x43) {
            this.sink.write(provided);
            return;
        }

        const w = new BinaryWriter();
        w.writeASCII('fLaC');

        // STREAMINFO: block sizes unknown-friendly, total samples unknown (0).
        const si = new Uint8Array(34);
        const dv = new DataView(si.buffer);
        dv.setUint16(0, 4096, false);
        dv.setUint16(2, 4096, false);

        const sr = this.sampleRate;
        const ch = this.channels - 1;
        const bps = this.bitsPerSample - 1;

        si[8] = (sr >> 12) & 0xFF;
        si[9] = (sr >> 4) & 0xFF;
        si[10] = ((sr & 0xF) << 4) | ((ch & 7) << 1) | ((bps >> 4) & 1);
        si[11] = ((bps & 0xF) << 4);

        const blockHeader = new Uint8Array(4);
        blockHeader[0] = 0x80; // last-metadata-block, type 0 (STREAMINFO)
        blockHeader[3] = 34;

        w.writeBytes(blockHeader);
        w.writeBytes(si);
        this.sink.write(w.toUint8Array());
    }
}
