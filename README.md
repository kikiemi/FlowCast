# FlowCast

FlowCast is a browser-first media format converter written in TypeScript with
no runtime dependencies. Audio encoding (MP3 and MP2) is fully self-hosted;
video paths use WebCodecs plus FlowCast's own muxers and demuxers.

## Using the single-file build

```html
<script src="FlowCast.min.js"></script>
<script>
    // window.FlowCast is ready synchronously after the script tag.
    const blob = FlowCast.encodeMP3(pcm, 44100, 2, 192);
</script>
```

`dist/FlowCast.js` (commented) and `dist/FlowCast.min.js` (comments stripped)
are fully self-contained: all modules and the audio worker are embedded, so a
single file works from `file://` pages and static hosting with no build step.
The MPEG audio worker starts from an embedded Blob URL and falls back to
on-thread encoding when workers are unavailable.

Bundler and Node users can import the ESM tree instead:

```js
import { FlowCast, encodeMP3 } from 'flowcast';
```

## Build

```bash
npm install
npm run build     # dist/FlowCast.js, dist/FlowCast.min.js, dist/esm/, dist/**.d.ts
npm run check     # tsc --noEmit
```

## Verification

`npm run verify` runs the encoder and container test suites. They require
`ffmpeg` and `ffprobe` on PATH and a completed build:

- `test/verify-mp2.mjs` - every legal Layer II rate/channel/sample-rate
  combination is encoded, decoded with ffmpeg, and checked for SNR against
  the source signal.
- `test/verify-mp3.mjs` - the same matrix for Layer III, plus a speed
  benchmark (set `FLOWCAST_OLD_ENGINE` to a previous compiled engine to
  compare).
- `test/verify-mux.mjs` - OGG/Opus, FLAC, and M4A muxing round-trips built
  from ffmpeg reference frames, plus MPEG-TS and FLV demuxing checks.
- `test/verify-mpeg-decode.mjs` - the built-in MPEG-1/2 Layer I/II decoder
  against ffmpeg's decoder (86 dB agreement), including ID3-prefixed,
  garbage-prefixed, and truncated streams.
- `test/verify-flac-enc.mjs` - the FLAC encoder must round-trip bit-exact
  through ffmpeg with zero warnings (CRC-8/CRC-16/MD5 all validated).
- `test/verify-aac-enc.mjs` - the AAC-LC encoder across rates and channel
  layouts, plus the m4a container integration and ADTS framing.
- `test/verify-gif.mjs` - GIF output decoded by ffmpeg and compared per
  frame (PSNR), plus frame-differencing size checks.
- `npm run bench:mp3` - side-by-side SNR against libmp3lame on tonal,
  mixed, and noise-band material.

## Audio encoders

The MPEG-1 Layer II and Layer III encoders share one ISO analysis filterbank
(the ISO 11172-3 Table 3-C.1 window) and are verified against ffmpeg's
decoder. Layer III applies a bitrate-dependent encoder lowpass and keeps the
full band from 160 kbps per channel; both encoders reuse their buffers across
frames, so no per-frame allocation happens during long encodes. The Layer III
psychoacoustic model spreads masking energy across scalefactor bands with
tonal/noise-dependent offsets and an absolute-hearing-threshold floor; on
mixed material it measures at or above libmp3lame on an SNR basis, while
transient-heavy content is the known gap (long blocks only, no block
switching).

FLAC output is produced by a built-in encoder (fixed + LPC prediction up to
order 8, partitioned Rice coding, per-frame stereo decorrelation, STREAMINFO
MD5). AAC-LC and M4A outputs prefer the platform's WebCodecs encoder and fall
back to a built-in AAC-LC encoder (long windows, two-loop quantization, full
huffman coding), so WAV to AAC/M4A/FLAC no longer depends on browser codec
availability. MP2 and MP3 inputs decode through decodeAudioData, WebCodecs,
and finally a built-in Layer I/II decoder, in that order.

## Notes

- Output containers: MP4/M4A, WebM/MKV, OGG (Opus), FLAC, WAV, MPEG audio
  (MP2/MP3), AVI, FLV, TS, animated GIF/APNG, and still images.
- Errors are thrown as typed `FlowCastError` subclasses (`DecodeError`,
  `EncodeError`, `DemuxError`, ...); no path silently produces an empty or
  fallback file.
