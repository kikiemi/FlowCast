export type ContainerFormat =
    | 'mp4' | 'mov' | 'webm' | 'mkv' | 'avi' | 'flv' | '3gp' | 'ts' | 'm4a' | 'm4v'
    | 'ogg' | 'mp3' | 'wav' | 'flac' | 'aac' | 'mp2'
    | 'gif' | 'apng' | 'png' | 'jpeg' | 'webp' | 'bmp' | 'tiff' | 'ico';

export type TrackType = 'video' | 'audio';

export interface EncodedChunk {
    readonly data: Uint8Array;
    readonly timestamp: number; // presentation timestamp in seconds
    readonly duration: number;
    readonly isKeyframe: boolean;
    readonly trackType: TrackType;
    readonly decodeTimestamp?: number; // decode timestamp in seconds
    readonly compositionTimeOffset?: number; // presentation - decode timestamp in seconds
}

export interface TrackDescriptor {
    readonly id: number;
    readonly type: TrackType;
    readonly codec: string;
    readonly width?: number;
    readonly height?: number;
    readonly displayWidth?: number;
    readonly displayHeight?: number;
    readonly pixelAspectRatioNum?: number;
    readonly pixelAspectRatioDen?: number;
    readonly framerate?: number;
    readonly sampleRate?: number;
    readonly channelCount?: number;
    codecConfig?: Uint8Array;
}
