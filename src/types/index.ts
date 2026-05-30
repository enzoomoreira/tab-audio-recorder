// === Core domain model ===

export interface RecordingMetadata {
  id: string;
  sourceUrl: string;
  sourceHost: string;
  sourceTitle: string;
  mimeType: string;
  durationMs: number;
  sizeBytes: number;
  startedAt: number;
  endedAt: number;
}

export interface Recording {
  metadata: RecordingMetadata;
  blob: Blob;
}

// === Repository ===

export interface RecordingFilter {
  host?: string;
  dateFrom?: number;
  dateTo?: number;
}

export type SortField = 'startedAt' | 'durationMs' | 'sizeBytes';
export type SortDirection = 'asc' | 'desc';

export interface SortOptions {
  field: SortField;
  direction: SortDirection;
}

export interface IRepository {
  save(recording: Recording): Promise<string>;
  list(filter?: RecordingFilter, sort?: SortOptions): Promise<RecordingMetadata[]>;
  deleteById(id: string): Promise<void>;
  getBlobById(id: string): Promise<Blob | null>;
  getById(id: string): Promise<Recording | null>;
}

// === Media capture ===

export interface CaptureResult {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  startedAt: number;
  endedAt: number;
}

// Shared interface for every content-side capture strategy (element capture,
// network fetch, Web Audio tap).
export interface IRecorder {
  stop(): Promise<CaptureResult>;
  isRecording(): boolean;
}

export interface INetworkRecorder extends IRecorder {
  start(url: string): void;
}

// === Message bus ===
// All messages typed as discriminated unions so listeners can narrow with type guards.

// Background -> Content
export type BgToContentMessage =
  | { type: 'CHECK_MEDIA' }
  | { type: 'START_CAPTURE'; payload: { bitrate: number } }
  | { type: 'START_NETWORK_CAPTURE'; payload: { url: string } }
  | { type: 'START_WEBAUDIO_CAPTURE'; payload: { bitrate: number } }
  | { type: 'STOP_CAPTURE' }
  // Arm the element hook to auto-capture the next media element that plays.
  | { type: 'ARM_CAPTURE'; payload: { bitrate: number } }
  | { type: 'DISARM_CAPTURE' }
  // Discard an armed capture that already started in a losing frame (multi-frame race).
  | { type: 'ABORT_CAPTURE' };

// Content -> Background (proactive, not a reply)
export type ContentToBgMessage =
  | { type: 'RECORDING_COMPLETE'; payload: CaptureResult }
  | { type: 'RECORDING_ERROR'; payload: { reason: string } }
  // An armed frame auto-started capture when its media element played.
  | { type: 'ARMED_STARTED' };

// The unified app page (sidebar SPA) has two sections; opening it deep-links to one.
export type AppSection = 'recordings' | 'settings';

// Popup -> Background (request/response)
export type PopupToBgMessage =
  | { type: 'GET_TAB_STATE'; payload: { tabId: number } }
  | { type: 'TOGGLE_RECORDING'; payload: { tabId: number } }
  | { type: 'OPEN_APP'; payload: { section: AppSection } };

// App page -> Background (request/response)
export type AppToBgMessage =
  | { type: 'LIST_RECORDINGS'; payload: { filter?: RecordingFilter; sort?: SortOptions } }
  | { type: 'DELETE_RECORDING'; payload: { id: string } }
  | { type: 'GET_BLOB'; payload: { id: string } }
  | { type: 'EXPORT_RECORDING'; payload: { id: string } };

// Test bridge -> Background (E2E builds only; stripped from production)
export type TestBridgeMessage =
  | { type: 'TEST_START_RECORDING' }
  | { type: 'TEST_STOP_RECORDING' }
  | { type: 'TEST_ARM_RECORDING' }
  | { type: 'TEST_GET_LOGS' };

// Everything the background's runtime.onMessage listener can receive.
export type InboundMessage =
  | PopupToBgMessage
  | AppToBgMessage
  | ContentToBgMessage
  | TestBridgeMessage;

export type TabRecordingState = 'idle' | 'armed' | 'recording' | 'processing';

// `armable` marks a start failure that happened only because nothing is playing
// yet (no media element, stream URL, or AudioContext) -- the toggle then arms
// instead of surfacing an error. DRM and comms failures are NOT armable.
export type ActionResult = { ok: true } | { ok: false; error: string; armable?: boolean };

// === Export ===
// Recordings are captured as WebM/Opus; on export they are decoded and
// re-encoded to one of these target formats.
export type ExportFormat = 'wav' | 'mp3';
