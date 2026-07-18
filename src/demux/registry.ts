import type { ContainerFormat } from '../types/media';
import { DemuxError } from '../core/errors';

const MIME: Record<ContainerFormat, string> = {
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
    avi: 'video/x-msvideo', flv: 'video/x-flv', ogg: 'audio/ogg', '3gp': 'video/3gpp',
    mp3: 'audio/mpeg', wav: 'audio/wav', gif: 'image/gif', apng: 'image/apng',
    png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp',
    tiff: 'image/tiff', ico: 'image/x-icon', flac: 'audio/flac',
    aac: 'audio/aac', ts: 'video/mp2t', mp2: 'audio/mp2',
    m4a: 'audio/mp4', m4v: 'video/x-m4v',
};

export class DemuxerRegistry {
    static detect(h: Uint8Array): ContainerFormat {
        if (h.length >= 12 && h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46) {
            const sub = String.fromCharCode(h[8], h[9], h[10], h[11]);
            if (sub === 'WAVE') return 'wav';
            if (sub === 'WEBP') return 'webp';
            if (sub === 'AVI ') return 'avi';
        }
        if (h.length >= 4 && h[0] === 0x1A && h[1] === 0x45 && h[2] === 0xDF && h[3] === 0xA3) {
            const str = new TextDecoder().decode(h.subarray(0, Math.min(64, h.length)));
            return str.includes('matroska') ? 'mkv' : 'webm';
        }
        if (h.length >= 12 && h[4] === 0x66 && h[5] === 0x74 && h[6] === 0x79 && h[7] === 0x70) {
            const brand = String.fromCharCode(h[8], h[9], h[10], h[11]);
            if (brand.startsWith('qt')) return 'mov';
            if (brand.startsWith('3gp') || brand.startsWith('3g2')) return '3gp';
            return 'mp4';
        }
        if (h.length >= 4 && h[0] === 0x46 && h[1] === 0x4C && h[2] === 0x56) return 'flv';
        if (h.length >= 4 && h[0] === 0x4F && h[1] === 0x67 && h[2] === 0x67 && h[3] === 0x53) return 'ogg';
        const mpegAudio = sniffMpegAudioFormat(h);
        if (mpegAudio) return mpegAudio;
        if (h.length >= 2 && h[0] === 0xFF && (h[1] === 0xF1 || h[1] === 0xF9)) return 'aac';
        if (h.length >= 4 && h[0] === 0x66 && h[1] === 0x4C && h[2] === 0x61 && h[3] === 0x43) return 'flac';
        if (h.length >= 4 && h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4E && h[3] === 0x47) {
            for (let i = 8; i + 8 < h.length;) {
                const len = (h[i] << 24) | (h[i + 1] << 16) | (h[i + 2] << 8) | h[i + 3];
                const type = String.fromCharCode(h[i + 4], h[i + 5], h[i + 6], h[i + 7]);
                if (type === 'acTL') return 'apng';
                if (type === 'IDAT') break;
                i += 12 + len;
            }
            return 'png';
        }
        if (h.length >= 3 && h[0] === 0xFF && h[1] === 0xD8 && h[2] === 0xFF) return 'jpeg';
        if (h.length >= 4 && h[0] === 0x47 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x38) return 'gif';
        if (h.length >= 2 && h[0] === 0x42 && h[1] === 0x4D) return 'bmp';
        if (h.length >= 4 && h[0] === 0x49 && h[1] === 0x49 && h[2] === 0x2A && h[3] === 0x00) return 'tiff';
        if (h.length >= 4 && h[0] === 0x4D && h[1] === 0x4D && h[2] === 0x00 && h[3] === 0x2A) return 'tiff';
        if (h.length >= 4 && h[0] === 0x00 && h[1] === 0x00 && h[2] === 0x01 && h[3] === 0x00) return 'ico';
        if (h.length >= 189 && h[0] === 0x47 && h[188] === 0x47) return 'ts';
        throw new DemuxError('Unable to detect file format');
    }

    static async detectFromFile(file: File | Blob): Promise<ContainerFormat> {
        // 4 KiB covers typical ID3v2 tags so layer sniffing sees real frames.
        const h = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
        return DemuxerRegistry.detect(h);
    }

    static getMimeType(fmt: ContainerFormat): string {
        return MIME[fmt] ?? 'application/octet-stream';
    }
}

/**
 * MPEG audio sniffing: skips a leading ID3v2 tag when it fits in the header
 * bytes, then reads the layer field. Layer I and II route to the 'mp2'
 * pipeline (the built-in decoder handles both); ADTS (layer 0) is excluded.
 */
function sniffMpegAudioFormat(h: Uint8Array): 'mp2' | 'mp3' | null {
    let off = 0;
    if (h.length >= 10 && h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) {
        const size = ((h[6] & 0x7F) << 21) | ((h[7] & 0x7F) << 14) | ((h[8] & 0x7F) << 7) | (h[9] & 0x7F);
        const after = 10 + size + ((h[5] & 0x10) ? 10 : 0);
        if (after + 2 > h.length) return 'mp3'; // tag exceeds sniff window: assume the common case
        off = after;
    }
    if (off + 2 > h.length) return null;
    if (h[off] !== 0xFF || (h[off + 1] & 0xE0) !== 0xE0) return null;
    const versionBits = (h[off + 1] >> 3) & 3;
    if (versionBits === 1) return null;
    const layerBits = (h[off + 1] >> 1) & 3;
    if (layerBits === 1) return 'mp3';
    if (layerBits === 2 || layerBits === 3) return 'mp2';
    return null;
}
