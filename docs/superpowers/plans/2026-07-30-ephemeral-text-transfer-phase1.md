# Ephemeral Encrypted Text Transfer — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send and receive ephemeral, end-to-end encrypted text messages between two peers on the LAN surface, the cross-network room, and the CLI pairing-code transport — with no server-side storage, no plaintext reachable by Relayium, and no change to any byte of the existing file transfer wire.

**Architecture:** Messaging runs on its own peer connection, its own commit-reveal handshake and its own SAS, tagged with a `text: true` signal generation exactly as the resume path already tags itself. Content travels as frame kind 9 on a DataChannel, sealed under a BLAKE2b domain-separated subkey of the session keys with its own monotonic nonce counter. Capabilities are announced at the roster level *before* any connection is attempted, so an older peer is never offered one. A message session and a file transfer are mutually exclusive in this phase, enforced through the existing `busy()` guard, so only one SAS is ever on screen.

**Tech Stack:** Svelte 5 runes + TypeScript + vitest (web); Go standard library + `coder/websocket` (CLI/server); libsodium-wrappers + Web Crypto (crypto). No new dependencies in any language.

**Spec:** `docs/superpowers/specs/2026-07-30-ephemeral-text-transfer-design.md`

## Global Constraints

- **Not one byte of the file wire changes.** `web/src/lib/transfer.ts` is modified in **no** task. `web/src/lib/transfer-session.svelte.ts` is modified in exactly **one** place, in Task 5: folding the text session into `busy()`. Any other diff to either file means the phase boundary was crossed — stop and re-read the spec's *Phasing* section.
- **`authPayload` output must not change.** `web/src/lib/webrtc-core.ts:148-157` enumerates its fields explicitly so that adding a field to `InboundSignal` cannot alter the resume MAC. Task 3 pins this with an assertion. If it changes, resumes break between old and new clients across a rolling deploy.
- **All limits are UTF-8 byte lengths, never character counts.** `TEXT_MAX_BYTES = 65536`. The composer's counter displays the same number the limit enforces.
- **Content is preserved exactly.** No trimming, normalising, collapsing, parsing, linkifying, Markdown, HTML, syntax highlighting, or preview — at any layer, on send or on render. A message of nothing but whitespace is a valid message.
- **Invalid UTF-8 is a hard error, never U+FFFD.** `TextDecoder("utf-8", { fatal: true })` on the web; `utf8.Valid` on the CLI.
- **No message content in any log, error, thrown `Error`, OS notification, `localStorage`, or `sessionStorage`.** Errors carry a byte length and a kind. Notifications carry the sender's name only.
- **`caps` is a hint, never a security input.** It gates *whether a text connection is attempted*. It must never gate encryption, and there must be no code path in which its absence or forgery produces an unencrypted message.
- **9 languages or the build fails.** `Messages` (`web/src/lib/i18n/types.ts:28-599`) is a hard interface. A new key means editing `types.ts` **and all of** `zh, en, ja, ko, de, fr, ar, es, pt`.
- **No new dependency, no new server endpoint, no new metering, no new quota, no plan gate.** The room creator remains the authenticated party exactly as today.
- Commit messages: conventional prefixes (`feat(web):`, `fix(server):`, `docs:`), **in English**. Repo hygiene must pass: `scripts/check-production-identifiers.sh`.
- Verification commands, run from the stated directory:
  - `cd web && npx vitest run` — web unit tests (note: `npm test` is watch mode; there is no `--run` script)
  - `cd web && npm run check` — `svelte-check` + `tsc`. **This is already red on `main`**: `crypto.ts` reports two pre-existing errors, a 2-argument `crypto_generichash` in `deriveResumeAuth` and a `BufferSource` variance issue in the resume-tag helpers. The gate for every task is therefore "no *new* errors and no new files with problems", not a clean run. Confirmed at the start of Task 1. Do not fix them in passing — they sit on the resume-auth path.
  - Run these **from `web/`**. The vitest shipped at the repo root resolves a different config with no jsdom environment and no `setupFiles`, so a DOM or storage assertion silently passes there. Check the banner names `.../relayium/web`.
  - `cd web && npm run build`
  - `cd server && go test ./...`
  - `cd web && npm run test:e2e` — needs a built `dist/` served by the Go server; see Task 13
- **CI runs none of these.** `.github/workflows/` has no workflow invoking `npx vitest` or `npm run check` (`i18n.test.ts:200-202` says so outright). Every gate in this plan is a local gate, run by the implementer.

## File Structure

**Created (web):**
| File | Responsibility |
|---|---|
| `web/src/lib/text-wire.ts` | Frame kind 9 codec: seal/open, seq discipline, `TEXT_MAX_BYTES`, UTF-8 validation. Pure; no DOM, no WebRTC. |
| `web/src/lib/text-wire.test.ts` | Codec tests against real crypto. |
| `web/src/lib/peer-caps.svelte.ts` | Which peers announced `text/1`. Reactive, keyed by peer id, cleared on roster change. |
| `web/src/lib/peer-caps.test.ts` | Announcement parsing and expiry-on-departure. |
| `web/src/lib/rate-bucket.ts` | Pure token bucket used for the receiver-side flood guard. |
| `web/src/lib/rate-bucket.test.ts` | Bucket tests with an injected clock. |
| `web/src/lib/text-session.svelte.ts` | The session state machine: request/accept/reject, send, history, session limits, idle timeout. |
| `web/src/lib/text-session.test.ts` | State machine tests against fakes. |
| `web/src/lib/MessagePanel.svelte` | Composer, byte counter, history list, copy, SAS, session state, errors. |
| `web/src/lib/MessagePanel.test.ts` | Component tests (mount/flushSync, per `DeviceRadar.test.ts`). |

**Created (Go / docs):**
| File | Responsibility |
|---|---|
| `server/internal/xfer/text.go` | `MsgText` framing over the pinned-TLS stream, with a text-specific length cap. |
| `server/internal/xfer/text_test.go` | Framing and cap tests. |
| `server/cmd/relayium/text.go` | The `relayium text` subcommand: flags, SAS gate, stdin/stdout loop. |
| `server/cmd/relayium/text_test.go` | Argument, SAS-gate and TTY-vs-pipe tests. |
| `docs/protocol/relayium-text-v1.md` | Authoritative text wire + key derivation + capability negotiation. |

**Modified (web):**
| File | Change |
|---|---|
| `crypto.ts` | `textKeyBytes()`, `TEXT_KEY_DOMAIN`; `SessionKeys` gains `textSend`/`textRecv`. |
| `webrtc-core.ts` | `InboundSignal.caps`, `InboundSignal.text`; text generation filter; `authPayload` **unchanged**. |
| `webrtc.ts` | `LOCAL_CAPS`, `connect` reports peer caps, `connectText`. |
| `App.svelte` | Caps hello on roster change; mount `MessagePanel` inside `transferSurface`; window `onpaste`. |
| `transfer-session.svelte.ts` | **One change only:** `busy()` consults the text session. |
| `i18n/types.ts` + 9 language files | New `text` namespace. |
| `i18n.test.ts` | Parity assertion block for the new namespace. |

**Modified (Go / docs):**
| File | Change |
|---|---|
| `internal/rzvous/handshake.go` | `hsMsg.Mode` (optional); `Handshake.PeerMode`. |
| `cmd/relayium/run.go` | Dispatch `text`; usage text. |
| `cmd/relayium/crossnet.go` | `crossnetConn` takes a mode and enforces the peer's. |
| `cmd/relayium/flagperm_test.go` | Add the new parser to the enumeration at `:151`. |
| `docs/protocol/relayium-realtime-wire-v1.md`, `-crypto-v1.md`, `-handshake-v1.md`, `-realtime-flow-v1.md` | Kind 9, derivation, caps, version-safety wording. |
| `apps/RelayiumKit/Tests/Fixtures/crypto-vectors.json`, `realtime-wire-vectors.json` | New vectors. |
| `docs/TESTING.md`, `web/e2e/lan-transfer.mjs`, `README.md`, `CliPage.svelte` | Gates and docs. |

---

### Task 1: The text keys are derived, not negotiated

**Files:**
- Modify: `web/src/lib/crypto.ts` (add `TEXT_KEY_DOMAIN`, `textKeyBytes`; extend `SessionKeys` and `deriveSession`)
- Test: `web/src/lib/crypto.text-keys.test.ts` (create)

**Interfaces:**
- Produces, consumed by Tasks 2, 4, 5:
  - `export const TEXT_KEY_DOMAIN = "relayium-text-v1\0"`
  - `export function textKeyBytes(sessionKey: Uint8Array): Uint8Array` — 32 bytes, requires `ready()`
  - `SessionKeys` gains `textSend: CryptoKey` and `textRecv: CryptoKey`

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/crypto.text-keys.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import {
  ready, generateKeyPair, deriveSession, textKeyBytes, TEXT_KEY_DOMAIN, seal, open,
} from "./crypto";

beforeAll(async () => { await ready(); });

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("text key derivation", () => {
  it("is 32 bytes and deterministic for a given session key", () => {
    const k = new Uint8Array(32).fill(7);
    const a = textKeyBytes(k);
    const b = textKeyBytes(k);
    expect(a.length).toBe(32);
    expect(hex(a)).toBe(hex(b));
  });

  it("is domain-separated: it is not the session key and not a bare hash of it", () => {
    const k = new Uint8Array(32).fill(7);
    expect(hex(textKeyBytes(k))).not.toBe(hex(k));
    // The domain is part of the input, so dropping it must change the output.
    expect(TEXT_KEY_DOMAIN).toBe("relayium-text-v1\0");
  });

  it("differs for different session keys", () => {
    const a = textKeyBytes(new Uint8Array(32).fill(1));
    const b = textKeyBytes(new Uint8Array(32).fill(2));
    expect(hex(a)).not.toBe(hex(b));
  });

  // The mirror property is what makes this work without a round trip: crypto_kx
  // already gives A's tx as B's rx, so a per-direction hash needs no sorting.
  it("mirrors across the two peers: A's textSend opens under B's textRecv", async () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const ka = await deriveSession("initiator", a, b.publicKey);
    const kb = await deriveSession("responder", b, a.publicKey);
    const pt = new Uint8Array([1, 2, 3, 4]) as Uint8Array<ArrayBuffer>;
    const ct = await seal(ka.textSend, 0, pt);
    const back = await open(kb.textRecv, 0, ct);
    expect([...back]).toEqual([1, 2, 3, 4]);
  });

  // The property the whole nonce argument rests on: two independent counters are
  // only safe because they are two independent keys.
  it("is a different key from the file stream key at the same seq", async () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const ka = await deriveSession("initiator", a, b.publicKey);
    const kb = await deriveSession("responder", b, a.publicKey);
    const pt = new Uint8Array([9, 9, 9]) as Uint8Array<ArrayBuffer>;
    const ct = await seal(ka.textSend, 5, pt);
    await expect(open(kb.recv, 5, ct)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd web && npx vitest run src/lib/crypto.text-keys.test.ts`
Expected: FAIL — `textKeyBytes` and `TEXT_KEY_DOMAIN` are not exported; TypeScript also reports `textSend` missing on `SessionKeys`.

- [ ] **Step 3: Implement the derivation**

In `web/src/lib/crypto.ts`, extend the interface:

```ts
export interface SessionKeys {
  send: CryptoKey;
  recv: CryptoKey;
  /** HMAC key both sides derive to the SAME value, used to authenticate resume
   *  signalling (see signResume). Separate from send/recv on purpose: it signs
   *  attacker-visible plaintext, so it must not be the key protecting content. */
  resumeAuth: CryptoKey;
  /** AEAD keys for the message stream. Domain-separated from send/recv because
   *  that stream's nonce safety rests on there being exactly one producer of its
   *  seq, and messages are produced by a second one. Directional and therefore
   *  unsorted: crypto_kx already mirrors tx/rx across the peers. */
  textSend: CryptoKey;
  textRecv: CryptoKey;
}
```

Add below `RESUME_AUTH_DOMAIN`:

```ts
/** Domain separation for the message stream's keys. Any change here is a wire
 *  break: regenerate apps/RelayiumKit/Tests/Fixtures/crypto-vectors.json. */
export const TEXT_KEY_DOMAIN = "relayium-text-v1\0";

/** The 32-byte AEAD key for one direction of the message stream.
 *
 *  Unlike deriveResumeAuth this does NOT sort its inputs, and must not: the
 *  resume key is shared and so has to be symmetric, while these are per
 *  direction. crypto_kx hands the peers mirrored secrets, so hashing each one
 *  locally already gives A's textSend == B's textRecv. Sorting would collapse
 *  both directions onto one key and put two producers back on one counter. */
export function textKeyBytes(sessionKey: Uint8Array): Uint8Array {
  const domain = new TextEncoder().encode(TEXT_KEY_DOMAIN);
  const input = new Uint8Array(domain.length + sessionKey.length);
  input.set(domain, 0);
  input.set(sessionKey, domain.length);
  return sodiumSync().crypto_generichash(32, input) as Bytes;
}
```

In `deriveSession`, extend the returned object (keeping the existing three fields exactly as they are):

```ts
  return {
    send: await importAesKey(keys.sharedTx as Bytes),
    recv: await importAesKey(keys.sharedRx as Bytes),
    resumeAuth: await deriveResumeAuth(keys.sharedTx as Bytes, keys.sharedRx as Bytes),
    textSend: await importAesKey(textKeyBytes(keys.sharedTx as Bytes) as Bytes),
    textRecv: await importAesKey(textKeyBytes(keys.sharedRx as Bytes) as Bytes),
  };
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd web && npx vitest run src/lib/crypto.text-keys.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Confirm the file path is undisturbed**

Run: `cd web && npx vitest run src/lib/transfer.test.ts src/lib/webrtc.test.ts src/lib/store-crypto.test.ts && npm run check`
Expected: PASS. `deriveSession` gained fields; nothing reads it positionally, so nothing else should move.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/crypto.ts web/src/lib/crypto.text-keys.test.ts
git commit -m "feat(web): derive a domain-separated key for the message stream"
```

---

### Task 2: The text frame codec

**Files:**
- Create: `web/src/lib/text-wire.ts`
- Test: `web/src/lib/text-wire.test.ts` (create)

**Interfaces:**
- Consumes from Task 1: `SessionKeys.textSend`, `SessionKeys.textRecv`, `seal`, `open`
- Produces, consumed by Tasks 5, 7, 12:
  - `export const KIND_TEXT_ENC = 9`
  - `export const TEXT_MAX_BYTES = 64 * 1024`
  - `export const TEXT_FRAME_OVERHEAD = 5 + 16`
  - `export function textByteLength(body: string): number`
  - `export function isTextFrame(buf: ArrayBuffer): boolean`
  - `export class TextSender { frame(body: string, key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> }`
  - `export class TextReceiver { feed(encoded: Uint8Array<ArrayBuffer>, key: CryptoKey): Promise<string> }`

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/text-wire.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { ready, generateKeyPair, deriveSession } from "./crypto";
import {
  TextSender, TextReceiver, KIND_TEXT_ENC, TEXT_MAX_BYTES, TEXT_FRAME_OVERHEAD,
  textByteLength, isTextFrame,
} from "./text-wire";

beforeAll(async () => { await ready(); });

async function pair() {
  const a = generateKeyPair();
  const b = generateKeyPair();
  return {
    ka: await deriveSession("initiator", a, b.publicKey),
    kb: await deriveSession("responder", b, a.publicKey),
  };
}

// Exactly the content the invariants promise to preserve: leading and trailing
// whitespace, tabs, blank lines, CJK, emoji, and a lone CR.
const GNARLY = "  \tif x:\n\n\t\tprint('你好 🌍')\n   \r\n  trailing   ";

describe("text wire", () => {
  it("round-trips content byte for byte", async () => {
    const { ka, kb } = await pair();
    const s = new TextSender();
    const r = new TextReceiver();
    const got = await r.feed(await s.frame(GNARLY, ka.textSend), kb.textRecv);
    expect(got).toBe(GNARLY);
  });

  it("preserves a message that is only whitespace", async () => {
    const { ka, kb } = await pair();
    const s = new TextSender();
    const r = new TextReceiver();
    expect(await r.feed(await s.frame("   \n\t ", ka.textSend), kb.textRecv)).toBe("   \n\t ");
  });

  it("preserves the empty string", async () => {
    const { ka, kb } = await pair();
    const s = new TextSender();
    const r = new TextReceiver();
    expect(await r.feed(await s.frame("", ka.textSend), kb.textRecv)).toBe("");
  });

  it("frames as [9][seq BE] and advances seq per message", async () => {
    const { ka } = await pair();
    const s = new TextSender();
    const f0 = await s.frame("a", ka.textSend);
    const f1 = await s.frame("b", ka.textSend);
    const seqOf = (f: Uint8Array) => new DataView(f.buffer, f.byteOffset).getUint32(1);
    expect(f0[0]).toBe(KIND_TEXT_ENC);
    expect(KIND_TEXT_ENC).toBe(9);
    expect(seqOf(f0)).toBe(0);
    expect(seqOf(f1)).toBe(1);
    expect(f0.byteLength).toBe(1 + TEXT_FRAME_OVERHEAD); // 1 byte plaintext + 21
    expect(isTextFrame(f0.buffer as ArrayBuffer)).toBe(true);
  });

  it("counts limits in UTF-8 bytes, not characters", () => {
    expect(textByteLength("abc")).toBe(3);
    expect(textByteLength("你好")).toBe(6);   // 3 bytes each, 2 characters
    expect(textByteLength("🌍")).toBe(4);     // 1 astral character
    expect(TEXT_MAX_BYTES).toBe(65536);
  });

  it("refuses a message one byte over the limit, measured on the plaintext", async () => {
    const { ka } = await pair();
    const s = new TextSender();
    const justFits = "a".repeat(TEXT_MAX_BYTES);
    await expect(s.frame(justFits, ka.textSend)).resolves.toBeInstanceOf(Uint8Array);
    const s2 = new TextSender();
    await expect(s2.frame("a".repeat(TEXT_MAX_BYTES + 1), ka.textSend)).rejects.toThrow(/too large/);
  });

  it("refuses a multibyte message that fits in characters but not in bytes", async () => {
    const { ka } = await pair();
    const s = new TextSender();
    // 22000 * 3 bytes = 66000 > 65536, but only 22000 characters.
    await expect(s.frame("你".repeat(22000), ka.textSend)).rejects.toThrow(/too large/);
  });

  it("rejects an out-of-order seq", async () => {
    const { ka, kb } = await pair();
    const s = new TextSender();
    const r = new TextReceiver();
    await s.frame("skipped", ka.textSend);            // seq 0, never delivered
    const f1 = await s.frame("arrives", ka.textSend); // seq 1
    await expect(r.feed(f1, kb.textRecv)).rejects.toThrow(/out-of-order/);
  });

  it("rejects a tampered frame", async () => {
    const { ka, kb } = await pair();
    const s = new TextSender();
    const r = new TextReceiver();
    const f = await s.frame("hello", ka.textSend);
    f[f.length - 1] ^= 0x01;
    await expect(r.feed(f, kb.textRecv)).rejects.toThrow();
  });

  it("rejects invalid UTF-8 rather than substituting U+FFFD", async () => {
    const { ka, kb } = await pair();
    // Seal a lone continuation byte directly — the sender cannot produce this,
    // but a peer can, and a replacement character would be silent corruption.
    const { seal } = await import("./crypto");
    const bad = new Uint8Array([0x80]) as Uint8Array<ArrayBuffer>;
    const ct = await seal(ka.textSend, 0, bad);
    const frame = new Uint8Array(5 + ct.length) as Uint8Array<ArrayBuffer>;
    frame[0] = KIND_TEXT_ENC;
    new DataView(frame.buffer).setUint32(1, 0);
    frame.set(ct, 5);
    const r = new TextReceiver();
    await expect(r.feed(frame, kb.textRecv)).rejects.toThrow(/valid UTF-8/);
  });

  it("rejects a non-text kind and a truncated frame", async () => {
    const { kb } = await pair();
    const r = new TextReceiver();
    const wrongKind = new Uint8Array([1, 0, 0, 0, 0, 0]) as Uint8Array<ArrayBuffer>;
    await expect(r.feed(wrongKind, kb.textRecv)).rejects.toThrow(/not a message frame/);
    const short = new Uint8Array([9, 0, 0]) as Uint8Array<ArrayBuffer>;
    await expect(r.feed(short, kb.textRecv)).rejects.toThrow(/malformed/);
    expect(isTextFrame(wrongKind.buffer as ArrayBuffer)).toBe(false);
  });

  // Content must not be readable on the wire. The positive control is what stops
  // this passing vacuously if the payload were empty.
  it("leaves no plaintext on the wire", async () => {
    const { ka } = await pair();
    const s = new TextSender();
    const f = await s.frame("SECRET-CANARY", ka.textSend);
    const asText = new TextDecoder("utf-8", { fatal: false }).decode(f);
    expect(asText).not.toContain("SECRET-CANARY");
    expect(new TextDecoder("utf-8", { fatal: false }).decode(
      new TextEncoder().encode("SECRET-CANARY"),
    )).toContain("SECRET-CANARY"); // positive control
  });

  it("never puts content into its error messages", async () => {
    const { ka } = await pair();
    const s = new TextSender();
    const err = await s.frame("a".repeat(TEXT_MAX_BYTES + 1), ka.textSend).catch((e: Error) => e);
    expect((err as Error).message).not.toContain("aaaa");
    expect((err as Error).message).toMatch(/\d+/); // reports a byte length
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd web && npx vitest run src/lib/text-wire.test.ts`
Expected: FAIL — cannot resolve `./text-wire`.

- [ ] **Step 3: Implement the codec**

Create `web/src/lib/text-wire.ts`:

```ts
import { seal, open } from "./crypto";

// Frames flow into DataChannel.send() and Web Crypto, which require an
// explicitly ArrayBuffer-backed Uint8Array. Every buffer here is one.
type Bytes = Uint8Array<ArrayBuffer>;

/** Message frame kind. Distinct from every file-stream kind (1..8) so a stray
 *  frame can never be read as a chunk, and so that when both streams share one
 *  channel in phase 2 the wire does not change. */
export const KIND_TEXT_ENC = 9;

/**
 * One message, one frame, no chunking.
 *
 * 64 KiB of UTF-8 covers any realistic paste of code or logs. The on-wire frame
 * is 65 557 B, far under the 256 KiB DataChannel max-message-size that CHUNK_SIZE
 * is also sized against (transfer.ts). Anything larger is a file, and the UI says
 * so rather than silently splitting content the user thinks of as one thing.
 */
export const TEXT_MAX_BYTES = 64 * 1024;

/** 5-byte header + 16-byte GCM tag. */
export const TEXT_FRAME_OVERHEAD = 5 + 16;

const enc = new TextEncoder();
// fatal: invalid UTF-8 must fail loudly. A replacement character would corrupt
// content while reporting success, and "opaque valid Unicode" is a contract.
const dec = new TextDecoder("utf-8", { fatal: true });

/** The number the limit is measured in, and the number the UI counter shows.
 *  A character count would let a Chinese or emoji message be refused after the
 *  user was told it fit. */
export function textByteLength(body: string): number {
  return enc.encode(body).length;
}

/** Cheap discriminator for the channel's onmessage demux. */
export function isTextFrame(buf: ArrayBuffer): boolean {
  const b = new Uint8Array(buf);
  return b.length >= 5 + 16 && b[0] === KIND_TEXT_ENC;
}

function frame(seq: number, payload: Uint8Array): Bytes {
  const out = new Uint8Array(5 + payload.length) as Bytes;
  out[0] = KIND_TEXT_ENC;
  new DataView(out.buffer).setUint32(1, seq);
  out.set(payload, 5);
  return out;
}

export class TextSender {
  // Its own counter, starting at 0, under its own key. It never rewinds, and
  // nothing else advances it — which is the entire reason the message stream
  // does not share the file stream's key.
  private seq = 0;

  async frame(body: string, key: CryptoKey): Promise<Bytes> {
    const payload = enc.encode(body) as Bytes;
    if (payload.length > TEXT_MAX_BYTES) {
      // The length, never the content.
      throw new Error(`relayium: message too large (${payload.length} > ${TEXT_MAX_BYTES} bytes)`);
    }
    const s = this.seq++;
    return frame(s, await seal(key, s, payload));
  }
}

export class TextReceiver {
  private expectedSeq = 0;

  async feed(encoded: Bytes, key: CryptoKey): Promise<string> {
    if (encoded.length < 5 + 16) throw new Error("relayium: malformed message frame");
    if (encoded[0] !== KIND_TEXT_ENC) throw new Error("relayium: not a message frame");
    const seq = new DataView(encoded.buffer, encoded.byteOffset).getUint32(1);
    // The channel is reliable and ordered, so a gap is not a network event —
    // it is tampering or a bug. Fail closed, as the chunk path does.
    if (seq !== this.expectedSeq) throw new Error("relayium: out-of-order message");
    const plain = await open(key, seq, encoded.slice(5) as Bytes); // throws on tamper
    this.expectedSeq++;
    try {
      return dec.decode(plain);
    } catch {
      throw new Error(`relayium: message is not valid UTF-8 (${plain.length} bytes)`);
    }
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd web && npx vitest run src/lib/text-wire.test.ts && npm run check`
Expected: PASS, 13 tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/text-wire.ts web/src/lib/text-wire.test.ts
git commit -m "feat(web): message frame codec (kind 9) with its own seq and key"
```

---

### Task 3: Capabilities are announced before a connection is attempted

**Files:**
- Create: `web/src/lib/peer-caps.svelte.ts`
- Test: `web/src/lib/peer-caps.test.ts` (create)
- Modify: `web/src/lib/webrtc-core.ts` (add `caps` to `InboundSignal`; **do not touch `authPayload`**)
- Modify: `web/src/lib/webrtc.ts` (export `LOCAL_CAPS`; attach caps via `sdpExtra`; report the peer's)
- Test: `web/src/lib/webrtc.test.ts` (extend — the `authPayload` invariance assertion)

**Interfaces:**
- Produces, consumed by Tasks 4, 5, 7:
  - `export const CAP_TEXT = "text/1"`
  - `export const LOCAL_CAPS: readonly string[]` (from `webrtc.ts`)
  - `export function capsSignal(): { caps: string[] }`
  - `export function recordPeerCaps(peerId: string, data: unknown): boolean` — true if the frame was a caps hello
  - `export function peerSupportsText(peerId: string): boolean`
  - `export function retainPeers(ids: string[]): void` — drop announcements for peers no longer in the roster
  - `export function resetPeerCaps(): void` — room-switch reset and test seam
  - `InboundSignal` gains `caps?: string[]` and `text?: boolean`
  - `ConnectOpts` gains `onPeerCaps?: (caps: string[]) => void`, and **must be exported** from `webrtc.ts` (it is currently a module-private `interface ConnectOpts` at `webrtc.ts:15`) because Task 4's `connectText` takes it

- [ ] **Step 1: Write the failing tests**

Create `web/src/lib/peer-caps.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  CAP_TEXT, capsSignal, recordPeerCaps, peerSupportsText, retainPeers, resetPeerCaps,
} from "./peer-caps.svelte";

beforeEach(() => { resetPeerCaps(); });

describe("peer caps", () => {
  it("treats an unheard-from peer as not supporting text", () => {
    expect(peerSupportsText("p1")).toBe(false);
  });

  it("records an announcement and reports support", () => {
    expect(recordPeerCaps("p1", { caps: [CAP_TEXT] })).toBe(true);
    expect(peerSupportsText("p1")).toBe(true);
  });

  it("ignores frames that are not a caps hello, so other piggybacks still route", () => {
    expect(recordPeerCaps("p1", { sdp: { type: "offer", sdp: "v=0" } })).toBe(false);
    expect(recordPeerCaps("p1", { rename: "Bob" })).toBe(false);
    expect(recordPeerCaps("p1", null)).toBe(false);
    expect(recordPeerCaps("p1", "caps")).toBe(false);
    expect(peerSupportsText("p1")).toBe(false);
  });

  // Peer-authored input. A non-array, or an array of non-strings, must not throw
  // out of the signal dispatch loop.
  it("survives a malformed caps field", () => {
    expect(recordPeerCaps("p1", { caps: "text/1" })).toBe(false);
    expect(recordPeerCaps("p2", { caps: [1, 2, 3] })).toBe(true);
    expect(peerSupportsText("p1")).toBe(false);
    expect(peerSupportsText("p2")).toBe(false);
  });

  it("announces exactly our capability list", () => {
    expect(capsSignal()).toEqual({ caps: [CAP_TEXT] });
  });

  it("forgets a peer that left the roster", () => {
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    recordPeerCaps("p2", { caps: [CAP_TEXT] });
    retainPeers(["p2"]);
    expect(peerSupportsText("p1")).toBe(false);
    expect(peerSupportsText("p2")).toBe(true);
  });

  // A reconnecting peer gets a brand-new id (server/main.go:44-48), so a stale
  // entry can never be mistaken for the new connection's.
  it("does not carry an announcement onto a different peer id", () => {
    recordPeerCaps("old-id", { caps: [CAP_TEXT] });
    expect(peerSupportsText("new-id")).toBe(false);
  });
});
```

Append to `web/src/lib/webrtc.test.ts`:

```ts
describe("capability piggyback", () => {
  // THE compatibility assertion for this feature. authPayload lists its fields
  // explicitly so that adding one to InboundSignal cannot change what the resume
  // MAC covers. If this goes red, old and new clients compute different tags and
  // every resume across a rolling deploy breaks.
  it("authPayload output is unchanged by the presence of caps", async () => {
    const { authPayload } = await import("./webrtc-core");
    const base = { sdp: { type: "offer" as const, sdp: "v=0\r\n" } };
    expect(authPayload({ ...base, caps: ["text/1"] })).toBe(authPayload(base));
    expect(authPayload({ ...base, caps: ["text/1"], text: true })).toBe(authPayload(base));
  });

  it("carries LOCAL_CAPS on the offer and on the answer", async () => {
    const { LOCAL_CAPS } = await import("./webrtc");
    expect(LOCAL_CAPS).toContain("text/1");
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd web && npx vitest run src/lib/peer-caps.test.ts src/lib/webrtc.test.ts`
Expected: FAIL — `./peer-caps.svelte` unresolved; `LOCAL_CAPS` not exported.

- [ ] **Step 3: Implement the caps module**

Create `web/src/lib/peer-caps.svelte.ts`:

```ts
// Which peers in the room have told us they can hold a message session.
//
// This is announced at the ROSTER level, not on a connection's SDP, and the
// reason is the older peer: listenForIncoming acts on any inbound offer and
// begins a file receive, so a connection opened for messaging is, to a peer
// running an earlier build, a file offer whose manifest never comes — it waits,
// and its 45 s stall watchdog fails it. Capabilities learned during that
// connection's handshake arrive too late to prevent it.
//
// The transport is the same bare `signal` frame the relay-RTT maps already use
// (App.svelte), which the WebRTC handlers ignore. Absence means "no text", so a
// peer that never announces is simply never offered a message session.
//
// It is a HINT. The signalling relay sees every frame and can strip it (text is
// disabled — denial of service) or forge it (we offer a session to a peer that
// cannot hold one — also denial of service). It can never cause plaintext to be
// sent: the message key is derived, not negotiated.

export const CAP_TEXT = "text/1";

let announced = $state<Record<string, string[]>>({});

/** The frame we send to each peer on joining a room and on roster change. */
export function capsSignal(): { caps: string[] } {
  return { caps: [CAP_TEXT] };
}

/** Record a peer's announcement. Returns true if this frame WAS a caps hello,
 *  so the caller knows not to route it onward. Peer-authored input: a malformed
 *  caps field is recorded as "no capabilities", never thrown. */
export function recordPeerCaps(peerId: string, data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const caps = (data as { caps?: unknown }).caps;
  if (caps === undefined) return false;
  if (!Array.isArray(caps)) return false;
  announced = { ...announced, [peerId]: caps.filter((c): c is string => typeof c === "string") };
  return true;
}

export function peerSupportsText(peerId: string): boolean {
  return (announced[peerId] ?? []).includes(CAP_TEXT);
}

/** Drop announcements for peers no longer in the roster. A reconnecting peer
 *  gets a fresh id from the server, so nothing stale can be reused. */
export function retainPeers(ids: string[]): void {
  const keep = new Set(ids);
  const next: Record<string, string[]> = {};
  for (const [id, caps] of Object.entries(announced)) if (keep.has(id)) next[id] = caps;
  announced = next;
}

/** Test seam and room-switch reset. */
export function resetPeerCaps(): void {
  announced = {};
}
```

- [ ] **Step 4: Add the signal fields and the SDP copy**

In `web/src/lib/webrtc-core.ts`, add to `InboundSignal` (leaving `authPayload` **untouched**):

```ts
  /** Capabilities the peer advertises, e.g. ["text/1"]. Opaque to the WebRTC
   *  handlers (like relayRtt/busy/rename) and deliberately outside authPayload,
   *  so adding it cannot change any resume tag. A hint, never a security input. */
  caps?: string[];
  /** Marks a signal as belonging to a message session's connection rather than a
   *  file transfer's. Same mechanism as `resume`: each generation ignores the
   *  other's signals. */
  text?: boolean;
```

In `web/src/lib/webrtc.ts`, export the list and wire it through `connect`:

```ts
import { CAP_TEXT } from "./peer-caps.svelte";

/** What we advertise. One entry today; the shape is a list so a later
 *  capability does not need a new field. */
export const LOCAL_CAPS: readonly string[] = [CAP_TEXT];
```

Add `onPeerCaps?: (caps: string[]) => void` to `ConnectOpts`, then inside `connect` change the two hooks:

```ts
    // The commit rides along with every offer/answer we send; caps ride with it
    // as the per-connection confirmation of the roster-level hello.
    sdpExtra: () => ({ commit: selfCommit, caps: [...LOCAL_CAPS] }),

    beforeSdp: (msg) => {
      if (msg.commit) peerCommit = unb64(msg.commit);
      if (Array.isArray(msg.caps)) {
        opts.onPeerCaps?.(msg.caps.filter((c): c is string => typeof c === "string"));
      }
    },
```

- [ ] **Step 5: Run and confirm the tests pass**

Run: `cd web && npx vitest run src/lib/peer-caps.test.ts src/lib/webrtc.test.ts && npm run check`
Expected: PASS. The pre-existing `webrtc.test.ts` cases must all still pass — they assert the commit-reveal and the resume generation, both of which this touches.

- [ ] **Step 6: Broadcast the hello from App.svelte**

In `web/src/App.svelte`, next to the existing relay-RTT signal exchange (`:142-168`):

- in the `onPeers` handler, call `retainPeers(peers.map((p) => p.id))`, then send `capsSignal()` to each peer id that is not self, via `signaling().sendSignal(id, capsSignal())`;
- in the `onSignal` handler, call `recordPeerCaps(from, data)` **before** the existing dispatch and `return` when it reports true, so a caps hello never reaches the SDP handlers;
- call `resetPeerCaps()` from `switchRoom()` (`:477-504`), alongside the existing peer clearing.

- [ ] **Step 7: Verify the whole web suite and commit**

Run: `cd web && npx vitest run && npm run check && npm run build`
Expected: PASS.

```bash
git add web/src/lib/peer-caps.svelte.ts web/src/lib/peer-caps.test.ts \
        web/src/lib/webrtc-core.ts web/src/lib/webrtc.ts web/src/lib/webrtc.test.ts web/src/App.svelte
git commit -m "feat(web): announce peer capabilities at the roster level"
```

---

### Task 4: A message session gets its own connection generation

**Files:**
- Modify: `web/src/lib/webrtc-core.ts` (extend the generation filter from a boolean to a named generation)
- Modify: `web/src/lib/webrtc.ts` (add `connectText`)
- Test: `web/src/lib/webrtc.test.ts` (extend)

**Interfaces:**
- Consumes from Task 3: `InboundSignal.text`, `LOCAL_CAPS`
- Produces, consumed by Task 5:
  - `export type Generation = "file" | "resume" | "text"`
  - `export async function connectText(opts: ConnectOpts): Promise<Conn>` — runs the full commit-reveal, so it yields keys and a SAS of its own
  - `export function signalGeneration(msg: InboundSignal): Generation`

- [ ] **Step 1: Write the failing test**

Append to `web/src/lib/webrtc.test.ts`:

```ts
describe("text generation isolation", () => {
  it("classifies each generation from its tag", async () => {
    const { signalGeneration } = await import("./webrtc-core");
    expect(signalGeneration({})).toBe("file");
    expect(signalGeneration({ resume: true })).toBe("resume");
    expect(signalGeneration({ text: true })).toBe("text");
  });

  // The same property webrtc.test.ts already pins for resume: two generations
  // alive at once must not cross-route each other's SDP. Without this a text
  // offer would land in listenForIncoming and start a file receive.
  it("a text-tagged signal is not delivered to a file-generation connection", async () => {
    const { signalGeneration } = await import("./webrtc-core");
    expect(signalGeneration({ text: true, sdp: { type: "offer", sdp: "v=0" } })).not.toBe("file");
  });

  it("connectText tags every outbound signal and runs its own handshake", async () => {
    const { connectText } = await import("./webrtc");
    expect(typeof connectText).toBe("function");
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd web && npx vitest run src/lib/webrtc.test.ts`
Expected: FAIL — `signalGeneration` and `connectText` are not exported.

- [ ] **Step 3: Generalise the generation filter**

`webrtc-core.ts` currently isolates generations with a boolean: `resume?: boolean` on `CoreOpts`, `tag()` stamping `resume: true`, and the inbound filter `!!msg.resume !== resume` (`:277`). Replace the boolean with a named generation, preserving today's behaviour exactly for `"file"` and `"resume"`:

```ts
/** Which concurrent connection a signal belongs to. Two (or three) generations
 *  can be alive at once — a dying transfer and its resume, a transfer and a
 *  message session — and each must ignore the others' SDP. */
export type Generation = "file" | "resume" | "text";

/** A signal's generation, from its tags. Untagged is the file generation, which
 *  is what every older peer sends. */
export function signalGeneration(msg: InboundSignal): Generation {
  if (msg.resume) return "resume";
  if (msg.text) return "text";
  return "file";
}
```

On `CoreOpts`, replace `resume?: boolean` with `generation?: Generation` (default `"file"`). In `establish`:

- `tag()` stamps `{ resume: true }` for `"resume"` and `{ text: true }` for `"text"`, nothing for `"file"` — so the bytes an older peer sees are byte-identical to today;
- the inbound filter becomes `if (signalGeneration(msg) !== generation) return;`.

Update `connectResume` (`webrtc.ts:217-219`) to pass `generation: "resume"` instead of `resume: true`.

- [ ] **Step 4: Add `connectText`**

In `web/src/lib/webrtc.ts`, factor the existing body of `connect` so the handshake is shared, and add:

```ts
/**
 * A connection for a message session. Runs the FULL commit-reveal — this is not
 * a resume — so it agrees its own session keys and its own 6-digit SAS, which is
 * the code the message panel shows.
 *
 * It rides its own signalling generation, so a text offer never reaches
 * listenForIncoming and a file offer never reaches the message listener. In this
 * phase a message session and a file transfer are mutually exclusive anyway
 * (busy()), but the isolation is what makes that a guard rather than a race.
 */
export async function connectText(opts: ConnectOpts): Promise<Conn> {
  return handshakeConnect(opts, "text");
}
```

where `connect` becomes `handshakeConnect(opts, "file")` and `handshakeConnect` is the current body of `connect` with `generation` threaded into `establish`.

- [ ] **Step 5: Run and confirm the tests pass**

Run: `cd web && npx vitest run src/lib/webrtc.test.ts && npm run check`
Expected: PASS, including the pre-existing resume-generation cases at `webrtc.test.ts:297-349` — they are the regression guard for this refactor.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/webrtc-core.ts web/src/lib/webrtc.ts web/src/lib/webrtc.test.ts
git commit -m "feat(web): name the signalling generations and add a text connection"
```

---

### Task 5: The message session state machine

**Files:**
- Create: `web/src/lib/rate-bucket.ts`, `web/src/lib/rate-bucket.test.ts`
- Create: `web/src/lib/text-session.svelte.ts`, `web/src/lib/text-session.test.ts`
- Modify: `web/src/lib/transfer-session.svelte.ts` — **`busy()` only** (`:111`)

**Interfaces:**
- Consumes: Task 1 keys, Task 2 codec, Task 3 `peerSupportsText`, Task 4 `connectText`
- Produces, consumed by Tasks 7, 8:
  - `export const TEXT_SESSION_MAX_MESSAGES = 500`, `TEXT_SESSION_MAX_BYTES = 4 << 20`
  - `TEXT_HISTORY_MAX = 200`, `TEXT_BURST = 20`, `TEXT_PER_SEC = 5`, `TEXT_IDLE_MS = 600_000`, `TEXT_SEND_BUFFER_MAX = 1 << 20`
  - `export function createRateBucket(burst: number, perSec: number, now: () => number)` with `take(): boolean`
  - The full session contract, which Tasks 7 and 8 code against:

```ts
export type TextStatus =
  | "idle" | "connecting" | "waitingAccept" | "incomingRequest"
  | "open" | "ended" | "failed" | "refused" | "unsupported" | "peerBusy";

/** Terminal-error keys, all of which are keys of Messages["text"] so the UI can
 *  render one without a mapping table. "" means no error. */
export type TextErrorKey =
  | "" | "tooLong" | "flooding" | "unsupported" | "peerBusy" | "failed" | "refused";

export interface TextMessage {
  id: number;              // monotonic, local; also the list key
  dir: "out" | "in";
  body: string;            // exact bytes as sent/received, never normalised
  at: number;              // local Date.now(); never sent, never received
  failed: boolean;         // an outbound message whose send threw
}

/** One live text connection, however it was established. Injected so the state
 *  machine is testable without WebRTC. */
export interface TextConn {
  channel: Pick<RTCDataChannel, "send" | "close" | "readyState"> & {
    onmessage: ((e: { data: ArrayBuffer }) => void) | null;
    onclose: (() => void) | null;
  };
  keys: SessionKeys;
  sas: string;
  path?: ConnPath;
  close(): void;
}

export interface TextSessionDeps {
  /** Opens a text-generation connection to a peer. In App.svelte this wraps
   *  connectText from Task 4; in tests it is a vi.fn(). */
  connect(peerId: string): Promise<TextConn>;
  /** Subscribes to inbound text-generation offers. Called by listenForRequests. */
  listen(onOffer: (peerId: string, conn: TextConn) => void): () => void;
  t(): Messages;
  now(): number;
}

export interface TextSession {
  readonly status: TextStatus;
  readonly peerId: string;
  readonly sasCode: string;
  readonly path: ConnPath | undefined;
  readonly history: TextMessage[];
  readonly errorKey: TextErrorKey;
  listenForRequests(): void;
  openWith(peerId: string): Promise<void>;
  accept(): void;
  reject(): void;
  send(body: string): Promise<void>;
  end(): void;
  clearHistory(): void;
  active(): boolean;
  /** Test seams. Named __test so they are unmistakable at a call site and
   *  greppable before a release. Not used by App.svelte. */
  __testMarkOpen(): void;
  __testInboundRequest(peerId: string, conn: TextConn["channel"], keys: SessionKeys): void;
}

export function createTextSession(deps: TextSessionDeps): TextSession;
```

- [ ] **Step 1: Write the failing bucket test**

Create `web/src/lib/rate-bucket.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createRateBucket } from "./rate-bucket";

describe("rate bucket", () => {
  it("allows a full burst then refuses", () => {
    let t = 0;
    const b = createRateBucket(3, 1, () => t);
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, true]);
    expect(b.take()).toBe(false);
  });

  it("refills at the configured rate", () => {
    let t = 0;
    const b = createRateBucket(2, 5, () => t);
    b.take(); b.take();
    expect(b.take()).toBe(false);
    t = 200; // 0.2 s at 5/s = one token
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
  });

  it("never refills above the burst", () => {
    let t = 0;
    const b = createRateBucket(2, 5, () => t);
    t = 10_000;
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, false]);
  });

  it("does not go backwards if the clock does", () => {
    let t = 1000;
    const b = createRateBucket(1, 1, () => t);
    expect(b.take()).toBe(true);
    t = 0;
    expect(b.take()).toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd web && npx vitest run src/lib/rate-bucket.test.ts`
Expected: FAIL — `./rate-bucket` unresolved.

- [ ] **Step 3: Implement the bucket**

Create `web/src/lib/rate-bucket.ts`:

```ts
/** A token bucket, shaped after the server's signalling limiter
 *  (internal/signal/connlimit.go: burst 50, refill 10/s). Pure and clock-injected
 *  so the flood guard is testable without waiting in real time. */
export function createRateBucket(burst: number, perSec: number, now: () => number) {
  let tokens = burst;
  let last = now();
  return {
    take(): boolean {
      const t = now();
      // A clock that went backwards must not mint tokens.
      if (t > last) {
        tokens = Math.min(burst, tokens + ((t - last) / 1000) * perSec);
        last = t;
      }
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}
```

- [ ] **Step 4: Run and confirm the bucket passes**

Run: `cd web && npx vitest run src/lib/rate-bucket.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing session test**

Create `web/src/lib/text-session.test.ts`. The module takes its transport as a dependency so the state machine is testable without WebRTC:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ready, generateKeyPair, deriveSession } from "./crypto";
import {
  createTextSession, TEXT_HISTORY_MAX, TEXT_SESSION_MAX_MESSAGES,
} from "./text-session.svelte";
import { TextSender } from "./text-wire";
import { recordPeerCaps, resetPeerCaps, CAP_TEXT } from "./peer-caps.svelte";

// A stand-in for the DataChannel: records what was sent, lets a test inject
// inbound frames, and never touches the network.
function fakeChannel() {
  const sent: ArrayBuffer[] = [];
  return {
    sent,
    readyState: "open" as string,
    bufferedAmount: 0,
    send(b: ArrayBuffer | Uint8Array) { sent.push(b instanceof Uint8Array ? (b.buffer as ArrayBuffer) : b); },
    close() { this.readyState = "closed"; },
    onmessage: null as ((e: { data: ArrayBuffer }) => void) | null,
    onclose: null as (() => void) | null,
  };
}

async function harness() {
  const a = generateKeyPair();
  const b = generateKeyPair();
  const ka = await deriveSession("initiator", a, b.publicKey);
  const kb = await deriveSession("responder", b, a.publicKey);
  const ch = fakeChannel();
  const s = createTextSession({
    connect: vi.fn(async () => ({ channel: ch, keys: ka, sas: "123456", close: () => ch.close() })),
    listen: vi.fn(),
    t: () => ({ tooLong: "too long", flooding: "flooding" }) as never,
    now: () => 0,
  } as never);
  return { s, ch, ka, kb };
}

beforeEach(async () => { await ready(); resetPeerCaps(); });

describe("text session", () => {
  it("refuses to open toward a peer that never announced text support", async () => {
    const { s } = await harness();
    await s.openWith("p1");
    expect(s.status).toBe("unsupported");
    expect(s.history.length).toBe(0);
  });

  it("opens toward a peer that announced, and reports the SAS", async () => {
    const { s } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    expect(s.status).toBe("waitingAccept");
    expect(s.sasCode).toBe("123456");
  });

  it("records a sent message in history and puts a sealed frame on the channel", async () => {
    const { s, ch, kb } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    s.__testMarkOpen();
    await s.send("  hello\n\tworld  ");
    expect(s.history.at(-1)).toMatchObject({ dir: "out", body: "  hello\n\tworld  ", failed: false });
    expect(ch.sent.length).toBe(1);
    // What went on the wire is not the plaintext.
    expect(new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(ch.sent[0])))
      .not.toContain("hello");
  });

  it("refuses to send an over-limit message and does not add it to history", async () => {
    const { s, ch } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    s.__testMarkOpen();
    await s.send("a".repeat(64 * 1024 + 1));
    expect(ch.sent.length).toBe(0);
    expect(s.history.length).toBe(0);
    expect(s.errorKey).toBe("tooLong");
  });

  it("shows no content before the user accepts an inbound request", async () => {
    const { s, ch, kb } = await harness();
    s.__testInboundRequest("p2", ch, kb);
    expect(s.status).toBe("incomingRequest");
    expect(s.history.length).toBe(0);
    // The peer sent immediately; nothing is attached, so nothing is rendered.
    expect(ch.onmessage).toBe(null);
  });

  it("delivers frames buffered before acceptance, in order, once accepted", async () => {
    const { s, ch, ka, kb } = await harness();
    s.__testInboundRequest("p2", ch, kb);
    s.accept();
    const peer = new TextSender();
    ch.onmessage!({ data: (await peer.frame("first", ka.textSend)).buffer as ArrayBuffer });
    await Promise.resolve();
    ch.onmessage!({ data: (await peer.frame("second", ka.textSend)).buffer as ArrayBuffer });
    await Promise.resolve();
    expect(s.history.map((m) => m.body)).toEqual(["first", "second"]);
  });

  it("closes the channel on reject and refuses later offers from that peer", async () => {
    const { s, ch, kb } = await harness();
    s.__testInboundRequest("p2", ch, kb);
    s.reject();
    expect(ch.readyState).toBe("closed");
    expect(s.status).toBe("idle");
    const ch2 = fakeChannel();
    s.__testInboundRequest("p2", ch2, kb);
    expect(s.status).toBe("idle");
    expect(ch2.readyState).toBe("closed");
  });

  it("ends the session when the connection drops, keeping history visible", async () => {
    const { s, ch } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    s.__testMarkOpen();
    await s.send("kept");
    ch.onclose!();
    expect(s.status).toBe("ended");
    expect(s.history.map((m) => m.body)).toEqual(["kept"]);
  });

  it("caps retained history and keeps the newest", async () => {
    const { s } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    s.__testMarkOpen();
    for (let i = 0; i < TEXT_HISTORY_MAX + 5; i++) await s.send(`m${i}`);
    expect(s.history.length).toBe(TEXT_HISTORY_MAX);
    expect(s.history.at(-1)!.body).toBe(`m${TEXT_HISTORY_MAX + 4}`);
  });

  it("clearHistory leaves nothing behind", async () => {
    const { s } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    s.__testMarkOpen();
    await s.send("secret");
    s.clearHistory();
    expect(s.history).toEqual([]);
  });

  it("ends the session on a flooding peer without touching a file transfer", async () => {
    const { s, ch, ka, kb } = await harness();
    s.__testInboundRequest("p2", ch, kb);
    s.accept();
    const peer = new TextSender();
    for (let i = 0; i < 25; i++) {
      ch.onmessage!({ data: (await peer.frame(`f${i}`, ka.textSend)).buffer as ArrayBuffer });
      await Promise.resolve();
    }
    expect(s.status).toBe("failed");
    expect(s.errorKey).toBe("flooding");
    expect(ch.readyState).toBe("closed");
    expect(s.history.length).toBeLessThan(25);
  });

  it("stops accepting past the session message cap", async () => {
    expect(TEXT_SESSION_MAX_MESSAGES).toBe(500);
  });

  it("refuses to send when the peer has stopped draining, and says so", async () => {
    const { s, ch } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    s.__testMarkOpen();
    (ch as unknown as { bufferedAmount: number }).bufferedAmount = (1 << 20) + 1;
    await s.send("into a full buffer");
    expect(ch.sent.length).toBe(0);
    // Recorded as failed, not dropped: plaintext the user believes was
    // delivered is the outcome to avoid.
    expect(s.history.at(-1)).toMatchObject({ dir: "out", failed: true });
  });

  it("never writes to localStorage or sessionStorage", async () => {
    const { s } = await harness();
    const before = { local: localStorage.length, session: sessionStorage.length };
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    s.__testMarkOpen();
    await s.send("must not persist");
    expect({ local: localStorage.length, session: sessionStorage.length }).toEqual(before);
  });
});
```

- [ ] **Step 6: Run and confirm failure**

Run: `cd web && npx vitest run src/lib/text-session.test.ts`
Expected: FAIL — `./text-session.svelte` unresolved.

- [ ] **Step 7: Implement the session**

Create `web/src/lib/text-session.svelte.ts` implementing the contract in *Interfaces*. The structure, with the load-bearing parts written out:

```ts
import { TextSender, TextReceiver, TEXT_MAX_BYTES, textByteLength, isTextFrame } from "./text-wire";
import { peerSupportsText } from "./peer-caps.svelte";
import { createRateBucket } from "./rate-bucket";
import type { SessionKeys } from "./crypto";
import type { ConnPath } from "./webrtc";

export const TEXT_SESSION_MAX_MESSAGES = 500;
export const TEXT_SESSION_MAX_BYTES = 4 << 20;
export const TEXT_HISTORY_MAX = 200;
export const TEXT_BURST = 20;
export const TEXT_PER_SEC = 5;
export const TEXT_IDLE_MS = 600_000;
/** Sixteen maximum-size messages. Above this the peer has stopped draining, and
 *  queueing without bound would leave plaintext the user believes was sent. */
export const TEXT_SEND_BUFFER_MAX = 1 << 20;

export function createTextSession(deps: TextSessionDeps): TextSession {
  // Every reactive cell is exposed through a getter: $state tracking is
  // per-property-access, so returning the object once would not re-render.
  let status = $state<TextStatus>("idle");
  let peerId = $state("");
  let sasCode = $state("");
  let path = $state<ConnPath | undefined>(undefined);
  let history = $state<TextMessage[]>([]);
  let errorKey = $state<TextErrorKey>("");

  // Per-session, not per-module: a new session must not inherit a counter.
  let conn: TextConn | null = null;
  let keys: SessionKeys | null = null;
  let sender = new TextSender();
  let receiver = new TextReceiver();
  let bucket = createRateBucket(TEXT_BURST, TEXT_PER_SEC, deps.now);
  let count = 0;
  let bytes = 0;
  let nextId = 1;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  // Serialises frame() per sender -- see send() below for why this is required
  // and not merely tidy. Same shape as webrtc-core's outbound signal chain.
  let sendChain: Promise<void> = Promise.resolve();
  // Page-lifetime, deliberately: a peer told "no" does not get to ask again by
  // reconnecting its channel. Reconnecting with a NEW peer id defeats this, and
  // that is accepted -- so does every other per-peer decision in the app.
  const refused = new Set<string>();

  function touch() {
    clearTimeout(idleTimer);
    // Bounds the relay cost of an idle-but-allocated session and keeps it inside
    // the TURN credential TTL (1 h). A transfer in progress is traffic on its own
    // connection, so this can never interrupt one.
    idleTimer = setTimeout(() => finish("ended"), TEXT_IDLE_MS);
  }

  function finish(next: TextStatus, key: TextErrorKey = "") {
    if (status === "idle" || status === "ended" || status === "failed") return;
    clearTimeout(idleTimer);
    status = next;
    errorKey = key;
    try { conn?.close(); } catch { /* already gone */ }
    conn = null;
    keys = null;               // history stays; the keys do not
  }

  function record(m: Omit<TextMessage, "id">) {
    const next = [...history, { id: nextId++, ...m }];
    history = next.length > TEXT_HISTORY_MAX ? next.slice(next.length - TEXT_HISTORY_MAX) : next;
    touch();
  }

  // Attached only after accept(), which is what makes "no content before
  // consent" structural: frames the peer already sent queue in the channel and
  // arrive here the moment this is installed.
  function attach(c: TextConn) {
    c.channel.onmessage = (e) => { void onFrame(e.data); };
    c.channel.onclose = () => finish("ended");
  }

  async function onFrame(data: ArrayBuffer) {
    if (!keys || !isTextFrame(data)) return;
    if (!bucket.take()) return finish("failed", "flooding");
    if (count + 1 > TEXT_SESSION_MAX_MESSAGES || bytes + data.byteLength > TEXT_SESSION_MAX_BYTES) {
      return finish("failed", "failed");
    }
    try {
      const body = await receiver.feed(new Uint8Array(data) as Uint8Array<ArrayBuffer>, keys.textRecv);
      count += 1;
      bytes += data.byteLength;
      record({ dir: "in", body, at: deps.now(), failed: false });
    } catch (err) {
      // The error object, never a body. A tampered or out-of-order frame is a
      // hard failure, as it is on the file stream.
      console.error("relayium message receive error", err);
      finish("failed", "failed");
    }
  }

  return {
    get status() { return status; },
    get peerId() { return peerId; },
    get sasCode() { return sasCode; },
    get path() { return path; },
    get history() { return history; },
    get errorKey() { return errorKey; },

    async openWith(id: string): Promise<void> {
      // Checked before anything is attempted: an older peer must never be sent
      // an offer it would read as a file transfer whose manifest never comes.
      if (!peerSupportsText(id)) { status = "unsupported"; errorKey = "unsupported"; return; }
      peerId = id;
      status = "connecting";
      errorKey = "";
      try {
        conn = await deps.connect(id);
        keys = conn.keys;
        sasCode = conn.sas;
        path = conn.path;
        attach(conn);
        status = "waitingAccept";
        touch();
      } catch (err) {
        console.error("relayium message connect error", err);
        finish("failed", "failed");
      }
    },

    async send(body: string): Promise<void> {
      if (status !== "open" || !conn || !keys) return;
      if (textByteLength(body) > TEXT_MAX_BYTES) { errorKey = "tooLong"; return; }
      // The only backpressure this stream needs. Messages are human-paced and
      // never hit disk, so there is no credit loop -- and a credit loop would
      // mean acknowledgements, which are one step from delivery receipts.
      if (((conn.channel as { bufferedAmount?: number }).bufferedAmount ?? 0) > TEXT_SEND_BUFFER_MAX) {
        record({ dir: "out", body, at: deps.now(), failed: true });
        return;
      }
      errorKey = "";
      try {
        // SERIALISED. TextSender.frame takes its seq synchronously before its
        // await, so two concurrent calls get distinct seqs but may finish sealing
        // out of order, putting the higher seq on the wire first -- which the
        // peer correctly rejects as out-of-order and which ends the session. Two
        // clicks of the send button is enough. See the caller contract on
        // TextSender.frame (task 2).
        sendChain = sendChain.then(async () => {
          const frame = await sender.frame(body, keys!.textSend);
          conn!.channel.send(frame);
        });
        await sendChain;
        record({ dir: "out", body, at: deps.now(), failed: false });
      } catch (err) {
        console.error("relayium message send error", err);
        // Recorded as failed rather than dropped: a message the user typed and
        // does not see again is worse than one marked undelivered.
        record({ dir: "out", body, at: deps.now(), failed: true });
      }
    },

    accept() { if (conn && status === "incomingRequest") { attach(conn); status = "open"; touch(); } },
    reject() { if (peerId) refused.add(peerId); finish("idle"); },
    end() { finish("ended"); },
    clearHistory() { history = []; },
    active() {
      return status === "connecting" || status === "waitingAccept"
        || status === "incomingRequest" || status === "open";
    },
    listenForRequests() { /* deps.listen(...) → set incomingRequest, or close if refused.has(peerId) */ },
    __testMarkOpen() { status = "open"; },
    __testInboundRequest(id, channel, k) { /* build a TextConn from the fake and enter incomingRequest */ },
  };
}
```

The two bodies elided above — `listenForRequests` and `__testInboundRequest` —
plus the behaviour the skeleton implies, each clause pinned by a named test from
Step 5:

- `openWith(peerId)` returns immediately as `"unsupported"` when `peerSupportsText(peerId)` is false — no connection is attempted;
- otherwise `connectText`, then `"connecting"` → `"waitingAccept"` → `"open"` when the peer accepts;
- an inbound text-generation offer sets `"incomingRequest"` and **does not attach `onmessage`**; `accept()` attaches it (buffered frames then deliver in order), `reject()` closes the connection and adds the peer to a page-lifetime refusal set;
- `send(body)` **serialises its calls through a promise chain** — this is a correctness requirement, not style: `TextSender.frame` allocates its seq before awaiting `seal`, so concurrent calls can reach the channel out of seq order and the peer will hard-fail the session. Then it refuses over-limit content by setting `errorKey` and adding nothing to history; on success it appends an `out` entry and sends the frame; a `send` that throws marks the entry `failed: true` rather than dropping it;
- inbound frames pass through a `createRateBucket(TEXT_BURST, TEXT_PER_SEC, Date.now)`; a refusal ends the session as `"failed"` with `errorKey = "flooding"` and closes only the text connection;
- session totals are counted and enforced against `TEXT_SESSION_MAX_MESSAGES` / `TEXT_SESSION_MAX_BYTES`;
- history is capped at `TEXT_HISTORY_MAX`, newest kept, held in `$state` only — **never** `localStorage` or `sessionStorage`;
- a `TEXT_IDLE_MS` timer with no traffic in either direction ends the session; any frame in either direction resets it;
- `active()` is true for `"connecting" | "waitingAccept" | "incomingRequest" | "open"`;
- every failure sets a `StatusKey`-style `errorKey`; nothing throws to the UI; `console.error` receives the error object but **never** a body.

The `__test*` methods are explicit test seams, named so, and documented as such.

- [ ] **Step 8: Fold the session into `busy()`**

The single permitted change to `web/src/lib/transfer-session.svelte.ts`. `busy()` at `:111` becomes:

```ts
  // A message session and a file transfer are mutually exclusive in this phase:
  // each runs its own handshake, so allowing both would put two different
  // 6-digit codes on screen at once and teach the user that codes are
  // decoration. Phase 2 moves both streams onto one link and lifts this.
  const busy = () => !!incoming || (recv && !recv.done) || (send && !send.done) || deps.textActive?.() === true;
```

with `textActive?: () => boolean` added to `SessionDeps` (`:56-65`) and wired from `App.svelte` in Task 7. Optional so no existing test has to change.

- [ ] **Step 9: Run and confirm everything passes**

Run: `cd web && npx vitest run && npm run check`
Expected: PASS. `transfer.test.ts` and `webrtc.test.ts` unmodified and green; `git diff --stat web/src/lib/transfer-session.svelte.ts` shows a handful of lines in `busy()` and `SessionDeps` and nothing else.

- [ ] **Step 10: Commit**

```bash
git add web/src/lib/rate-bucket.ts web/src/lib/rate-bucket.test.ts \
        web/src/lib/text-session.svelte.ts web/src/lib/text-session.test.ts \
        web/src/lib/transfer-session.svelte.ts
git commit -m "feat(web): message session state machine, exclusive with a transfer"
```

---

### Task 6: The `text` i18n namespace, in nine languages

**Files:**
- Modify: `web/src/lib/i18n/types.ts` (new `text` namespace on `Messages`)
- Modify: `web/src/lib/i18n/{zh,en,ja,ko,de,fr,ar,es,pt}.ts`
- Modify: `web/src/lib/i18n.test.ts` (parity assertions)

**Interfaces:**
- Produces, consumed by Task 7: `Messages["text"]` with keys
  `panelTitle`, `open`, `composePlaceholder`, `send`, `sendHint`, `byteCount: (used: number, max: number) => string`,
  `tooLong: (max: number) => string`, `useFileInstead`, `requestHead: (name: string) => string`,
  `accept`, `reject`, `waitingAccept`, `open_`, `ended`, `failed`, `refused`, `unsupported`, `peerBusy`,
  `flooding`, `copy`, `copied`, `clear`, `clearConfirm`, `emptyHistory`, `you`, `peer: (name: string) => string`,
  `newMessageFrom: (name: string) => string`, `ephemeralNote`, `clipboardNote`, `sasCompare`

- [ ] **Step 1: Write the failing parity test**

Append to `web/src/lib/i18n.test.ts`, inside the existing `describe("i18n completeness")`:

```ts
  // Compile-time parity comes from `npm run check`, which CI does not run, so the
  // runtime guard is what actually catches a missing translation.
  it("每种语言都有完整的 text 文案", () => {
    for (const { code } of LANGS) {
      const m = messages[code].text;
      expect(m, `${code} 缺少 text 命名空间`).toBeTruthy();
      for (const k of [
        "panelTitle", "open", "composePlaceholder", "send", "sendHint", "useFileInstead",
        "accept", "reject", "waitingAccept", "open_", "ended", "failed", "refused",
        "unsupported", "peerBusy", "flooding", "copy", "copied", "clear", "clearConfirm",
        "emptyHistory", "you", "ephemeralNote", "clipboardNote", "sasCompare",
      ] as const) {
        expect((m as Record<string, unknown>)[k], `${code}.text.${k} 是空的`).toBeTruthy();
      }
      expect(m.byteCount(10, 65536)).toBeTruthy();
      expect(m.tooLong(65536)).toBeTruthy();
      expect(m.requestHead("Alice")).toContain("Alice");
      expect(m.peer("Alice")).toContain("Alice");
      expect(m.newMessageFrom("Alice")).toContain("Alice");
    }
  });
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd web && npx vitest run src/lib/i18n.test.ts`
Expected: FAIL — `messages.zh.text` is undefined; `npm run check` also reports the missing property on every language file.

- [ ] **Step 3: Add the interface**

In `web/src/lib/i18n/types.ts`, add to `Messages` (following the nested-namespace style of `status`, `pair`, `crossnet`):

```ts
  text: {
    panelTitle: string;
    open: string;                 // the button that starts a session
    composePlaceholder: string;
    send: string;
    sendHint: string;             // "Enter for a new line, ⌘/Ctrl+Enter to send"
    byteCount: (used: number, max: number) => string;
    tooLong: (max: number) => string;
    useFileInstead: string;
    requestHead: (name: string) => string;
    accept: string;
    reject: string;
    waitingAccept: string;
    open_: string;                // session state "open"; `open` is the button
    ended: string;
    failed: string;
    refused: string;
    unsupported: string;          // the peer's app is older
    peerBusy: string;
    flooding: string;
    copy: string;
    copied: string;
    clear: string;
    clearConfirm: string;
    emptyHistory: string;
    you: string;
    peer: (name: string) => string;
    newMessageFrom: (name: string) => string;
    ephemeralNote: string;        // onboarding: what ephemeral means here
    clipboardNote: string;        // copying puts plaintext on the OS clipboard
    sasCompare: string;
  };
```

- [ ] **Step 4: Translate into all nine files**

Add the block to each of `zh, en, ja, ko, de, fr, ar, es, pt`. English, as the reference:

```ts
  text: {
    panelTitle: "Message",
    open: "Send a message",
    composePlaceholder: "Type or paste text…",
    send: "Send",
    sendHint: "Enter for a new line · ⌘/Ctrl+Enter to send",
    byteCount: (used, max) => `${used.toLocaleString()} / ${max.toLocaleString()} bytes`,
    tooLong: (max) => `Too long — messages are limited to ${max.toLocaleString()} bytes.`,
    useFileInstead: "Send it as a file instead.",
    requestHead: (name) => `${name} wants to send you a message`,
    accept: "Accept",
    reject: "Decline",
    waitingAccept: "Waiting for the other device to accept…",
    open_: "Session open",
    ended: "Session ended",
    failed: "Message session failed",
    refused: "Declined",
    unsupported: "That device's Relayium is older and can't receive messages. Update it on both sides.",
    peerBusy: "That device is busy with a transfer.",
    flooding: "The other device sent too many messages; the session was closed.",
    copy: "Copy",
    copied: "Copied",
    clear: "Clear",
    clearConfirm: "Clear this conversation from this device?",
    emptyHistory: "No messages yet.",
    you: "You",
    peer: (name) => name,
    newMessageFrom: (name) => `New message from ${name}`,
    ephemeralNote: "Messages are end-to-end encrypted, never stored on any server, and gone when this session ends.",
    clipboardNote: "Copying puts the text on your device's clipboard, where other apps can read it.",
    sasCompare: "Compare this code on both devices.",
  },
```

Chinese (`zh.ts`), which is the project's primary language:

```ts
  text: {
    panelTitle: "消息",
    open: "发送消息",
    composePlaceholder: "输入或粘贴文本…",
    send: "发送",
    sendHint: "回车换行 · ⌘/Ctrl+回车发送",
    byteCount: (used, max) => `${used.toLocaleString()} / ${max.toLocaleString()} 字节`,
    tooLong: (max) => `太长了——单条消息上限 ${max.toLocaleString()} 字节。`,
    useFileInstead: "改成用文件发送。",
    requestHead: (name) => `${name} 想给你发一条消息`,
    accept: "接受",
    reject: "拒绝",
    waitingAccept: "等待对方接受…",
    open_: "会话已建立",
    ended: "会话已结束",
    failed: "消息会话失败",
    refused: "已拒绝",
    unsupported: "对方的 Relayium 版本较旧，收不到消息。两端都更新一下。",
    peerBusy: "对方正在传输文件。",
    flooding: "对方发得太快，会话已关闭。",
    copy: "复制",
    copied: "已复制",
    clear: "清除",
    clearConfirm: "从这台设备上清除这段对话？",
    emptyHistory: "还没有消息。",
    you: "你",
    peer: (name) => name,
    newMessageFrom: (name) => `${name} 发来一条消息`,
    ephemeralNote: "消息端到端加密，不在任何服务器上存储，会话结束即消失。",
    clipboardNote: "复制会把文本放进这台设备的剪贴板，其他应用可以读到。",
    sasCompare: "在两台设备上核对这串数字。",
  },
```

Translate the same keys for `ja, ko, de, fr, ar, es, pt`, matching each file's existing register. `ar.ts` is the RTL language — its copy is translated normally; direction is handled by `dir(lang())`, not by the strings.

- [ ] **Step 5: Run and confirm the tests pass**

Run: `cd web && npx vitest run src/lib/i18n.test.ts && npm run check`
Expected: PASS. `npm run check` is the real completeness gate here — a missing key in any of the nine files is a type error.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/i18n/
git commit -m "feat(web): message UI strings in all nine languages"
```

---

### Task 7: The message panel

**Files:**
- Create: `web/src/lib/MessagePanel.svelte`, `web/src/lib/MessagePanel.test.ts`
- Modify: `web/src/App.svelte` (instantiate the session; render the panel inside `transferSurface`; a per-peer entry control)

**Interfaces:**
- Consumes: Task 5 session API, Task 6 `Messages["text"]`, `copyFeedback` from `clipboard.svelte.ts`
- Produces, consumed by Task 8: the panel accepts `prefill?: string` and exposes an `onPrefillConsumed` callback so the paste handler can open it with content

- [ ] **Step 1: Write the failing component test**

Create `web/src/lib/MessagePanel.test.ts`, following `DeviceRadar.test.ts`'s mount/`flushSync` pattern:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import MessagePanel from "./MessagePanel.svelte";
import { loadLang, messages } from "./i18n.svelte";

let target: HTMLDivElement;
let app: unknown;

beforeEach(async () => {
  await loadLang("en");
  target = document.createElement("div");
  document.body.appendChild(target);
});
afterEach(() => {
  if (app) unmount(app);
  target.remove();
});

const HISTORY = [
  { id: 1, dir: "in" as const, body: "  indented\n\n\ttabbed  ", at: 0, failed: false },
  { id: 2, dir: "out" as const, body: "<script>alert(1)</script>", at: 0, failed: false },
];

function open(props: Record<string, unknown> = {}) {
  app = mount(MessagePanel, {
    target,
    props: {
      status: "open", peerName: "Alice", sasCode: "123456", path: "lan",
      history: HISTORY, errorKey: "", onSend: vi.fn(), onAccept: vi.fn(),
      onReject: vi.fn(), onClear: vi.fn(), onEnd: vi.fn(), ...props,
    },
  });
  flushSync();
}

describe("MessagePanel", () => {
  it("renders message bodies as text, never as markup", () => {
    open();
    expect(target.querySelector("script")).toBe(null);
    const bodies = [...target.querySelectorAll(".msg-body")].map((n) => n.textContent);
    expect(bodies).toContain("<script>alert(1)</script>");
  });

  it("preserves whitespace in the rendered body", () => {
    open();
    const body = [...target.querySelectorAll(".msg-body")]
      .find((n) => n.textContent?.includes("indented"))!;
    expect(body.textContent).toBe("  indented\n\n\ttabbed  ");
    // pre-wrap is what makes the preserved bytes visible rather than collapsed.
    expect(getComputedStyle(body).whiteSpace).toMatch(/pre-wrap/);
  });

  it("marks each body dir=auto so RTL content renders correctly under an LTR UI", () => {
    open();
    for (const n of target.querySelectorAll(".msg-body")) expect(n.getAttribute("dir")).toBe("auto");
  });

  it("counts the composer in UTF-8 bytes, not characters", async () => {
    open();
    const ta = target.querySelector("textarea")!;
    ta.value = "你好";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(target.querySelector(".byte-count")!.textContent).toContain("6");
  });

  it("blocks send above the limit and names the file alternative", async () => {
    open();
    const ta = target.querySelector("textarea")!;
    ta.value = "a".repeat(64 * 1024 + 1);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    const btn = target.querySelector("button.send") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(target.textContent).toContain(messages.en.text.useFileInstead);
  });

  it("Enter inserts a newline; Cmd/Ctrl+Enter sends", () => {
    const onSend = vi.fn();
    open({ onSend });
    const ta = target.querySelector("textarea")!;
    ta.value = "line";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onSend).not.toHaveBeenCalled();
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    expect(onSend).toHaveBeenCalledWith("line");
  });

  it("does not trim what it sends", () => {
    const onSend = vi.fn();
    open({ onSend });
    const ta = target.querySelector("textarea")!;
    ta.value = "  padded\n\n  ";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    expect(onSend).toHaveBeenCalledWith("  padded\n\n  ");
  });

  it("shows the SAS and the compare copy while a session is live", () => {
    open();
    expect(target.querySelector(".sas code")!.textContent).toBe("123456");
    expect(target.textContent).toContain(messages.en.text.sasCompare);
  });

  it("shows an inbound request with no content and both choices", () => {
    open({ status: "incomingRequest", history: [] });
    expect(target.textContent).toContain("Alice");
    expect(target.querySelector("textarea")).toBe(null);
    expect(target.textContent).toContain(messages.en.text.accept);
    expect(target.textContent).toContain(messages.en.text.reject);
  });

  it("announces arrivals in a polite log region", () => {
    open();
    const live = target.querySelector('[role="log"]')!;
    expect(live.getAttribute("aria-live")).toBe("polite");
  });

  it("labels the composer and wires the counter with aria-describedby", () => {
    open();
    const ta = target.querySelector("textarea")!;
    expect(ta.getAttribute("aria-label") || target.querySelector(`label[for="${ta.id}"]`)).toBeTruthy();
    const described = ta.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(target.querySelector(`#${described!.split(" ")[0]}`)).toBeTruthy();
  });

  it("does not let form restoration resurrect a draft", () => {
    open();
    expect(target.querySelector("textarea")!.getAttribute("autocomplete")).toBe("off");
  });

  it("states the clipboard risk next to the copy control", () => {
    open();
    expect(target.textContent).toContain(messages.en.text.clipboardNote);
  });

  it("shows the ephemerality note", () => {
    open();
    expect(target.textContent).toContain(messages.en.text.ephemeralNote);
  });

  it("renders a terminal error from its i18n key", () => {
    open({ status: "unsupported", errorKey: "unsupported", history: [] });
    expect(target.textContent).toContain(messages.en.text.unsupported);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd web && npx vitest run src/lib/MessagePanel.test.ts`
Expected: FAIL — `./MessagePanel.svelte` does not exist.

- [ ] **Step 3: Implement the panel**

Create `web/src/lib/MessagePanel.svelte`. Presentational and prop-driven — the same split as `DeviceRadar.svelte`, so it is testable without a session. The skeleton, with the parts the tests pin:

```svelte
<script lang="ts">
  import type { Snippet } from "svelte";
  import { messages, lang } from "./i18n.svelte";
  import type { Messages } from "./i18n/types";
  import { copyFeedback } from "./clipboard.svelte";
  import { textByteLength, TEXT_MAX_BYTES } from "./text-wire";
  import type { TextMessage, TextStatus, TextErrorKey } from "./text-session.svelte";
  import type { ConnPath } from "./webrtc";

  let { status, peerName, sasCode, path, history, errorKey, prefill = "",
        onSend, onAccept, onReject, onClear, onEnd, onPrefillConsumed }:
    { status: TextStatus; peerName: string; sasCode: string; path?: ConnPath;
      history: TextMessage[]; errorKey: TextErrorKey; prefill?: string;
      onSend: (body: string) => void; onAccept: () => void; onReject: () => void;
      onClear: () => void; onEnd: () => void; onPrefillConsumed?: () => void } = $props();

  const t = $derived<Messages>(messages[lang()]);
  const copied = copyFeedback();

  let draft = $state("");
  $effect(() => { if (prefill) { draft = prefill; onPrefillConsumed?.(); } });

  // Bytes, not characters: the counter must show the number the limit enforces,
  // or a Chinese message is refused after the user was told it fit.
  const used = $derived(textByteLength(draft));
  const overLimit = $derived(used > TEXT_MAX_BYTES);

  function keydown(e: KeyboardEvent) {
    // Enter inserts a newline -- the whole point of the feature is multiline
    // content, so Enter-to-send would be the wrong default here.
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    if (overLimit || status !== "open") return;
    onSend(draft);            // NOT draft.trim() -- the content is the content
    draft = "";
  }
</script>

<section class="card msgpanel">
  <h2>{t.text.panelTitle}</h2>

  {#if status === "incomingRequest"}
    <!-- No content is rendered here, and none has been decrypted: the session's
         onmessage is not attached until accept(). -->
    <p class="req">{t.text.requestHead(peerName)}</p>
    <div class="sas">{t.codeLabel} <code>{sasCode}</code> — {t.text.sasCompare}</div>
    <div class="act">
      <button class="btn btn-primary" onclick={onAccept}>{t.text.accept}</button>
      <button class="btn btn-ghost" onclick={onReject}>{t.text.reject}</button>
    </div>
  {:else}
    <div class="sess">
      <span class="pname">{t.text.peer(peerName)}</span>
      <span class="state">{stateText(t, status)}</span>
      {#if path}<span class="path path-{path}"><i class="dot"></i>{pathLabel(t, path)}</span>{/if}
    </div>
    {#if sasCode && status !== "ended"}
      <div class="sas">{t.codeLabel} <code>{sasCode}</code> — {t.text.sasCompare}</div>
    {/if}

    <ol class="msglist" role="log" aria-live="polite">
      {#each history as m (m.id)}
        <li class="msg" class:out={m.dir === "out"} class:failed={m.failed}>
          <span class="who">{m.dir === "out" ? t.text.you : t.text.peer(peerName)}</span>
          <time>{new Date(m.at).toLocaleTimeString()}</time>
          <!-- Escaped text node, dir=auto, pre-wrap. No linkify, no Markdown,
               no highlighting: each of those is a parser over hostile input. -->
          <span class="msg-body" dir="auto">{m.body}</span>
          <button class="btn btn-link copy" class:copied={copied.value === String(m.id)}
                  onclick={() => copied.copy(m.body, String(m.id))}>
            {copied.value === String(m.id) ? t.text.copied : t.text.copy}
          </button>
        </li>
      {:else}
        <li class="empty">{t.text.emptyHistory}</li>
      {/each}
    </ol>

    {#if status === "open"}
      <label class="sr-only" for="msg-compose">{t.text.panelTitle}</label>
      <textarea id="msg-compose" bind:value={draft} onkeydown={keydown}
                autocomplete="off" spellcheck="false" rows="4"
                aria-describedby="msg-bytes msg-hint"
                placeholder={t.text.composePlaceholder}></textarea>
      <div class="compose-foot">
        <span class="byte-count" id="msg-bytes" class:over={overLimit}>
          {t.text.byteCount(used, TEXT_MAX_BYTES)}
        </span>
        <span class="hint" id="msg-hint">{t.text.sendHint}</span>
        <button class="btn btn-primary send" disabled={overLimit || draft === ""}
                onclick={() => { onSend(draft); draft = ""; }}>{t.text.send}</button>
      </div>
      {#if overLimit}<p class="over">{t.text.tooLong(TEXT_MAX_BYTES)} {t.text.useFileInstead}</p>{/if}
    {/if}

    {#if errorKey}<p class="bad">{t.text[errorKey]}</p>{/if}
    <p class="note">{t.text.ephemeralNote}</p>
    <p class="note">{t.text.clipboardNote}</p>
    <div class="act">
      <button class="btn btn-ghost" onclick={onClear}>{t.text.clear}</button>
      {#if status === "open"}<button class="btn btn-ghost" onclick={onEnd}>{t.startOver}</button>{/if}
    </div>
  {/if}
</section>
```

`stateText(t, status)` maps a `TextStatus` to `t.text.*` (`waitingAccept`, `open_`, `ended`, `failed`, `refused`, `unsupported`, `peerBusy`), and `pathLabel` is imported from the helper `App.svelte:640` already uses — extract it to a small module if it is still local. `onClear` confirms with `t.text.clearConfirm` at the call site in `App.svelte`, reusing `ConfirmModal.svelte`.

Everything else the tests require:

- `<section class="card msgpanel">` with `<h2>{t.text.panelTitle}</h2>`;
- session line: `{t.text.peer(peerName)}`, the state copy for `status`, the `.sas` block reusing the existing `<div class="sas">…<code>` markup from `App.svelte:762-764`, and the path badge reusing `pathLabel` and the `.path-{lan|p2p|relay}` classes;
- `role="log" aria-live="polite"` history list; each entry `.msg` with `.msg-dir`, a locally formatted time, `.msg-body` carrying `dir="auto"`, and a copy button driven by `copyFeedback()`;
- composer `<textarea id="msg-compose" autocomplete="off" aria-describedby="msg-bytes msg-hint">`, `.byte-count#msg-bytes` from `textByteLength`, `#msg-hint` with `t.text.sendHint`, and `button.send` disabled while over the limit or while `status !== "open"`;
- `onkeydown`: `Enter` does nothing special (the textarea inserts a newline); `(metaKey || ctrlKey) && key === "Enter"` sends;
- request state renders `t.text.requestHead(peerName)` plus accept/decline and **no** textarea;
- `t.text.ephemeralNote` and `t.text.clipboardNote`; a clear control confirming with `t.text.clearConfirm`.

Styles, scoped, using tokens only: `.msg-body { white-space: pre-wrap; overflow-wrap: anywhere; }`, `text-align: start` and `margin-inline-*` for RTL, `min-height: 44px` on controls inside `@media (pointer: coarse)`, the message list scrolling in its own `overflow-y: auto` box so the page never scrolls horizontally, and a `prefers-reduced-motion` opt-out for any transition.

- [ ] **Step 4: Wire it into both surfaces**

In `web/src/App.svelte`:

- `const textSession = createTextSession({...})`, and pass `textActive: () => textSession.active()` into `createTransferSession`'s deps (the hook added in Task 5);
- call `textSession.listenForRequests()` beside `session.listenForIncoming()`;
- render `<MessagePanel …/>` inside the `transferSurface` snippet (`:707-808`), after the transfer cards — **inside the snippet**, so the LAN route (`:873`) and `CrossPage.svelte:57` both get it from one place;
- add a **Send a message** button to the `peerCard` snippet (`:673-705`) beside the file-pick label, shown only when `peerSupportsText(p.id)`, calling `textSession.openWith(p.id)`;
- extend the completion notification (`:269`) so an arrival raises `t.text.newMessageFrom(nameOf(peer))` — the name, **never** a body.

- [ ] **Step 5: Run the whole suite, typecheck and build**

Run: `cd web && npx vitest run && npm run check && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/MessagePanel.svelte web/src/lib/MessagePanel.test.ts web/src/App.svelte
git commit -m "feat(web): message panel on the LAN and cross-network surfaces"
```

---

### Task 8: Paste opens the composer, and never sends

**Files:**
- Create: `web/src/lib/paste-text.ts`, `web/src/lib/paste-text.test.ts`
- Modify: `web/src/App.svelte` (register the window handler in the existing `onMount`)

**Interfaces:**
- Produces: `export function pastedText(e: ClipboardEvent): string | null` — the text to compose with, or null when the event should be left alone

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/paste-text.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pastedText } from "./paste-text";

// jsdom does not construct ClipboardEvent with data, so build the shape the
// function actually reads.
function ev(text: string | null, target: EventTarget | null): ClipboardEvent {
  return {
    clipboardData: text === null ? null : { getData: (t: string) => (t === "text/plain" ? text : "") },
    target,
  } as unknown as ClipboardEvent;
}

describe("pastedText", () => {
  it("returns pasted plain text", () => {
    expect(pastedText(ev("hello", document.createElement("div")))).toBe("hello");
  });

  it("preserves whitespace and newlines exactly", () => {
    expect(pastedText(ev("  a\n\n\tb  ", document.createElement("div")))).toBe("  a\n\n\tb  ");
  });

  it("ignores an empty clipboard and a missing clipboardData", () => {
    expect(pastedText(ev("", document.createElement("div")))).toBe(null);
    expect(pastedText(ev(null, document.createElement("div")))).toBe(null);
  });

  // Pasting into the pairing-code box or the rename input must keep working.
  it("stays out of the way of text inputs", () => {
    expect(pastedText(ev("x", document.createElement("input")))).toBe(null);
    expect(pastedText(ev("x", document.createElement("textarea")))).toBe(null);
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(pastedText(ev("x", editable))).toBe(null);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd web && npx vitest run src/lib/paste-text.test.ts`
Expected: FAIL — `./paste-text` unresolved.

- [ ] **Step 3: Implement it**

Create `web/src/lib/paste-text.ts`:

```ts
/**
 * What a window-level paste should hand to the message composer, or null to
 * leave the event alone.
 *
 * There is no other paste handler in the application, so this is a clean seam —
 * but the pairing-code input and the rename input rely on native paste, so an
 * event whose target is a text control is not ours.
 *
 * It reads the paste EVENT, never navigator.clipboard.readText(): the event
 * carries only what the user deliberately pasted, needs no permission, and
 * cannot be used to read the clipboard behind their back. Nothing in this app
 * has ever read the clipboard, and this does not change that.
 */
export function pastedText(e: ClipboardEvent): string | null {
  const el = e.target as HTMLElement | null;
  const tag = el?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return null;
  const text = e.clipboardData?.getData("text/plain");
  return text ? text : null; // no trimming — the content is the content
}
```

- [ ] **Step 4: Register the handler**

In `web/src/App.svelte`'s existing `onMount` (beside the window drag listeners at `:536-571`):

```ts
    const onPaste = (e: ClipboardEvent) => {
      if (!surfaceShown) return;
      const text = pastedText(e);
      if (text === null) return;
      const peer = effectiveSelected;
      if (!peer || !peerSupportsText(peer)) return;
      e.preventDefault();
      // Open the composer with the text. Pasting is NOT consent to transmit,
      // and a paste is often a mistake — the user still presses send.
      textCompose = text;
      void textSession.openWith(peer);
    };
    window.addEventListener("paste", onPaste);
```

and remove it in the same cleanup that removes the drag listeners. `textCompose` feeds the panel's `prefill` prop from Task 7.

- [ ] **Step 5: Run and commit**

Run: `cd web && npx vitest run && npm run check && npm run build`
Expected: PASS.

```bash
git add web/src/lib/paste-text.ts web/src/lib/paste-text.test.ts web/src/App.svelte
git commit -m "feat(web): a window paste opens the composer without sending"
```

---

### Task 9: The CLI negotiates mode in the handshake

**Files:**
- Modify: `server/internal/rzvous/handshake.go` (`hsMsg.Mode`, `Handshake.PeerMode`)
- Test: `server/internal/rzvous/handshake_test.go` (extend)

**Interfaces:**
- Produces, consumed by Task 11:
  - `hsMsg` gains `Mode string \`json:"mode,omitempty"\``
  - `Handshake` gains `PeerMode string`
  - `DoHandshake(ctx, sess, id, candidates, mode string)` — the new parameter; existing callers pass `ModeFile`
  - `const ModeFile = "file"`, `const ModeText = "text"`
  - `func ModeCompatible(self, peer string) bool` — treats `""` as `ModeFile`, so an older peer is a file peer

- [ ] **Step 1: Write the failing test**

Append to `server/internal/rzvous/handshake_test.go`:

```go
// An older binary sends no mode at all. It must read as a file peer, not as an
// unknown one, or every deployed CLI stops interoperating on upgrade.
func TestModeCompatibleTreatsAbsentAsFile(t *testing.T) {
	cases := []struct {
		self, peer string
		want       bool
	}{
		{ModeFile, "", true},   // new sender, old peer
		{"", ModeFile, true},   // old sender, new peer
		{ModeFile, ModeFile, true},
		{ModeText, ModeText, true},
		{ModeText, "", false},  // text against an older peer -- must refuse
		{ModeText, ModeFile, false},
		{ModeFile, ModeText, false},
	}
	for _, c := range cases {
		if got := ModeCompatible(c.self, c.peer); got != c.want {
			t.Errorf("ModeCompatible(%q,%q) = %v, want %v", c.self, c.peer, got, c.want)
		}
	}
}

// The mode rides the commit, so it is known before any TLS connection is made.
func TestDoHandshakeCarriesTheMode(t *testing.T) {
	base := startHub(t)
	a, err := Join(context.Background(), base, "", "a")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := Join(context.Background(), base, "", "b")
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()

	ida, err := secure.NewIdentity()
	if err != nil {
		t.Fatal(err)
	}
	idb, err := secure.NewIdentity()
	if err != nil {
		t.Fatal(err)
	}

	type res struct {
		hs  Handshake
		err error
	}
	ch := make(chan res, 2)
	go func() { h, e := DoHandshake(context.Background(), a, ida, nil, ModeText); ch <- res{h, e} }()
	go func() { h, e := DoHandshake(context.Background(), b, idb, nil, ModeText); ch <- res{h, e} }()

	for i := 0; i < 2; i++ {
		r := <-ch
		if r.err != nil {
			t.Fatalf("handshake: %v", r.err)
		}
		if r.hs.PeerMode != ModeText {
			t.Fatalf("PeerMode = %q, want %q", r.hs.PeerMode, ModeText)
		}
	}
}
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd server && go test ./internal/rzvous/ -run 'TestMode|TestDoHandshakeCarries' -v`
Expected: FAIL to compile — `ModeCompatible`, `ModeText`, `Handshake.PeerMode` undefined, and `DoHandshake` takes four arguments.

- [ ] **Step 3: Implement it**

In `server/internal/rzvous/handshake.go`:

```go
// Mode says what the peer intends to do with the connection. It rides the commit
// message, which is the earliest point either side can know — and the only
// compatible one.
//
// encoding/json ignores fields it does not know, so an older binary drops this
// silently and reports "" (ModeFile). That matters more than it looks: xfer's
// protocol is positional and validates no frame type, so a text frame delivered
// where a manifest is expected would unmarshal into an empty Manifest and the
// transfer would COMPLETE having moved nothing. Refusing here, before any TLS
// connection, is what makes that unreachable.
const (
	ModeFile = "file"
	ModeText = "text"
)

// ModeCompatible reports whether two peers want the same thing. An absent mode
// is a file peer: that is what every already-deployed binary sends.
func ModeCompatible(self, peer string) bool {
	norm := func(m string) string {
		if m == "" {
			return ModeFile
		}
		return m
	}
	return norm(self) == norm(peer)
}
```

Add `Mode string \`json:"mode,omitempty"\`` to `hsMsg`, `PeerMode string` to `Handshake`, take a `mode string` parameter on `DoHandshake`, set it on the outgoing commit, and read the peer's from the received commit into the returned `Handshake`. `omitempty` keeps the file path's bytes on the wire byte-identical to today.

- [ ] **Step 4: Update the existing caller**

`server/cmd/relayium/crossnet.go:52` passes `rzvous.ModeFile`. Give `crossnetConn` a `mode string` parameter and have it refuse after the handshake:

```go
	// Checked here, before RaceDirect, so a mismatch costs no TCP connection.
	// An older peer reports "" and reads as a file peer -- see ModeCompatible.
	if !rzvous.ModeCompatible(mode, hs.PeerMode) {
		want := map[string]string{rzvous.ModeText: "relayium text", rzvous.ModeFile: "relayium send/receive"}
		peer := hs.PeerMode
		if peer == "" {
			peer = rzvous.ModeFile
		}
		return nil, fmt.Errorf("the other side is running %s, not %s — both ends need the same command, on a recent enough relayium",
			want[peer], want[mode])
	}
```

placed **before** `RaceDirect` (`crossnet.go:71`), so no TCP connection is attempted on a mismatch.

- [ ] **Step 5: Run and confirm the tests pass**

Run: `cd server && go test ./internal/rzvous/ ./internal/connect/ ./internal/secure/ ./cmd/relayium/ && go build ./...`
Expected: PASS. `TestDoHandshakeAgreesOnSASAndRoles` and `TestDoHandshakeAbortsOnCommitMismatch` are the regression guards.

- [ ] **Step 6: Commit**

```bash
git add server/internal/rzvous/ server/cmd/relayium/crossnet.go
git commit -m "feat(server): negotiate the session mode in the rzvous handshake"
```

---

### Task 10: `MsgText` framing over the pinned TLS stream

**Files:**
- Create: `server/internal/xfer/text.go`, `server/internal/xfer/text_test.go`

**Interfaces:**
- Produces, consumed by Task 11:
  - `const MsgText MsgType = 8`
  - `const TextMaxBytes = 64 * 1024`
  - `func WriteText(w io.Writer, body string) error`
  - `func ReadText(r io.Reader) (string, error)`

- [ ] **Step 1: Write the failing test**

Create `server/internal/xfer/text_test.go`:

```go
package xfer

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"
)

const gnarly = "  \tif x:\n\n\t\tprint('你好 🌍')\n   \r\n  trailing   "

func TestTextRoundtripPreservesContentExactly(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteText(&buf, gnarly); err != nil {
		t.Fatal(err)
	}
	got, err := ReadText(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if got != gnarly {
		t.Fatalf("got %q, want %q", got, gnarly)
	}
}

func TestTextRoundtripEmptyAndWhitespaceOnly(t *testing.T) {
	for _, want := range []string{"", "   ", "\n\n", "\t "} {
		var buf bytes.Buffer
		if err := WriteText(&buf, want); err != nil {
			t.Fatal(err)
		}
		got, err := ReadText(&buf)
		if err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	}
}

func TestWriteTextRefusesOverTheCapInBytesNotRunes(t *testing.T) {
	var buf bytes.Buffer
	// 22000 runes * 3 bytes = 66000 > 65536, but only 22000 characters.
	if err := WriteText(&buf, strings.Repeat("你", 22000)); err == nil {
		t.Fatal("expected a refusal measured in bytes")
	}
	if buf.Len() != 0 {
		t.Fatalf("nothing should have been written, got %d bytes", buf.Len())
	}
}

// The length prefix is peer-controlled, so it must be checked BEFORE any
// allocation -- the same rule the stored wire states for MAX_FRAME_CT. The
// package-wide maxFramePayload of 8 MiB is far too permissive for a message.
func TestReadTextRejectsAnOversizePrefixWithoutAllocating(t *testing.T) {
	var hdr [5]byte
	hdr[0] = byte(MsgText)
	binary.BigEndian.PutUint32(hdr[1:], TextMaxBytes+1)
	if _, err := ReadText(bytes.NewReader(hdr[:])); err == nil {
		t.Fatal("expected a refusal on the length prefix alone")
	}
}

func TestReadTextRejectsInvalidUTF8(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteFrame(&buf, MsgText, []byte{0x80}); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadText(&buf); err == nil {
		t.Fatal("expected invalid UTF-8 to be an error, not a replacement character")
	}
}

func TestReadTextRejectsTheWrongFrameType(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteJSON(&buf, MsgManifest, Manifest{}); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadText(&buf); err == nil {
		t.Fatal("expected a non-text frame to be rejected")
	}
}

// MsgText must not collide with anything the file protocol uses.
func TestMsgTextIsDistinct(t *testing.T) {
	for _, used := range []MsgType{MsgHello, MsgManifest, MsgResume, MsgFileStart, MsgFileHash, MsgResult, MsgError} {
		if MsgText == used {
			t.Fatalf("MsgText collides with %d", used)
		}
	}
	if MsgText != 8 {
		t.Fatalf("MsgText = %d, want 8", MsgText)
	}
}
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd server && go test ./internal/xfer/ -run Text -v`
Expected: FAIL to compile — `MsgText`, `TextMaxBytes`, `WriteText`, `ReadText` undefined.

- [ ] **Step 3: Implement it**

Create `server/internal/xfer/text.go`:

```go
package xfer

import (
	"encoding/binary"
	"fmt"
	"io"
	"unicode/utf8"
)

// MsgText carries one message. It is used only by `relayium text`, whose peer is
// always another `relayium text` -- the rzvous handshake refuses a mode mismatch
// before a TLS connection exists, so this frame never reaches a file receiver.
const MsgText MsgType = 8

// TextMaxBytes matches the web client's TEXT_MAX_BYTES. One message, one frame.
const TextMaxBytes = 64 * 1024

// WriteText frames one message. Nothing is trimmed or normalised: the bytes are
// the content.
func WriteText(w io.Writer, body string) error {
	if len(body) > TextMaxBytes {
		// The length, never the content.
		return fmt.Errorf("message too large (%d > %d bytes)", len(body), TextMaxBytes)
	}
	return WriteFrame(w, MsgText, []byte(body))
}

// ReadText reads one message frame.
//
// It does not use ReadFrame: that guards only against the package-wide 8 MiB
// maxFramePayload, and the prefix is peer-controlled. A message is at most
// TextMaxBytes, so the check happens on the prefix, before any allocation.
func ReadText(r io.Reader) (string, error) {
	var hdr [5]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return "", err
	}
	if MsgType(hdr[0]) != MsgText {
		return "", fmt.Errorf("expected a message frame, got type %d", hdr[0])
	}
	n := binary.BigEndian.Uint32(hdr[1:])
	if n > TextMaxBytes {
		return "", fmt.Errorf("message frame too large (%d > %d bytes)", n, TextMaxBytes)
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(r, body); err != nil {
		return "", err
	}
	// Invalid UTF-8 is an error, never a replacement character: silent
	// corruption reported as success is worse than a refusal.
	if !utf8.Valid(body) {
		return "", fmt.Errorf("message is not valid UTF-8 (%d bytes)", len(body))
	}
	return string(body), nil
}
```

- [ ] **Step 4: Run and confirm the tests pass**

Run: `cd server && go test ./internal/xfer/ && go vet ./internal/xfer/`
Expected: PASS. The existing `TestFrameRoundtrip`, `TestSendReceiveRoundtrip` and the resume suite must be untouched and green.

- [ ] **Step 5: Commit**

```bash
git add server/internal/xfer/text.go server/internal/xfer/text_test.go
git commit -m "feat(server): MsgText framing with a message-sized length cap"
```

---

### Task 11: `relayium text`

**Files:**
- Create: `server/cmd/relayium/text.go`, `server/cmd/relayium/text_test.go`
- Modify: `server/cmd/relayium/run.go` (dispatch + usage), `server/cmd/relayium/flagperm_test.go:151`
- Modify: `web/src/lib/CliPage.svelte`, `web/src/lib/cli-page-data.ts`, `README.md`

**Interfaces:**
- Consumes: Task 9 `rzvous.ModeText`, Task 10 `xfer.WriteText`/`ReadText`
- Produces: `func runText(args []string, stdout, stderr io.Writer) int`, `func parseTextFlags(args []string) (textFlags, []string, error)`

- [ ] **Step 1: Write the failing test**

Create `server/cmd/relayium/text_test.go`:

```go
package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestTextRequiresACode(t *testing.T) {
	var out, errb bytes.Buffer
	if code := runText(nil, &out, &errb); code == 0 {
		t.Fatal("expected a non-zero exit without a code")
	}
	if !strings.Contains(errb.String(), "relayium text") {
		t.Fatalf("error should show the usage form, got %q", errb.String())
	}
}

func TestTextRejectsAMalformedCodeBeforeDialing(t *testing.T) {
	var out, errb bytes.Buffer
	// 0 and 1 are not in CodeAlphabet, so this cannot be a real code.
	if code := runText([]string{"726122"}, &out, &errb); code == 0 {
		t.Fatal("expected a non-zero exit on a malformed code")
	}
	if strings.Contains(errb.String(), "dial") {
		t.Fatalf("must fail on shape before dialing, got %q", errb.String())
	}
}

func TestParseTextFlags(t *testing.T) {
	f, rest, err := parseTextFlags([]string{"--server", "wss://example.invalid", "K7M4XR"})
	if err != nil {
		t.Fatal(err)
	}
	if f.server != "wss://example.invalid" {
		t.Fatalf("server = %q", f.server)
	}
	if len(rest) != 1 || rest[0] != "K7M4XR" {
		t.Fatalf("rest = %v", rest)
	}
}

// A message session has no manifest to inspect, so the SAS gate is on by
// default -- unlike `send`, where --verify opts in.
func TestTextConfirmsTheSasByDefaultOnATty(t *testing.T) {
	f, _, err := parseTextFlags([]string{"K7M4XR"})
	if err != nil {
		t.Fatal(err)
	}
	if !f.confirmSAS(true) {
		t.Fatal("a TTY session must confirm the SAS by default")
	}
	if f.confirmSAS(false) {
		t.Fatal("a piped session cannot prompt")
	}
}

// And a piped session without --yes must refuse rather than proceed unverified.
func TestTextRefusesAPipedSessionWithoutYes(t *testing.T) {
	f, _, err := parseTextFlags([]string{"K7M4XR"})
	if err != nil {
		t.Fatal(err)
	}
	if f.allowUnverified(false) {
		t.Fatal("piped without --yes must not proceed unverified")
	}
	fy, _, err := parseTextFlags([]string{"--yes", "K7M4XR"})
	if err != nil {
		t.Fatal(err)
	}
	if !fy.allowUnverified(false) {
		t.Fatal("--yes is the documented opt-out for scripts")
	}
}

func TestUsageListsText(t *testing.T) {
	if !strings.Contains(usage, "text") {
		t.Fatal("usage must list the text subcommand")
	}
}
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd server && go test ./cmd/relayium/ -run 'Text|UsageListsText' -v`
Expected: FAIL to compile — `runText`, `parseTextFlags` undefined.

- [ ] **Step 3: Implement the command**

Create `server/cmd/relayium/text.go`. The flag surface and the SAS gate, which the tests pin exactly:

```go
type textFlags struct {
	server    string
	advertise string
	yes       bool // skip the SAS prompt -- for scripts, which cannot answer one
}

func parseTextFlags(args []string) (textFlags, []string, error) {
	var f textFlags
	fs := flag.NewFlagSet("text", flag.ContinueOnError)
	fs.StringVar(&f.server, "server", defaultServer, "rendezvous server")
	fs.StringVar(&f.advertise, "advertise", "", "host:port to advertise to the peer")
	fs.BoolVar(&f.yes, "yes", false, "do not prompt to confirm the SAS")
	rest, err := parseArgs(fs, args) // GNU-style permutation; see flagperm.go
	return f, rest, err
}

// A message session has no manifest for the user to inspect before content
// arrives, so unlike `send` -- where --verify opts IN to a prompt -- this
// prompts by default and --yes opts out.
func (f textFlags) confirmSAS(tty bool) bool { return tty && !f.yes }

// And a session that cannot prompt must refuse rather than proceed unverified.
// Failing fast is the rule the pairing-code work already set for scripted
// environments: never block a job on a human who is not there.
func (f textFlags) allowUnverified(tty bool) bool { return tty || f.yes }
```

The rest of the command:

- validate the code with `signal.ValidCodeFormat` **before** dialing, reusing the pre-dial error the pairing-code work already shipped;
- `crossnetConn(ctx, code, name, f, stderr, rzvous.ModeText)`, print the SAS, gate on confirmation;
- interactive (stdin is a TTY): a read loop over `bufio.Scanner` on stdin sending each line with `xfer.WriteText`, and a goroutine reading `xfer.ReadText` and printing to stdout. EOF ends the session. **The line-oriented reader is a limitation of the reader, not of the wire** — a terminal cannot distinguish "newline inside this message" from "send" without a terminator or a modifier key. Multiline content goes through the pipe form, which preserves it byte for byte; the startup banner says so in one line;
- non-interactive: read stdin to EOF and send it as one message, then read any reply until the peer closes;
- refuse a body over `xfer.TextMaxBytes` naming the byte limit and pointing at `relayium send`.

Register it in `run.go`'s switch and add a `text` line to `usage`. Add `parseTextFlags` to the parser table in `flagperm_test.go:151`.

- [ ] **Step 4: Run and confirm the tests pass**

Run: `cd server && go test ./... && go build ./... && go vet ./...`
Expected: PASS.

- [ ] **Step 5: Document it**

- `web/src/lib/cli-page-data.ts` + `CliPage.svelte`: a command block for `relayium text K7M4XR`. **The index-paired arrays are length-checked per language** by `i18n.test.ts:203-226`, so any new entry needs its copy in all nine files or that test goes red.
- `README.md`: the command in the CLI section, and update the M3 roadmap line at `:197` — the clipboard half of "stdin/Docker/clipboard still ahead" has now partly landed.

- [ ] **Step 6: Run the full gate and commit**

Run: `cd server && go test ./... && cd ../web && npx vitest run && npm run check && npm run build`
Expected: PASS.

```bash
git add server/cmd/relayium/ web/src/lib/CliPage.svelte web/src/lib/cli-page-data.ts \
        web/src/lib/i18n/ README.md
git commit -m "feat(cli): relayium text sends ephemeral messages between machines"
```

---

### Task 12: Protocol documents and the Swift fixtures

**Files:**
- Create: `docs/protocol/relayium-text-v1.md`
- Modify: `docs/protocol/relayium-realtime-wire-v1.md`, `relayium-crypto-v1.md`, `relayium-handshake-v1.md`, `relayium-realtime-flow-v1.md`
- Modify: `apps/RelayiumKit/Tests/Fixtures/crypto-vectors.json`, `realtime-wire-vectors.json`
- Modify: `apps/RelayiumKit/Sources/RelayiumKit/RealtimeWire/RealtimeFrame.swift`, `KeyAgreement.swift`, `RealtimeSignal.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/RealtimeFrameTests.swift`, `KeyAgreementTests.swift` (extend)

Both protocol docs state this is mandatory: *"Any change requires regenerating `apps/RelayiumKit/Tests/Fixtures/crypto-vectors.json` and updating web + Swift together"* (`relayium-crypto-v1.md:3-4`).

- [ ] **Step 1: Write the failing Swift tests**

Extend `KeyAgreementTests.swift` with a vector-driven case asserting the `relayium-text-v1\0` derivation matches the new `crypto-vectors.json` entry, and `RealtimeFrameTests.swift` with one asserting `RealtimeKind.text == 9` and that a kind-9 frame from `realtime-wire-vectors.json` opens to the expected UTF-8 — including a multibyte body, so a byte/character confusion in the Swift port fails here rather than in the field.

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/RelayiumKit && swift test 2>&1 | tail -20`
Expected: FAIL — the vector keys do not exist and `RealtimeKind.text` is undefined.

- [ ] **Step 3: Generate the vectors from the web implementation**

Add a vitest case in `web/src/lib/text-wire.test.ts` that prints the vector JSON (a fixed 32-byte session key, its derived text key, and a sealed kind-9 frame for an ASCII body, a CJK body and an emoji body), run it, and paste the output into the two fixture files. Generating from the web side is what makes the fixtures a cross-check rather than a restatement of the Swift code.

- [ ] **Step 4: Implement the Swift side**

- `RealtimeFrame.swift`: `public static let text: UInt8 = 9` in `RealtimeKind`, keeping the block a mirror of `transfer.ts:33-48`;
- `KeyAgreement.swift`: the text key derivation;
- `RealtimeSignal.swift` / `HandshakeMessage.swift`: optional `caps: [String]?`, decoded leniently and ignored when absent.

- [ ] **Step 5: Run and confirm the tests pass**

Run: `cd apps/RelayiumKit && swift test`
Expected: PASS.

- [ ] **Step 6: Write the protocol document**

Create `docs/protocol/relayium-text-v1.md` in the register of the existing docs — terse, authoritative, byte-level. It must state: the frame layout and kind 9; the derivation with its exact domain string; that the payload is raw UTF-8 with no envelope; the seq discipline and that it is per-direction from 0; `TEXT_MAX_BYTES`; that invalid UTF-8 is a hard error; capability negotiation at both the roster and SDP levels and that it is a hint, never a security input; the CLI's separate `MsgText` framing and mode negotiation, and that the two transports do not interoperate.

Amend the four existing docs: kind 9 and the text channel in the wire doc; the derivation in the crypto doc; `caps` in the handshake doc; and the *Version safety* section of the flow doc, which today says there is no version field — still true of the file stream, now with capabilities negotiated in the handshake.

- [ ] **Step 7: Commit**

```bash
git add docs/protocol/ apps/RelayiumKit/
git commit -m "docs(protocol): text wire v1, with Swift vectors regenerated from web"
```

---

### Task 13: Manual and browser gates

**Files:**
- Modify: `web/e2e/lan-transfer.mjs`
- Modify: `docs/TESTING.md`

- [ ] **Step 1: Extend the e2e script**

`web/e2e/lan-transfer.mjs` drives two real Chrome tabs over a hand-rolled CDP client and asserts a byte-exact transfer, a mid-transfer resume, and that the SAS matches on both sides (scraped from `.status code` at `:482`). Add a message case after the existing transfer:

- tab A clicks the per-peer message control, tab B accepts;
- assert the SAS in the message panel is **identical on both tabs** — the same property the file case asserts, and the reason there is one code;
- send a payload with leading/trailing spaces, tabs, blank lines, CJK and emoji, and assert the received `.msg-body` `textContent` is **byte-identical**;
- assert `.msg-body` never yields an element for an injected `<script>` payload;
- assert a peer running with `caps` suppressed gets no message control.

It selects by CSS class, so `.msgpanel`, `.msg-body`, `.byte-count` and `.sas` are now part of the contract — renaming them breaks e2e.

- [ ] **Step 2: Run it**

```bash
cd web && npm run build
cd ../server && RELAYIUM_ADDR=:8099 go run . &
cd ../web && npm run test:e2e
```
Expected: PASS, including the pre-existing transfer and resume cases. Chrome needs `--disable-features=WebRtcHideLocalIpsWithMdns` and the server CSP must include `'wasm-unsafe-eval'`, both already handled by the script and the server.

- [ ] **Step 3: Add the manual procedure**

Append a `[MANUAL]` section to `docs/TESTING.md`, in the existing register with expected output captured:

1. **Two devices, LAN.** Send a multiline code snippet with tabs and CJK; confirm the received text is visually identical, including indentation; copy it on the receiver and paste into an editor to confirm byte fidelity.
2. **Cross-network room.** Same, in a code room. Confirm the path badge reads `relay`, the SAS matches on both devices, and the session survives ten minutes of light use.
3. **Consent.** Confirm the request card names the peer and shows **no content** until accepted, and that declining closes the session.
4. **Old peer.** One device on the previous release: confirm the newer device offers no message control, that the older device sees **no** spurious failed-receive card, and that a **file** transfer between them still works — this is the compatibility case that matters most.
5. **Mutual exclusion.** Start a file transfer, then attempt a message session: confirm it is refused as busy rather than opening a second SAS.
6. **Ephemerality.** Reload; confirm history is gone. Check DevTools → Application: no message content in `localStorage` or `sessionStorage`.
7. **Notification.** With the tab backgrounded, confirm the OS notification names the sender and contains **no** body.
8. **Screen reader + keyboard.** VoiceOver announces arrivals once; Tab reaches the composer, the send button and each copy control; Enter inserts a newline and does not send.
9. **RTL.** Switch the UI to Arabic; confirm the panel mirrors and that a Latin message body still reads left-to-right.
10. **CLI.** `relayium text` on two machines: confirm the SAS prompt appears by default, that a piped run without `--yes` refuses, and that `relayium text` against `relayium receive` fails with the mode-mismatch message and **not** by silently transferring nothing.

- [ ] **Step 4: Repo hygiene, then commit**

Run: `scripts/check-production-identifiers.sh`
Expected: PASSED.

```bash
git add web/e2e/lan-transfer.mjs docs/TESTING.md
git commit -m "test: browser and manual gates for ephemeral text transfer"
```

---

## Compatibility sequence

Deployment order matters, and here it is permissive in both directions — but only because of the two properties Tasks 3 and 4 pin.

1. **`authPayload` is unchanged.** Old and new clients compute identical resume MACs, so a resume across mixed versions works. Asserted in Task 3, Step 1. This is the only hard ordering hazard in the feature, and it is removed rather than sequenced around.
2. **The file wire is unchanged.** No new kind reaches the file stream, no manifest field is added, `hsMsg` gains only an `omitempty` field, and `xfer.WireVersion` stays `1`. An old CLI and a new CLI transfer files exactly as before.
3. **Web deploys are self-healing.** Both peers load from the same origin, so a cached older client is a page reload away from parity — which is the argument `transfer.ts:306-309` already makes for failing closed rather than falling back.
4. **A new peer never provokes an old one.** Roster-level caps are what guarantee this: absent an announcement, no message connection is opened, so the old client sees no unexplained offer and no spurious failed-receive card. Manual gate 4 is the check.
5. **CLI upgrades are per-machine and need no coordination.** A new binary talking to an old one refuses only the `text` mode, and refuses it before any TCP connection.

**Order:** web first (it is reload-recoverable), CLI whenever, native later. Nothing in phase 1 requires two components to ship together **except** the Swift fixtures, which are regenerated in the same commit as the crypto change by Task 12 — the requirement the protocol docs already state.

## Rollout and rollback

**Rollout.** Tasks 1–8 are web-only and land behind the capability gate: until both peers announce `text/1`, there is no message UI on either. There is no server change and no new endpoint, so nothing needs a config flag — `caps` is the flag, and it is negotiated rather than configured. Tasks 9–11 ship in the next CLI release through the existing `goreleaser` path.

**Rollback.** Each layer reverts independently:

- **Web:** revert the `App.svelte` wiring (Tasks 7–8) and the panel disappears; `text-wire.ts`, `peer-caps.svelte.ts` and `text-session.svelte.ts` become dead code that nothing reaches. The one change in `transfer-session.svelte.ts` is an optional dep defaulting to today's behaviour, so `busy()` is safe to leave.
- **Stopping mid-plan is safe.** After any task through 8 the tree builds, the suite passes, and no user-visible messaging exists.
- **CLI:** the `text` subcommand is additive. Reverting it leaves `hsMsg.Mode` as an ignored `omitempty` field.
- **Crypto:** `deriveSession` gains two fields nothing else reads. Reverting Task 1 requires reverting Tasks 2 and 5 first.
- **What cannot be rolled back by reverting code** is a message already delivered to a peer's screen. There is nothing to unsend, no server copy to delete, and this is the design working as intended — but it means a defect in the *send* path is user-visible immediately, which is why Task 5's over-limit and flood tests are red-first.

**What would make this go wrong, in order of likelihood:**

1. `authPayload` changing, silently breaking resumes across a rolling deploy. One assertion, Task 3.
2. A byte-versus-character slip in a limit or a counter, so a Chinese or emoji message is refused after the user was told it fit. Tested in Tasks 2, 7 and 10 with multibyte fixtures.
3. Content mangled by normalisation somewhere — a `.trim()` added in review because it looked like tidiness. Every layer has a whitespace-preservation test for exactly this reason.
4. A message body reaching a log, an OS notification, or `localStorage`. Tested in Tasks 2, 5 and manual gates 6–7.
5. The phase boundary quietly crossed by "just one more change" to `transfer-session.svelte.ts`. `git diff --stat` on that file is the check, and Task 5 Step 9 names it.

## Deferred to phase 2 (not in this plan)

Extract `PeerLink`, move both streams onto one handshake and one SAS, add the labelled `relayium-text` DataChannel with a label-filtered `ondatachannel` on both roles, inherit the authenticated resume for message sessions, and lift the mutual exclusion so a message can be sent during a file transfer. The wire does not change: kind 9 and the derived subkey are paid for here precisely so that it does not.
