// MP3 encoder verification + benchmark vs pristine engine.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { encodeMP3 } from '../dist/esm/audio/mp3/engine.js';
// Optional A/B benchmark target: set FLOWCAST_OLD_ENGINE to a compiled engine.js
// from a previous revision to compare speed and quality.

function genSignal(kind, seconds, sampleRate, channels) {
    const frames = Math.floor(seconds * sampleRate);
    const pcm = new Float32Array(frames * channels);
    let seed = 9;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
    const noiseF = [], noiseP = [];
    for (let k = 0; k < 24; k++) { noiseF.push(300 + k * 562.5); noiseP.push(rnd() * Math.PI); }
    const ph = [0, 0];
    for (let i = 0; i < frames; i++) {
        const t = i / sampleRate;
        for (let ch = 0; ch < channels; ch++) {
            let v = 0;
            if (kind === 'sine1k') v = 0.6 * Math.sin(2 * Math.PI * 1000 * t + ch * 0.5);
            else if (kind === 'music') {
                const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.7 * t);
                v = 0.35 * env * Math.sin(2 * Math.PI * 220 * t + ch)
                    + 0.25 * Math.sin(2 * Math.PI * 987 * t * (1 + 0.001 * ch))
                    + 0.15 * env * Math.sin(2 * Math.PI * 3520 * t)
                    + 0.08 * Math.sin(2 * Math.PI * 7040 * t + ch * 2);
                for (let k = 0; k < 24; k++) v += 0.004 * Math.sin(2 * Math.PI * noiseF[k] * t + noiseP[k] + ch);
            } else if (kind === 'sweep') {
                const f = 40 * Math.pow(2, t * Math.log2(12000 / 40) / seconds);
                ph[ch] += 2 * Math.PI * f / sampleRate;
                v = 0.5 * Math.sin(ph[ch] + ch * 0.4);
            }
            pcm[i * channels + ch] = Math.max(-0.98, Math.min(0.98, v));
        }
    }
    return pcm;
}

function ffDecode(path, channels) {
    const out = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'f32le', '-ac', String(channels), '-'], { maxBuffer: 1 << 28 });
    return new Float32Array(out.buffer, out.byteOffset, out.byteLength >> 2);
}
function ffErrors(path) {
    try { execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }); return ''; }
    catch (e) { return String(e.stderr || e.message); }
}
function ffprobe(path) {
    return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path]).toString()).streams[0];
}
function snrDb(ref, dec, channels, maxLag = 6000) {
    let bestLag = 0, bestCorr = -Infinity;
    const probeLen = Math.min(ref.length, 48000 * channels);
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

const cases = [];
for (const sr of [44100, 48000, 32000]) {
    for (const ch of [2, 1]) {
        for (const br of [32, 64, 96, 128, 192, 256, 320]) cases.push({ sr, ch, br });
    }
}
let failures = 0;
const t0 = Date.now();
for (const { sr, ch, br } of cases) {
    const pcm = genSignal('music', 3, sr, ch);
    let blob;
    try { blob = encodeMP3(pcm, sr, ch, br); }
    catch (e) { console.log(`FAIL ${sr}Hz ${ch}ch ${br}k THROW ${e.message}`); failures++; continue; }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const path = `/tmp/fc/out/m3_${sr}_${ch}_${br}.mp3`;
    writeFileSync(path, bytes);
    const errs = ffErrors(path);
    const st = ffprobe(path);
    const dec = ffDecode(path, ch);
    const { snr, lag } = snrDb(pcm, dec, ch);
    const perCh = br / ch;
    const min = perCh >= 96 ? 18 : perCh >= 64 ? 14 : perCh >= 48 ? 10 : 4;
    const ok = errs === '' && st.codec_name === 'mp3' && +st.sample_rate === sr && st.channels === ch && snr >= min;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${sr}Hz ${ch}ch ${String(br).padStart(3)}k snr=${snr.toFixed(1)}dB(min ${min}) lag=${lag} errs=${errs.slice(0, 100).replace(/\n/g, ' ')}`);
}
for (const [kind, sr, ch, br, min] of [['sine1k', 44100, 2, 320, 40], ['sine1k', 48000, 1, 160, 40], ['sweep', 44100, 2, 256, 18]]) {
    const pcm = genSignal(kind, 3, sr, ch);
    const blob = encodeMP3(pcm, sr, ch, br);
    const path = `/tmp/fc/out/m3hf_${kind}_${br}.mp3`;
    writeFileSync(path, new Uint8Array(await blob.arrayBuffer()));
    const dec = ffDecode(path, ch);
    const { snr } = snrDb(pcm, dec, ch);
    const ok = snr >= min && ffErrors(path) === '';
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} HF ${kind} ${br}k snr=${snr.toFixed(1)}dB (min ${min})`);
}

// Benchmark (6 s stereo 44.1 @ 192k); compares against FLOWCAST_OLD_ENGINE when set.
{
    const pcm = genSignal('music', 6, 44100, 2);
    const tNew = Date.now();
    const bNew = encodeMP3(pcm, 44100, 2, 192);
    const newMs = Date.now() - tNew;
    writeFileSync('/tmp/bench_new.mp3', new Uint8Array(await bNew.arrayBuffer()));
    const dNew = ffDecode('/tmp/bench_new.mp3', 2);
    let oldPart = '';
    if (process.env.FLOWCAST_OLD_ENGINE) {
        const { encodeMP3: encodeOld } = await import(process.env.FLOWCAST_OLD_ENGINE);
        const tOld = Date.now();
        const bOld = encodeOld(pcm, 44100, 2, 192);
        const oldMs = Date.now() - tOld;
        writeFileSync('/tmp/bench_old.mp3', new Uint8Array(await bOld.arrayBuffer()));
        const dOld = ffDecode('/tmp/bench_old.mp3', 2);
        oldPart = `old=${oldMs}ms snr=${snrDb(pcm, dOld, 2).snr.toFixed(1)}dB | speedup x${(oldMs / newMs).toFixed(2)} | `;
    }
    console.log(`BENCH ${oldPart}new=${newMs}ms snr=${snrDb(pcm, dNew, 2).snr.toFixed(1)}dB`);
}
console.log(`\n${cases.length + 3} cases, ${failures} failures, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(failures ? 1 : 0);
