export interface Sink {
    write(data: Uint8Array): void;
    close(): void | Promise<void>;
}

export interface Source {
    read(offset: number, length: number): Promise<Uint8Array>;
    readonly size: number;
}
