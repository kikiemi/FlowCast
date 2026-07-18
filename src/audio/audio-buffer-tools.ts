export interface InterleaveProgressOptions {
    chunkFrames?: number;
    onChunk?: (processedFrames: number, totalFrames: number) => void | Promise<void>;
}

export function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

export function collectChannelViews(audioBuffer: AudioBuffer, channelCount: number): Float32Array[] {
    const views = new Array<Float32Array>(channelCount);
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
        views[channelIndex] = audioBuffer.getChannelData(channelIndex);
    }
    return views;
}

export function fillInterleavedBlock(
    channelViews: readonly Float32Array[],
    frameOffset: number,
    frameCount: number,
    scratch: Float32Array<ArrayBuffer>,
): Float32Array<ArrayBuffer> {
    const channelCount = channelViews.length;
    let writeIndex = 0;
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
        const sampleIndex = frameOffset + frameIndex;
        for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
            scratch[writeIndex++] = channelViews[channelIndex][sampleIndex];
        }
    }
    return scratch.subarray(0, frameCount * channelCount);
}

export async function interleaveAudioBuffer(
    audioBuffer: AudioBuffer,
    channelCount: number,
    options: InterleaveProgressOptions = {},
): Promise<Float32Array> {
    const interleaved = new Float32Array(audioBuffer.length * channelCount);
    const channelViews = collectChannelViews(audioBuffer, channelCount);
    const chunkFrames = options.chunkFrames ?? 16384;

    for (let frameOffset = 0; frameOffset < audioBuffer.length; frameOffset += chunkFrames) {
        const frameCount = Math.min(chunkFrames, audioBuffer.length - frameOffset);
        let writeIndex = frameOffset * channelCount;
        for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
            const sampleIndex = frameOffset + frameIndex;
            for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
                interleaved[writeIndex++] = channelViews[channelIndex][sampleIndex];
            }
        }

        if (options.onChunk) {
            await options.onChunk(frameOffset + frameCount, audioBuffer.length);
        }
    }

    return interleaved;
}

export async function renderAudioBuffer(
    audioBuffer: AudioBuffer,
    targetSampleRate: number,
    targetChannels: number,
): Promise<AudioBuffer> {
    if (
        audioBuffer.sampleRate === targetSampleRate &&
        audioBuffer.numberOfChannels === targetChannels
    ) {
        return audioBuffer;
    }

    const offlineContext = new OfflineAudioContext(
        targetChannels,
        Math.ceil(audioBuffer.duration * targetSampleRate),
        targetSampleRate,
    );
    const sourceNode = offlineContext.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(offlineContext.destination);
    sourceNode.start();
    return offlineContext.startRendering();
}

export async function encodeAudioBufferWithEncoder(
    audioBuffer: AudioBuffer,
    framesPerChunk: number,
    handleAudioData: (audioData: AudioData) => void | Promise<void>,
): Promise<void> {
    const channelViews = collectChannelViews(audioBuffer, audioBuffer.numberOfChannels);
    const scratch = new Float32Array(framesPerChunk * audioBuffer.numberOfChannels);

    for (let frameOffset = 0, chunkIndex = 0; frameOffset < audioBuffer.length; frameOffset += framesPerChunk, chunkIndex++) {
        const frameCount = Math.min(framesPerChunk, audioBuffer.length - frameOffset);
        const interleaved = fillInterleavedBlock(channelViews, frameOffset, frameCount, scratch);
        const audioPayload = interleaved;
        const audioData = new AudioData({
            format: 'f32',
            sampleRate: audioBuffer.sampleRate,
            numberOfFrames: frameCount,
            numberOfChannels: audioBuffer.numberOfChannels,
            timestamp: Math.round((frameOffset / audioBuffer.sampleRate) * 1e6),
            data: audioPayload,
        });

        try {
            await handleAudioData(audioData);
        } finally {
            audioData.close();
        }

        if ((chunkIndex & 15) === 15) {
            await yieldToEventLoop();
        }
    }
}
