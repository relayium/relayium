// Resolve a bare `electron` specifier to the host stub beside this file.
//
// Registered by the harness before it imports any product module that reaches
// `build-mode.ts`. Scoped to that ONE specifier: everything else resolves
// normally, so a module that needs something real still fails loudly.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const STUB = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "electron-host-stub.mjs")).href;

export function resolve(specifier, context, next) {
  if (specifier === "electron") return { url: STUB, shortCircuit: true };
  return next(specifier, context);
}
