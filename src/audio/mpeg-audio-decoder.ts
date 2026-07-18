import { logger } from '../core/logger';
import { yieldToEventLoop } from './audio-buffer-tools';
import { decodeMpegLayer12, skipId3v2 } from './mpeg-layer12-decoder';

export type MpegAudioInputFormat = 'mp2' | 'mp3';

interface ParsedMpegAudioFrame {
    readonly offset: number;
    readonly size: number;
    readonly timestamp: number;
    readonly duration: number;
}

interface ParsedMpegAudioStream {
    readonly sampleRate: number;
    readonly channels: number;
    readonly frames: ParsedMpegAudioFrame[];
}

interface ParsedMpegAudioHeader {
    readonly format: MpegAudioInputFormat;
    readonly sampleRate: number;
    readonly channels: number;
    readonly frameLength: number;
    readonly samplesPerFrame: number;
}

const MPEG_SAMPLE_RATES: Record<number, readonly number[]> = {
    0: [11025, 12000, 8000],
    2: [22050, 24000, 16000],
    3: [44100, 48000, 32000],
};

const MPEG1_LAYER2_BITRATES = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0] as const;
const MPEG1_LAYER3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0] as const;
const MPEG2_LAYER23_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0] as const;

function parseMpegAudioHeader(data: Uint8Array, offset: number): ParsedMpegAudioHeader | null {
    if (offset + 4 > data.length) return null;
    if (data[offset] !== 0xFF || (data[offset + 1] & 0xE0) !== 0xE0) return null;

    const versionBits = (data[offset + 1] >> 3) & 0x03;
    const layerBits = (data[offset + 1] >> 1) & 0x03;
    const bitrateIndex = (data[offset + 2] >> 4) & 0x0F;
    const sampleRateIndex = (data[offset + 2] >> 2) & 0x03;
    const padding = (data[offset + 2] >> 1) & 0x01;
    const mode = (data[offset + 3] >> 6) & 0x03;

    if (versionBits === 1 || sampleRateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15) return null;

    const format: MpegAudioInputFormat | null =
        layerBits === 1 ? 'mp3'
            : layerBits === 2 ? 'mp2'
                : null;
    if (!format) return null;

    const sampleRates = MPEG_SAMPLE_RATES[versionBits];
    if (!sampleRates) return null;
    const sampleRate = sampleRates[sampleRateIndex];
    if (!sampleRate) return null;

    const bitrateKbps = format === 'mp2'
        ? (versionBits === 3 ? MPEG1_LAYER2_BITRATES[bitrateIndex] : MPEG2_LAYER23_BITRATES[bitrateIndex])
        : (versionBits === 3 ? MPEG1_LAYER3_BITRATES[bitrateIndex] : MPEG2_LAYER23_BITRATES[bitrateIndex]);
    if (!bitrateKbps) return null;

    const samplesPerFrame = format === 'mp2'
        ? 1152
        : (versionBits === 3 ? 1152 : 576);
    const frameLength = format === 'mp2'
        ? Math.floor((144000 * bitrateKbps) / sampleRate) + padding
        : Math.floor((((versionBits === 3 ? 144000 : 72000) * bitrateKbps) / sampleRate)) + padding;

    if (!Number.isFinite(frameLength) || frameLength < 24) return null;

    return {
        format,
        sampleRate,
        channels: mode === 3 ? 1 : 2,
        frameLength,
        samplesPerFrame,
    };
}

function parseMpegAudioStream(data: Uint8Array, expectedFormat: MpegAudioInputFormat): ParsedMpegAudioStream | null {
    const frames: ParsedMpegAudioFrame[] = [];
    let offset = skipId3v2(data, 0);
    let sampleRate = 0;
    let channels = 0;
    let timestamp = 0;

    while (offset + 4 <= data.length) {
        const header = parseMpegAudioHeader(data, offset);
        if (!header || header.format !== expectedFormat || offset + header.frameLength > data.length) {
            offset++;
            continue;
        }

        const nextOffset = offset + header.frameLength;
        if (nextOffset + 4 <= data.length) {
            const nextHeader = parseMpegAudioHeader(data, nextOffset);
            if (!nextHeader || nextHeader.format !== expectedFormat) {
                offset++;
                continue;
            }
        }

        sampleRate = header.sampleRate;
        channels = header.channels;
        const duration = Math.round((header.samplesPerFrame / header.sampleRate) * 1e6);
        frames.push({
            offset,
            size: header.frameLength,
            timestamp,
            duration,
        });
        timestamp += duration;
        offset = nextOffset;
    }

    if (frames.length === 0 || sampleRate === 0 || channels === 0) return null;
    return { sampleRate, channels, frames };
}

function codecCandidates(format: MpegAudioInputFormat): readonly string[] {
    // Browsers register MPEG audio Layers I-III under the single 'mp3' codec
    // string; their ffmpeg-backed decoder handles Layer II data through it.
    return format === 'mp3' ? ['mp3'] : ['mp2', 'mp3'];
}

function createAudioBuffer(channelChunks: readonly Float32Array[][], totalFrames: number, sampleRate: number): AudioBuffer {
    const channelCount = channelChunks.length;
    const offlineContext = new OfflineAudioContext(channelCount, Math.max(totalFrames, 1), sampleRate);
    const audioBuffer = offlineContext.createBuffer(channelCount, Math.max(totalFrames, 1), sampleRate);
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
        const channelData = audioBuffer.getChannelData(channelIndex);
        let frameOffset = 0;
        for (const chunk of channelChunks[channelIndex] ?? []) {
            channelData.set(chunk, frameOffset);
            frameOffset += chunk.length;
        }
    }
    return audioBuffer;
}

export interface MpegAudioDecoderConfig {
    readonly onProgress?: (progress: number, message: string) => void;
}

export class MpegAudioDecoder {
    private readonly config: MpegAudioDecoderConfig;

    constructor(config: MpegAudioDecoderConfig = {}) {
        this.config = config;
    }

    async decode(file: Blob, format: MpegAudioInputFormat): Promise<AudioBuffer | null> {
        const bytes = new Uint8Array(await file.arrayBuffer());
        // Container sniffing can mislabel the layer (e.g. an mp2 behind a large
        // ID3 tag); fall back to the sibling layer instead of trusting it.
        let effectiveFormat = format;
        let parsedStream = parseMpegAudioStream(bytes, format);
        if (!parsedStream) {
            const sibling: MpegAudioInputFormat = format === 'mp3' ? 'mp2' : 'mp3';
            parsedStream = parseMpegAudioStream(bytes, sibling);
            if (parsedStream) effectiveFormat = sibling;
        }

        if (parsedStream && typeof AudioDecoder !== 'undefined') {
            for (const codec of codecCandidates(effectiveFormat)) {
                const decoded = await this.tryDecodeWithCodec(bytes, parsedStream, codec, effectiveFormat);
                if (decoded) return decoded;
            }
        }

        // Built-in Layer I/II decoder; returns null quickly for Layer III data.
        const selfDecoded = decodeMpegLayer12(bytes);
        if (selfDecoded) {
            return createAudioBuffer(
                selfDecoded.channelData.map((channel) => [channel]),
                selfDecoded.channelData[0].length,
                selfDecoded.sampleRate,
            );
        }

        if (!parsedStream) {
            logger.warn(`[MpegAudioDecoder] could not parse raw ${format.toUpperCase()} frames`);
        }
        return null;
    }

    private async tryDecodeWithCodec(
        bytes: Uint8Array,
        stream: ParsedMpegAudioStream,
        codec: string,
        format: MpegAudioInputFormat,
    ): Promise<AudioBuffer | null> {
        const config: AudioDecoderConfig = {
            codec,
            sampleRate: stream.sampleRate,
            numberOfChannels: stream.channels,
        };

        try {
            if (typeof AudioDecoder.isConfigSupported === 'function') {
                const support = await AudioDecoder.isConfigSupported(config);
                if (!support.supported) return null;
            }
        } catch {
            return null;
        }

        const channelChunks: Float32Array[][] = Array.from({ length: stream.channels }, () => []);
        let totalFrames = 0;
        let decodedSampleRate = stream.sampleRate;
        let decodedChannels = stream.channels;
        let decodeError: Error | null = null;

        const decoder = new AudioDecoder({
            output: (audioData: AudioData) => {
                try {
                    decodedSampleRate = audioData.sampleRate;
                    decodedChannels = audioData.numberOfChannels;
                    while (channelChunks.length < decodedChannels) channelChunks.push([]);
                    for (let channelIndex = 0; channelIndex < decodedChannels; channelIndex++) {
                        const plane = new Float32Array(audioData.numberOfFrames);
                        audioData.copyTo(plane, {
                            planeIndex: channelIndex,
                            format: 'f32-planar',
                        });
                        channelChunks[channelIndex].push(plane);
                    }
                    totalFrames += audioData.numberOfFrames;
                } finally {
                    audioData.close();
                }
            },
            error: (error: DOMException) => {
                decodeError = error;
            },
        });

        try {
            decoder.configure(config);
        } catch {
            try { decoder.close(); } catch { /* ignore */ }
            return null;
        }

        try {
            for (let index = 0; index < stream.frames.length; index++) {
                if (decodeError) break;
                const frame = stream.frames[index];
                const frameData = bytes.subarray(frame.offset, frame.offset + frame.size);
                decoder.decode(new EncodedAudioChunk({
                    type: 'key',
                    timestamp: frame.timestamp,
                    duration: frame.duration,
                    data: frameData,
                }));
                if ((index & 31) === 0 || index === stream.frames.length - 1) {
                    this.config.onProgress?.(
                        18 + Math.min(20, Math.round(((index + 1) / stream.frames.length) * 20)),
                        `Decoding ${format.toUpperCase()} ${index + 1}/${stream.frames.length}`,
                    );
                    await yieldToEventLoop();
                }
            }
            if (!decodeError) {
                await decoder.flush();
            }
        } catch (error) {
            decodeError = error instanceof Error ? error : new Error(String(error));
        } finally {
            try { decoder.close(); } catch { /* ignore */ }
        }

        if (decodeError || totalFrames === 0 || decodedChannels === 0) {
            logger.warn(`[MpegAudioDecoder] ${format.toUpperCase()} decode failed for codec '${codec}':`, decodeError);
            return null;
        }

        return createAudioBuffer(channelChunks, totalFrames, decodedSampleRate);
    }
}
