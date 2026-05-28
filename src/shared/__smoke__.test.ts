import { describe, it, expect } from 'vitest';

describe('smoke', () => {
  it('happy-dom is the DOM impl', () => {
    const el = document.createElement('div');
    el.textContent = 'hello';
    expect(el.textContent).toBe('hello');
  });

  it('browser shim is installed', () => {
    expect(browser).toBeDefined();
    expect(typeof browser.runtime.getURL).toBe('function');
  });

  it('fake-indexeddb is wired', () => {
    expect(indexedDB).toBeDefined();
  });
});
