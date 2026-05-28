import { describe, it, expect, beforeEach } from 'vitest';
import { DOMScanner } from './DOMScanner';

function makePlayingAudio(): HTMLAudioElement {
  const el = document.createElement('audio');
  // happy-dom defaults: paused=true, readyState=0. Override to simulate playing.
  Object.defineProperty(el, 'paused', { get: () => false, configurable: true });
  Object.defineProperty(el, 'readyState', { get: () => 4, configurable: true });
  return el;
}

function makePausedAudio(): HTMLAudioElement {
  return document.createElement('audio');
}

function makePlayingVideo(): HTMLVideoElement {
  const el = document.createElement('video');
  Object.defineProperty(el, 'paused', { get: () => false, configurable: true });
  Object.defineProperty(el, 'readyState', { get: () => 4, configurable: true });
  return el;
}

describe('DOMScanner.find', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns null when no media in document', () => {
    expect(new DOMScanner().find()).toBeNull();
  });

  it('finds a direct <audio>', () => {
    const audio = makePausedAudio();
    document.body.append(audio);
    expect(new DOMScanner().find()).toBe(audio);
  });

  it('prefers playing video over paused audio', () => {
    document.body.append(makePausedAudio());
    const video = makePlayingVideo();
    document.body.append(video);
    expect(new DOMScanner().find()).toBe(video);
  });

  it('prefers playing audio over any paused element', () => {
    document.body.append(document.createElement('video'));
    document.body.append(makePausedAudio());
    const playing = makePlayingAudio();
    document.body.append(playing);
    expect(new DOMScanner().find()).toBe(playing);
  });

  it('falls back to any video when nothing is playing', () => {
    const video = document.createElement('video');
    document.body.append(makePausedAudio());
    document.body.append(video);
    expect(new DOMScanner().find()).toBe(video);
  });

  it('finds audio inside a shadow root', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const audio = makePlayingAudio();
    shadow.appendChild(audio);
    expect(new DOMScanner().find()).toBe(audio);
  });

  it('finds audio inside nested shadow roots', () => {
    const outer = document.createElement('div');
    document.body.append(outer);
    const outerShadow = outer.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    outerShadow.appendChild(inner);
    const innerShadow = inner.attachShadow({ mode: 'open' });
    const audio = makePlayingAudio();
    innerShadow.appendChild(audio);
    expect(new DOMScanner().find()).toBe(audio);
  });

  it('finds audio inside a same-origin iframe', () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const innerDoc = frame.contentDocument;
    expect(innerDoc).toBeTruthy();
    if (!innerDoc) return;
    const audio = makePlayingAudio.call(null);
    // Re-create inside iframe document (must be in the iframe's own doc).
    const innerAudio = innerDoc.createElement('audio');
    Object.defineProperty(innerAudio, 'paused', { get: () => false, configurable: true });
    Object.defineProperty(innerAudio, 'readyState', { get: () => 4, configurable: true });
    innerDoc.body.appendChild(innerAudio);
    void audio;
    expect(new DOMScanner().find()).toBe(innerAudio);
  });

  it('prefers a top-level playing video over a paused audio inside an iframe', () => {
    const video = makePlayingVideo();
    document.body.append(video);
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const innerDoc = frame.contentDocument;
    if (innerDoc) {
      innerDoc.body.appendChild(innerDoc.createElement('audio'));
    }
    expect(new DOMScanner().find()).toBe(video);
  });

  it('hasMedia mirrors find', () => {
    const scanner = new DOMScanner();
    expect(scanner.hasMedia()).toBe(false);
    document.body.append(makePausedAudio());
    expect(scanner.hasMedia()).toBe(true);
  });
});

describe('DOMScanner.diagnose', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('buckets direct, shadow, and iframe elements correctly', () => {
    document.body.append(document.createElement('audio'));

    const host = document.createElement('my-player');
    document.body.append(host);
    host.attachShadow({ mode: 'open' }).appendChild(document.createElement('audio'));

    const frame = document.createElement('iframe');
    document.body.append(frame);
    frame.contentDocument?.body.appendChild(frame.contentDocument.createElement('audio'));

    const report = new DOMScanner().diagnose();
    expect(report.directElements).toHaveLength(1);
    expect(report.shadowElements).toHaveLength(1);
    expect(report.shadowElements[0]?.inShadowOf).toBe('MY-PLAYER');
    expect(report.iframeElements).toHaveLength(1);
    expect(report.iframeElements[0]?.inIframe).toBe(0);
  });
});
