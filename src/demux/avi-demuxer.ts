import type { Source } from '../types/io';
import { DemuxError } from '../core/errors';
import { logger } from '../core/logger';
import type { MP4Sample, MP4DemuxResult } from './mp4-demuxer';

export class AVIDemuxer {
    async demux(input: File | Blob | Source): Promise<MP4DemuxResult> {
        const buf = input instanceof Blob
            ? new Uint8Array(await input.arrayBuffer())
            : await input.read(0, (input as { size?: number }).size ?? 0);

        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

        // Verify RIFF header
        if (buf.length < 12 || this.fourcc(buf, 0) !== 'RIFF' || this.fourcc(buf, 8) !== 'AVI ') {
            throw new DemuxError('Not an AVI file');
        }

        let videoCodec = '';
        let width = 0, height = 0, fps = 30;
        let audioFormat = 0, sampleRate = 44100, channelCount = 2, bitsPerSample = 16, blockAlign = 4;
        let codecConfig: Uint8Array | undefined;

        const videoSamples: MP4Sample[] = [];
        const audioSamples: MP4Sample[] = [];

        // Parse AVI structure
        let pos = 12;
        while (pos + 8 <= buf.length) {
            const ckId = this.fourcc(buf, pos);
            const ckSize = dv.getUint32(pos + 4, true);

            if (ckId === 'LIST') {
                const listType = this.fourcc(buf, pos + 8);

                if (listType === 'hdrl') {
                    // Parse header list
                    this.parseHdrl(buf, dv, pos + 12, pos + 8 + ckSize, (info) => {
                        if (info.type === 'video') {
                            videoCodec = info.codec;
                            width = info.width;
                            height = info.height;
                            fps = info.fps;
                        } else if (info.type === 'audio') {
                            audioFormat = info.audioFormat;
                            sampleRate = info.sampleRate;
                            channelCount = info.channelCount;
                            bitsPerSample = info.bitsPerSample;
                            blockAlign = info.blockAlign;
                        }
                    });
                } else if (listType === 'movi') {
                    // Parse movi data chunks
                    let moviPos = pos + 12;
                    const moviEnd = pos + 8 + ckSize;
                    let videoIdx = 0;

                    while (moviPos + 8 <= moviEnd) {
                        const chunkId = this.fourcc(buf, moviPos);
                        const chunkSize = dv.getUint32(moviPos + 4, true);
                        const dataOff = moviPos + 8;

                        if (chunkId === '00dc' || chunkId === '00db') {
                            // Video chunk (compressed or uncompressed)
                            videoSamples.push({
                                offset: dataOff,
                                size: chunkSize,
                                timestamp: videoIdx / fps,
                                duration: 1 / fps,
                                isKeyframe: chunkId === '00db' || this.isKeyframe(buf, dataOff, chunkSize, videoCodec),
                                data: buf.slice(dataOff, dataOff + chunkSize),
                            });
                            videoIdx++;
                        } else if (chunkId === '01wb') {
                            // Audio chunk
                            const audioTs = audioSamples.length > 0
                                ? audioSamples[audioSamples.length - 1].timestamp + audioSamples[audioSamples.length - 1].duration
                                : 0;
                            const numFrames = blockAlign > 0 ? chunkSize / blockAlign : chunkSize / (channelCount * (bitsPerSample / 8));
                            const duration = numFrames / sampleRate;
                            audioSamples.push({
                                offset: dataOff,
                                size: chunkSize,
                                timestamp: audioTs,
                                duration,
                                isKeyframe: true,
                                data: buf.slice(dataOff, dataOff + chunkSize),
                            });
                        } else if (chunkId === 'LIST') {
                            // Nested list (rec ), skip to inner chunks
                            const innerType = this.fourcc(buf, moviPos + 8);
                            if (innerType === 'rec ') {
                                moviPos += 12; // Skip LIST + 'rec ' header, continue inner
                                continue;
                            }
                        }

                        moviPos = dataOff + chunkSize + (chunkSize & 1); // Pad to even
                    }
                }
            }

            pos += 8 + ckSize + (ckSize & 1); // Pad to even
        }

        const totalDuration = videoSamples.length > 0
            ? videoSamples[videoSamples.length - 1].timestamp + videoSamples[videoSamples.length - 1].duration
            : audioSamples.length > 0
                ? audioSamples[audioSamples.length - 1].timestamp + audioSamples[audioSamples.length - 1].duration
                : 0;

        const result: MP4DemuxResult = { videoTracks: [], audioTracks: [] };

        if (videoSamples.length > 0) {
            const codec = this.mapVideoCodec(videoCodec);
            result.videoTracks.push({
                codec,
                width: width || 1920,
                height: height || 1080,
                sampleRate: 0,
                channelCount: 0,
                duration: totalDuration,
                samples: videoSamples,
                codecConfig,
            });
        }

        if (audioSamples.length > 0) {
            const codec = audioFormat === 1 ? 'pcm' : audioFormat === 0x00FF ? 'mp4a.40.2' : 'mp3';
            result.audioTracks.push({
                codec,
                width: 0,
                height: 0,
                sampleRate,
                channelCount,
                duration: totalDuration,
                samples: audioSamples,
            });
        }

        logger.info(`[AVIDemuxer] video=${videoSamples.length}, audio=${audioSamples.length}`);
        return result;
    }

    private fourcc(buf: Uint8Array, off: number): string {
        return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
    }

    private parseHdrl(
        buf: Uint8Array, dv: DataView, start: number, end: number,
        cb: (info: StreamInfo) => void,
    ): void {
        let pos = start;

        while (pos + 8 <= end) {
            const ckId = this.fourcc(buf, pos);
            const ckSize = dv.getUint32(pos + 4, true);

            if (ckId === 'avih') {
                // Main AVI header — skip, we get info from stream headers
            } else if (ckId === 'LIST') {
                const listType = this.fourcc(buf, pos + 8);
                if (listType === 'strl') {
                    this.parseStrl(buf, dv, pos + 12, pos + 8 + ckSize, cb);
                }
            }

            pos += 8 + ckSize + (ckSize & 1);
        }
    }

    private parseStrl(
        buf: Uint8Array, dv: DataView, start: number, end: number,
        cb: (info: StreamInfo) => void,
    ): void {
        let pos = start;
        let strhType = '';
        let fccHandler = '';
        let rate = 0, scale = 0;

        while (pos + 8 <= end) {
            const ckId = this.fourcc(buf, pos);
            const ckSize = dv.getUint32(pos + 4, true);
            const data = pos + 8;

            if (ckId === 'strh' && ckSize >= 48) {
                strhType = this.fourcc(buf, data);
                fccHandler = this.fourcc(buf, data + 4);
                scale = dv.getUint32(data + 20, true);
                rate = dv.getUint32(data + 24, true);
            } else if (ckId === 'strf') {
                if (strhType === 'vids' && ckSize >= 40) {
                    const w = dv.getInt32(data + 4, true);
                    const h = Math.abs(dv.getInt32(data + 8, true));
                    const codec = this.fourcc(buf, data + 16);
                    const fps = scale > 0 ? rate / scale : 30;
                    cb({
                        type: 'video', codec: codec || fccHandler, width: w, height: h, fps,
                        audioFormat: 0, sampleRate: 0, channelCount: 0, bitsPerSample: 0, blockAlign: 0
                    });
                } else if (strhType === 'auds' && ckSize >= 14) {
                    const audioFmt = dv.getUint16(data, true);
                    const ch = dv.getUint16(data + 2, true);
                    const sr = dv.getUint32(data + 4, true);
                    const ba = dv.getUint16(data + 12, true);
                    const bps = ckSize >= 16 ? dv.getUint16(data + 14, true) : 16;
                    cb({
                        type: 'audio', codec: '', width: 0, height: 0, fps: 0,
                        audioFormat: audioFmt, sampleRate: sr, channelCount: ch, bitsPerSample: bps, blockAlign: ba
                    });
                }
            }

            pos += 8 + ckSize + (ckSize & 1);
        }
    }

    private mapVideoCodec(fourcc: string): string {
        const uc = fourcc.toUpperCase().trim();
        if (uc === 'H264' || uc === 'X264' || uc === 'AVC1') return 'avc1.640028';
        if (uc === 'HEVC' || uc === 'H265' || uc === 'HVC1') return 'hev1.1.6.L93.B0';
        if (uc === 'VP8\0' || uc === 'VP80') return 'vp8';
        if (uc === 'VP9\0' || uc === 'VP90') return 'vp9';
        if (uc === 'MJPG') return 'mjpeg';
        // Default to H.264 — many AVI files use it
        return 'avc1.640028';
    }

    private isKeyframe(buf: Uint8Array, offset: number, size: number, codec: string): boolean {
        if (size < 5) return false;
        const mapped = this.mapVideoCodec(codec);
        if (mapped.startsWith('avc')) {
            // Check for AnnexB start code + IDR NAL type
            for (let i = offset; i < offset + Math.min(size, 32) - 4; i++) {
                if (buf[i] === 0 && buf[i + 1] === 0) {
                    let nalOff = -1;
                    if (buf[i + 2] === 1) nalOff = i + 3;
                    else if (buf[i + 2] === 0 && buf[i + 3] === 1) nalOff = i + 4;
                    if (nalOff >= 0 && nalOff < offset + size) {
                        const nalType = buf[nalOff] & 0x1F;
                        if (nalType === 5) return true;
                    }
                }
            }
        }
        return false;
    }
}

interface StreamInfo {
    type: 'video' | 'audio';
    codec: string;
    width: number;
    height: number;
    fps: number;
    audioFormat: number;
    sampleRate: number;
    channelCount: number;
    bitsPerSample: number;
    blockAlign: number;
}
