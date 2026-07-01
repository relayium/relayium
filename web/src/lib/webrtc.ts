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
  const ready = new Promise<RTCDataChannel>((resolve) => {
    if (role === "initiator") {
      channel = pc.createDataChannel("relayium");
      channel.binaryType = "arraybuffer";
      channel.bufferedAmountLowThreshold = 8 << 20; // 8 MB in-flight window keeps the pipe full
      channel.onopen = () => resolve(channel);
    } else {
      pc.ondatachannel = (ev) => {
        channel = ev.channel;
        channel.binaryType = "arraybuffer";
        channel.bufferedAmountLowThreshold = 8 << 20; // 8 MB in-flight window keeps the pipe full
        if (channel.readyState === "open") resolve(channel);
        else channel.onopen = () => resolve(channel);
      };
    }
  });

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

  const openChannel = await ready;
  return { channel: openChannel, close };
}
