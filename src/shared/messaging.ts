import type {
  PopupToBgMessage,
  AppToBgMessage,
  TabRecordingState,
  ActionResult,
  RecordingMetadata,
} from '../types';

// Requests a UI realm (popup / app) sends to the background.
type OutboundMessage = PopupToBgMessage | AppToBgMessage;

// Maps each outbound request onto the response the background returns for it, so
// sendToBackground resolves with the right type and call sites need no `as` cast.
interface ResponseFor {
  GET_TAB_STATE: { state: TabRecordingState };
  TOGGLE_RECORDING: ActionResult;
  OPEN_APP: undefined;
  LIST_RECORDINGS: RecordingMetadata[];
  DELETE_RECORDING: void;
  GET_BLOB: Blob | null;
  EXPORT_RECORDING: ActionResult;
}

/**
 * Typed wrapper over `browser.runtime.sendMessage` for UI -> background calls.
 * Constrains the request to the message union and resolves with the matching
 * response type, so both ends of a call are checked at the call site instead of
 * being cast loose.
 */
export function sendToBackground<M extends OutboundMessage>(
  message: M,
): Promise<ResponseFor[M['type']]> {
  return browser.runtime.sendMessage(message) as Promise<ResponseFor[M['type']]>;
}
