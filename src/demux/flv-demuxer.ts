import type { Source } from '../types/io';
import { DemuxError } from '../core/errors';
import { logger } from '../core/logger';
import type { MP4Sample, MP4DemuxResult } from './mp4-demuxer';

const FREQ_TABLE = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

export class FLVDemuxer {
    async demux(input: File | Blob | Source): Promise<MP4DemuxResult> {
        const buf = input instanceof Blob
            ? new Uint8Array(await input.arrayBuffer())
            : await input.read(0, (input as { size?: number }).size ?? 0);

        if (buf.length < 9 || buf[0] !== 0x46 || buf[1] !== 0x4C || buf[2] !== 0x56) {
            throw new DemuxError('Not an FLV file');
        }

        const dataOffset = new DataView(buf.buffer, buf.byteOffset).getUint32(5, false);

        const videoSamples: MP4Sample[] = [];
        const audioSamples: MP4Sample[] = [];
        let videoCodec = '';
        let audioCodec = '';
        let width = 0, height = 0;
        let sampleRate = 44100, channelCount = 2;
        let videoCodecConfig: Uint8Array | undefined;
        let audioCodecConfig: Uint8Array | undefined;

        let pos = dataOffset;
        while (pos + 15 <= buf.length) {
            // PreviousTagSize (4 bytes) + Tag header (11 bytes)
            pos += 4; // PreviousTagSize (unused)

            if (pos + 11 > buf.length) break;

            const tagType = buf[pos];
            const dataSize = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
            const tsLow = (buf[pos + 4] << 16) | (buf[pos + 5] << 8) | buf[pos + 6];
            const tsExt = buf[pos + 7];
            const timestamp = ((tsExt << 24) | tsLow) >>> 0;

            const tagDataOffset = pos + 11;
            if (tagDataOffset + dataSize > buf.length) break;

            if (tagType === 9 && dataSize > 0) {
                // Video tag
                const frameType = (buf[tagDataOffset] >> 4) & 0x0F;
                const codecId = buf[tagDataOffset] & 0x0F;

                if (codecId === 7) {
                    // H.264 / AVC
                    videoCodec = 'avc1.640028';
                    const avcPacketType = buf[tagDataOffset + 1];

                    if (avcPacketType === 0 && !videoCodecConfig) {
                        // AVC sequence header (AVCDecoderConfigurationRecord)
                        videoCodecConfig = buf.slice(tagDataOffset + 5, tagDataOffset + dataSize);
                        // Try to parse width/height from SPS
                        const parsed = this.parseAvcC(videoCodecConfig);
                        if (parsed) { width = parsed.width; height = parsed.height; }
                    } else if (avcPacketType === 1) {
                        // AVC NALU(s)
                        const cts = ((buf[tagDataOffset + 2] << 16) | (buf[tagDataOffset + 3] << 8) | buf[tagDataOffset + 4]) << 8 >> 8; // sign extend 24-bit
                        const pts = (timestamp + cts) / 1000;
                        videoSamples.push({
                            offset: tagDataOffset + 5,
                            size: dataSize - 5,
                            timestamp: pts,
                            duration: 0,
                            isKeyframe: frameType === 1,
                            data: buf.slice(tagDataOffset + 5, tagDataOffset + dataSize),
                        });
                    }
                }
            } else if (tagType === 8 && dataSize > 0) {
                // Audio tag
                const soundFormat = (buf[tagDataOffset] >> 4) & 0x0F;

                if (soundFormat === 10) {
                    // AAC
                    audioCodec = 'mp4a.40.2';
                    const aacPacketType = buf[tagDataOffset + 1];

                    const sndRate = (buf[tagDataOffset] >> 2) & 3;
                    sampleRate = [5500, 11025, 22050, 44100][sndRate] ?? 44100;
                    channelCount = (buf[tagDataOffset] & 1) ? 2 : 1;

                    if (aacPacketType === 0 && !audioCodecConfig) {
                        // AAC sequence header (AudioSpecificConfig)
                        audioCodecConfig = buf.slice(tagDataOffset + 2, tagDataOffset + dataSize);
                        // Parse AudioSpecificConfig for real sample rate
                        if (audioCodecConfig.length >= 2) {
                            const freqIdx = ((audioCodecConfig[0] & 0x07) << 1) | (audioCodecConfig[1] >> 7);
                            if (freqIdx < FREQ_TABLE.length) sampleRate = FREQ_TABLE[freqIdx];
                            channelCount = (audioCodecConfig[1] >> 3) & 0x0F;
                        }
                    } else if (aacPacketType === 1) {
                        audioSamples.push({
                            offset: tagDataOffset + 2,
                            size: dataSize - 2,
                            timestamp: timestamp / 1000,
                            duration: 1024 / sampleRate,
                            isKeyframe: true,
                            data: buf.slice(tagDataOffset + 2, tagDataOffset + dataSize),
                        });
                    }
                } else if (soundFormat === 2) {
                    // MP3: the 2-bit FLV soundRate field cannot express 48 kHz,
                    // so read the real rate from the MPEG frame header.
                    audioCodec = 'mp3';
                    const sync0 = buf[tagDataOffset + 1];
                    const sync1 = buf[tagDataOffset + 2];
                    const hdr2 = buf[tagDataOffset + 3];
                    if (sync0 === 0xFF && (sync1 & 0xE0) === 0xE0) {
                        const versionBits = (sync1 >> 3) & 3;
                        const srIdx = (hdr2 >> 2) & 3;
                        if (srIdx !== 3 && versionBits !== 1) {
                            const mpeg1Rate = [44100, 48000, 32000][srIdx];
                            sampleRate = versionBits === 3 ? mpeg1Rate : versionBits === 2 ? mpeg1Rate / 2 : mpeg1Rate / 4;
                        }
                        channelCount = (((buf[tagDataOffset + 4] >> 6) & 3) === 3) ? 1 : 2;
                    }
                    audioSamples.push({
                        offset: tagDataOffset + 1,
                        size: dataSize - 1,
                        timestamp: timestamp / 1000,
                        duration: 1152 / sampleRate,
                        isKeyframe: true,
                        data: buf.slice(tagDataOffset + 1, tagDataOffset + dataSize),
                    });
                }
            }

            pos = tagDataOffset + dataSize;
        }

        // Fill in durations for video samples
        for (let i = 0; i < videoSamples.length - 1; i++) {
            videoSamples[i].duration = videoSamples[i + 1].timestamp - videoSamples[i].timestamp;
        }
        if (videoSamples.length > 1) {
            videoSamples[videoSamples.length - 1].duration = videoSamples[videoSamples.length - 2].duration;
        }

        const totalDuration = videoSamples.length > 0
            ? videoSamples[videoSamples.length - 1].timestamp + videoSamples[videoSamples.length - 1].duration
            : audioSamples.length > 0
                ? audioSamples[audioSamples.length - 1].timestamp + audioSamples[audioSamples.length - 1].duration
                : 0;

        const result: MP4DemuxResult = { videoTracks: [], audioTracks: [] };

        if (videoSamples.length > 0) {
            result.videoTracks.push({
                codec: videoCodec,
                width: width || 1920,
                height: height || 1080,
                sampleRate: 0,
                channelCount: 0,
                duration: totalDuration,
                samples: videoSamples,
                codecConfig: videoCodecConfig,
            });
        }

        if (audioSamples.length > 0) {
            result.audioTracks.push({
                codec: audioCodec,
                width: 0,
                height: 0,
                sampleRate,
                channelCount,
                duration: totalDuration,
                samples: audioSamples,
                codecConfig: audioCodecConfig,
            });
        }

        logger.info(`[FLVDemuxer] video=${videoSamples.length} samples, audio=${audioSamples.length} samples`);
        return result;
    }

    private parseAvcC(avcC: Uint8Array): { width: number; height: number } | null {
        if (avcC.length < 8) return null;
        // AVCDecoderConfigurationRecord
        const numSPS = avcC[5] & 0x1F;
        if (numSPS === 0) return null;
        const spsLen = (avcC[6] << 8) | avcC[7];
        if (avcC.length < 8 + spsLen) return null;
        const sps = avcC.subarray(8, 8 + spsLen);
        return this.parseSPSDimensions(sps);
    }

    private parseSPSDimensions(sps: Uint8Array): { width: number; height: number } | null {
        if (sps.length < 4) return null;
        // Very simplified SPS parser — just get pic_width/height_in_mbs
        // For a robust implementation, would need full exp-golomb parsing
        // For now, return null and let the pipeline use defaults
        return null;
    }
}
