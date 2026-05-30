// Reaps geckodriver/firefox processes the suite leaks on teardown.
//
// On Windows, selenium's `driver.quit()` does not reliably kill the geckodriver
// child process (known bug: mozilla/geckodriver#1220, bugzilla 1430064). Orphans
// accumulate across runs, contend for resources, and make a later run hang inside
// `Builder.build()` — which then leaks yet another orphan. Selenium has no fix, so
// the recommended approach is a cleanup hook in the test framework itself.
//
// This runs once per `vitest run` regardless of who invokes it, so a dev calling
// `bun run test:e2e` gets the same cleanup. It diffs against a baseline taken
// before the suite, so it only kills processes THIS run started — never a
// Firefox the dev already had open. Caveat: if the vitest process is hard-killed
// (Ctrl-C), this teardown does not run; the normal pass/fail path is covered.
import { execFileSync } from 'node:child_process';

const isWin = process.platform === 'win32';

// geckodriver is reaped first: on Windows `taskkill /T` takes its Firefox child
// with it. The firefox pass then catches any Firefox already orphaned by a
// geckodriver that died first (the bugzilla case).
const IMAGES = ['geckodriver', 'firefox'] as const;

function listPids(image: string): Set<number> {
  try {
    if (isWin) {
      const out = execFileSync(
        'tasklist',
        ['/FI', `IMAGENAME eq ${image}.exe`, '/FO', 'CSV', '/NH'],
        { encoding: 'utf8' },
      );
      const pids = new Set<number>();
      for (const line of out.split('\n')) {
        const m = line.match(/^"[^"]+","(\d+)"/);
        if (m?.[1]) pids.add(Number(m[1]));
      }
      return pids;
    }
    const out = execFileSync('pgrep', ['-x', image], { encoding: 'utf8' });
    return new Set(
      out
        .split('\n')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
    );
  } catch {
    // tasklist with no match still exits 0 (prints an INFO line that the regex
    // skips); pgrep exits non-zero with no match and throws — both mean "none".
    return new Set();
  }
}

function kill(pid: number): void {
  try {
    if (isWin) execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone (e.g. killed as a child of the geckodriver tree above).
  }
}

export default function setup(): () => void {
  const baseline = new Map<string, Set<number>>();
  for (const img of IMAGES) baseline.set(img, listPids(img));

  return () => {
    for (const img of IMAGES) {
      const before = baseline.get(img) ?? new Set<number>();
      for (const pid of listPids(img)) {
        if (!before.has(pid)) kill(pid);
      }
    }
  };
}
