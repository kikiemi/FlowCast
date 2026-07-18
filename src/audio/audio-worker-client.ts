/** Off-thread MPEG audio encoding via a Web Worker. */

import { logger } from '../core/logger';
import { FLOWCAST_AUDIO_WORKER_SOURCE } from './audio-worker-inline-source';
import type {
    MpegAudioEncodeProgress,
    MpegAudioEncodeRequest,
    MpegAudioWorkerResponse,
} from './mpeg-audio-types';

interface PendingWorkerJob {
    readonly resolve: (data: ArrayBuffer) => void;
    readonly reject: (error: Error) => void;
    readonly onProgress?: (progress: MpegAudioEncodeProgress) => void;
}

const READY_TIMEOUT_MS = 5000;

/**
 * Client for the MPEG audio encoder worker.
 *
 * The worker script is an inline source string injected at build time and
 * started through a Blob URL, which also works from file:// pages. When the
 * inline source is absent (running straight from the source tree) encoding
 * stays on the calling thread. Jobs are only submitted after the worker
 * signals readiness, so a startup failure falls back to on-thread encoding
 * before any PCM has been transferred.
 */
export class AudioWorkerClient {
    private static sharedClient: AudioWorkerClient | null = null;

    static canUseWorker(): boolean {
        return typeof Worker !== 'undefined' && FLOWCAST_AUDIO_WORKER_SOURCE.length > 0;
    }

    static getShared(): AudioWorkerClient | null {
        if (!AudioWorkerClient.canUseWorker()) return null;
        AudioWorkerClient.sharedClient ??= new AudioWorkerClient();
        return AudioWorkerClient.sharedClient;
    }

    private readonly pendingJobs = new Map<number, PendingWorkerJob>();
    private worker: Worker | null = null;
    private workerBlobUrl: string | null = null;
    private ready: Promise<void> | null = null;
    private markReady: (() => void) | null = null;
    private nextJobId = 1;

    private readonly onWorkerMessage = (event: MessageEvent<MpegAudioWorkerResponse>): void => {
        const message = event.data;
        if (!message) return;
        if (message.kind === 'ready') {
            this.markReady?.();
            this.markReady = null;
            return;
        }
        const pendingJob = this.pendingJobs.get(message.jobId);
        if (!pendingJob) return;

        if (message.kind === 'progress') {
            pendingJob.onProgress?.(message.progress);
            return;
        }

        this.pendingJobs.delete(message.jobId);
        if (message.kind === 'result') {
            pendingJob.resolve(message.data);
            return;
        }

        pendingJob.reject(new Error(message.errorMessage));
    };

    private readonly onWorkerFailure = (event: ErrorEvent): void => {
        const failure = new Error(event.message || 'Audio worker crashed');
        logger.warn('[AudioWorkerClient] worker failure:', failure);
        this.rejectAll(failure);
        this.disposeWorker();
    };

    /**
     * Encode on the worker. The PCM buffer is transferred (zero-copy), so it
     * is detached in the caller once the job has been submitted; readiness is
     * awaited first, keeping the buffer intact when startup fails.
     */
    async encode(
        request: MpegAudioEncodeRequest,
        onProgress?: (progress: MpegAudioEncodeProgress) => void,
    ): Promise<ArrayBuffer> {
        const worker = this.ensureWorker();
        await this.waitUntilReady();
        return new Promise<ArrayBuffer>((resolve, reject) => {
            const jobId = this.nextJobId++;
            this.pendingJobs.set(jobId, { resolve, reject, onProgress });
            worker.postMessage(
                { kind: 'encode', jobId, request },
                [request.pcm.buffer],
            );
        });
    }

    private ensureWorker(): Worker {
        if (this.worker) return this.worker;

        if (FLOWCAST_AUDIO_WORKER_SOURCE.length === 0) {
            throw new Error('Audio worker source was not injected into this build');
        }
        const blob = new Blob([FLOWCAST_AUDIO_WORKER_SOURCE], { type: 'text/javascript' });
        this.workerBlobUrl = URL.createObjectURL(blob);
        const worker = new Worker(this.workerBlobUrl);

        this.ready = new Promise<void>((resolve, reject) => {
            this.markReady = resolve;
            setTimeout(() => {
                if (this.markReady) {
                    this.markReady = null;
                    reject(new Error(`Audio worker did not become ready within ${READY_TIMEOUT_MS}ms`));
                    this.disposeWorker();
                }
            }, READY_TIMEOUT_MS);
        });
        worker.addEventListener('message', this.onWorkerMessage);
        worker.addEventListener('error', this.onWorkerFailure);
        this.worker = worker;
        return worker;
    }

    private async waitUntilReady(): Promise<void> {
        if (!this.ready) throw new Error('Audio worker was not started');
        await this.ready;
    }

    private rejectAll(error: Error): void {
        for (const [jobId, pendingJob] of this.pendingJobs) {
            this.pendingJobs.delete(jobId);
            pendingJob.reject(error);
        }
    }

    private disposeWorker(): void {
        if (this.worker) {
            this.worker.removeEventListener('message', this.onWorkerMessage);
            this.worker.removeEventListener('error', this.onWorkerFailure);
            this.worker.terminate();
            this.worker = null;
        }
        if (this.workerBlobUrl) {
            URL.revokeObjectURL(this.workerBlobUrl);
            this.workerBlobUrl = null;
        }
        this.ready = null;
        this.markReady = null;
        AudioWorkerClient.sharedClient = null;
    }
}
