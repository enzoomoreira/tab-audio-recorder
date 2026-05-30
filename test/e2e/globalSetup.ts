// Reaps the geckodriver processes the suite leaks on teardown.
//
// On Windows, selenium's `driver.quit()` does not reliably kill the geckodriver
// child process (known bug: mozilla/geckodriver#1220, bugzilla 1430064). Orphans
// accumulate across runs, contend for resources, and make a later run hang inside
// `Builder.build()` — which then leaks yet another orphan. Selenium has no fix, so
// the recommended approach is a cleanup hook in the test framework itself.
//
// Only geckodriver is reaped, never firefox. On Windows `taskkill /T` kills the
// geckodriver process tree, so the test's child Firefox dies with it. Matching
// firefox by name is deliberately avoided: a browser window the dev opens during
// a run would be a non-baseline firefox.exe and get killed too. A Firefox left
// behind by a geckodriver that happened to exit first is harmless — it holds no
// port and does not block later runs.
//
// Runs once per `vitest run` regardless of who invokes it, so a plain
// `bun run test:e2e` self-cleans. It diffs against a baseline taken before the
// suite, so it only kills geckodrivers THIS run started. Caveat: if vitest is
// hard-killed (Ctrl-C) this teardown does not run; the normal pass/fail path is
// covered.
import { execFileSync } from 'node:child_process';

const isWin = process.platform === 'win32';
const IMAGE = 'geckodriver';

function listPids(): Set<number> {
  try {
    if (isWin) {
      const out = execFileSync(
        'tasklist',
        ['/FI', `IMAGENAME eq ${IMAGE}.exe`, '/FO', 'CSV', '/NH'],
        { encoding: 'utf8' },
      );
      const pids = new Set<number>();
      for (const line of out.split('\n')) {
        const m = line.match(/^"[^"]+","(\d+)"/);
        if (m?.[1]) pids.add(Number(m[1]));
      }
      return pids;
    }
    const out = execFileSync('pgrep', ['-x', IMAGE], { encoding: 'utf8' });
    return new Set(
      out
        .split('\n')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
    );
  } catch {
    // tasklist with no match still exits 0 (prints an INFO line the regex skips);
    // pgrep exits non-zero with no match and throws — both mean "none".
    return new Set();
  }
}

function kill(pid: number): void {
  try {
    // /T kills the process tree, taking the test's child Firefox with it.
    if (isWin) execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

export default function setup(): () => void {
  const baseline = listPids();

  return () => {
    for (const pid of listPids()) {
      if (!baseline.has(pid)) kill(pid);
    }
  };
}
