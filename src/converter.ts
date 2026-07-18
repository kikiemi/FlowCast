import type { ContainerFormat } from './types/media';
import { DemuxerRegistry } from './demux/registry';
import { Pipeline } from './pipeline';
import { WAVMuxer } from './mux/raw-muxer';
import { OGGMuxer } from './mux/ogg-muxer';
import { MP4Muxer } from './mux/mp4-muxer';
import { MemorySink } from './io/sinks';
import { FlowCastError } from './core/errors';
import { codecFamily, webCodecsAudioCodec } from './core/codec-strings';
import { logger } from './core/logger';
import { MP4Demuxer, type MP4TrackInfo, type MP4DemuxResult } from './demux/mp4-demuxer';
import { FLVDemuxer } from './demux/flv-demuxer';
import { TSDemuxer } from './demux/ts-demuxer';
import { AVIDemuxer } from './demux/avi-demuxer';
import { BlobSource } from './io/sources';
import { ADTSMuxer } from './mux/adts-muxer';
import {
    encodeAudioBufferWithEncoder,
    interleaveAudioBuffer,
    renderAudioBuffer,
    yieldToEventLoop,
} from './audio/audio-buffer-tools';
import { MpegAudioDecoder } from './audio/mpeg-audio-decoder';
import { MpegAudioEncoder } from './audio/mpeg-audio-encoder';
import { AudioWorkerClient } from './audio/audio-worker-client';
import { encodeFlac } from './audio/flac-encoder';
import { encodeAacLc, wrapAdts } from './audio/aac-encoder';
import { AAC_SAMPLE_RATES } from './audio/aac-tables';
import type { MpegAudioEncodeProgress, MpegAudioEncodeRequest } from './audio/mpeg-audio-types';
import {
    encodePNG, encodeJPEG, encodeWebP, encodeBMP, encodeTIFF, encodeICO,
    AnimatedGifEncoder, APNGEncoder,
} from './image/encoders';

export interface FlowCastConfig {
    outputFormat: ContainerFormat;
    videoCodec?: string;
    audioCodec?: string;
    width?: number;
    height?: number;
    fps?: number;
    videoBitrate?: number;
    audioBitrate?: number;
    audioSampleRate?: number;
    audioChannels?: number;
    signal?: AbortSignal;
    onProgress?: (progress: number, message: string) => void;
}

const IMAGE_FORMATS = new Set<ContainerFormat>(['png', 'jpeg', 'webp', 'bmp', 'tiff', 'ico', 'gif', 'apng']);
const AUDIO_ONLY = new Set<ContainerFormat>(['wav', 'ogg', 'aac', 'flac', 'mp3', 'm4a', 'mp2']);
const AUDIO_INPUT = new Set<ContainerFormat>(['wav', 'ogg', 'aac', 'flac', 'mp3', 'mp2']);
const VIDEO_CONTAINERS = new Set<ContainerFormat>(['mp4', 'mov', 'webm', 'mkv', 'avi', 'flv', '3gp', 'ts', 'm4v']);

type NativeDemuxer = {
    demux(input: File | Blob): Promise<MP4DemuxResult>;
};

type ContainerCodecPlan = {
    readonly defaultVideo?: string;
    readonly defaultAudio?: string;
    readonly video?: readonly string[];
    readonly audio?: readonly string[];
};

const CONTAINER_CODEC_PLANS: Partial<Record<ContainerFormat, ContainerCodecPlan>> = {
    mp4: {
        defaultVideo: 'avc1.640028',
        defaultAudio: 'mp4a.40.2',
        video: ['avc1.640028', 'hvc1.1.6.L93.B0', 'hev1.1.6.L93.B0', 'av01.0.01M.08'],
        audio: ['mp4a.40.2', 'ac-3', 'ec-3'],
    },
    mov: {
        defaultVideo: 'avc1.640028',
        defaultAudio: 'mp4a.40.2',
        video: ['avc1.640028', 'hvc1.1.6.L93.B0', 'hev1.1.6.L93.B0', 'av01.0.01M.08'],
        audio: ['mp4a.40.2', 'ac-3', 'ec-3'],
    },
    '3gp': {
        defaultVideo: 'avc1.640028',
        defaultAudio: 'mp4a.40.2',
        video: ['avc1.640028'],
        audio: ['mp4a.40.2'],
    },
    m4v: {
        defaultVideo: 'avc1.640028',
        defaultAudio: 'mp4a.40.2',
        video: ['avc1.640028', 'hvc1.1.6.L93.B0', 'hev1.1.6.L93.B0', 'av01.0.01M.08'],
        audio: ['mp4a.40.2', 'ac-3', 'ec-3'],
    },
    m4a: {
        defaultAudio: 'mp4a.40.2',
        audio: ['mp4a.40.2', 'ac-3', 'ec-3'],
    },
    webm: {
        defaultVideo: 'vp8',
        defaultAudio: 'opus',
        video: ['vp8', 'vp09.00.10.08', 'av01.0.01M.08'],
        audio: ['opus'],
    },
    mkv: {
        defaultVideo: 'vp8',
        defaultAudio: 'opus',
        video: ['vp8', 'vp09.00.10.08', 'av01.0.01M.08'],
        audio: ['opus'],
    },
    avi: {
        defaultVideo: 'avc1.640028',
        defaultAudio: 'pcm',
        video: ['avc1.640028'],
        audio: ['pcm'],
    },
    flv: {
        defaultVideo: 'avc1.640028',
        defaultAudio: 'mp4a.40.2',
        video: ['avc1.640028'],
        audio: ['mp4a.40.2'],
    },
    ts: {
        defaultVideo: 'avc1.640028',
        defaultAudio: 'mp4a.40.2',
        video: ['avc1.640028', 'hvc1.1.6.L93.B0', 'hev1.1.6.L93.B0'],
        audio: ['mp4a.40.2', 'ac-3', 'ec-3'],
    },
};



function resolveSupportedCodec(
    requestedCodec: string | undefined,
    supportedCodecs: readonly string[] | undefined,
    fallbackCodec: string | undefined,
    label: string,
): string | undefined {
    if (!supportedCodecs || supportedCodecs.length === 0) return fallbackCodec;
    if (!requestedCodec) return fallbackCodec;

    const requestedFamily = codecFamily(requestedCodec);
    const matchedCodec = supportedCodecs.find((candidate) => codecFamily(candidate) === requestedFamily);
    if (matchedCodec) return matchedCodec;

    logger.warn(`[Converter] ${label} does not support '${requestedCodec}', using '${fallbackCodec ?? supportedCodecs[0]}'`);
    return fallbackCodec ?? supportedCodecs[0];
}

export class FlowCastConverter {
    private config: FlowCastConfig;
    private readonly mpegAudioDecoder: MpegAudioDecoder;
    private readonly mpegAudioEncoder: MpegAudioEncoder;

    constructor(config: Partial<FlowCastConfig> = {}) {
        const { outputFormat = 'mp4', ...rest } = config;
        this.config = { ...rest, outputFormat };
        this.mpegAudioDecoder = new MpegAudioDecoder(this.config);
        this.mpegAudioEncoder = new MpegAudioEncoder(this.config);
    }

    async detectFormat(file: File | Blob): Promise<ContainerFormat> {
        return DemuxerRegistry.detectFromFile(file);
    }

    /** True when any option requests an actual transform (blocks passthrough). */
    private hasTransformOptions(): boolean {
        const c = this.config;
        return Boolean(c.width || c.height || c.fps || c.videoBitrate || c.audioBitrate
            || c.audioSampleRate || c.audioChannels || c.videoCodec || c.audioCodec);
    }

    async convert(file: File | Blob): Promise<Blob> {
        const inputFmt = await this.detectFormat(file);
        const outputFmt = this.config.outputFormat;
        logger.info(`[Converter] convert: ${inputFmt} → ${outputFmt}`);

        if (inputFmt === outputFmt && !this.hasTransformOptions()) {
            logger.info('[Converter] passthrough: same format, no conversion options');
            return file.slice(0, file.size, DemuxerRegistry.getMimeType(outputFmt));
        }

        // Image input → image output only
        if (IMAGE_FORMATS.has(inputFmt)) {
            if (IMAGE_FORMATS.has(outputFmt)) {
                return this.convertImage(file, outputFmt);
            }
            throw new FlowCastError(
                `Cannot convert image (${inputFmt}) to non-image format (${outputFmt})`, 'FORMAT',
            );
        }

        // Audio-only input (wav/mp3/ogg/flac/aac/mp2) → audio output
        if (AUDIO_INPUT.has(inputFmt)) {
            if (AUDIO_ONLY.has(outputFmt)) {
                return this.extractAudio(file, outputFmt, undefined, inputFmt);
            }
            throw new FlowCastError(
                `Cannot convert audio-only input (${inputFmt}) to video format (${outputFmt})`, 'FORMAT',
            );
        }

        // Video containers — route through Pipeline for all output types
        // The Pipeline handles video→video, video→audio, etc. using native demuxers
        if (VIDEO_CONTAINERS.has(inputFmt)) {
            // For audio-only output from browser-playable formats, use extractAudio directly
            const browserPlayable = new Set(['mp4', 'mov', 'webm', '3gp', 'm4v']);
            if (AUDIO_ONLY.has(outputFmt) && browserPlayable.has(inputFmt)) {
                try {
                    return await this.extractAudio(file, outputFmt, undefined, inputFmt);
                } catch (e) {
                    logger.warn('[Converter] extractAudio failed, trying Pipeline:', e);
                }
            }

            // For image output, try videoToImage
            if (IMAGE_FORMATS.has(outputFmt)) {
                try {
                    return await this.videoToImage(file, outputFmt);
                } catch (e) {
                    logger.warn('[Converter] videoToImage failed:', e);
                    try { return await this.convertImage(file, outputFmt); }
                    catch { throw e; }
                }
            }

            // Everything else (video output, audio from non-browser formats) → Pipeline
            return this.convertVideo(file);
        }

        throw new FlowCastError(`Unsupported input format: ${inputFmt}`, 'FORMAT');
    }

    async convertImage(file: File | Blob, format?: ContainerFormat): Promise<Blob> {
        const fmt = format ?? this.config.outputFormat;
        logger.info(`[Converter] Image → ${fmt}`);

        const bmp = await createImageBitmap(file);
        const canvas = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new FlowCastError('No 2D context', 'ENCODE');
        ctx.drawImage(bmp, 0, 0);
        bmp.close();

        switch (fmt) {
            case 'png': return encodePNG(canvas);
            case 'jpeg': return encodeJPEG(canvas);
            case 'webp': return encodeWebP(canvas);
            case 'bmp': return encodeBMP(canvas);
            case 'tiff': return encodeTIFF(canvas);
            case 'ico': return encodeICO(canvas);
            case 'gif': {
                const enc = new AnimatedGifEncoder(canvas.width, canvas.height);
                const frameBmp = await createImageBitmap(await canvas.convertToBlob({ type: 'image/png' }));
                await enc.addFrame(frameBmp, 0);
                frameBmp.close();
                return enc.encode();
            }
            case 'apng': {
                const enc = new APNGEncoder(canvas.width, canvas.height);
                const frameBmp = await createImageBitmap(await canvas.convertToBlob({ type: 'image/png' }));
                await enc.addFrame(frameBmp, 0);
                frameBmp.close();
                return enc.encode();
            }
            default:
                return canvas.convertToBlob({ type: 'image/png' });
        }
    }

    private chooseNativeDemuxer(format: ContainerFormat): NativeDemuxer | null {
        if (format === 'mp4' || format === 'mov' || format === '3gp' || format === 'm4v') return new MP4Demuxer();
        if (format === 'flv') return new FLVDemuxer();
        if (format === 'ts') return new TSDemuxer();
        if (format === 'avi') return new AVIDemuxer();
        return null;
    }

    private async inspectPrimaryTracks(file: File | Blob): Promise<{ video: MP4TrackInfo | null; audio: MP4TrackInfo | null; } | null> {
        const inputFormat = await this.detectFormat(file);
        const demuxer = this.chooseNativeDemuxer(inputFormat);
        if (!demuxer) return null;

        try {
            const result = await demuxer.demux(file);
            return {
                video: result.videoTracks[0] ?? null,
                audio: result.audioTracks[0] ?? null,
            };
        } catch (error) {
            logger.warn('[Converter] track inspection failed:', error);
            return null;
        }
    }

    private async resolvePipelineCodecs(file: File | Blob, format: ContainerFormat): Promise<{ videoCodec: string; audioCodec: string; }> {
        const plan = CONTAINER_CODEC_PLANS[format];
        if (!plan?.defaultVideo || !plan.defaultAudio) {
            throw new FlowCastError(`No codec profile for format: ${format}`, 'FORMAT');
        }

        const inspectedTracks = (!this.config.videoCodec || !this.config.audioCodec)
            ? await this.inspectPrimaryTracks(file)
            : null;
        const inspectedVideo = inspectedTracks?.video;
        const inspectedAudio = inspectedTracks?.audio;

        const preferredVideoCodec = this.config.videoCodec
            ?? (inspectedVideo && plan.video?.some((candidate) => codecFamily(candidate) === codecFamily(inspectedVideo.codec))
                ? inspectedVideo.codec
                : plan.defaultVideo);
        const preferredAudioCodec = this.config.audioCodec
            ?? (inspectedAudio && plan.audio?.some((candidate) => codecFamily(candidate) === codecFamily(inspectedAudio.codec))
                ? inspectedAudio.codec
                : plan.defaultAudio);

        return {
            videoCodec: resolveSupportedCodec(preferredVideoCodec, plan.video, plan.defaultVideo, `${format} video`) ?? plan.defaultVideo,
            audioCodec: resolveSupportedCodec(preferredAudioCodec, plan.audio, plan.defaultAudio, `${format} audio`) ?? plan.defaultAudio,
        };
    }

    private async tryDirectAudioRemux(
        file: File | Blob,
        inputFormat: ContainerFormat | undefined,
        outputFormat: Extract<ContainerFormat, 'm4a'>,
    ): Promise<Blob | null> {
        if (!inputFormat) return null;
        const demuxer = this.chooseNativeDemuxer(inputFormat);
        if (!demuxer) return null;

        const plan = CONTAINER_CODEC_PLANS[outputFormat];
        if (!plan?.defaultAudio || !plan.audio) return null;

        try {
            const result = await demuxer.demux(file);
            const audioTrack = result.audioTracks[0];
            if (!audioTrack) return null;

            const preferredCodec = this.config.audioCodec
                ?? (plan.audio.some((candidate) => codecFamily(candidate) === codecFamily(audioTrack.codec))
                    ? audioTrack.codec
                    : plan.defaultAudio);
            const outputCodec = resolveSupportedCodec(preferredCodec, plan.audio, plan.defaultAudio, `${outputFormat} audio`);
            if (!outputCodec || codecFamily(outputCodec) !== codecFamily(audioTrack.codec)) return null;

            if (this.config.audioChannels && audioTrack.channelCount && this.config.audioChannels !== audioTrack.channelCount) return null;
            if (this.config.audioSampleRate && audioTrack.sampleRate && this.config.audioSampleRate !== audioTrack.sampleRate) return null;
            if ((audioTrack.codec === 'ac-3' || audioTrack.codec === 'ec-3') && !audioTrack.codecConfig) return null;

            const source = new BlobSource(file);
            const sink = new MemorySink();
            const muxer = new MP4Muxer({
                format: outputFormat,
                mode: 'standard',
                maxFragmentDuration: 2.0,
                autoSync: true,
                audio: {
                    id: 1,
                    type: 'audio',
                    codec: outputCodec,
                    sampleRate: audioTrack.sampleRate || (this.config.audioSampleRate ?? 48000),
                    channelCount: audioTrack.channelCount || (this.config.audioChannels ?? 2),
                    codecConfig: audioTrack.codecConfig,
                },
            }, sink);

            for (let index = 0; index < audioTrack.samples.length; index++) {
                const sample = audioTrack.samples[index];
                const data = sample.data ?? await source.read(sample.offset, sample.size);
                muxer.addAudioChunk({
                    data,
                    timestamp: sample.timestamp,
                    duration: sample.duration,
                    isKeyframe: true,
                    trackType: 'audio',
                });
                if ((index & 63) === 0) {
                    this.config.onProgress?.(20 + Math.round((index / Math.max(audioTrack.samples.length, 1)) * 60), `Remux audio ${index}/${audioTrack.samples.length}`);
                    await yieldToEventLoop();
                }
            }

            muxer.finalize();
            this.config.onProgress?.(100, 'Done');
            return sink.toBlob('audio/mp4');
        } catch (error) {
            logger.warn('[Converter] direct audio remux failed:', error);
            return null;
        }
    }

    async convertVideo(file: File | Blob): Promise<Blob> {
        const fmt = this.config.outputFormat;
        logger.debug('convertVideo fmt=', fmt, 'size=', file.size);

        if (IMAGE_FORMATS.has(fmt)) {
            try { return await this.videoToImage(file, fmt); }
            catch (origErr) {
                logger.warn('[Converter] videoToImage failed:', origErr);
                try { return await this.convertImage(file, fmt); }
                catch { throw origErr; }
            }
        }

        // For audio-only output, try demux+decode for non-browser formats, fall back to extractAudio
        if (AUDIO_ONLY.has(fmt)) {
            try {
                return await this.demuxAndExtractAudio(file, fmt);
            } catch (e) {
                logger.warn('[Converter] demuxAndExtractAudio failed, trying extractAudio:', e);
            }
            return this.extractAudio(file, fmt);
        }

        if (VIDEO_CONTAINERS.has(fmt)) {
            const resolvedCodecs = await this.resolvePipelineCodecs(file, fmt);
            const { videoCodec: vCodec, audioCodec: aCodec } = resolvedCodecs;
            if (this.config.videoCodec && codecFamily(this.config.videoCodec) !== codecFamily(vCodec)) {
                logger.warn(`[Converter] ${fmt} only supports ${vCodec} video — ignoring '${this.config.videoCodec}'`);
            }
            if (this.config.audioCodec && codecFamily(this.config.audioCodec) !== codecFamily(aCodec)) {
                logger.warn(`[Converter] ${fmt} only supports ${aCodec} audio — ignoring '${this.config.audioCodec}'`);
            }
            logger.debug('creating Pipeline:', fmt, vCodec, aCodec);

            const pipeline = new Pipeline({
                outputFormat: fmt,
                videoCodec: vCodec,
                audioCodec: aCodec,
                width: this.config.width ?? 0,
                height: this.config.height ?? 0,
                fps: this.config.fps ?? 30,
                videoBitrate: this.config.videoBitrate ?? 2_000_000,
                audioBitrate: this.config.audioBitrate ?? 128_000,
                audioSampleRate: this.config.audioSampleRate ?? 0,
                audioChannels: this.config.audioChannels ?? 0,
                signal: this.config.signal,
                onProgress: this.config.onProgress,
            });

            return pipeline.run(file);
        }

        throw new FlowCastError(`Unsupported output format: ${fmt}`, 'FORMAT');
    }

    private async videoToImage(file: File | Blob, fmt: ContainerFormat): Promise<Blob> {
        const video = document.createElement('video');
        video.muted = true;
        video.preload = 'auto';
        video.playsInline = true;
        const url = URL.createObjectURL(file);
        video.src = url;

        try {
            await Promise.race([
                new Promise<void>((resolve, reject) => {
                    const ok = () => { rm(); resolve(); };
                    const ng = () => { rm(); reject(new FlowCastError('Cannot load video', 'DECODE')); };
                    const rm = () => { video.removeEventListener('loadeddata', ok); video.removeEventListener('error', ng); };
                    video.addEventListener('loadeddata', ok);
                    video.addEventListener('error', ng);
                }),
                new Promise<never>((_, reject) => setTimeout(() => reject(new FlowCastError('Video load timeout (10s)', 'DECODE')), 10000)),
            ]);

            const isAnimated = fmt === 'gif' || fmt === 'apng';

            if (isAnimated && video.duration > 0 && isFinite(video.duration)) {
                return await this.videoToAnimatedImage(video, fmt);
            }

            video.currentTime = 0.1;
            await this.seekVideo(video);
            this.config.onProgress?.(50, 'Encoding image...');

            const bmp = await createImageBitmap(video);
            const canvas = new OffscreenCanvas(bmp.width, bmp.height);
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(bmp, 0, 0);
            bmp.close();

            switch (fmt) {
                case 'png': return encodePNG(canvas);
                case 'jpeg': return encodeJPEG(canvas);
                case 'webp': return encodeWebP(canvas);
                case 'bmp': return encodeBMP(canvas);
                case 'tiff': return encodeTIFF(canvas);
                case 'ico': return encodeICO(canvas);
                default: return canvas.convertToBlob({ type: 'image/png' });
            }
        } finally {
            video.pause();
            video.removeAttribute('src');
            video.load();
            URL.revokeObjectURL(url);
        }
    }

    private async videoToAnimatedImage(video: HTMLVideoElement, fmt: ContainerFormat): Promise<Blob> {
        const fps = Math.min(this.config.fps ?? 10, 15);
        const duration = Math.min(video.duration, 30);
        const interval = 1 / fps;
        const delayMs = Math.round(1000 / fps);
        const totalFrames = Math.ceil(duration * fps);
        const w = video.videoWidth || this.config.width || 640;
        const h = video.videoHeight || this.config.height || 480;

        const isGif = fmt === 'gif';
        const gifEnc = isGif ? new AnimatedGifEncoder(w, h) : null;
        const apngEnc = isGif ? null : new APNGEncoder(w, h);

        for (let i = 0; i < totalFrames; i++) {
            video.currentTime = i * interval;
            await this.seekVideo(video);

            const bmp = await createImageBitmap(video, { resizeWidth: w, resizeHeight: h });
            if (isGif) await gifEnc!.addFrame(bmp, delayMs);
            else await apngEnc!.addFrame(bmp, delayMs);
            bmp.close();

            this.config.onProgress?.(5 + Math.round((i / totalFrames) * 90), `Frame ${i + 1}/${totalFrames}`);
        }

        this.config.onProgress?.(95, 'Encoding...');
        return isGif ? gifEnc!.encode() : apngEnc!.encode();
    }

    private seekVideo(video: HTMLVideoElement): Promise<void> {
        return new Promise(resolve => {
            if (video.seeking) {
                video.addEventListener('seeked', () => requestAnimationFrame(() => resolve()), { once: true });
            } else {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }
        });
    }

    private async demuxAndExtractAudio(file: File | Blob, fmt: ContainerFormat): Promise<Blob> {
        const inputFmt = await this.detectFormat(file);

        // Choose the right demuxer
        let demuxer: { demux(input: File | Blob): Promise<import('./demux/mp4-demuxer').MP4DemuxResult> };
        if (inputFmt === 'flv') demuxer = new FLVDemuxer();
        else if (inputFmt === 'ts') demuxer = new TSDemuxer();
        else if (inputFmt === 'avi') demuxer = new AVIDemuxer();
        else throw new FlowCastError(`No native demuxer for ${inputFmt}`, 'DECODE');

        this.config.onProgress?.(5, 'Demuxing audio...');
        const result = await demuxer.demux(file);
        const srcA = result.audioTracks[0];
        if (!srcA || srcA.samples.length === 0) {
            throw new FlowCastError('No audio track found', 'DECODE');
        }

        this.config.onProgress?.(20, 'Decoding audio...');
        const buf = new Uint8Array(await file.arrayBuffer());

        // Decode audio using WebCodecs AudioDecoder
        const pcmChunks: Float32Array[] = [];
        let decodedSR = srcA.sampleRate || 44100;
        let decodedCh = srcA.channelCount || 2;
        let decErr: Error | null = null;

        const decoder = new AudioDecoder({
            output: (ad: AudioData) => {
                decodedSR = ad.sampleRate;
                decodedCh = ad.numberOfChannels;
                // Extract planar float32 data
                for (let ch = 0; ch < ad.numberOfChannels; ch++) {
                    const chData = new Float32Array(ad.numberOfFrames);
                    ad.copyTo(chData, { planeIndex: ch, format: 'f32-planar' });
                    pcmChunks.push(chData);
                }
                ad.close();
            },
            error: (e: DOMException) => { decErr = e; },
        });

        const decCfg: AudioDecoderConfig = {
            codec: webCodecsAudioCodec(srcA.codec),
            sampleRate: srcA.sampleRate || 44100,
            numberOfChannels: srcA.channelCount || 2,
        };
        if (srcA.codecConfig) {
            decCfg.description = srcA.codecConfig;
        }

        try {
            decoder.configure(decCfg);
        } catch (e) {
            throw new FlowCastError(`AudioDecoder configure failed: ${e}`, 'DECODE');
        }

        // Feed audio samples
        let decodeException: unknown = null;
        for (let i = 0; i < srcA.samples.length; i++) {
            if (decErr) break;
            const s = srcA.samples[i];
            const sampleData = s.data ?? buf.slice(s.offset, s.offset + s.size);
            try {
                decoder.decode(new EncodedAudioChunk({
                    type: 'key',
                    timestamp: Math.round(s.timestamp * 1e6),
                    duration: Math.round(s.duration * 1e6),
                    data: sampleData,
                }));
            } catch (e) {
                decodeException = e;
                break;
            }

            if (i % 100 === 0) {
                this.config.onProgress?.(20 + Math.round((i / srcA.samples.length) * 30), `Audio ${i}/${srcA.samples.length}`);
            }
        }

        if ((decoder.state as string) !== 'closed') {
            try { await decoder.flush(); } catch (e) { logger.warn('[Converter] AudioDecoder flush:', e); }
            decoder.close();
        }

        if (pcmChunks.length === 0) {
            const reason = decErr ?? decodeException;
            throw new FlowCastError(
                `AudioDecoder produced no output${reason ? `: ${reason instanceof Error ? reason.message : String(reason)}` : ''}`,
                'DECODE',
            );
        }

        // Reconstruct AudioBuffer from decoded PCM; chunk lengths vary (priming, tail).
        let totalFrames = 0;
        for (let i = 0; i < pcmChunks.length; i += decodedCh) totalFrames += pcmChunks[i].length;
        const audioBuf = new AudioBuffer({ numberOfChannels: decodedCh, length: Math.max(totalFrames, 1), sampleRate: decodedSR });

        // Interleave chunks back to channel buffers
        for (let ch = 0; ch < decodedCh; ch++) {
            const channelData = audioBuf.getChannelData(ch);
            let offset = 0;
            for (let i = ch; i < pcmChunks.length; i += decodedCh) {
                channelData.set(pcmChunks[i], offset);
                offset += pcmChunks[i].length;
            }
        }

        this.config.onProgress?.(60, 'Encoding audio...');
        return this.extractAudio(new Blob([]), fmt, audioBuf);
    }

    private async decodeAudioToBuffer(file: File | Blob, inputFmt?: ContainerFormat): Promise<AudioBuffer> {
        const decodeInput = this.ensureMediaInputMime(file, inputFmt);
        const ab = await decodeInput.arrayBuffer();
        // Decode directly at the rate the caller will use, so audio is resampled
        // at most once: requested rate > sniffed source rate > 48 kHz.
        const sniffedRate = sniffAudioSampleRate(new Uint8Array(ab, 0, Math.min(ab.byteLength, 8192)), inputFmt);
        const preferredRate = this.config.audioSampleRate || sniffedRate || 48000;
        const ctx = new AudioContext({ sampleRate: preferredRate });

        try {
            return await ctx.decodeAudioData(ab.slice(0));
        } catch (decodeErr) {
            logger.warn('[Converter] decodeAudioData failed, trying media element fallback:', decodeErr);
            if (inputFmt === 'mp2' || inputFmt === 'mp3') {
                try {
                    const decodedMpeg = await this.mpegAudioDecoder.decode(decodeInput, inputFmt);
                    if (decodedMpeg) return decodedMpeg;
                } catch (mpegDecodeErr) {
                    logger.warn(`[Converter] ${inputFmt.toUpperCase()} AudioDecoder fallback failed:`, mpegDecodeErr);
                }
            }
            try {
                return await this.decodeAudioViaMediaElement(decodeInput, preferredRate);
            } catch (fallbackErr) {
                throw new FlowCastError(
                    `Cannot decode audio${inputFmt ? ` (${inputFmt})` : ''}: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
                    'DECODE',
                );
            }
        } finally {
            try { await ctx.close(); } catch { /* ignore */ }
        }
    }

    private ensureMediaInputMime(file: File | Blob, inputFmt?: ContainerFormat): Blob {
        if (!inputFmt) return file;
        const mimeType = DemuxerRegistry.getMimeType(inputFmt);
        if (!mimeType) return file;
        if (file.type === mimeType) return file;
        return new Blob([file], { type: mimeType });
    }

    private async decodeAudioViaMediaElement(file: File | Blob, preferredRate: number): Promise<AudioBuffer> {
        const url = URL.createObjectURL(file);
        const audio = document.createElement('audio');
        audio.preload = 'auto';
        audio.setAttribute('playsinline', 'true');
        audio.muted = true;
        audio.volume = 0;
        audio.src = url;

        const ctx = new AudioContext({ sampleRate: preferredRate });
        const source = ctx.createMediaElementSource(audio);
        const silentGain = ctx.createGain();
        silentGain.gain.value = 0;

        const chunks: Float32Array[][] = [];
        let totalFrames = 0;
        let channelCount = 0;
        let captureCleanup: (() => void) | null = null;

        const collectChunk = (planes: Float32Array[]): void => {
            if (planes.length === 0) return;
            channelCount = Math.max(channelCount, planes.length);
            totalFrames += planes[0].length;
            for (let ch = 0; ch < planes.length; ch++) {
                if (!chunks[ch]) chunks[ch] = [];
                chunks[ch].push(planes[ch]);
            }
        };

        const attachWorkletCapture = async (): Promise<void> => {
            const workletCode = `
                class FlowCastCaptureProcessor extends AudioWorkletProcessor {
                    process(inputs, outputs) {
                        const input = inputs[0];
                        const output = outputs[0];
                        if (input && input.length) {
                            const copied = input.map((channel) => {
                                const clone = new Float32Array(channel.length);
                                clone.set(channel);
                                return clone;
                            });
                            this.port.postMessage(copied, copied.map((channel) => channel.buffer));
                            for (let ch = 0; ch < output.length; ch++) {
                                if (input[ch]) output[ch].set(input[ch]);
                            }
                        }
                        return true;
                    }
                }
                registerProcessor('flowcast-capture-processor', FlowCastCaptureProcessor);
            `;
            const blobUrl = URL.createObjectURL(new Blob([workletCode], { type: 'application/javascript' }));
            try {
                await ctx.audioWorklet.addModule(blobUrl);
            } finally {
                URL.revokeObjectURL(blobUrl);
            }

            const node = new AudioWorkletNode(ctx, 'flowcast-capture-processor', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [2],
            });
            node.port.onmessage = (event: MessageEvent<Float32Array[]>) => {
                collectChunk(event.data.map((channel) => new Float32Array(channel)));
            };
            source.connect(node);
            node.connect(silentGain);
            captureCleanup = () => {
                node.port.onmessage = null;
                node.disconnect();
            };
        };

        const attachScriptProcessorCapture = (): void => {
            const processor = ctx.createScriptProcessor(4096, 2, 2);
            processor.onaudioprocess = (event: AudioProcessingEvent) => {
                const input = event.inputBuffer;
                if (input.numberOfChannels === 0) return;
                const planes: Float32Array[] = [];
                for (let ch = 0; ch < input.numberOfChannels; ch++) {
                    planes.push(new Float32Array(input.getChannelData(ch)));
                }
                collectChunk(planes);
            };
            source.connect(processor);
            processor.connect(silentGain);
            captureCleanup = () => {
                processor.onaudioprocess = null;
                processor.disconnect();
            };
        };

        try {
            if (typeof AudioWorkletNode !== 'undefined' && ctx.audioWorklet) {
                await attachWorkletCapture();
            } else {
                attachScriptProcessorCapture();
            }
        } catch (workletErr) {
            logger.warn('[Converter] audioWorklet capture failed, falling back to ScriptProcessor:', workletErr);
            attachScriptProcessorCapture();
        }

        silentGain.connect(ctx.destination);

        const waitForLoaded = () => new Promise<void>((resolve, reject) => {
            const onOk = () => { cleanup(); resolve(); };
            const onErr = () => { cleanup(); reject(new Error('media element load failed')); };
            const cleanup = () => {
                audio.removeEventListener('loadeddata', onOk);
                audio.removeEventListener('error', onErr);
            };
            audio.addEventListener('loadeddata', onOk, { once: true });
            audio.addEventListener('error', onErr, { once: true });
        });

        try {
            if (audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
                audio.load();
                await waitForLoaded();
            }

            await ctx.resume();

            const ended = new Promise<void>((resolve, reject) => {
                const onEnded = () => { cleanup(); resolve(); };
                const onErr = () => { cleanup(); reject(new Error('media playback failed')); };
                const cleanup = () => {
                    audio.removeEventListener('ended', onEnded);
                    audio.removeEventListener('error', onErr);
                };
                audio.addEventListener('ended', onEnded, { once: true });
                audio.addEventListener('error', onErr, { once: true });
            });

            await audio.play();
            await Promise.race([
                ended,
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('media decode timeout')), 60000)),
            ]);
            await new Promise((resolve) => setTimeout(resolve, 50));

            if (totalFrames === 0 || channelCount === 0) {
                throw new Error('media element produced no PCM');
            }

            const audioBuf = ctx.createBuffer(channelCount, totalFrames, ctx.sampleRate);
            for (let ch = 0; ch < channelCount; ch++) {
                const channel = audioBuf.getChannelData(ch);
                let offset = 0;
                for (const chunk of chunks[ch] ?? []) {
                    channel.set(chunk, offset);
                    offset += chunk.length;
                }
            }
            return audioBuf;
        } finally {
            try { audio.pause(); } catch { /* ignore */ }
            if (captureCleanup) captureCleanup();
            source.disconnect();
            silentGain.disconnect();
            audio.src = '';
            URL.revokeObjectURL(url);
            try { await ctx.close(); } catch { /* ignore */ }
        }
    }

    private async extractAudio(
        file: File | Blob,
        fmt: ContainerFormat,
        preDecodedBuf?: AudioBuffer,
        inputFmt?: ContainerFormat,
    ): Promise<Blob> {
        this.config.onProgress?.(10, 'Decoding audio...');

        let decoded: AudioBuffer;
        if (preDecodedBuf) {
            decoded = preDecodedBuf;
        } else {
            if (fmt === 'm4a') {
                const remuxed = await this.tryDirectAudioRemux(file, inputFmt, 'm4a');
                if (remuxed) return remuxed;
            }
            decoded = await this.decodeAudioToBuffer(file, inputFmt);
        }

        if (fmt === 'mp3') {
            return this.encodeRealMP3(decoded);
        }
        if (fmt === 'mp2') {
            return this.encodeRealMP2(decoded);
        }

        const targetCh = Math.max(1, Math.min(decoded.numberOfChannels, this.config.audioChannels || 2));

        // Opus requires 48 kHz; otherwise keep the decoded rate unless one was requested.
        const targetRate = (fmt === 'ogg') ? 48000 : (this.config.audioSampleRate || decoded.sampleRate);
        const resampled = (decoded.sampleRate === targetRate && decoded.numberOfChannels === targetCh)
            ? decoded
            : await renderAudioBuffer(decoded, targetRate, targetCh);

        this.config.onProgress?.(50, 'Encoding...');

        if (fmt === 'wav') {
            const sink = new MemorySink();
            const wavMux = new WAVMuxer(sink, resampled.sampleRate, resampled.numberOfChannels);
            wavMux.addAudioBuffer(resampled);
            wavMux.finalize();
            this.config.onProgress?.(100, 'Done');
            return sink.toBlob('audio/wav');
        }

        if (fmt === 'ogg') {
            return this.encodeOggOpus(resampled);
        }
        if (fmt === 'aac') {
            return this.encodeADTS(resampled);
        }
        if (fmt === 'flac') {
            return this.encodeFLAC(resampled);
        }
        if (fmt === 'm4a') {
            if (this.config.audioCodec && codecFamily(this.config.audioCodec) !== 'mp4a') {
                throw new FlowCastError(`${this.config.audioCodec} output requires direct remux in this build`, 'ENCODE');
            }
            return this.encodeAacAudio(resampled, 'audio/mp4');
        }

        // Fallback to WAV
        const sink = new MemorySink();
        const wavMux = new WAVMuxer(sink, resampled.sampleRate, resampled.numberOfChannels);
        wavMux.addAudioBuffer(resampled);
        wavMux.finalize();
        this.config.onProgress?.(100, 'Done');
        return sink.toBlob('audio/wav');
    }

    private async encodeOggOpus(buf: AudioBuffer): Promise<Blob> {
        const audio = await renderAudioBuffer(buf, 48000, buf.numberOfChannels);
        const sr = audio.sampleRate;
        const ch = audio.numberOfChannels;
        const sink = new MemorySink();

        const muxerCfg = {
            format: 'ogg' as const,
            mode: 'standard' as const,
            maxFragmentDuration: 2.0,
            autoSync: true,
            audio: { id: 1, type: 'audio' as const, codec: 'opus', sampleRate: sr, channelCount: ch },
        };
        const mux = new OGGMuxer(muxerCfg, sink);

        const encState: { error: DOMException | null } = { error: null };
        const encoder = new AudioEncoder({
            output: (chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) => {
                const description = metadata?.decoderConfig?.description;
                if (description) mux.setCodecConfig(toUint8(description));
                const d = new Uint8Array(chunk.byteLength);
                chunk.copyTo(d);
                mux.addAudioChunk({
                    data: d, timestamp: chunk.timestamp / 1e6,
                    duration: (chunk.duration ?? 0) / 1e6, isKeyframe: true, trackType: 'audio',
                });
            },
            error: (e: DOMException) => { encState.error = e; },
        });

        try {
            encoder.configure({ codec: 'opus', sampleRate: sr, numberOfChannels: ch, bitrate: this.config.audioBitrate || 128000 });
        } catch (e) {
            throw new FlowCastError(`Opus encoder not supported: ${e instanceof Error ? e.message : String(e)}`, 'ENCODE');
        }
        await yieldToEventLoop();

        await encodeAudioBufferWithEncoder(audio, 960, async (audioData) => {
            if (encState.error) return;
            while (encoder.encodeQueueSize > 8) await yieldToEventLoop();
            encoder.encode(audioData);
        });

        try { await encoder.flush(); } catch (e) { logger.warn('[Converter] Opus flush:', e); }
        try { encoder.close(); } catch { /* already closed */ }
        const oggErr = encState.error;
        if (oggErr) throw new FlowCastError(`Opus encoding failed: ${oggErr.message}`, 'ENCODE');
        mux.finalize();
        this.config.onProgress?.(100, 'Done');
        return sink.toBlob('audio/ogg');
    }

    /** Collected AAC access units plus the matching AudioSpecificConfig. */
    private async collectAacFrames(buf: AudioBuffer): Promise<{
        frames: Uint8Array[]; asc: Uint8Array; sampleRate: number; channels: number;
    }> {
        // The self-hosted encoder needs a standard AAC rate; resample odd rates.
        const source = AAC_SAMPLE_RATES.includes(buf.sampleRate)
            ? buf
            : await renderAudioBuffer(buf, 48000, buf.numberOfChannels);
        const sr = source.sampleRate;
        const ch = source.numberOfChannels;
        const bitrate = this.config.audioBitrate || 128000;

        const viaWebCodecs = await this.tryWebCodecsAac(source, bitrate);
        if (viaWebCodecs) return viaWebCodecs;

        if (ch > 2) {
            throw new FlowCastError('AAC output beyond stereo requires WebCodecs support in this browser', 'ENCODE');
        }
        this.config.onProgress?.(60, 'Encoding AAC...');
        const pcm = await interleaveAudioBuffer(source, ch, { chunkFrames: 16384 });
        const request: MpegAudioEncodeRequest = {
            format: 'aac', pcm, sampleRate: sr, channels: ch, bitrate: Math.round(bitrate / 1000),
        };
        const report = (progress: MpegAudioEncodeProgress) => {
            if ((progress.completedFrames & 63) === 0 || progress.completedFrames === progress.totalFrames) {
                const pct = 60 + Math.round((progress.completedFrames / Math.max(1, progress.totalFrames)) * 35);
                this.config.onProgress?.(Math.min(99, pct), `Encoding AAC ${progress.completedFrames}/${progress.totalFrames}`);
            }
        };

        let adts: Uint8Array;
        const workerClient = AudioWorkerClient.getShared();
        if (workerClient) {
            try {
                adts = new Uint8Array(await workerClient.encode(request, report));
            } catch (workerErr) {
                logger.warn('[Converter] AAC worker encode failed, falling back to local encode:', workerErr);
                const localPcm = request.pcm.buffer.byteLength === 0
                    ? await interleaveAudioBuffer(source, ch, { chunkFrames: 16384 })
                    : request.pcm;
                await yieldToEventLoop();
                adts = wrapAdts(encodeAacLc(localPcm, sr, ch, request.bitrate, {
                    onProgress: (completedFrames, totalFrames) => report({ completedFrames, totalFrames }),
                }));
            }
        } else {
            await yieldToEventLoop();
            adts = wrapAdts(encodeAacLc(pcm, sr, ch, request.bitrate, {
                onProgress: (completedFrames, totalFrames) => report({ completedFrames, totalFrames }),
            }));
        }
        return { frames: sliceAdtsFrames(adts), asc: buildAacAsc(sr, ch), sampleRate: sr, channels: ch };
    }

    /** WebCodecs AAC attempt; null when unsupported or failing at runtime. */
    private async tryWebCodecsAac(buf: AudioBuffer, bitrate: number): Promise<{
        frames: Uint8Array[]; asc: Uint8Array; sampleRate: number; channels: number;
    } | null> {
        if (typeof AudioEncoder === 'undefined') return null;
        const sr = buf.sampleRate;
        const ch = buf.numberOfChannels;
        const frames: Uint8Array[] = [];
        let asc: Uint8Array | null = null;
        const encState: { error: DOMException | null } = { error: null };

        const encoder = new AudioEncoder({
            output: (chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) => {
                const description = metadata?.decoderConfig?.description;
                if (description && !asc) asc = toUint8(description);
                const d = new Uint8Array(chunk.byteLength);
                chunk.copyTo(d);
                frames.push(d);
            },
            error: (e: DOMException) => { encState.error = e; },
        });

        try {
            encoder.configure({ codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: ch, bitrate });
        } catch (e) {
            logger.info('[Converter] WebCodecs AAC unavailable, using built-in encoder:', e);
            try { encoder.close(); } catch { /* already closed */ }
            return null;
        }
        await yieldToEventLoop();

        try {
            await encodeAudioBufferWithEncoder(buf, 1024, async (audioData) => {
                if (encState.error) return;
                while (encoder.encodeQueueSize > 8) await yieldToEventLoop();
                encoder.encode(audioData);
            });
            await encoder.flush();
        } catch (e) {
            logger.warn('[Converter] WebCodecs AAC failed, using built-in encoder:', e);
            try { encoder.close(); } catch { /* already closed */ }
            return null;
        }
        try { encoder.close(); } catch { /* already closed */ }
        if (encState.error || frames.length === 0) {
            logger.warn('[Converter] WebCodecs AAC failed, using built-in encoder:', encState.error);
            return null;
        }
        return { frames, asc: asc ?? buildAacAsc(sr, ch), sampleRate: sr, channels: ch };
    }

    private async encodeAacAudio(buf: AudioBuffer, mimeType: string): Promise<Blob> {
        const { frames, asc, sampleRate, channels } = await this.collectAacFrames(buf);
        const sink = new MemorySink();
        const muxer = new MP4Muxer({
            format: 'm4a',
            mode: 'standard',
            maxFragmentDuration: 2.0,
            autoSync: true,
            audio: { id: 1, type: 'audio', codec: 'mp4a.40.2', sampleRate, channelCount: channels },
        }, sink);
        muxer.setAudioCodecConfig(asc);
        const frameSeconds = 1024 / sampleRate;
        for (let i = 0; i < frames.length; i++) {
            muxer.addAudioChunk({
                data: frames[i],
                timestamp: i * frameSeconds,
                duration: frameSeconds,
                isKeyframe: true,
                trackType: 'audio',
            });
        }
        muxer.finalize();
        this.config.onProgress?.(100, 'Done');
        return sink.toBlob(mimeType);
    }

    private async encodeADTS(buf: AudioBuffer): Promise<Blob> {
        const { frames, sampleRate, channels } = await this.collectAacFrames(buf);
        const sink = new MemorySink();
        const mux = new ADTSMuxer(sink, sampleRate, channels);
        const frameSeconds = 1024 / sampleRate;
        for (let i = 0; i < frames.length; i++) {
            mux.addAudioChunk({
                data: frames[i],
                timestamp: i * frameSeconds,
                duration: frameSeconds,
                isKeyframe: true,
                trackType: 'audio',
            });
        }
        mux.finalize();
        this.config.onProgress?.(100, 'Done');
        return sink.toBlob('audio/aac');
    }

    private async encodeFLAC(buf: AudioBuffer): Promise<Blob> {
        const channels = buf.numberOfChannels;
        this.config.onProgress?.(70, 'Preparing FLAC...');
        const pcm = await interleaveAudioBuffer(buf, channels, { chunkFrames: 16384 });
        const request: MpegAudioEncodeRequest = {
            format: 'flac', pcm, sampleRate: buf.sampleRate, channels, bitrate: 0,
        };
        const reportFlac = (progress: MpegAudioEncodeProgress) => {
            const pct = 75 + Math.round((progress.completedFrames / Math.max(1, progress.totalFrames)) * 24);
            this.config.onProgress?.(Math.min(99, pct), `Encoding FLAC ${progress.completedFrames}/${progress.totalFrames}`);
        };

        let encoded: Uint8Array<ArrayBuffer>;
        const workerClient = AudioWorkerClient.getShared();
        if (workerClient) {
            try {
                encoded = new Uint8Array(await workerClient.encode(request, reportFlac));
            } catch (workerErr) {
                logger.warn('[Converter] FLAC worker encode failed, falling back to local encode:', workerErr);
                const localPcm = request.pcm.buffer.byteLength === 0
                    ? await interleaveAudioBuffer(buf, channels, { chunkFrames: 16384 })
                    : request.pcm;
                await yieldToEventLoop();
                encoded = encodeFlac(localPcm, buf.sampleRate, channels, {
                    onProgress: (completedFrames, totalFrames) => reportFlac({ completedFrames, totalFrames }),
                });
            }
        } else {
            await yieldToEventLoop();
            encoded = encodeFlac(pcm, buf.sampleRate, channels, {
                onProgress: (completedFrames, totalFrames) => reportFlac({ completedFrames, totalFrames }),
            });
        }
        this.config.onProgress?.(100, 'Done');
        return new Blob([encoded], { type: 'audio/flac' });
    }

    private async encodeRealMP3(buf: AudioBuffer): Promise<Blob> {
        return this.mpegAudioEncoder.encode(buf, 'mp3');
    }

    private async encodeRealMP2(buf: AudioBuffer): Promise<Blob> {
        return this.mpegAudioEncoder.encode(buf, 'mp2');
    }

}

function toUint8(source: AllowSharedBufferSource): Uint8Array {
    if (ArrayBuffer.isView(source)) {
        const out = new Uint8Array(source.byteLength);
        out.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
        return out;
    }
    const out = new Uint8Array(source.byteLength);
    out.set(new Uint8Array(source));
    return out;
}

/** Two-byte AudioSpecificConfig for AAC-LC. */
/** Split an ADTS stream (7/9-byte headers) back into raw access units. */
function sliceAdtsFrames(adts: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    let off = 0;
    while (off + 7 <= adts.length) {
        if (adts[off] !== 0xFF || (adts[off + 1] & 0xF0) !== 0xF0) { off++; continue; }
        const headerLen = (adts[off + 1] & 1) ? 7 : 9;
        const frameLen = ((adts[off + 3] & 3) << 11) | (adts[off + 4] << 3) | (adts[off + 5] >> 5);
        if (frameLen <= headerLen || off + frameLen > adts.length) break;
        frames.push(adts.subarray(off + headerLen, off + frameLen));
        off += frameLen;
    }
    return frames;
}

function buildAacAsc(sampleRate: number, channels: number): Uint8Array {
    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    let freqIdx = rates.indexOf(sampleRate);
    if (freqIdx < 0) freqIdx = 4;
    const objectType = 2; // AAC-LC
    return Uint8Array.from([
        (objectType << 3) | (freqIdx >> 1),
        ((freqIdx & 1) << 7) | ((channels & 0xF) << 3),
    ]);
}

/** Best-effort source sample-rate sniff from container headers (null = unknown). */
function sniffAudioSampleRate(head: Uint8Array, fmt?: ContainerFormat): number | null {
    const mpegRate = (): number | null => {
        let scanStart = 0;
        if (head.length >= 10 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
            const size = ((head[6] & 0x7F) << 21) | ((head[7] & 0x7F) << 14) | ((head[8] & 0x7F) << 7) | (head[9] & 0x7F);
            scanStart = Math.min(head.length, 10 + size); // skip ID3 to avoid false syncs in tag data
        }
        for (let i = scanStart; i + 3 < head.length; i++) {
            if (head[i] !== 0xFF || (head[i + 1] & 0xE0) !== 0xE0) continue;
            const versionBits = (head[i + 1] >> 3) & 3;
            const srBits = (head[i + 2] >> 2) & 3;
            if (srBits === 3) continue;
            const mpeg1 = [44100, 48000, 32000][srBits];
            if (versionBits === 3) return mpeg1;          // MPEG-1
            if (versionBits === 2) return mpeg1 / 2;      // MPEG-2
            if (versionBits === 0) return mpeg1 / 4;      // MPEG-2.5
        }
        return null;
    };
    switch (fmt) {
        case 'wav': {
            for (let i = 12; i + 16 < head.length; i++) {
                if (head[i] === 0x66 && head[i + 1] === 0x6D && head[i + 2] === 0x74 && head[i + 3] === 0x20) {
                    return head[i + 12] | (head[i + 13] << 8) | (head[i + 14] << 16) | (head[i + 15] << 24);
                }
            }
            return null;
        }
        case 'flac': {
            if (head.length > 20 && head[0] === 0x66 && head[1] === 0x4C && head[2] === 0x61 && head[3] === 0x43) {
                return (head[18] << 12) | (head[19] << 4) | (head[20] >> 4);
            }
            return null;
        }
        case 'ogg': {
            for (let i = 0; i + 12 < head.length; i++) {
                if (head[i] === 0x4F && head[i + 1] === 0x70 && head[i + 2] === 0x75 && head[i + 3] === 0x73
                    && head[i + 4] === 0x48) return 48000; // OpusHead: Opus always decodes at 48 kHz
                if (head[i] === 0x01 && head[i + 1] === 0x76 && head[i + 2] === 0x6F && head[i + 3] === 0x72
                    && head[i + 4] === 0x62 && head[i + 5] === 0x69 && head[i + 6] === 0x73) {
                    return head[i + 12] | (head[i + 13] << 8) | (head[i + 14] << 16) | (head[i + 15] << 24);
                }
            }
            return null;
        }
        case 'aac': {
            for (let i = 0; i + 2 < head.length; i++) {
                if (head[i] === 0xFF && (head[i + 1] & 0xF6) === 0xF0) {
                    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
                    const idx = (head[i + 2] >> 2) & 0xF;
                    return rates[idx] ?? null;
                }
            }
            return null;
        }
        case 'mp3':
        case 'mp2':
            return mpegRate();
        default:
            return null;
    }
}
