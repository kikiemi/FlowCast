export type MpegAudioFormat = 'mp2' | 'mp3';

/** Formats the audio encode worker accepts. */
export type WorkerAudioFormat = MpegAudioFormat | 'flac' | 'aac';

export interface MpegAudioEncodeProgress {
    readonly completedFrames: number;
    readonly totalFrames: number;
}

export interface MpegAudioEncodeOptions {
    readonly onProgress?: (progress: MpegAudioEncodeProgress) => void;
}

export interface MpegAudioEncodeRequest {
    readonly format: WorkerAudioFormat;
    readonly pcm: Float32Array;
    readonly sampleRate: number;
    readonly channels: number;
    readonly bitrate: number;
}

export interface MpegAudioWorkerEncodeRequest {
    readonly kind: 'encode';
    readonly jobId: number;
    readonly request: MpegAudioEncodeRequest;
}

export interface MpegAudioWorkerProgressMessage {
    readonly kind: 'progress';
    readonly jobId: number;
    readonly progress: MpegAudioEncodeProgress;
}

export interface MpegAudioWorkerResultMessage {
    readonly kind: 'result';
    readonly jobId: number;
    readonly data: ArrayBuffer;
}

export interface MpegAudioWorkerErrorMessage {
    readonly kind: 'error';
    readonly jobId: number;
    readonly errorMessage: string;
}

export interface MpegAudioWorkerReadyMessage {
    readonly kind: 'ready';
}

export type MpegAudioWorkerRequest = MpegAudioWorkerEncodeRequest;

export type MpegAudioWorkerResponse =
    | MpegAudioWorkerReadyMessage
    | MpegAudioWorkerProgressMessage
    | MpegAudioWorkerResultMessage
    | MpegAudioWorkerErrorMessage;
