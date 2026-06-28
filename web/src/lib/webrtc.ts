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
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export async function connect(opts: ConnectOpts): Promise<RTCDataChannel> {
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
      channel.bufferedAmountLowThreshold = 1 << 20;
      channel.onopen = () => resolve(channel);
    } else {
      pc.ondatachannel = (ev) => {
        channel = ev.channel;
        channel.binaryType = "arraybuffer";
        channel.bufferedAmountLowThreshold = 1 << 20;
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

  signaling.onSignal((from, data) => {
    if (from === peerId) void handleSignal(data as InboundSignal);
  });

  if (role === "initiator") {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signaling.sendSignal(peerId, { sdp: offer, key: b64(selfKey) });
  } else if (opts.initialSignal) {
    await handleSignal(opts.initialSignal);
  }

  return ready;
}
