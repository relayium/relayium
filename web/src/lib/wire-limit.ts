/**
 * How many bytes one DataChannel message may carry on *this* connection.
 *
 * SCTP negotiates a maximum message size. The browser exposes the result on
 * `RTCPeerConnection.sctp.maxMessageSize`, and `send()` on a larger message
 * fails — the channel errors or closes, and the transfer dies with it.
 *
 * The number is **not** a constant of the local browser. Per RFC 8841 it is the
 * smaller of what we can send and what the *remote* advertised in its SDP
 * `a=max-message-size`, and a remote that advertises nothing means 64 KiB. So a
 * peer on an old Chromium-based Android WebView drags the limit down for the
 * desktop that is sending to it. That is the whole reason this module exists.
 */

/** The RFC 8841 default: what a peer that advertises nothing can accept. Also
 *  what we assume whenever the browser will not tell us. */
export const CONSERVATIVE_MAX_MESSAGE_BYTES = 65_536;

/** What a current Chromium advertises and accepts. Nothing at runtime depends on
 *  it — the connection is always asked — but it is the number that makes "this
 *  works on desktop and fails on that phone" concrete. */
export const CHROME_MAX_MESSAGE_BYTES = 262_144;

/** Just enough of `RTCSctpTransport` to read the negotiated limit — so this is
 *  testable without a real PeerConnection. */
export interface SctpLimitSource {
  maxMessageSize?: number;
}

/**
 * The negotiated per-message ceiling, or a conservative floor when the browser
 * gives us nothing usable.
 *
 * `Infinity` is not ambiguous: the spec returns it only when both ends declared
 * no limit, so it is honoured as "no ceiling". Everything else that is not a
 * positive finite number — a missing transport (SCTP not up yet), `undefined`,
 * `0`, `NaN`, a negative — is treated as unknown and answered conservatively.
 * `0` in particular is a value the spec says should never be returned; reading
 * it as "unlimited" would be exactly the wrong guess.
 */
export function negotiatedMaxMessageBytes(sctp: SctpLimitSource | null | undefined): number {
  const max = sctp?.maxMessageSize;
  if (max === Infinity) return Infinity;
  if (typeof max !== "number" || !Number.isFinite(max) || max <= 0) {
    return CONSERVATIVE_MAX_MESSAGE_BYTES;
  }
  return Math.floor(max);
}
