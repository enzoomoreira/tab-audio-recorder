import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { By, type WebDriver } from 'selenium-webdriver';
import { Driver, Options, ServiceBuilder } from 'selenium-webdriver/firefox';
import { download } from 'geckodriver';
import { extensionBaseUrl } from '../../test/e2e/fixture';
import type { ActionResult, RecordingMetadata } from '../../src/types';

let stage = 'driver setup';

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject): void => {
        timer = setTimeout(
          (): void => reject(new Error(`Operation exceeded 10s: ${stage}`)),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const options = new Options().addArguments('-headless');
options.setPreference('media.autoplay.default', 0);
options.setPreference('media.autoplay.blocking_policy', 0);
options.setPreference('media.block-autoplay-until-in-foreground', false);
if (process.env['QA_MOCK_AUDIO'] === 'true') {
  options.setPreference('media.cubeb.force_mock_context', true);
}
const downloadDirectory = resolve('e2e-artifacts/worker-qa');
await bounded(mkdir(downloadDirectory, { recursive: true }));
options.setPreference('browser.download.folderList', 2);
options.setPreference('browser.download.dir', downloadDirectory);
options.setPreference('browser.helperApps.neverAsk.saveToDisk', 'audio/mpeg,audio/wav,audio/webm');
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
    ).installAddon(resolve('dist'), true),
  );
  const base = await bounded(extensionBaseUrl(driver));
  stage = 'source page';
  await bounded(driver.get('https://example.com/'));
  const source = await bounded(driver.getWindowHandle());
  await bounded(driver.findElement(By.css('body')).click());
  stage = 'start oscillator';
  await bounded(
    driver.executeAsyncScript(`const done=arguments[arguments.length-1];(async()=>{
    window.qaContext=new AudioContext();await qaContext.resume();const oscillator=qaContext.createOscillator();
    const gain=qaContext.createGain();gain.gain.value=.1;oscillator.connect(gain).connect(qaContext.destination);
    oscillator.start();
  })().then(()=>done(true),e=>done(String(e)));`),
  );
  await bounded(driver.switchTo().newWindow('tab'));
  stage = 'open app';
  await bounded(driver.get(`${base}/app/index.html#recordings`));
  const tabId = await bounded(
    driver.executeAsyncScript<number>(
      `const done=arguments[arguments.length-1];browser.tabs.query({}).then(t=>done(t.find(t=>t.url.startsWith('https://example.com/')).id));`,
    ),
  );
  async function message<T>(type: string, payload: object = {}): Promise<T> {
    return bounded(
      driver!.executeAsyncScript<T>(
        'const [type,payload,done]=arguments;browser.runtime.sendMessage({type,payload}).then(done,e=>done({error:String(e)}));',
        type,
        payload,
      ),
    );
  }
  stage = 'start capture';
  assert.deepEqual(await message('TOGGLE_RECORDING', { tabId }), { ok: true });
  stage = 'seed five-minute recording';
  const seeded = await bounded(
    driver.executeAsyncScript(`const done=arguments[arguments.length-1];(async()=>{
    const rate=44100,seconds=300,frames=rate*seconds,channels=2;
    const data=new ArrayBuffer(44+frames*channels*2),v=new DataView(data);
    const str=(at,s)=>{for(let i=0;i<s.length;i++)v.setUint8(at+i,s.charCodeAt(i));};
    str(0,'RIFF');v.setUint32(4,data.byteLength-8,true);str(8,'WAVE');str(12,'fmt ');
    v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,channels,true);
    v.setUint32(24,rate,true);v.setUint32(28,rate*channels*2,true);v.setUint16(32,channels*2,true);
    v.setUint16(34,16,true);str(36,'data');v.setUint32(40,frames*channels*2,true);
    for(let i=0;i<frames;i++){const sample=5000*Math.sin(i*2*Math.PI*440/rate);v.setInt16(44+i*4,sample,true);v.setInt16(46+i*4,sample,true);}
    const db=await new Promise((r,j)=>{const q=indexedDB.open('tab-audio-recorder',2);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
    await new Promise((r,j)=>{const tx=db.transaction(['metadata','blobs'],'readwrite');
      tx.objectStore('metadata').put({id:'qa-worker',sourceHost:'worker-qa',sourceTitle:'Five minutes',sourceUrl:'https://example.com',mimeType:'audio/wav',durationMs:seconds*1000,sizeBytes:data.byteLength,startedAt:Date.now(),endedAt:Date.now()+seconds*1000,status:'complete'});
      tx.objectStore('blobs').put({id:'qa-worker',blob:new Blob([data],{type:'audio/wav'})});tx.oncomplete=r;tx.onabort=()=>j(tx.error);
    });db.close();await browser.storage.local.set({settings:{exportFormat:'mp3',autoExport:false}});return data.byteLength;
  })().then(done,e=>done(String(e)));`),
  );
  assert.equal(typeof seeded, 'number');
  stage = 'launch export';
  await bounded(
    driver.executeScript(`window.qaExport={done:false};window.qaExportStarted=performance.now();
    browser.runtime.sendMessage({type:'EXPORT_RECORDING',payload:{id:'qa-worker'}}).then(r=>{window.qaExport={done:true,result:r,elapsed:performance.now()-qaExportStarted};},e=>{window.qaExport={done:true,result:{ok:false,error:String(e)}};});`),
  );
  let exportResult: { done: boolean; result?: ActionResult; elapsed?: number } = { done: false };
  let maxResponseMs = 0;
  let samples = 0;
  let firstBytes = 0;
  let lastBytes = 0;
  for (let attempt = 0; attempt < 90; attempt++) {
    stage = `export poll ${attempt}`;
    const started = performance.now();
    const status = await message<{
      state: string;
      error?: string;
      progress: { savedBytes: number };
    }>('GET_TAB_STATE', { tabId });
    maxResponseMs = Math.max(maxResponseMs, performance.now() - started);
    assert.equal(status.state, 'recording', JSON.stringify(status));
    assert.equal(status.error ?? null, null);
    if (samples++ === 0) firstBytes = status.progress.savedBytes;
    lastBytes = status.progress.savedBytes;
    exportResult = await bounded(
      driver.executeScript<typeof exportResult>('return window.qaExport;'),
    );
    if (exportResult.done) break;
    await new Promise<void>((done): void => {
      setTimeout(done, 500);
    });
  }
  assert.equal(exportResult.done, true);
  assert.equal(exportResult.result?.ok, true, JSON.stringify(exportResult));
  assert.ok(lastBytes > firstBytes, 'Capture must commit more audio during conversion');
  assert.ok(maxResponseMs < 2000, `Background stalled: ${maxResponseMs}ms`);
  stage = 'stop capture';
  assert.deepEqual(await message('TOGGLE_RECORDING', { tabId }), { ok: true });
  let rows: RecordingMetadata[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    rows = await message<RecordingMetadata[]>('LIST_RECORDINGS');
    if (rows.some((row) => row.id !== 'qa-worker' && row.status === 'complete')) break;
    await new Promise<void>((done): void => {
      setTimeout(done, 250);
    });
  }
  assert.ok(rows.some((row) => row.id !== 'qa-worker' && row.status === 'complete'));
  stage = 'inspect download';
  const file = await bounded(
    driver.executeAsyncScript<{
      filename: string;
      fileSize: number;
    }>(`const done=arguments[arguments.length-1];(async()=>{
    const files=await browser.downloads.search({state:'complete'});const file=files.find(f=>f.filename.endsWith('.mp3'));
    if(!file)throw Error('No completed MP3');
    return {filename:file.filename,fileSize:file.fileSize};
  })().then(done,e=>done({error:String(e)}));`),
  );
  assert.ok(file.filename);
  const bytes = await bounded(readFile(file.filename));
  assert.equal(bytes.length, file.fileSize);
  const audio = await bounded(
    driver.executeAsyncScript<{ duration: number; peak: number }>(
      `const [base64,done]=arguments;(async()=>{
    const data=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));const ctx=new AudioContext();
    try{const decoded=await ctx.decodeAudioData(data.buffer);let peak=0;for(const sample of decoded.getChannelData(0))peak=Math.max(peak,Math.abs(sample));return {duration:decoded.duration,peak};}finally{await ctx.close();}
  })().then(done,e=>done({error:String(e)}));`,
      bytes.toString('base64'),
    ),
  );
  assert.ok(Math.abs(audio.duration - 300) < 0.1, JSON.stringify(audio));
  assert.ok(audio.peak > 0.05, JSON.stringify(audio));
  stage = 'WAV export';
  await bounded(
    driver.executeAsyncScript(
      `const done=arguments[arguments.length-1];browser.storage.local.set({settings:{exportFormat:'wav',autoExport:false}}).then(()=>done(true));`,
    ),
  );
  const capture = rows.find((row) => row.id !== 'qa-worker' && row.status === 'complete')!;
  assert.deepEqual(await message('EXPORT_RECORDING', { id: capture.id }), { ok: true });
  const wavFile = await bounded(
    driver.executeAsyncScript<{ filename: string; fileSize: number }>(
      `const done=arguments[arguments.length-1];browser.downloads.search({state:'complete'}).then(files=>done(files.find(file=>file.filename.endsWith('.wav'))));`,
    ),
  );
  const wavBytes = await bounded(readFile(wavFile.filename));
  assert.equal(wavBytes.length, wavFile.fileSize);
  assert.equal(wavBytes.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wavBytes.readUInt32LE(40), wavBytes.length - 44);
  console.log(
    JSON.stringify({
      exportResult,
      samples,
      maxResponseMs: Math.round(maxResponseMs),
      firstBytes,
      lastBytes,
      recordings: rows.length,
      audio,
      wavBytes: wavBytes.length,
      mockAudio: process.env['QA_MOCK_AUDIO'] === 'true',
    }),
  );
  await bounded(driver.switchTo().window(source));
} finally {
  if (driver) await bounded(driver.quit()).catch((): void => {});
  await bounded(service.kill()).catch((): void => {});
}
