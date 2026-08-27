import { describe, expect, it } from "vitest";
import type { CoreOpts, LinkCoreOpts, ResumeCoreOpts, SignalAuth } from "./webrtc-core";
import { LINK_CHANNEL_LABELS, signalGeneration } from "./webrtc-core";
import { readFileSync, readdirSync } from "node:fs";

// The deletion, asserted as a POSITIVE property of the shipped composition
// rather than as the absence of a check that is now correctly gone.
//
// A green suite proves nothing about a removal on its own: every one of these
// files would also pass if the legacy lanes were quietly wired back up beside
// the link. So each claim below is written as "exactly this, and nothing else",
// and each is a SURVIVAL-shaped claim wherever it can be — "this exact
// composition is what ships" rather than "that symbol is absent" — because an
// absence assertion is satisfied by any deleter, including a rename that put the
// same behaviour back under another name.
//
// Every claim here is deliberately reachable by a one-line edit to production
// source, so the mutations recorded for this task (accept non-exact link caps;
// re-add a legacy fallback call; bypass the room relay gate; attach an
// unauthenticated resume) each land on at least one of them rather than on a
// test that would have stayed green.

const read = (p: string) => readFileSync(p, "utf8");
const app = read("src/App.svelte");
const workspace = read("src/lib/peer-workspace.svelte.ts");

/** Every production module the browser bundle can reach. Tests, fixtures and
 *  generators are excluded: a test may legitimately NAME a retired lane while
 *  proving it is gone, which is exactly what this file does. */
function productionSources(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { walk(path); continue; }
      if (!/\.(ts|svelte)$/.test(entry.name)) continue;
      if (/\.test\.ts$/.test(entry.name) || /\.d\.ts$/.test(entry.name)) continue;
      out.push({ name: path, text: read(path) });
    }
  };
  walk("src");
  // A guard that silently walked an empty tree would pass every claim below.
  expect(out.length).toBeGreaterThan(80);
  return out;
}

describe("the browser composes link/1 and nothing else", () => {
  // The three modules the contraction deleted. Named as literal paths rather
  // than as identifiers, because an identifier-shaped guard survives the rename
  // that defeats it.
  it.each([
    "src/lib/transfer-session.svelte.ts",
    "src/lib/text-session.svelte.ts",
    "src/lib/text-link.ts",
  ])("has no %s to import", (path) => {
    expect(() => read(path)).toThrow();
  });

  it("imports no legacy session module anywhere in production source", () => {
    const offenders = productionSources().filter(({ text }) =>
      /from\s+["'][./]*(transfer-session\.svelte|text-session\.svelte|text-link)["']/.test(text));
    expect(offenders.map((o) => o.name)).toEqual([]);
  });

  it("constructs no legacy session or lane arbitration anywhere in production source", () => {
    // The constructors, the lane selector and the roster adapter the two lanes
    // shared. Any one of them reappearing is a second transport.
    for (const symbol of [
      "createTransferSession", "createTextSession", "createTextLink",
      "createLaneClaim", "createRosterDepartures", "routeOffer", "isTextOffer",
      // The transport primitives the deleted lanes dialled with. Each one is a
      // complete, working way to build a second connection, so leaving an
      // uncalled export behind is leaving the fallback one import away.
      "connectText", "connectResume",
    ]) {
      const offenders = productionSources()
        .filter(({ text }) => text.includes(`${symbol}(`))
        .map((o) => o.name);
      expect(offenders, symbol).toEqual([]);
    }
  });

  it("hands the workspace router no legacy transport to fall back to", () => {
    // The fallback callbacks themselves. `App.svelte` used to pass two adapter
    // objects; the router used to name them in fifteen places.
    for (const dep of ["legacyFiles", "legacyText"]) {
      expect(app, dep).not.toContain(dep);
      expect(workspace, dep).not.toContain(dep);
    }
    // …and the router's decision points hold no `else` that reaches a second
    // transport. Each of these is the exact shipped text.
    expect(workspace).toContain("if (!routes(peerId)) return;\n      clearSuppressionForIntent(peerId);\n      mixed.file.enqueue(peerId, files);");
    expect(workspace).toContain("acceptFile() { mixed.file.accept(); },");
    expect(workspace).toContain("conn() { return mixed.link?.conn ?? null; },");
  });

  it("keeps the capability gate exact, and reads it for every intent", () => {
    // `routes` is the only admission answer, and it is the EXACT `link/1` test —
    // not a prefix, not a case-fold, not "announced something".
    expect(workspace).toContain("const supports = deps.supportsLink ?? peerSupportsLink;");
    expect(workspace).toContain("return deps.joined() && deps.selfId() !== \"\" && supports(peerId);");
    // Both user intents are gated on it, and both return rather than redirect.
    for (const intent of ["sendFiles(peerId, files) {", "async openText(peerId) {"]) {
      const start = workspace.indexOf(intent);
      expect(start, intent).toBeGreaterThan(-1);
      const body = workspace.slice(start, workspace.indexOf("\n    },", start));
      expect(body, intent).toContain("if (!routes(peerId)) return;");
    }
  });

  it("offers a conversation only to a peer that routes link/1", () => {
    // A `text/1`-only peer has no lane to open, so the composer must not be
    // offered to it — and the predicate that used to answer "did this peer
    // announce text/1" is gone from the module, not merely unread. An unused
    // exported predicate is a routing decision waiting to be made again.
    // The composer is reachable only from the workspace a routing peer opens…
    expect(app).toContain("{@const unifiedPeer = workspace.routes(p.id)}");
    expect(app).toContain("{#if unifiedPeer}");
    // …and there is no second, capability-independent entry point to it.
    const card = app.slice(app.indexOf("{#snippet peerCard("), app.indexOf("{#snippet transferSurface()"));
    expect(card.slice(card.indexOf("{:else}", card.indexOf('<div class="peer-actions">'))))
      .not.toContain("workspace.openText(p.id)");
    for (const { name, text } of productionSources()) {
      expect(text, name).not.toContain("peerSupportsText");
    }
  });

  it("advertises only what it can honour", () => {
    // The hello is the one input a peer is entitled to act on, so a capability
    // this build cannot serve is not a harmless leftover: a peer that took
    // `text/1` up reached a page with no lane to open it on. `link/1` and
    // `preupload/1` stay EXACT — contracting the announcement must not become
    // contracting the protocol.
    const caps = read("src/lib/peer-caps.svelte.ts");
    expect(caps).toContain("return linkRoomActive() ? [CAP_LINK, CAP_PREUPLOAD] : [];");
    // The constant survives the announcement, deliberately: a native peer still
    // sends `text/1`, and a fixture that has to describe such a peer should name
    // it rather than spell it. What must not survive is any production reader.
    expect(caps).toContain('export const CAP_TEXT = "text/1";');
    const advertise = caps.slice(caps.indexOf("export function advertisedCaps"));
    expect(advertise).not.toContain("CAP_TEXT");
  });

  it("keeps exactly one way to build a transport, and one way to rebuild it", () => {
    // `webrtc.ts` used to export four constructors: three commit-reveal
    // generations and one shared resume. Two of the three and the shared resume
    // had no production caller left after the lanes went, and an uncalled
    // constructor is not dead weight — it is the whole of a second transport,
    // ready for whoever needs to "just get files through" one afternoon.
    const rtc = read("src/lib/webrtc.ts");
    const constructors = [...rtc.matchAll(/^export (?:async )?function (connect\w*)/gm)]
      .map((m) => m[1]);
    expect(constructors).toEqual(["connectLink", "connectResumeLink"]);
    // The generation is written into the one handshake rather than passed in.
    // A generation PARAMETER is exactly what a reintroduced `connect()` needs.
    expect(rtc).toContain('const generation: Generation = "link";');
    expect(rtc).not.toMatch(/handshakeConnect\(opts, ["'`]/);
    // The vocabulary itself stays complete: `peer-link` compares
    // `signalGeneration(msg) === "link"` exactly, and an exact comparison needs
    // the other generations to exist in order to reject them.
    const core = read("src/lib/webrtc-core.ts");
    expect(core).toContain('export type Generation = "file" | "resume" | "text" | "link";');
  });

  it("keeps exactly one conversation getter on the surface", () => {
    // `activeText` was the retaining twin of `surfaceText`, and existed only
    // because a legacy transcript had to stay rendered while a link lane was
    // idle. One lane, one getter.
    expect(app).not.toMatch(/activeText/);
    expect(app).toContain("const surfaceText = $derived(workspace.text);");
  });
});

describe("a drop has nowhere to go unless the sole peer routes link/1", () => {
  // **The defect this pins.** `dropBusy` checked only whether a peer was
  // mid-intent, so a sole peer that announced nothing, `text/1`, `LINK/1` or a
  // later `link/2` still made `dropTarget` answer "send". The overlay invited
  // the drop, the handler accepted it, and `workspace.sendFiles` handed the
  // router a batch it drops — the file went nowhere and nothing was said.
  //
  // The paste handler beside it had required `routes` all along, which is what
  // makes this an omission rather than a decision.
  const source = read("src/App.svelte");

  it("puts routes(peer) in the predicate that decides the overlay", () => {
    const predicate = source.slice(source.indexOf("const dropBusy = $derived("),
                                   source.indexOf("`storedReceiver` is part of this test"));
    expect(predicate).toContain("workspace.blocksNewIntent(peer.id)");
    expect(predicate).toContain("!workspace.routes(peer.id)");
    // Both, not either: a busy peer that routes and an idle peer that does not
    // are both unable to take a drop, and dropping one half re-opens the hole.
    expect(predicate).toMatch(/blocksNewIntent\(peer\.id\)\s*\|\|\s*!workspace\.routes\(peer\.id\)/);
  });

  it("re-asks at drop time rather than trusting the frame that drew the overlay", () => {
    const handler = source.slice(source.indexOf("const onWindowDrop = (e: DragEvent) => {"),
                                 source.indexOf("const onPaste = (e: ClipboardEvent)"));
    expect(handler).toContain("if (!peer || !workspace.routes(peer)) return;");
  });

  // **`preventDefault` IS the consumption**, and the first version of this fix
  // called it before the route check — so an unroutable drop was still taken
  // away from the browser and then dropped on the floor: no overlay, no error,
  // no transfer, and the OS default (open or download it) suppressed. The file
  // simply vanished.
  //
  // An earlier version of THIS test asserted only that the route check preceded
  // `filesFromDataTransfer`, which is true of the broken code too. Ordering
  // against `preventDefault` is the assertion that would have caught it.
  it("prevents the browser default only after every gate has passed", () => {
    const handler = source.slice(source.indexOf("const onWindowDrop = (e: DragEvent) => {"),
                                 source.indexOf("const onPaste = (e: ClipboardEvent)"));
    const prevent = handler.indexOf("e.preventDefault();");
    expect(prevent).toBeGreaterThan(-1);
    for (const gate of ["if (!surfaceShown) return;",
                        'if (dropTarget(visiblePeers.length, dropBusy) !== "send") return;',
                        "if (!transfer) return;",
                        "if (!peer || !workspace.routes(peer)) return;"]) {
      expect(handler).toContain(gate);
      expect(handler.indexOf(gate), gate).toBeLessThan(prevent);
    }
    // …and exactly one, so a second call cannot creep back above the gates.
    expect(handler.match(/e\.preventDefault\(\)/g)).toHaveLength(1);
    // The files are only read after the default has been taken deliberately.
    expect(prevent).toBeLessThan(handler.indexOf("filesFromDataTransfer(transfer)"));
  });

  it("uses the same routing answer the paste handler and the peer card use", () => {
    // One predicate, three surfaces. A second spelling here is how the drop path
    // drifted away from the paste path in the first place.
    expect(source).toContain("{@const unifiedPeer = workspace.routes(p.id)}");
    const paste = source.slice(source.indexOf("const onPaste = (e: ClipboardEvent)"));
    expect(paste).toContain("workspace.routes(");
  });
});

describe("only link and resume can be constructed", () => {
  const core = read("src/lib/webrtc-core.ts");

  // **Two vocabularies, and the distinction is the point.** `Generation` is the
  // INBOUND classification and must keep naming `file` and `text` — a tag this
  // code could not classify would fall through to `file` and be answered as a
  // legacy transfer, which is the failure the tags exist to prevent.
  // `OutboundGeneration` is what can be built, and the retired lanes are not in
  // it.
  it("keeps the inbound vocabulary able to recognise the retired lanes", () => {
    expect(core).toContain('export type Generation = "file" | "resume" | "text" | "link";');
    const classify = core.slice(core.indexOf("export function signalGeneration("));
    expect(classify).toContain('if (msg.text) return "text";');
    expect(classify).toContain('return "file";');
  });

  // **These read shapes; the `@ts-expect-error` block at the bottom of this
  // file is what proves the type refuses anything.** An earlier version of
  // these two asserted "generation is required" and "channelLabels is required",
  // both of which were TRUE of a `CoreOpts` that still admitted an
  // unauthenticated single-channel resume — a false green, and the reason the
  // negative coverage exists.
  it("splits construction from classification, with no untagged default", () => {
    expect(core).toContain('export type OutboundGeneration = "resume" | "link";');
    expect(core).toContain("export type CoreOpts = LinkCoreOpts | ResumeCoreOpts;");
    expect(core).not.toContain("generation?: Generation");
    expect(core).not.toContain('generation = "file"');
    // The two members carry the requirements an intersection could not express.
    expect(core).toContain('  generation: "link";');
    expect(core).toContain("  auth?: never;");
    expect(core).toContain('  generation: "resume";');
    expect(core).toContain("  auth: SignalAuth;");
  });

  it("tags outbound signals exhaustively, with no untagged branch", () => {
    const tag = core.slice(core.indexOf('generation === "resume" ?'),
                           core.indexOf('generation === "resume" ?') + 160);
    expect(tag).toContain("{ ...msg, resume: true }");
    expect(tag).toContain("{ ...msg, link: true }");
    expect(tag).not.toContain("text: true");
    // `: msg` was the untagged fallback — unreachable once both generations are
    // handled, and exactly what a mis-wired call site used to fall into.
    expect(tag).not.toContain(": msg;");
  });

  it("types the channel labels as the exact link tuple", () => {
    expect(core).toContain('export const LINK_CHANNEL_LABELS = ["relayium", "relayium-text"] as const;');
    expect(core).toContain("  channelLabels: LinkChannelLabels;");
    expect(core).not.toContain("channelLabels: readonly string[];");
    expect(core).not.toContain('opts.channelLabels ?? ["relayium"]');
    // Declared in core so the option types can name the tuple, and re-exported
    // rather than redeclared — a second `readonly string[]` declaration is what
    // admitted the one-element list at the call sites.
    const webrtc = read("src/lib/webrtc.ts");
    expect(webrtc).toContain('export { LINK_CHANNEL_LABELS } from "./webrtc-core";');
    expect(webrtc).not.toMatch(/const LINK_CHANNEL_LABELS[^=]*=\s*\[/);
    expect(webrtc.match(/channelLabels: LINK_CHANNEL_LABELS/g)).toHaveLength(2);
  });

  it("still carries the link's commit-reveal and the authenticated resume", () => {
    // The contraction removes constructible legacy transports, not the
    // handshake or the resume that the surviving link depends on.
    const webrtc = read("src/lib/webrtc.ts");
    expect(webrtc).toContain("commit: selfCommit");
    expect(webrtc).toContain('generation: "resume"');
    expect(webrtc).toContain("auth:");
  });

  it("constructs from exactly two call sites, both naming their generation", () => {
    const webrtc = read("src/lib/webrtc.ts");
    expect(webrtc.match(/establish\(\{/g)).toHaveLength(2);
    const offenders = productionSources().filter(
      ({ name, text }) => name !== "src/lib/webrtc.ts" && /\bestablish\(\{/.test(text));
    expect(offenders.map((o) => o.name)).toEqual([]);
  });
});

// MARK: - the option types refuse what the guards above only describe

/**
 * **Negative type coverage.**
 *
 * The source assertions above read `webrtc-core.ts` for shapes, which cannot
 * tell whether the type actually refuses anything — an earlier version of them
 * passed against a `CoreOpts` that still admitted an unauthenticated
 * single-channel resume, because "required" was true of a field whose type was
 * `readonly string[]`.
 *
 * `@ts-expect-error` is the assertion that bites: each one FAILS `npm run check`
 * if the line beneath it ever starts compiling, and fails it as an unused
 * directive if that line was never an error. Both directions are enforced by
 * the same gate that types the product.
 */
describe("the establish option types refuse the retired shapes", () => {
  const signaling = {} as CoreOpts["signaling"];
  const auth = {} as SignalAuth;
  const base = { signaling, peerId: "p", role: "initiator" } as const;

  it("accepts the two legitimate shapes", () => {
    const link: LinkCoreOpts = {
      ...base, generation: "link", channelLabels: LINK_CHANNEL_LABELS,
    };
    const resume: ResumeCoreOpts = {
      ...base, generation: "resume", auth, channelLabels: LINK_CHANNEL_LABELS,
    };
    expect(link.generation).toBe("link");
    expect(resume.auth).toBe(auth);
  });

  it("rejects the retired generations", () => {
    const file: CoreOpts = {
      ...base,
      // @ts-expect-error - `file` is an inbound classification, never built
      generation: "file",
      channelLabels: LINK_CHANNEL_LABELS,
    };
    const text: CoreOpts = {
      ...base,
      // @ts-expect-error - `text` likewise: recognised on the wire, never built
      generation: "text",
      channelLabels: LINK_CHANNEL_LABELS,
    };
    expect([file.generation, text.generation]).toHaveLength(2);
  });

  it("rejects a resume with no authentication", () => {
    // @ts-expect-error - a resume re-attaches to a verified session; it must sign
    const unsigned: ResumeCoreOpts = {
      ...base, generation: "resume", channelLabels: LINK_CHANNEL_LABELS,
    };
    expect(unsigned.generation).toBe("resume");
  });

  it("rejects auth on the initial link handshake", () => {
    const early: LinkCoreOpts = {
      ...base, generation: "link",
      // @ts-expect-error - the link derives its keys through commit-reveal, so it
      // has nothing to sign with yet; accepting one would be a contradiction
      auth,
      channelLabels: LINK_CHANNEL_LABELS,
    };
    expect(early.generation).toBe("link");
  });

  it("rejects a single-lane connection in either generation", () => {
    const oneLink: LinkCoreOpts = {
      ...base, generation: "link",
      // @ts-expect-error - one lane is the retired transfer's shape
      channelLabels: ["relayium"],
    };
    const oneResume: ResumeCoreOpts = {
      ...base, generation: "resume", auth,
      // @ts-expect-error - a resume re-attaches to a link, so it needs both lanes
      channelLabels: ["relayium"],
    };
    expect([oneLink.generation, oneResume.generation]).toHaveLength(2);
  });

  it("rejects channel labels that are merely a string array", () => {
    const loose: readonly string[] = ["relayium", "relayium-text"];
    const wide: LinkCoreOpts = {
      ...base, generation: "link",
      // @ts-expect-error - `readonly string[]` is what admitted the one-element list
      channelLabels: loose,
    };
    expect(wide.generation).toBe("link");
  });

  it("keeps the inbound vocabulary able to name what construction refuses", () => {
    // The other half of the split: classification must still RECOGNISE the
    // retired lanes, or a legacy tag falls through to `file` and is answered as
    // a legacy transfer — the failure the tags exist to prevent.
    expect(signalGeneration({ text: true } as never)).toBe("text");
    expect(signalGeneration({} as never)).toBe("file");
    expect(signalGeneration({ link: true } as never)).toBe("link");
    expect(signalGeneration({ resume: true } as never)).toBe("resume");
  });
});
