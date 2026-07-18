import type { Sink } from '../types/io';
import type { EncodedChunk } from '../types/media';
import { BinaryWriter } from '../core/binary-writer';

export class RawMuxer {
    private readonly sink: Sink;
    constructor(sink: Sink) { this.sink = sink; }

    addAudioChunk(chunk: EncodedChunk): void {
        this.sink.write(chunk.data);
    }

    finalize(): void {
        this.sink.close();
    }
}

export class WAVMuxer {
    private readonly sink: Sink;
    private readonly sampleRate: number;
    private readonly channels: number;
    private pcmData: Uint8Array[] = [];

    constructor(sink: Sink, sampleRate: number, channels: number) {
        this.sink = sink;
        this.sampleRate = sampleRate;
        this.channels = channels;
    }

    addPCMData(data: Uint8Array): void {
        this.pcmData.push(new Uint8Array(data));
    }

    addAudioBuffer(buffer: AudioBuffer): void {
        const ch = buffer.numberOfChannels;
        const len = buffer.length;
        const pcm = new Int16Array(len * ch);
        for (let i = 0; i < len; i++) {
            for (let c = 0; c < ch; c++) {
                const s = Math.max(-1, Math.min(1, buffer.getChannelData(c)[i]));
                pcm[i * ch + c] = s < 0 ? s * 32768 : s * 32767;
            }
        }
        this.pcmData.push(new Uint8Array(pcm.buffer));
    }

    finalize(): void {
        let totalLen = 0;
        for (const d of this.pcmData) totalLen += d.length;

        const w = new BinaryWriter();
        // RIFF header
        w.writeASCII('RIFF');
        w.writeU32LE(36 + totalLen);
        w.writeASCII('WAVE');

        // fmt chunk
        w.writeASCII('fmt ');
        w.writeU32LE(16);
        w.writeU16LE(1); // PCM
        w.writeU16LE(this.channels);
        w.writeU32LE(this.sampleRate);
        w.writeU32LE(this.sampleRate * this.channels * 2); // byte rate
        w.writeU16LE(this.channels * 2); // block align
        w.writeU16LE(16); // bits per sample

        // data chunk
        w.writeASCII('data');
        w.writeU32LE(totalLen);
        for (const d of this.pcmData) w.writeBytes(d);

        this.sink.write(w.toUint8Array());
        this.sink.close();
    }
}
