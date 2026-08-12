import { describe, it, expect, vi, afterEach } from "vitest";
import { uploadFileResumable } from "./stored-file";
import { completionVerifier, decodeKey, encodeKey } from "./store-crypto";

/** The SENDER's half of the pair-room completion contract.
 *
 *  A pre-upload's finalize carries the verifier derived from the file key that
 *  encrypted it, so the receiver — which is handed that key over the peers' own
 *  channel — can later prove it has the file and let the server release the
 *  ciphertext. Nothing here posts a completion: the receiver's side is the next
 *  checkpoint, and the objects this produces simply keep the lifetime they
 *  already had until it lands.
 *
 *  What these tests pin is the two things that would silently break it: sending
 *  the wrong value (a proof instead of a verifier, or a verifier for a different
 *  key), and sending one at all on an upload that is not a pre-upload. */

/** A fetch double for the resumable endpoints that records the finalize body. */
function installFinalizeCapture() {
  const seen = { finalizeBody: undefined as string | undefined, finalized: false };
  let received = 0;
  const json = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.startsWith("/api/uploads?")) return json({ uploadId: "u1", chunkSize: 1 << 20 });
      if (method === "POST" && url.endsWith("/finalize")) {
        seen.finalized = true;
        seen.finalizeBody = init?.body === undefined || init?.body === null ? undefined : String(init.body);
        return json({ id: "id1", expiresAt: 123 });
      }
      if (method === "PATCH" && url === "/api/uploads/u1") {
        const buf = new Uint8Array(await new Response(init!.body as BodyInit).arrayBuffer());
        received += buf.length;
        return json({ received });
      }
      if (method === "GET" && url === "/api/uploads/u1") return json({ received });
      throw new Error(`unexpected ${method} ${url}`);
    }),
  );
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

const file = () => new File([new Uint8Array(64).fill(7)], "a.bin");

describe("pair-room finalize carries a completion verifier", () => {
  it("sends the verifier derived from the object's own file key", async () => {
    const seen = installFinalizeCapture();
    const res = await uploadFileResumable([file()], { purpose: "pair_room", code: "483920" });

    expect(seen.finalized).toBe(true);
    expect(seen.finalizeBody).toBeDefined();
    const body = JSON.parse(seen.finalizeBody!);
    // The value must be the verifier for the key the caller was handed back —
    // not a proof, and not a verifier for some other key. A mismatch here is
    // invisible until a real receiver tries to complete and gets a 403.
    const expected = encodeKey(await completionVerifier(decodeKey(res.key)));
    expect(body.completionVerifier).toBe(expected);
  });

  it("sends it as unpadded base64url, which is what the server accepts", async () => {
    const seen = installFinalizeCapture();
    await uploadFileResumable([file()], { purpose: "pair_room", code: "483920" });
    const v = JSON.parse(seen.finalizeBody!).completionVerifier as string;
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  // The verifier is the sender's promise about ONE object, so two files in the
  // same batch must not finalize with the same one — that would let either
  // file's key end both.
  it("derives a different verifier per uploaded object", async () => {
    const seen1 = installFinalizeCapture();
    await uploadFileResumable([file()], { purpose: "pair_room", code: "483920" });
    const first = JSON.parse(seen1.finalizeBody!).completionVerifier;
    vi.unstubAllGlobals();
    const seen2 = installFinalizeCapture();
    await uploadFileResumable([file()], { purpose: "pair_room", code: "483920" });
    expect(JSON.parse(seen2.finalizeBody!).completionVerifier).not.toBe(first);
  });

  // A share has no completion lifecycle, and the server refuses a verifier on
  // one with a 400. Sending an ordinary upload's finalize byte-for-byte as it
  // always was is what keeps this change additive.
  it("sends no body at all for a share upload", async () => {
    const seen = installFinalizeCapture();
    await uploadFileResumable([file()], { burnAfterRead: false, ttl: 3600 });
    expect(seen.finalized).toBe(true);
    expect(seen.finalizeBody).toBeUndefined();
  });

  it("sends no body at all for a device-task upload", async () => {
    const seen = installFinalizeCapture();
    await uploadFileResumable([file()], { burnAfterRead: false, ttl: 3600, purpose: "device_task" });
    expect(seen.finalizeBody).toBeUndefined();
  });
});
