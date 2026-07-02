import type { SignalingClient } from "./signaling";
import { commitKey, randomNonce, verifyCommit } from "./crypto";

export interface RtcConfig {
  iceServers: RTCIceServer[];
}

export const DEFAULT_ICE: RtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

/** A public key + nonce revealed only after both commitments were exchanged. */
export interface Reveal {
  key: string; // base64 public key
  nonce: string; // base64 commitment nonce
}

export interface InboundSignal {
  sdp?: RTCSessionDescriptionInit;
  /** base64 BLAKE2b(pub || nonce); travels with the offer/answer SDP. */
  commit?: string;
  /** Sent only after this side has seen the peer's commit. */
  reveal?: Reveal;
  ice?: RTCIceCandidateInit;
}

interface ConnectOpts {
  signaling: SignalingClient;
  peerId: string;
  selfKey: Uint8Array;
  role: "initiator" | "responder";
  onPeerKey: (k: Uint8Array) => void;
  config?: RtcConfig;
  initialSignal?: InboundSignal;
  /** Notified whenever the peer connection changes state. Lets the UI surface a
   *  drop as a failed transfer instead of hanging forever. "failed"/"closed" are
   *  terminal; a transient "disconnected" triggers an automatic ICE restart. */
  onStateChange?: (state: RTCPeerConnectionState) => void;
}

export interface Conn {
  channel: RTCDataChannel;
  /** Tear down the peer connection and stop listening for this peer's signals. */
  close(): void;
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export async function connect(opts: ConnectOpts): Promise<Conn> {
  const pc = new RTCPeerConnection(opts.config ?? DEFAULT_ICE);
  const { signaling, peerId, selfKey, role, onPeerKey } = opts;

  // Commit-then-reveal: publish BLAKE2b(selfKey || selfNonce) with the SDP, and
  // only disclose selfKey/selfNonce once the peer's commit is in hand. See
  // crypto.ts for why this is what makes a 6-digit SAS safe against a relay MITM.
  const selfNonce = randomNonce();
  const selfCommit = b64(commitKey(selfKey, selfNonce));
  let peerCommit: Uint8Array | undefined;
  let revealSent = false;
  let peerKeyDelivered = false;

  pc.onicecandidate = (e) => {
    if (e.candidate) signaling.sendSignal(peerId, { ice: e.candidate });
  };

  let channel: RTCDataChannel;
  let opened = false;
  let failReady!: (err: Error) => void;
  const ready = new Promise<RTCDataChannel>((resolve, reject) => {
    failReady = reject;
    const open = (ch: RTCDataChannel) => { opened = true; resolve(ch); };
    if (role === "initiator") {
      channel = pc.createDataChannel("relayium");
      channel.binaryType = "arraybuffer";
      channel.bufferedAmountLowThreshold = 8 << 20; // 8 MB in-flight window keeps the pipe full
      channel.onopen = () => open(channel);
    } else {
      pc.ondatachannel = (ev) => {
        channel = ev.channel;
        channel.binaryType = "arraybuffer";
        channel.bufferedAmountLowThreshold = 8 << 20; // 8 MB in-flight window keeps the pipe full
        if (channel.readyState === "open") open(channel);
        else channel.onopen = () => open(channel);
      };
    }
  });

  // Fail fast if the data channel never opens. Two escape hatches: a "failed"
  // connection state, and an overall timeout for the case where ICE sits in
  // "checking" and never flips to "failed" (no reachable path, TURN blocked).
  // Without this, a caller awaiting connect() hangs at "connecting" 0% forever.
  const CONNECT_TIMEOUT_MS = 30_000;
  const connectTimer = setTimeout(() => {
    if (!opened) failReady(new Error("relayium: connection timed out"));
  }, CONNECT_TIMEOUT_MS);

  // Disclose our real key + nonce. Guarded to once: an ICE-restart answer would
  // otherwise re-trigger this after the SAS is already fixed.
  function sendReveal() {
    if (revealSent) return;
    revealSent = true;
    signaling.sendSignal(peerId, {
      reveal: { key: b64(selfKey), nonce: b64(selfNonce) },
    });
  }

  // Verify a peer reveal against its earlier commit. A mismatch means the value
  // was chosen after seeing our key (or tampered in flight): abort hard, never
  // open the channel — silently continuing would defeat the SAS entirely.
  function handleReveal(rev: Reveal) {
    if (peerKeyDelivered) return; // ignore duplicates (e.g. ICE restart)
    const peerPub = unb64(rev.key);
    const peerNonce = unb64(rev.nonce);
    if (!peerCommit || !verifyCommit(peerCommit, peerPub, peerNonce)) {
      // failReady unblocks a caller still awaiting connect(); close() tears down
      // even if the channel already opened (then failReady is a settled no-op),
      // surfacing to the app as a dropped connection rather than a silent MITM.
      failReady(new Error("relayium: key commitment mismatch — possible MITM"));
      close();
      return;
    }
    peerKeyDelivered = true;
    // Responder learns the peer key from the reveal and only now discloses its
    // own; the initiator has already revealed (on receiving the answer's commit).
    if (role === "responder") sendReveal();
    onPeerKey(peerPub);
  }

  async function handleSignal(msg: InboundSignal) {
    if (msg.commit) peerCommit = unb64(msg.commit);
    if (msg.sdp) {
      await pc.setRemoteDescription(msg.sdp);
      if (msg.sdp.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signaling.sendSignal(peerId, { sdp: answer, commit: selfCommit });
      } else if (msg.sdp.type === "answer") {
        // Initiator now holds the responder's commit → safe to reveal our key.
        sendReveal();
      }
    }
    if (msg.reveal) handleReveal(msg.reveal);
    if (msg.ice) {
      try {
        await pc.addIceCandidate(msg.ice);
      } catch {
        // A candidate arriving before remoteDescription is set, or after close,
        // is non-fatal on a LAN where host candidates in the SDP usually suffice.
      }
    }
  }

  const off = signaling.onSignal((from, data) => {
    if (from === peerId) handleSignal(data as InboundSignal).catch((err) => console.error("relayium signal error", err));
  });

  // A transient "disconnected" (a NAT rebinding, a brief network blip) often
  // recovers on its own, and an ICE restart forces fresh candidate gathering to
  // speed that up. Only the initiator drives renegotiation; guard to one attempt
  // so a genuinely dead path fails fast instead of looping offers.
  let restarted = false;
  async function tryIceRestart() {
    if (restarted || role !== "initiator") return;
    restarted = true;
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      signaling.sendSignal(peerId, { sdp: offer });
    } catch (err) {
      console.error("relayium ice restart error", err);
    }
  }

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    opts.onStateChange?.(state);
    if (state === "disconnected") tryIceRestart();
    // A failure before the channel ever opened must unblock connect(); after it
    // opened, ready is already settled and this reject is a harmless no-op.
    if (state === "failed" && !opened) failReady(new Error("relayium: connection failed"));
    // Once the connection reaches a terminal state, stop routing this peer's
    // signals so listeners don't pile up across repeated transfers.
    if (state === "closed" || state === "failed") off();
  };

  function close() {
    off();
    try { pc.close(); } catch { /* already closed */ }
  }

  if (role === "initiator") {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signaling.sendSignal(peerId, { sdp: offer, commit: selfCommit });
  } else if (opts.initialSignal) {
    await handleSignal(opts.initialSignal);
  }

  try {
    const openChannel = await ready;
    clearTimeout(connectTimer);
    return { channel: openChannel, close };
  } catch (err) {
    // Establishment failed or timed out: clean up the listener and peer
    // connection, then propagate so the caller shows a retryable failure
    // instead of a progress bar frozen at 0%.
    clearTimeout(connectTimer);
    close();
    throw err;
  }
}
