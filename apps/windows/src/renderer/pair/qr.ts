// A QR image for a join link, or nothing.
//
// The shape is `web/src/lib/CodePairing.svelte`'s, deliberately: a DYNAMIC
// import, `toDataURL` into an `<img>`, a cancellation flag captured against the
// link, and a silent failure. Three properties follow from it.
//
//   * The render is cancellable, so a slow encode cannot overwrite a newer
//     link. That is the same rule `PairingCodeHandoffView` applies to its copy
//     state — a QR belongs to ONE link, never to the component slot.
//   * A runtime failure degrades to no image. `QRCode.swift` says it best: a
//     failed QR is a missing accelerator, not a broken screen, and the code and
//     the link are still on screen and still work.
//   * A data URL, not a canvas, which is what makes that failure path trivial.
//
// What it does NOT do is make the dependency optional at BUILD time. `qrcode` is
// a declared dependency and the bundle must resolve it; a build that could not
// would be a broken build, not a degraded feature.

/** Matches the mac's 144pt handoff QR at this app's pixel density. */
export const QR_SIDE = 160;

export interface QrRequest {
  readonly link: string;
  /** The link's generation. A result carrying an older one is discarded. */
  readonly generation: number;
}

export interface QrResult {
  readonly generation: number;
  /** `null` when the encoder was unavailable or refused the input. */
  readonly dataUrl: string | null;
}

/**
 * Encode one link.
 *
 * Never rejects: the caller gets `dataUrl: null` and renders the code and the
 * copy button, which is the whole affordance minus an accelerator.
 */
export async function renderJoinQr(request: QrRequest): Promise<QrResult> {
  const { link, generation } = request;
  if (typeof link !== "string" || link.length === 0) return { generation, dataUrl: null };
  try {
    const module = await import("qrcode");
    const dataUrl = await module.toDataURL(link, { margin: 1, width: QR_SIDE });
    return { generation, dataUrl: typeof dataUrl === "string" ? dataUrl : null };
  } catch {
    return { generation, dataUrl: null };
  }
}
