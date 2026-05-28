import { Builder, type WebDriver } from 'selenium-webdriver';
import { Options as FirefoxOptions, ServiceBuilder } from 'selenium-webdriver/firefox';
import { path as geckoDriverPath } from 'geckodriver';
import { resolve, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const DIST_DIR = resolve(REPO_ROOT, 'dist');

export const EXT_ID = 'tab-audio-recorder@test';

export interface E2EContext {
  driver: WebDriver;
  baseUrl: string;
  altUrl: string;
}

/**
 * Build a Firefox driver with the extension temporarily installed.
 * Caller must close the driver via `await ctx.driver.quit()`.
 */
export async function launchDriver(baseUrl: string, altUrl: string): Promise<E2EContext> {
  if (!existsSync(DIST_DIR)) {
    throw new Error(`Build dist/ first (bun run build). Missing: ${DIST_DIR}`);
  }

  const options = new FirefoxOptions();
  // Run headed for a11y/popup testing; switch to .addArguments('-headless') for CI.
  options.addArguments('-remote-allow-system-access'); // chrome-context execute (UUID discovery)
  options.setPreference('xpinstall.signatures.required', false);
  options.setPreference('extensions.experiments.enabled', true);
  // Allow programmatic .play() without user gesture (tests trigger audio via JS).
  options.setPreference('media.autoplay.default', 0);
  options.setPreference('media.autoplay.blocking_policy', 0);
  options.setPreference('media.autoplay.allow-extension-background-pages', true);
  options.setPreference('media.block-autoplay-until-in-foreground', false);

  const service = new ServiceBuilder(geckoDriverPath);

  const driver = await new Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(options)
    .setFirefoxService(service)
    .build();

  // Install the unpacked extension temporarily (only valid for this session).
  // selenium-webdriver exposes this via driver.installAddon in v4.
  type WithInstall = WebDriver & { installAddon: (p: string, temporary?: boolean) => Promise<string> };
  const id = await (driver as WithInstall).installAddon(DIST_DIR, true);
  if (id !== EXT_ID) {
    // Firefox may surface a different ID; warn but continue -- specs that need the UUID
    // discover it via runtime introspection.
    // eslint-disable-next-line no-console
    console.warn(`installAddon returned id=${id}, expected ${EXT_ID}`);
  }

  return { driver, baseUrl, altUrl };
}

/**
 * Resolve the extension's per-session UUID by switching to Marionette's chrome
 * context (privileged) and asking WebExtensionPolicy. The UUID is randomized
 * per profile, so we discover it at runtime.
 */
export async function extensionBaseUrl(driver: WebDriver): Promise<string> {
  type WithContext = WebDriver & { setContext: (c: 'chrome' | 'content') => Promise<void> };
  const ff = driver as WithContext;

  await ff.setContext('chrome');
  let uuid: string | null;
  try {
    uuid = await driver.executeScript<string | null>(
      `const policy = WebExtensionPolicy.getByID(${JSON.stringify(EXT_ID)});
       return policy ? policy.mozExtensionHostname : null;`,
    );
  } finally {
    await ff.setContext('content');
  }
  if (!uuid) throw new Error(`Could not discover UUID for extension ${EXT_ID}`);
  return `moz-extension://${uuid}`;
}

export async function popupUrl(driver: WebDriver): Promise<string> {
  return `${await extensionBaseUrl(driver)}/popup/index.html`;
}
