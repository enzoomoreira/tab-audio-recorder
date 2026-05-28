// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { By } from 'selenium-webdriver';
import { launchDriver, type E2EContext } from './fixture';
import { startServer, type StaticServer } from './server';
import {
  startRecording,
  stopRecording,
  waitForRecording,
  waitForFailedRecording,
  clearRecordings,
} from './helpers';

const RECORD_DURATION_MS = 3_000;

describe('E2E capture per technique', () => {
  let server: StaticServer;
  let ctx: E2EContext;

  beforeAll(async () => {
    server = await startServer();
    ctx = await launchDriver(server.url, server.urlAlt);
  }, 60_000);

  afterAll(async () => {
    await ctx?.driver.quit().catch(() => undefined);
    await server?.close();
  });

  beforeEach(async () => {
    await clearRecordings(ctx.driver);
  });

  async function captureFor(page: string) {
    await ctx.driver.get(`${ctx.baseUrl}/${page}`);
    // Click the page's Start button -- real user gesture that satisfies
    // Firefox autoplay policy. Each test-page exposes <button id="start">.
    await ctx.driver.findElement(By.css('[data-testid="start"]')).click();
    // Give audio a brief moment to actually begin before we start recording.
    await new Promise((r) => setTimeout(r, 500));
    await startRecording(ctx.driver);
    await new Promise((r) => setTimeout(r, RECORD_DURATION_MS));
    await stopRecording(ctx.driver);
    return waitForRecording(ctx.driver);
  }

  it('01 - <audio src="blob:wav"> captures via DOM strategy', async () => {
    const result = await captureFor('01-audio-src-direct.html');
    expect(result).not.toBeNull();
    expect(result?.lastSize).toBeGreaterThan(0);
  }, 60_000);

  it('02 - <video> with audio track does NOT regress YouTube bug', async () => {
    const result = await captureFor('02-video-with-audio.html');
    expect(result).not.toBeNull();
    expect(result?.lastSize).toBeGreaterThan(0);
  }, 60_000);

  it('06 - Web Audio pure (OscillatorNode) captures via P3 hook', async () => {
    const result = await captureFor('06-webaudio-pure.html');
    expect(result).not.toBeNull();
    expect(result?.lastSize).toBeGreaterThan(0);
  }, 60_000);

  it('07 - <audio> inside Shadow DOM is found by P1 recursive scan', async () => {
    const result = await captureFor('07-shadow-dom.html');
    expect(result).not.toBeNull();
    expect(result?.lastSize).toBeGreaterThan(0);
  }, 60_000);

  it('08 - <audio> in same-origin iframe is found by P1 recursive scan', async () => {
    const result = await captureFor('08-iframe-same-origin.html');
    expect(result).not.toBeNull();
    expect(result?.lastSize).toBeGreaterThan(0);
  }, 60_000);

  it('03 - <audio> fed by MediaSource captures via DOM strategy', async () => {
    await ctx.driver.get(`${ctx.baseUrl}/03-mse-blob.html`);
    // Wait for the bundled sample.webm to fetch + appendBuffer to settle.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const ok = await ctx.driver.executeScript<boolean>(
        'return !!(window.__mseReady && window.__mseReady())',
      );
      if (ok) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await ctx.driver.findElement(By.css('[data-testid="start"]')).click();
    await new Promise((r) => setTimeout(r, 500));
    await startRecording(ctx.driver);
    await new Promise((r) => setTimeout(r, RECORD_DURATION_MS));
    await stopRecording(ctx.driver);
    const result = await waitForRecording(ctx.driver);
    expect(result).not.toBeNull();
    expect(result?.lastSize).toBeGreaterThan(0);
  }, 60_000);

  it('13 - <audio> with faked mediaKeys is refused (P4 DRM detection)', async () => {
    await ctx.driver.get(`${ctx.baseUrl}/13-drm-fake.html`);
    await ctx.driver.findElement(By.css('[data-testid="start"]')).click();
    await new Promise((r) => setTimeout(r, 500));
    await startRecording(ctx.driver);
    await new Promise((r) => setTimeout(r, RECORD_DURATION_MS));
    await stopRecording(ctx.driver);
    const refused = await waitForFailedRecording(ctx.driver);
    expect(refused).toBe(true);
  }, 60_000);

  it('09 - <audio> in cross-origin iframe found by P2 frameId routing', async () => {
    // Top frame at baseUrl, iframe loaded from urlAlt -- different origin.
    const url = `${ctx.baseUrl}/09-iframe-cross-origin.html?alt=${encodeURIComponent(ctx.altUrl)}`;
    await ctx.driver.get(url);
    // Wait for iframe to load its src.
    await new Promise((r) => setTimeout(r, 1500));
    await ctx.driver.findElement(By.css('[data-testid="start"]')).click();
    await new Promise((r) => setTimeout(r, 500));
    await startRecording(ctx.driver);
    await new Promise((r) => setTimeout(r, RECORD_DURATION_MS));
    await stopRecording(ctx.driver);
    const result = await waitForRecording(ctx.driver);
    expect(result).not.toBeNull();
    expect(result?.lastSize).toBeGreaterThan(0);
  }, 60_000);
});
