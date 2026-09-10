// The one place that loads the stored-link runtime artifact.
//
// `runtime-contract.ts` declares the shape; this resolves and types it. Nothing
// else in `src/main/stored/**` touches the artifact, so the shared-protocol
// dependency has exactly one entry point.
import type { StoredRuntime } from "./runtime-contract.js";

/**
 * The artifact path, relative to THIS module's compiled location.
 *
 * This file compiles to `dist/main/stored/runtime.js` and the bundle is emitted
 * to `dist/main/stored-runtime.js`, so the artifact is one directory UP — `../`,
 * not `./`. Resolved from `import.meta.url` rather than `process.cwd()` so it
 * follows the module wherever the app is installed, the same discipline the
 * native helper path uses.
 */
const ARTIFACT_SPECIFIER = "../stored-runtime.js";

export class StoredRuntimeUnavailableError extends Error {
  constructor(cause: string) {
    // The message names the artifact and the build, never a resolved
    // filesystem path: this string can reach a log, and an install path is the
    // user's business.
    super(`stored runtime unavailable: ${cause}`);
    this.name = "StoredRuntimeUnavailableError";
  }
}

/**
 * Where the artifact sits relative to a compiled module base.
 *
 * Pure and exported so the `../` derivation is TESTABLE. It cannot be exercised
 * through the default loader from a test, because the compiled layout has the
 * artifact at `dist/main/stored-runtime.js` while the source layout this suite
 * runs from would look for `src/main/stored-runtime.js`. `./` would resolve
 * inside `dist/main/stored/` and fail at startup; this function is what makes
 * that mistake a test failure instead.
 */
export function artifactURL(moduleBase: URL): URL {
  return new URL(ARTIFACT_SPECIFIER, moduleBase);
}

/** How the artifact is fetched. Injected only by the conformance test. */
export type RuntimeLoader = () => Promise<{ default?: unknown }>;

const defaultLoader: RuntimeLoader = () =>
  import(artifactURL(new URL(import.meta.url)).href) as Promise<{ default?: unknown }>;

let loaded: Promise<StoredRuntime> | null = null;

/**
 * Load the runtime once.
 *
 * Memoised on the PROMISE so concurrent callers share one load, and cleared on
 * failure so a transient problem is retryable rather than cached forever.
 */
export function storedRuntime(load: RuntimeLoader = defaultLoader): Promise<StoredRuntime> {
  if (loaded !== null) return loaded;
  const attempt = (async (): Promise<StoredRuntime> => {
    let module: { default?: unknown };
    try {
      module = await load();
    } catch (error) {
      throw new StoredRuntimeUnavailableError(
        `${ARTIFACT_SPECIFIER} could not be loaded (${(error as Error).name}); run \`vite build --config vite.stored.config.ts\``,
      );
    }
    const candidate = module.default;
    if (candidate === undefined || candidate === null || typeof candidate !== "object") {
      throw new StoredRuntimeUnavailableError(`${ARTIFACT_SPECIFIER} has no default export`);
    }
    return candidate as StoredRuntime;
  })();
  loaded = attempt;
  attempt.catch(() => {
    if (loaded === attempt) loaded = null;
  });
  return attempt;
}

/** Test seam: forget a memoised load. Not used by product code. */
export function resetStoredRuntimeForTest(): void {
  loaded = null;
}
