import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const expectedAppID = "7PVYUG4YQS.com.relayium.mac";

describe("Apple app site association", () => {
  it("associates only the released macOS app with actionable link paths", async () => {
    const source = resolve(process.cwd(), "public/.well-known/apple-app-site-association");
    const aasa = JSON.parse(await readFile(source, "utf8"));

    expect(aasa.applinks.apps).toEqual([]);
    expect(aasa.applinks.details).toEqual([
      {
        appIDs: [expectedAppID],
        components: [
          { "/": "/d/*", comment: "shared download links open in the app" },
          { "/": "/cross-network", comment: "realtime pairing links open in the app" },
        ],
      },
    ]);
    expect(aasa.webcredentials.apps).toEqual([expectedAppID]);
    expect(JSON.stringify(aasa)).not.toContain("TEAMID");
    expect(JSON.stringify(aasa)).not.toContain("com.relayium.app");
  });
});
