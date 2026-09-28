#!/usr/bin/env node
// scripts/test/keychain-entitlement-boundary-test.mjs — which signed processes
// may reach the app's keychain namespace, read from the entitlement plists
// themselves.
//
// ## The invariant this guards
//
// The content key of an upload that has not finished is filed in the keychain
// under `KeychainStoredLinkKeyStore.pendingUploadPrefix` ("pending-upload-key:",
// apps/RelayiumKit/Sources/RelayiumKit/Account/StoredLinkKeyStore.swift), in ONE
// namespace per app: the shared team group `7PVYUG4YQS.com.relayium.shared` on
// macOS (`AppEnvironment.keychainAccessGroup`), the app's own default group on
// iOS (`accessGroup: nil`). The launch sweep that deletes pending keys and job
// directories is safe only because NO OTHER PROCESS can hold a pending key: the
// Share extensions stage plaintext into the App Group and stop, and the key for
// a shared draft is minted in the APP when the user presses Send.
//
// That "no other process" is not a runtime fact any test can observe. It is the
// ABSENCE of one entitlement, `keychain-access-groups`, from each extension. The
// entitlement's PRESENCE is what grants access — an empty array is still a
// claim that a later edit only has to fill — so the key itself is refused, not
// a particular value. The two app targets that DO use the shared group are held
// to it from the other side, so the guard fails in both directions: a group
// that leaks into an extension, and a group that silently leaves the app (and
// with it the namespace every stored and pending key lives in).
//
// ## Why a parser, and why it is strict
//
// A substring search would count a key inside an XML comment (every one of these
// files argues its absences in comments that NAME `keychain-access-groups`) and
// would miss `keychain&#45;access-groups`. So each file is parsed as an XML
// property list: comments, the XML declaration and the DOCTYPE are dropped, the
// element tree is built, entities are decoded, and the top-level `<dict>` keys
// are what is judged. Anything the parser does not understand — CDATA, a
// processing instruction mid-file, an unknown element, text outside a string, a
// duplicate key — THROWS rather than being skipped, because a mis-read plist is
// the one thing that would make every rule below pass vacuously.
//
// ## Why it also enumerates files and build settings
//
// A guard over two fixed paths passes on a renamed file if it skips it, and
// passes on a NEW entitlements file an extension target is repointed at. So a
// missing classified file fails, every `*.entitlements` under `apps/` must be
// classified, and every entitlements path a target is signed with — the
// `CODE_SIGN_ENTITLEMENTS` settings in both Xcode projects and the Engineering
// xcconfig — must be a classified file and every classified file must be used.
// Which TARGET uses which file is asserted by the Swift suites that already own
// that mapping (`MacHardenedRuntimeTests`, `MacAppStoreSigningTests`,
// `IOSSurfaceGuardTests`); this file does not re-parse the pbxproj object graph.
//
// ## Why it proves itself
//
// The evaluation is a pure function over an in-memory snapshot, so after the
// real tree passes, each rule is broken in memory and must be reported: a key
// with an empty array planted in each extension, a non-empty one, an
// entity-encoded one, the group removed from each app, the value changed, a
// file renamed, an unclassified file added, a target repointed, the
// AppEnvironment literal changed, and malformed or duplicate-key plists. A
// commented-out key is the positive control and must still pass.
//
// No dependencies, Linux, milliseconds: it runs in `repo-hygiene.yml`'s
// unfiltered `repository-policy` job, so an entitlement edit is judged by the
// commit that makes it.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = new URL("../../", import.meta.url);
const INVARIANT =
  "pending upload keys are app-only: the Share extension stages plaintext and the " +
  "content key is minted in the app (KeychainStoredLinkKeyStore.pendingUploadPrefix, " +
  "apps/RelayiumKit/Sources/RelayiumKit/Account/StoredLinkKeyStore.swift); the " +
  "launch sweep that deletes pending keys and job directories is safe only while no " +
  "other process can hold one, and the entitlement's PRESENCE — even with an empty " +
  "array — is what grants keychain access";

const KEY = "keychain-access-groups";
const SHARED_GROUP_ENTRY = "$(AppIdentifierPrefix)com.relayium.shared";
const TEAM_PREFIX = "7PVYUG4YQS.";

// Must NOT carry the key. The two Share extensions are the invariant; the
// Engineering pair is a separate identity whose `keychainAccessGroup` is nil in
// AppEnvironment and must never reach production's shared namespace; the iOS
// app keeps its keys in its own default group (`accessGroup: nil`).
const ABSENT = {
  "apps/mac/RelayiumShare/RelayiumShare.entitlements": "the macOS Share extension (direct and App Store builds)",
  "apps/ios/RelayiumShare/RelayiumShare.entitlements": "the iOS Share extension",
  "apps/mac/Engineering/RelayiumShare.entitlements": "the Engineering candidate's Share extension",
  "apps/mac/Engineering/Relayium.entitlements": "the Engineering candidate app (AppEnvironment.keychainAccessGroup is nil for it)",
  "apps/ios/Relayium/Relayium.entitlements": "the iOS app (its keys live in its own default group; accessGroup: nil)",
};
// MUST carry exactly the shared group.
const PRESENT = {
  "apps/mac/Relayium/Relayium.entitlements": "the macOS direct-download app",
  "apps/mac/RelayiumAppStore/Relayium.entitlements": "the Mac App Store app",
};
const CLASSIFIED = [...Object.keys(ABSENT), ...Object.keys(PRESENT)].sort();

const BUILD_SETTINGS = {
  "apps/mac/Relayium.xcodeproj/project.pbxproj": "apps/mac/",
  "apps/ios/Relayium.xcodeproj/project.pbxproj": "apps/ios/",
  "apps/mac/Engineering/Engineering.xcconfig": "apps/mac/",
};
const APP_ENVIRONMENT = "apps/RelayiumKit/Sources/RelayiumAppKit/AppEnvironment.swift";

// ---------------------------------------------------------------------------
// A strict XML property-list reader for the subset entitlements use.

const ENTITY = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decode(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);|&/g, (m, name) => {
    if (name === undefined) throw new Error("bare '&' in plist text");
    if (name.startsWith("#x")) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(parseInt(name.slice(1), 10));
    if (!(name in ENTITY)) throw new Error(`unknown entity &${name};`);
    return ENTITY[name];
  });
}

export function parsePlist(source) {
  let s = source.replace(/^\uFEFF/, "");
  if (s.includes("<![CDATA[")) throw new Error("CDATA is not supported");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  if (s.includes("<!--") || s.includes("-->")) throw new Error("unterminated comment");
  s = s.replace(/^\s*<\?xml[^?]*\?>/, "");
  s = s.replace(/^\s*<!DOCTYPE plist [^>]*>/, "");
  if (/<[?!]/.test(s)) throw new Error("unexpected declaration or processing instruction");

  const tokens = [];
  const re = /<(\/?)([A-Za-z][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*(\/?)>|([^<]+)|(<)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[6]) throw new Error(`malformed tag near offset ${m.index}`);
    if (m[5] !== undefined) tokens.push({ text: m[5] });
    else tokens.push({ close: m[1] === "/", name: m[2], attrs: m[3].trim(), empty: m[4] === "/" });
  }
  let i = 0;
  const skipSpace = () => { while (i < tokens.length && tokens[i].text !== undefined && !tokens[i].text.trim()) i++; };
  const expectClose = name => {
    const t = tokens[i++];
    if (!t || !t.close || t.name !== name) throw new Error(`expected </${name}>`);
  };
  const textUntilClose = name => {
    let out = "";
    if (tokens[i] && tokens[i].text !== undefined) out = decode(tokens[i++].text);
    expectClose(name);
    return out;
  };
  function value() {
    skipSpace();
    const t = tokens[i++];
    if (!t || t.text !== undefined || t.close) throw new Error("expected a plist value");
    if (t.attrs) throw new Error(`unexpected attributes on <${t.name}>`);
    switch (t.name) {
      case "true": case "false":
        if (!t.empty) { skipSpace(); expectClose(t.name); }
        return t.name === "true";
      case "string": case "date": case "data":
        return t.empty ? "" : textUntilClose(t.name);
      case "integer": case "real": {
        const text = t.empty ? "" : textUntilClose(t.name);
        if (!/^\s*[-+]?[0-9.eE+-]+\s*$/.test(text)) throw new Error(`bad <${t.name}> ${text}`);
        return Number(text);
      }
      case "array": {
        const out = [];
        if (t.empty) return out;
        for (;;) {
          skipSpace();
          if (tokens[i] && tokens[i].close) { expectClose("array"); return out; }
          out.push(value());
        }
      }
      case "dict": {
        const out = new Map();
        if (t.empty) return out;
        for (;;) {
          skipSpace();
          const k = tokens[i];
          if (k && k.close) { expectClose("dict"); return out; }
          if (!k || k.name !== "key" || k.close || k.attrs) throw new Error("expected <key> in <dict>");
          i++;
          const key = k.empty ? "" : textUntilClose("key");
          if (out.has(key)) throw new Error(`duplicate key ${key}`);
          out.set(key, value());
        }
      }
      default:
        throw new Error(`unknown plist element <${t.name}>`);
    }
  }
  skipSpace();
  const root = tokens[i++];
  if (!root || root.name !== "plist" || root.close || root.empty) throw new Error("expected <plist>");
  if (root.attrs && root.attrs !== 'version="1.0"') throw new Error(`unexpected <plist ${root.attrs}>`);
  const top = value();
  skipSpace();
  expectClose("plist");
  skipSpace();
  if (i !== tokens.length) throw new Error("content after </plist>");
  if (!(top instanceof Map)) throw new Error("top-level plist value is not a <dict>");
  return top;
}

// ---------------------------------------------------------------------------
// The evaluation: a pure function over { path -> content | undefined }.

export function evaluate(files) {
  const problems = [];
  const discovered = Object.keys(files).filter(p => p.endsWith(".entitlements")).sort();

  for (const path of CLASSIFIED) {
    if (files[path] === undefined) problems.push(`${path}: missing — a classified entitlements file was renamed or removed; ${INVARIANT}`);
  }
  for (const path of discovered) {
    if (!CLASSIFIED.includes(path) && files[path] !== undefined) {
      problems.push(`${path}: unclassified entitlements file — decide whether it may carry ${KEY} and add it to this guard; ${INVARIANT}`);
    }
  }

  const parse = path => {
    try { return parsePlist(files[path]); }
    catch (error) { problems.push(`${path}: not a plist this guard can read (${error.message})`); return null; }
  };
  for (const [path, who] of Object.entries(ABSENT)) {
    if (files[path] === undefined) continue;
    const plist = parse(path);
    if (plist && plist.has(KEY)) {
      problems.push(`${path}: ${who} claims ${KEY} (${JSON.stringify(plist.get(KEY))}) — it must be ABSENT, not merely empty; ${INVARIANT}`);
    }
  }
  for (const [path, who] of Object.entries(PRESENT)) {
    if (files[path] === undefined) continue;
    const plist = parse(path);
    if (!plist) continue;
    const groups = plist.get(KEY);
    if (!Array.isArray(groups) || groups.length !== 1 || groups[0] !== SHARED_GROUP_ENTRY) {
      problems.push(`${path}: ${who} must carry ${KEY} = [${SHARED_GROUP_ENTRY}] (got ${JSON.stringify(groups)}) — it is the one namespace every stored and pending key lives in on macOS (AppEnvironment.keychainAccessGroup)`);
    }
  }

  // The app-side literal the entitlement is the signed half of.
  const env = files[APP_ENVIRONMENT];
  if (env === undefined) {
    problems.push(`${APP_ENVIRONMENT}: missing`);
  } else {
    const mac = env.match(/static var keychainAccessGroup: String\? \{\s*isEngineeringCandidate \? nil : "([^"]+)"\s*\}/);
    if (!mac) problems.push(`${APP_ENVIRONMENT}: keychainAccessGroup is no longer "isEngineeringCandidate ? nil : <literal>"`);
    else if (mac[1] !== TEAM_PREFIX + SHARED_GROUP_ENTRY.replace("$(AppIdentifierPrefix)", "")) {
      problems.push(`${APP_ENVIRONMENT}: keychainAccessGroup "${mac[1]}" does not match the entitlement ${SHARED_GROUP_ENTRY} with prefix ${TEAM_PREFIX}`);
    }
    if (!/case \.iOS:\s*return KeychainConfiguration\(service: iosKeychainService,\s*account: keychainAccount,\s*accessGroup: nil\)/.test(env)) {
      problems.push(`${APP_ENVIRONMENT}: the iOS keychain configuration no longer names accessGroup: nil`);
    }
  }

  // Every entitlements file a target is signed with must be classified above,
  // and every classified file must be one some target is signed with.
  const referenced = new Set();
  for (const [path, base] of Object.entries(BUILD_SETTINGS)) {
    const text = files[path];
    if (text === undefined) { problems.push(`${path}: missing`); continue; }
    const values = [
      ...[...text.matchAll(/^\s*CODE_SIGN_ENTITLEMENTS = ("?)([^";\n]+)\1;?\s*$/gm)].map(x => x[2]),
      ...[...text.matchAll(/^\s*ENGINEERING_ENTITLEMENTS_\w+ = (.+?)\s*$/gm)].map(x => x[1]),
    ];
    for (const raw of values) {
      if (raw === "$(ENGINEERING_ENTITLEMENTS_$(TARGET_NAME))") continue;
      const resolved = base + raw.replace(/^\$\(PROJECT_DIR\)\//, "");
      if (resolved.includes("$(")) { problems.push(`${path}: unresolvable entitlements setting ${raw}`); continue; }
      referenced.add(resolved);
      if (!CLASSIFIED.includes(resolved)) problems.push(`${path}: a target is signed with ${resolved}, which this guard does not classify; ${INVARIANT}`);
    }
  }
  for (const path of CLASSIFIED) {
    if (!referenced.has(path)) problems.push(`${path}: no target is signed with this file any more — the guard would be judging a file nothing ships`);
  }
  return problems;
}

// ---------------------------------------------------------------------------

function walk(dir, out) {
  for (const entry of readdirSync(new URL(dir, ROOT), { withFileTypes: true })) {
    if ([".build", "node_modules", "DerivedData", "build", ".swiftpm"].includes(entry.name)) continue;
    const rel = `${dir}${entry.name}`;
    if (entry.isDirectory()) walk(`${rel}/`, out);
    else if (entry.name.endsWith(".entitlements")) out.push(rel);
  }
  return out;
}

function snapshot() {
  const files = {};
  const paths = new Set([...walk("apps/", []), ...CLASSIFIED, ...Object.keys(BUILD_SETTINGS), APP_ENVIRONMENT]);
  for (const path of paths) {
    const url = new URL(path, ROOT);
    files[path] = existsSync(url) ? readFileSync(url, "utf8") : undefined;
  }
  return files;
}

const REAL = snapshot();
const MAC_EXT = "apps/mac/RelayiumShare/RelayiumShare.entitlements";
const IOS_EXT = "apps/ios/RelayiumShare/RelayiumShare.entitlements";
const MAC_APP = "apps/mac/Relayium/Relayium.entitlements";
const STORE_APP = "apps/mac/RelayiumAppStore/Relayium.entitlements";

const plant = (text, fragment) => {
  const at = text.lastIndexOf("</dict>");
  assert.ok(at > 0, "no closing </dict> to plant before");
  return text.slice(0, at) + fragment + "\n" + text.slice(at);
};
const removeGroup = text => {
  const out = text.replace(/\s*<key>keychain-access-groups<\/key>\s*<array>[\s\S]*?<\/array>/, "");
  assert.notEqual(out, text, "the mutation did not remove the group");
  return out;
};
function mutated(changes) {
  const files = { ...REAL };
  for (const [path, change] of Object.entries(changes)) {
    files[path] = typeof change === "function" ? change(files[path]) : change;
  }
  return evaluate(files);
}
const expectFailure = (problems, pattern, label) => {
  assert.ok(problems.some(p => pattern.test(p)),
    `mutation "${label}" was not caught; got: ${JSON.stringify(problems, null, 2)}`);
};

test("the parser reads a plist's structure, not its text", () => {
  const sample = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<!-- <key>keychain-access-groups</key><array/> -->
<dict>
  <key>a</key><true/>
  <key>b</key><array><string>x &amp; y</string><string/></array>
  <key>c</key><dict><key>d</key><integer>3</integer></dict>
  <key>keychain&#45;access&#x2d;groups</key><array/>
</dict>
</plist>`;
  const plist = parsePlist(sample);
  assert.deepEqual([...plist.keys()], ["a", "b", "c", KEY]);
  assert.equal(plist.get("a"), true);
  assert.deepEqual(plist.get("b"), ["x & y", ""]);
  assert.equal(plist.get("c").get("d"), 3);
  assert.deepEqual(plist.get(KEY), []);
  for (const [bad, why] of [
    ['<plist version="1.0"><dict><key>a</key><true/><key>a</key><false/></dict></plist>', /duplicate/],
    ['<plist version="1.0"><dict><key>a</key><![CDATA[x]]></dict></plist>', /CDATA/],
    ['<plist version="1.0"><dict><key>a</key><bogus/></dict></plist>', /unknown plist element/],
    ['<plist version="1.0"><dict>text<key>a</key><true/></dict></plist>', /expected <key>/],
    ['<plist version="1.0"><dict><key>a</key><true/></dict>', /expected <\/plist>/],
    ['<plist version="1.0"><array/></plist>', /not a <dict>/],
    ['<plist version="1.0"><dict><!-- open </dict></plist>', /unterminated comment/],
    ['<plist version="1.0"><dict><key>a&bogus;</key><true/></dict></plist>', /unknown entity/],
  ]) assert.throws(() => parsePlist(bad), why);
});

test("the real tree: extensions claim no keychain group, the apps claim exactly the shared one", () => {
  for (const path of CLASSIFIED) assert.notEqual(REAL[path], undefined, `${path} is missing; ${INVARIANT}`);
  // Both extension files argue the absence in comments that NAME the key, so a
  // substring search would have been wrong from the start.
  for (const path of [MAC_EXT, IOS_EXT]) assert.ok(REAL[path].includes(KEY), `${path} no longer mentions ${KEY} in its comment`);
  const problems = evaluate(REAL);
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("every rule fails when it is broken (in-memory mutations)", () => {
  const cases = [
    ["empty-array key planted in the macOS extension",
      { [MAC_EXT]: t => plant(t, "\t<key>keychain-access-groups</key><array/>") },
      /RelayiumShare\/RelayiumShare\.entitlements: the macOS Share extension .* claims keychain-access-groups .*pending upload keys are app-only/],
    ["empty-array key planted in the iOS extension",
      { [IOS_EXT]: t => plant(t, "\t<key>keychain-access-groups</key>\n\t<array>\n\t</array>") },
      /apps\/ios\/RelayiumShare\/RelayiumShare\.entitlements: the iOS Share extension claims keychain-access-groups/],
    ["shared group planted in the macOS extension",
      { [MAC_EXT]: t => plant(t, "\t<key>keychain-access-groups</key><array><string>$(AppIdentifierPrefix)com.relayium.shared</string></array>") },
      /macOS Share extension .* claims keychain-access-groups \(\["\$\(AppIdentifierPrefix\)com\.relayium\.shared"\]\)/],
    ["entity-encoded key planted in the iOS extension",
      { [IOS_EXT]: t => plant(t, "\t<key>keychain&#45;access-groups</key><array/>") },
      /iOS Share extension claims keychain-access-groups/],
    ["key planted in the Engineering extension",
      { "apps/mac/Engineering/RelayiumShare.entitlements": t => plant(t, "\t<key>keychain-access-groups</key><array/>") },
      /Engineering candidate's Share extension claims keychain-access-groups/],
    ["key planted in the iOS app",
      { "apps/ios/Relayium/Relayium.entitlements": t => plant(t, "\t<key>keychain-access-groups</key><array/>") },
      /the iOS app .* claims keychain-access-groups/],
    ["group removed from the direct app",
      { [MAC_APP]: removeGroup },
      /apps\/mac\/Relayium\/Relayium\.entitlements: the macOS direct-download app must carry keychain-access-groups .*got undefined/],
    ["group removed from the App Store app",
      { [STORE_APP]: removeGroup },
      /RelayiumAppStore\/Relayium\.entitlements: the Mac App Store app must carry/],
    ["group emptied in the direct app",
      { [MAC_APP]: t => t.replace(/(<key>keychain-access-groups<\/key>\s*)<array>[\s\S]*?<\/array>/, "$1<array/>") },
      /direct-download app must carry .*got \[\]/],
    ["group renamed in the App Store app",
      { [STORE_APP]: t => t.replace("$(AppIdentifierPrefix)com.relayium.shared", "$(AppIdentifierPrefix)com.relayium.other") },
      /Mac App Store app must carry .*com\.relayium\.other/],
    ["macOS extension renamed",
      { [MAC_EXT]: undefined, "apps/mac/RelayiumShare/Share.entitlements": REAL[MAC_EXT] },
      /apps\/mac\/RelayiumShare\/RelayiumShare\.entitlements: missing/],
    ["iOS extension removed",
      { [IOS_EXT]: undefined },
      /apps\/ios\/RelayiumShare\/RelayiumShare\.entitlements: missing/],
    ["unclassified entitlements file added",
      { "apps/mac/RelayiumShare/Share.entitlements": REAL[MAC_EXT] },
      /Share\.entitlements: unclassified entitlements file/],
    ["extension target repointed at a new file",
      { "apps/mac/Relayium.xcodeproj/project.pbxproj": t => t.replaceAll("CODE_SIGN_ENTITLEMENTS = RelayiumShare/RelayiumShare.entitlements;", "CODE_SIGN_ENTITLEMENTS = RelayiumShare/Other.entitlements;") },
      /a target is signed with apps\/mac\/RelayiumShare\/Other\.entitlements/],
    ["Engineering xcconfig repointed",
      { "apps/mac/Engineering/Engineering.xcconfig": t => t.replace("Engineering/RelayiumShare.entitlements", "RelayiumShare/Other.entitlements") },
      /signed with apps\/mac\/RelayiumShare\/Other\.entitlements/],
    ["AppEnvironment macOS group changed",
      { [APP_ENVIRONMENT]: t => t.replace('"7PVYUG4YQS.com.relayium.shared"', '"7PVYUG4YQS.com.relayium.other"') },
      /keychainAccessGroup "7PVYUG4YQS\.com\.relayium\.other" does not match/],
    ["AppEnvironment iOS gains a group",
      { [APP_ENVIRONMENT]: t => t.replace("accessGroup: nil)", 'accessGroup: "x")') },
      /iOS keychain configuration no longer names accessGroup: nil/],
    ["malformed extension plist",
      { [MAC_EXT]: t => plant(t, "\t<key>x</key><![CDATA[y]]>") },
      /RelayiumShare\.entitlements: not a plist this guard can read \(CDATA/],
    ["duplicate key in an extension plist",
      { [IOS_EXT]: t => plant(t, "\t<key>com.apple.security.application-groups</key><array/>") },
      /not a plist this guard can read \(duplicate key/],
  ];
  for (const [label, changes, pattern] of cases) expectFailure(mutated(changes), pattern, label);
});

test("a commented-out key does not count (positive control)", () => {
  const problems = mutated({
    [MAC_EXT]: t => plant(t, "\t<!-- <key>keychain-access-groups</key><array/> -->"),
    [IOS_EXT]: t => plant(t, "\t<!--\n\t<key>keychain-access-groups</key>\n\t<array><string>x</string></array>\n\t-->"),
  });
  assert.deepEqual(problems, []);
});
