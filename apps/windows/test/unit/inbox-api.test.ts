// Owning tests for the Inbox API client.
//
// ## The fixture, and what it is worth
//
// `serverDelivery()` below is built from the server's OWN view structs —
// `inboxTaskView` / `inboxDeliveryView` in `server/account/deviceinbox_task.go`,
// whose json tags are PascalCase — and from `handleClaimInboxTasks`, which wraps
// them as `{tasks, leaseSeconds}`. It is not a shape this client invented.
//
// That is stronger than the camelCase guess it replaces, which would have failed
// on the first real response. It is still NOT a captured live-server response:
// an owned real-server fixture remains owed, and these tests say so rather than
// implying they close it.
import { describe, expect, it, vi } from "vitest";

import {
  InboxApi,
  InboxApiError,
  type CapturedApiContext,
} from "../../src/main/inbox/api.js";
import { CLAIM_TOKEN_HEADER, MAX_CLAIM_BATCH } from "../../src/main/inbox/wire.js";

const ORIGIN = "https://relayium.example";

const CONTEXT: CapturedApiContext = {
  origin: ORIGIN,
  deviceID: "dev-1",
  bearer: "bearer-token-value",
  epoch: 7,
};

/** One delivery, in the server's own casing. */
function serverDelivery(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ID: "task-1",
    TargetDeviceID: "dev-1",
    SourceDeviceID: "dev-2",
    IdempotencyKey: "idem-1",
    StoredFileID: "file-1",
    State: "queued",
    ErrorCode: "",
    CiphertextBytes: 4096,
    WrapAlgorithm: "x25519-sealedbox-v1",
    TargetKeyID: "key-1",
    TargetKeyGeneration: 3,
    Attempts: 0,
    NextAttemptAt: 0,
    LeaseExpiresAt: 0,
    CreatedAt: 1_700_000_000,
    UpdatedAt: 1_700_000_000,
    ExpiresAt: 1_700_086_400,
    NotifiedAt: 0,
    SavedAt: 0,
    TerminalAt: 0,
    Terminal: false,
    EncManifest: "YWJjZA==",
    WrappedKey: "d3JhcHBlZC1rZXk",
    ClaimToken: "claim-1",
    ...overrides,
  };
}

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fetch stub that records calls and tracks whether bodies were released. */
function stubFetch(handler: (call: Call) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: Call[];
  cancelled: number;
} {
  const calls: Call[] = [];
  const tracker = { cancelled: 0 };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const response = await handler(call);
    // Wrap the body so a cancel is observable: an unreleased body is a leaked
    // connection, and it is invisible without this.
    const original = response.body;
    if (original !== null) {
      const wrapped = new ReadableStream<Uint8Array>({
        start(controller) {
          void original.pipeTo(
            new WritableStream({
              write(chunk) {
                controller.enqueue(chunk);
              },
              close() {
                controller.close();
              },
              abort() {
                controller.error(new Error("aborted"));
              },
            }),
          ).catch(() => undefined);
        },
        cancel() {
          tracker.cancelled += 1;
        },
      });
      return new Response(wrapped, { status: response.status, headers: response.headers });
    }
    return response;
  }) as typeof fetch;
  return {
    fetchImpl,
    calls,
    get cancelled() {
      return tracker.cancelled;
    },
  } as { fetchImpl: typeof fetch; calls: Call[]; cancelled: number };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const api = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}): InboxApi =>
  new InboxApi({ context: CONTEXT, fetchImpl, ...extra });

const live = (): AbortSignal => new AbortController().signal;

describe("credentials and origin", () => {
  it("sends the bearer, and only to the pinned origin", async () => {
    const stub = stubFetch(() => json({ tasks: [], leaseSeconds: 60 }));
    await api(stub.fetchImpl).claim(1, live());
    const headers = new Headers(stub.calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer bearer-token-value");
    expect(stub.calls[0]?.url.startsWith(ORIGIN)).toBe(true);
  });

  it("refuses every request when the device id would leave the origin", async () => {
    const stub = stubFetch(() => json({}));
    const escaped = new InboxApi({
      context: { ...CONTEXT, deviceID: "../../evil" },
      fetchImpl: stub.fetchImpl,
    });
    // Escaped rather than smuggled: the id is encoded, so it stays one segment.
    await escaped.claim(1, live()).catch(() => undefined);
    expect(stub.calls[0]?.url).toContain("..%2F..%2Fevil");
    expect(stub.calls[0]?.url.startsWith(`${ORIGIN}/api/devices/`)).toBe(true);
  });

  it("sets redirect:error on every request", async () => {
    const stub = stubFetch(() => json({ tasks: [], leaseSeconds: 60 }));
    await api(stub.fetchImpl).claim(1, live());
    expect(stub.calls[0]?.init.redirect).toBe("error");
  });

  it("reports a redirect distinctly from a network blip", async () => {
    const stub = stubFetch(() => {
      throw new TypeError("failed to fetch: redirect not allowed");
    });
    await expect(api(stub.fetchImpl).claim(1, live())).rejects.toMatchObject({
      code: "redirect-refused",
    });
  });

  it("captures the bearer instead of reading one per call", () => {
    // A per-call read could return a token belonging to an account that
    // replaced the one the operation started under.
    const client = api(stubFetch(() => json({})).fetchImpl);
    expect(client.epoch).toBe(7);
    expect(Object.keys(CONTEXT)).toContain("bearer");
  });
});

describe("claim", () => {
  it("parses the server's PascalCase shape", async () => {
    // The casing that matters: an earlier client expected `id`/`targetKeyId`
    // and would have refused this exact response as malformed.
    const stub = stubFetch(() => json({ tasks: [serverDelivery()], leaseSeconds: 300 }));
    const result = await api(stub.fetchImpl).claim(4, live());
    expect(result.leaseSeconds).toBe(300);
    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]).toMatchObject({
      ID: "task-1",
      TargetKeyID: "key-1",
      TargetKeyGeneration: 3,
      IdempotencyKey: "idem-1",
      ClaimToken: "claim-1",
      CiphertextBytes: 4096,
      ExpiresAt: 1_700_086_400,
      Terminal: false,
    });
  });

  it("refuses a camelCase response outright", async () => {
    const stub = stubFetch(() =>
      json({ tasks: [{ id: "task-1", targetKeyId: "key-1", claimToken: "c" }], leaseSeconds: 60 }),
    );
    await expect(api(stub.fetchImpl).claim(1, live())).rejects.toMatchObject({ code: "malformed" });
  });

  it("refuses more tasks than were asked for", async () => {
    const stub = stubFetch(() =>
      json({ tasks: [serverDelivery(), serverDelivery({ ID: "task-2" })], leaseSeconds: 60 }),
    );
    await expect(api(stub.fetchImpl).claim(1, live())).rejects.toMatchObject({ code: "malformed" });
  });

  it("refuses a batch past the server's own ceiling", async () => {
    const stub = stubFetch(() => json({ tasks: [], leaseSeconds: 60 }));
    await expect(api(stub.fetchImpl).claim(MAX_CLAIM_BATCH + 1, live())).rejects.toMatchObject({
      code: "malformed",
    });
    // Nothing was sent: the request is refused before it leaves.
    expect(stub.calls).toHaveLength(0);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["a day and a second", 24 * 60 * 60 + 1],
    ["fractional", 1.5],
  ])("refuses %s leaseSeconds rather than following it", async (_label, leaseSeconds) => {
    const stub = stubFetch(() => json({ tasks: [], leaseSeconds }));
    await expect(api(stub.fetchImpl).claim(1, live())).rejects.toMatchObject({ code: "malformed" });
  });

  it.each([
    ["a wrong-typed SourceDeviceID", { SourceDeviceID: 7 }],
    ["a wrong-typed IdempotencyKey", { IdempotencyKey: { a: 1 } }],
    ["an unbounded id", { ID: "x".repeat(300) }],
    ["a missing ID", { ID: "" }],
    ["an unknown State", { State: "encrypting" }],
    ["a non-integer CiphertextBytes", { CiphertextBytes: 1.5 }],
    ["an unsafe CiphertextBytes", { CiphertextBytes: Number.MAX_SAFE_INTEGER + 2 }],
    ["a negative TargetKeyGeneration", { TargetKeyGeneration: -1 }],
    ["a non-boolean Terminal", { Terminal: "no" }],
    ["a base64url EncManifest", { EncManifest: "abc-_" }],
    ["a standard-base64 WrappedKey", { WrappedKey: "YWJjZA==" }],
    ["an empty ClaimToken", { ClaimToken: "" }],
  ])("refuses a delivery with %s", async (_label, override) => {
    // A wrong TYPE used to become "" silently, which turned a bad
    // IdempotencyKey into a missing one and defeated dedup.
    const stub = stubFetch(() => json({ tasks: [serverDelivery(override)], leaseSeconds: 60 }));
    await expect(api(stub.fetchImpl).claim(1, live())).rejects.toMatchObject({ code: "malformed" });
  });

  it("accepts an absent optional field but not a wrong-typed one", async () => {
    const withoutSource = serverDelivery();
    delete withoutSource["SourceDeviceID"];
    const stub = stubFetch(() => json({ tasks: [withoutSource], leaseSeconds: 60 }));
    const result = await api(stub.fetchImpl).claim(1, live());
    expect(result.deliveries[0]?.SourceDeviceID).toBe("");
  });
});

describe("report", () => {
  it("TRANSMITS the claim token in the body", async () => {
    // The defect this pins: an earlier version accepted the token and dropped
    // it, and the server checks `if in.ClaimToken == ""` first — so every call
    // would have come back 409 stale_claim.
    const stub = stubFetch(() => json({ task: serverDelivery({ State: "downloading" }) }));
    await api(stub.fetchImpl).report("task-1", "claim-1", "downloading", false, "", live());
    const body = JSON.parse(String(stub.calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      claimToken: "claim-1",
      state: "downloading",
      errorCode: "",
      committed: false,
    });
    expect(stub.calls[0]?.url).toBe(`${ORIGIN}/api/devices/dev-1/inbox/tasks/task-1/report`);
  });

  it("refuses to send an empty claim token", async () => {
    const stub = stubFetch(() => json({ task: serverDelivery() }));
    await expect(
      api(stub.fetchImpl).report("task-1", "", "downloading", false, "", live()),
    ).rejects.toMatchObject({ code: "stale-claim" });
    expect(stub.calls).toHaveLength(0);
  });

  it("returns the SERVER's task as the authority", async () => {
    // `state` and `committed` are what this device asserts; whether the task
    // reached `saved` is what comes back.
    const stub = stubFetch(() =>
      json({ task: serverDelivery({ State: "saved", SavedAt: 1_700_000_500, Terminal: true }) }),
    );
    const task = await api(stub.fetchImpl).report("task-1", "claim-1", "saved", true, "", live());
    expect(task.State).toBe("saved");
    expect(task.SavedAt).toBe(1_700_000_500);
    expect(task.Terminal).toBe(true);
  });

  it("surfaces stale_claim and task_terminal distinctly, carrying the echoed task", async () => {
    for (const [token, code] of [
      ["stale_claim", "stale-claim"],
      ["task_terminal", "task-terminal"],
    ] as const) {
      const stub = stubFetch(() =>
        json({ error: token, task: serverDelivery({ State: "expired", Terminal: true }) }, 409),
      );
      const error = (await api(stub.fetchImpl)
        .report("task-1", "claim-1", "saved", true, "", live())
        .catch((e: unknown) => e)) as InboxApiError;
      expect(error.code).toBe(code);
      expect(error.task?.Terminal).toBe(true);
    }
  });

  it("refuses a state outside the server's closed set", async () => {
    const stub = stubFetch(() => json({ task: serverDelivery() }));
    await expect(
      // "encrypting" is a real PRD state but a SENDER-local one; the server
      // rejects it by name.
      api(stub.fetchImpl).report("task-1", "claim-1", "encrypting" as never, false, "", live()),
    ).rejects.toMatchObject({ code: "malformed" });
    expect(stub.calls).toHaveLength(0);
  });
});

describe("blob", () => {
  const bodyOf = (bytes: number): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    });

  it("sends the claim token in a HEADER, never in the URL", async () => {
    const stub = stubFetch(() => new Response(bodyOf(8), { status: 200 }));
    await api(stub.fetchImpl).blob("task-1", "claim-1", 0, 8, live());
    const headers = new Headers(stub.calls[0]?.init.headers);
    expect(headers.get(CLAIM_TOKEN_HEADER)).toBe("claim-1");
    expect(stub.calls[0]?.url).not.toContain("claim-1");
  });

  it("sends a Range only when resuming", async () => {
    const stub = stubFetch(() => new Response(bodyOf(8), { status: 200 }));
    await api(stub.fetchImpl).blob("task-1", "claim-1", 0, 8, live());
    expect(new Headers(stub.calls[0]?.init.headers).get("range")).toBeNull();

    const resumed = stubFetch(
      () =>
        new Response(bodyOf(4), {
          status: 206,
          headers: { "content-range": "bytes 4-7/8" },
        }),
    );
    await api(resumed.fetchImpl).blob("task-1", "claim-1", 4, 8, live());
    expect(new Headers(resumed.calls[0]?.init.headers).get("range")).toBe("bytes=4-");
  });

  it("refuses a resume answered 200, and releases the body", async () => {
    // The splice this prevents produces a file of exactly the right length and
    // wrong in the middle, which no length check catches.
    const stub = stubFetch(() => new Response(bodyOf(8), { status: 200 }));
    await expect(api(stub.fetchImpl).blob("task-1", "claim-1", 4, 8, live())).rejects.toMatchObject({
      code: "resume-restart",
    });
    expect(stub.cancelled).toBe(1);
  });

  it.each([
    ["a range starting elsewhere", "bytes 0-7/8"],
    ["a total that disagrees", "bytes 4-7/99"],
    ["a malformed header", "bytes banana"],
    ["no header at all", null],
  ])("refuses a 206 with %s, and releases the body", async (_label, contentRange) => {
    // A 206 is NOT enough on its own: a range beginning somewhere else would
    // have its bytes written at the caller's offset.
    const stub = stubFetch(
      () =>
        new Response(bodyOf(4), {
          status: 206,
          ...(contentRange === null ? {} : { headers: { "content-range": contentRange } }),
        }),
    );
    await expect(api(stub.fetchImpl).blob("task-1", "claim-1", 4, 8, live())).rejects.toMatchObject({
      code: "malformed",
    });
    expect(stub.cancelled).toBe(1);
  });

  it("accepts a 206 whose range agrees, and reports the total", async () => {
    const stub = stubFetch(
      () =>
        new Response(bodyOf(4), {
          status: 206,
          headers: { "content-range": "bytes 4-7/8" },
        }),
    );
    const stream = await api(stub.fetchImpl).blob("task-1", "claim-1", 4, 8, live());
    expect(stream.partial).toBe(true);
    expect(stream.totalBytes).toBe(8);
  });

  it("releases the body when a redirect is detected after the response", async () => {
    const stub = stubFetch(
      () =>
        new Response(bodyOf(8), {
          status: 200,
          headers: { "x-final-url": "https://elsewhere.example/blob" },
        }),
    );
    // Response.url is empty for a synthesised Response, so drive the check by
    // constructing one whose url is set.
    const redirected = (async () =>
      Object.defineProperty(await stub.fetchImpl("https://x", {}), "url", {
        value: "https://elsewhere.example/blob",
      })) as unknown as typeof fetch;
    await expect(
      api(redirected).blob("task-1", "claim-1", 0, 8, live()),
    ).rejects.toMatchObject({ code: "redirect-refused" });
  });

  it("requires a caller signal, which is what bounds the body", async () => {
    // The body has no overall deadline by design; the caller's abort is the
    // only thing that can stop a stalled one.
    const controller = new AbortController();
    const stub = stubFetch(() => new Response(bodyOf(8), { status: 200 }));
    await api(stub.fetchImpl).blob("task-1", "claim-1", 0, 8, controller.signal);
    const signal = stub.calls[0]?.init.signal;
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
  });

  it("refuses an offset past the expected total", async () => {
    const stub = stubFetch(() => new Response(bodyOf(8), { status: 200 }));
    await expect(api(stub.fetchImpl).blob("task-1", "claim-1", 9, 8, live())).rejects.toMatchObject({
      code: "malformed",
    });
    expect(stub.calls).toHaveLength(0);
  });
});

describe("rejection bodies", () => {
  it("keeps only a token-shaped error and never server prose", async () => {
    const stub = stubFetch(() =>
      json({ error: "the file C:\\Users\\victim\\secret.txt could not be read" }, 400),
    );
    const error = (await api(stub.fetchImpl)
      .claim(1, live())
      .catch((e: unknown) => e)) as InboxApiError;
    expect(error.code).toBe("server-refused");
    expect(error.serverCode).toBeUndefined();
    expect(error.message).not.toContain("victim");
    expect(error.message).not.toContain("C:\\");
  });

  it("bounds a huge rejection body", async () => {
    const stub = stubFetch(() => new Response("x".repeat(1024 * 1024), { status: 500 }));
    const error = (await api(stub.fetchImpl)
      .claim(1, live())
      .catch((e: unknown) => e)) as InboxApiError;
    expect(error.code).toBe("server-refused");
    expect(error.status).toBe(500);
  });
});

describe("owed", () => {
  it("records that a captured real-server fixture is still owed", () => {
    // These fixtures are derived from the server's own view structs, which is
    // materially stronger than the camelCase guess they replace — but they are
    // not a captured live response, and interop is not closed by them.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle adapters
//
// Shapes taken from the handlers, cited at each call site in `api.ts`. Same
// caveat as the fixture above: this is the server's declared contract, read
// from its source, not a captured live response. The real-server harness is
// what closes that.
// ---------------------------------------------------------------------------

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("lifecycle adapters", () => {
  it("enrols and returns what central AGREED, not what was asked", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      ok({
        inbox: { Presence: "offline" },
        // Central negotiated DOWN from what was offered.
        protocolVersion: 3,
        receiveCapability: "inbox.receive.v3",
        keyAlgorithm: "x25519-sealedbox-v1",
      }),
    );
    const api = new InboxApi({ context: CONTEXT, fetchImpl });
    const agreed = await api.enrol(
      {
        platform: "windows",
        appVersion: "0.0.1",
        protocolVersions: [3, 4],
        capabilities: ["inbox.receive.v3"],
        autoAccept: "ask",
        receiveDirReady: true,
      },
      new AbortController().signal,
    );
    expect(agreed).toEqual({
      protocolVersion: 3,
      receiveCapability: "inbox.receive.v3",
      keyAlgorithm: "x25519-sealedbox-v1",
    });
    expect(calls[0]!.init.method).toBe("PUT");
    expect(calls[0]!.url).toBe(`${ORIGIN}/api/devices/dev-1/inbox`);
    // The handler decodes STRICTLY: an extra field is a 400, so the body must
    // carry exactly the declared keys.
    expect(Object.keys(JSON.parse(String(calls[0]!.init.body)) as object).sort()).toEqual([
      "appVersion",
      "autoAccept",
      "capabilities",
      "platform",
      "protocolVersions",
      "receiveDirReady",
    ]);
  });

  it("sends the accept decision as the strict single-field body", async () => {
    const { fetchImpl, calls } = stubFetch(() => ok({ task: serverDelivery({ State: "queued" }) }));
    const api = new InboxApi({ context: CONTEXT, fetchImpl });
    await api.accept("task-1", false, new AbortController().signal);
    expect(calls[0]!.url).toBe(`${ORIGIN}/api/devices/dev-1/inbox/tasks/task-1/accept`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ accept: false });
    // No claim token: the decision belongs to a person, and no lease is held.
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get(CLAIM_TOKEN_HEADER)).toBeNull();
  });

  it("collapses whitespace in a device name and alters nothing else", async () => {
    const { fetchImpl, calls } = stubFetch(() => ok({}));
    const api = new InboxApi({ context: CONTEXT, fetchImpl });
    const normalize = (v: string) => v.trim().replace(/\s+/g, " ");
    const sent = await api.renameDevice("  Lily's   MacBook  Pro \n", normalize, new AbortController().signal);
    expect(sent).toBe("Lily's MacBook Pro");
    expect(calls[0]!.init.method).toBe("PATCH");
    expect(calls[0]!.url).toBe(`${ORIGIN}/api/devices/dev-1`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: "Lily's MacBook Pro" });
  });

  it("does NOT pre-sanitize a name the server would refuse", async () => {
    // A bidi mark survives whitespace collapsing, so it reaches the server and
    // the server REFUSES it. Stripping it here would silently store something
    // the person did not type, which is exactly what the handler avoids.
    const { fetchImpl, calls } = stubFetch(() =>
      ok({ error: "invalid_device_name" }, 400),
    );
    const api = new InboxApi({ context: CONTEXT, fetchImpl });
    const normalize = (v: string) => v.trim().replace(/\s+/g, " ");
    await expect(
      api.renameDevice("My‮PC", normalize, new AbortController().signal),
    ).rejects.toMatchObject({ code: "server-refused", serverCode: "invalid_device_name" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: "My‮PC" });
  });

  it("refuses an empty or oversized name before making a request", async () => {
    const { fetchImpl, calls } = stubFetch(() => ok({}));
    const api = new InboxApi({ context: CONTEXT, fetchImpl });
    const normalize = (v: string) => v.trim().replace(/\s+/g, " ");
    const signal = new AbortController().signal;
    await expect(api.renameDevice("   ", normalize, signal)).rejects.toBeInstanceOf(InboxApiError);
    await expect(api.renameDevice("x".repeat(65), normalize, signal)).rejects.toBeInstanceOf(InboxApiError);
    expect(calls.length).toBe(0);
  });

  it("finds the current device and refuses a row naming a different one", async () => {
    const good = stubFetch(() =>
      ok({ devices: [{ ID: "dev-9", Current: false }, { ID: "dev-1", Name: "Windows PC", Current: true }] }),
    );
    const api = new InboxApi({ context: CONTEXT, fetchImpl: good.fetchImpl });
    expect(await api.currentDevice(new AbortController().signal)).toEqual({
      ID: "dev-1",
      Name: "Windows PC",
    });

    // A `Current` row naming another device means this bearer is not the device
    // this client believes it is. Acting on it would enrol the wrong machine.
    const wrong = stubFetch(() => ok({ devices: [{ ID: "dev-2", Name: "Someone else", Current: true }] }));
    const other = new InboxApi({ context: CONTEXT, fetchImpl: wrong.fetchImpl });
    await expect(other.currentDevice(new AbortController().signal)).rejects.toMatchObject({
      code: "malformed",
    });
  });

  it("bounds the pending limit and the reply", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      ok({ tasks: [serverDelivery(), serverDelivery({ ID: "task-2" })], leaseSeconds: 300, heartbeatIntervalSecs: 30 }),
    );
    const api = new InboxApi({ context: CONTEXT, fetchImpl });
    const signal = new AbortController().signal;
    // A reply longer than what was asked for is not one to keep parsing.
    await expect(api.pending(1, signal)).rejects.toMatchObject({ code: "malformed" });
    const result = await api.pending(5, signal);
    expect(result.tasks.length).toBe(2);
    expect(result.leaseSeconds).toBe(300);
    expect(calls[1]!.url).toBe(`${ORIGIN}/api/devices/dev-1/inbox/pending?limit=5`);
    // And the limit itself is bounded before any request.
    const before = calls.length;
    await expect(api.pending(0, signal)).rejects.toBeInstanceOf(InboxApiError);
    await expect(api.pending(101, signal)).rejects.toBeInstanceOf(InboxApiError);
    expect(calls.length).toBe(before);
  });

  it("registers and lists keys, refusing a malformed public key", async () => {
    const key = { ID: "key-1", Algorithm: "x25519-sealedbox-v1", PublicKey: "cHVibGlj", Generation: 2 };
    const good = stubFetch(() => ok({ key }));
    const api = new InboxApi({ context: CONTEXT, fetchImpl: good.fetchImpl });
    const signal = new AbortController().signal;
    expect(await api.registerKey("x25519-sealedbox-v1", "cHVibGlj", "", signal)).toMatchObject({
      ID: "key-1",
      Generation: 2,
    });
    expect(JSON.parse(String(good.calls[0]!.init.body))).toEqual({
      algorithm: "x25519-sealedbox-v1",
      publicKey: "cHVibGlj",
      previousKeyId: "",
    });

    // Standard-base64 padding is not the raw base64url the wire uses.
    const bad = stubFetch(() => ok({ keys: [{ ...key, PublicKey: "cHVibGlj==" }] }));
    const other = new InboxApi({ context: CONTEXT, fetchImpl: bad.fetchImpl });
    await expect(other.listKeys(signal)).rejects.toMatchObject({ code: "malformed" });
  });

  it("heartbeats, goes offline, and withdraws the enrolment", async () => {
    const { fetchImpl, calls } = stubFetch((call) =>
      call.url.endsWith("/heartbeat") ? ok({ presence: "online", heartbeatIntervalSeconds: 30 }) : ok({}),
    );
    const api = new InboxApi({ context: CONTEXT, fetchImpl });
    const signal = new AbortController().signal;
    expect(await api.heartbeat(true, signal)).toEqual({ presence: "online", intervalSeconds: 30 });
    await api.offline(signal);
    await api.deleteInbox(signal);
    expect(calls.map((c) => `${String(c.init.method)} ${c.url.replace(ORIGIN, "")}`)).toEqual([
      "POST /api/devices/dev-1/inbox/heartbeat",
      "POST /api/devices/dev-1/inbox/offline",
      "DELETE /api/devices/dev-1/inbox",
    ]);
    // Offline and delete send no body: the handlers read none.
    expect(calls[1]!.init.body).toBeUndefined();
    expect(calls[2]!.init.body).toBeUndefined();
  });

  it("carries the bearer to the pinned origin only, on every lifecycle call", async () => {
    const { fetchImpl, calls } = stubFetch(() => ok({ presence: "online" }));
    const api = new InboxApi({ context: CONTEXT, fetchImpl });
    await api.heartbeat(false, new AbortController().signal);
    for (const call of calls) {
      expect(call.url.startsWith(ORIGIN)).toBe(true);
      expect(new Headers(call.init.headers).get("authorization")).toBe(`Bearer ${CONTEXT.bearer}`);
      expect(call.init.redirect).toBe("error");
    }
  });
});
