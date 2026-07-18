export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

export class Logger {
    level: LogLevel = 'warn';

    debug(...args: unknown[]): void {
        if (LEVELS[this.level] <= LEVELS.debug) console.debug('[FlowCast]', ...args);
    }
    info(...args: unknown[]): void {
        if (LEVELS[this.level] <= LEVELS.info) console.info('[FlowCast]', ...args);
    }
    warn(...args: unknown[]): void {
        if (LEVELS[this.level] <= LEVELS.warn) console.warn('[FlowCast]', ...args);
    }
    error(...args: unknown[]): void {
        if (LEVELS[this.level] <= LEVELS.error) console.error('[FlowCast]', ...args);
    }
}

export const logger = new Logger();
