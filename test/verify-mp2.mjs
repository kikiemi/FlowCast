// MP2 encoder verification: encode with FlowCast, decode with ffmpeg, measure SNR.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { encodeMP2, legalMp2Bitrates } from '../dist/esm/audio/mp2-encoder.js';

mkdirSync('/tmp/fc/out', { recursive: true });

function genSignal(kind, seconds, sampleRate, channels) {
    const frames = Math.floor(seconds * sampleRate);
    const pcm = new Float32Array(frames * channels);
    let seed = 12345;
    const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff * 2 - 1;
    };
    // Band-limited noise bed: random-phase sines 300..13800 Hz (inside every sblimit).
    const noiseF = [], noiseP = [];
    for (let k = 0; k < 24; k++) { noiseF.push(300 + k * 562.5); noiseP.push(rnd() * Math.PI); }
    const sweepPhase = [0, 0];
    for (let i = 0; i < frames; i++) {
        const t = i / sampleRate;
        for (let ch = 0; ch < channels; ch++) {
            let v = 0;
            if (kind === 'sine1k') {
                v = 0.6 * Math.sin(2 * Math.PI * 1000 * t + ch * 0.5);
            } else if (kind === 'music') {
                const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.7 * t);
                v = 0.35 * env * Math.sin(2 * Math.PI * 220 * t + ch)
                    + 0.25 * Math.sin(2 * Math.PI * 987 * t * (1 + 0.001 * ch))
                    + 0.15 * env * Math.sin(2 * Math.PI * 3520 * t)
                    + 0.08 * Math.sin(2 * Math.PI * 7040 * t + ch * 2);
            }
            if (kind === 'music') {
                for (let k = 0; k < 24; k++) v += 0.004 * Math.sin(2 * Math.PI * noiseF[k] * t + noiseP[k] + ch);
            } else if (kind === 'sweep') {
                const f = 40 * Math.pow(2, t * Math.log2(12000 / 40) / seconds);
                sweepPhase[ch] += 2 * Math.PI * f / sampleRate;
                v = 0.5 * Math.sin(sweepPhase[ch] + ch * 0.4);
            }
            pcm[i * channels + ch] = Math.max(-0.98, Math.min(0.98, v));
        }
    }
    return pcm;
}

function ffDecode(path, channels) {
    const err = [];
    const out = execFileSync('ffmpeg', [
        '-v', 'error', '-i', path, '-f', 'f32le', '-ac', String(channels), '-'
    ], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
    return new Float32Array(out.buffer, out.byteOffset, out.byteLength >> 2);
}

function ffErrors(path) {
    try {
        const r = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
        return '';
    } catch (e) {
        return String(e.stderr || e.message);
    }
}

function ffprobe(path) {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path]);
    return JSON.parse(out.toString()).streams[0];
}

// Best-lag SNR: search alignment in [0, maxLag], compare overlapping region.
function snrDb(ref, dec, channels, maxLag = 4096) {
    let bestLag = 0, bestCorr = -Infinity;
    const probeLen = Math.min(ref.length, 48000 * channels);
    for (let lag = 0; lag <= maxLag; lag += channels) {
        let corr = 0;
        const n = Math.min(probeLen, dec.length - lag);
        for (let i = 0; i < n; i += 7) corr += ref[i] * dec[i + lag];
        if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    const skip = 1152 * 2 * channels;
    const n = Math.min(ref.length, dec.length - bestLag) - skip * 2;
    let sig = 0, noise = 0;
    for (let i = skip; i < skip + n; i++) {
        const d = ref[i] - dec[i + bestLag];
        sig += ref[i] * ref[i];
        noise += d * d;
    }
    return { snr: 10 * Math.log10(sig / Math.max(noise, 1e-30)), lag: bestLag / channels };
}

const cases = [];
for (const sr of [44100, 48000, 32000]) {
    for (const ch of [2, 1]) {
        for (const br of legalMp2Bitrates(ch)) {
            cases.push({ sr, ch, br });
        }
    }
}

let failures = 0;
const t0 = Date.now();
for (const { sr, ch, br } of cases) {
    const pcm = genSignal('music', 3, sr, ch);
    const blob = encodeMP2(pcm, sr, ch, br);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const path = `/tmp/fc/out/t_${sr}_${ch}_${br}.mp2`;
    writeFileSync(path, bytes);

    const errs = ffErrors(path);
    const st = ffprobe(path);
    const dec = ffDecode(path, ch);
    const { snr, lag } = snrDb(pcm, dec, ch);
    const expectBytes = Math.round(br * 1000 / 8 * 3);
    const sizeOk = Math.abs(bytes.length - expectBytes) < expectBytes * 0.02;

    const min = br / ch >= 160 ? 30 : br / ch >= 96 ? 22 : br / ch >= 64 ? 15 : 8;
    const ok = errs === '' && st.codec_name === 'mp2' && +st.sample_rate === sr
        && st.channels === ch && sizeOk && snr >= min;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${sr}Hz ${ch}ch ${String(br).padStart(3)}k  snr=${snr.toFixed(1)}dB lag=${lag} codec=${st.codec_name} errs=${errs.slice(0, 120).replace(/\n/g, ' ')}`);
}

// High-fidelity spot checks.
for (const [kind, sr, ch, br, min] of [['sine1k', 44100, 2, 384, 45], ['sine1k', 48000, 1, 192, 45], ['sweep', 44100, 2, 256, 25]]) {
    const pcm = genSignal(kind, 3, sr, ch);
    const blob = encodeMP2(pcm, sr, ch, br);
    const path = `/tmp/fc/out/hf_${kind}_${br}.mp2`;
    writeFileSync(path, new Uint8Array(await blob.arrayBuffer()));
    const dec = ffDecode(path, ch);
    const { snr } = snrDb(pcm, dec, ch);
    const ok = snr >= min && ffErrors(path) === '';
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} HF ${kind} ${br}k snr=${snr.toFixed(1)}dB (min ${min})`);
}

console.log(`\n${cases.length + 3} cases, ${failures} failures, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(failures ? 1 : 0);
