import type { Sink } from '../types/io';
import type { MuxerConfig } from '../types/container';
import type { EncodedChunk } from '../types/media';

const PAT_PID = 0x0000;
const PMT_PID = 0x1000;
const VIDEO_PID = 0x0100;
const AUDIO_PID = 0x0101;
const TS = 188;

export class TSMuxer {
    private readonly sink: Sink;
    private readonly cfg: MuxerConfig;
    private headerWritten = false;
    private cc: Record<number, number> = {};

    constructor(cfg: MuxerConfig, sink: Sink) {
        this.cfg = cfg;
        this.sink = sink;
    }

    addVideoChunk(chunk: EncodedChunk): void {
        this.ensureHeader();
        const pts = Math.round(chunk.timestamp * 90000);
        const pes = buildPES(0xE0, chunk.data, pts);
        this.packetize(VIDEO_PID, pes, chunk.isKeyframe, pts);
    }

    addAudioChunk(chunk: EncodedChunk): void {
        this.ensureHeader();
        const pts = Math.round(chunk.timestamp * 90000);
        const payload = this.audioNeedsAdts()
            ? wrapADTS(chunk.data, this.cfg.audio?.sampleRate ?? 48000, this.cfg.audio?.channelCount ?? 2)
            : chunk.data;
        const pes = buildPES(this.audioStreamId(), payload, pts);
        this.packetize(AUDIO_PID, pes, false, pts);
    }

    finalize(): void {
        this.ensureHeader();
        this.sink.close();
    }

    private ensureHeader(): void {
        if (this.headerWritten) return;
        this.headerWritten = true;
        this.writeTable(PAT_PID, this.buildPAT());
        this.writeTable(PMT_PID, this.buildPMT());
    }

    private nextCC(pid: number): number {
        const c = (this.cc[pid] ?? 0) & 0xF;
        this.cc[pid] = c + 1;
        return c;
    }

    private videoStreamType(): number {
        const codec = this.cfg.video?.codec ?? 'avc1.640028';
        if (codec.startsWith('hvc1') || codec.startsWith('hev1')) return 0x24;
        return 0x1B;
    }

    private audioStreamType(): number {
        const codec = this.cfg.audio?.codec ?? 'mp4a.40.2';
        if (codec === 'ac-3') return 0x81;
        if (codec === 'ec-3') return 0x87;
        return 0x0F;
    }

    private audioStreamId(): number {
        const codec = this.cfg.audio?.codec ?? 'mp4a.40.2';
        return codec === 'ac-3' || codec === 'ec-3' ? 0xBD : 0xC0;
    }

    private audioNeedsAdts(): boolean {
        const codec = this.cfg.audio?.codec ?? 'mp4a.40.2';
        return codec.startsWith('mp4a');
    }

    private buildPAT(): Uint8Array {
        const d = new Uint8Array(12);
        d[0] = 0x00;
        d[1] = 0xB0;
        d[2] = 0x0D;
        d[3] = 0x00; d[4] = 0x01;
        d[5] = 0xC1;
        d[6] = 0x00; d[7] = 0x00;
        d[8] = 0x00; d[9] = 0x01;
        d[10] = 0xE0 | ((PMT_PID >> 8) & 0x1F);
        d[11] = PMT_PID & 0xFF;
        return appendCRC(d);
    }

    private buildPMT(): Uint8Array {
        const hasV = !!this.cfg.video, hasA = !!this.cfg.audio;
        const pcrPid = hasV ? VIDEO_PID : AUDIO_PID;
        const streams: number[][] = [];
        if (hasV) streams.push([this.videoStreamType(), VIDEO_PID]);
        if (hasA) streams.push([this.audioStreamType(), AUDIO_PID]);

        const infoLen = streams.length * 5;
        const sectionLen = 9 + infoLen + 4;
        const d = new Uint8Array(3 + sectionLen - 4);
        let p = 0;
        d[p++] = 0x02;
        d[p++] = 0xB0 | ((sectionLen >> 8) & 0x0F);
        d[p++] = sectionLen & 0xFF;
        d[p++] = 0x00; d[p++] = 0x01;
        d[p++] = 0xC1;
        d[p++] = 0x00; d[p++] = 0x00;
        d[p++] = 0xE0 | ((pcrPid >> 8) & 0x1F);
        d[p++] = pcrPid & 0xFF;
        d[p++] = 0xF0; d[p++] = 0x00;

        for (const [type, pid] of streams) {
            d[p++] = type;
            d[p++] = 0xE0 | ((pid >> 8) & 0x1F);
            d[p++] = pid & 0xFF;
            d[p++] = 0xF0; d[p++] = 0x00;
        }

        return appendCRC(d.subarray(0, p));
    }

    private writeTable(pid: number, section: Uint8Array): void {
        const pkt = new Uint8Array(TS);
        pkt[0] = 0x47;
        pkt[1] = 0x40 | ((pid >> 8) & 0x1F);
        pkt[2] = pid & 0xFF;
        pkt[3] = 0x10 | this.nextCC(pid);

        const pointer = 1;
        const payloadLen = pointer + section.length;
        const room = TS - 4;

        if (payloadLen < room) {
            const stuffLen = room - payloadLen;
            pkt[3] |= 0x20;
            pkt[4] = stuffLen > 0 ? stuffLen - 1 : 0;
            if (stuffLen > 1) pkt[5] = 0x00;
            if (stuffLen > 2) pkt.fill(0xFF, 6, 4 + stuffLen);
            const off = 4 + Math.max(stuffLen, 1);
            pkt[off] = 0x00;
            pkt.set(section, off + 1);
        } else {
            pkt[4] = 0x00;
            pkt.set(section, 5);
        }

        this.sink.write(pkt);
    }

    private packetize(pid: number, pes: Uint8Array, addPCR: boolean, pts: number): void {
        let off = 0, first = true;
        while (off < pes.length) {
            const pkt = new Uint8Array(TS);
            pkt[0] = 0x47;
            pkt[1] = (first ? 0x40 : 0) | ((pid >> 8) & 0x1F);
            pkt[2] = pid & 0xFF;
            pkt[3] = 0x10 | this.nextCC(pid);

            let hdr = 4;

            if (first && addPCR) {
                pkt[3] |= 0x20;
                pkt[4] = 7;
                pkt[5] = 0x10;
                const pcrBase = pts;
                pkt[6] = (pcrBase >> 25) & 0xFF;
                pkt[7] = (pcrBase >> 17) & 0xFF;
                pkt[8] = (pcrBase >> 9) & 0xFF;
                pkt[9] = (pcrBase >> 1) & 0xFF;
                pkt[10] = ((pcrBase & 1) << 7) | 0x7E;
                pkt[11] = 0x00;
                hdr = 12;
            }

            const rem = pes.length - off;
            const room = TS - hdr;

            if (rem >= room) {
                pkt.set(pes.subarray(off, off + room), hdr);
                off += room;
            } else {
                const stuff = room - rem;
                pkt[3] |= 0x20;
                if (hdr === 4) {
                    pkt[4] = stuff - 1;
                    if (stuff > 1) pkt[5] = 0x00;
                    if (stuff > 2) pkt.fill(0xFF, 6, 4 + stuff);
                } else {
                    const oldLen = pkt[4];
                    pkt[4] = oldLen + stuff;
                    pkt.fill(0xFF, hdr, hdr + stuff);
                }
                pkt.set(pes.subarray(off, off + rem), TS - rem);
                off += rem;
            }

            first = false;
            this.sink.write(pkt);
        }
    }
}

function buildPES(streamId: number, data: Uint8Array, pts: number): Uint8Array {
    const hdrLen = 14;
    const pesPacketLen = 3 + 5 + data.length;
    const buf = new Uint8Array(hdrLen + data.length);
    buf[0] = 0x00; buf[1] = 0x00; buf[2] = 0x01;
    buf[3] = streamId;

    if (pesPacketLen <= 0xFFFF) {
        buf[4] = (pesPacketLen >> 8) & 0xFF;
        buf[5] = pesPacketLen & 0xFF;
    }

    buf[6] = 0x80;
    buf[7] = 0x80;
    buf[8] = 5;

    writePTS(buf, 9, pts);
    buf.set(data, hdrLen);
    return buf;
}

function writePTS(buf: Uint8Array, off: number, pts: number): void {
    buf[off] = 0x21 | (((pts >> 30) & 0x07) << 1);
    buf[off + 1] = (pts >> 22) & 0xFF;
    buf[off + 2] = (((pts >> 15) & 0x7F) << 1) | 1;
    buf[off + 3] = (pts >> 7) & 0xFF;
    buf[off + 4] = ((pts & 0x7F) << 1) | 1;
}

function appendCRC(section: Uint8Array): Uint8Array {
    const out = new Uint8Array(section.length + 4);
    out.set(section);
    const crc = crc32mpeg(section);
    out[section.length] = (crc >> 24) & 0xFF;
    out[section.length + 1] = (crc >> 16) & 0xFF;
    out[section.length + 2] = (crc >> 8) & 0xFF;
    out[section.length + 3] = crc & 0xFF;
    return out;
}

function crc32mpeg(data: Uint8Array): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i] << 24;
        for (let b = 0; b < 8; b++) {
            crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04C11DB7) : (crc << 1);
        }
    }
    return crc >>> 0;
}

const FREQ_TABLE = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function wrapADTS(aac: Uint8Array, sampleRate: number, channels: number): Uint8Array {
    const srIdx = FREQ_TABLE.indexOf(sampleRate);
    const freqIdx = srIdx >= 0 ? srIdx : 3;
    const ch = Math.min(channels, 7);
    const frameLen = aac.length + 7;
    const out = new Uint8Array(frameLen);
    out[0] = 0xFF;
    out[1] = 0xF1;
    out[2] = (1 << 6) | (freqIdx << 2) | ((ch >> 2) & 1);
    out[3] = ((ch & 3) << 6) | ((frameLen >> 11) & 3);
    out[4] = (frameLen >> 3) & 0xFF;
    out[5] = ((frameLen & 7) << 5) | 0x1F;
    out[6] = 0xFC;
    out.set(aac, 7);
    return out;
}
