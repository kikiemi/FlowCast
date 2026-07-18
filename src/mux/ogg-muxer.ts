import type { Sink } from '../types/io';
import type { MuxerConfig } from '../types/container';
import type { EncodedChunk } from '../types/media';
import { BinaryWriter } from '../core/binary-writer';

const OGG_CONTINUED_PACKET = 0x01;
const OGG_BOS = 0x02;
const OGG_EOS = 0x04;
const OGG_MAX_SEGMENTS_PER_PAGE = 255;
const OGG_SEGMENT_SIZE = 255;
const OPUS_SAMPLE_RATE = 48000;
const OPUS_PRE_SKIP = 312;
const OPUS_DEFAULT_FRAME_SAMPLES = 960; // 20 ms at 48 kHz
const INVALID_GRANULE_POSITION = 0xFFFFFFFFFFFFFFFFn;

export class OGGMuxer {
    private readonly sink: Sink;
    private readonly cfg: MuxerConfig;
    private readonly serialNumber: number;
    private readonly chunks: EncodedChunk[] = [];
    private pageSequenceNumber = 0;
    // Page assembly state for batched packets.
    private pageSegments: number[] = [];
    private pageParts: Uint8Array[] = [];
    private pageGranule: bigint = INVALID_GRANULE_POSITION;

    constructor(cfg: MuxerConfig, sink: Sink) {
        this.cfg = cfg;
        this.sink = sink;
        this.serialNumber = ((Date.now() & 0xFFFFFFFF) ^ 0x6f676753) >>> 0;
    }

    /** Provide the encoder's OpusHead; used when building the ID header. */
    setCodecConfig(codecConfig: Uint8Array): void {
        if (this.cfg.audio) this.cfg.audio.codecConfig = codecConfig;
    }

    addVideoChunk(chunk: EncodedChunk): void {
        this.chunks.push(chunk);
    }

    addAudioChunk(chunk: EncodedChunk): void {
        this.chunks.push(chunk);
    }

    finalize(): void {
        const channelCount = this.cfg.audio?.channelCount ?? 2;
        const inputSampleRate = this.cfg.audio?.sampleRate ?? OPUS_SAMPLE_RATE;
        const packets = this.chunks
            .map((chunk, index) => ({ chunk, index }))
            .filter((entry) => entry.chunk.trackType === 'audio')
            .sort((left, right) => {
                const timestampDelta = left.chunk.timestamp - right.chunk.timestamp;
                return timestampDelta !== 0 ? timestampDelta : left.index - right.index;
            });

        const idHeader = this.resolveOpusIdHeader(channelCount, inputSampleRate);
        const preSkip = idHeader.length >= 12 ? (idHeader[10] | (idHeader[11] << 8)) : OPUS_PRE_SKIP;
        this.writePacket(idHeader, 0n, OGG_BOS);
        this.writePacket(this.buildOpusCommentHeader(), 0n, 0);

        // RFC 7845: granule position counts 48 kHz samples including pre-skip.
        let samplePosition = BigInt(preSkip);
        for (let index = 0; index < packets.length; index++) {
            const { chunk } = packets[index];
            let durationSeconds = chunk.duration > 0 ? chunk.duration : 0;
            if (durationSeconds <= 0 && index + 1 < packets.length) {
                durationSeconds = Math.max(0, packets[index + 1].chunk.timestamp - chunk.timestamp);
            }
            const samples = durationSeconds > 0
                ? Math.max(1, Math.round(durationSeconds * OPUS_SAMPLE_RATE))
                : OPUS_DEFAULT_FRAME_SAMPLES;
            samplePosition += BigInt(samples);
            this.queuePacket(chunk.data, samplePosition, index === packets.length - 1);
        }
        this.flushPage(0);

        this.sink.close();
    }

    /** Use the encoder-provided OpusHead when present; build a default otherwise. */
    private resolveOpusIdHeader(channelCount: number, inputSampleRate: number): Uint8Array {
        const provided = this.cfg.audio?.codecConfig;
        if (provided && provided.length >= 19
            && provided[0] === 0x4F && provided[1] === 0x70 && provided[2] === 0x75 && provided[3] === 0x73
            && provided[4] === 0x48 && provided[5] === 0x65 && provided[6] === 0x61 && provided[7] === 0x64) {
            return provided;
        }
        return this.buildOpusIdHeader(channelCount, inputSampleRate);
    }

    /** Append a packet to the current page, flushing when the segment table fills. */
    private queuePacket(payload: Uint8Array, granulePosition: bigint, isLast: boolean): void {
        const lacing = this.buildLacingValues(payload.length);
        if (lacing.length > OGG_MAX_SEGMENTS_PER_PAGE) {
            // Oversized packet: give it dedicated (continued) pages.
            this.flushPage(0);
            this.writePacket(payload, granulePosition, isLast ? OGG_EOS : 0);
            return;
        }
        if (this.pageSegments.length + lacing.length > OGG_MAX_SEGMENTS_PER_PAGE) {
            this.flushPage(0);
        }
        for (let i = 0; i < lacing.length; i++) this.pageSegments.push(lacing[i]);
        this.pageParts.push(payload);
        this.pageGranule = granulePosition;
        if (isLast) this.flushPage(OGG_EOS);
    }

    private flushPage(extraFlags: number): void {
        if (this.pageSegments.length === 0) return;
        let total = 0;
        for (const part of this.pageParts) total += part.length;
        const payload = new Uint8Array(total);
        let off = 0;
        for (const part of this.pageParts) {
            payload.set(part, off);
            off += part.length;
        }
        this.sink.write(this.buildPage(payload, Uint8Array.from(this.pageSegments), extraFlags, this.pageGranule));
        this.pageSegments = [];
        this.pageParts = [];
        this.pageGranule = INVALID_GRANULE_POSITION;
    }

    private buildOpusIdHeader(channelCount: number, inputSampleRate: number): Uint8Array {
        const writer = new BinaryWriter();
        writer.writeASCII('OpusHead');
        writer.writeU8(1);
        writer.writeU8(channelCount);
        writer.writeU16LE(OPUS_PRE_SKIP);
        writer.writeU32LE(inputSampleRate);
        writer.writeU16LE(0);
        writer.writeU8(0);
        return writer.toUint8Array();
    }

    private buildOpusCommentHeader(): Uint8Array {
        const writer = new BinaryWriter();
        const vendor = 'FlowCast';
        writer.writeASCII('OpusTags');
        writer.writeU32LE(vendor.length);
        writer.writeASCII(vendor);
        writer.writeU32LE(0);
        return writer.toUint8Array();
    }

    private writePacket(payload: Uint8Array, granulePosition: bigint, flags: number): void {
        const lacingValues = this.buildLacingValues(payload.length);
        let payloadOffset = 0;
        const totalPages = Math.max(1, Math.ceil(lacingValues.length / OGG_MAX_SEGMENTS_PER_PAGE));

        for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
            const segmentStart = pageIndex * OGG_MAX_SEGMENTS_PER_PAGE;
            const segmentEnd = Math.min(lacingValues.length, segmentStart + OGG_MAX_SEGMENTS_PER_PAGE);
            const segmentTable = lacingValues.subarray(segmentStart, segmentEnd);

            let pagePayloadLength = 0;
            for (let segmentIndex = 0; segmentIndex < segmentTable.length; segmentIndex++) {
                pagePayloadLength += segmentTable[segmentIndex] ?? 0;
            }

            const pagePayload = payload.subarray(payloadOffset, payloadOffset + pagePayloadLength);
            payloadOffset += pagePayloadLength;

            let headerType = 0;
            if (pageIndex > 0) headerType |= OGG_CONTINUED_PACKET;
            if (pageIndex === 0 && (flags & OGG_BOS) !== 0) headerType |= OGG_BOS;
            if (pageIndex === totalPages - 1 && (flags & OGG_EOS) !== 0) headerType |= OGG_EOS;

            const pageGranulePosition = pageIndex === totalPages - 1 ? granulePosition : INVALID_GRANULE_POSITION;
            this.sink.write(this.buildPage(pagePayload, segmentTable, headerType, pageGranulePosition));
        }
    }

    private buildLacingValues(payloadLength: number): Uint8Array {
        if (payloadLength === 0) return new Uint8Array([0]);

        const values: number[] = [];
        let remaining = payloadLength;
        while (remaining >= OGG_SEGMENT_SIZE) {
            values.push(OGG_SEGMENT_SIZE);
            remaining -= OGG_SEGMENT_SIZE;
        }
        values.push(remaining);
        if (payloadLength % OGG_SEGMENT_SIZE === 0) values.push(0);
        return Uint8Array.from(values);
    }

    private buildPage(
        payload: Uint8Array,
        segmentTable: Uint8Array,
        headerType: number,
        granulePosition: bigint,
    ): Uint8Array {
        const writer = new BinaryWriter();
        writer.writeASCII('OggS');
        writer.writeU8(0);
        writer.writeU8(headerType);
        this.writeU64LE(writer, granulePosition);
        writer.writeU32LE(this.serialNumber);
        writer.writeU32LE(this.pageSequenceNumber++);
        writer.writeU32LE(0);
        writer.writeU8(segmentTable.length);
        writer.writeBytes(segmentTable);
        writer.writeBytes(payload);

        const page = writer.toUint8Array();
        const checksum = this.crc32(page);
        page[22] = checksum & 0xFF;
        page[23] = (checksum >>> 8) & 0xFF;
        page[24] = (checksum >>> 16) & 0xFF;
        page[25] = (checksum >>> 24) & 0xFF;
        return page;
    }

    private writeU64LE(writer: BinaryWriter, value: bigint): void {
        const normalized = value < 0n ? INVALID_GRANULE_POSITION : value;
        writer.writeU32LE(Number(normalized & 0xFFFFFFFFn));
        writer.writeU32LE(Number((normalized >> 32n) & 0xFFFFFFFFn));
    }

    private crc32(data: Uint8Array): number {
        let crc = 0;
        for (let index = 0; index < data.length; index++) {
            crc = (crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) & 0xFF) ^ data[index]];
            crc >>>= 0;
        }
        return crc >>> 0;
    }
}

const OGG_CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
        let remainder = index << 24;
        for (let bit = 0; bit < 8; bit++) {
            remainder = (remainder & 0x80000000) !== 0 ? ((remainder << 1) ^ 0x04C11DB7) : (remainder << 1);
            remainder >>>= 0;
        }
        table[index] = remainder;
    }
    return table;
})();
