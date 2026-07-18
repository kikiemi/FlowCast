// MP3 quality benchmark: FlowCast vs libmp3lame (SNR proxy, same decoder).
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeMP3 } from '../dist/esm/audio/mp3-encoder.js';

const T = join(tmpdir(), 'fc-mp3bench');
execFileSync('mkdir', ['-p', T]);

function genCorpus(kind, sr, seconds) {
    const n = Math.floor(sr * seconds);
    const pcm = new Float32Array(n * 2);
    let seed = 1234;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
    if (kind === 'tonal') {
        const f = [220, 277.18, 329.63, 440, 554.37, 880, 1760, 3520];
        for (let i = 0; i < n; i++) {
            const t = i / sr;
            const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.8 * t);
            let v = 0;
            for (let k = 0; k < f.length; k++) v += (0.28 / (k + 1)) * Math.sin(2 * Math.PI * f[k] * t + k);
            v *= env;
            pcm[i * 2] = Math.max(-0.97, Math.min(0.97, v));
            pcm[i * 2 + 1] = Math.max(-0.97, Math.min(0.97, v * 0.9 + 0.05 * Math.sin(2 * Math.PI * 660 * t)));
        }
    } else if (kind === 'mix') {
        const partF = [], partP = [];
        for (let k = 0; k < 30; k++) { partF.push(150 + k * 500 + (k * k) % 133); partP.push(rnd() * Math.PI); }
        for (let i = 0; i < n; i++) {
            const t = i / sr;
            for (let ch = 0; ch < 2; ch++) {
                let v = 0.3 * Math.sin(2 * Math.PI * 196 * t + ch)
                    + 0.2 * Math.sin(2 * Math.PI * 1244.5 * t);
                for (let k = 0; k < 30; k++) v += 0.012 * Math.sin(2 * Math.PI * partF[k] * t + partP[k] + ch);
                v += 0.02 * rnd();
                pcm[i * 2 + ch] = Math.max(-0.97, Math.min(0.97, v));
            }
        }
    } else { // noiseband
        let l1 = 0, l2 = 0;
        for (let i = 0; i < n; i++) {
            const w = rnd() * 0.5;
            l1 = 0.98 * l1 + 0.02 * w;
            l2 = 0.9 * l2 + 0.1 * w;
            pcm[i * 2] = Math.max(-0.9, Math.min(0.9, l2 * 3 + 0.15 * Math.sin(2 * Math.PI * 800 * i / sr)));
            pcm[i * 2 + 1] = pcm[i * 2] * 0.95;
        }
    }
    return pcm;
}

function ffDecode(path) {
    const run = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2', '-'], { maxBuffer: 1 << 28 });
    return new Float32Array(run.stdout.buffer, run.stdout.byteOffset, run.stdout.byteLength >> 2);
}
function snrDb(ref, dec) {
    const maxLag = 9000 * 2;
    let bestLag = 0, bestCorr = -Infinity;
    const probeLen = Math.min(ref.length, Math.max(0, dec.length - maxLag), 44100 * 2);
    for (let lag = 0; lag <= maxLag; lag += 2) {
        let corr = 0;
        for (let i = 0; i < probeLen; i += 17) corr += ref[i] * dec[i + lag];
        if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    const skip = 9216;
    const n = Math.min(ref.length, dec.length - bestLag) - skip * 2;
    let sig = 0, noise = 0;
    for (let i = skip; i < skip + n; i++) {
        const d = ref[i] - dec[i + bestLag];
        sig += ref[i] * ref[i];
        noise += d * d;
    }
    return 10 * Math.log10(sig / Math.max(noise, 1e-30));
}

const sr = 44100;
for (const kind of ['tonal', 'mix', 'noiseband']) {
    const pcm = genCorpus(kind, sr, 4);
    const raw = join(T, 'src.f32');
    writeFileSync(raw, Buffer.from(pcm.buffer));
    for (const br of [128, 192, 256]) {
        const t0 = Date.now();
        const mineBlob = encodeMP3(pcm, sr, 2, br);
        const encodeMs = Date.now() - t0;
        const minePath = join(T, `mine_${kind}_${br}.mp3`);
        writeFileSync(minePath, Buffer.from(await mineBlob.arrayBuffer()));
        const lamePath = join(T, `lame_${kind}_${br}.mp3`);
        execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'f32le', '-ar', String(sr), '-ac', '2', '-i', raw,
            '-c:a', 'libmp3lame', '-b:a', `${br}k`, lamePath]);
        const mineSnr = snrDb(pcm, ffDecode(minePath));
        const lameSnr = snrDb(pcm, ffDecode(lamePath));
        console.log(`${kind.padEnd(9)} ${br}k: mine=${mineSnr.toFixed(1)}dB lame=${lameSnr.toFixed(1)}dB gap=${(lameSnr - mineSnr).toFixed(1)} (${encodeMs}ms encode)`);
    }
}
