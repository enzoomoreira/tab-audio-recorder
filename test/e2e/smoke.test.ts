// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { launchDriver, popupUrl, type E2EContext } from './fixture';
import { startServer, type StaticServer } from './server';

describe('E2E smoke', () => {
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

  it('static server serves test-pages and Firefox loads them', async () => {
    await ctx.driver.get(`${server.url}/00-smoke.html`);
    const loaded = await ctx.driver.executeScript<boolean | null>('return window.__smokeLoaded ?? null');
    expect(loaded).toBe(true);
  }, 30_000);

  it('extension popup URL is resolvable', async () => {
    const url = await popupUrl(ctx.driver);
    expect(url).toMatch(/^moz-extension:\/\/[0-9a-f-]+\/popup\/index\.html$/);
  }, 30_000);
});
