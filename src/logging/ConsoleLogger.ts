import { Logger } from './Logger';

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LOG_LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export class ConsoleLogger implements Logger {
  private readonly level: number;

  constructor() {
    const envLevel = (process.env.LOG_LEVEL || 'info').toLowerCase() as LogLevel;
    this.level = LOG_LEVELS[envLevel] ?? LOG_LEVELS.info;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] <= this.level;
  }

  public debug(message: string, meta?: any): void {
    if (!this.shouldLog('debug')) return;
    console.debug(`[DEBUG] ${message}`, meta || '');
  }

  public info(message: string, meta?: any): void {
    if (!this.shouldLog('info')) return;
    console.log(`[INFO] ${message}`, meta || '');
  }

  public warn(message: string, meta?: any): void {
    if (!this.shouldLog('warn')) return;
    console.warn(`[WARN] ${message}`, meta || '');
  }

  public error(message: string, meta?: any): void {
    if (!this.shouldLog('error')) return;
    console.error(`[ERROR] ${message}`, meta || '');
  }
}
