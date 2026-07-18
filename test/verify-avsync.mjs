// A/V sync verification: inter-track start offsets must survive muxing, and
// sample timing must be anchored to timestamps (no rounding drift, VFR-safe).
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { MP4Muxer } from '../dist/esm/mux/mp4-muxer.js';
import { MP4Demuxer } from '../dist/esm/demux/mp4-demuxer.js';
import { TSDemuxer } from '../dist/esm/demux/ts-demuxer.js';
import { MemorySink } from '../dist/esm/io/sinks.js';

execFileSync('mkdir', ['-p', '/tmp/fc/out']);
let failures = 0;
const check = (ok, label, detail = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' ' + detail : ''}`);
};
function ff(args) { return execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { maxBuffer: 1 << 28 }); }
function probeStreams(path) {
    return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path]).toString()).streams;
}
function ffDecodeErrors(path) {
    try { execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }); return ''; }
    catch (e) { return String(e.stderr || e.message); }
}



async function demuxMp4(bytes) {
    const demux = new MP4Demuxer();
    return demux.demux(new Blob([bytes]));
}

function sliceAdts(adts) {
    const frames = [];
    let off = 0;
    while (off + 7 <= adts.length) {
        if (adts[off] !== 0xFF || (adts[off + 1] & 0xF0) !== 0xF0) { off++; continue; }
        const headerLen = (adts[off + 1] & 1) ? 7 : 9;
        const frameLen = ((adts[off + 3] & 3) << 11) | (adts[off + 4] << 3) | (adts[off + 5] >> 5);
        if (frameLen <= headerLen || off + frameLen > adts.length) break;
        frames.push(adts.subarray(off + headerLen, off + frameLen));
        off += frameLen;
    }
    return frames;
}

function buildAsc(sr, ch) {
    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const idx = rates.indexOf(sr);
    return new Uint8Array([(2 << 3) | (idx >> 1), ((idx & 1) << 7) | (ch << 3)]);
}

// Reference media: 4 s H.264 (30 fps) and 3 s AAC 48 kHz stereo.
ff(['-f', 'lavfi', '-i', 'testsrc2=duration=4:size=320x240:rate=30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30', '-pix_fmt', 'yuv420p', '/tmp/fc/out/av_v.mp4']);
ff(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=3:sample_rate=48000',
    '-ac', '2', '-c:a', 'aac', '-b:a', '128k', '/tmp/fc/out/av_a.aac']);

const videoSrc = await demuxMp4(readFileSync('/tmp/fc/out/av_v.mp4'));
const vTrack = videoSrc.videoTracks[0];
const aacFrames = sliceAdts(readFileSync('/tmp/fc/out/av_a.aac'));
const AAC_SR = 48000;
const aacDur = 1024 / AAC_SR;

const videoFileBytes = readFileSync('/tmp/fc/out/av_v.mp4');
async function loadVideoChunks() {
    const chunks = [];
    for (const s of vTrack.samples) {
        const data = s.data ?? videoFileBytes.subarray(s.offset, s.offset + s.size);
        chunks.push({
            data: new Uint8Array(data),
            timestamp: s.timestamp,
            decodeTimestamp: s.decodeTimestamp ?? s.timestamp,
            duration: s.duration,
            isKeyframe: s.isKeyframe,
            trackType: 'video',
        });
    }
    return chunks;
}

function muxAv(videoChunks, audioChunks) {
    const sink = new MemorySink();
    const mux = new MP4Muxer({
        format: 'mp4', mode: 'standard', maxFragmentDuration: 2, autoSync: true,
        video: { id: 1, type: 'video', codec: vTrack.codec, width: 320, height: 240 },
        audio: { id: 2, type: 'audio', codec: 'mp4a.40.2', sampleRate: AAC_SR, channelCount: 2 },
    }, sink);
    if (vTrack.codecConfig) mux.setVideoCodecConfig?.(vTrack.codecConfig);
    for (const c of videoChunks) mux.addVideoChunk(c, vTrack.codecConfig);
    mux.setAudioCodecConfig(buildAsc(AAC_SR, 2));
    for (const c of audioChunks) mux.addAudioChunk(c);
    mux.finalize();
    return sink.toBlob('video/mp4');
}

// ---- 1. Inter-track start offset: audio begins 0.48 s after video ----
{
    const OFFSET = 0.48;
    const videoChunks = await loadVideoChunks();
    const audioChunks = aacFrames.map((data, i) => ({
        data: new Uint8Array(data),
        timestamp: OFFSET + i * aacDur,
        duration: aacDur,
        isKeyframe: true,
        trackType: 'audio',
    }));
    const blob = muxAv(videoChunks, audioChunks);
    writeFileSync('/tmp/fc/out/av_offset.mp4', Buffer.from(await blob.arrayBuffer()));

    const streams = probeStreams('/tmp/fc/out/av_offset.mp4');
    const vs = streams.find((s) => s.codec_type === 'video');
    const as = streams.find((s) => s.codec_type === 'audio');
    const vStart = parseFloat(vs.start_time);
    const aStart = parseFloat(as.start_time);
    const errors = ffDecodeErrors('/tmp/fc/out/av_offset.mp4');
    check(Math.abs(vStart) < 0.005 && Math.abs(aStart - OFFSET) < 0.005 && errors === '',
        'audio-late start offset preserved via elst',
        `video=${vStart.toFixed(3)} audio=${aStart.toFixed(3)} (want 0 / ${OFFSET}) err=${JSON.stringify(errors.slice(0, 60))}`);
}

// ---- 2. Video-late variant (audio anchors the movie) ----
{
    const OFFSET = 0.36;
    const videoChunks = (await loadVideoChunks()).map((c) => ({
        ...c,
        timestamp: c.timestamp + OFFSET,
        decodeTimestamp: c.decodeTimestamp + OFFSET,
    }));
    const audioChunks = aacFrames.map((data, i) => ({
        data: new Uint8Array(data), timestamp: i * aacDur, duration: aacDur, isKeyframe: true, trackType: 'audio',
    }));
    const blob = muxAv(videoChunks, audioChunks);
    writeFileSync('/tmp/fc/out/av_offset_v.mp4', Buffer.from(await blob.arrayBuffer()));
    const streams = probeStreams('/tmp/fc/out/av_offset_v.mp4');
    const vStart = parseFloat(streams.find((s) => s.codec_type === 'video').start_time);
    const aStart = parseFloat(streams.find((s) => s.codec_type === 'audio').start_time);
    check(Math.abs(aStart) < 0.005 && Math.abs(vStart - OFFSET) < 0.005,
        'video-late start offset preserved via elst',
        `video=${vStart.toFixed(3)} audio=${aStart.toFixed(3)} (want ${OFFSET} / 0)`);
}

// ---- 3. VFR + lying constant duration: timing must follow timestamps ----
{
    const pattern = [1 / 30, 1 / 20, 1 / 60, 1 / 25];
    const base = await loadVideoChunks();
    let t = 0;
    const vfr = base.map((c, i) => {
        const chunk = {
            ...c,
            timestamp: t + (c.timestamp - c.decodeTimestamp),
            decodeTimestamp: t,
            duration: 1 / 30, // deliberately wrong constant duration
        };
        t += pattern[i % pattern.length];
        return chunk;
    });
    const audioChunks = aacFrames.map((data, i) => ({
        data: new Uint8Array(data), timestamp: i * aacDur, duration: aacDur, isKeyframe: true, trackType: 'audio',
    }));
    const blob = muxAv(vfr, audioChunks);
    const bytes = Buffer.from(await blob.arrayBuffer());
    writeFileSync('/tmp/fc/out/av_vfr.mp4', bytes);

    const round = await demuxMp4(new Uint8Array(bytes));
    const outSamples = round.videoTracks[0].samples;
    let maxErr = 0;
    for (let i = 0; i < Math.min(outSamples.length, vfr.length); i++) {
        const err = Math.abs((outSamples[i].decodeTimestamp ?? outSamples[i].timestamp) - vfr[i].decodeTimestamp);
        if (err > maxErr) maxErr = err;
    }
    const lastIn = vfr[vfr.length - 1].decodeTimestamp;
    const lastOut = outSamples[outSamples.length - 1].decodeTimestamp ?? outSamples[outSamples.length - 1].timestamp;
    check(maxErr < 0.002 && Math.abs(lastOut - lastIn) < 0.002,
        'VFR timestamps anchored (no drift from wrong durations)',
        `maxErr=${(maxErr * 1000).toFixed(2)}ms lastDelta=${((lastOut - lastIn) * 1000).toFixed(2)}ms over ${outSamples.length} samples`);
}

// ---- 4. Real TS end-to-end: demux skew equals remux skew ----
{
    ff(['-f', 'lavfi', '-i', 'testsrc2=duration=3:size=320x240:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=48000',
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-muxdelay', '0.7', '/tmp/fc/out/av_src.ts']);
    const tsBytes = readFileSync('/tmp/fc/out/av_src.ts');
    const demux = new TSDemuxer();
    const result = await demux.demux(new Blob([tsBytes]));
    const vt = result.videoTracks[0];
    const at = result.audioTracks[0];
    const sourceSkew = at.samples[0].timestamp - vt.samples[0].timestamp;

    const sink = new MemorySink();
    const mux = new MP4Muxer({
        format: 'mp4', mode: 'standard', maxFragmentDuration: 2, autoSync: true,
        video: { id: 1, type: 'video', codec: vt.codec, width: 320, height: 240 },
        audio: { id: 2, type: 'audio', codec: 'mp4a.40.2', sampleRate: at.sampleRate, channelCount: at.channelCount },
    }, sink);
    for (const s of vt.samples) {
        mux.addVideoChunk({
            data: s.data, timestamp: s.timestamp, decodeTimestamp: s.decodeTimestamp ?? s.timestamp,
            duration: s.duration, isKeyframe: s.isKeyframe, trackType: 'video',
        }, vt.codecConfig);
    }
    mux.setAudioCodecConfig(at.codecConfig ?? buildAsc(at.sampleRate, at.channelCount));
    for (const s of at.samples) {
        mux.addAudioChunk({ data: s.data, timestamp: s.timestamp, duration: s.duration, isKeyframe: true, trackType: 'audio' });
    }
    mux.finalize();
    writeFileSync('/tmp/fc/out/av_from_ts.mp4', Buffer.from(await sink.toBlob('video/mp4').arrayBuffer()));

    const streams = probeStreams('/tmp/fc/out/av_from_ts.mp4');
    const vStart = parseFloat(streams.find((s) => s.codec_type === 'video').start_time);
    const aStart = parseFloat(streams.find((s) => s.codec_type === 'audio').start_time);
    const outSkew = aStart - vStart;
    const errors = ffDecodeErrors('/tmp/fc/out/av_from_ts.mp4');
    check(Math.abs(outSkew - sourceSkew) < 0.01 && errors === '',
        'TS to MP4 keeps source A/V skew',
        `sourceSkew=${(sourceSkew * 1000).toFixed(1)}ms outSkew=${(outSkew * 1000).toFixed(1)}ms err=${JSON.stringify(errors.slice(0, 60))}`);
}

console.log(`\n${failures} failures`);
process.exit(failures ? 1 : 0);
