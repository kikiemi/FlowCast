// Container verification: feed real encoder output through FlowCast muxers,
// validate the result with ffprobe/ffmpeg; demux ffmpeg-made containers with
// FlowCast demuxers and check structure.
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { OGGMuxer } from '../dist/esm/mux/ogg-muxer.js';
import { FLACMuxer } from '../dist/esm/mux/flac-muxer.js';
import { MP4Muxer } from '../dist/esm/mux/mp4-muxer.js';
import { MemorySink } from '../dist/esm/io/sinks.js';
import { TSDemuxer } from '../dist/esm/demux/ts-demuxer.js';
import { FLVDemuxer } from '../dist/esm/demux/flv-demuxer.js';

let failures = 0;
const check = (ok, label, detail = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' ' + detail : ''}`);
};

function ff(args) { return execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { maxBuffer: 1 << 28 }); }
function ffprobeStream(path) {
    return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]).toString());
}
function ffDecodeErrors(path) {
    try { execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }); return ''; }
    catch (e) { return String(e.stderr || e.message); }
}

// Source PCM: 3 s, 48 kHz stereo sine.
{
    const sr = 48000, secs = 3, n = sr * secs;
    const pcm = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
        pcm[i * 2] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr);
        pcm[i * 2 + 1] = 0.5 * Math.sin(2 * Math.PI * 660 * i / sr);
    }
    writeFileSync('/tmp/fc/out/src48.f32', Buffer.from(pcm.buffer));
}
const SRC = ['-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', '/tmp/fc/out/src48.f32'];

// ---- 1. OGG/Opus: ffmpeg opus packets -> OGGMuxer ----
{
    ff([...SRC, '-c:a', 'libopus', '-b:a', '96k', '/tmp/fc/out/ref.opus.ogg']);
    const bytes = readFileSync('/tmp/fc/out/ref.opus.ogg');
    // Minimal Ogg page parser to recover packets.
    const packets = [];
    let pending = [];
    for (let pos = 0; pos + 27 <= bytes.length;) {
        if (!(bytes[pos] === 0x4F && bytes[pos + 1] === 0x67 && bytes[pos + 2] === 0x67 && bytes[pos + 3] === 0x53)) { pos++; continue; }
        const segCount = bytes[pos + 26];
        const segTable = bytes.subarray(pos + 27, pos + 27 + segCount);
        let p = pos + 27 + segCount;
        for (const lace of segTable) {
            pending.push(bytes.subarray(p, p + lace));
            p += lace;
            if (lace < 255) {
                const size = pending.reduce((a, c) => a + c.length, 0);
                const pkt = new Uint8Array(size);
                let o = 0;
                for (const c of pending) { pkt.set(c, o); o += c.length; }
                packets.push(pkt);
                pending = [];
            }
        }
        pos = p;
    }
    // packets[0]=OpusHead, [1]=OpusTags, rest = audio (20 ms each by default).
    const head = packets[0];
    check(head && head.length >= 19 && String.fromCharCode(...head.subarray(0, 8)) === 'OpusHead', 'opus: parsed OpusHead from ffmpeg reference');
    const audioPackets = packets.slice(2);
    const sink = new MemorySink();
    const mux = new OGGMuxer({
        format: 'ogg', mode: 'standard', maxFragmentDuration: 2, autoSync: true,
        audio: { id: 1, type: 'audio', codec: 'opus', sampleRate: 48000, channelCount: 2, codecConfig: new Uint8Array(head) },
    }, sink);
    for (let i = 0; i < audioPackets.length; i++) {
        mux.addAudioChunk({ data: audioPackets[i], timestamp: i * 0.02, duration: 0.02, isKeyframe: true, trackType: 'audio' });
    }
    mux.finalize();
    writeFileSync('/tmp/fc/out/mux.opus.ogg', sink.toUint8Array());
    const errs = ffDecodeErrors('/tmp/fc/out/mux.opus.ogg');
    const probe = ffprobeStream('/tmp/fc/out/mux.opus.ogg');
    const st = probe.streams[0];
    const dur = parseFloat(probe.format.duration);
    check(errs === '', 'opus: ffmpeg decodes muxed ogg without errors', errs.slice(0, 120));
    check(st.codec_name === 'opus' && st.channels === 2, 'opus: stream identity', `${st.codec_name}/${st.channels}ch`);
    check(Math.abs(dur - 3.0) < 0.15, 'opus: duration ~3.0s', `got ${dur}`);
    // Page batching sanity: our file should be smaller than one-page-per-packet overhead.
    const refSize = bytes.length;
    const ourSize = sink.toUint8Array().length;
    check(ourSize < refSize * 1.15, 'opus: container overhead sane', `ours=${ourSize} ref=${refSize}`);
}

// ---- 2. FLAC: ffmpeg stream -> FLACMuxer passthrough ----
{
    ff([...SRC, '-c:a', 'flac', '-f', 'flac', '/tmp/fc/out/ref.flac']);
    const bytes = readFileSync('/tmp/fc/out/ref.flac');
    // Split header (fLaC + metadata blocks) from frames.
    let pos = 4;
    for (; ;) {
        const last = (bytes[pos] & 0x80) !== 0;
        const size = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
        pos += 4 + size;
        if (last) break;
    }
    const header = new Uint8Array(bytes.subarray(0, pos));
    const frames = new Uint8Array(bytes.subarray(pos));
    const sink = new MemorySink();
    const mux = new FLACMuxer(sink, 48000, 2, 16, header);
    mux.addAudioChunk({ data: frames, timestamp: 0, duration: 3, isKeyframe: true, trackType: 'audio' });
    mux.finalize();
    writeFileSync('/tmp/fc/out/mux.flac', sink.toUint8Array());
    const errs = ffDecodeErrors('/tmp/fc/out/mux.flac');
    const st = ffprobeStream('/tmp/fc/out/mux.flac').streams[0];
    check(errs === '', 'flac: ffmpeg decodes muxed flac without errors', errs.slice(0, 120));
    check(st.codec_name === 'flac' && +st.sample_rate === 48000 && st.channels === 2, 'flac: stream identity', `${st.codec_name}/${st.sample_rate}/${st.channels}ch`);
}

// ---- 3. m4a: ffmpeg ADTS -> raw AAC -> MP4Muxer ----
{
    ff([...SRC, '-c:a', 'aac', '-b:a', '128k', '-f', 'adts', '/tmp/fc/out/ref.aac']);
    const bytes = readFileSync('/tmp/fc/out/ref.aac');
    const frames = [];
    let sr = 48000, ch = 2, freqIdx = 3;
    for (let pos = 0; pos + 7 <= bytes.length;) {
        if (!(bytes[pos] === 0xFF && (bytes[pos + 1] & 0xF0) === 0xF0)) { pos++; continue; }
        freqIdx = (bytes[pos + 2] >> 2) & 0x0F;
        sr = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350][freqIdx] ?? 48000;
        ch = ((bytes[pos + 2] & 1) << 2) | ((bytes[pos + 3] >> 6) & 3);
        const frameLength = ((bytes[pos + 3] & 3) << 11) | (bytes[pos + 4] << 3) | (bytes[pos + 5] >> 5);
        if (frameLength < 7 || pos + frameLength > bytes.length) break;
        const headerLen = (bytes[pos + 1] & 1) ? 7 : 9;
        frames.push(new Uint8Array(bytes.subarray(pos + headerLen, pos + frameLength)));
        pos += frameLength;
    }
    check(frames.length > 100, 'm4a: split ADTS reference frames', `n=${frames.length}`);
    const asc = Uint8Array.from([(2 << 3) | (freqIdx >> 1), ((freqIdx & 1) << 7) | (ch << 3)]);
    const sink = new MemorySink();
    const mux = new MP4Muxer({
        format: 'm4a', mode: 'standard', maxFragmentDuration: 2, autoSync: true,
        audio: { id: 1, type: 'audio', codec: 'mp4a.40.2', sampleRate: sr, channelCount: ch, codecConfig: asc },
    }, sink);
    for (let i = 0; i < frames.length; i++) {
        mux.addAudioChunk({ data: frames[i], timestamp: i * 1024 / sr, duration: 1024 / sr, isKeyframe: true, trackType: 'audio' });
    }
    mux.finalize();
    writeFileSync('/tmp/fc/out/mux.m4a', sink.toUint8Array());
    const errs = ffDecodeErrors('/tmp/fc/out/mux.m4a');
    const probe = ffprobeStream('/tmp/fc/out/mux.m4a');
    const st = probe.streams[0];
    const dur = parseFloat(probe.format.duration);
    check(errs === '', 'm4a: ffmpeg decodes muxed m4a without errors', errs.slice(0, 120));
    check(st.codec_name === 'aac' && +st.sample_rate === sr && st.channels === ch, 'm4a: stream identity', `${st.codec_name}/${st.sample_rate}/${st.channels}ch`);
    check(Math.abs(dur - 3.0) < 0.2, 'm4a: duration ~3.0s', `got ${dur}`);
}

// ---- 4. TSDemuxer: aac + mp2 in mpegts ----
for (const [codec, spf, codecName] of [['aac', 1024, 'mp4a.40.2'], ['mp2', 1152, 'mp2']]) {
    ff([...SRC, '-c:a', codec, '-f', 'mpegts', `/tmp/fc/out/ref.${codec}.ts`]);
    const file = new Blob([readFileSync(`/tmp/fc/out/ref.${codec}.ts`)]);
    const demux = new TSDemuxer();
    const result = await demux.demux(file);
    const track = result.audioTracks[0];
    const expected = Math.floor(3 * 48000 / spf);
    const monotonic = track ? track.samples.every((s, i, a) => i === 0 || s.timestamp >= a[i - 1].timestamp - 1e-9) : false;
    check(!!track, `ts(${codec}): audio track found`);
    if (track) {
        check(track.sampleRate === 48000, `ts(${codec}): sampleRate from headers`, `got ${track.sampleRate}`);
        check(Math.abs(track.samples.length - expected) <= 4, `ts(${codec}): frame count ~${expected}`, `got ${track.samples.length}`);
        check(monotonic, `ts(${codec}): PTS monotonic`);
        check(track.codec === codecName, `ts(${codec}): codec id`, `got ${track.codec}`);
        if (codec === 'mp2') {
            const first = track.samples[0].data;
            check(first[0] === 0xFF && (first[1] & 0xE0) === 0xE0, 'ts(mp2): frames keep MPEG sync');
        }
    }
}

// ---- 5. FLVDemuxer: mp3@44.1k rate from frame header ----
{
    ff([...SRC, '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'flv', '/tmp/fc/out/ref.mp3.flv']);
    const file = new Blob([readFileSync('/tmp/fc/out/ref.mp3.flv')]);
    const result = await new FLVDemuxer().demux(file);
    const track = result.audioTracks[0];
    check(!!track && track.sampleRate === 44100, 'flv(mp3): real sample rate from frame header', `got ${track?.sampleRate}`);
}

console.log(`\n${failures} failures`);
process.exit(failures ? 1 : 0);
