// Vitest setup: Node.js 25 exposes a built-in `localStorage` getter (node:internal/webstorage)
// that populateGlobal skips because it already exists in the global. Replace it with
// the proper jsdom-backed Storage so tests can call localStorage.clear() etc.
const jsdomInstance = (globalThis as unknown as { jsdom?: { window: Window } }).jsdom;
if (jsdomInstance) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: jsdomInstance.window.localStorage,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    writable: true,
    value: jsdomInstance.window.sessionStorage,
  });
}
