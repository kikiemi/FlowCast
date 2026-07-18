import type { Sink } from '../types/io';
import type { MuxerConfig } from '../types/container';
import type { EncodedChunk } from '../types/media';

const FREQ_TABLE = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

export class FLVMuxer {
    private readonly sink: Sink;
    private readonly cfg: MuxerConfig;
    private headerWritten = false;
    private prevTagSize = 0;
    private videoSeqSent = false;
    private audioSeqSent = false;

    constructor(cfg: MuxerConfig, sink: Sink) { this.cfg = cfg; this.sink = sink; }

    addVideoChunk(chunk: EncodedChunk, codecCfg?: Uint8Array): void {
        this.ensureHeader();

        if (!this.videoSeqSent && codecCfg && codecCfg.length > 0) {
            this.videoSeqSent = true;
            const seq = new Uint8Array(5 + codecCfg.length);
            seq[0] = 0x17;
            seq.set(codecCfg, 5);
            this.writeTag(9, 0, seq);
        }

        const payload = new Uint8Array(5 + chunk.data.length);
        payload[0] = (chunk.isKeyframe ? 0x10 : 0x20) | 0x07;
        payload[1] = 1;
        const cts = 0;
        payload[2] = (cts >> 16) & 0xFF;
        payload[3] = (cts >> 8) & 0xFF;
        payload[4] = cts & 0xFF;
        payload.set(chunk.data, 5);
        this.writeTag(9, Math.round(chunk.timestamp * 1000), payload);
    }

    addAudioChunk(chunk: EncodedChunk, codecConfig?: Uint8Array): void {
        this.ensureHeader();

        if (!this.audioSeqSent) {
            this.audioSeqSent = true;
            // Prefer the encoder's real AudioSpecificConfig over a synthesized one.
            const asc = (codecConfig ?? this.cfg.audio?.codecConfig ?? buildAudioSpecificConfig(
                this.cfg.audio?.sampleRate ?? 44100,
                this.cfg.audio?.channelCount ?? 2,
            ));
            const seq = new Uint8Array(2 + asc.length);
            seq[0] = 0xAF;
            seq.set(asc, 2);
            this.writeTag(8, 0, seq);
        }

        const payload = new Uint8Array(2 + chunk.data.length);
        payload[0] = 0xAF;
        payload[1] = 1;
        payload.set(chunk.data, 2);
        this.writeTag(8, Math.round(chunk.timestamp * 1000), payload);
    }

    finalize(): void {
        this.ensureHeader();
        const buf = new Uint8Array(4);
        new DataView(buf.buffer).setUint32(0, this.prevTagSize, false);
        this.sink.write(buf);
        this.sink.close();
    }

    private ensureHeader(): void {
        if (this.headerWritten) return;
        this.headerWritten = true;
        const hasV = !!this.cfg.video;
        const hasA = !!this.cfg.audio;
        const hdr = new Uint8Array(9);
        hdr[0] = 0x46; hdr[1] = 0x4C; hdr[2] = 0x56;
        hdr[3] = 1;
        hdr[4] = (hasV ? 1 : 0) | (hasA ? 4 : 0);
        new DataView(hdr.buffer).setUint32(5, 9, false);
        this.sink.write(hdr);
    }

    private writeTag(type: number, ts: number, data: Uint8Array): void {
        const tagHeader = new Uint8Array(15);
        const dv = new DataView(tagHeader.buffer);
        dv.setUint32(0, this.prevTagSize, false);
        tagHeader[4] = type;
        tagHeader[5] = (data.length >> 16) & 0xFF;
        tagHeader[6] = (data.length >> 8) & 0xFF;
        tagHeader[7] = data.length & 0xFF;
        tagHeader[8] = (ts >> 16) & 0xFF;
        tagHeader[9] = (ts >> 8) & 0xFF;
        tagHeader[10] = ts & 0xFF;
        tagHeader[11] = (ts >> 24) & 0xFF;
        this.sink.write(tagHeader);
        this.sink.write(data);
        this.prevTagSize = 11 + data.length;
    }
}

function buildAudioSpecificConfig(sampleRate: number, channels: number): Uint8Array {
    const srIdx = FREQ_TABLE.indexOf(sampleRate);
    const freqIdx = srIdx >= 0 ? srIdx : 4;
    const asc = new Uint8Array(2);
    asc[0] = (2 << 3) | ((freqIdx >> 1) & 0x07);
    asc[1] = ((freqIdx & 1) << 7) | (channels << 3);
    return asc;
}
