import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { WebDriver } from 'selenium-webdriver';
import { Driver, Options, ServiceBuilder } from 'selenium-webdriver/firefox';
import { download } from 'geckodriver';
import { extensionBaseUrl } from '../../test/e2e/fixture';
import type { ActionResult, RecordingMetadata } from '../../src/types';

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

const duration = Number(process.env['CAPTURE_SECONDS'] ?? 12);
assert.ok(Number.isInteger(duration) && duration >= 4 && duration <= 1200);
const downloadDirectory = resolve('e2e-artifacts/incremental-qa');
await bounded(mkdir(downloadDirectory, { recursive: true }));
const options = new Options().addArguments('-headless');
options.setPreference('media.autoplay.default', 0);
options.setPreference('media.autoplay.blocking_policy', 0);
options.setPreference('media.block-autoplay-until-in-foreground', false);
options.setPreference('browser.download.folderList', 2);
options.setPreference('browser.download.dir', downloadDirectory);
options.setPreference('browser.helperApps.neverAsk.saveToDisk', 'audio/webm,audio/ogg');
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input, init) =>
  originalFetch(input, { ...init, signal: AbortSignal.timeout(10_000) })) as typeof fetch;
let binary: string;
try {
  binary = await bounded(download());
} finally {
  globalThis.fetch = originalFetch;
}
const service = new ServiceBuilder(binary).addArguments('--allow-system-access').build();
let driver: WebDriver | undefined;
try {
  driver = Driver.createSession(options, service);
  await bounded(driver.getSession());
  await bounded(driver.manage().setTimeouts({ script: 10_000, pageLoad: 10_000, implicit: 0 }));
  await bounded(
    (
      driver as WebDriver & { installAddon(path: string, temporary: boolean): Promise<string> }
    ).installAddon(resolve(process.env['EXTENSION_DIRECTORY'] ?? 'dist'), true),
  );
  const base = await bounded(extensionBaseUrl(driver));
  await bounded(driver.get('https://example.com/'));
  const source = await bounded(driver.getWindowHandle());
  await bounded(driver.switchTo().newWindow('tab'));
  await bounded(driver.get(`${base}/app/index.html`));
  const app = await bounded(driver.getWindowHandle());
  const tabId = await bounded(
    driver.executeAsyncScript<number>(
      'const done=arguments[arguments.length-1]; browser.tabs.query({}).then(t=>done(t.find(t=>t.url.startsWith("https://example.com/")).id));',
    ),
  );
  async function message<T>(type: string, payload: object = {}): Promise<T> {
    return bounded(
      driver!.executeAsyncScript<T>(
        'const [type,payload,done]=arguments; browser.runtime.sendMessage({type,payload}).then(done,e=>done({error:String(e)}));',
        type,
        payload,
      ),
    );
  }
  async function generateAudio(media: boolean): Promise<void> {
    await bounded(driver!.switchTo().window(source));
    const result = await bounded(
      driver!.executeAsyncScript<boolean | string>(
        `const [media,done]=arguments; (async()=>{
        if(media){
          const rate=16000,n=rate*2,a=new ArrayBuffer(44+n*2),v=new DataView(a);
          const text=(at,s)=>{for(let i=0;i<s.length;i++)v.setUint8(at+i,s.charCodeAt(i));};
          text(0,'RIFF');v.setUint32(4,36+n*2,true);text(8,'WAVE');text(12,'fmt ');
          v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);
          v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);text(36,'data');v.setUint32(40,n*2,true);
          for(let i=0;i<n;i++)v.setInt16(44+i*2,5000*Math.sin(i*2*Math.PI*440/rate),true);
          window.qaAudio=new Audio(URL.createObjectURL(new Blob([a],{type:'audio/wav'})));qaAudio.loop=true;await qaAudio.play();
        }else{
          window.qaContext=new AudioContext();await qaContext.resume();const o=qaContext.createOscillator();
          const g=qaContext.createGain();g.gain.value=.1;o.connect(g).connect(qaContext.destination);o.start();
        }
      })().then(()=>done(true),e=>done(String(e)));`,
        media,
      ),
    );
    assert.equal(result, true);
    await bounded(driver!.switchTo().window(app));
  }
  async function waitForChunks(seconds: number): Promise<RecordingMetadata> {
    let latest: RecordingMetadata | undefined;
    const start = Date.now();
    for (let attempt = 0; attempt < Math.ceil(seconds / 2) + 5; attempt++) {
      await new Promise<void>((resolve): void => {
        setTimeout(resolve, 2000);
      });
      const rows = await message<RecordingMetadata[]>('LIST_RECORDINGS');
      latest = rows.find((row) => row.status === 'recording');
      if (attempt % 15 === 0) console.log('Recording checkpoint', JSON.stringify(latest));
      if (Date.now() - start >= seconds * 1000 && latest && (latest.nextSequence ?? 0) > 0)
        return latest;
    }
    throw new Error(`No recording chunks committed: ${JSON.stringify(latest)}`);
  }
  async function stopAndDecode(id: string): Promise<void> {
    assert.deepEqual(await message('TOGGLE_RECORDING', { tabId }), { ok: true });
    let row: RecordingMetadata | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      row = (await message<RecordingMetadata[]>('LIST_RECORDINGS')).find((r) => r.id === id);
      if (row?.status === 'complete') break;
      await new Promise<void>((resolve): void => {
        setTimeout(resolve, 100);
      });
    }
    assert.equal(row?.status, 'complete');
    const decoded = await bounded(
      driver!.executeAsyncScript<{ duration: number; peak: number; error?: string }>(
        `const [id,done]=arguments;(async()=>{const b=await browser.runtime.sendMessage({type:'GET_BLOB',payload:{id}});
       const c=new AudioContext();try{const a=await c.decodeAudioData(await b.arrayBuffer());const p=a.getChannelData(0);
       let peak=0;for(let i=0;i<p.length;i+=100)peak=Math.max(peak,Math.abs(p[i]));done({duration:a.duration,peak});}finally{await c.close();}})().catch(e=>done({error:String(e)}));`,
        id,
      ),
    );
    assert.ok(decoded.duration > 1, JSON.stringify(decoded));
    assert.ok(decoded.peak > 0.01, JSON.stringify(decoded));
    const exported = await message<ActionResult>('EXPORT_RECORDING', { id });
    assert.deepEqual(exported, { ok: true });
    console.log(
      'PASS complete, decoded non-silent audio, original download complete',
      JSON.stringify({ row, decoded }),
    );
  }
  await generateAudio(true);
  assert.deepEqual(await message('TOGGLE_RECORDING', { tabId }), { ok: true });
  const media = await waitForChunks(duration);
  assert.ok(media.sizeBytes > 0);
  await stopAndDecode(media.id);

  // Closing the source document must preserve prior commits as interrupted.
  assert.deepEqual(await message('TOGGLE_RECORDING', { tabId }), { ok: true });
  const interrupted = await waitForChunks(4);
  await bounded(driver.switchTo().window(source));
  await bounded(driver.get('https://example.com/?new-document'));
  await bounded(driver.switchTo().window(app));
  let recovered: RecordingMetadata | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    recovered = (await message<RecordingMetadata[]>('LIST_RECORDINGS')).find(
      (r) => r.id === interrupted.id,
    );
    if (recovered?.status === 'interrupted') break;
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 100);
    });
  }
  assert.equal(recovered?.status, 'interrupted');
  assert.ok(recovered!.sizeBytes >= interrupted.sizeBytes);
  console.log('PASS navigation preserves interrupted bytes', JSON.stringify(recovered));
  await generateAudio(false);
  assert.deepEqual(await message('TOGGLE_RECORDING', { tabId }), { ok: true });
  const webAudio = await waitForChunks(4);
  await stopAndDecode(webAudio.id);
  console.log('PASS Firefox incremental capture QA');
} finally {
  if (driver) await bounded(driver.quit()).catch((): void => {});
  await service.kill();
}
