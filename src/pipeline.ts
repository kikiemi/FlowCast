import type { Sink, Source } from './types/io';
import type { ContainerFormat, EncodedChunk } from './types/media';
import type { MuxerConfig } from './types/container';
import { DOMDemuxer } from './demux/dom-demuxer';
import { MP4Demuxer, type MP4TrackInfo, type MP4DemuxResult } from './demux/mp4-demuxer';
import { FLVDemuxer } from './demux/flv-demuxer';
import { TSDemuxer } from './demux/ts-demuxer';
import { AVIDemuxer } from './demux/avi-demuxer';
import { DemuxerRegistry } from './demux/registry';
import { MP4Muxer } from './mux/mp4-muxer';
import { AVIMuxer } from './mux/avi-muxer';
import { FLVMuxer } from './mux/flv-muxer';
import { WebMMuxer } from './mux/webm-muxer';
import { TSMuxer } from './mux/ts-muxer';
import { MemorySink } from './io/sinks';
import { BlobSource } from './io/sources';
import { FlowCastError, EncodeError, DecodeError } from './core/errors';
import { webCodecsAudioCodec, codecFamily } from './core/codec-strings';
import { logger } from './core/logger';
import {
    encodeAudioBufferWithEncoder,
    renderAudioBuffer,
    yieldToEventLoop,
} from './audio/audio-buffer-tools';

export interface PipelineConfig {
    outputFormat: ContainerFormat;
    videoCodec: string;
    audioCodec: string;
    width: number;
    height: number;
    fps: number;
    videoBitrate: number;
    audioBitrate: number;
    audioSampleRate: number;
    audioChannels: number;
    signal?: AbortSignal;
    onProgress?: (pct: number, msg: string) => void;
}

const MP4_FAMILY = new Set(['mp4', 'mov', '3gp', 'm4v']);

function copyCodecDescription(description: AllowSharedBufferSource | undefined): Uint8Array | undefined {
    if (!description) return undefined;
    if (description instanceof ArrayBuffer) return new Uint8Array(description.slice(0));
    if (ArrayBuffer.isView(description)) {
        return new Uint8Array(description.buffer.slice(description.byteOffset, description.byteOffset + description.byteLength));
    }
    return undefined;
}

interface OutputMuxer {
    addVideoChunk(chunk: EncodedChunk, codecConfig?: Uint8Array): void;
    addAudioChunk(chunk: EncodedChunk, codecConfig?: Uint8Array): void;
    finalize(): void;
}

export class Pipeline {
    private readonly cfg: PipelineConfig;

    constructor(cfg: PipelineConfig) { this.cfg = cfg; }

    async run(input: File | Blob): Promise<Blob> {
        const inputFmt = await DemuxerRegistry.detectFromFile(input);
        const outFmt = this.cfg.outputFormat;

        const demuxer = this.chooseDemuxer(inputFmt);
        if (demuxer) {
            try {
                return await this.runWebCodecsGeneric(input, outFmt, demuxer, inputFmt);
            } catch (e: unknown) {
                logger.warn(`[Pipeline] native pipeline (${inputFmt}) failed, falling back to DOM:`, e);
            }
        }
        return this.runDOM(input, outFmt);
    }

    private chooseDemuxer(fmt: ContainerFormat): { demux(input: File | Blob): Promise<MP4DemuxResult> } | null {
        if (MP4_FAMILY.has(fmt)) return new MP4Demuxer();
        if (fmt === 'flv') return new FLVDemuxer();
        if (fmt === 'ts') return new TSDemuxer();
        if (fmt === 'avi') return new AVIDemuxer();
        return null;
    }

    private async runWebCodecsGeneric(
        input: File | Blob, fmt: ContainerFormat,
        demuxer: { demux(input: File | Blob | Source): Promise<MP4DemuxResult> },
        inputFmt: ContainerFormat,
    ): Promise<Blob> {
        this.report(5, 'Demuxing...');
        const source = new BlobSource(input);
        const result = await demuxer.demux(input);

        const srcV = result.videoTracks[0] ?? null;
        const srcA = result.audioTracks[0] ?? null;
        if (!srcV && !srcA) throw new FlowCastError('No tracks found', 'DECODE');

        const vCodec = this.cfg.videoCodec;
        const aCodec = this.cfg.audioCodec;
        const directVideo = !!srcV && this.canDirectRemuxVideo(inputFmt, fmt, srcV, vCodec);
        const directAudio = !!srcA && this.canDirectRemuxAudio(inputFmt, fmt, srcA, aCodec);

        if (srcV && !directVideo) {
            if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') {
                throw new FlowCastError('Video WebCodecs are unavailable for transcoding', 'DECODE');
            }
            const WEBCODECS_VIDEO = ['avc1', 'avc3', 'hvc1', 'hev1', 'vp8', 'vp09', 'vp9', 'av01'];
            if (!WEBCODECS_VIDEO.some(c => srcV.codec.startsWith(c))) {
                throw new FlowCastError(`WebCodecs does not support video codec: ${srcV.codec}`, 'DECODE');
            }
            try {
                const support = await VideoDecoder.isConfigSupported({
                    codec: srcV.codec, codedWidth: srcV.width || 1920, codedHeight: srcV.height || 1080,
                });
                if (!support.supported) {
                    throw new FlowCastError(`VideoDecoder does not support: ${srcV.codec}`, 'DECODE');
                }
            } catch (e) {
                if (e instanceof FlowCastError) throw e;
                throw new FlowCastError(`Codec check failed: ${srcV.codec}`, 'DECODE');
            }
        }
        if (srcA && !directAudio && typeof AudioDecoder === 'undefined') {
            throw new FlowCastError('Audio WebCodecs are unavailable for transcoding', 'DECODE');
        }

        const sink = new MemorySink();
        const muxer = this.makeMuxer(fmt, sink, srcV, srcA, vCodec, aCodec);

        if (srcV) {
            if (directVideo) {
                this.report(10, 'Remuxing video...');
                await this.remuxVideoTrack(srcV, source, muxer);
            } else {
                this.report(10, 'Encoding video...');
                await this.pipeVideo(srcV, source, vCodec, fmt, muxer);
            }
        }
        if (srcA) {
            if (directAudio) {
                this.report(80, 'Remuxing audio...');
                await this.remuxAudioTrack(srcA, source, muxer);
            } else {
                this.report(80, 'Encoding audio...');
                await this.pipeAudio(srcA, source, aCodec, muxer);
            }
        }

        muxer.finalize();
        this.report(100, 'Done');
        return sink.toBlob(DemuxerRegistry.getMimeType(fmt));
    }

    private canDirectRemuxVideo(
        inputFmt: ContainerFormat,
        outputFmt: ContainerFormat,
        track: MP4TrackInfo,
        outputCodec: string,
    ): boolean {
        if (!this.containerSupportsVideoCodec(outputFmt, track.codec)) return false;
        if (!this.sameCodecFamily(track.codec, outputCodec)) return false;
        if ((this.cfg.width && track.width && this.cfg.width !== track.width) ||
            (this.cfg.height && track.height && this.cfg.height !== track.height)) {
            return false;
        }
        if (outputFmt === 'ts') return inputFmt === 'ts';
        if (inputFmt === 'ts' || inputFmt === 'avi') return false;
        return true;
    }

    private canDirectRemuxAudio(
        inputFmt: ContainerFormat,
        outputFmt: ContainerFormat,
        track: MP4TrackInfo,
        outputCodec: string,
    ): boolean {
        if (!this.containerSupportsAudioCodec(outputFmt, track.codec)) return false;
        if (!this.sameCodecFamily(track.codec, outputCodec)) return false;
        if (this.cfg.audioChannels && track.channelCount && this.cfg.audioChannels !== track.channelCount) {
            return false;
        }
        if (outputCodec === 'opus') {
            if (track.sampleRate !== 48000) return false;
        } else if (this.cfg.audioSampleRate && track.sampleRate && this.cfg.audioSampleRate !== track.sampleRate) {
            return false;
        }
        if ((track.codec === 'ac-3' || track.codec === 'ec-3') && !track.codecConfig && MP4_FAMILY.has(outputFmt)) {
            return false;
        }
        if (inputFmt === 'avi' && !track.codec.startsWith('pcm')) return false;
        if (outputFmt === 'ts') return inputFmt === 'ts';
        if (inputFmt === 'ts') return false;
        return true;
    }

    private containerSupportsVideoCodec(fmt: ContainerFormat, codec: string): boolean {
        if (MP4_FAMILY.has(fmt)) {
            return codec.startsWith('avc') || codec.startsWith('avc1') || codec.startsWith('hvc1')
                || codec.startsWith('hev1') || codec.startsWith('av01');
        }
        if (fmt === 'webm' || fmt === 'mkv') {
            return codec === 'vp8' || codec.startsWith('vp09') || codec.startsWith('vp9') || codec.startsWith('av01');
        }
        if (fmt === 'avi') {
            return codec.startsWith('avc');
        }
        if (fmt === 'flv') {
            return codec.startsWith('avc');
        }
        if (fmt === 'ts') {
            return codec.startsWith('avc') || codec.startsWith('hvc1') || codec.startsWith('hev1');
        }
        return false;
    }

    private containerSupportsAudioCodec(fmt: ContainerFormat, codec: string): boolean {
        if (MP4_FAMILY.has(fmt)) {
            return codec.startsWith('mp4a') || codec === 'ac-3' || codec === 'ec-3';
        }
        if (fmt === 'webm' || fmt === 'mkv') {
            return codec === 'opus' || codec === 'vorbis';
        }
        if (fmt === 'avi') {
            return codec === 'pcm';
        }
        if (fmt === 'flv') {
            return codec.startsWith('mp4a');
        }
        if (fmt === 'ts') {
            return codec.startsWith('mp4a') || codec === 'ac-3' || codec === 'ec-3';
        }
        return false;
    }

    private sameCodecFamily(sourceCodec: string, targetCodec: string): boolean {
        return codecFamily(sourceCodec) === codecFamily(targetCodec);
    }



    private async remuxVideoTrack(src: MP4TrackInfo, source: Source, muxer: OutputMuxer): Promise<void> {
        for (let index = 0; index < src.samples.length; index++) {
            this.checkAbort();
            const sample = src.samples[index];
            const data = sample.data ?? await source.read(sample.offset, sample.size);
            muxer.addVideoChunk({
                data,
                timestamp: sample.timestamp,
                decodeTimestamp: sample.decodeTimestamp,
                compositionTimeOffset: sample.compositionTimeOffset,
                duration: sample.duration,
                isKeyframe: sample.isKeyframe,
                trackType: 'video',
            }, src.codecConfig);
            if ((index & 31) === 0) {
                this.report(10 + Math.round((index / Math.max(src.samples.length, 1)) * 65), `Video ${index}/${src.samples.length}`);
                await this.yield();
            }
        }
    }

    private async remuxAudioTrack(src: MP4TrackInfo, source: Source, muxer: OutputMuxer): Promise<void> {
        for (let index = 0; index < src.samples.length; index++) {
            this.checkAbort();
            const sample = src.samples[index];
            const data = sample.data ?? await source.read(sample.offset, sample.size);
            muxer.addAudioChunk({
                data,
                timestamp: sample.timestamp,
                duration: sample.duration,
                isKeyframe: true,
                trackType: 'audio',
            });
            if ((index & 63) === 0) {
                this.report(80 + Math.round((index / Math.max(src.samples.length, 1)) * 15), `Audio ${index}/${src.samples.length}`);
                await this.yield();
            }
        }
    }

    private async pipeVideo(
        src: MP4TrackInfo, source: Source, outCodec: string, fmt: ContainerFormat, muxer: OutputMuxer,
    ): Promise<void> {
        let codecCfg: Uint8Array | undefined;
        let err: Error | null = null;
        let decoded = 0;
        let encoded = 0;

        const encoder = new VideoEncoder({
            output: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => {
                encoded++;
                if (meta?.decoderConfig?.description && !codecCfg) {
                    codecCfg = copyCodecDescription(meta.decoderConfig.description);
                }
                const data = new Uint8Array(chunk.byteLength);
                chunk.copyTo(data);
                muxer.addVideoChunk({
                    data, timestamp: chunk.timestamp / 1e6,
                    duration: (chunk.duration ?? 0) / 1e6,
                    isKeyframe: chunk.type === 'key', trackType: 'video',
                }, codecCfg);
            },
            error: (e: DOMException) => { err = e; logger.warn('[Pipeline] VideoEncoder error:', e); },
        });

        const encWidth = this.cfg.width || src.width || 1920;
        const encHeight = this.cfg.height || src.height || 1080;

        try {
            encoder.configure({
                codec: outCodec, width: encWidth, height: encHeight,
                bitrate: this.cfg.videoBitrate, framerate: this.cfg.fps,
                ...(outCodec.startsWith('avc') ? { avc: { format: avcFormatFor(fmt) } } : {}),
            });
        } catch (e: unknown) {
            encoder.close();
            throw new EncodeError(`VideoEncoder configure failed for '${outCodec}': ${e}`);
        }
        await this.yield();

        const decCfg: VideoDecoderConfig = {
            codec: src.codec, codedWidth: src.width, codedHeight: src.height,
        };
        if (src.codecConfig) decCfg.description = src.codecConfig;

        logger.warn(`[Pipeline] pipeVideo: codec=${src.codec}, ${src.width}x${src.height}, samples=${src.samples.length}, hasConfig=${!!src.codecConfig}`);

        const decoder = new VideoDecoder({
            output: (frame: VideoFrame) => {
                decoded++;
                try { if (encoder.state !== 'closed') encoder.encode(frame, { keyFrame: decoded % 60 === 1 }); }
                finally { frame.close(); }
            },
            error: (e: DOMException) => { err = err ?? e; logger.warn('[Pipeline] VideoDecoder error:', e); },
        });

        try {
            decoder.configure(decCfg);
        } catch (e: unknown) {
            encoder.close();
            throw new EncodeError(`VideoDecoder configure failed for '${src.codec}': ${e}`);
        }
        await this.yield();

        for (let i = 0; i < src.samples.length; i++) {
            this.checkAbort();
            if (err) break;
            while (encoder.encodeQueueSize > 5 || decoder.decodeQueueSize > 8) await this.yield();
            const s = src.samples[i];
            const sampleData = s.data ?? await source.read(s.offset, s.size);
            decoder.decode(new EncodedVideoChunk({
                type: s.isKeyframe ? 'key' : 'delta',
                timestamp: s.timestamp * 1e6, duration: s.duration * 1e6,
                data: sampleData,
            }));
            if (i % 10 === 0) this.report(10 + Math.round((i / src.samples.length) * 65), `Video ${i}/${src.samples.length}`);
        }

        if ((decoder.state as string) !== 'closed') { try { await decoder.flush(); } catch (e) { logger.warn('[Pipeline] decoder flush:', e); } decoder.close(); }
        if ((encoder.state as string) !== 'closed') { try { await encoder.flush(); } catch (e) { logger.warn('[Pipeline] encoder flush:', e); } encoder.close(); }
        logger.debug(`[Pipeline] pipeVideo done: samples=${src.samples.length}, decoded=${decoded}, encoded=${encoded}`);
        const finalErr: unknown = err;
        if (finalErr) {
            throw new EncodeError(`Video pipeline failed: ${finalErr instanceof Error ? finalErr.message : String(finalErr)}`);
        }
        if (encoded === 0 && src.samples.length > 0) {
            throw new EncodeError('Video pipeline produced no output');
        }
    }

    private async pipeAudio(
        src: MP4TrackInfo, source: Source, outCodec: string, muxer: OutputMuxer,
    ): Promise<void> {
        const targetRate = outCodec === 'opus' ? 48000 : (this.cfg.audioSampleRate || src.sampleRate || 48000);
        const targetCh = this.cfg.audioChannels || src.channelCount || 2;
        const directStream = outCodec !== 'pcm'
            && (src.sampleRate || targetRate) === targetRate
            && (src.channelCount || targetCh) === targetCh;
        const rawFrames: { data: Float32Array; sampleRate: number; channels: number }[] = [];
        let decErr: Error | null = null;
        let encErr: Error | null = null;
        let directEncoder: AudioEncoder | null = null;

        if (directStream) {
            let codecConfig: Uint8Array | undefined;
            const encoder = new AudioEncoder({
                output: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => {
                    const d = new Uint8Array(chunk.byteLength);
                    chunk.copyTo(d);
                    const nextCodecConfig = copyCodecDescription(meta?.decoderConfig?.description);
                    if (nextCodecConfig && !codecConfig) codecConfig = nextCodecConfig;
                    muxer.addAudioChunk({
                        data: d,
                        timestamp: chunk.timestamp / 1e6,
                        duration: (chunk.duration ?? 0) / 1e6,
                        isKeyframe: true,
                        trackType: 'audio',
                    }, codecConfig);
                },
                error: (e: DOMException) => { encErr = e; },
            });

            try {
                encoder.configure({
                    codec: outCodec,
                    sampleRate: targetRate,
                    numberOfChannels: targetCh,
                    bitrate: this.cfg.audioBitrate,
                });
                directEncoder = encoder;
            } catch (e) {
                logger.warn('[Pipeline] direct audio encode unavailable, falling back to buffered path:', e);
                try { encoder.close(); } catch { /* ignore */ }
            }
        }

        const decoder = new AudioDecoder({
            output: (ad: AudioData) => {
                try {
                    if (directEncoder) {
                        if (!encErr && directEncoder.state !== 'closed') {
                            try { directEncoder.encode(ad); }
                            catch (e) { encErr = e instanceof Error ? e : new Error(String(e)); }
                        }
                        return;
                    }
                    const ch = ad.numberOfChannels, frames = ad.numberOfFrames;
                    const pcm = new Float32Array(frames * ch);
                    try {
                        for (let c = 0; c < ch; c++) {
                            const plane = new Float32Array(frames);
                            ad.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
                            for (let i = 0; i < frames; i++) pcm[i * ch + c] = plane[i];
                        }
                    } catch {
                        try {
                            ad.copyTo(pcm, { planeIndex: 0, format: 'f32' });
                        } catch (copyErr) {
                            // Never emit a silent frame: surface the copy failure.
                            decErr = copyErr instanceof Error ? copyErr : new Error(String(copyErr));
                            return;
                        }
                    }
                    rawFrames.push({ data: pcm, sampleRate: ad.sampleRate, channels: ch });
                } finally { ad.close(); }
            },
            error: (e: DOMException) => { decErr = e; },
        });

        const decCfg: AudioDecoderConfig = {
            codec: webCodecsAudioCodec(src.codec), sampleRate: src.sampleRate, numberOfChannels: src.channelCount,
        };
        if (src.codecConfig) decCfg.description = src.codecConfig;
        try { decoder.configure(decCfg); } catch (e) {
            throw new DecodeError(`AudioDecoder configure failed for '${src.codec}': ${e instanceof Error ? e.message : String(e)}`);
        }
        await this.yield();
        if (decoder.state === 'closed') {
            throw new DecodeError(`AudioDecoder closed immediately for '${src.codec}'`);
        }

        for (const s of src.samples) {
            if (decErr || encErr) break;
            while (decoder.decodeQueueSize > 8 || (directEncoder !== null && directEncoder.encodeQueueSize > 8)) await this.yield();
            const sampleData = s.data ?? await source.read(s.offset, s.size);
            decoder.decode(new EncodedAudioChunk({
                type: 'key', timestamp: s.timestamp * 1e6, duration: s.duration * 1e6,
                data: sampleData,
            }));
        }

        if ((decoder.state as string) !== 'closed') { try { await decoder.flush(); } catch (e) { logger.warn('[Pipeline] audio decoder flush:', e); } decoder.close(); }
        if (directEncoder) {
            if (directEncoder.state !== 'closed') {
                try { await directEncoder.flush(); } catch (e) { logger.warn('[Pipeline] audio encoder flush:', e); }
                try { directEncoder.close(); } catch { /* already closed */ }
            }
            if (!decErr && !encErr) return;
        }
        const audioDecErr: unknown = decErr;
        if (audioDecErr) {
            throw new DecodeError(`Audio decoding failed: ${audioDecErr instanceof Error ? audioDecErr.message : String(audioDecErr)}`);
        }
        const audioEncErr: unknown = encErr;
        if (audioEncErr && rawFrames.length === 0) {
            throw new EncodeError(`Audio encoding failed: ${audioEncErr instanceof Error ? audioEncErr.message : String(audioEncErr)}`);
        }
        if (rawFrames.length === 0) {
            throw new DecodeError('Audio pipeline produced no decoded frames');
        }

        const totalFrames = rawFrames.reduce((acc, frame) => acc + frame.data.length / frame.channels, 0);
        const srcRate = rawFrames[0].sampleRate || src.sampleRate || 44100;
        const srcCh = Math.max(1, rawFrames[0].channels || targetCh);
        const audioBuf = new AudioBuffer({ numberOfChannels: srcCh, length: Math.max(totalFrames, 1), sampleRate: srcRate });

        let writePos = 0;
        for (const f of rawFrames) {
            const numFrames = f.data.length / f.channels;
            for (let c = 0; c < srcCh; c++) {
                const chanData = audioBuf.getChannelData(c);
                for (let i = 0; i < numFrames; i++) chanData[writePos + i] = f.data[i * f.channels + (c < f.channels ? c : 0)];
            }
            writePos += numFrames;
        }
        rawFrames.length = 0;

        const outCh = Math.max(1, Math.min(srcCh, targetCh));
        const resampled = (audioBuf.sampleRate === targetRate && audioBuf.numberOfChannels === outCh)
            ? audioBuf
            : await renderAudioBuffer(audioBuf, targetRate, outCh);

        if (outCodec === 'pcm' && muxer instanceof AVIMuxer) {
            muxer.addPCMBuffer(resampled);
            return;
        }

        await this.encodeAudioBuffer(resampled, outCodec, muxer);
    }

    private async runDOM(input: File | Blob, fmt: ContainerFormat): Promise<Blob> {
        const demuxer = new DOMDemuxer({
            fps: this.cfg.fps, signal: this.cfg.signal, onProgress: this.cfg.onProgress,
        });

        try {
            const info = await demuxer.open(input);
            if (!info.hasVideo && !info.hasAudio) throw new FlowCastError('No media tracks', 'DECODE');

            const sink = new MemorySink();
            const vCodec = this.cfg.videoCodec;
            const aCodec = this.cfg.audioCodec;

            const w = info.videoWidth || this.cfg.width;
            const h = info.videoHeight || this.cfg.height;
            const muxer = this.makeMuxer(fmt, sink, null, null, vCodec, aCodec,
                info.hasVideo, info.hasAudio, w, h, info.audioSampleRate, info.audioChannels);

            if (info.hasVideo) {
                this.report(10, 'Encoding video...');
                let codecCfg: Uint8Array | undefined;
                let encErr: Error | null = null;

                const encoder = new VideoEncoder({
                    output: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => {
                        if (meta?.decoderConfig?.description && !codecCfg) {
                            codecCfg = copyCodecDescription(meta.decoderConfig.description);
                        }
                        const data = new Uint8Array(chunk.byteLength);
                        chunk.copyTo(data);
                        muxer.addVideoChunk({
                            data, timestamp: chunk.timestamp / 1e6,
                            duration: (chunk.duration ?? 0) / 1e6,
                            isKeyframe: chunk.type === 'key', trackType: 'video',
                        }, codecCfg);
                    },
                    error: (e: DOMException) => { encErr = e; },
                });

                encoder.configure({
                    codec: vCodec, width: w, height: h,
                    bitrate: this.cfg.videoBitrate, framerate: this.cfg.fps,
                    ...(vCodec.startsWith('avc') ? { avc: { format: avcFormatFor(fmt) } } : {}),
                });
                await this.yield();
                if (encoder.state === 'closed') throw new EncodeError(`VideoEncoder failed for '${vCodec}'`);

                let fi = 0;
                for await (const frame of demuxer.videoFrames()) {
                    this.checkAbort();
                    if (encErr) { frame.close(); break; }
                    while (encoder.encodeQueueSize > 5) await this.yield();
                    try { encoder.encode(frame, { keyFrame: fi % 60 === 0 }); }
                    catch (e) {
                        encErr = e instanceof Error ? e : new Error(String(e));
                        frame.close();
                        break;
                    }
                    frame.close();
                    fi++;
                }

                if ((encoder.state as string) !== 'closed') { try { await encoder.flush(); } catch (e) { logger.warn('[Pipeline] encoder flush:', e); } encoder.close(); }
                const domVideoErr: unknown = encErr;
                if (domVideoErr) {
                    throw new EncodeError(`Video encoding failed: ${domVideoErr instanceof Error ? domVideoErr.message : String(domVideoErr)}`);
                }
            }

            if (info.hasAudio) {
                this.report(85, 'Encoding audio...');
                const audioBuf = await demuxer.decodeAudio(input);
                if (!audioBuf) {
                    throw new DecodeError('Audio track present but produced no PCM');
                }
                if (aCodec === 'pcm' && muxer instanceof AVIMuxer) {
                    const targetRate = this.cfg.audioSampleRate || audioBuf.sampleRate;
                    const targetCh = Math.max(1, Math.min(audioBuf.numberOfChannels, this.cfg.audioChannels || audioBuf.numberOfChannels));
                    const rendered = (audioBuf.sampleRate === targetRate && audioBuf.numberOfChannels === targetCh)
                        ? audioBuf
                        : await renderAudioBuffer(audioBuf, targetRate, targetCh);
                    muxer.addPCMBuffer(rendered);
                } else {
                    await this.encodeAudioBuffer(audioBuf, aCodec, muxer);
                }
            }

            muxer.finalize();
            this.report(100, 'Done');

            const blob = sink.toBlob(DemuxerRegistry.getMimeType(fmt));
            if (blob.size < 100) throw new FlowCastError('Output too small', 'OUTPUT');
            return blob;
        } finally {
            demuxer.close();
        }
    }

    private async encodeAudioBuffer(
        audioBuf: AudioBuffer, codec: string, muxer: OutputMuxer,
    ): Promise<void> {
        if (codec === 'ac-3' || codec === 'ec-3') {
            throw new EncodeError(`${codec} encoding is only available through direct remux in this build`);
        }

        const targetRate = this.cfg.audioSampleRate || audioBuf.sampleRate;
        const targetCh = Math.max(1, Math.min(audioBuf.numberOfChannels, this.cfg.audioChannels || audioBuf.numberOfChannels));
        let resampled = audioBuf;

        if (audioBuf.numberOfChannels !== targetCh || audioBuf.sampleRate !== targetRate) {
            resampled = await renderAudioBuffer(audioBuf, targetRate, targetCh);
        }

        let encErr: Error | null = null;
        let codecConfig: Uint8Array | undefined;
        const encoder = new AudioEncoder({
            output: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => {
                const d = new Uint8Array(chunk.byteLength);
                chunk.copyTo(d);
                const nextCodecConfig = copyCodecDescription(meta?.decoderConfig?.description);
                if (nextCodecConfig && !codecConfig) codecConfig = nextCodecConfig;
                muxer.addAudioChunk({
                    data: d, timestamp: chunk.timestamp / 1e6,
                    duration: (chunk.duration ?? 0) / 1e6, isKeyframe: true, trackType: 'audio',
                }, codecConfig);
            },
            error: (e: DOMException) => { encErr = e; },
        });

        encoder.configure({
            codec, sampleRate: resampled.sampleRate,
            numberOfChannels: resampled.numberOfChannels, bitrate: this.cfg.audioBitrate,
        });

        await encodeAudioBufferWithEncoder(resampled, 1024, async (audioData) => {
            if (encErr || encoder.state === 'closed') return;
            while (encoder.encodeQueueSize > 8) await yieldToEventLoop();
            encoder.encode(audioData);
        });

        if (encoder.state !== 'closed') { try { await encoder.flush(); } catch (e) { logger.warn('[Pipeline] audio encoder flush:', e); } encoder.close(); }
        const bufferEncErr: unknown = encErr;
        if (bufferEncErr) {
            throw new EncodeError(`Audio encoding failed: ${bufferEncErr instanceof Error ? bufferEncErr.message : String(bufferEncErr)}`);
        }
    }

    private makeMuxer(
        fmt: ContainerFormat, sink: Sink,
        srcV: MP4TrackInfo | null, srcA: MP4TrackInfo | null,
        vCodec: string, aCodec: string,
        forceV = false, forceA = false,
        overW = 0, overH = 0, overSR = 48000, overCh = 2,
    ): OutputMuxer {
        const hasV = !!srcV || forceV;
        const hasA = !!srcA || forceA;
        const preserveDisplayMetadata = !overW && !overH && !this.cfg.width && !this.cfg.height;
        const cfg: MuxerConfig = {
            format: fmt,
            mode: (MP4_FAMILY.has(fmt) || ['avi'].includes(fmt)) ? 'standard' : 'fragmented',
            maxFragmentDuration: 2.0,
            autoSync: true,
            video: hasV ? {
                id: 1, type: 'video', codec: vCodec,
                width: overW || this.cfg.width || srcV?.width || 0,
                height: overH || this.cfg.height || srcV?.height || 0,
                displayWidth: preserveDisplayMetadata ? srcV?.displayWidth : undefined,
                displayHeight: preserveDisplayMetadata ? srcV?.displayHeight : undefined,
                pixelAspectRatioNum: preserveDisplayMetadata ? srcV?.pixelAspectRatioNum : undefined,
                pixelAspectRatioDen: preserveDisplayMetadata ? srcV?.pixelAspectRatioDen : undefined,
                framerate: this.cfg.fps,
                codecConfig: srcV?.codecConfig,
            } : undefined,
            audio: hasA ? {
                id: hasV ? 2 : 1, type: 'audio', codec: aCodec,
                sampleRate: srcA
                    ? (aCodec === 'opus' ? 48000 : (srcA.sampleRate || 48000))
                    : (overSR || 48000),
                channelCount: srcA
                    ? (srcA.channelCount || 2)
                    : (overCh || 2),
                codecConfig: srcA?.codecConfig,
            } : undefined,
        };

        switch (fmt) {
            case 'mp4': case 'mov': case '3gp': case 'm4v': return new MP4Muxer(cfg, sink);
            case 'webm': case 'mkv': return new WebMMuxer(cfg, sink);
            case 'avi': return new AVIMuxer(cfg, sink);
            case 'flv': return new FLVMuxer(cfg, sink);
            case 'ts': return new TSMuxer(cfg, sink);
            default: throw new FlowCastError(`Unsupported format: ${fmt}`, 'FORMAT');
        }
    }

    private report(pct: number, msg: string): void { this.cfg.onProgress?.(pct, msg); }
    private checkAbort(): void { if (this.cfg.signal?.aborted) throw new FlowCastError('Aborted', 'ABORT'); }
    private yield(): Promise<void> { return yieldToEventLoop(); }
}

/** AVC bitstream layout by container: MP4 family and FLV use length-prefixed 'avc'; TS/AVI use Annex B. */
function avcFormatFor(fmt: ContainerFormat): AvcBitstreamFormat {
    return (fmt === 'mp4' || fmt === 'mov' || fmt === '3gp' || fmt === 'm4v' || fmt === 'flv') ? 'avc' : 'annexb';
}
