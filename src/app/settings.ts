import {
  getSettings,
  saveSettings,
  resetSettings,
  BITRATE_OPTIONS,
  DEFAULT_SETTINGS,
  type Settings,
} from '../shared/Settings';
import { applyTemplate, validateTemplate } from '../shared/FilenameTemplate';
import { FORMAT_META, EXPORT_FORMATS } from '../shared/exportFormats';
import { createLogger } from '../shared/Logger';
import type { RecordingMetadata, SortField, SortDirection, ExportFormat } from '../types';

const logger = createLogger('Settings');

// --- DOM refs ---
const bitrateEl = document.getElementById('bitrate') as HTMLSelectElement;
const maxDurationSecEl = document.getElementById('maxDurationSec') as HTMLInputElement;
const exportFormatEl = document.getElementById('exportFormat') as HTMLSelectElement;
const exportSubfolderEl = document.getElementById('exportSubfolder') as HTMLInputElement;
const autoExportEl = document.getElementById('autoExport') as HTMLInputElement;
const filenameTemplateEl = document.getElementById('filenameTemplate') as HTMLInputElement;
const templatePreviewEl = document.getElementById('templatePreview') as HTMLSpanElement;
const templateErrorEl = document.getElementById('templateError') as HTMLParagraphElement;
const defaultSortFieldEl = document.getElementById('defaultSortField') as HTMLSelectElement;
const defaultSortDirectionEl = document.getElementById('defaultSortDirection') as HTMLSelectElement;
const maxRecordingsEl = document.getElementById('maxRecordings') as HTMLInputElement;
const verboseLoggingEl = document.getElementById('verboseLogging') as HTMLInputElement;
const resetBtn = document.getElementById('resetBtn') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;

// --- Sample metadata for live preview ---
const PREVIEW_METADATA: RecordingMetadata = {
  id: 'preview',
  sourceUrl: 'https://radio.garden/listen/example',
  sourceHost: 'radio.garden',
  sourceTitle: 'Example Station',
  mimeType: 'audio/mpeg',
  durationMs: 12345,
  sizeBytes: 261_000,
  startedAt: Date.now(),
  endedAt: Date.now() + 12345,
};

// --- State ---
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let statusTimer: ReturnType<typeof setTimeout> | null = null;

function populateBitrateOptions(): void {
  for (const value of BITRATE_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = String(value);
    opt.textContent = `${value / 1000} kbps`;
    bitrateEl.appendChild(opt);
  }
}

function populateExportFormatOptions(): void {
  for (const fmt of EXPORT_FORMATS) {
    const opt = document.createElement('option');
    opt.value = fmt;
    opt.textContent = FORMAT_META[fmt].label;
    exportFormatEl.appendChild(opt);
  }
}

function currentExtension(): string {
  const fmt = exportFormatEl.value as ExportFormat;
  return FORMAT_META[fmt]?.extension ?? FORMAT_META[DEFAULT_SETTINGS.exportFormat].extension;
}

function applyToForm(s: Settings): void {
  bitrateEl.value = String(s.bitrate);
  maxDurationSecEl.value = String(s.maxDurationSec);
  exportFormatEl.value = s.exportFormat;
  exportSubfolderEl.value = s.exportSubfolder;
  autoExportEl.checked = s.autoExport;
  filenameTemplateEl.value = s.filenameTemplate;
  defaultSortFieldEl.value = s.defaultSortField;
  defaultSortDirectionEl.value = s.defaultSortDirection;
  maxRecordingsEl.value = String(s.maxRecordings);
  verboseLoggingEl.checked = s.verboseLogging;
  updateTemplatePreview(s.filenameTemplate);
}

function readForm(): Settings {
  return {
    bitrate: Number(bitrateEl.value),
    maxDurationSec: Math.max(0, Number(maxDurationSecEl.value) || 0),
    exportFormat: exportFormatEl.value as ExportFormat,
    exportSubfolder: exportSubfolderEl.value.trim(),
    autoExport: autoExportEl.checked,
    filenameTemplate: filenameTemplateEl.value,
    defaultSortField: defaultSortFieldEl.value as SortField,
    defaultSortDirection: defaultSortDirectionEl.value as SortDirection,
    maxRecordings: Math.max(0, Number(maxRecordingsEl.value) || 0),
    verboseLogging: verboseLoggingEl.checked,
  };
}

function updateTemplatePreview(template: string): void {
  const validation = validateTemplate(template);
  if (!validation.ok) {
    templatePreviewEl.textContent = '—';
    templateErrorEl.textContent = validation.error ?? 'Invalid template';
    templateErrorEl.hidden = false;
    return;
  }
  templateErrorEl.hidden = true;
  try {
    templatePreviewEl.textContent = applyTemplate(template, PREVIEW_METADATA, currentExtension());
  } catch (err) {
    templatePreviewEl.textContent = '—';
    logger.error('Preview render failed:', err);
  }
}

function showSavedStatus(): void {
  statusEl.textContent = 'Saved';
  statusEl.classList.add('is-visible');
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusEl.classList.remove('is-visible');
  }, 1500);
}

async function scheduleSave(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const next = readForm();

    // Don't persist an invalid template — UI shows error inline,
    // but the rest of the form can still save with the previous template value.
    const validation = validateTemplate(next.filenameTemplate);
    if (!validation.ok) {
      const current = await getSettings();
      next.filenameTemplate = current.filenameTemplate;
    }

    await saveSettings(next);
    showSavedStatus();
  }, 300);
}

function bindEvents(): void {
  // Change events: any input/select/checkbox flush
  const flushOnChange = [
    bitrateEl,
    maxDurationSecEl,
    exportSubfolderEl,
    autoExportEl,
    defaultSortFieldEl,
    defaultSortDirectionEl,
    maxRecordingsEl,
    verboseLoggingEl,
  ];
  for (const el of flushOnChange) {
    el.addEventListener('change', () => void scheduleSave());
  }

  // Format change saves and refreshes the preview (the extension changes).
  exportFormatEl.addEventListener('change', () => {
    updateTemplatePreview(filenameTemplateEl.value);
    void scheduleSave();
  });

  // Template needs live preview AND debounced save
  filenameTemplateEl.addEventListener('input', () => {
    updateTemplatePreview(filenameTemplateEl.value);
    void scheduleSave();
  });

  // Reset
  resetBtn.addEventListener('click', async () => {
    if (!confirm('Reset all settings to defaults? Existing recordings are unaffected.')) return;
    await resetSettings();
    applyToForm(DEFAULT_SETTINGS);
    showSavedStatus();
  });
}

export function initSettings(settings: Settings): void {
  populateBitrateOptions();
  populateExportFormatOptions();
  applyToForm(settings);
  bindEvents();
  logger.info('Settings section initialized');
}
