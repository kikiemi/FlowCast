import { FlowCastError } from '../core/errors';
import { logger } from '../core/logger';

export interface DemuxedTrackInfo {
    hasVideo: boolean;
    hasAudio: boolean;
    videoWidth: number;
    videoHeight: number;
    duration: number;
    audioSampleRate: number;
    audioChannels: number;
}

export class DOMDemuxer {
    private readonly fps: number;
    private readonly signal?: AbortSignal;
    private readonly onProgress?: (pct: number, msg: string) => void;
    private video: HTMLVideoElement | null = null;
    private url: string | null = null;
    private info: DemuxedTrackInfo | null = null;
    private cachedAudio: AudioBuffer | null = null;

    constructor(cfg: { fps?: number; signal?: AbortSignal; onProgress?: (p: number, m: string) => void } = {}) {
        this.fps = cfg.fps ?? 30;
        this.signal = cfg.signal;
        this.onProgress = cfg.onProgress;
    }

    async open(input: File | Blob): Promise<DemuxedTrackInfo> {
        const v = document.createElement('video');
        v.muted = true;
        v.preload = 'auto';
        v.playsInline = true;
        const url = URL.createObjectURL(input);
        v.src = url;

        await new Promise<void>((resolve, reject) => {
            const ok = () => { rm(); resolve(); };
            const ng = () => { rm(); reject(new FlowCastError('Failed to load video', 'DECODE')); };
            const rm = () => { v.removeEventListener('loadeddata', ok); v.removeEventListener('error', ng); };
            v.addEventListener('loadeddata', ok);
            v.addEventListener('error', ng);
        });

        this.video = v;
        this.url = url;

        const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : -1;
        let sr = 48000, ch = 2, hasAudio = false;
        try {
            const ctx = new AudioContext();
            const ab = await input.arrayBuffer();
            const dec = await ctx.decodeAudioData(ab);
            sr = dec.sampleRate; ch = dec.numberOfChannels; hasAudio = true;
            this.cachedAudio = dec;
            ctx.close();
        } catch (e) { logger.warn('[DOMDemuxer] Audio detection failed:', e); hasAudio = false; }

        this.info = {
            hasVideo: v.videoWidth > 0 && v.videoHeight > 0,
            hasAudio, videoWidth: v.videoWidth || 0, videoHeight: v.videoHeight || 0,
            duration: dur, audioSampleRate: sr, audioChannels: ch,
        };
        return this.info;
    }

    async *videoFrames(): AsyncGenerator<VideoFrame> {
        const v = this.video;
        if (!v || !this.info?.hasVideo) return;
        const fps = this.fps;
        const dur = this.info.duration;
        if (dur <= 0) return;
        const total = Math.ceil(dur * fps);
        for (let i = 0; i < total; i++) {
            if (this.signal?.aborted) throw new FlowCastError('Aborted', 'ABORT');
            v.currentTime = i / fps;
            await this.waitSeek(v);
            const bmp = await createImageBitmap(v);
            const f = new VideoFrame(bmp, { timestamp: Math.round(i / fps * 1e6) });
            bmp.close();
            yield f;
            this.onProgress?.(10 + Math.round((i / total) * 70), `Frame ${i + 1}/${total}`);
        }
    }

    async decodeAudio(_input: File | Blob): Promise<AudioBuffer | null> {
        if (!this.info?.hasAudio) return null;
        if (this.cachedAudio) {
            const buf = this.cachedAudio;
            this.cachedAudio = null;
            return buf;
        }
        try {
            const ctx = new AudioContext();
            const ab = await _input.arrayBuffer();
            const dec = await ctx.decodeAudioData(ab);
            ctx.close();
            return dec;
        } catch (e) { logger.warn('[DOMDemuxer] Audio decode failed:', e); return null; }
    }

    close(): void {
        if (this.video) { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); this.video = null; }
        if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
        this.info = null;
        this.cachedAudio = null;
    }

    private waitSeek(v: HTMLVideoElement): Promise<void> {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => { rm(); reject(new FlowCastError('Seek timeout', 'DECODE')); }, 10000);
            const ok = () => { rm(); requestAnimationFrame(() => resolve()); };
            const ng = () => { rm(); reject(new FlowCastError('Seek error', 'DECODE')); };
            const rm = () => { clearTimeout(t); v.removeEventListener('seeked', ok); v.removeEventListener('error', ng); };
            v.addEventListener('seeked', ok);
            v.addEventListener('error', ng);
            if (!v.seeking) { rm(); requestAnimationFrame(() => requestAnimationFrame(() => resolve())); }
        });
    }
}
