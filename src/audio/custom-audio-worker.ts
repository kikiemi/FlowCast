import { encodeMP2 } from './mp2-encoder';
import { encodeFlac } from './flac-encoder';
import { encodeAacLc, wrapAdts } from './aac-encoder';
import { encodeMP3 } from './mp3-encoder';
import type {
    MpegAudioEncodeOptions,
    MpegAudioWorkerEncodeRequest,
    MpegAudioWorkerErrorMessage,
    MpegAudioWorkerProgressMessage,
    MpegAudioWorkerReadyMessage,
    MpegAudioWorkerResultMessage,
} from './mpeg-audio-types';

type AudioWorkerScope = {
    postMessage(message: unknown, transfer?: Transferable[]): void;
    addEventListener(type: 'message', listener: (event: MessageEvent<MpegAudioWorkerEncodeRequest>) => void): void;
};

// The project compiles against lib.dom, so `self` is typed as Window here;
// the structural interface above is the worker-scope surface actually used.
const workerScope = self as unknown as AudioWorkerScope;

function createProgressReporter(jobId: number): MpegAudioEncodeOptions['onProgress'] {
    return (progress) => {
        const message: MpegAudioWorkerProgressMessage = {
            kind: 'progress',
            jobId,
            progress,
        };
        workerScope.postMessage(message);
    };
}

async function encodeRequest(message: MpegAudioWorkerEncodeRequest): Promise<void> {
    const { jobId, request } = message;
    const encodeOptions: MpegAudioEncodeOptions = {
        onProgress: createProgressReporter(jobId),
    };
    let encodedBuffer: ArrayBuffer;
    if (request.format === 'aac') {
        const result = encodeAacLc(request.pcm, request.sampleRate, request.channels, request.bitrate, {
            onProgress: (completedFrames, totalFrames) => {
                encodeOptions.onProgress?.({ completedFrames, totalFrames });
            },
        });
        encodedBuffer = wrapAdts(result).buffer;
    } else if (request.format === 'flac') {
        const flac = encodeFlac(request.pcm, request.sampleRate, request.channels, {
            onProgress: (completedFrames, totalFrames) => {
                encodeOptions.onProgress?.({ completedFrames, totalFrames });
            },
        });
        encodedBuffer = flac.buffer;
    } else {
        const encoded = request.format === 'mp3'
            ? encodeMP3(request.pcm, request.sampleRate, request.channels, request.bitrate, encodeOptions)
            : encodeMP2(request.pcm, request.sampleRate, request.channels, request.bitrate, encodeOptions);
        encodedBuffer = await encoded.arrayBuffer();
    }
    const resultMessage: MpegAudioWorkerResultMessage = {
        kind: 'result',
        jobId,
        data: encodedBuffer,
    };
    workerScope.postMessage(resultMessage, [encodedBuffer]);
}

workerScope.addEventListener('message', (event: MessageEvent<MpegAudioWorkerEncodeRequest>) => {
    const message = event.data;
    if (!message || message.kind !== 'encode') return;

    void encodeRequest(message).catch((error: unknown) => {
        const errorMessage: MpegAudioWorkerErrorMessage = {
            kind: 'error',
            jobId: message.jobId,
            errorMessage: error instanceof Error ? error.message : String(error),
        };
        workerScope.postMessage(errorMessage);
    });
});

const readyMessage: MpegAudioWorkerReadyMessage = { kind: 'ready' };
workerScope.postMessage(readyMessage);

export {};
