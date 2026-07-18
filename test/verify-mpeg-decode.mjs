// MPEG-1/2 Layer I/II decoder verification against ffmpeg-encoded references.
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeMpegLayer12, skipId3v2 } from '../dist/esm/audio/mpeg-layer12-decoder.js';

const T = join(tmpdir(), 'fc-mpegdec');
execFileSync('mkdir', ['-p', T]);

function genMusic(seconds, sampleRate, channels) {
    const frames = Math.floor(seconds * sampleRate);
    const pcm = new Float32Array(frames * channels);
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
    const noiseF = [], noiseP = [];
    for (let k = 0; k < 24; k++) { noiseF.push(300 + k * 550); noiseP.push(rnd() * Math.PI); }
    for (let i = 0; i < frames; i++) {
        const t = i / sampleRate;
        for (let ch = 0; ch < channels; ch++) {
            const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.7 * t);
            let v = 0.35 * env * Math.sin(2 * Math.PI * 220 * t + ch)
                + 0.25 * Math.sin(2 * Math.PI * 987 * t * (1 + 0.001 * ch))
                + 0.15 * env * Math.sin(2 * Math.PI * 3520 * t)
                + 0.08 * Math.sin(2 * Math.PI * 7040 * t + ch * 2);
            for (let k = 0; k < 24; k++) v += 0.004 * Math.sin(2 * Math.PI * noiseF[k] * t + noiseP[k] + ch);
            pcm[i * channels + ch] = Math.max(-0.98, Math.min(0.98, v));
        }
    }
    return pcm;
}

function writeF32(path, pcm) { writeFileSync(path, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)); }
function ff(args) { execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] }); }
function ffDecode(path, channels) {
    const out = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'f32le', '-ac', String(channels), '-'], { maxBuffer: 1 << 28 });
    return new Float32Array(out.buffer, out.byteOffset, out.byteLength >> 2);
}
function interleave(channelData) {
    const ch = channelData.length, n = channelData[0].length;
    const out = new Float32Array(n * ch);
    for (let c = 0; c < ch; c++) for (let i = 0; i < n; i++) out[i * ch + c] = channelData[c][i];
    return out;
}
function snrDb(ref, dec, channels, maxLag = 4000) {
    let bestLag = 0, bestCorr = -Infinity;
    const probeLen = Math.min(ref.length, dec.length, 48000 * channels);
    for (let lag = 0; lag <= maxLag; lag += channels) {
        let corr = 0;
        for (let i = 0; i < probeLen - maxLag; i += 7) corr += ref[i] * dec[i + lag];
        if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    const skip = 1152 * 3 * channels;
    const n = Math.min(ref.length, dec.length - bestLag) - skip * 2;
    let sig = 0, noise = 0;
    for (let i = skip; i < skip + n; i++) {
        const d = ref[i] - dec[i + bestLag];
        sig += ref[i] * ref[i]; noise += d * d;
    }
    return { snr: 10 * Math.log10(sig / Math.max(noise, 1e-30)), lag: bestLag / channels };
}

let failures = 0;
function check(ok, name, detail = '') {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' ' + detail : ''}`);
}

// ---- 1. MPEG-1 Layer II matrix: decode ffmpeg-encoded files ----
for (const [sr, ch, br] of [
    [44100, 2, 192], [44100, 2, 384], [44100, 1, 96],
    [48000, 2, 256], [48000, 1, 160],
    [32000, 2, 128], [32000, 1, 64],
]) {
    const pcm = genMusic(3, sr, ch);
    const raw = join(T, 'src.f32');
    const mp2 = join(T, `ref_${sr}_${ch}_${br}.mp2`);
    writeF32(raw, pcm);
    ff(['-f', 'f32le', '-ar', String(sr), '-ac', String(ch), '-i', raw, '-c:a', 'mp2', '-b:a', `${br}k`, mp2]);

    const decoded = decodeMpegLayer12(new Uint8Array(readFileSync(mp2)));
    if (!decoded) { check(false, `L2 ${sr}/${ch}ch/${br}k`, 'decode returned null'); continue; }
    const mine = interleave(decoded.channelData);
    const vsSrc = snrDb(pcm, mine, ch);
    const ffm = ffDecode(mp2, ch);
    const vsFf = snrDb(ffm, mine, ch);
    const ok = decoded.sampleRate === sr && decoded.channelData.length === ch
        && vsSrc.snr >= 20 && vsFf.snr >= 55;
    check(ok, `L2 ${sr}Hz ${ch}ch ${br}k`, `vsSrc=${vsSrc.snr.toFixed(1)}dB vsFfmpeg=${vsFf.snr.toFixed(1)}dB lag=${vsSrc.lag}`);
}

// ---- 2. MPEG-2 LSF Layer II ----
for (const [sr, ch, br] of [[24000, 2, 96], [16000, 1, 32]]) {
    const pcm = genMusic(3, sr, ch);
    const raw = join(T, 'src.f32');
    const mp2 = join(T, `lsf_${sr}_${ch}_${br}.mp2`);
    writeF32(raw, pcm);
    ff(['-f', 'f32le', '-ar', String(sr), '-ac', String(ch), '-i', raw, '-c:a', 'mp2', '-b:a', `${br}k`, mp2]);
    const decoded = decodeMpegLayer12(new Uint8Array(readFileSync(mp2)));
    if (!decoded) { check(false, `LSF ${sr}/${ch}ch/${br}k`, 'decode returned null'); continue; }
    const mine = interleave(decoded.channelData);
    const vsFf = snrDb(ffDecode(mp2, ch), mine, ch);
    check(decoded.sampleRate === sr && vsFf.snr >= 55, `LSF ${sr}Hz ${ch}ch ${br}k`, `vsFfmpeg=${vsFf.snr.toFixed(1)}dB`);
}

// ---- 3. Robustness: ID3v2 tag, garbage prefix, truncation ----
{
    const base = new Uint8Array(readFileSync(join(T, 'ref_44100_2_192.mp2')));
    const clean = decodeMpegLayer12(base);

    const tagBody = 200;
    const id3 = new Uint8Array(10 + tagBody + base.length);
    id3.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, (tagBody >> 7) & 0x7F, tagBody & 0x7F]);
    id3.set(base, 10 + tagBody);
    check(skipId3v2(id3, 0) === 10 + tagBody, 'ID3v2 size parsing');
    const viaId3 = decodeMpegLayer12(id3);
    check(!!viaId3 && viaId3.channelData[0].length === clean.channelData[0].length, 'decode with ID3v2 tag prefix',
        viaId3 ? `${viaId3.channelData[0].length} samples` : 'null');

    const junk = new Uint8Array(100 + base.length);
    let seed = 99;
    for (let i = 0; i < 100; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; junk[i] = (seed >> 8) & 0xFF; }
    junk[3] = 0xFF; // near-sync bait
    junk.set(base, 100);
    const viaJunk = decodeMpegLayer12(junk);
    check(!!viaJunk && Math.abs(viaJunk.channelData[0].length - clean.channelData[0].length) <= 1152 * 2,
        'resync over garbage prefix', viaJunk ? `${viaJunk.channelData[0].length} samples` : 'null');

    const cut = base.subarray(0, Math.floor(base.length * 0.6) + 7); // mid-frame cut
    const viaCut = decodeMpegLayer12(cut);
    check(!!viaCut && viaCut.channelData[0].length > clean.channelData[0].length * 0.4
        && viaCut.channelData[0].length < clean.channelData[0].length,
        'truncated file decodes clean prefix', viaCut ? `${viaCut.channelData[0].length} samples` : 'null');
}

// ---- 4. Joint stereo (twolame if available) ----
{
    let twolame = true;
    try { execFileSync('which', ['twolame'], { stdio: 'ignore' }); } catch { twolame = false; }
    if (twolame) {
        const pcm = genMusic(3, 44100, 2);
        const raw = join(T, 'js.raw');
        writeF32(raw, pcm);
        const wav = join(T, 'js.wav');
        ff(['-f', 'f32le', '-ar', '44100', '-ac', '2', '-i', raw, wav]);
        const mp2 = join(T, 'js.mp2');
        execFileSync('twolame', ['-m', 'j', '-b', '192', wav, mp2], { stdio: 'ignore' });
        const decoded = decodeMpegLayer12(new Uint8Array(readFileSync(mp2)));
        const vsFf = decoded ? snrDb(ffDecode(mp2, 2), interleave(decoded.channelData), 2) : { snr: -99 };
        check(!!decoded && vsFf.snr >= 55, 'joint stereo (twolame)', `vsFfmpeg=${vsFf.snr.toFixed(1)}dB`);
    } else {
        console.log('skip joint stereo: twolame not installed');
    }
}

// ---- 5. Layer I structural decode (no encoder available; hand-built frame) ----
{
    // Mono 44.1 kHz 448 kbps Layer I: header + 32*4 alloc bits + scf + 12 codes.
    const frameBytes = Math.floor(12000 * 448 / 44100) * 4;
    const frame = new Uint8Array(frameBytes * 2);
    for (const base of [0, frameBytes]) {
        frame[base] = 0xFF; frame[base + 1] = 0xFF; frame[base + 2] = 0xE0; frame[base + 3] = 0xC0;
        let bit = (base + 4) * 8;
        const put = (v, n) => { for (let i = n - 1; i >= 0; i--) { if ((v >> i) & 1) frame[bit >> 3] |= 0x80 >> (bit & 7); bit++; } };
        put(14, 4); // sb0: 15-bit samples
        for (let sb = 1; sb < 32; sb++) put(0, 4);
        put(0, 6); // scalefactor 2.0
        for (let s = 0; s < 12; s++) put(16383 + s * 100, 15);
    }
    const decoded = decodeMpegLayer12(frame);
    const okStruct = !!decoded && decoded.sampleRate === 44100
        && decoded.channelData.length === 1 && decoded.channelData[0].length === 768
        && decoded.channelData[0].every(Number.isFinite)
        && decoded.channelData[0].some((v) => Math.abs(v) > 1e-4);
    check(okStruct, 'Layer I structural decode', decoded ? `${decoded.channelData[0].length} samples` : 'null');
}

console.log(`\n${failures} failures`);
process.exit(failures ? 1 : 0);
