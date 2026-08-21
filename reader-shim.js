'use strict';

// Some ebook parser dependencies reuse the Node `path` package in the browser.
// Its browser build still calls process.cwd(), so provide only the harmless
// compatibility surface it needs without making PDF.js think it is in Node.
if (typeof globalThis.process === 'undefined') {
  globalThis.process = {
    browser: true,
    cwd: () => '/',
    env: {},
    versions: {},
    nextTick: (callback, ...args) => Promise.resolve().then(() => callback(...args)),
  };
}
