import { encodeMp3, encodeWav, type PcmAudio } from './PcmEncoder';
import type { EncodingRequest, EncodingResponse } from './EncodingWorker';

self.onmessage = (event: MessageEvent<EncodingRequest>): void => {
  try {
    const { channels, sampleRate, format, kbps } = event.data;
    const pcm: PcmAudio = {
      numberOfChannels: channels.length,
      sampleRate,
      length: channels[0]!.length,
      getChannelData: (channel): Float32Array => channels[channel]!,
    };
    const bytes = format === 'wav' ? encodeWav(pcm) : encodeMp3(pcm, kbps);
    const response: EncodingResponse = { ok: true, bytes };
    self.postMessage(response, { transfer: [bytes.buffer] });
  } catch (error) {
    const response: EncodingResponse = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};
