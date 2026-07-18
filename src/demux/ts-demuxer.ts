import type { Source } from '../types/io';
import { DemuxError } from '../core/errors';
import { logger } from '../core/logger';
import type { MP4Sample, MP4DemuxResult } from './mp4-demuxer';

const TS_PACKET = 188;
const FREQ_TABLE = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

export class TSDemuxer {
    async demux(input: File | Blob | Source): Promise<MP4DemuxResult> {
        const buf = input instanceof Blob
            ? new Uint8Array(await input.arrayBuffer())
            : await input.read(0, (input as { size?: number }).size ?? 0);

        // Find sync byte
        let syncOff = -1;
        for (let i = 0; i < Math.min(buf.length, 1024); i++) {
            if (buf[i] === 0x47 && i + TS_PACKET < buf.length && buf[i + TS_PACKET] === 0x47) {
                syncOff = i;
                break;
            }
        }
        if (syncOff < 0) {
            throw new DemuxError('MPEG-TS sync byte (0x47) not found in the first 1KB');
        }

        let pmtPid = -1;
        let videoPid = -1;
        let audioPid = -1;
        let videoStreamType = 0;
        let audioStreamType = 0;

        // First pass: find PAT/PMT to determine PIDs
        for (let pos = syncOff; pos + TS_PACKET <= buf.length; pos += TS_PACKET) {
            if (buf[pos] !== 0x47) continue;
            if (videoPid >= 0 && audioPid >= 0) break;

            const pid = ((buf[pos + 1] & 0x1F) << 8) | buf[pos + 2];
            const payloadStart = !!(buf[pos + 1] & 0x40);
            const hasAdapt = !!(buf[pos + 3] & 0x20);
            const hasPayload = !!(buf[pos + 3] & 0x10);

            let payloadOff = pos + 4;
            if (hasAdapt) payloadOff += 1 + buf[payloadOff];
            if (!hasPayload || payloadOff >= pos + TS_PACKET) continue;

            const payload = buf.subarray(payloadOff, pos + TS_PACKET);

            if (pid === 0 && payloadStart && payload.length > 1) {
                const ptr = payload[0];
                const sect = payload.subarray(1 + ptr);
                if (sect.length >= 12) {
                    pmtPid = ((sect[10] & 0x1F) << 8) | sect[11];
                }
            } else if (pid === pmtPid && payloadStart && payload.length > 1) {
                const ptr = payload[0];
                const sect = payload.subarray(1 + ptr);
                if (sect.length >= 12) {
                    const progInfoLen = ((sect[10] & 0x0F) << 8) | sect[11];
                    let off = 12 + progInfoLen;
                    const sectionLen = ((sect[1] & 0x0F) << 8) | sect[2];
                    const endOff = Math.min(3 + sectionLen - 4, sect.length);
                    while (off + 5 <= endOff) {
                        const sType = sect[off];
                        const sPid = ((sect[off + 1] & 0x1F) << 8) | sect[off + 2];
                        const esInfoLen = ((sect[off + 3] & 0x0F) << 8) | sect[off + 4];
                        const descriptors = sect.subarray(off + 5, off + 5 + esInfoLen);
                        const privateAudioType = sType === 0x06 ? this.resolvePrivateAudioStreamType(descriptors) : 0;

                        if ((sType === 0x1B || sType === 0x24) && videoPid < 0) {
                            videoPid = sPid;
                            videoStreamType = sType;
                        } else if ((sType === 0x0F || sType === 0x11 || sType === 0x03 || sType === 0x04 || sType === 0x81 || sType === 0x87 || privateAudioType !== 0) && audioPid < 0) {
                            audioPid = sPid;
                            audioStreamType = privateAudioType || sType;
                        }
                        off += 5 + esInfoLen;
                    }
                }
            }
        }

        // Second pass: collect PES packets, storing actual data
        interface PESEntry { pts: number; data: Uint8Array; }
        const videoPES: PESEntry[] = [];
        const audioPES: PESEntry[] = [];

        // Current accumulation buffers
        let curVideoChunks: Uint8Array[] = [];
        let curVideoSize = 0;
        let curVideoPts = 0;
        let lastVideoPts = -1;
        let lastAudioPts = -1;
        let wrapBase = 0;
        const PTS_WRAP = 2 ** 33;
        const PTS_HALF_RANGE = 2 ** 32;
        let curAudioChunks: Uint8Array[] = [];
        let curAudioSize = 0;
        let curAudioPts = 0;

        const flushVideo = () => {
            if (curVideoChunks.length > 0) {
                const merged = new Uint8Array(curVideoSize);
                let off = 0;
                for (const c of curVideoChunks) { merged.set(c, off); off += c.length; }
                videoPES.push({ pts: curVideoPts, data: merged });
                curVideoChunks = []; curVideoSize = 0;
            }
        };

        const flushAudio = () => {
            if (curAudioChunks.length > 0) {
                const merged = new Uint8Array(curAudioSize);
                let off = 0;
                for (const c of curAudioChunks) { merged.set(c, off); off += c.length; }
                audioPES.push({ pts: curAudioPts, data: merged });
                curAudioChunks = []; curAudioSize = 0;
            }
        };

        for (let pos = syncOff; pos + TS_PACKET <= buf.length; pos += TS_PACKET) {
            if (buf[pos] !== 0x47) continue;
            const pid = ((buf[pos + 1] & 0x1F) << 8) | buf[pos + 2];
            if (pid !== videoPid && pid !== audioPid) continue;

            const payloadStart = !!(buf[pos + 1] & 0x40);
            const hasAdapt = !!(buf[pos + 3] & 0x20);
            const hasPayload = !!(buf[pos + 3] & 0x10);

            let payloadOff = pos + 4;
            if (hasAdapt) payloadOff += 1 + buf[payloadOff];
            if (!hasPayload || payloadOff >= pos + TS_PACKET) continue;

            const payload = buf.subarray(payloadOff, pos + TS_PACKET);

            if (payloadStart) {
                // New PES packet — flush previous
                if (pid === videoPid) flushVideo();
                else flushAudio();

                // Parse PES header
                if (payload.length >= 9 && payload[0] === 0 && payload[1] === 0 && payload[2] === 1) {
                    const ptsFlag = !!(payload[7] & 0x80);
                    const pesHdrLen = payload[8];
                    let pts = 0;
                    if (ptsFlag && payload.length >= 14) {
                        pts = this.readPTS(payload, 9);
                        // 33-bit PTS wraps every ~26.5 h; unwrap against the last seen value.
                        const last = pid === videoPid ? lastVideoPts : lastAudioPts;
                        if (last >= 0) {
                            let unwrapped = pts + wrapBase;
                            while (unwrapped < last - PTS_HALF_RANGE) unwrapped += PTS_WRAP;
                            if (unwrapped - wrapBase !== pts) wrapBase = unwrapped - pts;
                            pts = unwrapped;
                        } else {
                            pts += wrapBase;
                        }
                        if (pid === videoPid) lastVideoPts = pts; else lastAudioPts = pts;
                    }
                    const dataStart = 9 + pesHdrLen;
                    if (dataStart < payload.length) {
                        const data = payload.subarray(dataStart);
                        if (pid === videoPid) {
                            curVideoPts = pts / 90000;
                            curVideoChunks = [new Uint8Array(data)];
                            curVideoSize = data.length;
                        } else {
                            curAudioPts = pts / 90000;
                            curAudioChunks = [new Uint8Array(data)];
                            curAudioSize = data.length;
                        }
                    }
                }
            } else {
                // Continuation packet
                const copy = new Uint8Array(payload);
                if (pid === videoPid) {
                    curVideoChunks.push(copy);
                    curVideoSize += copy.length;
                } else {
                    curAudioChunks.push(copy);
                    curAudioSize += copy.length;
                }
            }
        }
        flushVideo();
        flushAudio();

        // Build samples with embedded data
        const videoSamples: MP4Sample[] = [];
        const audioSamples: MP4Sample[] = [];

        for (let i = 0; i < videoPES.length; i++) {
            const isKey = videoStreamType === 0x24
                ? this.isH265Keyframe(videoPES[i].data)
                : this.isH264Keyframe(videoPES[i].data);
            videoSamples.push({
                offset: 0,
                size: videoPES[i].data.length,
                timestamp: videoPES[i].pts,
                duration: i < videoPES.length - 1 ? videoPES[i + 1].pts - videoPES[i].pts : 1 / 30,
                isKeyframe: isKey,
                data: videoPES[i].data,
            });
        }

        let audioCodec = 'mp3';
        let sampleRate = 48000, channelCount = 2;
        let audioCodecConfig: Uint8Array | undefined;

        for (let i = 0; i < audioPES.length; i++) {
            const parsed = this.splitAudioFrames(audioStreamType, audioPES[i].data);
            audioCodec = parsed.codec;
            sampleRate = parsed.sampleRate;
            channelCount = parsed.channelCount;
            if (!audioCodecConfig && parsed.codecConfig) audioCodecConfig = parsed.codecConfig;

            let framePts = audioPES[i].pts;
            for (const frame of parsed.frames) {
                audioSamples.push({
                    offset: 0,
                    size: frame.data.length,
                    timestamp: framePts,
                    duration: frame.duration,
                    isKeyframe: true,
                    data: frame.data,
                });
                framePts += frame.duration;
            }
        }

        const totalDuration = videoSamples.length > 0
            ? videoSamples[videoSamples.length - 1].timestamp + videoSamples[videoSamples.length - 1].duration
            : audioSamples.length > 0
                ? audioSamples[audioSamples.length - 1].timestamp + audioSamples[audioSamples.length - 1].duration
                : 0;

        const result: MP4DemuxResult = { videoTracks: [], audioTracks: [] };

        if (videoSamples.length > 0) {
            result.videoTracks.push({
                codec: videoStreamType === 0x24 ? 'hev1.1.6.L93.B0' : 'avc1.640028',
                width: 1920, height: 1080,
                sampleRate: 0, channelCount: 0,
                duration: totalDuration,
                samples: videoSamples,
            });
        }

        if (audioSamples.length > 0) {
            result.audioTracks.push({
                codec: audioCodec,
                width: 0, height: 0,
                sampleRate, channelCount,
                duration: totalDuration,
                samples: audioSamples,
                codecConfig: audioCodecConfig,
            });
        }

        logger.info(`[TSDemuxer] video=${videoSamples.length}, audio=${audioSamples.length}`);
        return result;
    }

    private readPTS(buf: Uint8Array, off: number): number {
        // 33-bit value; must not be truncated to 32 bits (wraps after ~13 hours).
        return ((buf[off] >> 1) & 7) * 0x100000000 +
            (((buf[off + 1] << 22) | ((buf[off + 2] >> 1) << 15) |
                (buf[off + 3] << 7) | (buf[off + 4] >> 1)) >>> 0);
    }

    private isH264Keyframe(data: Uint8Array): boolean {
        for (let i = 0; i < data.length - 4; i++) {
            if (data[i] === 0 && data[i + 1] === 0) {
                let nalOff = -1;
                if (data[i + 2] === 1) nalOff = i + 3;
                else if (data[i + 2] === 0 && data[i + 3] === 1) nalOff = i + 4;
                if (nalOff >= 0 && nalOff < data.length) {
                    const nalType = data[nalOff] & 0x1F;
                    if (nalType === 5) return true;
                }
            }
        }
        return false;
    }

    private isH265Keyframe(data: Uint8Array): boolean {
        for (let i = 0; i < data.length - 5; i++) {
            if (data[i] === 0 && data[i + 1] === 0) {
                let nalOff = -1;
                if (data[i + 2] === 1) nalOff = i + 3;
                else if (data[i + 2] === 0 && data[i + 3] === 1) nalOff = i + 4;
                if (nalOff >= 0 && nalOff < data.length) {
                    const nalType = (data[nalOff] >> 1) & 0x3F;
                    if (nalType === 19 || nalType === 20 || nalType === 21) return true;
                }
            }
        }
        return false;
    }

    private resolvePrivateAudioStreamType(descriptors: Uint8Array): number {
        let offset = 0;
        while (offset + 2 <= descriptors.length) {
            const tag = descriptors[offset];
            const length = descriptors[offset + 1];
            const end = offset + 2 + length;
            if (end > descriptors.length) break;
            if (tag === 0x6A) return 0x81;
            if (tag === 0x7A) return 0x87;
            if (tag === 0x05 && length >= 4) {
                const registration = String.fromCharCode(
                    descriptors[offset + 2],
                    descriptors[offset + 3],
                    descriptors[offset + 4],
                    descriptors[offset + 5],
                );
                if (registration === 'AC-3') return 0x81;
                if (registration === 'EAC3') return 0x87;
            }
            offset = end;
        }
        return 0;
    }

    private splitAudioFrames(streamType: number, data: Uint8Array): {
        codec: string;
        sampleRate: number;
        channelCount: number;
        codecConfig?: Uint8Array;
        frames: { data: Uint8Array; duration: number }[];
    } {
        if (streamType === 0x0F || streamType === 0x11) return this.splitAdtsFrames(data);
        if (streamType === 0x81 || streamType === 0x87) return this.splitAc3Frames(streamType, data);
        return this.splitMpegAudioFrames(data);
    }

    /** Split a PES payload into raw AAC frames (a PES usually carries several ADTS frames). */
    private splitAdtsFrames(data: Uint8Array): {
        codec: string; sampleRate: number; channelCount: number;
        codecConfig?: Uint8Array; frames: { data: Uint8Array; duration: number }[];
    } {
        let sampleRate = 48000;
        let channelCount = 2;
        const frames: { data: Uint8Array; duration: number }[] = [];
        let pos = 0;
        while (pos + 7 <= data.length) {
            if (data[pos] !== 0xFF || (data[pos + 1] & 0xF0) !== 0xF0) {
                pos++;
                continue;
            }
            const freqIdx = (data[pos + 2] >> 2) & 0x0F;
            if (freqIdx < FREQ_TABLE.length) sampleRate = FREQ_TABLE[freqIdx];
            channelCount = ((data[pos + 2] & 0x01) << 2) | ((data[pos + 3] >> 6) & 0x03) || channelCount;
            const frameLength = ((data[pos + 3] & 0x03) << 11) | (data[pos + 4] << 3) | (data[pos + 5] >> 5);
            if (frameLength < 7 || pos + frameLength > data.length) break;
            const headerLen = (data[pos + 1] & 0x01) ? 7 : 9;
            frames.push({
                data: data.subarray(pos + headerLen, pos + frameLength),
                duration: 1024 / sampleRate,
            });
            pos += frameLength;
        }
        if (frames.length === 0) frames.push({ data, duration: 1024 / sampleRate });
        return {
            codec: 'mp4a.40.2',
            sampleRate,
            channelCount,
            codecConfig: this.buildAudioSpecificConfig(sampleRate, channelCount),
            frames,
        };
    }

    /** Split MPEG-1 audio (Layer I/II/III) into frames using header-derived sizes. */
    private splitMpegAudioFrames(data: Uint8Array): {
        codec: string; sampleRate: number; channelCount: number;
        frames: { data: Uint8Array; duration: number }[];
    } {
        const RATES = [44100, 48000, 32000];
        const BR_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
        const BR_L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
        const BR_L1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448];
        let codec = 'mp3';
        let sampleRate = 44100;
        let channelCount = 2;
        const frames: { data: Uint8Array; duration: number }[] = [];
        let pos = 0;
        while (pos + 4 <= data.length) {
            if (data[pos] !== 0xFF || (data[pos + 1] & 0xE0) !== 0xE0) {
                pos++;
                continue;
            }
            const versionBits = (data[pos + 1] >> 3) & 3;
            const layerBits = (data[pos + 1] >> 1) & 3;
            const brIdx = (data[pos + 2] >> 4) & 0x0F;
            const srIdx = (data[pos + 2] >> 2) & 3;
            if (versionBits !== 3 || layerBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) {
                pos++;
                continue;
            }
            sampleRate = RATES[srIdx];
            codec = layerBits === 3 ? 'mp1' : (layerBits === 2 ? 'mp2' : 'mp3');
            channelCount = ((data[pos + 3] >> 6) & 3) === 3 ? 1 : 2;
            const padding = (data[pos + 2] >> 1) & 1;
            let frameBytes: number;
            let samplesPerFrame: number;
            if (layerBits === 3) { // Layer I
                frameBytes = (Math.floor(12000 * BR_L1[brIdx] / sampleRate) + padding) * 4;
                samplesPerFrame = 384;
            } else { // Layer II / III
                const bitrate = layerBits === 2 ? BR_L2[brIdx] : BR_L3[brIdx];
                frameBytes = Math.floor(144000 * bitrate / sampleRate) + padding;
                samplesPerFrame = 1152;
            }
            if (frameBytes < 4 || pos + frameBytes > data.length) break;
            frames.push({
                data: data.subarray(pos, pos + frameBytes),
                duration: samplesPerFrame / sampleRate,
            });
            pos += frameBytes;
        }
        if (frames.length === 0) frames.push({ data, duration: 1152 / sampleRate });
        return { codec, sampleRate, channelCount, frames };
    }

    /** Split (E-)AC-3 by scanning for syncwords; parameters from the first frame. */
    private splitAc3Frames(streamType: number, data: Uint8Array): {
        codec: string; sampleRate: number; channelCount: number;
        frames: { data: Uint8Array; duration: number }[];
    } {
        const info = streamType === 0x87 ? this.parseEac3FrameInfo(data) : this.parseAc3FrameInfo(data);
        const duration = 1536 / info.sampleRate;
        const starts: number[] = [];
        for (let i = 0; i + 1 < data.length; i++) {
            if (data[i] === 0x0B && data[i + 1] === 0x77) starts.push(i);
        }
        const frames: { data: Uint8Array; duration: number }[] = [];
        for (let i = 0; i < starts.length; i++) {
            const end = i + 1 < starts.length ? starts[i + 1] : data.length;
            frames.push({ data: data.subarray(starts[i], end), duration });
        }
        if (frames.length === 0) frames.push({ data, duration });
        return {
            codec: streamType === 0x87 ? 'ec-3' : 'ac-3',
            sampleRate: info.sampleRate,
            channelCount: info.channelCount,
            frames,
        };
    }

    private parseAc3FrameInfo(data: Uint8Array): { sampleRate: number; channelCount: number } {
        const sampleRates = [48000, 44100, 32000];
        const channelTable = [2, 1, 2, 3, 3, 4, 4, 5];
        if (data.length < 7 || data[0] !== 0x0B || data[1] !== 0x77) {
            return { sampleRate: 48000, channelCount: 2 };
        }
        const fscod = data[4] >> 6;
        const acmod = (data[6] >> 5) & 0x07;
        const lfeon = (data[6] >> 4) & 0x01;
        return {
            sampleRate: sampleRates[fscod] ?? 48000,
            channelCount: (channelTable[acmod] ?? 2) + lfeon,
        };
    }

    private parseEac3FrameInfo(data: Uint8Array): { sampleRate: number; channelCount: number } {
        const sampleRates = [48000, 44100, 32000];
        const reducedSampleRates = [24000, 22050, 16000];
        const channelTable = [2, 1, 2, 3, 3, 4, 4, 5];
        if (data.length < 7 || data[0] !== 0x0B || data[1] !== 0x77) {
            return { sampleRate: 48000, channelCount: 2 };
        }
        const fscod = data[4] >> 6;
        const fscod2 = (data[4] >> 4) & 0x03;
        const acmod = (data[6] >> 1) & 0x07;
        const lfeon = data[6] & 0x01;
        const sampleRate = fscod === 0x03
            ? (reducedSampleRates[fscod2] ?? 24000)
            : (sampleRates[fscod] ?? 48000);
        return {
            sampleRate,
            channelCount: (channelTable[acmod] ?? 2) + lfeon,
        };
    }

    private buildAudioSpecificConfig(sampleRate: number, channels: number): Uint8Array {
        const srIdx = FREQ_TABLE.indexOf(sampleRate);
        const freqIdx = srIdx >= 0 ? srIdx : 4;
        const asc = new Uint8Array(2);
        asc[0] = (2 << 3) | ((freqIdx >> 1) & 0x07);
        asc[1] = ((freqIdx & 1) << 7) | (channels << 3);
        return asc;
    }
}
