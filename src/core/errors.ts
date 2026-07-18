type ErrorCode = 'DECODE' | 'ENCODE' | 'MUX' | 'DEMUX' | 'FORMAT' | 'INPUT' | 'OUTPUT' | 'ABORT' | 'IO' | 'OOM';

export class FlowCastError extends Error {
    readonly code: ErrorCode;
    constructor(message: string, code: ErrorCode) {
        super(message);
        this.name = 'FlowCastError';
        this.code = code;
    }
}

export class DemuxError extends FlowCastError {
    constructor(msg: string) { super(msg, 'DEMUX'); this.name = 'DemuxError'; }
}

export class DecodeError extends FlowCastError {
    constructor(msg: string) { super(msg, 'DECODE'); this.name = 'DecodeError'; }
}

export class EncodeError extends FlowCastError {
    constructor(msg: string) { super(msg, 'ENCODE'); this.name = 'EncodeError'; }
}

export class MuxError extends FlowCastError {
    constructor(msg: string) { super(msg, 'MUX'); this.name = 'MuxError'; }
}

export class IOError extends FlowCastError {
    constructor(msg: string) { super(msg, 'IO'); this.name = 'IOError'; }
}
