import { logger } from '../core/logger';
import { EncodeError } from '../core/errors';
import {
    interleaveAudioBuffer,
    renderAudioBuffer,
    yieldToEventLoop,
} from './audio-buffer-tools';
import { AudioWorkerClient } from './audio-worker-client';
import { encodeMP2, legalMp2Bitrates } from './mp2-encoder';
import { encodeMP3 } from './mp3-encoder';
import type {
    MpegAudioEncodeOptions,
    MpegAudioEncodeProgress,
    MpegAudioEncodeRequest,
    MpegAudioFormat,
} from './mpeg-audio-types';

export interface MpegAudioEncoderConfig {
    readonly audioBitrate?: number;
    readonly audioSampleRate?: number;
    readonly audioChannels?: number;
    readonly onProgress?: (progress: number, message: string) => void;
}

export interface PreparedMpegAudioBuffer {
    readonly audioBuffer: AudioBuffer;
    readonly bitrate: number;
    readonly sourcePeak: number;
    readonly preparedPeak: number;
    readonly appliedGain: number;
}

const MPEG_AUDIO_SAMPLE_RATES = [32000, 44100, 48000] as const;
const MP3_BITRATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] as const;
const MP2_TARGET_PEAK = 0.9;
const MP3_TARGET_PEAK = 0.94;

function pickNearestInt(target: number, supportedValues: readonly number[], fallbackValue: number): number {
    if (!Number.isFinite(target)) return fallbackValue;
    let bestValue = supportedValues[0] ?? fallbackValue;
    let bestDistance = Math.abs(bestValue - target);
    for (const value of supportedValues) {
        const distance = Math.abs(value - target);
        if (distance < bestDistance) {
            bestValue = value;
            bestDistance = distance;
        }
    }
    return bestValue;
}

function resolveTargetSampleRate(config: MpegAudioEncoderConfig, audioBuffer: AudioBuffer): number {
    return pickNearestInt(
        config.audioSampleRate ?? audioBuffer.sampleRate,
        MPEG_AUDIO_SAMPLE_RATES,
        44100,
    );
}

function resolveTargetChannels(config: MpegAudioEncoderConfig, audioBuffer: AudioBuffer): number {
    // 0 or undefined means "not specified"; mono stays mono, >2ch downmixes to stereo.
    const requested = config.audioChannels || audioBuffer.numberOfChannels;
    return Math.max(1, Math.min(2, requested));
}

function measurePeak(audioBuffer: AudioBuffer): number {
    let peak = 0;
    for (let channelIndex = 0; channelIndex < audioBuffer.numberOfChannels; channelIndex++) {
        const channel = audioBuffer.getChannelData(channelIndex);
        for (let sampleIndex = 0; sampleIndex < channel.length; sampleIndex++) {
            const amplitude = Math.abs(channel[sampleIndex]);
            if (amplitude > peak) peak = amplitude;
        }
    }
    return peak;
}

export function resolveMpegAudioBitrate(format: MpegAudioFormat, audioBitrate: number | undefined, channels: number): number {
    const preferredKbps = Math.max(32, Math.round((audioBitrate || 256000) / 1000));
    return format === 'mp3'
        ? pickNearestInt(preferredKbps, MP3_BITRATES, 256)
        : pickNearestInt(preferredKbps, legalMp2Bitrates(channels), channels === 1 ? 192 : 256);
}

export function applyMpegAudioPeakHeadroom(audioBuffer: AudioBuffer, targetPeak: number): {
    readonly sourcePeak: number;
    readonly preparedPeak: number;
    readonly appliedGain: number;
} {
    const sourcePeak = measurePeak(audioBuffer);
    if (!(sourcePeak > targetPeak) || sourcePeak <= 1e-9) {
        return {
            sourcePeak,
            preparedPeak: sourcePeak,
            appliedGain: 1,
        };
    }

    const gain = targetPeak / sourcePeak;
    for (let channelIndex = 0; channelIndex < audioBuffer.numberOfChannels; channelIndex++) {
        const channel = audioBuffer.getChannelData(channelIndex);
        for (let sampleIndex = 0; sampleIndex < channel.length; sampleIndex++) {
            channel[sampleIndex] *= gain;
        }
    }

    return {
        sourcePeak,
        preparedPeak: measurePeak(audioBuffer),
        appliedGain: gain,
    };
}

export async function prepareMpegAudioBuffer(
    audioBuffer: AudioBuffer,
    format: MpegAudioFormat,
    config: MpegAudioEncoderConfig = {},
): Promise<PreparedMpegAudioBuffer> {
    const targetRate = resolveTargetSampleRate(config, audioBuffer);
    const targetChannels = resolveTargetChannels(config, audioBuffer);
    const rendered = await renderAudioBuffer(audioBuffer, targetRate, targetChannels);
    const headroom = applyMpegAudioPeakHeadroom(
        rendered,
        format === 'mp3' ? MP3_TARGET_PEAK : MP2_TARGET_PEAK,
    );
    return {
        audioBuffer: rendered,
        bitrate: resolveMpegAudioBitrate(format, config.audioBitrate, rendered.numberOfChannels),
        sourcePeak: headroom.sourcePeak,
        preparedPeak: headroom.preparedPeak,
        appliedGain: headroom.appliedGain,
    };
}

export class MpegAudioEncoder {
    private readonly config: MpegAudioEncoderConfig;

    constructor(config: MpegAudioEncoderConfig = {}) {
        this.config = config;
    }

    async encode(audioBuffer: AudioBuffer, format: MpegAudioFormat): Promise<Blob> {
        const upperFormat = format.toUpperCase();
        const prepared = await prepareMpegAudioBuffer(audioBuffer, format, this.config);
        const rendered = prepared.audioBuffer;
        const bitrate = prepared.bitrate;

        this.report(82, `Preparing ${upperFormat} audio...`);
        const pcm = await interleaveAudioBuffer(rendered, rendered.numberOfChannels, {
            chunkFrames: 16384,
            onChunk: async (processedFrames, totalFrames) => {
                this.report(
                    82 + Math.min(7, Math.round((processedFrames / Math.max(totalFrames, 1)) * 7)),
                    `Preparing ${upperFormat} audio ${processedFrames}/${totalFrames}`,
                );
                await yieldToEventLoop();
            },
        });

        const encodeRequest: MpegAudioEncodeRequest = {
            format,
            pcm,
            sampleRate: rendered.sampleRate,
            channels: rendered.numberOfChannels,
            bitrate,
        };

        this.report(90, `Encoding ${upperFormat}...`);
        let encodedBuffer: ArrayBuffer;
        const workerClient = AudioWorkerClient.getShared();
        if (workerClient) {
            try {
                encodedBuffer = await workerClient.encode(encodeRequest, (progress) => {
                    this.reportEncodingProgress(format, progress);
                });
            } catch (error) {
                logger.warn('[MpegAudioEncoder] worker encode failed, falling back to local encode:', error);
                // The worker transfers the PCM buffer; if it died mid-job the
                // buffer is detached and the samples must be rebuilt first.
                const localPcm = encodeRequest.pcm.buffer.byteLength === 0
                    ? await interleaveAudioBuffer(rendered, rendered.numberOfChannels, { chunkFrames: 16384 })
                    : encodeRequest.pcm;
                encodedBuffer = await this.encodeLocal({ ...encodeRequest, pcm: localPcm });
            }
        } else {
            encodedBuffer = await this.encodeLocal(encodeRequest);
        }
        this.report(100, 'Done');
        return new Blob([encodedBuffer], { type: format === 'mp2' ? 'audio/mp2' : 'audio/mpeg' });
    }

    private async encodeLocal(request: MpegAudioEncodeRequest): Promise<ArrayBuffer> {
        const { format } = request;
        if (format === 'flac' || format === 'aac') {
            throw new EncodeError('MpegAudioEncoder handles MPEG formats only');
        }
        const encodeOptions: MpegAudioEncodeOptions = {
            onProgress: (progress) => {
                this.reportEncodingProgress(format, progress);
            },
        };
        await yieldToEventLoop();
        const encoded = format === 'mp3'
            ? encodeMP3(request.pcm, request.sampleRate, request.channels, request.bitrate, encodeOptions)
            : encodeMP2(request.pcm, request.sampleRate, request.channels, request.bitrate, encodeOptions);
        return encoded.arrayBuffer();
    }

    private reportEncodingProgress(format: MpegAudioFormat, progress: MpegAudioEncodeProgress): void {
        const upperFormat = format.toUpperCase();
        const ratio = progress.completedFrames / Math.max(progress.totalFrames, 1);
        const progressPercent = 90 + Math.min(9, Math.round(ratio * 9));
        this.report(
            progressPercent,
            `Encoding ${upperFormat} ${progress.completedFrames}/${progress.totalFrames}`,
        );
    }

    private report(progress: number, message: string): void {
        this.config.onProgress?.(progress, message);
    }
}
