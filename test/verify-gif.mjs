// GIF encoder verification: ffmpeg must decode our frames back at high PSNR.
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnimatedGifEncoder } from '../dist/esm/image/encoders.js';

const T = join(tmpdir(), 'fc-gif');
execFileSync('mkdir', ['-p', T]);

const W = 160, H = 120, FRAMES = 8;

function makeFrame(index) {
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            // smooth gradient background (dither quality test)
            rgba[i] = Math.round((x / (W - 1)) * 255);
            rgba[i + 1] = Math.round((y / (H - 1)) * 255);
            rgba[i + 2] = 96;
            rgba[i + 3] = 255;
        }
    }
    // moving solid box (frame-diff + crop test)
    const bx = 10 + index * 12, by = 30 + (index % 3) * 8;
    for (let y = by; y < by + 24 && y < H; y++) {
        for (let x = bx; x < bx + 24 && x < W; x++) {
            const i = (y * W + x) * 4;
            rgba[i] = 255; rgba[i + 1] = 40; rgba[i + 2] = 40;
        }
    }
    // static detailed patch (palette variety)
    for (let y = 90; y < 116; y++) {
        for (let x = 8; x < 60; x++) {
            const i = (y * W + x) * 4;
            rgba[i] = (x * 7 + y * 13) & 0xFF;
            rgba[i + 1] = (x * 3 ^ y * 5) & 0xFF;
            rgba[i + 2] = (x + y * 2) & 0xFF;
        }
    }
    return { data: rgba, width: W, height: H };
}

let failures = 0;
function check(ok, name, detail = '') {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' ' + detail : ''}`);
}

const enc = new AnimatedGifEncoder(W, H);
const sources = [];
let firstFrameBytes = 0;
for (let f = 0; f < FRAMES; f++) {
    const frame = makeFrame(f);
    sources.push(frame.data);
    enc.addFrameData(frame, 50);
}
const blob = await enc.encode();
const gif = Buffer.from(await blob.arrayBuffer());
const gifPath = join(T, 'out.gif');
writeFileSync(gifPath, gif);
firstFrameBytes = gif.length;

// Container-level probe
const probe = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
    'stream=nb_read_frames,width,height,codec_name', '-of', 'csv=p=0', gifPath]).toString().trim();
check(probe === `gif,${W},${H},${FRAMES}`, 'ffprobe stream', `[${probe}]`);

// Decode all frames to raw RGBA and compare per-frame PSNR.
const run = spawnSync('ffmpeg', ['-v', 'error', '-i', gifPath, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 28 });
const stderr = run.stderr.toString();
check(stderr.length === 0, 'ffmpeg decode clean', JSON.stringify(stderr.slice(0, 80)));
const raw = run.stdout;
const frameBytes = W * H * 4;
check(raw.length === frameBytes * FRAMES, 'decoded frame count', `${raw.length / frameBytes}`);

const psnrs = [];
for (let f = 0; f < FRAMES; f++) {
    const src = sources[f];
    let mse = 0;
    for (let p = 0; p < W * H; p++) {
        const si = p * 4;
        const di = f * frameBytes + p * 4;
        for (let c = 0; c < 3; c++) {
            const d = src[si + c] - raw[di + c];
            mse += d * d;
        }
    }
    mse /= W * H * 3;
    psnrs.push(10 * Math.log10(255 * 255 / Math.max(mse, 1e-9)));
}
const minPsnr = Math.min(...psnrs);
// The corpus includes a near-random-color patch; 255 colors + dither tops out
// around 32 dB there, while smooth content sits well above.
check(minPsnr >= 30, 'per-frame PSNR', `[${psnrs.map((p) => p.toFixed(1)).join(', ')}]dB`);

// Diff effectiveness proxy: bytes per non-first frame far below first frame cost.
{
    const one = new AnimatedGifEncoder(W, H);
    one.addFrameData(makeFrame(0), 50);
    const oneBytes = Buffer.from(await (await one.encode()).arrayBuffer()).length;
    const perExtra = (firstFrameBytes - oneBytes) / (FRAMES - 1);
    check(perExtra < oneBytes * 0.55, 'frame differencing shrinks frames',
        `first=${oneBytes}B, extra avg=${Math.round(perExtra)}B`);
}

// Identical consecutive frames stay tiny and decode identically.
{
    const rep = new AnimatedGifEncoder(W, H);
    const frame = makeFrame(2);
    rep.addFrameData(frame, 50);
    rep.addFrameData(frame, 50);
    rep.addFrameData(frame, 50);
    const repGif = Buffer.from(await (await rep.encode()).arrayBuffer());
    const repPath = join(T, 'rep.gif');
    writeFileSync(repPath, repGif);
    const rerun = spawnSync('ffmpeg', ['-v', 'error', '-i', repPath, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 27 });
    const okLen = rerun.stdout.length === frameBytes * 3;
    let same = okLen;
    if (okLen) {
        for (let c = 0; c < frameBytes && same; c++) {
            if (rerun.stdout[c] !== rerun.stdout[frameBytes * 2 + c]) same = false;
        }
    }
    check(okLen && same && rerun.stderr.length === 0, 'identical frames repeat cleanly', `bytes=${repGif.length}`);
}

console.log(`\n${failures} failures`);
process.exit(failures ? 1 : 0);
