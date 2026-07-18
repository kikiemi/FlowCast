import { BlobSource } from '../io/sources';
import type { Source } from '../types/io';
import { DemuxError } from '../core/errors';
import { logger } from '../core/logger';

export interface MP4TrackInfo {
    codec: string;
    width: number;
    height: number;
    displayWidth?: number;
    displayHeight?: number;
    pixelAspectRatioNum?: number;
    pixelAspectRatioDen?: number;
    sampleRate: number;
    channelCount: number;
    duration: number;
    samples: MP4Sample[];
    codecConfig?: Uint8Array;
    timescale?: number;
}

export interface MP4Sample {
    offset: number;
    size: number;
    timestamp: number;
    duration: number;
    isKeyframe: boolean;
    decodeTimestamp?: number;
    compositionTimeOffset?: number;
    data?: Uint8Array;
}

export interface MP4DemuxResult {
    videoTracks: MP4TrackInfo[];
    audioTracks: MP4TrackInfo[];
}

function readU32(d: DataView, o: number): number { return d.getUint32(o, false); }
function readU16(d: DataView, o: number): number { return d.getUint16(o, false); }
function ascii(buf: Uint8Array, o: number, len: number): string {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(buf[o + i]);
    return s;
}

interface Box { type: string; offset: number; size: number; }

function findBoxes(buf: Uint8Array, start: number, end: number): Box[] {
    const boxes: Box[] = [];
    let pos = start;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    while (pos + 8 <= end) {
        let size = dv.getUint32(pos, false);
        const type = ascii(buf, pos + 4, 4);
        if (size === 0) size = end - pos;
        if (size < 8) break;
        boxes.push({ type, offset: pos, size });
        pos += size;
    }
    return boxes;
}

function findBox(buf: Uint8Array, start: number, end: number, type: string): Box | null {
    return findBoxes(buf, start, end).find(b => b.type === type) ?? null;
}

export class MP4Demuxer {
    private source!: Source;

    async demux(input: File | Blob | Source): Promise<MP4DemuxResult> {
        if (input instanceof Blob) {
            this.source = new BlobSource(input);
        } else {
            this.source = input;
        }

        const moovBuf = await this.findMoov();
        if (!moovBuf) throw new DemuxError('No moov box found');

        const dv = new DataView(moovBuf.buffer, moovBuf.byteOffset, moovBuf.byteLength);
        const result: MP4DemuxResult = { videoTracks: [], audioTracks: [] };
        const traks = findBoxes(moovBuf, 8, moovBuf.length).filter(b => b.type === 'trak');

        // Track ID → track index mapping for fragments
        const trackIdMap = new Map<number, { isVideo: boolean; idx: number }>();
        let prevVCount = 0, prevACount = 0;

        for (const trak of traks) {
            try {
                const trackId = this.getTrackId(moovBuf, dv, trak);
                this.parseTrak(moovBuf, dv, trak, result);

                if (trackId > 0) {
                    if (result.videoTracks.length > prevVCount) {
                        trackIdMap.set(trackId, { isVideo: true, idx: result.videoTracks.length - 1 });
                    } else if (result.audioTracks.length > prevACount) {
                        trackIdMap.set(trackId, { isVideo: false, idx: result.audioTracks.length - 1 });
                    }
                }
                prevVCount = result.videoTracks.length;
                prevACount = result.audioTracks.length;
            } catch (e) {
                logger.warn('[MP4Demuxer] Skipping unparseable track:', e);
            }
        }

        // Check if any track has 0 samples (fragmented MP4)
        const hasEmpty = [...result.videoTracks, ...result.audioTracks].some(t => t.samples.length === 0);
        if (hasEmpty) {
            logger.warn('[MP4Demuxer] Empty samples detected, parsing moof fragments...');
            await this.parseFragments(result, trackIdMap);
        }

        return result;
    }

    private getTrackId(buf: Uint8Array, dv: DataView, trak: Box): number {
        const trakS = trak.offset + 8;
        const trakE = trak.offset + trak.size;
        const tkhd = findBox(buf, trakS, trakE, 'tkhd');
        if (!tkhd) return 0;
        const ver = buf[tkhd.offset + 8];
        return ver === 0 ? readU32(dv, tkhd.offset + 20) : readU32(dv, tkhd.offset + 28);
    }

    private async parseFragments(
        result: MP4DemuxResult,
        trackIdMap: Map<number, { isVideo: boolean; idx: number }>,
    ): Promise<void> {
        const fileSize = this.source.size;
        const fullBuf = await this.source.read(0, fileSize);
        const dv = new DataView(fullBuf.buffer, fullBuf.byteOffset, fullBuf.byteLength);

        // Scan for moof boxes
        let pos = 0;
        while (pos + 8 <= fileSize) {
            let boxSize = dv.getUint32(pos, false);
            const boxType = ascii(fullBuf, pos + 4, 4);
            if (boxSize === 0) boxSize = fileSize - pos;
            if (boxSize < 8) break;

            if (boxType === 'moof') {
                const moofStart = pos;
                const moofEnd = pos + boxSize;

                // Find mdat that follows this moof
                let mdatOff = moofEnd;
                if (mdatOff + 8 <= fileSize && ascii(fullBuf, mdatOff + 4, 4) === 'mdat') {
                    mdatOff += 8; // skip mdat header
                }

                // Parse traf boxes inside moof
                const innerBoxes = findBoxes(fullBuf, moofStart + 8, moofEnd);
                for (const traf of innerBoxes.filter(b => b.type === 'traf')) {
                    const trafS = traf.offset + 8;
                    const trafE = traf.offset + traf.size;

                    const tfhd = findBox(fullBuf, trafS, trafE, 'tfhd');
                    if (!tfhd) continue;

                    const tfhdFlags = (fullBuf[tfhd.offset + 9] << 16) |
                        (fullBuf[tfhd.offset + 10] << 8) |
                        fullBuf[tfhd.offset + 11];
                    const trackId = readU32(dv, tfhd.offset + 12);
                    const mapping = trackIdMap.get(trackId);
                    if (!mapping) continue;

                    const track = mapping.isVideo
                        ? result.videoTracks[mapping.idx]
                        : result.audioTracks[mapping.idx];
                    if (!track) continue;

                    // Parse tfhd optional fields
                    let tfhdOff = tfhd.offset + 16;
                    let baseDataOffset = moofStart;
                    if (tfhdFlags & 0x000001) { // base-data-offset-present
                        const hi = readU32(dv, tfhdOff);
                        const lo = readU32(dv, tfhdOff + 4);
                        baseDataOffset = hi * 0x100000000 + lo;
                        tfhdOff += 8;
                    }
                    let defaultSampleDuration = 0;
                    if (tfhdFlags & 0x000008) { // default-sample-duration-present
                        defaultSampleDuration = readU32(dv, tfhdOff);
                        tfhdOff += 4;
                    }
                    let defaultSampleSize = 0;
                    if (tfhdFlags & 0x000010) { // default-sample-size-present
                        defaultSampleSize = readU32(dv, tfhdOff);
                        tfhdOff += 4;
                    }
                    let defaultSampleFlags = 0;
                    if (tfhdFlags & 0x000020) { // default-sample-flags-present
                        defaultSampleFlags = readU32(dv, tfhdOff);
                    }

                    // Parse tfdt for base decode time
                    const tfdt = findBox(fullBuf, trafS, trafE, 'tfdt');
                    let baseDecodeTime = 0;
                    if (tfdt) {
                        const tfdtVer = fullBuf[tfdt.offset + 8];
                        if (tfdtVer === 0) {
                            baseDecodeTime = readU32(dv, tfdt.offset + 12);
                        } else {
                            baseDecodeTime = readU32(dv, tfdt.offset + 12) * 0x100000000 +
                                readU32(dv, tfdt.offset + 16);
                        }
                    }

                    // Parse trun boxes
                    const trunBoxes = findBoxes(fullBuf, trafS, trafE).filter(b => b.type === 'trun');
                    for (const trun of trunBoxes) {
                        const trunFlags = (fullBuf[trun.offset + 9] << 16) |
                            (fullBuf[trun.offset + 10] << 8) |
                            fullBuf[trun.offset + 11];
                        const sampleCount = readU32(dv, trun.offset + 12);
                        let trunOff = trun.offset + 16;

                        let dataOffset = 0;
                        if (trunFlags & 0x000001) { // data-offset-present
                            dataOffset = dv.getInt32(trunOff, false);
                            trunOff += 4;
                        }
                        if (trunFlags & 0x000004) { // first-sample-flags-present
                            trunOff += 4; // skip
                        }

                        const hasDuration = !!(trunFlags & 0x000100);
                        const hasSize = !!(trunFlags & 0x000200);
                        const hasFlags = !!(trunFlags & 0x000400);
                        const hasCTO = !!(trunFlags & 0x000800);

                        let curOffset = (tfhdFlags & 0x000001)
                            ? baseDataOffset + dataOffset
                            : moofStart + dataOffset;
                        let curDts = baseDecodeTime;
                        const timescale = track.timescale || track.sampleRate || 90000;

                        for (let i = 0; i < sampleCount; i++) {
                            const duration = hasDuration ? readU32(dv, trunOff) : defaultSampleDuration;
                            if (hasDuration) trunOff += 4;
                            const size = hasSize ? readU32(dv, trunOff) : defaultSampleSize;
                            if (hasSize) trunOff += 4;
                            const flags = hasFlags ? readU32(dv, trunOff) : defaultSampleFlags;
                            if (hasFlags) trunOff += 4;
                            const cto = hasCTO ? dv.getInt32(trunOff, false) : 0;
                            if (hasCTO) trunOff += 4;

                            const isKeyframe = mapping.isVideo
                                ? (flags & 0x10000) === 0  // sample_is_non_sync_sample
                                : true;

                            // Offsets are absolute file offsets; consumers read on demand,
                            // avoiding a second full copy of the file in sample data.
                            track.samples.push({
                                offset: curOffset,
                                size,
                                timestamp: (curDts + cto) / timescale,
                                decodeTimestamp: curDts / timescale,
                                compositionTimeOffset: cto / timescale,
                                duration: duration / timescale,
                                isKeyframe,
                            });

                            curOffset += size;
                            curDts += duration;
                        }
                    }
                }
            }

            pos += boxSize;
        }

        logger.warn(`[MP4Demuxer] After fragments: video=${result.videoTracks[0]?.samples.length ?? 0}, audio=${result.audioTracks[0]?.samples.length ?? 0}`);
    }

    async readSample(sample: MP4Sample): Promise<Uint8Array>;
    async readSample(input: File | Blob | Source, sample: MP4Sample): Promise<Uint8Array>;
    async readSample(inputOrSample: File | Blob | Source | MP4Sample, maybeSample?: MP4Sample): Promise<Uint8Array> {
        let source: Source;
        let sample: MP4Sample;

        if (maybeSample) {
            sample = maybeSample;
            const inp = inputOrSample;
            if (inp instanceof Blob) {
                source = new BlobSource(inp);
            } else if ('read' in inp) {
                source = inp;
            } else {
                throw new DemuxError('readSample: an MP4Sample cannot be used as the input source');
            }
        } else {
            if (inputOrSample instanceof Blob || 'read' in inputOrSample) {
                throw new DemuxError('readSample: sample argument is missing');
            }
            sample = inputOrSample;
            source = this.source;
        }

        return source.read(sample.offset, sample.size);
    }

    private async findMoov(): Promise<Uint8Array | null> {
        const fileSize = this.source.size;
        let pos = 0;

        while (pos + 8 <= fileSize) {
            const header = await this.source.read(pos, 8);
            const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
            let boxSize = dv.getUint32(0, false);
            const type = ascii(header, 4, 4);

            if (boxSize === 1 && pos + 16 <= fileSize) {
                const ext = await this.source.read(pos + 8, 8);
                const edv = new DataView(ext.buffer, ext.byteOffset, ext.byteLength);
                boxSize = edv.getUint32(0, false) * 0x100000000 + edv.getUint32(4, false);
            }
            if (boxSize === 0) boxSize = fileSize - pos;
            if (boxSize < 8) break;

            if (type === 'moov') {
                return this.source.read(pos, boxSize);
            }

            pos += boxSize;
        }

        return null;
    }

    private parseTrak(buf: Uint8Array, dv: DataView, trak: Box, result: MP4DemuxResult): void {
        const trakS = trak.offset + 8;
        const trakE = trak.offset + trak.size;

        const mdia = findBox(buf, trakS, trakE, 'mdia');
        if (!mdia) return;

        const mdiaS = mdia.offset + 8;
        const mdiaE = mdia.offset + mdia.size;

        const hdlr = findBox(buf, mdiaS, mdiaE, 'hdlr');
        if (!hdlr) return;
        const handlerType = ascii(buf, hdlr.offset + 16, 4);
        const isVideo = handlerType === 'vide';
        const isAudio = handlerType === 'soun';
        if (!isVideo && !isAudio) return;

        const mdhd = findBox(buf, mdiaS, mdiaE, 'mdhd');
        let timescale = 90000;
        let mediaDuration = 0;
        if (mdhd) {
            const ver = buf[mdhd.offset + 8];
            if (ver === 0) {
                timescale = readU32(dv, mdhd.offset + 20);
                mediaDuration = readU32(dv, mdhd.offset + 24);
            } else {
                timescale = readU32(dv, mdhd.offset + 28);
                const hi = readU32(dv, mdhd.offset + 32);
                const lo = readU32(dv, mdhd.offset + 36);
                mediaDuration = hi * 0x100000000 + lo;
            }
        }

        const tkhd = findBox(buf, trakS, trakE, 'tkhd');
        let tkhdDisplayWidth = 0;
        let tkhdDisplayHeight = 0;
        if (tkhd) {
            const tkhdVer = buf[tkhd.offset + 8];
            const payloadStart = tkhd.offset + 12;
            const widthOff = payloadStart + (tkhdVer === 0 ? 72 : 84);
            const heightOff = payloadStart + (tkhdVer === 0 ? 76 : 88);
            if (widthOff + 4 <= tkhd.offset + tkhd.size && heightOff + 4 <= tkhd.offset + tkhd.size) {
                tkhdDisplayWidth = readU32(dv, widthOff) / 65536;
                tkhdDisplayHeight = readU32(dv, heightOff) / 65536;
            }
        }

        const minf = findBox(buf, mdiaS, mdiaE, 'minf');
        if (!minf) return;
        const stbl = findBox(buf, minf.offset + 8, minf.offset + minf.size, 'stbl');
        if (!stbl) return;

        const stblS = stbl.offset + 8;
        const stblE = stbl.offset + stbl.size;

        const stsd = findBox(buf, stblS, stblE, 'stsd');
        if (!stsd) return;

        const entryCount = readU32(dv, stsd.offset + 12);
        if (entryCount < 1) return;
        const entryOffset = stsd.offset + 16;
        const entrySize = readU32(dv, entryOffset);
        const codecFourCC = ascii(buf, entryOffset + 4, 4);

        let codec = '';
        let width = 0, height = 0, sampleRate = 0, channelCount = 0;
        let displayWidth = 0, displayHeight = 0;
        let pixelAspectRatioNum = 1, pixelAspectRatioDen = 1;
        let codecConfig: Uint8Array | undefined;

        if (isVideo) {
            width = readU16(dv, entryOffset + 32);
            height = readU16(dv, entryOffset + 34);

            const pasp = findBox(buf, entryOffset + 86, entryOffset + entrySize, 'pasp');
            if (pasp && pasp.offset + 16 <= entryOffset + entrySize) {
                pixelAspectRatioNum = readU32(dv, pasp.offset + 8);
                pixelAspectRatioDen = readU32(dv, pasp.offset + 12) || 1;
            }

            if (codecFourCC === 'avc1' || codecFourCC === 'avc3') {
                const avcC = findBox(buf, entryOffset + 86, entryOffset + entrySize, 'avcC');
                if (avcC) {
                    codecConfig = buf.slice(avcC.offset + 8, avcC.offset + avcC.size);
                    const profile = codecConfig[1] ?? 0x64;
                    const compat = codecConfig[2] ?? 0x00;
                    const level = codecConfig[3] ?? 0x28;
                    codec = `avc1.${profile.toString(16).padStart(2, '0')}${compat.toString(16).padStart(2, '0')}${level.toString(16).padStart(2, '0')}`;
                } else {
                    codec = 'avc1.640028';
                }
            } else if (codecFourCC === 'hvc1' || codecFourCC === 'hev1') {
                codec = codecFourCC;
                const hvcC = findBox(buf, entryOffset + 86, entryOffset + entrySize, 'hvcC');
                if (hvcC) codecConfig = buf.slice(hvcC.offset + 8, hvcC.offset + hvcC.size);
            } else if (codecFourCC === 'vp08') {
                codec = 'vp8';
            } else if (codecFourCC === 'vp09') {
                codec = 'vp09.00.10.08';
                const vpcC = findBox(buf, entryOffset + 86, entryOffset + entrySize, 'vpcC');
                if (vpcC) codecConfig = buf.slice(vpcC.offset + 8, vpcC.offset + vpcC.size);
            } else if (codecFourCC === 'av01') {
                codec = 'av01.0.01M.08';
                const av1C = findBox(buf, entryOffset + 86, entryOffset + entrySize, 'av1C');
                if (av1C) codecConfig = buf.slice(av1C.offset + 8, av1C.offset + av1C.size);
            } else if (codecFourCC === 'mp4v') {
                codec = 'mp4v.20.9';
            } else if (codecFourCC === 's263' || codecFourCC === 'H263') {
                codec = 's263';
            } else {
                codec = codecFourCC;
            }

            displayWidth = tkhdDisplayWidth > 0 ? tkhdDisplayWidth : width;
            displayHeight = tkhdDisplayHeight > 0 ? tkhdDisplayHeight : height;
            if ((displayWidth <= 0 || displayHeight <= 0) && width > 0 && height > 0) {
                displayWidth = width;
                displayHeight = height;
            }
            if (displayWidth <= 0 && width > 0) displayWidth = width;
            if (displayHeight <= 0 && height > 0) displayHeight = height;
            if (pixelAspectRatioNum > 0 && pixelAspectRatioDen > 0 && width > 0 && height > 0) {
                const paspWidth = width * pixelAspectRatioNum / pixelAspectRatioDen;
                if (!(tkhdDisplayWidth > 0) && Number.isFinite(paspWidth) && paspWidth > 0) {
                    displayWidth = paspWidth;
                    displayHeight = height;
                }
            }
        } else {
            // AudioSampleEntry version decides where extension boxes begin:
            // v0 -> +36, v1 (QuickTime) -> +52, v2 -> +72.
            const audioVersion = readU16(dv, entryOffset + 16);
            const extStart = entryOffset + (audioVersion === 2 ? 72 : audioVersion === 1 ? 52 : 36);
            if (audioVersion === 2 && entryOffset + 52 <= entryOffset + entrySize) {
                sampleRate = Math.round(dv.getFloat64(entryOffset + 40, false)) || 48000;
                channelCount = readU32(dv, entryOffset + 48) || 2;
            } else {
                channelCount = readU16(dv, entryOffset + 24);
                sampleRate = readU16(dv, entryOffset + 32);
            }

            if (codecFourCC === 'mp4a') {
                codec = 'mp4a.40.2';
                const esds = this.findEsds(buf, extStart, entryOffset + entrySize);
                if (esds) {
                    codecConfig = esds;
                    const parsedAsc = this.parseAacAudioSpecificConfig(esds);
                    if (parsedAsc?.sampleRate) sampleRate = parsedAsc.sampleRate;
                    if (parsedAsc?.channelCount) channelCount = parsedAsc.channelCount;
                }
            } else if (codecFourCC === 'Opus') {
                codec = 'opus';
                const dOps = findBox(buf, extStart, entryOffset + entrySize, 'dOps');
                if (dOps) codecConfig = buf.slice(dOps.offset + 8, dOps.offset + dOps.size);
            } else if (codecFourCC === 'ac-3') {
                codec = 'ac-3';
                const dac3 = findBox(buf, extStart, entryOffset + entrySize, 'dac3');
                if (dac3) codecConfig = buf.slice(dac3.offset + 8, dac3.offset + dac3.size);
            } else if (codecFourCC === 'ec-3') {
                codec = 'ec-3';
                const dec3 = findBox(buf, extStart, entryOffset + entrySize, 'dec3');
                if (dec3) codecConfig = buf.slice(dec3.offset + 8, dec3.offset + dec3.size);
            } else if (codecFourCC === 'fLaC') {
                codec = 'flac';
            } else {
                codec = codecFourCC;
            }
        }

        const samples = this.parseSamples(buf, dv, stblS, stblE, timescale);
        const trackDuration = timescale > 0 ? mediaDuration / timescale : 0;

        const track: MP4TrackInfo = {
            codec,
            width,
            height,
            displayWidth: isVideo ? displayWidth : undefined,
            displayHeight: isVideo ? displayHeight : undefined,
            pixelAspectRatioNum: isVideo ? pixelAspectRatioNum : undefined,
            pixelAspectRatioDen: isVideo ? pixelAspectRatioDen : undefined,
            sampleRate,
            channelCount,
            duration: trackDuration,
            samples,
            codecConfig,
            timescale,
        };

        if (isVideo) result.videoTracks.push(track);
        else result.audioTracks.push(track);
    }

    private findEsds(buf: Uint8Array, start: number, end: number): Uint8Array | undefined {
        const esds = findBox(buf, start, end, 'esds');
        if (!esds) {
            const wave = findBox(buf, start, end, 'wave');
            if (wave) return this.findEsds(buf, wave.offset + 8, wave.offset + wave.size);
            return undefined;
        }
        const data = buf.slice(esds.offset + 12, esds.offset + esds.size);
        for (let i = 0; i < data.length - 2; i++) {
            if (data[i] === 0x05) {
                let j = i + 1;
                while (j < data.length && data[j] === 0x80) j++;
                if (j < data.length) {
                    const len = data[j];
                    j++;
                    if (j + len <= data.length) {
                        return data.slice(j, j + len);
                    }
                }
            }
        }
        return undefined;
    }


    private parseAacAudioSpecificConfig(config: Uint8Array): { sampleRate?: number; channelCount?: number } | null {
        if (config.length < 2) return null;
        const sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
        let bitOffset = 0;
        const readBits = (count: number): number => {
            let value = 0;
            for (let i = 0; i < count; i++) {
                const byteIndex = bitOffset >> 3;
                if (byteIndex >= config.length) return value;
                const bitIndex = 7 - (bitOffset & 7);
                value = (value << 1) | ((config[byteIndex] >> bitIndex) & 1);
                bitOffset++;
            }
            return value;
        };

        let audioObjectType = readBits(5);
        if (audioObjectType === 31) audioObjectType = 32 + readBits(6);
        const samplingFrequencyIndex = readBits(4);
        const sampleRate = samplingFrequencyIndex == 0x0F ? readBits(24) : sampleRates[samplingFrequencyIndex];
        const channelConfig = readBits(4);
        if (audioObjectType <= 0) return null;
        return {
            sampleRate,
            channelCount: channelConfig === 7 ? 8 : channelConfig,
        };
    }

    private parseSamples(
        buf: Uint8Array, dv: DataView, stblS: number, stblE: number, timescale: number,
    ): MP4Sample[] {
        const stsz = findBox(buf, stblS, stblE, 'stsz');
        const stco = findBox(buf, stblS, stblE, 'stco') ?? findBox(buf, stblS, stblE, 'co64');
        const stts = findBox(buf, stblS, stblE, 'stts');
        const stsc = findBox(buf, stblS, stblE, 'stsc');
        const stss = findBox(buf, stblS, stblE, 'stss');
        const ctts = findBox(buf, stblS, stblE, 'ctts');

        if (!stsz || !stco || !stts || !stsc) return [];

        const isLargeOffset = stco.type === 'co64';
        const sampleCount = readU32(dv, stsz.offset + 16);
        const defaultSize = readU32(dv, stsz.offset + 12);

        const sizes: number[] = [];
        if (defaultSize > 0) {
            for (let i = 0; i < sampleCount; i++) sizes.push(defaultSize);
        } else {
            for (let i = 0; i < sampleCount; i++) sizes.push(readU32(dv, stsz.offset + 20 + i * 4));
        }

        const chunkCount = readU32(dv, stco.offset + 12);
        const chunkOffsets: number[] = [];
        for (let i = 0; i < chunkCount; i++) {
            if (isLargeOffset) {
                const hi = readU32(dv, stco.offset + 16 + i * 8);
                const lo = readU32(dv, stco.offset + 20 + i * 8);
                chunkOffsets.push(hi * 0x100000000 + lo);
            } else {
                chunkOffsets.push(readU32(dv, stco.offset + 16 + i * 4));
            }
        }

        const stscEntryCount = readU32(dv, stsc.offset + 12);
        const stscEntries: { firstChunk: number; samplesPerChunk: number }[] = [];
        for (let i = 0; i < stscEntryCount; i++) {
            stscEntries.push({
                firstChunk: readU32(dv, stsc.offset + 16 + i * 12),
                samplesPerChunk: readU32(dv, stsc.offset + 20 + i * 12),
            });
        }

        const dtsList: number[] = [];
        const durations: number[] = [];
        const sttsEntryCount = readU32(dv, stts.offset + 12);
        let dts = 0;
        for (let i = 0; i < sttsEntryCount; i++) {
            const count = readU32(dv, stts.offset + 16 + i * 8);
            const delta = readU32(dv, stts.offset + 20 + i * 8);
            for (let j = 0; j < count && dtsList.length < sampleCount; j++) {
                dtsList.push(dts);
                durations.push(delta);
                dts += delta;
            }
        }
        while (durations.length < sampleCount) durations.push(durations[durations.length - 1] ?? 0);

        const compositionOffsets = new Array<number>(sampleCount).fill(0);
        if (ctts) {
            const version = buf[ctts.offset + 8];
            const entryCount = readU32(dv, ctts.offset + 12);
            let sampleIndex = 0;
            for (let i = 0; i < entryCount && sampleIndex < sampleCount; i++) {
                const count = readU32(dv, ctts.offset + 16 + i * 8);
                let offset = readU32(dv, ctts.offset + 20 + i * 8);
                if (version === 1 && offset >= 0x80000000) offset -= 0x100000000;
                for (let j = 0; j < count && sampleIndex < sampleCount; j++, sampleIndex++) {
                    compositionOffsets[sampleIndex] = offset;
                }
            }
        }

        const keyframes = new Set<number>();
        if (stss) {
            const ssCount = readU32(dv, stss.offset + 12);
            for (let i = 0; i < ssCount; i++) keyframes.add(readU32(dv, stss.offset + 16 + i * 4) - 1);
        } else {
            for (let i = 0; i < sampleCount; i++) keyframes.add(i);
        }

        const sampleOffsets: number[] = new Array(sampleCount);
        let sampleIdx = 0;
        for (let ci = 0; ci < chunkCount && sampleIdx < sampleCount; ci++) {
            let samplesInChunk = stscEntries[stscEntries.length - 1]?.samplesPerChunk ?? 1;
            for (let e = stscEntries.length - 1; e >= 0; e--) {
                if (ci + 1 >= stscEntries[e].firstChunk) {
                    samplesInChunk = stscEntries[e].samplesPerChunk;
                    break;
                }
            }
            let off = chunkOffsets[ci] ?? 0;
            for (let s = 0; s < samplesInChunk && sampleIdx < sampleCount; s++) {
                sampleOffsets[sampleIdx] = off;
                off += sizes[sampleIdx] ?? 0;
                sampleIdx++;
            }
        }

        const samples: MP4Sample[] = [];
        for (let i = 0; i < sampleCount; i++) {
            const decodeTs = dtsList[i] ?? 0;
            const dur = durations[i] ?? 0;
            const cto = compositionOffsets[i] ?? 0;
            samples.push({
                offset: sampleOffsets[i] ?? 0,
                size: sizes[i] ?? 0,
                timestamp: (decodeTs + cto) / timescale,
                decodeTimestamp: decodeTs / timescale,
                compositionTimeOffset: cto / timescale,
                duration: dur / timescale,
                isKeyframe: keyframes.has(i),
            });
        }

        return samples;
    }
}
