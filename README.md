# FlowCast

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)
![License](https://img.shields.io/badge/license-WTFPL-lightgrey)

**ブラウザーだけで動画・音声・画像を変換する、依存関係ゼロのTypeScriptメディア変換ライブラリ。**  
**A dependency-free TypeScript media conversion library for converting video, audio, and images directly in the browser.**

[日本語](#日本語) | [English](#english)

---

# 日本語

## 概要

FlowCastは、動画・音声・画像の変換処理をブラウザー内で実行するメディア変換ライブラリです。

MP2、MP3、FLAC、AAC-LCの内蔵エンコーダー、独自のMuxer／Demuxer、WebCodecsを組み合わせ、単純な画像変換から動画の再エンコード、音声抽出、GIF／APNG生成まで扱えます。

変換用サーバーや実行時npm依存パッケージは必要ありません。`dist/FlowCast.min.js`を読み込むだけで、静的サイトや`file://`ページからも利用できます。

## 主な特徴

- 動画・音声・画像をブラウザー内で変換
- 実行時依存関係ゼロ
- MP2／MP3／FLAC／AAC-LCの内蔵エンコーダー
- MP4、WebM、AVI、FLV、MPEG-TSなどの独自Muxer／Demuxer
- 対応コーデック同士では再エンコードを避けるダイレクトRemux
- 動画から音声を抽出
- 動画から静止画、GIF、APNGを生成
- ファイル拡張子ではなくヘッダーから形式を自動判定
- 進捗コールバックと`AbortSignal`によるキャンセル
- TypeScript型定義を同梱
- 単一ファイル版、ES Modules版の両方を生成
- Web Workerが利用できない場合はメインスレッド処理へフォールバック
- エラーを`FlowCastError`派生クラスとして通知

## 対応形式

### 動画コンテナ

| 形式 | 主な出力コーデック |
| --- | --- |
| MP4 / MOV / M4V | H.264 + AACを標準使用。HEVC、AV1、AC-3、E-AC-3はブラウザーやRemux条件に依存 |
| 3GP | H.264 + AAC |
| WebM / MKV | VP8 + Opusを標準使用。VP9、AV1にも対応 |
| AVI | H.264 + PCM |
| FLV | H.264 + AAC |
| MPEG-TS | H.264 / HEVC + AAC / AC-3 / E-AC-3 |

### 音声

| 形式 | 備考 |
| --- | --- |
| MP3 | 内蔵MPEG-1 Layer IIIエンコーダー |
| MP2 | 内蔵MPEG-1 Layer IIエンコーダー |
| AAC | AAC-LC、ADTS形式 |
| M4A | AAC-LCをMP4コンテナへ格納。互換条件では音声を直接Remux |
| FLAC | 内蔵ロスレスエンコーダー |
| OGG | Opus |
| WAV | PCM |

### 画像

`PNG`、`JPEG`、`WebP`、`BMP`、`TIFF`、`ICO`、`GIF`、`APNG`

### 変換できる組み合わせ

| 入力 | 出力 | 対応 |
| --- | --- | --- |
| 画像 | 画像 | 対応 |
| 音声 | 音声 | 対応 |
| 動画 | 動画 | 対応 |
| 動画 | 音声 | 対応 |
| 動画 | 静止画 / GIF / APNG | 対応 |
| 画像 | 音声 / 動画 | 非対応 |
| 音声 | 画像 / 動画 | 非対応 |

## ブラウザー要件

FlowCastはブラウザー向けに設計されています。処理内容に応じて、以下のWeb APIを使用します。

- WebCodecs: `VideoEncoder`、`VideoDecoder`、`AudioEncoder`、`AudioDecoder`
- Web Audio API: `AudioContext`、`OfflineAudioContext`
- Canvas API: `OffscreenCanvas`、`createImageBitmap`
- Blob、File、Worker

使用可能な動画・音声コーデックはブラウザーとOSに依存します。特に動画の再エンコードやOpus出力では、WebCodecsの対応状況を確認してください。

MP2、MP3、FLAC、AAC-LCには内蔵エンコーダーがありますが、入力ファイルのデコードや動画処理ではブラウザー機能を使用する場合があります。

## 導入方法

### リポジトリを取得してビルド

```bash
git clone https://github.com/kikiemi/Flow-Cast.git
cd Flow-Cast
npm install
npm run build
```

ビルド後、以下が生成されます。

```text
dist/FlowCast.js
dist/FlowCast.min.js
dist/esm/
dist/**/*.d.ts
```

## 単一ファイル版を使う

`dist/FlowCast.min.js`には、ライブラリ本体と音声Workerが埋め込まれています。

```html
<script src='./dist/FlowCast.min.js'></script>
<script>
    const converter = new FlowCast.FlowCastConverter({
        outputFormat: 'mp3'
    })
</script>
```

読み込み後、APIは同期的に`window.FlowCast`へ公開されます。

```js
window.FlowCast
window.FlowCastReady
```

準備完了時には`flowcast:ready`イベントも送出されます。

## 最小構成の変換例

次の例では、選択したファイルをMP3へ変換して保存します。

```html
<!doctype html>
<html lang='ja'>
<head>
    <meta charset='UTF-8'>
    <meta name='viewport' content='width=device-width, initial-scale=1'>
    <title>FlowCast Example</title>
</head>
<body>
    <input id='file' type='file' accept='audio/*,video/*'>
    <button id='convert' type='button'>MP3へ変換</button>
    <progress id='progress' max='100' value='0'></progress>
    <p id='status'></p>

    <script src='./dist/FlowCast.min.js'></script>
    <script>
        const fileInput = document.querySelector('#file')
        const convertButton = document.querySelector('#convert')
        const progress = document.querySelector('#progress')
        const status = document.querySelector('#status')

        convertButton.addEventListener('click', async () => {
            const file = fileInput.files?.[0]
            if (!file) return

            convertButton.disabled = true

            try {
                const converter = new FlowCast.FlowCastConverter({
                    outputFormat: 'mp3',
                    audioBitrate: 192000,
                    onProgress: (percent, message) => {
                        progress.value = percent
                        status.textContent = message
                    }
                })

                const output = await converter.convert(file)
                const url = URL.createObjectURL(output)
                const link = document.createElement('a')

                link.href = url
                link.download = `${file.name.replace(/\.[^.]+$/, '')}.mp3`
                link.click()

                setTimeout(() => URL.revokeObjectURL(url), 1000)
            } catch (error) {
                console.error(error)
                status.textContent = error instanceof Error ? error.message : String(error)
            } finally {
                convertButton.disabled = false
            }
        })
    </script>
</body>
</html>
```

## 出力形式を選択できる例

```js
const converter = new FlowCast.FlowCastConverter({
    outputFormat: 'webm',
    videoCodec: 'vp09.00.10.08',
    audioCodec: 'opus',
    width: 1280,
    height: 720,
    fps: 30,
    videoBitrate: 2500000,
    audioBitrate: 128000,
    onProgress: (percent, message) => {
        console.log(percent, message)
    }
})

const outputBlob = await converter.convert(inputFile)
```

## ES Modules版を使う

```js
import {
    FlowCastConverter,
    FlowCastError,
    encodeMP3,
    encodeMP2
} from './dist/esm/index.js'

const converter = new FlowCastConverter({
    outputFormat: 'flac'
})

const output = await converter.convert(file)
```

`package.json`のexportsを利用できる環境では、パッケージとして読み込むこともできます。

```js
import { FlowCastConverter } from 'flowcast'
```

FlowCastはブラウザー優先のライブラリです。Node.jsからES Modulesを読み込めますが、DOM、WebCodecs、Web Audio APIを必要とする変換処理は通常のNode.js環境だけでは実行できません。

## PCMからMP3／MP2を直接生成

`encodeMP3`と`encodeMP2`は、インターリーブ済みの`Float32Array` PCMを受け取ります。

```js
const mp3Blob = FlowCast.encodeMP3(
    interleavedPcm,
    44100,
    2,
    192
)

const mp2Blob = FlowCast.encodeMP2(
    interleavedPcm,
    48000,
    2,
    256
)
```

引数は次の順です。

```text
PCMデータ, サンプルレート, チャンネル数, ビットレートkbps
```

直接エンコーダーの主な制限:

- チャンネル数はモノラルまたはステレオ
- MP2／MP3のサンプルレートは32,000、44,100、48,000 Hz
- MP2はチャンネル数ごとにMPEG規格上の有効なビットレートを指定する必要あり
- `FlowCastConverter`を使う場合は、必要に応じてデコード、チャンネル変換、リサンプリングが行われる

## `FlowCastConfig`

```ts
interface FlowCastConfig {
    outputFormat: ContainerFormat
    videoCodec?: string
    audioCodec?: string
    width?: number
    height?: number
    fps?: number
    videoBitrate?: number
    audioBitrate?: number
    audioSampleRate?: number
    audioChannels?: number
    signal?: AbortSignal
    onProgress?: (progress: number, message: string) => void
}
```

| オプション | 説明 |
| --- | --- |
| `outputFormat` | 出力形式。コンストラクターでは未指定時に`mp4`を使用 |
| `videoCodec` | 出力動画コーデック。コンテナ非対応の場合は互換コーデックへ変更されることがある |
| `audioCodec` | 出力音声コーデック |
| `width`, `height` | 出力解像度。未指定時は元サイズを優先 |
| `fps` | 出力フレームレート。動画変換の標準値は30 |
| `videoBitrate` | 動画ビットレート。単位はbps |
| `audioBitrate` | 音声ビットレート。単位はbps |
| `audioSampleRate` | 出力サンプルレート |
| `audioChannels` | 出力チャンネル数 |
| `signal` | 変換を中断する`AbortSignal` |
| `onProgress` | 0〜100の進捗率と処理メッセージを受け取るコールバック |

## キャンセル

```js
const controller = new AbortController()

const converter = new FlowCast.FlowCastConverter({
    outputFormat: 'mp4',
    signal: controller.signal
})

const task = converter.convert(file)

cancelButton.addEventListener('click', () => {
    controller.abort()
})

const output = await task
```

## 主な公開API

### 高水準API

- `FlowCastConverter`
- `Pipeline`
- `DemuxerRegistry`

### 音声

- `encodeMP3`
- `encodeMP2`
- `encodeFlac`
- `encodeAacLc`
- `wrapAdts`
- `MpegAudioEncoder`

### 画像

- `encodePNG`
- `encodeJPEG`
- `encodeWebP`
- `encodeBMP`
- `encodeTIFF`
- `encodeICO`
- `AnimatedGifEncoder`
- `APNGEncoder`

### Muxer／Demuxer

- `MP4Muxer` / `MP4Demuxer`
- `WebMMuxer`
- `AVIMuxer` / `AVIDemuxer`
- `FLVMuxer` / `FLVDemuxer`
- `TSMuxer` / `TSDemuxer`
- `OGGMuxer`
- `FLACMuxer`
- `ADTSMuxer`
- `WAVMuxer`

### 入出力

- `BlobSource`
- `MemorySink`
- `StreamSink`

## エラー処理

```js
try {
    const output = await converter.convert(file)
} catch (error) {
    if (error instanceof FlowCast.FlowCastError) {
        console.error(error.code, error.message)
    } else {
        console.error(error)
    }
}
```

主なエラークラス:

- `FlowCastError`
- `DemuxError`
- `EncodeError`
- `MuxError`
- `IOError`

## 開発

```bash
npm install
npm run check
npm run build
```

### テスト

`ffmpeg`と`ffprobe`をPATHへ追加してから実行してください。

```bash
npm run verify
```

個別コマンド:

```bash
npm run verify:audio
npm run verify:media
npm run bench:mp3
```

テストスイートでは、以下を検証します。

- MP2エンコードとffmpegによるデコード比較
- MP3エンコードとffmpegによるデコード比較
- MPEG Layer I／IIデコーダー
- FLACのビット完全なラウンドトリップ
- AAC-LCとM4A統合
- OGG、FLAC、M4A、MPEG-TS、FLVなどのMux／Demux
- GIFのフレーム比較と差分圧縮

## プロジェクト構成

```text
src/
├── audio/       音声エンコーダー、デコーダー、Worker
├── core/        エラー、ロガー、バイナリ処理
├── demux/       コンテナ解析
├── image/       静止画、GIF、APNGエンコーダー
├── io/          Source / Sink
├── mux/         コンテナ生成
├── types/       公開型定義
├── converter.ts 高水準変換API
├── pipeline.ts  動画変換パイプライン
└── index.ts     公開エントリーポイント

dist/            ビルド済みファイル
scripts/         ビルドスクリプト
test/            検証・ベンチマーク
```

## 制限事項

- コーデックの利用可否はブラウザーとOSに依存します
- 大きなファイルでは、入力・中間データ・出力Blobによって多くのメモリを消費する場合があります
- 現在の高水準変換APIは基本的に先頭の動画トラックと音声トラックを使用します
- 画像入力から音声／動画、音声入力から画像／動画への変換には対応していません
- 動画からGIF／APNGを生成する場合、現在は最大30秒、最大15fpsです
- 静止画からGIF／APNGへ変換した場合は1フレームの画像になります
- OGG出力はOpusエンコーダーを必要とします
- MP3エンコーダーはロングブロック中心で、非常に強い過渡音を含む素材は改善の余地があります
- Node.js単体ではブラウザーAPIを使用する変換処理を実行できません

## ライセンス

WTFPL

---

# English

## Overview

FlowCast is a browser-first media conversion library for video, audio, and image files.

It combines built-in MP2, MP3, FLAC, and AAC-LC encoders with custom muxers, demuxers, and WebCodecs-based processing. It can handle tasks ranging from basic image conversion to video transcoding, audio extraction, and animated GIF or APNG generation.

No conversion server or runtime npm dependency is required. The self-contained `dist/FlowCast.min.js` build can be used on static hosting and even from `file://` pages.

## Features

- Convert video, audio, and images directly in the browser
- Zero runtime dependencies
- Built-in MP2, MP3, FLAC, and AAC-LC encoders
- Custom muxers and demuxers for MP4, WebM, AVI, FLV, MPEG-TS, and more
- Direct remuxing when the input codec is compatible with the output container
- Extract audio from video files
- Export video frames as still images, GIF, or APNG
- Detect formats from file headers instead of relying only on extensions
- Progress callbacks and cancellation through `AbortSignal`
- Bundled TypeScript declarations
- Both self-contained classic-script and ES Modules builds
- Audio Worker with a main-thread fallback
- Typed errors based on `FlowCastError`

## Supported formats

### Video containers

| Format | Main output codecs |
| --- | --- |
| MP4 / MOV / M4V | H.264 + AAC by default. HEVC, AV1, AC-3, and E-AC-3 depend on browser support or remux compatibility |
| 3GP | H.264 + AAC |
| WebM / MKV | VP8 + Opus by default, with VP9 and AV1 support |
| AVI | H.264 + PCM |
| FLV | H.264 + AAC |
| MPEG-TS | H.264 / HEVC + AAC / AC-3 / E-AC-3 |

### Audio

| Format | Notes |
| --- | --- |
| MP3 | Built-in MPEG-1 Layer III encoder |
| MP2 | Built-in MPEG-1 Layer II encoder |
| AAC | AAC-LC in ADTS format |
| M4A | AAC-LC in an MP4 container, with direct audio remuxing when compatible |
| FLAC | Built-in lossless encoder |
| OGG | Opus |
| WAV | PCM |

### Images

`PNG`, `JPEG`, `WebP`, `BMP`, `TIFF`, `ICO`, `GIF`, and `APNG`

### Conversion routes

| Input | Output | Supported |
| --- | --- | --- |
| Image | Image | Yes |
| Audio | Audio | Yes |
| Video | Video | Yes |
| Video | Audio | Yes |
| Video | Still image / GIF / APNG | Yes |
| Image | Audio / Video | No |
| Audio | Image / Video | No |

## Browser requirements

FlowCast is designed primarily for browsers. Depending on the conversion path, it uses the following Web APIs:

- WebCodecs: `VideoEncoder`, `VideoDecoder`, `AudioEncoder`, and `AudioDecoder`
- Web Audio API: `AudioContext` and `OfflineAudioContext`
- Canvas APIs: `OffscreenCanvas` and `createImageBitmap`
- Blob, File, and Worker

Available audio and video codecs depend on the browser and operating system. Video transcoding and Opus output in particular require suitable WebCodecs support.

FlowCast includes built-in MP2, MP3, FLAC, and AAC-LC encoders, but input decoding and video processing may still rely on browser capabilities.

## Installation

### Clone and build

```bash
git clone https://github.com/kikiemi/Flow-Cast.git
cd Flow-Cast
npm install
npm run build
```

The build produces:

```text
dist/FlowCast.js
dist/FlowCast.min.js
dist/esm/
dist/**/*.d.ts
```

## Using the single-file build

`dist/FlowCast.min.js` contains both the library and the embedded audio Worker.

```html
<script src='./dist/FlowCast.min.js'></script>
<script>
    const converter = new FlowCast.FlowCastConverter({
        outputFormat: 'mp3'
    })
</script>
```

The API is exposed synchronously as `window.FlowCast`.

```js
window.FlowCast
window.FlowCastReady
```

A `flowcast:ready` event is also dispatched when the bundle is ready.

## Minimal conversion example

The following example converts a selected audio or video file to MP3 and downloads the result.

```html
<!doctype html>
<html lang='en'>
<head>
    <meta charset='UTF-8'>
    <meta name='viewport' content='width=device-width, initial-scale=1'>
    <title>FlowCast Example</title>
</head>
<body>
    <input id='file' type='file' accept='audio/*,video/*'>
    <button id='convert' type='button'>Convert to MP3</button>
    <progress id='progress' max='100' value='0'></progress>
    <p id='status'></p>

    <script src='./dist/FlowCast.min.js'></script>
    <script>
        const fileInput = document.querySelector('#file')
        const convertButton = document.querySelector('#convert')
        const progress = document.querySelector('#progress')
        const status = document.querySelector('#status')

        convertButton.addEventListener('click', async () => {
            const file = fileInput.files?.[0]
            if (!file) return

            convertButton.disabled = true

            try {
                const converter = new FlowCast.FlowCastConverter({
                    outputFormat: 'mp3',
                    audioBitrate: 192000,
                    onProgress: (percent, message) => {
                        progress.value = percent
                        status.textContent = message
                    }
                })

                const output = await converter.convert(file)
                const url = URL.createObjectURL(output)
                const link = document.createElement('a')

                link.href = url
                link.download = `${file.name.replace(/\.[^.]+$/, '')}.mp3`
                link.click()

                setTimeout(() => URL.revokeObjectURL(url), 1000)
            } catch (error) {
                console.error(error)
                status.textContent = error instanceof Error ? error.message : String(error)
            } finally {
                convertButton.disabled = false
            }
        })
    </script>
</body>
</html>
```

## Video conversion example

```js
const converter = new FlowCast.FlowCastConverter({
    outputFormat: 'webm',
    videoCodec: 'vp09.00.10.08',
    audioCodec: 'opus',
    width: 1280,
    height: 720,
    fps: 30,
    videoBitrate: 2500000,
    audioBitrate: 128000,
    onProgress: (percent, message) => {
        console.log(percent, message)
    }
})

const outputBlob = await converter.convert(inputFile)
```

## Using ES Modules

```js
import {
    FlowCastConverter,
    FlowCastError,
    encodeMP3,
    encodeMP2
} from './dist/esm/index.js'

const converter = new FlowCastConverter({
    outputFormat: 'flac'
})

const output = await converter.convert(file)
```

Environments that support package exports can also import the package name:

```js
import { FlowCastConverter } from 'flowcast'
```

FlowCast is browser-first. Its ES Modules can be imported by Node.js, but conversion paths that require the DOM, WebCodecs, or the Web Audio API will not run in a standard Node.js environment without compatible polyfills or host APIs.

## Encoding PCM directly to MP3 or MP2

`encodeMP3` and `encodeMP2` accept interleaved `Float32Array` PCM data.

```js
const mp3Blob = FlowCast.encodeMP3(
    interleavedPcm,
    44100,
    2,
    192
)

const mp2Blob = FlowCast.encodeMP2(
    interleavedPcm,
    48000,
    2,
    256
)
```

Arguments are ordered as follows:

```text
PCM data, sample rate, channel count, bitrate in kbps
```

Main direct-encoder restrictions:

- Mono or stereo input
- MP2 and MP3 sample rates of 32,000, 44,100, or 48,000 Hz
- MP2 requires a legal MPEG Layer II bitrate for the selected channel mode
- `FlowCastConverter` can decode, remix channels, and resample when needed

## `FlowCastConfig`

```ts
interface FlowCastConfig {
    outputFormat: ContainerFormat
    videoCodec?: string
    audioCodec?: string
    width?: number
    height?: number
    fps?: number
    videoBitrate?: number
    audioBitrate?: number
    audioSampleRate?: number
    audioChannels?: number
    signal?: AbortSignal
    onProgress?: (progress: number, message: string) => void
}
```

| Option | Description |
| --- | --- |
| `outputFormat` | Output format. The converter constructor defaults to `mp4` when omitted |
| `videoCodec` | Requested output video codec. FlowCast may select a compatible fallback for the container |
| `audioCodec` | Requested output audio codec |
| `width`, `height` | Output dimensions. Source dimensions are preferred when omitted |
| `fps` | Output frame rate. The default video conversion value is 30 |
| `videoBitrate` | Video bitrate in bits per second |
| `audioBitrate` | Audio bitrate in bits per second |
| `audioSampleRate` | Requested output sample rate |
| `audioChannels` | Requested output channel count |
| `signal` | `AbortSignal` used to cancel conversion |
| `onProgress` | Callback receiving a percentage from 0 to 100 and a status message |

## Cancellation

```js
const controller = new AbortController()

const converter = new FlowCast.FlowCastConverter({
    outputFormat: 'mp4',
    signal: controller.signal
})

const task = converter.convert(file)

cancelButton.addEventListener('click', () => {
    controller.abort()
})

const output = await task
```

## Main public APIs

### High-level APIs

- `FlowCastConverter`
- `Pipeline`
- `DemuxerRegistry`

### Audio

- `encodeMP3`
- `encodeMP2`
- `encodeFlac`
- `encodeAacLc`
- `wrapAdts`
- `MpegAudioEncoder`

### Images

- `encodePNG`
- `encodeJPEG`
- `encodeWebP`
- `encodeBMP`
- `encodeTIFF`
- `encodeICO`
- `AnimatedGifEncoder`
- `APNGEncoder`

### Muxers and demuxers

- `MP4Muxer` / `MP4Demuxer`
- `WebMMuxer`
- `AVIMuxer` / `AVIDemuxer`
- `FLVMuxer` / `FLVDemuxer`
- `TSMuxer` / `TSDemuxer`
- `OGGMuxer`
- `FLACMuxer`
- `ADTSMuxer`
- `WAVMuxer`

### Input and output

- `BlobSource`
- `MemorySink`
- `StreamSink`

## Error handling

```js
try {
    const output = await converter.convert(file)
} catch (error) {
    if (error instanceof FlowCast.FlowCastError) {
        console.error(error.code, error.message)
    } else {
        console.error(error)
    }
}
```

Main error classes:

- `FlowCastError`
- `DemuxError`
- `EncodeError`
- `MuxError`
- `IOError`

## Development

```bash
npm install
npm run check
npm run build
```

### Verification

Add `ffmpeg` and `ffprobe` to your PATH before running the verification suite.

```bash
npm run verify
```

Individual commands:

```bash
npm run verify:audio
npm run verify:media
npm run bench:mp3
```

The test suite covers:

- MP2 encoding compared through ffmpeg decoding
- MP3 encoding compared through ffmpeg decoding
- MPEG Layer I and II decoding
- Bit-exact FLAC round trips
- AAC-LC and M4A integration
- Muxing and demuxing for OGG, FLAC, M4A, MPEG-TS, FLV, and related formats
- GIF frame comparison and frame-differencing behavior

## Project structure

```text
src/
├── audio/       Audio encoders, decoders, and Worker code
├── core/        Errors, logging, and binary utilities
├── demux/       Container parsing
├── image/       Still image, GIF, and APNG encoders
├── io/          Source and Sink implementations
├── mux/         Container writers
├── types/       Public type definitions
├── converter.ts High-level conversion API
├── pipeline.ts  Video conversion pipeline
└── index.ts     Public entry point

dist/            Built files
scripts/         Build scripts
test/            Verification and benchmarks
```

## Limitations

- Codec availability depends on the browser and operating system
- Large files may require substantial memory for input data, intermediate buffers, and the final output Blob
- The high-level conversion API currently uses the first primary video and audio tracks
- Image-to-audio, image-to-video, audio-to-image, and audio-to-video conversions are not supported
- Animated GIF and APNG output from video is currently limited to 30 seconds and 15 fps
- Converting a still image to GIF or APNG creates a single-frame output
- OGG output requires an available Opus encoder
- The MP3 encoder currently focuses on long blocks, so highly transient material remains an area for improvement
- Browser-dependent conversion paths cannot run in plain Node.js alone

## License

WTFPL
