const PREFIX = 'TabAudioRec';

class Logger {
  private tag: string;

  constructor(tag: string) {
    this.tag = `[${PREFIX}:${tag}]`;
  }

  debug(...args: unknown[]): void {
    console.debug(this.tag, ...args);
  }

  info(...args: unknown[]): void {
    console.info(this.tag, ...args);
  }

  warn(...args: unknown[]): void {
    console.warn(this.tag, ...args);
  }

  error(...args: unknown[]): void {
    console.error(this.tag, ...args);
  }
}

export function createLogger(tag: string): Logger {
  return new Logger(tag);
}
