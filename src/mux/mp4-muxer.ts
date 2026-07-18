import type { Sink } from '../types/io';
import type { MuxerConfig } from '../types/container';
import type { EncodedChunk } from '../types/media';
import { EncodeError } from '../core/errors';

const ascii = (s: string): Uint8Array => {
    const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
};

function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
    let total = 8;
    for (const p of payloads) total += p.length;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, total, false);
    out.set(ascii(type), 4);
    let pos = 8;
    for (const p of payloads) {
        out.set(p, pos);
        pos += p.length;
    }
    return out;
}

function fullBox(type: string, version: number, flags: number, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + payload.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, out.length, false);
    out.set(ascii(type), 4);
    out[8] = version;
    out[9] = (flags >> 16) & 0xFF;
    out[10] = (flags >> 8) & 0xFF;
    out[11] = flags & 0xFF;
    out.set(payload, 12);
    return out;
}

function u32be(v: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, v >>> 0, false);
    return out;
}

function fixed16_16(v: number): number {
    return Math.max(0, Math.round(v * 65536));
}

function toUint32Seconds(value: number, timescale: number): number {
    return Math.max(0, Math.round(value * timescale));
}

function sameRuns(values: number[]): { value: number; count: number }[] {
    const runs: { value: number; count: number }[] = [];
    for (const value of values) {
        if (runs.length > 0 && runs[runs.length - 1].value === value) runs[runs.length - 1].count++;
        else runs.push({ value, count: 1 });
    }
    return runs;
}

function signed32Payload(value: number): number {
    return value < 0 ? value + 0x100000000 : value;
}

interface TrackTiming {
    readonly decodeDurations: number[];
    readonly compositionOffsets: number[];
    readonly durationUnits: number;
    /** Earliest presentation time of the track, in seconds. */
    readonly startSeconds: number;
    /** Earliest presentation minus first decode time, in track units (>= 0). */
    readonly mediaTimeUnits: number;
}

/**
 * Sample durations are anchored to the chunk timestamps: each duration is the
 * integer-timescale difference between consecutive decode times, so rounding
 * never accumulates and variable frame rates survive intact. The old
 * per-chunk `duration` field is only used for the final sample.
 */
function readChunkTiming(chunks: EncodedChunk[], timescale: number): TrackTiming {
    const count = chunks.length;
    const decodeDurations: number[] = [];
    const compositionOffsets: number[] = [];
    if (count === 0) {
        return { decodeDurations, compositionOffsets, durationUnits: 0, startSeconds: 0, mediaTimeUnits: 0 };
    }

    const firstDecode = chunks[0].decodeTimestamp ?? chunks[0].timestamp;
    const decodeUnits = new Array<number>(count);
    for (let i = 0; i < count; i++) {
        const dts = chunks[i].decodeTimestamp ?? chunks[i].timestamp;
        decodeUnits[i] = Math.round((dts - firstDecode) * timescale);
    }

    let durationUnits = 0;
    let debt = 0;
    let startSeconds = Number.POSITIVE_INFINITY;
    for (let i = 0; i < count; i++) {
        let duration = i + 1 < count
            ? decodeUnits[i + 1] - decodeUnits[i]
            : Math.max(1, toUint32Seconds(chunks[i].duration, timescale));
        duration -= debt;
        debt = 0;
        if (duration < 1) {
            debt = 1 - duration;
            duration = 1;
        }
        decodeDurations.push(duration);
        durationUnits += duration;

        const explicitCto = chunks[i].compositionTimeOffset;
        const ctoUnits = explicitCto !== undefined
            ? Math.round(explicitCto * timescale)
            : chunks[i].decodeTimestamp !== undefined
                ? Math.round((chunks[i].timestamp - firstDecode) * timescale) - decodeUnits[i]
                : 0;
        compositionOffsets.push(ctoUnits);
        const presentation = chunks[i].timestamp;
        if (presentation < startSeconds) startSeconds = presentation;
    }

    const mediaTimeUnits = Math.max(0, Math.round((startSeconds - firstDecode) * timescale));
    return { decodeDurations, compositionOffsets, durationUnits, startSeconds, mediaTimeUnits };
}

export class MP4Muxer {
    private readonly sink: Sink;
    private readonly cfg: MuxerConfig;
    private readonly videoChunks: EncodedChunk[] = [];
    private readonly audioChunks: EncodedChunk[] = [];
    private videoConfig?: Uint8Array;
    private audioConfig?: Uint8Array;

    constructor(cfg: MuxerConfig, sink: Sink) {
        this.cfg = cfg;
        this.sink = sink;
        if (cfg.video?.codecConfig) this.videoConfig = new Uint8Array(cfg.video.codecConfig);
        if (cfg.audio?.codecConfig) this.audioConfig = new Uint8Array(cfg.audio.codecConfig);
    }

    addVideoChunk(chunk: EncodedChunk, codecCfg?: Uint8Array): void {
        if (codecCfg && !this.videoConfig) this.videoConfig = new Uint8Array(codecCfg);
        this.videoChunks.push(chunk);
    }

    addAudioChunk(chunk: EncodedChunk, codecCfg?: Uint8Array): void {
        if (codecCfg && !this.audioConfig) this.audioConfig = new Uint8Array(codecCfg);
        this.audioChunks.push(chunk);
    }

    /** Provide the audio decoder configuration (e.g. AAC AudioSpecificConfig) before finalize. */
    setAudioCodecConfig(codecConfig: Uint8Array): void {
        this.audioConfig = new Uint8Array(codecConfig);
    }

    finalize(): void {
        this.writeStandard();
        this.sink.close();
    }

    private writeStandard(): void {
        const hasV = !!this.cfg.video && this.videoChunks.length > 0;
        const hasA = !!this.cfg.audio && this.audioChunks.length > 0;

        const ftyp = this.buildFtyp();
        let dataLen = 0;
        const videoOffsets: number[] = [];
        const audioOffsets: number[] = [];

        if (hasV) {
            for (const chunk of this.videoChunks) {
                videoOffsets.push(dataLen);
                dataLen += chunk.data.length;
            }
        }
        if (hasA) {
            for (const chunk of this.audioChunks) {
                audioOffsets.push(dataLen);
                dataLen += chunk.data.length;
            }
        }

        let moov = this.buildMoov(hasV, hasA, videoOffsets, audioOffsets, 0);
        const mdatHeaderLen = 8;
        const base = ftyp.length + moov.length + mdatHeaderLen;
        moov = this.buildMoov(hasV, hasA, videoOffsets, audioOffsets, base);

        this.sink.write(ftyp);
        this.sink.write(moov);

        const mdatHeader = new Uint8Array(8);
        const dv = new DataView(mdatHeader.buffer);
        dv.setUint32(0, dataLen + 8, false);
        mdatHeader.set(ascii('mdat'), 4);
        this.sink.write(mdatHeader);

        if (hasV) for (const chunk of this.videoChunks) this.sink.write(chunk.data);
        if (hasA) for (const chunk of this.audioChunks) this.sink.write(chunk.data);
    }

    private buildFtyp(): Uint8Array {
        const fmt = this.cfg.format;
        let major = 'isom';
        const compatible: string[] = [];
        if (fmt === 'mov') {
            major = 'qt  ';
            compatible.push('qt  ');
        } else if (fmt === '3gp') {
            major = '3gp6';
            compatible.push('3gp6', 'isom');
        } else if (fmt === 'm4a') {
            major = 'M4A ';
            compatible.push('M4A ', 'isom', 'mp42');
        } else if (fmt === 'm4v') {
            major = 'mp42';
            compatible.push('mp42', 'isom', 'mp41');
        } else {
            major = 'isom';
            compatible.push('isom', 'iso2', 'mp41');
        }
        if (this.cfg.video?.codec.startsWith('hvc1') || this.cfg.video?.codec.startsWith('hev1')) compatible.push('iso8');
        if (this.cfg.video?.codec.startsWith('av01')) compatible.push('av01');

        const brands = [ascii(major), u32be(0x200), ...compatible.map(ascii)];
        let total = 8;
        for (const brand of brands) total += brand.length;
        const out = new Uint8Array(total);
        const dv = new DataView(out.buffer);
        dv.setUint32(0, total, false);
        out.set(ascii('ftyp'), 4);
        let pos = 8;
        for (const brand of brands) {
            out.set(brand, pos);
            pos += brand.length;
        }
        return out;
    }

    private buildMoov(hasV: boolean, hasA: boolean, videoOffsets: number[], audioOffsets: number[], base: number): Uint8Array {
        const movieTimescale = 1000;
        const videoTimescale = this.videoTimescale();
        const audioTimescale = this.audioTimescale();
        const videoTiming = hasV ? readChunkTiming(this.videoChunks, videoTimescale) : null;
        const audioTiming = hasA ? readChunkTiming(this.audioChunks, audioTimescale) : null;
        const videoMovieDuration = videoTiming ? Math.round(videoTiming.durationUnits / videoTimescale * movieTimescale) : 0;
        const audioMovieDuration = audioTiming ? Math.round(audioTiming.durationUnits / audioTimescale * movieTimescale) : 0;

        // Preserve the source's inter-track start offset: the earlier track
        // anchors the movie, the later one gets an empty leading edit.
        const baseStart = Math.min(
            videoTiming ? videoTiming.startSeconds : Number.POSITIVE_INFINITY,
            audioTiming ? audioTiming.startSeconds : Number.POSITIVE_INFINITY,
        );
        const videoLead = videoTiming ? Math.max(0, Math.round((videoTiming.startSeconds - baseStart) * movieTimescale)) : 0;
        const audioLead = audioTiming ? Math.max(0, Math.round((audioTiming.startSeconds - baseStart) * movieTimescale)) : 0;
        const movieDuration = Math.max(videoLead + videoMovieDuration, audioLead + audioMovieDuration);

        const traks: Uint8Array[] = [];
        if (hasV) {
            traks.push(this.buildTrak(1, true, this.videoChunks, videoOffsets, base, videoTimescale, videoTiming!, videoMovieDuration, videoLead));
        }
        if (hasA) {
            traks.push(this.buildTrak(hasV ? 2 : 1, false, this.audioChunks, audioOffsets, base, audioTimescale, audioTiming!, audioMovieDuration, audioLead));
        }
        return box('moov', this.buildMvhd(movieTimescale, movieDuration, traks.length + 1), ...traks);
    }

    private buildMvhd(timescale: number, duration: number, nextTrackId: number): Uint8Array {
        const payload = new Uint8Array(100);
        const dv = new DataView(payload.buffer);
        dv.setUint32(8, timescale, false);
        dv.setUint32(12, duration, false);
        dv.setUint32(16, 0x00010000, false);
        dv.setUint16(20, 0x0100, false);
        dv.setUint32(32, 0x00010000, false);
        dv.setUint32(48, 0x00010000, false);
        dv.setUint32(64, 0x40000000, false);
        dv.setUint32(96, nextTrackId, false);
        return fullBox('mvhd', 0, 0, payload);
    }

    private buildTrak(
        id: number,
        isVideo: boolean,
        chunks: EncodedChunk[],
        offsets: number[],
        base: number,
        trackTimescale: number,
        timing: TrackTiming,
        movieDuration: number,
        leadMovieUnits: number,
    ): Uint8Array {
        const tkhd = this.buildTkhd(id, isVideo, leadMovieUnits + movieDuration);
        const mdhd = this.buildMdhd(trackTimescale, timing.durationUnits);
        const minf = this.buildMinf(isVideo, chunks, offsets, base, timing);
        const mdia = box('mdia', mdhd, this.buildHdlr(isVideo), minf);
        if (leadMovieUnits > 0 || timing.mediaTimeUnits > 0) {
            return box('trak', tkhd, this.buildEdts(leadMovieUnits, movieDuration, timing.mediaTimeUnits), mdia);
        }
        return box('trak', tkhd, mdia);
    }

    /**
     * Edit list: an optional empty edit delays the track, then the media
     * plays from media_time (trimming the decoder lead-in of B-frame video).
     */
    private buildEdts(leadMovieUnits: number, movieDuration: number, mediaTimeUnits: number): Uint8Array {
        const entryCount = leadMovieUnits > 0 ? 2 : 1;
        const payload = new Uint8Array(4 + entryCount * 12);
        const dv = new DataView(payload.buffer);
        dv.setUint32(0, entryCount, false);
        let p = 4;
        if (leadMovieUnits > 0) {
            dv.setUint32(p, leadMovieUnits, false);
            dv.setInt32(p + 4, -1, false); // media_time -1: empty edit
            dv.setUint32(p + 8, 0x00010000, false);
            p += 12;
        }
        dv.setUint32(p, movieDuration, false);
        dv.setInt32(p + 4, mediaTimeUnits, false);
        dv.setUint32(p + 8, 0x00010000, false);
        return box('edts', fullBox('elst', 0, 0, payload));
    }

    private buildTkhd(id: number, isVideo: boolean, duration: number): Uint8Array {
        const payload = new Uint8Array(80);
        const dv = new DataView(payload.buffer);
        dv.setUint32(8, id, false);
        dv.setUint32(16, duration, false);
        if (!isVideo) dv.setUint16(32, 0x0100, false);
        dv.setUint32(36, 0x00010000, false);
        dv.setUint32(52, 0x00010000, false);
        dv.setUint32(68, 0x40000000, false);
        if (isVideo && this.cfg.video) {
            const displayWidth = this.cfg.video.displayWidth ?? this.cfg.video.width;
            const displayHeight = this.cfg.video.displayHeight ?? this.cfg.video.height;
            dv.setUint32(72, fixed16_16(displayWidth), false);
            dv.setUint32(76, fixed16_16(displayHeight), false);
        }
        return fullBox('tkhd', 0, 0x000003, payload);
    }

    private buildMdhd(timescale: number, duration: number): Uint8Array {
        const payload = new Uint8Array(20);
        const dv = new DataView(payload.buffer);
        dv.setUint32(8, timescale, false);
        dv.setUint32(12, duration, false);
        dv.setUint16(16, 0x55C4, false);
        return fullBox('mdhd', 0, 0, payload);
    }

    private buildHdlr(isVideo: boolean): Uint8Array {
        // fullbox payload: pre_defined(4) + handler_type(4) + reserved(12) + name
        const name = isVideo ? 'VideoHandler\0' : 'SoundHandler\0';
        const payload = new Uint8Array(20 + name.length);
        payload.set(ascii(isVideo ? 'vide' : 'soun'), 4);
        payload.set(ascii(name), 20);
        return fullBox('hdlr', 0, 0, payload);
    }

    private buildMinf(
        isVideo: boolean,
        chunks: EncodedChunk[],
        offsets: number[],
        base: number,
        timing: TrackTiming,
    ): Uint8Array {
        const mediaHeader = isVideo
            ? fullBox('vmhd', 0, 1, new Uint8Array(8))
            : fullBox('smhd', 0, 0, new Uint8Array(4));
        return box('minf', mediaHeader, this.buildDinf(), this.buildStbl(isVideo, chunks, offsets, base, timing));
    }

    private buildDinf(): Uint8Array {
        const entry = fullBox('url ', 0, 1, new Uint8Array(0));
        const payload = new Uint8Array(4 + entry.length);
        new DataView(payload.buffer).setUint32(0, 1, false);
        payload.set(entry, 4);
        return box('dinf', fullBox('dref', 0, 0, payload));
    }

    private buildStbl(
        isVideo: boolean,
        chunks: EncodedChunk[],
        offsets: number[],
        base: number,
        timing: TrackTiming,
    ): Uint8Array {
        const parts: Uint8Array[] = [
            this.buildStsd(isVideo),
            this.buildStts(timing.decodeDurations),
            this.buildStsc(),
            this.buildStsz(chunks),
            this.buildStco(offsets, base),
        ];
        const ctts = this.buildCtts(timing.compositionOffsets);
        if (ctts) parts.push(ctts);
        if (isVideo) {
            const stss = this.buildStss(chunks);
            if (stss) parts.push(stss);
        }
        return box('stbl', ...parts);
    }

    private buildStsd(isVideo: boolean): Uint8Array {
        const entry = isVideo ? this.buildVideoSampleEntry() : this.buildAudioSampleEntry();
        const payload = new Uint8Array(4 + entry.length);
        const dv = new DataView(payload.buffer);
        dv.setUint32(0, 1, false);
        payload.set(entry, 4);
        return fullBox('stsd', 0, 0, payload);
    }

    private buildVideoSampleEntry(): Uint8Array {
        const codec = this.cfg.video?.codec ?? 'avc1.640028';
        const sampleEntryType = this.resolveVideoSampleEntryType(codec);
        const configBoxType = sampleEntryType === 'av01'
            ? 'av1C'
            : (sampleEntryType === 'hvc1' || sampleEntryType === 'hev1')
                ? 'hvcC'
                : 'avcC';
        const width = this.cfg.video?.width ?? 0;
        const height = this.cfg.video?.height ?? 0;
        const payloads: Uint8Array[] = [];

        if (this.videoConfig) payloads.push(box(configBoxType, this.videoConfig));
        const parNum = this.cfg.video?.pixelAspectRatioNum ?? 1;
        const parDen = this.cfg.video?.pixelAspectRatioDen ?? 1;
        if (parNum > 0 && parDen > 0 && !(parNum === 1 && parDen === 1)) {
            payloads.push(box('pasp', u32be(parNum), u32be(parDen)));
        }

        let total = 86;
        for (const payload of payloads) total += payload.length;
        const out = new Uint8Array(total);
        const dv = new DataView(out.buffer);
        dv.setUint32(0, total, false);
        out.set(ascii(sampleEntryType), 4);
        dv.setUint16(14, 1, false);
        dv.setUint16(32, width, false);
        dv.setUint16(34, height, false);
        dv.setUint32(36, 0x00480000, false);
        dv.setUint32(40, 0x00480000, false);
        dv.setUint16(48, 1, false);
        dv.setUint16(82, 0x0018, false);
        dv.setUint16(84, 0xFFFF, false);
        let pos = 86;
        for (const payload of payloads) {
            out.set(payload, pos);
            pos += payload.length;
        }
        return out;
    }

    private buildAudioSampleEntry(): Uint8Array {
        const codec = this.cfg.audio?.codec ?? 'mp4a.40.2';
        if (codec.startsWith('mp4a')) return this.buildMp4aEntry();
        if (codec === 'ac-3' || codec === 'ec-3') return this.buildDolbyAudioEntry(codec);
        throw new EncodeError(`MP4 muxer does not support audio codec '${codec}'`);
    }

    private buildMp4aEntry(): Uint8Array {
        const sampleRate = this.cfg.audio?.sampleRate ?? 48000;
        const channelCount = this.cfg.audio?.channelCount ?? 2;
        const esds = this.buildEsds(sampleRate, channelCount, this.audioConfig);
        const out = new Uint8Array(36 + esds.length);
        const dv = new DataView(out.buffer);
        dv.setUint32(0, out.length, false);
        out.set(ascii('mp4a'), 4);
        dv.setUint16(14, 1, false);
        dv.setUint16(24, channelCount, false);
        dv.setUint16(26, 16, false);
        dv.setUint32(32, sampleRate << 16, false);
        out.set(esds, 36);
        return out;
    }

    private buildDolbyAudioEntry(codec: 'ac-3' | 'ec-3'): Uint8Array {
        const sampleRate = this.cfg.audio?.sampleRate ?? 48000;
        const channelCount = this.cfg.audio?.channelCount ?? 2;
        const configBoxType = codec === 'ac-3' ? 'dac3' : 'dec3';
        const configBox = this.audioConfig ? box(configBoxType, this.audioConfig) : new Uint8Array(0);
        const out = new Uint8Array(36 + configBox.length);
        const dv = new DataView(out.buffer);
        dv.setUint32(0, out.length, false);
        out.set(ascii(codec), 4);
        dv.setUint16(14, 1, false);
        dv.setUint16(24, channelCount, false);
        dv.setUint16(26, 16, false);
        dv.setUint32(32, sampleRate << 16, false);
        if (configBox.length > 0) out.set(configBox, 36);
        return out;
    }

    private resolveVideoSampleEntryType(codec: string): 'avc1' | 'hvc1' | 'hev1' | 'av01' {
        if (codec.startsWith('avc1') || codec.startsWith('avc3') || codec.startsWith('avc')) return 'avc1';
        if (codec.startsWith('hvc1')) return 'hvc1';
        if (codec.startsWith('hev1') || codec.startsWith('hev')) return 'hev1';
        if (codec.startsWith('av01')) return 'av01';
        throw new EncodeError(`MP4 muxer does not support video codec '${codec}'`);
    }

    private buildEsds(sampleRate: number, channelCount: number, audioSpecificConfig?: Uint8Array): Uint8Array {
        const freqTable = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
        const freqIndex = Math.max(0, freqTable.indexOf(sampleRate));
        const asc = audioSpecificConfig && audioSpecificConfig.length > 0
            ? new Uint8Array(audioSpecificConfig)
            : new Uint8Array([(2 << 3) | (freqIndex >> 1), ((freqIndex & 1) << 7) | (channelCount << 3)]);
        const dsi = new Uint8Array([0x05, 0x80, 0x80, 0x80, asc.length, ...asc]);
        const decoderConfig = new Uint8Array([
            0x40, 0x15, 0x00, 0x00, 0x00,
            0x00, 0x01, 0xF4, 0x00,
            0x00, 0x01, 0xF4, 0x00,
            ...dsi,
        ]);
        const decoderConfigDesc = new Uint8Array([0x04, 0x80, 0x80, 0x80, decoderConfig.length, ...decoderConfig]);
        const slConfig = new Uint8Array([0x06, 0x80, 0x80, 0x80, 0x01, 0x02]);
        const esPayload = new Uint8Array([0x00, 0x01, 0x00, ...decoderConfigDesc, ...slConfig]);
        const esDesc = new Uint8Array([0x03, 0x80, 0x80, 0x80, esPayload.length, ...esPayload]);
        return fullBox('esds', 0, 0, esDesc);
    }

    private buildStts(durations: number[]): Uint8Array {
        const runs = sameRuns(durations);
        const payload = new Uint8Array(4 + runs.length * 8);
        const dv = new DataView(payload.buffer);
        dv.setUint32(0, runs.length, false);
        for (let i = 0; i < runs.length; i++) {
            dv.setUint32(4 + i * 8, runs[i].count, false);
            dv.setUint32(8 + i * 8, runs[i].value, false);
        }
        return fullBox('stts', 0, 0, payload);
    }

    private buildCtts(compositionOffsets: number[]): Uint8Array | null {
        if (compositionOffsets.length === 0 || compositionOffsets.every((value) => value === 0)) return null;
        const runs = sameRuns(compositionOffsets);
        const version = compositionOffsets.some((value) => value < 0) ? 1 : 0;
        const payload = new Uint8Array(4 + runs.length * 8);
        const dv = new DataView(payload.buffer);
        dv.setUint32(0, runs.length, false);
        for (let i = 0; i < runs.length; i++) {
            dv.setUint32(4 + i * 8, runs[i].count, false);
            dv.setUint32(8 + i * 8, signed32Payload(runs[i].value), false);
        }
        return fullBox('ctts', version, 0, payload);
    }

    private buildStsc(): Uint8Array {
        const payload = new Uint8Array(16);
        const dv = new DataView(payload.buffer);
        dv.setUint32(0, 1, false);
        dv.setUint32(4, 1, false);
        dv.setUint32(8, 1, false);
        dv.setUint32(12, 1, false);
        return fullBox('stsc', 0, 0, payload);
    }

    private buildStsz(chunks: EncodedChunk[]): Uint8Array {
        const payload = new Uint8Array(8 + chunks.length * 4);
        const dv = new DataView(payload.buffer);
        dv.setUint32(0, 0, false);
        dv.setUint32(4, chunks.length, false);
        for (let i = 0; i < chunks.length; i++) dv.setUint32(8 + i * 4, chunks[i].data.length, false);
        return fullBox('stsz', 0, 0, payload);
    }

    private buildStco(offsets: number[], base: number): Uint8Array {
        const payload = new Uint8Array(4 + offsets.length * 4);
        const dv = new DataView(payload.buffer);
        dv.setUint32(0, offsets.length, false);
        for (let i = 0; i < offsets.length; i++) dv.setUint32(4 + i * 4, base + offsets[i], false);
        return fullBox('stco', 0, 0, payload);
    }

    private buildStss(chunks: EncodedChunk[]): Uint8Array | null {
        const syncSamples: number[] = [];
        for (let i = 0; i < chunks.length; i++) if (chunks[i].isKeyframe) syncSamples.push(i + 1);
        if (syncSamples.length === 0 || syncSamples.length === chunks.length) return null;
        const payload = new Uint8Array(4 + syncSamples.length * 4);
        const dv = new DataView(payload.buffer);
        dv.setUint32(0, syncSamples.length, false);
        for (let i = 0; i < syncSamples.length; i++) dv.setUint32(4 + i * 4, syncSamples[i], false);
        return fullBox('stss', 0, 0, payload);
    }

    private videoTimescale(): number {
        return 90000;
    }

    private audioTimescale(): number {
        return this.cfg.audio?.sampleRate ?? 48000;
    }
}
