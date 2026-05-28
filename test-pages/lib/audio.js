// Helpers for generating known audio sources inline -- no external assets.
// Pages embed this script and call the exposed functions.

(function () {
  function encodeWav(samples, sampleRate) {
    const numSamples = samples.length;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);
    function writeString(offset, s) {
      for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    }
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, numSamples * 2, true);
    for (let i = 0; i < numSamples; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  function sineSamples(freqHz, durationSec, sampleRate) {
    const total = Math.floor(sampleRate * durationSec);
    const out = new Float32Array(total);
    for (let i = 0; i < total; i++) {
      out[i] = 0.3 * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
    }
    return out;
  }

  /** Produce a Blob URL of a 440Hz sine, mono, 44.1kHz, `seconds` long. */
  window.sineWavUrl = function sineWavUrl(seconds, freqHz) {
    const sr = 44100;
    const blob = encodeWav(sineSamples(freqHz || 440, seconds, sr), sr);
    return URL.createObjectURL(blob);
  };

  /**
   * Produce a MediaStream with BOTH a video track (from a canvas drawing loop)
   * and an audio track (from an OscillatorNode). Useful for regression-testing
   * the YouTube case: `<video>` whose captureStream() exposes a video track
   * the MediaRecorder cannot accept with an audio-only mimeType.
   * Returns { stream, stop, context }.
   */
  window.combinedAVStream = function combinedAVStream(freqHz) {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 120;
    const cctx = canvas.getContext('2d');
    let t = 0;
    let rafId = 0;
    function draw() {
      t += 1;
      cctx.fillStyle = `hsl(${t % 360}, 70%, 40%)`;
      cctx.fillRect(0, 0, canvas.width, canvas.height);
      cctx.fillStyle = 'white';
      cctx.font = '16px sans-serif';
      cctx.fillText(`frame ${t}`, 10, 30);
      rafId = requestAnimationFrame(draw);
    }
    draw();

    const videoStream = canvas.captureStream(30);
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    osc.frequency.value = freqHz || 440;
    const gain = ctx.createGain();
    gain.gain.value = 0.2;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain).connect(dest);
    osc.start();

    const stream = new MediaStream([
      videoStream.getVideoTracks()[0],
      dest.stream.getAudioTracks()[0],
    ]);

    return {
      stream,
      stop: () => {
        cancelAnimationFrame(rafId);
        try { osc.stop(); } catch { /* already stopped */ }
        try { ctx.close(); } catch { /* already closed */ }
      },
      context: ctx,
    };
  };

  /** Loop a sine via Web Audio (no media element). Returns { stop }. */
  window.startWebAudioSine = function startWebAudioSine(freqHz) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    osc.frequency.value = freqHz || 440;
    const gain = ctx.createGain();
    gain.gain.value = 0.2;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    return {
      stop: () => {
        try {
          osc.stop();
        } catch {
          /* already stopped */
        }
        try {
          ctx.close();
        } catch {
          /* already closed */
        }
      },
      context: ctx,
    };
  };
})();
