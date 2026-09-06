import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import type { WebDriver } from 'selenium-webdriver';
import { Driver, Options, ServiceBuilder } from 'selenium-webdriver/firefox';
import { download } from 'geckodriver';
import { extensionBaseUrl } from '../../test/e2e/fixture';
import { startServer } from '../../test/e2e/server';

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject): void => {
        timer = setTimeout((): void => reject(new Error('Operation exceeded 10s')), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

const options = new Options().addArguments('-headless');
options.setPreference('media.autoplay.default', 0);
options.setPreference('media.autoplay.blocking_policy', 0);
options.setPreference('media.block-autoplay-until-in-foreground', false);
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input, init) =>
  originalFetch(input, { ...init, signal: AbortSignal.timeout(10_000) })) as typeof fetch;
const geckodriverPath = await bounded(download());
globalThis.fetch = originalFetch;
const service = new ServiceBuilder(geckodriverPath).addArguments('--allow-system-access').build();
let driver: WebDriver | undefined;
const server = await startServer();
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
  await bounded(driver.get(`${server.url}/01-audio-src-direct.html`));
  const mediaHandle = await bounded(driver.getWindowHandle());
  await bounded(
    driver.executeAsyncScript(
      'const done = arguments[arguments.length-1]; window.__startAudio().then(() => done(true), e => done(String(e)));',
    ),
  );
  await bounded(driver.switchTo().newWindow('tab'));
  await bounded(driver.get(`${base}/app/index.html`));
  const appHandle = await bounded(driver.getWindowHandle());
  const tabId = await bounded(
    driver.executeAsyncScript<number>(
      'const done = arguments[arguments.length-1]; browser.tabs.query({}).then(t => done(t.find(t => t.url.includes("01-audio-src-direct.html")).id));',
    ),
  );
  async function message<T>(type: string, payload: object): Promise<T> {
    return bounded(
      driver!.executeAsyncScript<T>(
        'const [type,payload,done]=arguments; browser.runtime.sendMessage({type,payload}).then(done,e=>done({error:String(e)}));',
        type,
        payload,
      ),
    );
  }
  console.log(
    'Firefox capture probe',
    await bounded(
      driver.executeAsyncScript(
        'const [tabId,done]=arguments; browser.tabs.sendMessage(tabId,{type:"CHECK_MEDIA"},{frameId:0}).then(done,e=>done(String(e)));',
        tabId,
      ),
    ),
  );
  assert.deepEqual(await message('TOGGLE_RECORDING', { tabId }), { ok: true });
  assert.equal((await message<{ state: string }>('GET_TAB_STATE', { tabId })).state, 'recording');
  await bounded(driver.switchTo().window(mediaHandle));
  await bounded(
    driver.executeAsyncScript(
      'const done = arguments[arguments.length-1]; const p=document.getElementById("player"); p.loop=false; p.addEventListener("ended",()=>done(true),{once:true}); p.currentTime=9.5;',
    ),
  );
  await bounded(driver.switchTo().window(appHandle));
  assert.deepEqual(await message('TOGGLE_RECORDING', { tabId }), { ok: true });
  let recordings: Array<{ id: string; sizeBytes: number }> = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    recordings = await message('LIST_RECORDINGS', {});
    if (recordings.length > 0) break;
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 100);
    });
  }
  assert.equal(recordings.length, 1);
  assert.ok(recordings[0]!.sizeBytes > 0);
  const state = await message<{ state: string }>('GET_TAB_STATE', { tabId });
  assert.equal(state.state, 'idle');
  const decoded = await bounded(
    driver.executeAsyncScript<{ frames: number; channels: number }>(
      'const [id,done]=arguments; (async()=>{const blob=await browser.runtime.sendMessage({type:"GET_BLOB",payload:{id}}); const ctx=new AudioContext(); try { const audio=await ctx.decodeAudioData(await blob.arrayBuffer()); done({frames:audio.length,channels:audio.numberOfChannels}); } finally { await ctx.close(); }})().catch(e=>done({error:String(e)}));',
      recordings[0]!.id,
    ),
  );
  assert.ok(decoded.frames > 0);
  console.log(
    'PASS Firefox production: natural media end -> Stop -> saved -> idle -> decoded audio',
    JSON.stringify({ recordings, decoded }),
  );
} finally {
  if (driver) await bounded(driver.quit()).catch((): void => {});
  await service.kill();
  await server.close();
}
