import type { Sink } from '../types/io';
import type { EncodedChunk } from '../types/media';

export class ADTSMuxer {
    private readonly sink: Sink;
    private readonly sampleRate: number;
    private readonly channels: number;

    constructor(sink: Sink, sampleRate: number, channels: number) {
        this.sink = sink;
        this.sampleRate = sampleRate;
        this.channels = channels;
    }

    addAudioChunk(chunk: EncodedChunk): void {
        this.sink.write(this.wrapFrame(chunk.data));
    }

    finalize(): void {
        this.sink.close();
    }

    private wrapFrame(aac: Uint8Array): Uint8Array {
        const srIdx = FREQ_TABLE.indexOf(this.sampleRate);
        const freqIdx = srIdx >= 0 ? srIdx : 4;
        const ch = Math.min(this.channels, 7);
        const frameLen = aac.length + 7;

        const hdr = new Uint8Array(7 + aac.length);
        hdr[0] = 0xFF;
        hdr[1] = 0xF1;
        hdr[2] = (1 << 6) | (freqIdx << 2) | ((ch >> 2) & 1);
        hdr[3] = ((ch & 3) << 6) | ((frameLen >> 11) & 3);
        hdr[4] = (frameLen >> 3) & 0xFF;
        hdr[5] = ((frameLen & 7) << 5) | 0x1F;
        hdr[6] = 0xFC;
        hdr.set(aac, 7);
        return hdr;
    }
}

const FREQ_TABLE = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
