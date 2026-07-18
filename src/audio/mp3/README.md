# FlowCast self MP3 encoder

This directory contains FlowCast's self-hosted MPEG-1 Layer III encoder.
It is the fixed MP3 path used by the library and does not rely on native
WebCodecs MP3 encoding or external command-line encoders.

## Layout

- `engine.ts` — analysis, quantization, Huffman packing, and frame writing.
- `tables.ts` — Layer III tables, windows, scalefactor bands, and Huffman data.
- `index.ts` — public entrypoint for the self encoder.

## Current design choices

- MPEG-1 Layer III
- 32 / 44.1 / 48 kHz
- CBR output
- long-block encoder path
- left/right stereo only (M/S disabled in the fixed path)
- conservative low-pass tuned to suppress high-band chirps on difficult stereo material

## Why the old "recorder" sound persisted

The old path kept switching into an aggressive frame-level M/S stereo mode and
let too much difficult high-band content through the quantizer. On hard stereo
material that produced exactly the flute-like / recorder-like chirps the user
was hearing. The fixed path now stays in plain left/right stereo and uses a
conservative stereo low-pass so the self encoder spends its bits where it is
actually stable.

## Remaining limits

This encoder still does not implement short/mixed blocks or a full transient
switching model, so it is intentionally tuned toward stable stereo output over
maximum coding efficiency.
