import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { readFile, stat } from 'fs/promises';
import { resolve, extname, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const TEST_PAGES_DIR = resolve(REPO_ROOT, 'test-pages');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
};

export interface StaticServer {
  url: string;
  /**
   * Second server on a different port, used as a cross-origin host (e.g. to
   * iframe a page from `url` and observe the P2 frameId routing).
   * Different port = different origin per Same-Origin Policy.
   */
  urlAlt: string;
  close(): Promise<void>;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = resolve(TEST_PAGES_DIR, '.' + path);
    if (!filePath.startsWith(TEST_PAGES_DIR)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    try {
      const s = await stat(filePath);
      if (!s.isFile()) throw new Error('not a file');
    } catch {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    const body = await readFile(filePath);
    res.setHeader('Content-Type', MIME[extname(filePath)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  } catch (err) {
    res.statusCode = 500;
    res.end(String(err));
  }
}

function startOne(): Promise<{ server: Server; port: number }> {
  return new Promise((resolveOne, rejectOne) => {
    const server = createServer((req, res) => void handle(req, res));
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        rejectOne(new Error('Server bound to unexpected address'));
        return;
      }
      resolveOne({ server, port: addr.port });
    });
    server.on('error', rejectOne);
  });
}

/**
 * Spawn two static file servers for the test-pages/ directory on random ports.
 * Both serve the same files; the second exists so iframes can be cross-origin.
 */
export async function startServer(): Promise<StaticServer> {
  const [a, b] = await Promise.all([startOne(), startOne()]);
  return {
    url: `http://127.0.0.1:${a.port}`,
    urlAlt: `http://127.0.0.1:${b.port}`,
    close: () =>
      Promise.all([
        new Promise<void>((r) => a.server.close(() => r())),
        new Promise<void>((r) => b.server.close(() => r())),
      ]).then(() => undefined),
  };
}
