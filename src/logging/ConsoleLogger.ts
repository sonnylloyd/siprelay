import { Logger } from './Logger';

export class ConsoleLogger implements Logger {
  public info(message: string, meta?: any): void {
    console.log(`[INFO] ${message}`, meta || '');
  }

  public warn(message: string, meta?: any): void {
    console.warn(`[WARN] ${message}`, meta || '');
  }

  public error(message: string, meta?: any): void {
    console.error(`[ERROR] ${message}`, meta || '');
  }
}