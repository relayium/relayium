import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveSession, generateKeyPair, ready, type SessionKeys } from "./crypto";
import {
  createMixedTextSession,
  MIXED_TEXT_CONSENT_TIMEOUT_MS,
  MIXED_TEXT_END_ACK_TIMEOUT_MS,
} from "./mixed-text-session.svelte";
import { LinkBusyError, UnsupportedLinkError, type MixedPeerLink } from "./peer-link.svelte";
import { TextReceiver, TextSender, TEXT_END, TEXT_REQUEST } from "./text-wire";
import { ACCEPT, REJECT } from "./transfer";

function fakeChannel() {
  return {
    sent: [] as ArrayBuffer[],
    readyState: "open" as RTCDataChannelState,
    bufferedAmount: 0,
    binaryType: "blob" as BinaryType,
    onmessage: null as ((event: MessageEvent) => void) | null,
    onclose: null as (() => void) | null,
    send(data: string | Blob | ArrayBuffer | ArrayBufferView) {
      if (typeof data === "string" || data instanceof Blob) throw new Error("unexpected payload");
      const view = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      this.sent.push(view.slice().buffer as ArrayBuffer);
    },
    close: vi.fn(function (this: { readyState: RTCDataChannelState }) {
      this.readyState = "closed";
    }),
    dispatch(data: ArrayBuffer | Uint8Array) {
      const value = data instanceof Uint8Array
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
        : data;
      this.onmessage?.(new MessageEvent("message", { data: value }));
    },
  };
}

type FakeChannel = ReturnType<typeof fakeChannel>;

async function harness(role: "initiator" | "responder" = "initiator") {
  const a = generateKeyPair();
  const b = generateKeyPair();
  const keys = await deriveSession(role, a, b.publicKey);
  const peerKeys = await deriveSession(role === "initiator" ? "responder" : "initiator", b, a.publicKey);
  const text = fakeChannel();
  const file = fakeChannel();
  const connClose = vi.fn();
  const link: MixedPeerLink = {
    peerId: "peer",
    role,
    conn: { close: connClose } as unknown as MixedPeerLink["conn"],
    fileChannel: file as unknown as RTCDataChannel,
    textChannel: text as unknown as RTCDataChannel,
    keys,
    sas: "123456",
    fileSender: {} as MixedPeerLink["fileSender"],
    fileReceiver: {} as MixedPeerLink["fileReceiver"],
    textSender: new TextSender(),
    textReceiver: new TextReceiver(),
  };
  let clock = 0;
  const ensureLink = vi.fn(async () => link);
  const session = createMixedTextSession({ ensureLink, now: () => ++clock });
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { session, link, text, file, peerKeys, ensureLink, connClose, flush };
}

const firstByte = (data: ArrayBuffer) => new Uint8Array(data)[0];

beforeEach(async () => { await ready(); });
afterEach(() => { vi.useRealTimers(); });

describe("mixed text session", () => {
  it("requests a conversation on an existing authenticated link", async () => {
    const { session, text, ensureLink } = await harness();
    await session.openWith("peer");
    await Promise.resolve();
    expect(ensureLink).toHaveBeenCalledOnce();
    expect(session.status).toBe("waitingAccept");
    expect(session.sasCode).toBe("123456");
    expect(firstByte(text.sent[0])).toBe(TEXT_REQUEST[0]);
  });

  it("accepts an inbound request without closing either lane", async () => {
    const { session, link, text, file, connClose } = await harness();
    session.attach(link);
    text.dispatch(TEXT_REQUEST);
    expect(session.status).toBe("incomingRequest");
    session.accept();
    await Promise.resolve();
    expect(session.status).toBe("open");
    expect(firstByte(text.sent[0])).toBe(ACCEPT[0]);
    expect(text.readyState).toBe("open");
    expect(file.readyState).toBe("open");
    expect(connClose).not.toHaveBeenCalled();
  });

  it("hard-fails the text lane without decrypting content sent before consent", async () => {
    const { session, link, text, file, peerKeys, flush } = await harness();
    session.attach(link);
    text.dispatch(TEXT_REQUEST);
    const peer = new TextSender();
    text.dispatch(await peer.frame("private until accepted", peerKeys.textSend));
    await flush();
    expect(session.history).toEqual([]);
    expect(session.status).toBe("failed");
    expect(text.readyState).toBe("closed");
    expect(file.readyState).toBe("open");
    session.accept();
    await flush();
    expect(session.history).toEqual([]);
  });

  it("sends and receives messages after consent", async () => {
    const { session, text, peerKeys, flush } = await harness();
    await session.openWith("peer");
    text.dispatch(ACCEPT);
    await session.send("outbound");
    const peerReceiver = new TextReceiver();
    expect(await peerReceiver.feed(new Uint8Array(text.sent[1]), peerKeys.textRecv)).toBe("outbound");
    const peerSender = new TextSender();
    text.dispatch(await peerSender.frame("inbound", peerKeys.textSend));
    await flush();
    expect(session.history.map((message) => message.body)).toEqual(["outbound", "inbound"]);
  });

  it("orders END after an already queued message and keeps the link open", async () => {
    const { session, text, file, connClose, flush } = await harness();
    await session.openWith("peer");
    text.dispatch(ACCEPT);
    const sending = session.send("last message");
    session.end();
    await sending;
    await flush();
    expect(firstByte(text.sent.at(-1)!)).toBe(TEXT_END[0]);
    expect(session.status).toBe("ended");
    expect(text.readyState).toBe("open");
    expect(file.readyState).toBe("open");
    expect(connClose).not.toHaveBeenCalled();
  });

  it("drains an in-flight peer message after local END without exposing or poisoning it", async () => {
    const { session, text, peerKeys, flush } = await harness();
    await session.openWith("peer");
    text.dispatch(ACCEPT);
    const peer = new TextSender();
    const inFlight = await peer.frame("already in flight", peerKeys.textSend);
    session.end();
    text.dispatch(inFlight);
    await flush();
    expect(session.status).toBe("ended");
    expect(session.history).toEqual([]);
    expect(text.readyState).toBe("open");

    text.dispatch(TEXT_END); // ordered acknowledgement closes the drain window
    await session.openWith("peer");
    text.dispatch(ACCEPT);
    text.dispatch(await peer.frame("next consented message", peerKeys.textSend));
    await flush();
    expect(session.status).toBe("open");
    expect(session.history.map((message) => message.body)).toEqual(["next consented message"]);
  });

  it("cancels queued encryption after remote END while draining an already-started nonce", async () => {
    const { session, link, text, flush } = await harness();
    await session.openWith("peer");
    text.dispatch(ACCEPT);
    const originalFrame = link.textSender.frame.bind(link.textSender);
    let release: (() => void) | undefined;
    const frameSpy = vi.spyOn(link.textSender, "frame").mockImplementationOnce((body, key) => {
      const framed = originalFrame(body, key);
      return new Promise((resolve, reject) => {
        release = () => { void framed.then(resolve, reject); };
      });
    });

    const encrypting = session.send("nonce already consumed");
    for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
    expect(release).toBeTypeOf("function");
    const queued = session.send("not encrypted yet");
    text.dispatch(TEXT_END);
    release!();
    await Promise.all([encrypting, queued]);

    expect(session.status).toBe("ended");
    expect(frameSpy).toHaveBeenCalledTimes(1);
    expect(text.sent.filter((frame) => firstByte(frame) === 9)).toHaveLength(1);
    expect(session.history.map(({ body, failed }) => ({ body, failed }))).toEqual([
      { body: "nonce already consumed", failed: true },
      { body: "not encrypted yet", failed: true },
    ]);
    expect(text.readyState).toBe("open");
  });

  it("reopens with the same link codecs and continuous outbound sequence", async () => {
    const { session, text } = await harness();
    await session.openWith("peer");
    text.dispatch(ACCEPT);
    await session.send("first");
    session.end();
    await Promise.resolve();
    text.dispatch(TEXT_END);
    await session.openWith("peer");
    await Promise.resolve();
    text.dispatch(ACCEPT);
    await session.send("second");
    const encrypted = text.sent.filter((frame) => frame.byteLength > 1);
    expect(encrypted.map((frame) => new DataView(frame).getUint32(1))).toEqual([0, 1]);
  });

  it("continues inbound sequence across reopened conversations", async () => {
    const { session, link, text, peerKeys, flush } = await harness();
    const peer = new TextSender();
    session.attach(link);
    text.dispatch(TEXT_REQUEST);
    session.accept();
    text.dispatch(await peer.frame("one", peerKeys.textSend));
    await flush();
    text.dispatch(TEXT_END);
    text.dispatch(TEXT_REQUEST);
    session.accept();
    text.dispatch(await peer.frame("two", peerKeys.textSend));
    await flush();
    expect(session.history.map((message) => message.body)).toEqual(["one", "two"]);
  });

  it("treats remote END as conversation-only", async () => {
    const { session, text, file, connClose, flush } = await harness();
    await session.openWith("peer");
    text.dispatch(ACCEPT);
    text.dispatch(TEXT_END);
    await flush();
    expect(session.status).toBe("ended");
    expect(firstByte(text.sent.at(-1)!)).toBe(TEXT_END[0]);
    expect(text.readyState).toBe("open");
    expect(file.readyState).toBe("open");
    expect(connClose).not.toHaveBeenCalled();
  });

  it("rejects one conversation but prompts again for a later request", async () => {
    const { session, link, text, flush } = await harness();
    session.attach(link);
    text.dispatch(TEXT_REQUEST);
    session.reject();
    await flush();
    expect(firstByte(text.sent[0])).toBe(REJECT[0]);
    expect(session.status).toBe("refused");
    expect(text.readyState).toBe("open");
    text.dispatch(TEXT_REQUEST);
    await flush();
    expect(text.sent.map(firstByte)).toEqual([REJECT[0]]);
    expect(session.status).toBe("incomingRequest");
  });

  it("treats a crossing REJECT as the ordered acknowledgement of local END", async () => {
    const { session, text } = await harness();
    await session.openWith("peer");
    session.end();
    expect(session.active()).toBe(true);
    text.dispatch(REJECT);
    expect(session.status).toBe("ended");
    expect(session.errorKey).toBe("");
    expect(session.active()).toBe(false);

    await session.openWith("peer");
    await Promise.resolve();
    expect(session.status).toBe("waitingAccept");
    expect(firstByte(text.sent.at(-1)!)).toBe(TEXT_REQUEST[0]);
  });

  it("uses the ordered REJECT itself as the barrier for a crossing END", async () => {
    const { session, link, text, flush } = await harness();
    session.attach(link);
    text.dispatch(TEXT_REQUEST);
    session.reject();
    await Promise.resolve();
    text.dispatch(TEXT_END);
    await flush();
    expect(session.status).toBe("refused");
    expect(session.errorKey).toBe("refused");
    expect(text.sent.map(firstByte)).toEqual([REJECT[0]]);
  });

  it("lets REJECT close a live drain window without losing inbound sequence", async () => {
    const { session, text, peerKeys, flush } = await harness();
    const peer = new TextSender();
    await session.openWith("peer");
    text.dispatch(ACCEPT);
    const inFlight = await peer.frame("discarded before reject", peerKeys.textSend);
    session.end();
    text.dispatch(inFlight);
    text.dispatch(REJECT);
    await flush();
    expect(session.active()).toBe(false);
    expect(session.history).toEqual([]);

    await session.openWith("peer");
    text.dispatch(ACCEPT);
    text.dispatch(await peer.frame("next conversation", peerKeys.textSend));
    await flush();
    expect(session.history.map((message) => message.body)).toEqual(["next conversation"]);
  });

  it("lets a local request clear a previous inbound refusal", async () => {
    const { session, link, text, ensureLink } = await harness();
    session.attach(link);
    text.dispatch(TEXT_REQUEST);
    session.reject();
    await Promise.resolve();
    await session.openWith("peer");
    await Promise.resolve();
    expect(session.status).toBe("waitingAccept");
    expect(firstByte(text.sent.at(-1)!)).toBe(TEXT_REQUEST[0]);
  });

  it("resolves simultaneous requests in favor of the smaller peer", async () => {
    const smaller = await harness("initiator");
    await smaller.session.openWith("peer");
    smaller.text.dispatch(TEXT_REQUEST);
    await smaller.flush();
    expect(smaller.session.status).toBe("waitingAccept");
    expect(firstByte(smaller.text.sent.at(-1)!)).toBe(REJECT[0]);

    const larger = await harness("responder");
    await larger.session.openWith("peer");
    larger.text.dispatch(TEXT_REQUEST);
    expect(larger.session.status).toBe("incomingRequest");
  });

  it("fails only the text lane on a malformed protected frame", async () => {
    const { session, text, file, connClose, flush } = await harness();
    await session.openWith("peer");
    text.dispatch(ACCEPT);
    const malformed = new Uint8Array(21);
    malformed[0] = 9;
    text.dispatch(malformed);
    await flush();
    expect(session.status).toBe("failed");
    expect(file.readyState).toBe("open");
    expect(connClose).not.toHaveBeenCalled();
  });

  it("hard-fails a short kind-9 frame instead of silently dropping it", async () => {
    const { session, link, text, file } = await harness();
    session.attach(link);
    text.dispatch(new Uint8Array([9, 0, 0, 0, 0]));
    expect(session.status).toBe("failed");
    expect(text.readyState).toBe("closed");
    expect(file.readyState).toBe("open");
  });

  it("never renders content sent after rejection in a later conversation", async () => {
    const { session, link, text, peerKeys, flush } = await harness();
    session.attach(link);
    text.dispatch(TEXT_REQUEST);
    session.reject();
    await flush();
    const peer = new TextSender();
    text.dispatch(await peer.frame("rejected content", peerKeys.textSend));
    await flush();
    expect(session.status).toBe("failed");
    expect(session.history).toEqual([]);
    await session.openWith("peer");
    expect(session.status).toBe("failed");
    expect(session.history).toEqual([]);
  });

  it("fails explicitly instead of waiting on a closed text channel", async () => {
    const { session, link, text } = await harness();
    session.attach(link);
    text.readyState = "closed";
    text.onclose?.();
    await session.openWith("peer");
    expect(session.status).toBe("failed");
    expect(session.errorKey).toBe("failed");
  });

  it("serialises concurrent sends with strictly increasing sequence numbers", async () => {
    const { session, text } = await harness();
    await session.openWith("peer");
    text.dispatch(ACCEPT);
    await Promise.all([session.send("one"), session.send("two"), session.send("three")]);
    const encrypted = text.sent.filter((frame) => frame.byteLength > 1);
    expect(encrypted.map((frame) => new DataView(frame).getUint32(1))).toEqual([0, 1, 2]);
  });

  it("bounds an unanswered consent prompt without closing the link", async () => {
    vi.useFakeTimers();
    const { session, text, file, connClose } = await harness();
    await session.openWith("peer");
    await vi.advanceTimersByTimeAsync(MIXED_TEXT_CONSENT_TIMEOUT_MS);
    await Promise.resolve();
    expect(session.status).toBe("ended");
    expect(firstByte(text.sent.at(-1)!)).toBe(TEXT_END[0]);
    expect(file.readyState).toBe("open");
    expect(connClose).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("drains a late ACCEPT and message after local consent timeout until END acknowledgement", async () => {
    vi.useFakeTimers();
    const { session, text, peerKeys } = await harness();
    await session.openWith("peer");
    await vi.advanceTimersByTimeAsync(MIXED_TEXT_CONSENT_TIMEOUT_MS);
    text.dispatch(ACCEPT);
    const peer = new TextSender();
    text.dispatch(await peer.frame("arrived after local timeout", peerKeys.textSend));
    await vi.advanceTimersByTimeAsync(MIXED_TEXT_END_ACK_TIMEOUT_MS - 1);
    expect(session.status).toBe("ended");
    expect(session.history).toEqual([]);
    expect(text.readyState).toBe("open");
    expect(session.active()).toBe(true);
    text.dispatch(TEXT_END);
    expect(session.active()).toBe(false);
  });

  it("hard-fails only the text lane when END acknowledgement never arrives", async () => {
    vi.useFakeTimers();
    const { session, link, text, file, connClose } = await harness();
    await session.openWith("peer");
    text.dispatch(ACCEPT);
    session.end();
    await vi.advanceTimersByTimeAsync(MIXED_TEXT_END_ACK_TIMEOUT_MS);
    expect(session.status).toBe("failed");
    expect(session.errorKey).toBe("failed");
    expect(session.active()).toBe(false);
    expect(text.readyState).toBe("closed");
    expect(file.readyState).toBe("open");
    expect(connClose).not.toHaveBeenCalled();
    const resumedText = fakeChannel();
    session.attach({ ...link, textChannel: resumedText as unknown as RTCDataChannel });
    expect(session.status).toBe("failed");
    expect(resumedText.readyState).toBe("closed");
  });

  it("lets end dismiss an incoming prompt without a silent no-op", async () => {
    const { session, link, text } = await harness();
    session.attach(link);
    text.dispatch(TEXT_REQUEST);
    session.end();
    await Promise.resolve();
    expect(session.status).toBe("ended");
    expect(session.active()).toBe(false);
    expect(firstByte(text.sent.at(-1)!)).toBe(REJECT[0]);
    await session.openWith("peer");
    expect(session.status).toBe("waitingAccept");
  });

  it("drains an honest late ACCEPT after a stale END crosses a reopened request", async () => {
    const { session, text, peerKeys, flush } = await harness();
    const peer = new TextSender();
    await session.openWith("peer");
    text.dispatch(TEXT_END);
    expect(session.status).toBe("ended");

    text.dispatch(ACCEPT);
    text.dispatch(await peer.frame("crossed the stale end", peerKeys.textSend));
    await flush();
    expect(session.status).toBe("ended");
    expect(session.history).toEqual([]);
    expect(text.readyState).toBe("open");

    text.dispatch(TEXT_END);
    await session.openWith("peer");
    text.dispatch(ACCEPT);
    text.dispatch(await peer.frame("next conversation", peerKeys.textSend));
    await flush();
    expect(session.status).toBe("open");
    expect(session.history.map((message) => message.body)).toEqual(["next conversation"]);
  });

  it("also bounds an unanswered inbound consent prompt", async () => {
    vi.useFakeTimers();
    const { session, link, text, file } = await harness();
    session.attach(link);
    text.dispatch(TEXT_REQUEST);
    await vi.advanceTimersByTimeAsync(MIXED_TEXT_CONSENT_TIMEOUT_MS);
    expect(session.status).toBe("ended");
    expect(session.active()).toBe(false);
    expect(firstByte(text.sent.at(-1)!)).toBe(REJECT[0]);
    expect(file.readyState).toBe("open");
    await vi.advanceTimersByTimeAsync(MIXED_TEXT_END_ACK_TIMEOUT_MS);
    expect(session.status).toBe("ended");
    expect(text.readyState).toBe("open");
  });

  it("maps an unsupported link to the explicit compatibility state", async () => {
    const { session, ensureLink } = await harness();
    ensureLink.mockRejectedValueOnce(new UnsupportedLinkError());
    await session.openWith("old-peer");
    expect(session.peerId).toBe("old-peer");
    expect(session.status).toBe("unsupported");
    expect(session.errorKey).toBe("unsupported");
  });

  it("preserves a pending local intent when the coordinator attaches its link", async () => {
    const base = await harness();
    let resolve!: (link: MixedPeerLink) => void;
    const ensured = new Promise<MixedPeerLink>((done) => { resolve = done; });
    const session = createMixedTextSession({
      ensureLink: () => ensured,
      now: () => 0,
    });
    const opening = session.openWith("peer");
    session.attach(base.link);
    expect(session.status).toBe("connecting");
    resolve(base.link);
    await opening;
    await base.flush();
    expect(session.status).toBe("waitingAccept");
    expect(firstByte(base.text.sent[0])).toBe(TEXT_REQUEST[0]);
  });

  it("orders the winning REQUEST before the glare REJECT during coordinator attach", async () => {
    const base = await harness("initiator");
    let resolve!: (link: MixedPeerLink) => void;
    const ensured = new Promise<MixedPeerLink>((done) => { resolve = done; });
    const session = createMixedTextSession({ ensureLink: () => ensured, now: () => 0 });
    const opening = session.openWith("peer");
    session.attach(base.link);
    base.text.dispatch(TEXT_REQUEST);
    expect(session.status).toBe("incomingRequest");
    resolve(base.link);
    await opening;
    await base.flush();
    expect(session.status).toBe("waitingAccept");
    expect(base.text.sent.map(firstByte)).toEqual([TEXT_REQUEST[0], REJECT[0]]);
  });

  it("ignores an END ordered before a pending local REQUEST", async () => {
    const base = await harness();
    let resolve!: (link: MixedPeerLink) => void;
    const ensured = new Promise<MixedPeerLink>((done) => { resolve = done; });
    const session = createMixedTextSession({ ensureLink: () => ensured, now: () => 0 });
    const opening = session.openWith("peer");
    session.attach(base.link);
    base.text.dispatch(TEXT_END);
    expect(session.status).toBe("connecting");
    resolve(base.link);
    await opening;
    await base.flush();
    expect(session.status).toBe("waitingAccept");
    expect(base.text.sent.map(firstByte)).toEqual([TEXT_REQUEST[0]]);
  });

  it("does not let a stale outbound crypto completion write into a replacement link", async () => {
    const old = await harness();
    const replacement = await harness();
    await old.session.openWith("peer");
    old.text.dispatch(ACCEPT);
    let resolve!: (frame: Uint8Array<ArrayBuffer>) => void;
    const framed = new Promise<Uint8Array<ArrayBuffer>>((done) => { resolve = done; });
    vi.spyOn(old.link.textSender, "frame").mockReturnValueOnce(framed);
    const sending = old.session.send("stale");
    old.session.attach({ ...replacement.link, peerId: "other" });
    resolve(new Uint8Array(21) as Uint8Array<ArrayBuffer>);
    await sending;
    expect(old.session.peerId).toBe("other");
    expect(old.session.history).toEqual([]);
    expect(old.text.sent.filter((frame) => frame.byteLength > 1)).toHaveLength(0);
    expect(replacement.text.sent).toHaveLength(0);
  });

  it("keeps one codec chain and poisons a dropped nonce across detach and reattach", async () => {
    const { session, link, text, flush } = await harness();
    await session.openWith("peer");
    text.dispatch(ACCEPT);
    let resolve!: (frame: Uint8Array<ArrayBuffer>) => void;
    const framed = new Promise<Uint8Array<ArrayBuffer>>((done) => { resolve = done; });
    const frame = vi.spyOn(link.textSender, "frame").mockReturnValueOnce(framed);
    const stale = session.send("stale");
    await flush();
    expect(frame).toHaveBeenCalledTimes(1);
    session.detach();
    session.attach(link);
    text.dispatch(TEXT_REQUEST);
    session.accept();
    const newer = session.send("newer");
    await Promise.resolve();
    expect(frame).toHaveBeenCalledTimes(1);
    resolve(new Uint8Array(21) as Uint8Array<ArrayBuffer>);
    await Promise.all([stale, newer]);
    await flush();
    expect(session.status).toBe("failed");
    expect(text.sent.filter((item) => item.byteLength > 1)).toHaveLength(0);
  });

  it("ignores queued handlers from an earlier attachment generation", async () => {
    const { session, link, text } = await harness();
    session.attach(link);
    const staleMessage = text.onmessage!;
    const staleClose = text.onclose!;
    session.detach();
    expect(session.sasCode).toBe("");
    expect(text.onmessage).toBeNull();
    expect(text.onclose).toBeNull();
    session.attach(link);
    staleMessage(new MessageEvent("message", { data: TEXT_REQUEST.buffer }));
    staleClose();
    expect(session.status).toBe("idle");
    expect(session.link).toBe(link);
    expect(text.onmessage).not.toBeNull();
    expect(text.onclose).not.toBeNull();
  });

  it("keeps a protocol failure poisoned across a resumed channel with the same codecs", async () => {
    const { session, link, text } = await harness();
    session.attach(link);
    text.dispatch(new Uint8Array([9]));
    const resumedText = fakeChannel();
    session.attach({ ...link, textChannel: resumedText as unknown as RTCDataChannel });
    expect(session.status).toBe("failed");
    expect(resumedText.readyState).toBe("closed");
  });

  it("poisons a resumed receiver when an admitted frame is stranded behind transport loss", async () => {
    const { session, link, text, peerKeys, flush } = await harness();
    await session.openWith("peer");
    text.dispatch(ACCEPT);
    let resolve!: (body: string) => void;
    const firstOpen = new Promise<string>((done) => { resolve = done; });
    vi.spyOn(link.textReceiver, "feed")
      .mockReturnValueOnce(firstOpen)
      .mockResolvedValueOnce("second");
    const peer = new TextSender();
    text.dispatch(await peer.frame("first", peerKeys.textSend));
    await Promise.resolve();
    text.dispatch(await peer.frame("second", peerKeys.textSend));
    text.readyState = "closed";
    text.onclose?.();
    const resumedText = fakeChannel();
    session.attach({ ...link, textChannel: resumedText as unknown as RTCDataChannel });
    resolve("first");
    await flush();
    expect(session.status).toBe("failed");
    expect(resumedText.readyState).toBe("closed");
    expect(link.textReceiver.feed).toHaveBeenCalledTimes(1);
  });

  it("maps ordinary transport loss to ended and permits a resumed conversation", async () => {
    const { session, link, text, ensureLink } = await harness();
    await session.openWith("peer");
    text.dispatch(ACCEPT);
    await session.send("kept in transcript");
    text.readyState = "closed";
    text.onclose?.();
    expect(session.status).toBe("ended");
    expect(session.sasCode).toBe("123456");
    const resumedText = fakeChannel();
    const resumed = { ...link, textChannel: resumedText as unknown as RTCDataChannel };
    ensureLink.mockResolvedValue(resumed);
    session.attach(resumed);
    expect(session.status).toBe("ended");
    expect(session.history.at(-1)?.body).toBe("kept in transcript");
    await session.openWith("peer");
    await Promise.resolve();
    expect(session.status).toBe("waitingAccept");
    expect(firstByte(resumedText.sent[0])).toBe(TEXT_REQUEST[0]);
  });

  it("does not turn an ended conversation into a failure when transport later closes", async () => {
    const { session, link, text } = await harness();
    await session.openWith("peer");
    text.dispatch(ACCEPT);
    session.end();
    await Promise.resolve();
    text.readyState = "closed";
    text.onclose?.();
    expect(session.status).toBe("ended");
    expect(session.errorKey).toBe("");
    expect(session.sasCode).toBe("123456");
  });

  it("rate-limits protected frames independently from lifecycle controls", async () => {
    const base = await harness();
    const session = createMixedTextSession({ ensureLink: async () => base.link, now: () => 0 });
    session.attach(base.link);
    base.text.dispatch(TEXT_REQUEST);
    session.accept();
    const peer = new TextSender();
    for (let i = 0; i <= 20; i++) {
      base.text.dispatch(await peer.frame(`message ${i}`, base.peerKeys.textSend));
    }
    await base.flush();
    expect(session.status).toBe("failed");
    expect(session.errorKey).toBe("flooding");
    expect(session.history).toHaveLength(20);
    expect(base.file.readyState).toBe("open");
  });

  it("does not poison link codecs when only lifecycle controls flood one channel generation", async () => {
    const { session, link, text, ensureLink } = await harness();
    session.attach(link);
    for (let i = 0; i <= 20; i++) text.dispatch(TEXT_END);
    expect(session.status).toBe("failed");
    const resumedText = fakeChannel();
    const resumed = { ...link, textChannel: resumedText as unknown as RTCDataChannel };
    ensureLink.mockResolvedValue(resumed);
    session.attach(resumed);
    await session.openWith("peer");
    await Promise.resolve();
    expect(session.status).toBe("waitingAccept");
    expect(firstByte(resumedText.sent[0])).toBe(TEXT_REQUEST[0]);
  });

  it("poisons link codecs when transport closes with protected bytes still buffered", async () => {
    const { session, link, text } = await harness();
    await session.openWith("peer");
    text.dispatch(ACCEPT);
    await session.send("still buffered");
    text.bufferedAmount = 1;
    text.readyState = "closed";
    text.onclose?.();
    expect(session.status).toBe("failed");
    const resumedText = fakeChannel();
    session.attach({ ...link, textChannel: resumedText as unknown as RTCDataChannel });
    expect(session.status).toBe("failed");
    expect(resumedText.readyState).toBe("closed");
  });

  it("enforces the protected-byte ceiling before decryption", async () => {
    const base = await harness();
    const session = createMixedTextSession({ ensureLink: async () => base.link, now: () => 0 });
    vi.spyOn(base.link.textReceiver, "feed").mockResolvedValue("should not open");
    session.attach(base.link);
    base.text.dispatch(TEXT_REQUEST);
    session.accept();
    const oversized = new Uint8Array((4 << 20) + 1);
    oversized[0] = 9;
    base.text.dispatch(oversized);
    await base.flush();
    expect(session.status).toBe("failed");
    expect(base.link.textReceiver.feed).not.toHaveBeenCalled();
  });

  it("enforces the protected-message ceiling", async () => {
    const base = await harness();
    let clock = 0;
    const session = createMixedTextSession({
      ensureLink: async () => base.link,
      now: () => (clock += 1_000),
    });
    vi.spyOn(base.link.textReceiver, "feed").mockResolvedValue("accepted");
    session.attach(base.link);
    base.text.dispatch(TEXT_REQUEST);
    session.accept();
    for (let i = 0; i <= 500; i++) {
      const frame = new Uint8Array(21);
      frame[0] = 9;
      base.text.dispatch(frame);
    }
    await base.flush();
    expect(session.status).toBe("failed");
    expect(base.link.textReceiver.feed).toHaveBeenCalledTimes(500);
  });

  it("resets protected-byte accounting only for a new consented conversation", async () => {
    const base = await harness();
    const session = createMixedTextSession({ ensureLink: async () => base.link, now: () => 0 });
    vi.spyOn(base.link.textReceiver, "feed").mockResolvedValue("accepted");
    session.attach(base.link);
    base.text.dispatch(TEXT_REQUEST);
    session.accept();
    const maximum = new Uint8Array(4 << 20);
    maximum[0] = 9;
    base.text.dispatch(maximum);
    await base.flush();
    base.text.dispatch(TEXT_END);
    base.text.dispatch(TEXT_REQUEST);
    session.accept();
    base.text.dispatch(maximum);
    await base.flush();
    expect(session.status).toBe("open");
    expect(base.link.textReceiver.feed).toHaveBeenCalledTimes(2);
  });

  it("reports another peer as busy without corrupting the attached peer id", async () => {
    const { session, link } = await harness();
    session.attach(link);
    await session.openWith("other");
    expect(session.status).toBe("peerBusy");
    expect(session.peerId).toBe("peer");
    expect(session.link?.peerId).toBe("peer");
  });

  it("maps a link-manager busy rejection to the explicit state", async () => {
    const base = await harness();
    base.ensureLink.mockRejectedValueOnce(new LinkBusyError());
    await base.session.openWith("peer");
    expect(base.session.status).toBe("peerBusy");
    expect(base.session.errorKey).toBe("peerBusy");
  });

  it("cancels a pending link open when the conversation is ended", async () => {
    const base = await harness();
    let resolve!: (link: MixedPeerLink) => void;
    const ensured = new Promise<MixedPeerLink>((done) => { resolve = done; });
    const session = createMixedTextSession({ ensureLink: () => ensured, now: () => 0 });
    const opening = session.openWith("peer");
    session.end();
    resolve(base.link);
    await opening;
    expect(session.status).toBe("ended");
    expect(session.link).toBeNull();
    expect(base.text.sent).toEqual([]);
  });

  it("bounds outbound text and lets the user clear local history", async () => {
    const { session, text } = await harness();
    await session.openWith("peer");
    text.dispatch(ACCEPT);
    await session.send("x".repeat(65_537));
    expect(session.errorKey).toBe("tooLong");
    await session.send("kept");
    expect(session.history).toHaveLength(1);
    session.clearHistory();
    expect(session.history).toEqual([]);
  });

  it("clears transcript identity when attaching a different peer", async () => {
    const first = await harness();
    const second = await harness();
    await first.session.openWith("peer");
    first.text.dispatch(ACCEPT);
    await first.session.send("first peer");
    const other = { ...second.link, peerId: "other" };
    first.session.attach(other);
    expect(first.session.history).toEqual([]);
    second.text.dispatch(TEXT_REQUEST);
    first.session.accept();
    await first.session.send("second peer");
    expect(first.session.history).toEqual([
      expect.objectContaining({ id: 1, body: "second peer" }),
    ]);
  });

  it("does not let a stale inbound crypto completion enter replacement history", async () => {
    const old = await harness();
    const replacement = await harness();
    await old.session.openWith("peer");
    old.text.dispatch(ACCEPT);
    let resolve!: (body: string) => void;
    const opened = new Promise<string>((done) => { resolve = done; });
    vi.spyOn(old.link.textReceiver, "feed").mockReturnValueOnce(opened);
    const frame = new Uint8Array(21);
    frame[0] = 9;
    old.text.dispatch(frame);
    await Promise.resolve();
    old.session.attach({ ...replacement.link, peerId: "other" });
    resolve("stale inbound");
    await old.flush();
    expect(old.session.peerId).toBe("other");
    expect(old.session.history).toEqual([]);
  });

  it("preserves a flooding error when the failed text channel closes", async () => {
    const { session, link, text } = await harness();
    session.attach(link);
    for (let i = 0; i <= 20; i++) text.dispatch(TEXT_END);
    expect(session.status).toBe("failed");
    expect(session.errorKey).toBe("flooding");
    text.onclose?.();
    expect(session.status).toBe("failed");
    expect(session.errorKey).toBe("flooding");
  });

  it("preserves a flooding error when protected bytes are also buffered at close", async () => {
    const { session, link, text } = await harness();
    await session.openWith("peer");
    text.dispatch(ACCEPT);
    await session.send("still buffered");
    text.bufferedAmount = 1;
    for (let i = 0; i <= 20; i++) text.dispatch(TEXT_END);
    expect(session.status).toBe("failed");
    expect(session.errorKey).toBe("flooding");
    text.onclose?.();
    expect(session.status).toBe("failed");
    expect(session.errorKey).toBe("flooding");
    const resumedText = fakeChannel();
    session.attach({ ...link, textChannel: resumedText as unknown as RTCDataChannel });
    expect(session.status).toBe("failed");
    expect(resumedText.readyState).toBe("closed");
  });

  it("marks a locally backpressured message failed without affecting the file lane", async () => {
    const { session, text, file } = await harness();
    await session.openWith("peer");
    text.dispatch(ACCEPT);
    text.bufferedAmount = (1 << 20) + 1;
    await session.send("blocked");
    expect(session.history.at(-1)).toMatchObject({ body: "blocked", failed: true });
    expect(file.readyState).toBe("open");
  });
});
