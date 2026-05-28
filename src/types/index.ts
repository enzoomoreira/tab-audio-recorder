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
}

// === Media capture ===

export interface IDetector {
  find(): HTMLMediaElement | null;
  hasMedia(): boolean;
}

export interface CaptureResult {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  startedAt: number;
  endedAt: number;
}

export interface IStreamRecorder {
  start(element: HTMLMediaElement): void;
  stop(): Promise<CaptureResult>;
  isRecording(): boolean;
}

// === Message bus ===
// All messages typed as discriminated unions so listeners can narrow with type guards.

// Background -> Content
export type BgToContentMessage =
  | { type: 'CHECK_MEDIA' }
  | { type: 'START_CAPTURE' }
  | { type: 'STOP_CAPTURE' };

// Content -> Background (proactive, not a reply)
export type ContentToBgMessage =
  | { type: 'RECORDING_COMPLETE'; payload: CaptureResult }
  | { type: 'RECORDING_ERROR'; payload: { reason: string } };

// Popup -> Background (request/response)
export type PopupToBgMessage =
  | { type: 'GET_TAB_STATE'; payload: { tabId: number } }
  | { type: 'START_RECORDING'; payload: { tabId: number } }
  | { type: 'STOP_RECORDING'; payload: { tabId: number } }
  | { type: 'OPEN_MANAGER' };

// Manager -> Background (request/response)
export type ManagerToBgMessage =
  | { type: 'LIST_RECORDINGS'; payload: { filter?: RecordingFilter; sort?: SortOptions } }
  | { type: 'DELETE_RECORDING'; payload: { id: string } }
  | { type: 'GET_BLOB'; payload: { id: string } };

export type TabRecordingState = 'idle' | 'recording' | 'processing';

export type ActionResult = { ok: true } | { ok: false; error: string };
