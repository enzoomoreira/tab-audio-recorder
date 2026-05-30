import { createLogger, setVerbose } from '../shared/Logger';
import { getSettings } from '../shared/Settings';
import { initRecordings } from './recordings';
import { initSettings } from './settings';
import type { AppSection } from '../types';

const logger = createLogger('App');

const SECTIONS: AppSection[] = ['recordings', 'settings'];

const navItems = Array.from(document.querySelectorAll<HTMLAnchorElement>('.nav__item'));
const views = new Map<AppSection, HTMLElement>(
  SECTIONS.map((s) => [s, document.getElementById(`view-${s}`)!]),
);

const TITLES: Record<AppSection, string> = {
  recordings: 'Recordings — Tab Audio Recorder',
  settings: 'Settings — Tab Audio Recorder',
};

// The section is driven entirely by the URL fragment, so the background opener
// can deep-link (and re-target an already-open tab) just by setting the hash.
function currentSection(): AppSection {
  const hash = location.hash.replace(/^#/, '') as AppSection;
  return SECTIONS.includes(hash) ? hash : 'recordings';
}

function showSection(section: AppSection): void {
  for (const [s, el] of views) el.hidden = s !== section;
  for (const item of navItems) {
    item.classList.toggle('is-active', item.dataset['section'] === section);
  }
  document.title = TITLES[section];
}

// Changing only the fragment never reloads the page — it fires hashchange, which
// is how clicking the sidebar and the background re-targeting both land here.
window.addEventListener('hashchange', () => showSection(currentSection()));

async function init(): Promise<void> {
  const settings = await getSettings();
  setVerbose(settings.verboseLogging);

  // Both sections eager-init: cheap, and the manager's resource cleanup runs on
  // full page unload (pagehide) regardless of which section is visible.
  initSettings(settings);
  showSection(currentSection());
  await initRecordings(settings);
}

void init().catch((err: unknown) => logger.error('App init failed:', err));
