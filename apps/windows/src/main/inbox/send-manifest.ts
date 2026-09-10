// The v3 manifest one staged delivery seals at frame 0.
//
// A PURE function of the descriptors — no clock, no network, no state left over
// from the attempt that staged it. Three properties follow, each the answer to
// a real failure (`InboxSendManifest.swift` states the same three):
//
//  1. **Every attempt seals the same document.** A retry and a reseal after a
//     key rotation rebuild it from the same durable plan, so none of them can
//     produce a delivery of a different kind — or a different item order — than
//     the attempt before it.
//  2. **A resume in a fresh process is correct.** Everything it needs is on disk.
//  3. **There is no fall-back.** The shared Stored-Wire manifest is not
//     reachable from here. A delivery that cannot produce a valid v3 manifest
//     fails, rather than quietly sealing the document its own receiver refuses.
//
// **Item order is the caller's, never sorted.** Descriptor *i* describes payload
// frames *i*; sorting here would silently rename every file in a folder send.
import type { InboxRuntime, RuntimeManifest } from "./runtime-contract.js";

/** One item the user chose. A manifest name, never a path on this disk. */
export interface SendDescriptor {
  /** Manifest-relative name. May contain "/" so a folder keeps its shape. */
  readonly relativePath: string;
  readonly size: number;
}

export type SendKind = "file" | "text";

export class SendManifestError extends Error {
  constructor(
    readonly code: "empty" | "kind-mismatch" | "size" | "text-item-count" | "refused",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "SendManifestError";
  }
}

/**
 * Build the manifest, or refuse.
 *
 * Refusing is the honest outcome for a delivery no receiver would accept — a
 * traversal name, an oversized message, an item count past the ceiling. It
 * would have been refused after the upload instead, at the cost of the user's
 * bandwidth. The shared validator is the authority; nothing is re-implemented.
 */
export function buildSendManifest(
  runtime: InboxRuntime,
  kind: SendKind,
  descriptors: readonly SendDescriptor[],
): RuntimeManifest {
  if (descriptors.length === 0) throw new SendManifestError("empty", "a delivery with no items");
  for (const item of descriptors) {
    if (!Number.isSafeInteger(item.size) || item.size < 0) {
      throw new SendManifestError("size", "an item size is not an exact non-negative integer");
    }
  }
  try {
    if (kind === "text") {
      // ONE item, and its size only. The message's bytes are payload frames;
      // putting them here would make the manifest's size a function of its
      // content and would put plaintext into the one structure a receiver
      // parses before it has decided the delivery is safe to accept.
      if (descriptors.length !== 1) {
        throw new SendManifestError("text-item-count", "a text delivery is exactly one item");
      }
      return runtime.textManifest(descriptors[0]!.size);
    }
    return runtime.fileManifest(descriptors.map((d) => ({ name: d.relativePath, size: d.size })));
  } catch (error) {
    if (error instanceof SendManifestError) throw error;
    // The shared validator refused it. Its reason is not re-derived here.
    throw new SendManifestError("refused", (error as Error).name);
  }
}

/** The canonical bytes frame 0 carries. */
export function encodeSendManifest(runtime: InboxRuntime, manifest: RuntimeManifest): Uint8Array {
  return runtime.encodeInboxManifest(manifest);
}
