const PREFIX = 'TabAudioRec';

// Global flag for the current JS context. Defaults to false so production
// behavior is quiet; each context (background, popup, manager, settings)
// can call setVerbose() with the loaded setting on boot.
let verboseEnabled = false;

export function setVerbose(enabled: boolean): void {
  verboseEnabled = enabled;
}

class Logger {
  private tag: string;

  constructor(tag: string) {
    this.tag = `[${PREFIX}:${tag}]`;
  }

  debug(...args: unknown[]): void {
    if (!verboseEnabled) return;
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
