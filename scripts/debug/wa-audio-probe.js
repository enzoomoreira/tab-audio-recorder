// WhatsApp Web audio playback probe.
//
// Paste into the DevTools console of web.whatsapp.com (Firefox, logged in),
// then play a voice message. Reports how WhatsApp emits the audio and whether
// captureStream/mozCaptureStream can tap it -- the two facts that decide why the
// extension's DOM strategy fails there.
//
// Firefox may block console paste: type `allow pasting` + Enter first.
// If the logs stay quiet after pressing play, run  __waCap()  while it plays.
(() => {
  const css = 'color:#25D366;font-weight:bold';
  const log = (...a) => console.log('%c[wa-probe]', css, ...a);

  const describe = (el) => ({
    tagName: el.tagName,
    connected: el.isConnected, // false => detached element, invisible to querySelectorAll
    src: el.currentSrc || el.src,
    srcKind: (el.currentSrc || el.src || '(none)').split(':')[0],
    paused: el.paused,
    readyState: el.readyState,
    duration: el.duration,
    hasStdCapture: typeof el.captureStream === 'function',
    hasMozCapture: typeof el.mozCaptureStream === 'function',
    el,
  });

  const tryCapture = (el, when) => {
    const cap = el.captureStream || el.mozCaptureStream;
    if (!cap) {
      log(when, '-> no captureStream/mozCaptureStream on element');
      return;
    }
    try {
      const s = cap.call(el);
      const audio = s.getAudioTracks();
      log(
        when,
        '-> captureStream OK | audioTracks =',
        audio.length,
        '| videoTracks =',
        s.getVideoTracks().length,
        '| trackStates =',
        audio.map((t) => `${t.readyState}/${t.muted ? 'muted' : 'live'}`),
      );
    } catch (e) {
      log(when, '-> captureStream THREW:', String(e));
    }
  };

  window.__waSeen = [];
  window.__waCap = () => {
    const els = [...document.querySelectorAll('audio,video'), ...window.__waSeen];
    const target = els.find((e) => e && !e.paused && e.readyState >= 2) || els[0];
    if (!target) {
      log('manual: no media element seen yet');
      return;
    }
    log('manual capture on:', describe(target));
    tryCapture(target, 'manual');
  };

  // 1) what is attached to the DOM right now
  log('attached <audio>/<video> now:', [...document.querySelectorAll('audio,video')].map(describe));

  // 2) play() on the prototype -> catches DETACHED elements (new Audio()) too
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    if (!window.__waSeen.includes(this)) window.__waSeen.push(this);
    log('play() ->', describe(this));
    tryCapture(this, 'at play()');
    this.addEventListener(
      'playing',
      () => {
        log('event "playing" fired (data flowing now)');
        tryCapture(this, 'on playing');
      },
      { once: true },
    );
    return origPlay.apply(this, args);
  };

  // 3) createMediaElementSource -> is the <audio> routed through Web Audio?
  const ACtx = window.AudioContext || window.webkitAudioContext;
  if (ACtx && ACtx.prototype.createMediaElementSource) {
    const orig = ACtx.prototype.createMediaElementSource;
    ACtx.prototype.createMediaElementSource = function (el) {
      log('createMediaElementSource() -> element IS routed through Web Audio', describe(el));
      return orig.call(this, el);
    };
  }

  // 4) AudioNode.connect -> any node reaching the speakers (Web Audio playback)
  if (typeof AudioNode !== 'undefined') {
    const origConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest, ...rest) {
      try {
        if (typeof AudioDestinationNode !== 'undefined' && dest instanceof AudioDestinationNode) {
          log('AudioNode.connect -> destination | node =', this.constructor.name);
        }
      } catch {
        /* ignore */
      }
      return origConnect.call(this, dest, ...rest);
    };
  }

  // 5) createObjectURL -> plain Blob vs MediaSource (MSE)
  const origCOU = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origCOU.call(this, obj);
    try {
      if (obj instanceof Blob) log('createObjectURL(Blob)', { type: obj.type, size: obj.size });
      else if (typeof MediaSource !== 'undefined' && obj instanceof MediaSource)
        log('createObjectURL(MediaSource) -> MSE IN USE');
    } catch {
      /* ignore */
    }
    return url;
  };

  log('probe installed. Play a voice message. If quiet, run  __waCap()  while it plays.');
})();
