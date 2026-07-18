// FLAC encoder verification: ffmpeg must decode to bit-exact PCM with no warnings.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFlac } from '../dist/esm/audio/flac-encoder.js';

const T = join(tmpdir(), 'fc-flac');
execFileSync('mkdir', ['-p', T]);

function genMusic(seconds, sampleRate, channels) {
    const frames = Math.floor(seconds * sampleRate);
    const pcm = new Float32Array(frames * channels);
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
    for (let i = 0; i < frames; i++) {
        const t = i / sampleRate;
        for (let ch = 0; ch < channels; ch++) {
            const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 1.3 * t + ch);
            pcm[i * channels + ch] = Math.max(-0.99, Math.min(0.99,
                0.4 * env * Math.sin(2 * Math.PI * 220 * t)
                + 0.2 * Math.sin(2 * Math.PI * 1318.5 * t + ch)
                + 0.1 * env * Math.sin(2 * Math.PI * 4200 * t)
                + 0.03 * rnd()));
        }
    }
    return pcm;
}

function quantize16(pcm) {
    const out = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
        const v = pcm[i];
        let s = Math.round((v >= 1 ? 1 : v <= -1 ? -1 : v) * 32767);
        if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
        out[i] = s;
    }
    return out;
}

let failures = 0;
function check(ok, name, detail = '') {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' ' + detail : ''}`);
}

const cases = [
    ['music 44.1k stereo', () => genMusic(3, 44100, 2), 44100, 2],
    ['music 48k stereo', () => genMusic(2, 48000, 2), 48000, 2],
    ['music 44.1k mono', () => genMusic(2, 44100, 1), 44100, 1],
    ['music 8k mono', () => genMusic(2, 8000, 1), 8000, 1],
    ['music 11025Hz mono (hz16 tail)', () => genMusic(1, 11025, 1), 11025, 1],
    ['odd tail length', () => genMusic(1.2345, 44100, 2), 44100, 2],
    ['silence 44.1k stereo', () => new Float32Array(44100 * 2), 44100, 2],
    ['full-scale clip', () => { const p = genMusic(1, 44100, 2); for (let i = 0; i < p.length; i++) p[i] *= 3; return p; }, 44100, 2],
    ['hard-pan stereo', () => { const p = genMusic(2, 44100, 2); for (let i = 0; i < p.length; i += 2) p[i + 1] = 0; return p; }, 44100, 2],
];

for (const [name, gen, sr, ch] of cases) {
    const pcm = gen();
    const encoded = encodeFlac(pcm, sr, ch);
    const path = join(T, name.replace(/[^a-z0-9]+/gi, '_') + '.flac');
    writeFileSync(path, encoded);

    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries',
        'stream=codec_name,sample_rate,channels', '-of', 'csv=p=0', path]).toString().trim();
    const probeOk = probe === `flac,${sr},${ch}`;

    // Decode with warnings captured: CRC or MD5 mismatches surface here.
    const { spawnSync } = await import('node:child_process');
    const run = spawnSync('ffmpeg', ['-v', 'warning', '-i', path, '-f', 's16le', '-ac', String(ch), '-'],
        { maxBuffer: 1 << 28 });
    const stderr = run.stderr.toString();
    const decoded = new Int16Array(run.stdout.buffer, run.stdout.byteOffset, run.stdout.byteLength >> 1);
    const expected = quantize16(pcm);
    let exact = decoded.length === expected.length;
    if (exact) {
        for (let i = 0; i < expected.length; i++) {
            if (decoded[i] !== expected[i]) { exact = false; break; }
        }
    }
    const rawBytes = expected.length * 2;
    const ratio = encoded.length / rawBytes;
    check(probeOk && exact && stderr.length === 0, name,
        `probe=${probeOk} exact=${exact} warn=${JSON.stringify(stderr.slice(0, 80))} ratio=${(ratio * 100).toFixed(1)}%`);
}

console.log(`\n${failures} failures`);
process.exit(failures ? 1 : 0);
