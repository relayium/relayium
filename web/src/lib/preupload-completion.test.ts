import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { completeStoredObject, InvalidStoredObjectIdError, uploadFileResumable } from "./stored-file";
import { completionProof, completionVerifier, decodeKey, encodeKey } from "./store-crypto";

/** BOTH halves of the pair-room completion contract, as the Web speaks them.
 *
 *  A pre-upload's finalize carries the verifier derived from the file key that
 *  encrypted it, so the receiver — which is handed that key over the peers' own
 *  channel — can later prove it has the file and let the server release the
 *  ciphertext. The first half below is the sender recording the capability; the
 *  second is the receiver spending it.
 *
 *  What these tests pin on the sender's side is the two things that would
 *  silently break it: sending the wrong value (a proof instead of a verifier, or
 *  a verifier for a different key), and sending one at all on an upload that is
 *  not a pre-upload. On the receiver's side it is the request's SHAPE (a body,
 *  never a URL — this is a bearer capability to delete an object) and the status
 *  contract, whose four outcomes mean four different things to a caller deciding
 *  whether to try again. */

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
    await uploadFileResumable([file()], {
      burnAfterRead: false,
      ttl: 3600,
      purpose: "device_task",
      // A Device Inbox delivery seals its own frame-0 document, and the upload
      // path refuses the purpose without one — the shared manifest is exactly
      // what its v2 receiver would refuse as `verify_failed`. Irrelevant to what
      // this test is about, which is the FINALIZE body, but it is what makes a
      // delivery upload reachable at all.
      sealedManifest: new TextEncoder().encode('{"v":2,"items":[{"kind":"file","name":"a.txt","size":3}]}'),
    });
    expect(seen.finalizeBody).toBeUndefined();
  });
});

// --- the RECEIVER's half: spending the capability ---------------------------

/** A fetch double for POST /api/files/{id}/complete that records the whole
 *  request — URL included, because "the proof is never in a URL" is one of the
 *  two things this endpoint's shape has to guarantee. */
function installCompleteCapture(reply: { status?: number; throws?: unknown } = {}) {
  const seen = {
    calls: [] as { url: string; method: string; body: string | undefined; headers: unknown; signal?: AbortSignal }[],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      seen.calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body == null ? undefined : String(init.body),
        headers: init?.headers,
        signal: init?.signal ?? undefined,
      });
      if (reply.throws) throw reply.throws;
      const status = reply.status ?? 204;
      return { ok: status >= 200 && status < 300, status } as unknown as Response;
    }),
  );
  return seen;
}

const aProof = async () => completionProof(decodeKey(encodeKey(new Uint8Array(32).fill(3))));

describe("posting a completion", () => {
  it("puts the proof in the BODY of POST /api/files/{id}/complete, never in the URL", async () => {
    // The proof is a bearer capability to DELETE an object. A URL is recorded by
    // every proxy and access log between here and the server, so a query-string
    // spelling of this request would hand that capability to anyone who reads one.
    const seen = installCompleteCapture();
    const proof = await aProof();

    expect(await completeStoredObject("obj1", proof)).toBe("completed");

    expect(seen.calls).toHaveLength(1);
    const call = seen.calls[0];
    expect(call.method).toBe("POST");
    expect(call.url).toBe("/api/files/obj1/complete");
    const encoded = encodeKey(proof);
    expect(call.url).not.toContain(encoded);
    expect(JSON.parse(call.body!)).toEqual({ proof: encoded });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]{43}$/); // unpadded base64url, 32 bytes
  });

  it("declares a JSON body, which is what the server decodes", async () => {
    const seen = installCompleteCapture();
    await completeStoredObject("obj1", await aProof());
    expect(new Headers(seen.calls[0].headers as HeadersInit).get("content-type")).toBe("application/json");
  });

  it("reads 204 as completed — the object is gone, or there was nothing to end", async () => {
    // The server answers 204 for four situations on purpose (already completed,
    // never existed, not a pair-room object, and a real completion), so that an
    // unauthenticated endpoint is not an existence oracle. A caller must treat
    // all four the same: there is nothing left to do.
    installCompleteCapture({ status: 204 });
    expect(await completeStoredObject("obj1", await aProof())).toBe("completed");
  });

  it("reads 409 as an older sender, not as a failure to retry", async () => {
    // A live pair-room object with no completion capability at all. No proof
    // this receiver can ever derive will work on it, so retrying is a loop with
    // a guaranteed end state — and reporting it as an error would be false too.
    installCompleteCapture({ status: 409 });
    expect(await completeStoredObject("obj1", await aProof())).toBe("unsupported");
  });

  it("reads 403 as refused — the proof was wrong and nothing was deleted", async () => {
    installCompleteCapture({ status: 403 });
    expect(await completeStoredObject("obj1", await aProof())).toBe("refused");
  });

  it("reads 400 as refused: a malformed body is not a transient condition", async () => {
    installCompleteCapture({ status: 400 });
    expect(await completeStoredObject("obj1", await aProof())).toBe("refused");
  });

  it("reads an unspecified 4xx as refused rather than guessing it is retryable", async () => {
    installCompleteCapture({ status: 404 });
    expect(await completeStoredObject("obj1", await aProof())).toBe("refused");
  });

  it("reads 5xx as retryable", async () => {
    installCompleteCapture({ status: 503 });
    expect(await completeStoredObject("obj1", await aProof())).toBe("retry");
  });

  it("reads 429 as retryable — the per-IP budget refills", async () => {
    installCompleteCapture({ status: 429 });
    expect(await completeStoredObject("obj1", await aProof())).toBe("retry");
  });

  it("reads a network failure as retryable", async () => {
    installCompleteCapture({ throws: new TypeError("Failed to fetch") });
    expect(await completeStoredObject("obj1", await aProof())).toBe("retry");
  });

  it("refuses an id that is not one inert path token, without making a request", async () => {
    const seen = installCompleteCapture();
    await expect(completeStoredObject("../secrets", await aProof())).rejects.toBeInstanceOf(
      InvalidStoredObjectIdError,
    );
    expect(seen.calls).toHaveLength(0);
  });

  it("refuses a proof that is not 32 bytes, without making a request", async () => {
    // A short proof is not a weaker credential, it is a malformed one — and
    // sending it would spend this receiver's rate budget on a guaranteed 400.
    const seen = installCompleteCapture();
    await expect(completeStoredObject("obj1", new Uint8Array(31))).rejects.toThrow();
    expect(seen.calls).toHaveLength(0);
  });

  it("hands the caller's signal to fetch, and makes no request at all once aborted", async () => {
    const seen = installCompleteCapture();
    const live = new AbortController();
    await completeStoredObject("obj1", await aProof(), live.signal);
    expect(seen.calls[0].signal).toBe(live.signal);

    const dead = new AbortController();
    dead.abort();
    // A room that is already over must not cost the server a request — and must
    // not come back as "completed" either, which would let a caller record a
    // completion that never happened.
    await expect(completeStoredObject("obj1", await aProof(), dead.signal)).rejects.toThrow();
    expect(seen.calls).toHaveLength(1);
  });

  it("never persists the capability anywhere", () => {
    // A source guard, and it has to be one: "this value was never written down"
    // is a property of every line that could have written it, not of any call a
    // test can make. The proof deletes an object and the key opens it; either
    // one surviving a tab close, or landing in a console a user pastes into a
    // bug report, is a capability handed to whoever reads it next.
    for (const file of ["stored-file.ts", "preupload-receive.svelte.ts", "store-crypto.ts"]) {
      const src = readFileSync(join(import.meta.dirname, file), "utf8");
      for (const sink of ["localStorage", "sessionStorage", "document.cookie", "indexedDB"]) {
        expect(src, `${file} must not persist anything: ${sink}`).not.toContain(sink);
      }
      // Every console call, with its string literals removed so a message that
      // merely SAYS "proof" is not mistaken for one that logs a proof.
      for (const call of src.match(/console\.\w+\([^;]*?\);/gs) ?? []) {
        const withoutText = call.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '""');
        expect(withoutText, `${file}: a console call may not carry a proof or a key`)
          .not.toMatch(/\b(proof|key|raw)\b/i);
      }
    }
  });

  it("reports a cancellation as an abort, never as a retryable network fault", async () => {
    // The two are told apart by every caller that has to decide whether to try
    // again: a cancelled room must stop, not queue another attempt.
    const ctrl = new AbortController();
    installCompleteCapture({ throws: new DOMException("aborted", "AbortError") });
    ctrl.abort();
    const err = await completeStoredObject("obj1", await aProof(), ctrl.signal).catch((e) => e);
    expect((err as Error).name).toBe("AbortError");
  });
});
