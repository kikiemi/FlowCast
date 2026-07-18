import type { Sink } from '../types/io';
import type { MuxerConfig } from '../types/container';
import type { EncodedChunk } from '../types/media';

const textEncoder = new TextEncoder();

interface BufferedPacket {
    readonly chunk: EncodedChunk;
    readonly trackNum: number;
}

interface OpusInfo {
    readonly head: Uint8Array;
    readonly channels: number;
    readonly inputSampleRate: number;
    readonly preSkip: number;
}

function concat(...parts: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const part of parts) {
        out.set(part, pos);
        pos += part.length;
    }
    return out;
}

function ebmlIdBytes(id: number): number {
    if (id > 0xFFFFFF) return 4;
    if (id > 0xFFFF) return 3;
    if (id > 0xFF) return 2;
    return 1;
}

function writeEbmlId(out: Uint8Array, pos: number, id: number): number {
    if (id > 0xFFFFFF) {
        out[pos++] = (id >>> 24) & 0xFF;
        out[pos++] = (id >>> 16) & 0xFF;
        out[pos++] = (id >>> 8) & 0xFF;
        out[pos++] = id & 0xFF;
        return pos;
    }
    if (id > 0xFFFF) {
        out[pos++] = (id >>> 16) & 0xFF;
        out[pos++] = (id >>> 8) & 0xFF;
        out[pos++] = id & 0xFF;
        return pos;
    }
    if (id > 0xFF) {
        out[pos++] = (id >>> 8) & 0xFF;
        out[pos++] = id & 0xFF;
        return pos;
    }
    out[pos++] = id & 0xFF;
    return pos;
}

function unsignedBytes(value: number): number {
    let v = BigInt(Math.max(0, Math.floor(value)));
    let bytes = 1;
    while (v > 0xFFn && bytes < 8) {
        v >>= 8n;
        bytes++;
    }
    return bytes;
}

function writeUnsigned(out: Uint8Array, pos: number, value: number, bytes: number): number {
    let v = BigInt(Math.max(0, Math.floor(value)));
    for (let i = bytes - 1; i >= 0; i--) {
        out[pos + i] = Number(v & 0xFFn);
        v >>= 8n;
    }
    return pos + bytes;
}

function ebmlSizeBytes(size: number): number {
    const value = BigInt(Math.max(0, Math.floor(size)));
    for (let bytes = 1; bytes <= 8; bytes++) {
        const maxValue = (1n << BigInt(bytes * 7)) - 1n;
        if (value <= maxValue) return bytes;
    }
    throw new Error(`EBML size too large: ${size}`);
}

function writeEbmlSize(out: Uint8Array, pos: number, size: number): number {
    const bytes = ebmlSizeBytes(size);
    let value = BigInt(Math.max(0, Math.floor(size))) | (1n << BigInt(bytes * 7));
    for (let i = bytes - 1; i >= 0; i--) {
        out[pos + i] = Number(value & 0xFFn);
        value >>= 8n;
    }
    return pos + bytes;
}

function ebmlElement(id: number, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(ebmlIdBytes(id) + ebmlSizeBytes(payload.length) + payload.length);
    let pos = writeEbmlId(out, 0, id);
    pos = writeEbmlSize(out, pos, payload.length);
    out.set(payload, pos);
    return out;
}

function ebmlUint(id: number, value: number): Uint8Array {
    const bytes = unsignedBytes(value);
    const payload = new Uint8Array(bytes);
    writeUnsigned(payload, 0, value, bytes);
    return ebmlElement(id, payload);
}

function ebmlFloat(id: number, value: number): Uint8Array {
    const payload = new Uint8Array(8);
    new DataView(payload.buffer).setFloat64(0, value, false);
    return ebmlElement(id, payload);
}

function ebmlString(id: number, value: string): Uint8Array {
    return ebmlElement(id, textEncoder.encode(value));
}

function ebmlBinary(id: number, payload: Uint8Array): Uint8Array {
    return ebmlElement(id, payload);
}

function buildOpusHead(channels: number, inputSampleRate: number, preSkip: number): Uint8Array {
    const head = new Uint8Array(19);
    head.set(textEncoder.encode('OpusHead'), 0);
    head[8] = 1;
    head[9] = channels & 0xFF;
    new DataView(head.buffer).setUint16(10, preSkip & 0xFFFF, true);
    new DataView(head.buffer).setUint32(12, inputSampleRate >>> 0, true);
    new DataView(head.buffer).setInt16(16, 0, true);
    head[18] = 0;
    return head;
}

function parseOpusHead(config: Uint8Array | undefined, fallbackChannels: number, fallbackRate: number): OpusInfo {
    if (config && config.length >= 19) {
        const magic = String.fromCharCode(...config.subarray(0, 8));
        if (magic === 'OpusHead') {
            const view = new DataView(config.buffer, config.byteOffset, config.byteLength);
            return {
                head: new Uint8Array(config),
                channels: Math.max(1, config[9] || fallbackChannels || 2),
                inputSampleRate: view.getUint32(12, true) || fallbackRate || 48000,
                preSkip: view.getUint16(10, true),
            };
        }
    }
    return {
        head: buildOpusHead(Math.max(1, fallbackChannels || 2), Math.max(1, fallbackRate || 48000), 312),
        channels: Math.max(1, fallbackChannels || 2),
        inputSampleRate: Math.max(1, fallbackRate || 48000),
        preSkip: 312,
    };
}

export class WebMMuxer {
    private readonly sink: Sink;
    private readonly cfg: MuxerConfig;
    private readonly packets: BufferedPacket[] = [];
    private videoConfig?: Uint8Array;
    private audioConfig?: Uint8Array;

    constructor(cfg: MuxerConfig, sink: Sink) {
        this.cfg = cfg;
        this.sink = sink;
        if (cfg.video?.codecConfig) this.videoConfig = new Uint8Array(cfg.video.codecConfig);
        if (cfg.audio?.codecConfig) this.audioConfig = new Uint8Array(cfg.audio.codecConfig);
    }

    addVideoChunk(chunk: EncodedChunk, codecConfig?: Uint8Array): void {
        if (codecConfig && !this.videoConfig) this.videoConfig = new Uint8Array(codecConfig);
        this.packets.push({ chunk, trackNum: 1 });
    }

    addAudioChunk(chunk: EncodedChunk, codecConfig?: Uint8Array): void {
        if (codecConfig && !this.audioConfig) this.audioConfig = new Uint8Array(codecConfig);
        this.packets.push({ chunk, trackNum: this.cfg.video ? 2 : 1 });
    }

    finalize(): void {
        const orderedPackets = this.packets
            .slice()
            .sort((a, b) => a.chunk.timestamp - b.chunk.timestamp || a.trackNum - b.trackNum);
        const durationSeconds = orderedPackets.reduce(
            (max, packet) => Math.max(max, packet.chunk.timestamp + packet.chunk.duration),
            0,
        );
        const segmentPayload = concat(
            this.buildSegmentInfo(durationSeconds),
            this.buildTracks(),
            ...this.buildClusters(orderedPackets),
        );
        this.sink.write(this.buildEbmlHeader());
        this.sink.write(ebmlElement(0x18538067, segmentPayload));
        this.sink.close();
    }

    private buildEbmlHeader(): Uint8Array {
        const docType = this.cfg.format === 'mkv' ? 'matroska' : 'webm';
        return ebmlElement(0x1A45DFA3, concat(
            ebmlUint(0x4286, 1),
            ebmlUint(0x42F7, 1),
            ebmlUint(0x42F2, 4),
            ebmlUint(0x42F3, 8),
            ebmlString(0x4282, docType),
            ebmlUint(0x4287, docType === 'matroska' ? 4 : 2),
            ebmlUint(0x4285, 2),
        ));
    }

    private buildSegmentInfo(durationSeconds: number): Uint8Array {
        return ebmlElement(0x1549A966, concat(
            ebmlUint(0x2AD7B1, 1000000),
            ebmlFloat(0x4489, durationSeconds * 1000),
            ebmlString(0x4D80, 'FlowCast'),
            ebmlString(0x5741, 'FlowCast'),
        ));
    }

    private buildTracks(): Uint8Array {
        const entries: Uint8Array[] = [];
        if (this.cfg.video) entries.push(this.buildVideoTrackEntry(1));
        if (this.cfg.audio) entries.push(this.buildAudioTrackEntry(this.cfg.video ? 2 : 1));
        return ebmlElement(0x1654AE6B, concat(...entries));
    }

    private buildVideoTrackEntry(trackNum: number): Uint8Array {
        const video = this.cfg.video;
        if (!video) throw new Error('Missing video track config');
        const codecId = video.codec === 'vp8'
            ? 'V_VP8'
            : (video.codec.startsWith('vp09') || video.codec.startsWith('vp9'))
                ? 'V_VP9'
                : video.codec.startsWith('av01')
                    ? 'V_AV1'
                    : 'V_VP8';

        const videoChildren: Uint8Array[] = [
            ebmlUint(0xB0, video.width || 1),
            ebmlUint(0xBA, video.height || 1),
        ];
        if (video.displayWidth && video.displayHeight) {
            videoChildren.push(ebmlUint(0x54B0, video.displayWidth));
            videoChildren.push(ebmlUint(0x54BA, video.displayHeight));
            videoChildren.push(ebmlUint(0x54B2, 0));
        }

        const trackChildren: Uint8Array[] = [
            ebmlUint(0xD7, trackNum),
            ebmlUint(0x73C5, trackNum),
            ebmlUint(0x83, 1),
            ebmlString(0x86, codecId),
        ];
        if (video.framerate > 0) {
            trackChildren.push(ebmlUint(0x23E383, Math.max(1, Math.round(1_000_000_000 / video.framerate))));
        }
        if (this.videoConfig && this.videoConfig.length > 0) trackChildren.push(ebmlBinary(0x63A2, this.videoConfig));
        trackChildren.push(ebmlElement(0xE0, concat(...videoChildren)));
        return ebmlElement(0xAE, concat(...trackChildren));
    }

    private buildAudioTrackEntry(trackNum: number): Uint8Array {
        const audio = this.cfg.audio;
        if (!audio) throw new Error('Missing audio track config');
        const codecId = audio.codec === 'vorbis' ? 'A_VORBIS' : 'A_OPUS';
        const trackChildren: Uint8Array[] = [
            ebmlUint(0xD7, trackNum),
            ebmlUint(0x73C5, trackNum),
            ebmlUint(0x83, 2),
            ebmlString(0x86, codecId),
        ];
        if (codecId === 'A_OPUS') {
            const opus = parseOpusHead(this.audioConfig, audio.channelCount || 2, audio.sampleRate || 48000);
            trackChildren.push(ebmlBinary(0x63A2, opus.head));
            trackChildren.push(ebmlUint(0x56AA, Math.round((opus.preSkip * 1_000_000_000) / 48000)));
            trackChildren.push(ebmlUint(0x56BB, 80_000_000));
            trackChildren.push(ebmlElement(0xE1, concat(
                ebmlFloat(0xB5, 48000),
                ebmlUint(0x9F, opus.channels),
            )));
        } else {
            if (this.audioConfig && this.audioConfig.length > 0) trackChildren.push(ebmlBinary(0x63A2, this.audioConfig));
            trackChildren.push(ebmlElement(0xE1, concat(
                ebmlFloat(0xB5, audio.sampleRate || 48000),
                ebmlUint(0x9F, audio.channelCount || 2),
            )));
        }
        return ebmlElement(0xAE, concat(...trackChildren));
    }

    private buildClusters(packets: BufferedPacket[]): Uint8Array[] {
        const clusters: Uint8Array[] = [];
        const clusterDurationMs = 2000;
        let clusterPackets: BufferedPacket[] = [];
        let clusterStartMs = 0;

        const flush = (): void => {
            if (clusterPackets.length === 0) return;
            const children: Uint8Array[] = [ebmlUint(0xE7, clusterStartMs)];
            for (const packet of clusterPackets) {
                const absoluteMs = Math.round(packet.chunk.timestamp * 1000);
                const relMs = Math.max(-32768, Math.min(32767, absoluteMs - clusterStartMs));
                const payload = new Uint8Array(4 + packet.chunk.data.length);
                payload[0] = 0x80 | packet.trackNum;
                payload[1] = (relMs >> 8) & 0xFF;
                payload[2] = relMs & 0xFF;
                payload[3] = packet.chunk.isKeyframe || packet.chunk.trackType === 'audio' ? 0x80 : 0;
                payload.set(packet.chunk.data, 4);
                children.push(ebmlElement(0xA3, payload));
            }
            clusters.push(ebmlElement(0x1F43B675, concat(...children)));
            clusterPackets = [];
        };

        for (const packet of packets) {
            const timestampMs = Math.round(packet.chunk.timestamp * 1000);
            if (clusterPackets.length === 0) clusterStartMs = timestampMs;
            if (timestampMs - clusterStartMs >= clusterDurationMs) {
                flush();
                clusterStartMs = timestampMs;
            }
            clusterPackets.push(packet);
        }
        flush();
        return clusters;
    }
}
