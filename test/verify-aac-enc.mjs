// AAC-LC encoder verification: ffmpeg must parse and decode with sane SNR.
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAacLc, wrapAdts } from '../dist/esm/audio/aac-encoder.js';

const T = join(tmpdir(), 'fc-aac');
execFileSync('mkdir', ['-p', T]);

function genMusic(seconds, sampleRate, channels) {
    const frames = Math.floor(seconds * sampleRate);
    const pcm = new Float32Array(frames * channels);
    let seed = 424242;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
    const partF = [], partP = [];
    for (let k = 0; k < 20; k++) { partF.push(250 + k * 620); partP.push(rnd() * Math.PI); }
    for (let i = 0; i < frames; i++) {
        const t = i / sampleRate;
        for (let ch = 0; ch < channels; ch++) {
            const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.9 * t + ch);
            let v = 0.34 * env * Math.sin(2 * Math.PI * 220 * t)
                + 0.22 * Math.sin(2 * Math.PI * 1108.7 * t + ch * 0.5)
                + 0.12 * env * Math.sin(2 * Math.PI * 3520 * t);
            for (let k = 0; k < 20; k++) v += 0.005 * Math.sin(2 * Math.PI * partF[k] * t + partP[k] + ch);
            pcm[i * channels + ch] = Math.max(-0.97, Math.min(0.97, v));
        }
    }
    return pcm;
}

function tone(freq, sampleRate, seconds, amp, channels) {
    const frames = Math.floor(seconds * sampleRate);
    const pcm = new Float32Array(frames * channels);
    for (let i = 0; i < frames; i++) {
        for (let ch = 0; ch < channels; ch++) pcm[i * channels + ch] = amp * Math.sin(2 * Math.PI * freq * i / sampleRate);
    }
    return pcm;
}

function ffDecode(path, channels) {
    const run = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'f32le', '-ac', String(channels), '-'], { maxBuffer: 1 << 28 });
    const stderr = run.stderr.toString();
    return { pcm: new Float32Array(run.stdout.buffer, run.stdout.byteOffset, run.stdout.byteLength >> 2), stderr };
}

function snrDb(ref, dec, channels) {
    const maxLag = 8192 * channels;
    let bestLag = 0, bestCorr = -Infinity;
    const probeLen = Math.min(ref.length, Math.max(0, dec.length - maxLag), 48000 * channels);
    for (let lag = 0; lag <= maxLag; lag += channels) {
        let corr = 0;
        for (let i = 0; i < probeLen; i += 13) corr += ref[i] * dec[i + lag];
        if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    const skip = 4096 * channels;
    const n = Math.min(ref.length, dec.length - bestLag) - skip * 2;
    let sig = 0, noise = 0;
    for (let i = skip; i < skip + n; i++) {
        const d = ref[i] - dec[i + bestLag];
        sig += ref[i] * ref[i];
        noise += d * d;
    }
    return { snr: 10 * Math.log10(sig / Math.max(noise, 1e-30)), lag: bestLag / channels };
}

let failures = 0;
function check(ok, name, detail = '') {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' ' + detail : ''}`);
}

const cases = [
    ['music 44.1k stereo 128k', genMusic(3, 44100, 2), 44100, 2, 128, 22],
    ['music 44.1k stereo 192k', genMusic(3, 44100, 2), 44100, 2, 192, 26],
    ['music 48k stereo 160k', genMusic(3, 48000, 2), 48000, 2, 160, 24],
    ['music 44.1k mono 96k', genMusic(3, 44100, 1), 44100, 1, 96, 24],
    ['music 32k mono 64k', genMusic(3, 32000, 1), 32000, 1, 64, 22],
    ['music 24k mono 48k', genMusic(3, 24000, 1), 24000, 1, 48, 20],
    ['sine 1k stereo 128k', tone(1000, 44100, 2, 0.5, 2), 44100, 2, 128, 40],
    ['sine 8k mono 96k', tone(8000, 44100, 2, 0.5, 1), 44100, 1, 96, 30],
];

for (const [name, pcm, sr, ch, br, minSnr] of cases) {
    const result = encodeAacLc(pcm, sr, ch, br);
    const adts = wrapAdts(result);
    const path = join(T, name.replace(/[^a-z0-9]+/gi, '_') + '.aac');
    writeFileSync(path, adts);

    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries',
        'stream=codec_name,profile,sample_rate,channels', '-of', 'csv=p=0', path]).toString().trim();
    const probeOk = probe === `aac,LC,${sr},${ch}`;

    const { pcm: decoded, stderr } = ffDecode(path, ch);
    const { snr, lag } = snrDb(pcm, decoded, ch);
    const bytesPerSec = adts.length / (pcm.length / ch / sr);
    const kbps = (bytesPerSec * 8) / 1000;
    const rateOk = kbps > br * 0.5 && kbps < br * 1.35;
    check(probeOk && stderr.length === 0 && snr >= minSnr && rateOk, name,
        `probe=[${probe}] snr=${snr.toFixed(1)}dB(min ${minSnr}) rate=${kbps.toFixed(0)}kbps lag=${lag} err=${JSON.stringify(stderr.slice(0, 60))}`);
}



// ---- m4a container integration: self-hosted frames through MP4Muxer ----
{
    const { MP4Muxer } = await import('../dist/esm/mux/mp4-muxer.js');
    const { MemorySink } = await import('../dist/esm/io/sinks.js');
    const sr = 44100, ch = 2;
    const pcm = genMusic(2.5, sr, ch);
    const enc = encodeAacLc(pcm, sr, ch, 160);
    const sink = new MemorySink();
    const muxer = new MP4Muxer({
        format: 'm4a', mode: 'standard', maxFragmentDuration: 2.0, autoSync: true,
        audio: { id: 1, type: 'audio', codec: 'mp4a.40.2', sampleRate: sr, channelCount: ch },
    }, sink);
    muxer.setAudioCodecConfig(enc.audioSpecificConfig);
    const frameSeconds = 1024 / sr;
    for (let i = 0; i < enc.frames.length; i++) {
        muxer.addAudioChunk({ data: enc.frames[i], timestamp: i * frameSeconds, duration: frameSeconds, isKeyframe: true, trackType: 'audio' });
    }
    muxer.finalize();
    const blob = sink.toBlob('audio/mp4');
    const m4aPath = join(T, 'selfhosted.m4a');
    writeFileSync(m4aPath, Buffer.from(await blob.arrayBuffer()));

    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries',
        'stream=codec_name,profile,sample_rate,channels', '-of', 'csv=p=0', m4aPath]).toString().trim();
    const { pcm: decoded, stderr } = ffDecode(m4aPath, ch);
    const { snr } = snrDb(pcm, decoded, ch);
    check(probe === `aac,LC,${sr},${ch}` && stderr.length === 0 && snr >= 24,
        'm4a mux (self-hosted frames)', `probe=[${probe}] snr=${snr.toFixed(1)}dB err=${JSON.stringify(stderr.slice(0, 60))}`);
}

// ---- ADTS frame slicing round-trip (converter helper contract) ----
{
    const sr = 32000, ch = 1;
    const pcm = genMusic(1.5, sr, ch);
    const enc = encodeAacLc(pcm, sr, ch, 64);
    const adts = wrapAdts(enc);
    // Re-slice and compare against the original access units byte for byte.
    const frames = [];
    let off = 0;
    while (off + 7 <= adts.length) {
        const headerLen = (adts[off + 1] & 1) ? 7 : 9;
        const frameLen = ((adts[off + 3] & 3) << 11) | (adts[off + 4] << 3) | (adts[off + 5] >> 5);
        frames.push(adts.subarray(off + headerLen, off + frameLen));
        off += frameLen;
    }
    let same = frames.length === enc.frames.length;
    if (same) {
        for (let i = 0; i < frames.length && same; i++) {
            if (frames[i].length !== enc.frames[i].length) { same = false; break; }
            for (let j = 0; j < frames[i].length; j++) {
                if (frames[i][j] !== enc.frames[i][j]) { same = false; break; }
            }
        }
    }
    check(same, 'ADTS slice round-trip', `${frames.length} frames`);
}

console.log(`\n${failures} failures (extended)`);
process.exit(failures ? 1 : 0);
