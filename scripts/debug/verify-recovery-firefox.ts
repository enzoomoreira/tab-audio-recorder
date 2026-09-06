import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { WebDriver } from 'selenium-webdriver';
import { Driver, Options, ServiceBuilder } from 'selenium-webdriver/firefox';
import { download } from 'geckodriver';
import { build } from 'vite';
import webExtension from 'vite-plugin-web-extension';
import { extensionBaseUrl, EXT_ID } from '../../test/e2e/fixture';
import type { ActionResult, RecordingMetadata } from '../../src/types';

// Build every entrypoint separately: this plugin does not forward CLI outDir to inner builds.
// This simulates restart bookkeeping, not an actual browser/OS crash.
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

async function pause(ms: number): Promise<void> {
  await new Promise<void>((done): void => {
    setTimeout(done, ms);
  });
}

const isolatedBuild = {
  configFile: false as const,
  root: resolve('src'),
  define: { __TEST_BRIDGE__: 'false' },
  build: { outDir: resolve('e2e-artifacts/recovery-dist'), emptyOutDir: false },
};
await bounded(
  build({
    ...isolatedBuild,
    plugins: [
      webExtension({
        browser: 'firefox',
        additionalInputs: ['app/index.html'],
        htmlViteConfig: isolatedBuild,
        scriptViteConfig: isolatedBuild,
      }),
    ],
    build: { ...isolatedBuild.build, emptyOutDir: true },
  }),
);

const options = new Options().addArguments('-headless');
const downloadDirectory = resolve('e2e-artifacts/recovery-qa');
await bounded(mkdir(downloadDirectory, { recursive: true }));
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
  const installed = await bounded(
    (
      driver as WebDriver & {
        installAddon(path: string, temporary: boolean): Promise<string>;
      }
    ).installAddon(resolve('e2e-artifacts/recovery-dist'), true),
  );
  assert.equal(installed, EXT_ID);
  const base = await bounded(extensionBaseUrl(driver));
  await bounded(driver.get('https://example.com/'));
  const source = await bounded(driver.getWindowHandle());
  await bounded(driver.switchTo().newWindow('tab'));
  await bounded(driver.get(`${base}/app/index.html`));
  const app = await bounded(driver.getWindowHandle());
  const tabId = await bounded(
    driver.executeAsyncScript<number>(
      'const done=arguments[arguments.length-1];browser.tabs.query({}).then(t=>done(t.find(t=>t.url.startsWith("https://example.com/")).id));',
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

  async function awaitRow(status: string, id?: string): Promise<RecordingMetadata> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const row = (await message<RecordingMetadata[]>('LIST_RECORDINGS')).find(
        (entry) => entry.status === status && (!id || entry.id === id) && entry.sizeBytes > 0,
      );
      if (row) return row;
      await pause(250);
    }
    throw new Error(`No nonempty ${status} recording found: ${id ?? 'any'}`);
  }

  // A silent page toggles into armed mode. Playback should activate that session.
  assert.deepEqual(await message('TOGGLE_RECORDING', { tabId }), { ok: true });
  assert.equal((await message<{ state: string }>('GET_TAB_STATE', { tabId })).state, 'armed');
  await bounded(driver.switchTo().window(source));
  const played = await bounded(
    driver.executeAsyncScript<boolean | string>(
      `const done=arguments[arguments.length-1];(async()=>{
      const rate=16000,n=rate*2,a=new ArrayBuffer(44+n*2),v=new DataView(a);
      const text=(at,s)=>{for(let i=0;i<s.length;i++)v.setUint8(at+i,s.charCodeAt(i));};
      text(0,'RIFF');v.setUint32(4,36+n*2,true);text(8,'WAVE');text(12,'fmt ');
      v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);
      v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);text(36,'data');v.setUint32(40,n*2,true);
      for(let i=0;i<n;i++)v.setInt16(44+i*2,5000*Math.sin(i*2*Math.PI*440/rate),true);
      window.qaAudio=new Audio(URL.createObjectURL(new Blob([a],{type:'audio/wav'})));qaAudio.loop=true;await qaAudio.play();
    })().then(()=>done(true),e=>done(String(e)));`,
    ),
  );
  assert.equal(played, true);
  await bounded(driver.switchTo().window(app));
  const armed = await awaitRow('recording');
  assert.equal((await message<{ state: string }>('GET_TAB_STATE', { tabId })).state, 'recording');
  assert.deepEqual(await message('TOGGLE_RECORDING', { tabId }), { ok: true });
  const complete = await awaitRow('complete', armed.id);
  console.log(
    'PASS armed playback persists chunks and completes after Stop',
    JSON.stringify(complete),
  );

  assert.deepEqual(await message('TOGGLE_RECORDING', { tabId }), { ok: true });
  const beforeReload = await awaitRow('recording');
  // Drop volatile session bookkeeping, retain IndexedDB, and recreate the extension background.
  // This exercises orphan-session reconciliation without claiming crash durability.
  const cleared = await bounded(
    driver.executeAsyncScript<boolean>(
      `const done=arguments[arguments.length-1];(async()=>{
      const existing=await browser.storage.local.get('settings');
      await browser.storage.local.set({settings:{...existing.settings,exportFormat:'wav'}});
      await browser.storage.session.clear();done(true);
      setTimeout(()=>browser.runtime.reload(),250);
    })();`,
    ),
  );
  assert.equal(cleared, true);
  await bounded(driver.switchTo().window(source));
  await pause(1500);
  assert.equal(await bounded(extensionBaseUrl(driver)), base, 'Extension UUID changed on reload');
  await bounded(driver.switchTo().newWindow('tab'));
  await bounded(driver.get(`${base}/app/index.html`));
  const interrupted = await awaitRow('interrupted', beforeReload.id);
  assert.ok(interrupted.sizeBytes >= beforeReload.sizeBytes);
  const saved = await bounded(
    driver.executeAsyncScript<{ size: number; hash: string; format: string }>(
      `const [id,done]=arguments;(async()=>{
      const blob=await browser.runtime.sendMessage({type:'GET_BLOB',payload:{id}});
      const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
      const settings=await browser.storage.local.get('settings');
      done({size:blob.size,hash:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''),format:settings.settings.exportFormat});
    })();`,
      interrupted.id,
    ),
  );
  assert.equal(saved.size, interrupted.sizeBytes);
  assert.equal(saved.format, 'wav');
  const text = await bounded(driver.executeScript<string>('return document.body.innerText'));
  assert.match(text, /Interrupted recording\./);
  assert.match(text, /playback may require file repair/);
  await bounded(
    writeFile(
      resolve('e2e-artifacts/recovery-manager.png'),
      Buffer.from(await bounded(driver.takeScreenshot()), 'base64'),
    ),
  );
  console.log(
    'PASS simulated restart retains interrupted bytes and manager warning',
    JSON.stringify(interrupted),
  );

  assert.deepEqual(await message<ActionResult>('EXPORT_RECORDING', { id: interrupted.id }), {
    ok: true,
  });
  const downloaded = await bounded(
    driver.executeAsyncScript<{ filename: string; state: string }>(
      'const done=arguments[arguments.length-1];browser.downloads.search({orderBy:["-startTime"],limit:1}).then(rows=>done(rows[0]));',
    ),
  );
  assert.equal(downloaded.state, 'complete');
  assert.match(downloaded.filename, /\.(webm|ogg)$/);
  const bytes = await bounded(readFile(downloaded.filename));
  assert.equal(bytes.length, saved.size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), saved.hash);
  console.log(
    'PASS interrupted export remains byte-identical original despite WAV setting',
    JSON.stringify(downloaded),
  );
  console.log('PASS Firefox recovery QA; restart simulated, no OS crash or durability claim');
} finally {
  if (driver) await bounded(driver.quit()).catch((): void => {});
  await bounded(service.kill());
}
