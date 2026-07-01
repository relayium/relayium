import type { SignalingClient } from "./signaling";

export interface RtcConfig {
  iceServers: RTCIceServer[];
}

export const DEFAULT_ICE: RtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export interface InboundSignal {
  sdp?: RTCSessionDescriptionInit;
  key?: string;
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

  async function handleSignal(msg: InboundSignal) {
    if (msg.key) onPeerKey(unb64(msg.key));
    if (msg.sdp) {
      await pc.setRemoteDescription(msg.sdp);
      if (msg.sdp.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signaling.sendSignal(peerId, { sdp: answer, key: b64(selfKey) });
      }
    }
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
    signaling.sendSignal(peerId, { sdp: offer, key: b64(selfKey) });
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
