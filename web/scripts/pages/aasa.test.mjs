import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/// The two native app targets, by full `<TeamID>.<BundleID>`. Both are named
/// under `applinks` because both route links: macOS has since the shell slice,
/// and iOS now claims `com.apple.developer.associated-domains =
/// [applinks:relayium.com]` and wires `onOpenURL` at its scene root. An
/// `applinks` app ID that no build claims would be the OS opening an app that
/// then does nothing with the link.
///
/// `webcredentials` is a DIFFERENT permission and stays macOS-only. It is the
/// site allowing password AutoFill for an app, which has nothing to do with
/// link routing: the iOS app claims no `webcredentials:` entitlement and its
/// sign-in form does not use AutoFill, so listing it here would widen a
/// credential-adjacent association ahead of any feature asking for it. Adding
/// the iOS app to this list is a deliberate change that arrives with that
/// feature, not a side effect of shipping Universal Links.
const macAppID = "7PVYUG4YQS.com.relayium.mac";
const iosAppID = "7PVYUG4YQS.com.relayium.app";

describe("Apple app site association", () => {
  it("associates both native app IDs with the two actionable link paths", async () => {
    const source = resolve(process.cwd(), "public/.well-known/apple-app-site-association");
    const aasa = JSON.parse(await readFile(source, "utf8"));

    expect(aasa.applinks.apps).toEqual([]);
    expect(aasa.applinks.details).toEqual([
      {
        appIDs: [macAppID, iosAppID],
        components: [
          { "/": "/d/*", comment: "shared download links open in the app" },
          { "/": "/cross-network", comment: "realtime pairing links open in the app" },
        ],
      },
    ]);
    expect(JSON.stringify(aasa)).not.toContain("TEAMID");
  });

  /// The iOS app is associated for links and for nothing else.
  ///
  /// `applinks` and `webcredentials` are separate permissions that happen to
  /// share a file, and the easy mistake is to add the new app ID to both lists
  /// because they sit a few lines apart. Password AutoFill is not the scope of
  /// this slice: no iOS entitlement asks for it and no iOS form uses it.
  it("keeps webcredentials to the macOS app, which is a separate permission", async () => {
    const source = resolve(process.cwd(), "public/.well-known/apple-app-site-association");
    const aasa = JSON.parse(await readFile(source, "utf8"));

    expect(aasa.webcredentials.apps).toEqual([macAppID]);
    expect(aasa.webcredentials.apps).not.toContain(iosAppID);
  });

  /// Claiming a path the apps cannot serve is worse than claiming none: the OS
  /// would open the app for it, and the app would put the user on a screen that
  /// has nothing to do with the link they tapped. `/d/*` and `/cross-network`
  /// are the only two `parseAppDeepLink` recognises, and the marketing, pricing,
  /// legal and account pages must keep opening in the browser.
  it("claims exactly the two routable paths and no marketing or account page", async () => {
    const source = resolve(process.cwd(), "public/.well-known/apple-app-site-association");
    const aasa = JSON.parse(await readFile(source, "utf8"));

    const paths = aasa.applinks.details.flatMap((d) => d.components.map((c) => c["/"]));
    expect(paths).toEqual(["/d/*", "/cross-network"]);
    expect(paths).not.toContain("*");
    expect(paths).not.toContain("/*");
    for (const unclaimed of [
      "/",
      "/pricing",
      "/plans",
      "/account",
      "/login",
      "/terms",
      "/privacy",
      "/apps",
      "/cli",
      "/cross-network/*",
    ]) {
      expect(paths).not.toContain(unclaimed);
    }
  });
});
