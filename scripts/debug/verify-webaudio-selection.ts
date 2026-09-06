import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Driver, Options, ServiceBuilder } from 'selenium-webdriver/firefox';
import { download } from 'geckodriver';

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject): void => {
        timer = setTimeout((): void => reject(new Error('Operation exceeded 10s')), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const path = await bounded(download());
const options = new Options().addArguments('-headless');
options.setPreference('media.autoplay.default', 0);
options.setPreference('media.autoplay.blocking_policy', 0);
const driver = Driver.createSession(options, new ServiceBuilder(path).build());
try {
  await bounded(driver.getSession());
  await bounded(driver.manage().setTimeouts({ script: 10_000, pageLoad: 10_000 }));
  await bounded(driver.get('https://example.com/'));
  const source = await readFile('src/content/AudioContextHook.ts', 'utf8');
  await bounded(driver.executeScript(new Bun.Transpiler({ loader: 'ts' }).transformSync(source)));
  const result = await bounded(
    driver.executeAsyncScript<Record<string, unknown>>(`
    const done = arguments[arguments.length - 1];
    (async () => {
      const replies = [];
      const chunks = [];
      window.addEventListener('message', event => {
        if (event.data.source !== 'tab-audio-recorder-page') return;
        replies.push(event.data);
        if (event.data.type === 'CHUNK') {
          chunks.push(event.data.blob);
          window.postMessage({source:'tab-audio-recorder',type:'CHUNK_ACK',captureId:event.data.captureId,sequence:event.data.sequence,ok:true},location.origin);
        }
      });
      async function request(type, captureId = 'selection') {
        const replyType = {PROBE:'PROBE_RESULT',START:'STARTED',STOP:'STOPPED'}[type];
        const response = new Promise(resolve => {
          const listener = event => {
            if (event.data.source === 'tab-audio-recorder-page' && event.data.type === replyType) {
              window.removeEventListener('message',listener);
              resolve(event.data);
            }
          };
          window.addEventListener('message',listener);
        });
        window.postMessage({source:'tab-audio-recorder',type,captureId},location.origin);
        return response;
      }
      const idle = new AudioContext(); await idle.resume();
      const idleProbe = await request('PROBE');
      const active = new AudioContext(); await active.resume();
      const oscillator = active.createOscillator();
      oscillator.connect(active.destination); oscillator.start();
      const start = await request('START');
      await new Promise(resolve => setTimeout(resolve,1200));
      const stop = await request('STOP');
      const buffer = await active.decodeAudioData(await new Blob(chunks).arrayBuffer());
      let peak = 0;
      for (const value of buffer.getChannelData(0)) peak = Math.max(peak,Math.abs(value));
      oscillator.connect(active.destination);
      oscillator.disconnect(active.destination);
      const duplicateDisconnected = await request('PROBE');
      oscillator.connect(active.destination);
      const other = idle.createOscillator(); other.connect(idle.destination); other.start();
      const ambiguous = await request('START','ambiguous');
      other.disconnect(0);
      const afterOutputDisconnect = await request('START','output'); await request('STOP','output');
      other.connect(idle.destination); other.disconnect();
      const afterAllDisconnect = await request('START','all'); await request('STOP','all');
      await active.suspend();
      const suspended = await request('PROBE');
      await active.close(); await idle.close();
      return {idleProbe,start,stop,peak,duplicateDisconnected,ambiguous,afterOutputDisconnect,afterAllDisconnect,suspended};
    })().then(done,error => done({error:String(error)}));
  `),
  );
  assert.equal(result.error, undefined);
  for (const field of ['idleProbe', 'duplicateDisconnected', 'suspended']) {
    assert.equal((result[field] as { hasContexts: boolean }).hasContexts, false, field);
  }
  for (const field of ['start', 'stop', 'afterOutputDisconnect', 'afterAllDisconnect']) {
    assert.equal((result[field] as { ok: boolean }).ok, true, field);
  }
  assert.ok((result.peak as number) > 0.1);
  assert.match((result.ambiguous as { error: string }).error, /Multiple Web Audio contexts/);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await bounded(driver.quit());
}
