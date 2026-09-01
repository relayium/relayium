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

// jsdom has no layout engine, so `Element.prototype.scrollIntoView` is not
// merely a no-op there — it does not exist, and calling it throws a TypeError.
//
// The components that move focus to an in-page section (CliPage's rail and its
// on-load fragment handler) call scrollIntoView BEFORE focus({preventScroll:
// true}), which is the correct order in a real browser: it scrolls the section
// to the top rather than wherever focus() would have parked it. Guarding that
// call inside the component to keep jsdom happy would put test-shaped code in
// the product and make the ordering easy to lose. A no-op here keeps the
// component identical to what ships, and leaves the assertion that actually
// matters — which element ended up focused — testing jsdom's real focus model.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
