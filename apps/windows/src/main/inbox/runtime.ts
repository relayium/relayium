// The one place that loads the Inbox runtime artifact.
//
// `runtime-contract.ts` declares the shape; this resolves and types it. Nothing
// else in `src/main/inbox/**` touches the artifact, so the shared-protocol
// dependency has exactly one entry point.
import type { InboxRuntime } from "./runtime-contract.js";

/**
 * The artifact path, relative to THIS module's compiled location.
 *
 * This file compiles to `dist/main/inbox/runtime.js` and the bundle is emitted
 * to `dist/main/inbox-runtime.js`, so the artifact is one directory UP — `../`,
 * not `./`. Resolved from `import.meta.url` rather than `process.cwd()` so it
 * follows the module wherever the app is installed, the same discipline the
 * native helper path uses.
 */
const ARTIFACT_SPECIFIER = "../inbox-runtime.js";

export class InboxRuntimeUnavailableError extends Error {
  constructor(cause: string) {
    // The message names the artifact, never a resolved filesystem path: this
    // string can reach a log, and an install path is the user's business.
    super(`inbox runtime unavailable: ${cause}`);
    this.name = "InboxRuntimeUnavailableError";
  }
}

/**
 * Where the artifact sits relative to a compiled module base.
 *
 * Pure and exported so the `../` derivation is TESTABLE. It cannot be exercised
 * through the default loader from a test, because the compiled layout has the
 * artifact at `dist/main/inbox-runtime.js` while the source layout this suite
 * runs from would look for `src/main/inbox-runtime.js`. An earlier draft of the
 * plan wrote `./inbox-runtime.js`, which would have resolved inside
 * `dist/main/inbox/` and failed at startup; this function is what makes that
 * mistake a test failure instead.
 */
export function artifactURL(moduleBase: URL): URL {
  return new URL(ARTIFACT_SPECIFIER, moduleBase);
}

/** How the artifact is fetched. Injected only by the conformance test. */
export type RuntimeLoader = () => Promise<{ default?: unknown }>;

const defaultLoader: RuntimeLoader = () =>
  import(artifactURL(new URL(import.meta.url)).href) as Promise<{ default?: unknown }>;

let loaded: Promise<InboxRuntime> | null = null;

/**
 * Load the runtime once.
 *
 * Memoised on the PROMISE so concurrent callers share one load, and cleared on
 * failure so a transient problem is retryable rather than cached forever.
 */
export function inboxRuntime(load: RuntimeLoader = defaultLoader): Promise<InboxRuntime> {
  if (loaded !== null) return loaded;
  const attempt = (async (): Promise<InboxRuntime> => {
    let module: { default?: unknown };
    try {
      module = await load();
    } catch (error) {
      throw new InboxRuntimeUnavailableError(
        `${ARTIFACT_SPECIFIER} could not be loaded (${(error as Error).name}); run \`npm run build:inbox\``,
      );
    }
    const candidate = module.default;
    if (candidate === undefined || candidate === null || typeof candidate !== "object") {
      throw new InboxRuntimeUnavailableError(`${ARTIFACT_SPECIFIER} has no default export`);
    }
    return candidate as InboxRuntime;
  })();
  loaded = attempt;
  attempt.catch(() => {
    if (loaded === attempt) loaded = null;
  });
  return attempt;
}

/** Test seam: forget a memoised load. Not used by product code. */
export function resetInboxRuntimeForTest(): void {
  loaded = null;
}
