declare const __FLOWCAST_AUDIO_WORKER_SOURCE__: string;

export const FLOWCAST_AUDIO_WORKER_SOURCE =
    typeof __FLOWCAST_AUDIO_WORKER_SOURCE__ === 'string'
        ? __FLOWCAST_AUDIO_WORKER_SOURCE__
        : '';
