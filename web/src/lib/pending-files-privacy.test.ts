import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (relative: string) =>
  readFileSync(join(process.cwd(), "src", relative), "utf8");

describe("pending-file presentation stays local", () => {
  it("is a prop-only presentation component with no network, notification, log or analytics seam", () => {
    const component = source("lib/PendingFiles.svelte");
    for (const forbidden of [
      "fetch(", "WebSocket", "sendSignal", "Notification", "notifyTransfer",
      "console.", "analytics", "telemetry", "localStorage", "sessionStorage",
    ]) {
      expect(component, forbidden).not.toContain(forbidden);
    }
    expect(component).toContain("safeDisplayName");
    expect(component).toContain("formatSize");
  });

  it("keeps outbox as the sole queued-file state and never imports it into signaling or roster code", () => {
    const outbox = source("lib/outbox.svelte.ts");
    expect(outbox).toMatch(/let files = \$state<PickedFile\[\]>/);
    expect(outbox).not.toContain("name:");
    expect(outbox).not.toContain("size:");

    for (const file of ["lib/signaling.ts", "lib/protocol.ts", "lib/peer-caps.svelte.ts"]) {
      const wire = source(file);
      expect(wire, file).not.toMatch(/PendingFiles|outbox\.svelte|sharePending/);
    }
  });

  it("keeps transfer notifications count-only rather than exposing pending file names", () => {
    const app = source("App.svelte");
    const start = app.indexOf("function statusText");
    const end = app.indexOf("function pathLabel", start);
    const notificationCopy = app.slice(start, end);

    expect(notificationCopy).toContain("x.files.length");
    expect(notificationCopy).not.toMatch(/\.name|xferLabel|outbox|PendingFiles/);
    expect(app).not.toMatch(/notifyTransfer\([^)]*(?:outbox|PendingFiles|safeDisplayName)/);
  });
});
