const PREFIX = 'TabAudioRec';

// Global flag for the current JS context. Defaults to false so production
// behavior is quiet; each context (background, popup, manager, settings)
// can call setVerbose() with the loaded setting on boot.
let verboseEnabled = false;

export function setVerbose(enabled: boolean): void {
  verboseEnabled = enabled;
}

// E2E-only in-context log buffer. The Selenium suite reads the background's copy
// via the TEST_GET_LOGS bridge so a failing test can show *why* (which strategy,
// what error). `__TEST_BRIDGE__` is false in production, so this whole buffer is
// dead-code-eliminated from release builds.
const logBuffer: string[] = [];
const MAX_BUFFER = 500;

function stringifyArg(a: unknown): string {
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function capture(level: string, tag: string, args: unknown[]): void {
  if (!__TEST_BRIDGE__) return;
  try {
    logBuffer.push(`${new Date().toISOString()} ${level} ${tag} ${args.map(stringifyArg).join(' ')}`);
    if (logBuffer.length > MAX_BUFFER) logBuffer.shift();
  } catch {
    // Diagnostics must never throw.
  }
}

/** Snapshot of this context's captured log lines (E2E builds only). */
export function getLogBuffer(): string[] {
  return [...logBuffer];
}

class Logger {
  private tag: string;

  constructor(tag: string) {
    this.tag = `[${PREFIX}:${tag}]`;
  }

  debug(...args: unknown[]): void {
    capture('DEBUG', this.tag, args);
    if (!verboseEnabled) return;
    console.debug(this.tag, ...args);
  }

  info(...args: unknown[]): void {
    capture('INFO', this.tag, args);
    console.info(this.tag, ...args);
  }

  warn(...args: unknown[]): void {
    capture('WARN', this.tag, args);
    console.warn(this.tag, ...args);
  }

  error(...args: unknown[]): void {
    capture('ERROR', this.tag, args);
    console.error(this.tag, ...args);
  }
}

export function createLogger(tag: string): Logger {
  return new Logger(tag);
}
