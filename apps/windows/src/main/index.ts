// The executable entry point.
//
// Separate from `main.ts` on purpose. `main.ts` exports `bootstrap()` and a few
// pure helpers, and the smoke test imports it to drive the real app — so if it
// also *invoked* `bootstrap()` at import time, the smoke run would start the app
// twice and the second scheme registration would fail. A module that does
// something merely by being imported cannot be tested by importing it.

import { app } from "electron";
import { bootstrap } from "./main.js";

bootstrap().catch((err: unknown) => {
  // A failed bootstrap must not leave a half-built privileged process sitting
  // there: no window, no tray, no IPC handlers, and a non-zero exit.
  process.stderr.write(`relayium: bootstrap failed: ${String(err)}\n`);
  app.exit(1);
});
