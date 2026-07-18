import type { ContainerFormat } from './media';

export interface VideoTrackConfig {
    id: number;
    type: 'video';
    codec: string;
    width: number;
    height: number;
    displayWidth?: number;
    displayHeight?: number;
    pixelAspectRatioNum?: number;
    pixelAspectRatioDen?: number;
    framerate: number;
    codecConfig?: Uint8Array;
}

export interface AudioTrackConfig {
    id: number;
    type: 'audio';
    codec: string;
    sampleRate: number;
    channelCount: number;
    codecConfig?: Uint8Array;
}

export interface MuxerConfig {
    format: ContainerFormat;
    mode: 'standard' | 'fragmented';
    maxFragmentDuration: number;
    autoSync: boolean;
    video?: VideoTrackConfig;
    audio?: AudioTrackConfig;
}
