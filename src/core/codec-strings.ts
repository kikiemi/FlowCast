/** Codec-string helpers shared by the demuxers and WebCodecs pipelines. */

/**
 * Map a demuxed audio codec id to the string WebCodecs expects.
 * Browsers register MPEG audio Layers I-III under the single 'mp3' codec
 * string; the demuxers still report the true layer ('mp1'/'mp2') so callers
 * can route to the built-in MPEG decoder or label outputs honestly.
 */
export function webCodecsAudioCodec(codec: string): string {
    return codec === 'mp2' || codec === 'mp1' ? 'mp3' : codec;
}

/** Coarse codec family for remux compatibility decisions. */
export function codecFamily(codec: string): string {
    if (codec.startsWith('avc')) return 'avc';
    if (codec.startsWith('hvc')) return 'hvc1';
    if (codec.startsWith('hev')) return 'hev1';
    if (codec.startsWith('av01')) return 'av01';
    if (codec.startsWith('vp09') || codec.startsWith('vp9')) return 'vp09';
    if (codec.startsWith('mp4a')) return 'mp4a';
    return codec;
}
