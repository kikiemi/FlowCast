import type { Sink } from '../types/io';
import type { MuxerConfig } from '../types/container';
import type { EncodedChunk } from '../types/media';
import { BinaryWriter } from '../core/binary-writer';

interface IndexEntry {
    fourcc: string;
    flags: number;
    offset: number;
    size: number;
}

interface PreparedChunk {
    fourcc: string;
    data: Uint8Array;
    ts: number;           // seconds
    durationSec: number;  // seconds
    isKey: boolean;
    sampleFrames: number; // audio only, otherwise 0
}

interface MoviBuildResult {
    data: Uint8Array;
    videoFrames: number;
    audioSampleFrames: number;
    index: IndexEntry[];
    maxChunkSize: number;
    maxVideoChunkSize: number;
    maxAudioChunkSize: number;
    avgBytesPerSec: number;
    videoStartSec: number;
    audioStartSec: number;
}

interface AvcConfigInfo {
    nalLengthSize: number;
    annexBConfig: Uint8Array;
}

export class AVIMuxer {
    private static readonly START_CODE = new Uint8Array([0x00, 0x00, 0x00, 0x01]);

    private readonly sink: Sink;
    private readonly cfg: MuxerConfig;

    private videoChunks: EncodedChunk[] = [];
    private audioChunks: EncodedChunk[] = [];

    private codecConfig?: Uint8Array;
    private annexBCodecConfig?: Uint8Array;
    private nalLengthSize?: number;

    private observedAudioSampleRate?: number;
    private observedAudioChannels?: number;

    constructor(cfg: MuxerConfig, sink: Sink) {
        this.cfg = cfg;
        this.sink = sink;
    }

    addVideoChunk(c: EncodedChunk, cfg?: Uint8Array): void {
        if (cfg && !this.codecConfig) {
            this.setCodecConfig(cfg);
        }

        this.videoChunks.push({
            ...c,
            data: new Uint8Array(c.data),
        });
    }

    addAudioChunk(c: EncodedChunk): void {
        this.audioChunks.push({
            ...c,
            data: new Uint8Array(c.data),
        });
    }

    addPCMBuffer(buf: AudioBuffer): void {
        const ch = buf.numberOfChannels;
        const len = buf.length;
        const blockSize = 4096;
        const channels: Float32Array[] = [];

        this.observedAudioSampleRate = buf.sampleRate;
        this.observedAudioChannels = ch;

        for (let c = 0; c < ch; c++) {
            channels.push(buf.getChannelData(c));
        }

        for (let off = 0; off < len; off += blockSize) {
            const end = Math.min(off + blockSize, len);
            const n = end - off;
            const pcm = new Int16Array(n * ch);

            for (let i = 0; i < n; i++) {
                for (let c = 0; c < ch; c++) {
                    const s = Math.max(-1, Math.min(1, channels[c][off + i]));
                    pcm[i * ch + c] = s < 0
                        ? Math.round(s * 32768)
                        : Math.round(s * 32767);
                }
            }

            this.audioChunks.push({
                data: new Uint8Array(pcm.buffer),
                timestamp: off / buf.sampleRate,
                duration: n / buf.sampleRate,
                isKeyframe: true,
                trackType: 'audio',
            });
        }
    }

    finalize(): void {
        const hasV = this.videoChunks.length > 0;
        const hasA = this.audioChunks.length > 0;

        if (!hasV && !hasA) {
            throw new Error('Nothing to mux');
        }

        const moviResult = this.buildMovi(hasV, hasA);
        const hdrl = this.buildHdrl(
            hasV,
            hasA,
            moviResult.videoFrames,
            moviResult.audioSampleFrames,
            moviResult.maxChunkSize,
            moviResult.maxVideoChunkSize,
            moviResult.maxAudioChunkSize,
            moviResult.avgBytesPerSec,
            moviResult.videoStartSec,
            moviResult.audioStartSec,
        );
        const movi = this.wrapList('movi', moviResult.data);
        const idx1 = this.buildIdx1(moviResult.index);

        const riffPayloadSize = 4 + hdrl.length + movi.length + idx1.length;

        const w = new BinaryWriter();
        w.writeASCII('RIFF');
        w.writeU32LE(riffPayloadSize);
        w.writeASCII('AVI ');
        w.writeBytes(hdrl);
        w.writeBytes(movi);
        w.writeBytes(idx1);

        this.sink.write(w.toUint8Array());
        this.sink.close();
    }

    private buildMovi(hasV: boolean, hasA: boolean): MoviBuildResult {
        const videoFourCC = '00dc';
        const audioFourCC = hasV ? '01wb' : '00wb';

        const preparedVideo = hasV ? this.prepareVideoChunks(videoFourCC) : [];
        const preparedAudio = hasA ? this.prepareAudioChunks(audioFourCC) : [];

        const firstVideoTs = preparedVideo.length > 0 ? preparedVideo[0].ts : Number.POSITIVE_INFINITY;
        const firstAudioTs = preparedAudio.length > 0 ? preparedAudio[0].ts : Number.POSITIVE_INFINITY;
        const baseStartSec = Number.isFinite(Math.min(firstVideoTs, firstAudioTs))
            ? Math.min(firstVideoTs, firstAudioTs)
            : 0;

        const videoStartSec = preparedVideo.length > 0 ? Math.max(0, preparedVideo[0].ts - baseStartSec) : 0;
        const audioStartSec = preparedAudio.length > 0 ? Math.max(0, preparedAudio[0].ts - baseStartSec) : 0;

        const merged = this.mergePreparedChunks(preparedVideo, preparedAudio);

        const w = new BinaryWriter();
        const index: IndexEntry[] = [];

        let maxChunkSize = 0;
        let maxVideoChunkSize = 0;
        let maxAudioChunkSize = 0;

        let videoFrames = 0;
        let audioSampleFrames = 0;

        let totalMediaBytes = 0;
        let videoEndSec = preparedVideo.length > 0
            ? Math.max(...preparedVideo.map(c => c.ts + c.durationSec))
            : baseStartSec;
        let audioEndSec = preparedAudio.length > 0
            ? Math.max(...preparedAudio.map(c => c.ts + c.durationSec))
            : baseStartSec;

        for (const m of merged) {
            const offset = w.size;

            w.writeASCII(m.fourcc);
            w.writeU32LE(m.data.length);
            w.writeBytes(m.data);
            if ((m.data.length & 1) !== 0) {
                w.writeU8(0);
            }

            index.push({
                fourcc: m.fourcc,
                flags: m.isKey ? 0x10 : 0,
                offset,
                size: m.data.length,
            });

            totalMediaBytes += m.data.length;
            if (m.data.length > maxChunkSize) maxChunkSize = m.data.length;

            if (m.fourcc.endsWith('dc')) {
                videoFrames++;
                if (m.data.length > maxVideoChunkSize) maxVideoChunkSize = m.data.length;
            } else if (m.fourcc.endsWith('wb')) {
                audioSampleFrames += m.sampleFrames;
                if (m.data.length > maxAudioChunkSize) maxAudioChunkSize = m.data.length;
            }
        }

        const overallDuration = Math.max(
            0.001,
            Math.max(videoEndSec, audioEndSec) - baseStartSec,
        );
        const avgBytesPerSec = Math.ceil(totalMediaBytes / overallDuration);

        return {
            data: w.toUint8Array(),
            videoFrames,
            audioSampleFrames,
            index,
            maxChunkSize,
            maxVideoChunkSize,
            maxAudioChunkSize,
            avgBytesPerSec,
            videoStartSec,
            audioStartSec,
        };
    }

    private mergePreparedChunks(video: PreparedChunk[], audio: PreparedChunk[]): PreparedChunk[] {
        const merged: PreparedChunk[] = [];
        let vi = 0;
        let ai = 0;

        while (vi < video.length || ai < audio.length) {
            if (vi >= video.length) {
                merged.push(audio[ai++]);
                continue;
            }
            if (ai >= audio.length) {
                merged.push(video[vi++]);
                continue;
            }

            const v = video[vi];
            const a = audio[ai];

            // 同時刻なら video を先に出す
            if (v.ts <= a.ts) {
                merged.push(v);
                vi++;
            } else {
                merged.push(a);
                ai++;
            }
        }

        return merged;
    }

    private prepareVideoChunks(fourcc: string): PreparedChunk[] {
        const tb = this.getVideoRateScale();
        const defaultFrameDur = tb.scale / tb.rate;

        const out: PreparedChunk[] = [];
        let nextFallbackTs = 0;

        for (let i = 0; i < this.videoChunks.length; i++) {
            const c = this.videoChunks[i];
            const ts = this.isFiniteNonNegative(c.timestamp) ? c.timestamp : nextFallbackTs;
            const durationSec = this.isFinitePositive(c.duration) ? c.duration : defaultFrameDur;
            const data = this.normalizeH264Chunk(c.data, c.isKeyframe);

            out.push({
                fourcc,
                data,
                ts,
                durationSec,
                isKey: !!c.isKeyframe,
                sampleFrames: 0,
            });

            nextFallbackTs = ts + durationSec;
        }

        return out;
    }

    private prepareAudioChunks(fourcc: string): PreparedChunk[] {
        const sr = this.getAudioSampleRate();

        const out: PreparedChunk[] = [];
        let nextFallbackTs = 0;

        for (let i = 0; i < this.audioChunks.length; i++) {
            const c = this.audioChunks[i];
            const sampleFrames = this.getAudioChunkSampleFrames(c);
            const fallbackDur = sampleFrames > 0 ? sampleFrames / sr : 0;
            const ts = this.isFiniteNonNegative(c.timestamp) ? c.timestamp : nextFallbackTs;
            const durationSec = this.isFinitePositive(c.duration) ? c.duration : fallbackDur;

            out.push({
                fourcc,
                data: c.data,
                ts,
                durationSec,
                isKey: true,
                sampleFrames,
            });

            nextFallbackTs = ts + durationSec;
        }

        return out;
    }

    private buildIdx1(entries: IndexEntry[]): Uint8Array {
        const w = new BinaryWriter();
        w.writeASCII('idx1');
        w.writeU32LE(entries.length * 16);

        for (const e of entries) {
            w.writeASCII(e.fourcc);
            w.writeU32LE(e.flags);

            // 多くの実装で通る old-style AVI index
            w.writeU32LE(e.offset + 4);
            w.writeU32LE(e.size);
        }

        return w.toUint8Array();
    }

    private buildHdrl(
        hasV: boolean,
        hasA: boolean,
        videoFrames: number,
        audioSampleFrames: number,
        maxChunkSize: number,
        maxVideoChunkSize: number,
        maxAudioChunkSize: number,
        avgBytesPerSec: number,
        videoStartSec: number,
        audioStartSec: number,
    ): Uint8Array {
        const avih = this.buildAvih(
            hasV,
            hasA,
            videoFrames,
            maxChunkSize,
            avgBytesPerSec,
        );

        const content = new BinaryWriter();
        content.writeBytes(avih);

        if (hasV) {
            content.writeBytes(this.buildVideoStream(
                videoFrames,
                maxVideoChunkSize,
                videoStartSec,
            ));
        }

        if (hasA) {
            content.writeBytes(this.buildAudioStream(
                audioSampleFrames,
                maxAudioChunkSize,
                audioStartSec,
            ));
        }

        return this.wrapList('hdrl', content.toUint8Array());
    }

    private buildAvih(
        hasV: boolean,
        hasA: boolean,
        videoFrames: number,
        maxChunkSize: number,
        avgBytesPerSec: number,
    ): Uint8Array {
        const tb = this.getVideoRateScale();
        const streamCount = (hasV ? 1 : 0) + (hasA ? 1 : 0);
        const width = hasV ? this.getVideoWidth() : 0;
        const height = hasV ? this.getVideoHeight() : 0;

        const w = new BinaryWriter();
        w.writeU32LE(hasV ? Math.round(1_000_000 * tb.scale / tb.rate) : 0); // dwMicroSecPerFrame
        w.writeU32LE(avgBytesPerSec);                                         // dwMaxBytesPerSec
        w.writeU32LE(0);                                                      // dwPaddingGranularity
        w.writeU32LE(0x10 | ((hasV && hasA) ? 0x100 : 0));                    // dwFlags
        w.writeU32LE(hasV ? videoFrames : 0);                                 // dwTotalFrames
        w.writeU32LE(0);                                                      // dwInitialFrames
        w.writeU32LE(streamCount);                                            // dwStreams
        w.writeU32LE(maxChunkSize);                                           // dwSuggestedBufferSize
        w.writeU32LE(width);                                                  // dwWidth
        w.writeU32LE(height);                                                 // dwHeight
        w.writeZeros(16);                                                     // dwReserved[4]

        return this.wrapChunk('avih', w.toUint8Array());
    }

    private buildVideoStream(
        frameCount: number,
        maxVideoChunkSize: number,
        videoStartSec: number,
    ): Uint8Array {
        const tb = this.getVideoRateScale();
        const vw = this.getVideoWidth();
        const vh = this.getVideoHeight();
        const videoStartUnits = Math.max(0, Math.round(videoStartSec * tb.rate / tb.scale));

        const strh = new BinaryWriter();
        strh.writeASCII('vids');            // fccType
        strh.writeASCII('H264');            // fccHandler
        strh.writeU32LE(0);                 // dwFlags
        strh.writeU16LE(0);                 // wPriority
        strh.writeU16LE(0);                 // wLanguage
        strh.writeU32LE(0);                 // dwInitialFrames
        strh.writeU32LE(tb.scale);          // dwScale
        strh.writeU32LE(tb.rate);           // dwRate
        strh.writeU32LE(videoStartUnits);   // dwStart
        strh.writeU32LE(frameCount);        // dwLength
        strh.writeU32LE(maxVideoChunkSize); // dwSuggestedBufferSize
        strh.writeU32LE(0xFFFFFFFF);        // dwQuality
        strh.writeU32LE(0);                 // dwSampleSize
        strh.writeU16LE(0);                 // rcFrame.left
        strh.writeU16LE(0);                 // rcFrame.top
        strh.writeU16LE(vw);                // rcFrame.right
        strh.writeU16LE(vh);                // rcFrame.bottom

        const strf = new BinaryWriter();
        strf.writeU32LE(40);                // biSize
        strf.writeU32LE(vw);                // biWidth
        strf.writeU32LE(vh);                // biHeight
        strf.writeU16LE(1);                 // biPlanes
        strf.writeU16LE(24);                // biBitCount
        strf.writeASCII('H264');            // biCompression
        strf.writeU32LE(0);                 // biSizeImage
        strf.writeU32LE(0);                 // biXPelsPerMeter
        strf.writeU32LE(0);                 // biYPelsPerMeter
        strf.writeU32LE(0);                 // biClrUsed
        strf.writeU32LE(0);                 // biClrImportant

        const content = new BinaryWriter();
        content.writeBytes(this.wrapChunk('strh', strh.toUint8Array()));
        content.writeBytes(this.wrapChunk('strf', strf.toUint8Array()));

        return this.wrapList('strl', content.toUint8Array());
    }

    private buildAudioStream(
        sampleFrames: number,
        maxAudioChunkSize: number,
        audioStartSec: number,
    ): Uint8Array {
        const sr = this.getAudioSampleRate();
        const ch = this.getAudioChannelCount();
        const blockAlign = this.getAudioBlockAlign();
        const bytesPerSec = this.getAudioBytesPerSec();
        const audioStartUnits = Math.max(0, Math.round(audioStartSec * sr));

        const strh = new BinaryWriter();
        strh.writeASCII('auds');              // fccType
        strh.writeU32LE(0);                   // fccHandler
        strh.writeU32LE(0);                   // dwFlags
        strh.writeU16LE(0);                   // wPriority
        strh.writeU16LE(0);                   // wLanguage
        strh.writeU32LE(0);                   // dwInitialFrames
        strh.writeU32LE(blockAlign);          // dwScale
        strh.writeU32LE(bytesPerSec);         // dwRate
        strh.writeU32LE(audioStartUnits);     // dwStart
        strh.writeU32LE(sampleFrames);        // dwLength
        strh.writeU32LE(maxAudioChunkSize);   // dwSuggestedBufferSize
        strh.writeU32LE(0xFFFFFFFF);          // dwQuality
        strh.writeU32LE(blockAlign);          // dwSampleSize
        strh.writeU16LE(0);                   // rcFrame.left
        strh.writeU16LE(0);                   // rcFrame.top
        strh.writeU16LE(0);                   // rcFrame.right
        strh.writeU16LE(0);                   // rcFrame.bottom

        // PCM WAVEFORMAT (16 bytes)
        const strf = new BinaryWriter();
        strf.writeU16LE(0x0001);              // WAVE_FORMAT_PCM
        strf.writeU16LE(ch);                  // nChannels
        strf.writeU32LE(sr);                  // nSamplesPerSec
        strf.writeU32LE(bytesPerSec);         // nAvgBytesPerSec
        strf.writeU16LE(blockAlign);          // nBlockAlign
        strf.writeU16LE(16);                  // wBitsPerSample

        const content = new BinaryWriter();
        content.writeBytes(this.wrapChunk('strh', strh.toUint8Array()));
        content.writeBytes(this.wrapChunk('strf', strf.toUint8Array()));

        return this.wrapList('strl', content.toUint8Array());
    }

    private wrapChunk(fourcc: string, data: Uint8Array): Uint8Array {
        const w = new BinaryWriter();
        w.writeASCII(fourcc);
        w.writeU32LE(data.length);
        w.writeBytes(data);
        if ((data.length & 1) !== 0) {
            w.writeU8(0);
        }
        return w.toUint8Array();
    }

    private wrapList(fourcc: string, data: Uint8Array): Uint8Array {
        const w = new BinaryWriter();
        const listSize = data.length + 4;

        w.writeASCII('LIST');
        w.writeU32LE(listSize);
        w.writeASCII(fourcc);
        w.writeBytes(data);

        if ((listSize & 1) !== 0) {
            w.writeU8(0);
        }

        return w.toUint8Array();
    }

    private getVideoRateScale(): { rate: number; scale: number } {
        const fps = this.getConfiguredOrEstimatedVideoFps();
        return this.fpsToAviRateScale(fps);
    }

    private getConfiguredOrEstimatedVideoFps(): number {
        const cfgFps = this.cfg.video?.framerate;
        if (typeof cfgFps === 'number' && Number.isFinite(cfgFps) && cfgFps > 0) {
            return cfgFps;
        }

        const estimated = this.estimateVideoFpsFromChunks();
        if (estimated && Number.isFinite(estimated) && estimated > 0) {
            return estimated;
        }

        return 30;
    }

    private estimateVideoFpsFromChunks(): number | undefined {
        if (this.videoChunks.length >= 2) {
            const deltas: number[] = [];
            for (let i = 1; i < this.videoChunks.length; i++) {
                const dt = this.videoChunks[i].timestamp - this.videoChunks[i - 1].timestamp;
                if (Number.isFinite(dt) && dt > 0 && dt < 10) {
                    deltas.push(dt);
                }
            }
            if (deltas.length > 0) {
                deltas.sort((a, b) => a - b);
                const median = deltas[deltas.length >> 1];
                if (median > 0) return 1 / median;
            }
        }

        const durations: number[] = [];
        for (const c of this.videoChunks) {
            if (Number.isFinite(c.duration) && c.duration > 0 && c.duration < 10) {
                durations.push(c.duration);
            }
        }
        if (durations.length > 0) {
            durations.sort((a, b) => a - b);
            const median = durations[durations.length >> 1];
            if (median > 0) return 1 / median;
        }

        return undefined;
    }

    private fpsToAviRateScale(fps: number): { rate: number; scale: number } {
        if (!Number.isFinite(fps) || fps <= 0) {
            return { rate: 30, scale: 1 };
        }

        const common = [
            { fps: 24000 / 1001, rate: 24000, scale: 1001 },
            { fps: 30000 / 1001, rate: 30000, scale: 1001 },
            { fps: 60000 / 1001, rate: 60000, scale: 1001 },
            { fps: 120000 / 1001, rate: 120000, scale: 1001 },
            { fps: 24, rate: 24, scale: 1 },
            { fps: 25, rate: 25, scale: 1 },
            { fps: 30, rate: 30, scale: 1 },
            { fps: 50, rate: 50, scale: 1 },
            { fps: 60, rate: 60, scale: 1 },
        ];

        for (const c of common) {
            if (Math.abs(fps - c.fps) < 0.01) {
                return { rate: c.rate, scale: c.scale };
            }
        }

        const scale = 1_000_000;
        const rate = Math.max(1, Math.round(fps * scale));
        const g = this.gcd(rate, scale);

        return {
            rate: Math.floor(rate / g),
            scale: Math.floor(scale / g),
        };
    }

    private gcd(a: number, b: number): number {
        a = Math.abs(Math.trunc(a));
        b = Math.abs(Math.trunc(b));

        while (b !== 0) {
            const t = a % b;
            a = b;
            b = t;
        }

        return a || 1;
    }

    private getVideoWidth(): number {
        return this.cfg.video?.width ?? 1920;
    }

    private getVideoHeight(): number {
        return this.cfg.video?.height ?? 1080;
    }

    private getAudioSampleRate(): number {
        return this.cfg.audio?.sampleRate
            ?? this.observedAudioSampleRate
            ?? 48000;
    }

    private getAudioChannelCount(): number {
        return this.cfg.audio?.channelCount
            ?? this.observedAudioChannels
            ?? 2;
    }

    private getAudioBlockAlign(): number {
        return this.getAudioChannelCount() * 2;
    }

    private getAudioBytesPerSec(): number {
        return this.getAudioSampleRate() * this.getAudioBlockAlign();
    }

    private getAudioChunkSampleFrames(c: EncodedChunk): number {
        const blockAlign = this.getAudioBlockAlign();
        if (blockAlign > 0 && c.data.length >= blockAlign) {
            return Math.floor(c.data.length / blockAlign);
        }

        const sr = this.getAudioSampleRate();
        if (this.isFinitePositive(c.duration)) {
            return Math.max(0, Math.round(c.duration * sr));
        }

        return 0;
    }

    private setCodecConfig(cfg: Uint8Array): void {
        this.codecConfig = new Uint8Array(cfg);

        if (this.isAnnexB(cfg)) {
            this.annexBCodecConfig = new Uint8Array(cfg);
            return;
        }

        const parsed = this.parseAvcDecoderConfigurationRecord(cfg);
        if (parsed) {
            this.nalLengthSize = parsed.nalLengthSize;
            this.annexBCodecConfig = parsed.annexBConfig;
        }
    }

    private normalizeH264Chunk(data: Uint8Array, isKeyframe: boolean): Uint8Array {
        let out = data;

        if (!this.isAnnexB(out)) {
            let nalLengthSize = this.nalLengthSize;

            if (!nalLengthSize) {
                nalLengthSize = this.guessAvccNalLengthSize(out);
            }

            if (!nalLengthSize) {
                throw new Error(
                    'H.264 chunk is not Annex B and AVCC length size is unknown. ' +
                    'Pass codec config to addVideoChunk(), or configure encoder for Annex B output.'
                );
            }

            const converted = this.convertAvccSampleToAnnexB(out, nalLengthSize);
            if (!converted) {
                throw new Error('Failed to convert H.264 sample from AVCC to Annex B.');
            }
            out = converted;
        }

        if (isKeyframe && this.annexBCodecConfig && !this.chunkHasSpsPps(out)) {
            out = this.concatBytes(this.annexBCodecConfig, out);
        }

        return out;
    }

    private isAnnexB(data: Uint8Array): boolean {
        if (data.length < 4) return false;

        for (let i = 0; i + 3 < data.length; i++) {
            if (data[i] === 0x00 && data[i + 1] === 0x00) {
                if (data[i + 2] === 0x01) return true;
                if (data[i + 2] === 0x00 && data[i + 3] === 0x01) return true;
            }
        }

        return false;
    }

    private parseAvcDecoderConfigurationRecord(data: Uint8Array): AvcConfigInfo | null {
        if (data.length < 7) return null;
        if (data[0] !== 1) return null;

        const nalLengthSize = (data[4] & 0x03) + 1;
        let pos = 5;

        const spsCount = data[pos++] & 0x1f;
        const parts: Uint8Array[] = [];

        for (let i = 0; i < spsCount; i++) {
            if (pos + 2 > data.length) return null;
            const len = (data[pos] << 8) | data[pos + 1];
            pos += 2;
            if (pos + len > data.length) return null;
            parts.push(AVIMuxer.START_CODE, data.subarray(pos, pos + len));
            pos += len;
        }

        if (pos + 1 > data.length) return null;
        const ppsCount = data[pos++];

        for (let i = 0; i < ppsCount; i++) {
            if (pos + 2 > data.length) return null;
            const len = (data[pos] << 8) | data[pos + 1];
            pos += 2;
            if (pos + len > data.length) return null;
            parts.push(AVIMuxer.START_CODE, data.subarray(pos, pos + len));
            pos += len;
        }

        if (parts.length === 0) return null;

        return {
            nalLengthSize,
            annexBConfig: this.concatMany(parts),
        };
    }

    private guessAvccNalLengthSize(data: Uint8Array): number | undefined {
        for (const n of [4, 2, 1]) {
            if (this.looksLikeAvccSample(data, n)) return n;
        }
        return undefined;
    }

    private looksLikeAvccSample(data: Uint8Array, nalLengthSize: number): boolean {
        let pos = 0;
        let sawNal = false;

        while (pos + nalLengthSize <= data.length) {
            let len = 0;
            for (let i = 0; i < nalLengthSize; i++) {
                len = (len << 8) | data[pos + i];
            }
            pos += nalLengthSize;

            if (len <= 0 || pos + len > data.length) return false;

            const nalType = data[pos] & 0x1f;
            if (nalType === 0 || nalType > 31) return false;

            pos += len;
            sawNal = true;
        }

        return sawNal && pos === data.length;
    }

    private convertAvccSampleToAnnexB(data: Uint8Array, nalLengthSize: number): Uint8Array | null {
        let pos = 0;
        const parts: Uint8Array[] = [];

        while (pos + nalLengthSize <= data.length) {
            let len = 0;
            for (let i = 0; i < nalLengthSize; i++) {
                len = (len << 8) | data[pos + i];
            }
            pos += nalLengthSize;

            if (len <= 0 || pos + len > data.length) return null;

            parts.push(AVIMuxer.START_CODE, data.subarray(pos, pos + len));
            pos += len;
        }

        if (pos !== data.length) return null;
        return this.concatMany(parts);
    }

    private chunkHasSpsPps(data: Uint8Array): boolean {
        let foundSps = false;
        let foundPps = false;
        let pos = 0;

        while (true) {
            const cur = this.findStartCode(data, pos);
            if (!cur) break;

            const nalStart = cur.index + cur.length;
            const next = this.findStartCode(data, nalStart);
            const nalEnd = next ? next.index : data.length;

            if (nalStart < nalEnd) {
                const nalType = data[nalStart] & 0x1f;
                if (nalType === 7) foundSps = true;
                if (nalType === 8) foundPps = true;
                if (foundSps && foundPps) return true;
            }

            pos = nalEnd;
        }

        return false;
    }

    private findStartCode(data: Uint8Array, from: number): { index: number; length: number } | null {
        for (let i = from; i + 3 < data.length; i++) {
            if (data[i] === 0x00 && data[i + 1] === 0x00) {
                if (data[i + 2] === 0x01) {
                    return { index: i, length: 3 };
                }
                if (data[i + 2] === 0x00 && data[i + 3] === 0x01) {
                    return { index: i, length: 4 };
                }
            }
        }
        return null;
    }

    private concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
        const out = new Uint8Array(a.length + b.length);
        out.set(a, 0);
        out.set(b, a.length);
        return out;
    }

    private concatMany(parts: Uint8Array[]): Uint8Array {
        let total = 0;
        for (const p of parts) total += p.length;

        const out = new Uint8Array(total);
        let off = 0;
        for (const p of parts) {
            out.set(p, off);
            off += p.length;
        }
        return out;
    }

    private isFinitePositive(v: number | undefined): v is number {
        return typeof v === 'number' && Number.isFinite(v) && v > 0;
    }

    private isFiniteNonNegative(v: number | undefined): v is number {
        return typeof v === 'number' && Number.isFinite(v) && v >= 0;
    }
}
