// Small motion helpers used across the SPA. Both respect prefers-reduced-motion
// (they resolve to their final state instantly) and both degrade to a visible,
// final-value element if IntersectionObserver / rAF are unavailable.

const prefersReducedMotion = (): boolean =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

type RevealOpts = { delay?: number; threshold?: number; once?: boolean };

/**
 * Scroll-reveal action. The element should carry the `.reveal` class (opacity 0,
 * shifted down); this adds `.in` once it scrolls into view, triggering the CSS
 * transition. `delay` sets a per-element stagger via the --reveal-delay var.
 *
 *   <section class="reveal" use:reveal={{ delay: 80 }}>
 */
export function reveal(node: HTMLElement, opts: RevealOpts = {}) {
  const { delay = 0, threshold = 0.12, once = true } = opts;
  if (delay) node.style.setProperty("--reveal-delay", `${delay}ms`);

  // No observer (SSR/old browsers) or reduced motion: just show it.
  if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") {
    node.classList.add("in");
    return {};
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          node.classList.add("in");
          if (once) io.unobserve(node);
        } else if (!once) {
          node.classList.remove("in");
        }
      }
    },
    { threshold, rootMargin: "0px 0px -8% 0px" },
  );
  io.observe(node);
  return { destroy: () => io.disconnect() };
}

/**
 * Count-up action for an integer stat. Renders the value climbing from 0 to the
 * target the first time the node scrolls into view. Re-runs if the bound value
 * changes afterwards (e.g. stats refresh after a transfer).
 *
 *   <span use:countUp={stats.transfers}>0</span>
 */
export function countUp(node: HTMLElement, value: number) {
  let started = false;
  let raf = 0;
  // Track what we've painted ourselves. Svelte's reactive text also writes this
  // node, so we can't trust node.textContent as the animation's starting point.
  let shown = 0;

  const format = (n: number) => String(Math.round(n));
  const paint = (n: number) => { shown = n; node.textContent = format(n); };

  const run = (target: number, from = shown) => {
    if (prefersReducedMotion() || typeof requestAnimationFrame === "undefined") {
      paint(target);
      return;
    }
    cancelAnimationFrame(raf);
    const dur = 900;
    let t0 = 0;
    const step = (ts: number) => {
      if (!t0) t0 = ts;
      const p = Math.min(1, (ts - t0) / dur);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - p, 3);
      paint(from + (target - from) * eased);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };

  const start = (target: number) => {
    if (started) return;
    started = true;
    run(target, 0);
  };

  paint(0);

  let io: IntersectionObserver | null = null;
  if (typeof IntersectionObserver === "undefined") {
    start(value);
  } else {
    io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          start(value);
          io?.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(node);
  }

  return {
    update(next: number) {
      value = next;
      // Only animate updates after the first reveal has fired; animate from what
      // we last painted, not the node text (which Svelte may have just rewritten).
      if (started) run(next, shown);
    },
    destroy() {
      cancelAnimationFrame(raf);
      io?.disconnect();
    },
  };
}
