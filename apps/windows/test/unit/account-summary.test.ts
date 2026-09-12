// The account client: what it parses, what it refuses, and what it never sends.
//
// Most cases run against a REAL loopback server rather than a stubbed `fetch`,
// because half of what is under test is HTTP behaviour — a redirect, a body that
// keeps coming, a response held open while the caller aborts. A stub would agree
// with whatever this module assumed.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  AccountApiError,
  AccountClient,
  MAX_DEVICE_NAME_RUNES,
  MAX_DEVICE_ROWS,
  type CapturedAccountContext,
} from "../../src/main/account/summary.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

/** A loopback origin, and the requests it actually received. */
async function serve(
  handler: (seen: Seen, respond: (status: number, body?: string, headers?: Record<string, string>) => void) => void,
): Promise<{ origin: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const record: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(record);
      handler(record, (status, body, headers) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(body ?? "");
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, seen };
}

const context = (origin: string, epoch = 1): CapturedAccountContext => ({
  origin,
  bearer: "rlm_cli_secret_value",
  epoch,
});

const ME = {
  user: {
    id: "u1", email: "a@b.c", displayName: "A", hasPassword: true, emailVerified: true,
    linkedMethods: ["password", "apple"], onlyOwnNodes: false,
    planId: "max", subscriptionStatus: "active", subscriptionEnd: 1789000000,
    hasBilling: true, scheduledPlanId: "", scheduledCycle: "", billingCycle: "yearly",
    entitlementProvider: "stripe", appleRenewal: { available: false },
  },
};

const USAGE = {
  period: "2026-09",
  resetsAt: 1790000000,
  traffic: { used: 5, cap: 100 },
  storage: { used: 6, cap: 0 },
  plan: {
    id: "max", name: "Max", storageBytes: 0, trafficBytes: 999, retentionSecs: 0,
    priceMonthly: 0, priceYearly: 0, isTop: true,
    subscriptionStatus: "active", subscriptionEnd: 1789000000, billingCycle: "yearly",
    scheduledPlanId: "", scheduledPlanName: "", scheduledCycle: "",
    entitlementProvider: "stripe", appleRenewal: { available: false },
  },
};

const DEVICE_ROWS = [
  {
    ID: "d1", UserID: "u1", Name: "Laptop", CreatedAt: 1, LastSeenAt: 2,
    LastIP: "203.0.113.7", Kind: "desktop", Current: true,
    Inbox: { Capabilities: ["v1"], PublicKey: "AAAA" },
  },
  {
    ID: "d2", UserID: "u1", Name: "Phone", CreatedAt: 3, LastSeenAt: 4,
    LastIP: "203.0.113.8", Kind: "mobile", Current: false, Inbox: null,
  },
];

/** The REAL shape: `/api/devices` is wrapped (`handlers.go:363`). */
const DEVICES = { devices: DEVICE_ROWS };

const json = (value: unknown): string => JSON.stringify(value);

describe("reading the account", () => {
  it("parses the WRAPPED profile and the FLAT usage document", async () => {
    const { origin } = await serve((seen, respond) => {
      if (seen.url === "/api/me") respond(200, json(ME));
      else if (seen.url === "/api/me/usage") respond(200, json(USAGE));
      else respond(404);
    });
    const client = new AccountClient({ context: context(origin) });
    const profile = await client.profile(AbortSignal.timeout(5000));
    const usage = await client.usage(AbortSignal.timeout(5000));

    expect(profile.email).toBe("a@b.c");
    expect(profile.linkedMethods).toEqual(["password", "apple"]);
    // A grant would make these disagree; the client carries both rather than
    // reconciling them.
    expect(profile.planId).toBe("max");
    expect(profile.subscriptionStatus).toBe("active");
    expect(usage.period).toBe("2026-09");
    expect(usage.plan.id).toBe("max");
  });

  it("keeps retention where the server puts it, and treats 0 as unlimited", async () => {
    // `retentionSecs` exists ONLY on the usage document, inside `plan`.
    const { origin } = await serve((seen, respond) => {
      respond(200, json(seen.url === "/api/me" ? ME : USAGE));
    });
    const client = new AccountClient({ context: context(origin) });
    const profile = await client.profile(AbortSignal.timeout(5000));
    const usage = await client.usage(AbortSignal.timeout(5000));

    expect(profile).not.toHaveProperty("retentionSecs");
    expect(usage.plan.retentionSecs).toBe(0);
    // Unlimited is 0 for every cap, and the type says so rather than the caller
    // guessing from a sentinel.
    expect(usage.storage.cap).toBe(0);
  });

  it("keeps the EFFECTIVE cap distinct from the NOMINAL plan figure", async () => {
    // `traffic.cap` is prorated across a mid-month tier change; `trafficBytes`
    // is what the plan card advertises. Collapsing them misreports the quota.
    const { origin } = await serve((_seen, respond) => respond(200, json(USAGE)));
    const usage = await new AccountClient({ context: context(origin) }).usage(
      AbortSignal.timeout(5000),
    );
    expect(usage.traffic.cap).toBe(100);
    expect(usage.plan.trafficBytes).toBe(999);
    expect(usage.traffic.cap).not.toBe(usage.plan.trafficBytes);
  });

  it("defaults an OMITTED provider and refuses an UNKNOWN one", async () => {
    const omitted = { user: { ...ME.user } } as { user: Record<string, unknown> };
    delete omitted.user["entitlementProvider"];
    const { origin: a } = await serve((_seen, respond) => respond(200, json(omitted)));
    const backCompat = await new AccountClient({ context: context(a) }).profile(
      AbortSignal.timeout(5000),
    );
    // Older server: documented default.
    expect(backCompat.entitlementProvider).toBe("");

    const unknown = { user: { ...ME.user, entitlementProvider: "paypal" } };
    const { origin: b } = await serve((_seen, respond) => respond(200, json(unknown)));
    // Newer server this build does not understand: fail closed rather than
    // render a provider nothing here can handle.
    await expect(
      new AccountClient({ context: context(b) }).profile(AbortSignal.timeout(5000)),
    ).rejects.toMatchObject({ code: "malformed" });
  });

  it("refuses a negative or non-safe cap instead of rounding it up", async () => {
    // Repairing would turn "this response is wrong" into "you have no limit",
    // because 0 MEANS unlimited.
    for (const broken of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      const body = { ...USAGE, plan: { ...USAGE.plan, retentionSecs: broken } };
      const { origin } = await serve((_seen, respond) => respond(200, json(body)));
      await expect(
        new AccountClient({ context: context(origin) }).usage(AbortSignal.timeout(5000)),
      ).rejects.toMatchObject({ code: "malformed" });
    }
  });

  it("ignores fields it does not know without relaxing the ones it needs", async () => {
    const extra = { ...USAGE, somethingNew: { nested: true }, plan: { ...USAGE.plan, alsoNew: 7 } };
    const { origin } = await serve((_seen, respond) => respond(200, json(extra)));
    const usage = await new AccountClient({ context: context(origin) }).usage(
      AbortSignal.timeout(5000),
    );
    expect(usage.plan.name).toBe("Max");

    const missing = { ...USAGE, plan: { ...USAGE.plan, id: undefined } };
    const { origin: b } = await serve((_seen, respond) => respond(200, json(missing)));
    await expect(
      new AccountClient({ context: context(b) }).usage(AbortSignal.timeout(5000)),
    ).rejects.toMatchObject({ code: "malformed" });
  });

  it("reports the three reads separately", async () => {
    // A broken usage endpoint must not blank the profile, and neither may be
    // degraded into a free plan or a zero quota.
    const { origin } = await serve((seen, respond) => {
      if (seen.url === "/api/me") respond(200, json(ME));
      else if (seen.url === "/api/devices") respond(200, json(DEVICES));
      else respond(500, "server error");
    });
    const client = new AccountClient({ context: context(origin) });
    const profile = await client.profile(AbortSignal.timeout(5000));
    const devices = await client.devices(AbortSignal.timeout(5000));
    const failure = await client.usage(AbortSignal.timeout(5000)).then(
      () => null,
      (error: unknown) => error as AccountApiError,
    );

    expect(profile.planId).toBe("max");
    expect(devices).toHaveLength(2);
    expect(failure?.code).toBe("server-refused");
    expect(failure?.status).toBe(500);
  });
});

describe("the device list", () => {
  it("labels the current device and drops what a client must not carry", async () => {
    const { origin } = await serve((_seen, respond) => respond(200, json(DEVICES)));
    const devices = await new AccountClient({ context: context(origin) }).devices(
      AbortSignal.timeout(5000),
    );

    expect(devices[0]).toEqual({
      id: "d1", name: "Laptop", kind: "desktop", createdAt: 1, lastSeenAt: 2,
      current: true, enrolled: true,
    });
    // `Inbox` becomes a boolean; the capabilities and public key do not travel.
    expect(devices[1]?.enrolled).toBe(false);
    for (const device of devices) {
      expect(device).not.toHaveProperty("lastIP");
      expect(device).not.toHaveProperty("LastIP");
      expect(device).not.toHaveProperty("userId");
      expect(JSON.stringify(device)).not.toContain("203.0.113");
    }
  });

  it("refuses a BARE array — the real response is wrapped", async () => {
    // `{"devices": [...]}`. A parser that took a bare array would have been
    // tried only against a fixture written to match it, never against the
    // server.
    const { origin } = await serve((_seen, respond) => respond(200, json(DEVICE_ROWS)));
    await expect(
      new AccountClient({ context: context(origin) }).devices(AbortSignal.timeout(5000)),
    ).rejects.toMatchObject({ code: "malformed" });
  });

  it("refuses a list longer than a page and a row that is not a row", async () => {
    const many = {
      devices: Array.from({ length: MAX_DEVICE_ROWS + 1 }, (_, i) => ({
        ...DEVICE_ROWS[1], ID: `d${i}`,
      })),
    };
    const { origin: a } = await serve((_seen, respond) => respond(200, json(many)));
    await expect(
      new AccountClient({ context: context(a) }).devices(AbortSignal.timeout(5000)),
    ).rejects.toMatchObject({ code: "too-large" });

    const { origin: b } = await serve((_seen, respond) => respond(200, json({ devices: [{ ID: "" }] })));
    await expect(
      new AccountClient({ context: context(b) }).devices(AbortSignal.timeout(5000)),
    ).rejects.toMatchObject({ code: "malformed" });
  });
});

describe("renaming and revoking", () => {
  it("sends the exact method, path and body", async () => {
    const { origin, seen } = await serve((_seen, respond) => respond(200, json({ status: "ok" })));
    const client = new AccountClient({ context: context(origin) });
    const saved = await client.renameDevice("d1", "  My  Laptop  ", (v) => v.trim().replace(/\s+/g, " "), AbortSignal.timeout(5000));
    await client.revokeDevice("d1", AbortSignal.timeout(5000));

    expect(saved).toBe("My Laptop");
    expect(seen[0]).toMatchObject({ method: "PATCH", url: "/api/devices/d1" });
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ name: "My Laptop" });
    expect(seen[1]).toMatchObject({ method: "DELETE", url: "/api/devices/d1", body: "" });
    // Exactly two requests: no retry, no probe, no loop.
    expect(seen).toHaveLength(2);
  });

  it("refuses a name the server would refuse, counted in RUNES", async () => {
    const { origin, seen } = await serve((_seen, respond) => respond(200, json({ status: "ok" })));
    const client = new AccountClient({ context: context(origin) });
    const identity = (v: string): string => v;

    await expect(
      client.renameDevice("d1", "", identity, AbortSignal.timeout(5000)),
    ).rejects.toMatchObject({ code: "malformed" });
    // 65 astral characters: 130 UTF-16 units but 65 runes, which is what the
    // server counts. A UTF-16 ceiling would reject at 32 and disagree.
    await expect(
      client.renameDevice("d1", "😀".repeat(MAX_DEVICE_NAME_RUNES + 1), identity, AbortSignal.timeout(5000)),
    ).rejects.toMatchObject({ code: "malformed" });
    // Exactly at the ceiling is accepted, and reaches the server.
    await client.renameDevice("d1", "😀".repeat(MAX_DEVICE_NAME_RUNES), identity, AbortSignal.timeout(5000));

    expect(seen).toHaveLength(1);
  });

  it("keeps a device id to one path segment", async () => {
    const { origin, seen } = await serve((_seen, respond) => respond(200, json({ status: "ok" })));
    const client = new AccountClient({ context: context(origin) });
    // Encoded, so it addresses the row it names and not another route.
    await client.revokeDevice("../me", AbortSignal.timeout(5000));
    expect(seen[0]?.url).toBe("/api/devices/..%2Fme");

    await expect(
      client.revokeDevice("", AbortSignal.timeout(5000)),
    ).rejects.toMatchObject({ code: "malformed" });
  });
});

describe("asking for the verification email again", () => {
  it("sends the address the SERVER just gave, and never one a caller chose", async () => {
    // The security property in one case. Nothing in the signature can carry an
    // address: the only email that reaches the wire is the one this credential's
    // own profile came back with, so a renderer — or any other caller — cannot
    // make this app email somebody else.
    const { origin, seen } = await serve((incoming, respond) => {
      if (incoming.url === "/api/me") {
        respond(200, json({ user: { ...ME.user, email: "real@owner.example", emailVerified: false } }));
        return;
      }
      respond(200, json({ status: "sent" }));
    });
    const client = new AccountClient({ context: context(origin) });

    await expect(client.resendVerification(AbortSignal.timeout(5000))).resolves.toBe("sent");

    expect(seen[0]).toMatchObject({ method: "GET", url: "/api/me" });
    expect(seen[1]).toMatchObject({ method: "POST", url: "/api/auth/email/resend" });
    expect(JSON.parse(seen[1]?.body ?? "{}")).toEqual({ email: "real@owner.example" });
    // The profile read and the POST. No retry, no probe.
    expect(seen).toHaveLength(2);
  });

  it("sends NOTHING when the server's current answer is already verified", async () => {
    // The race worth having: somebody finished verifying in a browser while this
    // screen was still showing the badge. An email nobody needs is not the
    // answer, and neither is a failure — the outcome is what is true.
    const { origin, seen } = await serve((incoming, respond) => {
      if (incoming.url === "/api/me") {
        respond(200, json({ user: { ...ME.user, emailVerified: true } }));
        return;
      }
      respond(200, json({ status: "sent" }));
    });
    const client = new AccountClient({ context: context(origin) });

    await expect(client.resendVerification(AbortSignal.timeout(5000))).resolves.toBe("already-verified");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("/api/me");
  });

  it("refuses rather than posting an empty address", async () => {
    // An unverified account with no email on it should not become a POST with
    // `{"email":""}` — that is a request whose meaning is entirely up to the
    // server, made on behalf of a user who has no address to verify.
    const { origin, seen } = await serve((incoming, respond) => {
      if (incoming.url === "/api/me") {
        respond(200, json({ user: { ...ME.user, email: "", emailVerified: false } }));
        return;
      }
      respond(200, json({ status: "sent" }));
    });
    const client = new AccountClient({ context: context(origin) });

    await expect(
      client.resendVerification(AbortSignal.timeout(5000)),
    ).rejects.toMatchObject({ code: "malformed" });
    expect(seen).toHaveLength(1);
  });
});

describe("the transport", () => {
  it("refuses a redirect rather than following it with the bearer", async () => {
    // The target is a REAL second origin that would happily answer. A test
    // pointing at an unresolvable host proves nothing: the request fails either
    // way, and a client that followed redirects would still look correct.
    const elsewhere = await serve((_seen, respond) => respond(200, json(ME)));
    const { origin, seen } = await serve((seen, respond) => {
      if (seen.url === "/api/me") respond(302, "", { location: `${elsewhere.origin}/api/me` });
      else respond(200, json(ME));
    });

    await expect(
      new AccountClient({ context: context(origin) }).profile(AbortSignal.timeout(5000)),
    ).rejects.toBeInstanceOf(AccountApiError);

    expect(seen).toHaveLength(1);
    // The decisive assertion: the other origin was never contacted, so the
    // bearer never reached it.
    expect(elsewhere.seen).toHaveLength(0);
  });

  it("refuses an origin that is not an origin, at construction", async () => {
    expect(() => new AccountClient({ context: { origin: "not a url", bearer: "b", epoch: 1 } })).toThrow(
      AccountApiError,
    );
  });

  it("refuses a body that keeps coming, mid-flight", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = "x".repeat(64 * 1024);
      const pump = (): void => {
        if (!res.writableEnded) {
          res.write(chunk);
          setTimeout(pump, 1);
        }
      };
      pump();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await expect(
      new AccountClient({ context: context(`http://127.0.0.1:${port}`) }).profile(
        AbortSignal.timeout(5000),
      ),
    ).rejects.toMatchObject({ code: "too-large" });
  });

  it("joins a held response when the caller aborts", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      void held.then(() => res.end("}"));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const controller = new AbortController();
    const client = new AccountClient({ context: context(`http://127.0.0.1:${port}`) });
    const pending = client.profile(controller.signal).then(
      () => null,
      (error: unknown) => error as AccountApiError,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    const failure = await pending;
    release();
    // Reported as a failure, and the read was cancelled rather than left half
    // consumed.
    expect(failure).toBeInstanceOf(AccountApiError);
  });

  it("drops an UNKNOWN server token instead of echoing it", async () => {
    // A shape test — "short and alphanumeric" — admits whatever the server put
    // there: an account identifier, an email, a token fragment. This value
    // reaches an error message and a log, so only codes this build recognises
    // survive; the status still says what happened.
    const { origin } = await serve((_seen, respond) =>
      respond(403, json({ error: "PRIVATE_SYNTHETIC_ACCOUNT_IDENTIFIER" })),
    );
    const failure = await new AccountClient({ context: context(origin) })
      .profile(AbortSignal.timeout(5000))
      .then(() => null, (error: unknown) => error as AccountApiError);

    expect(failure?.code).toBe("server-refused");
    expect(failure?.status).toBe(403);
    expect(failure?.serverCode).toBeUndefined();
    const text = `${failure?.message ?? ""}${failure?.stack ?? ""}`;
    expect(text).not.toContain("PRIVATE_SYNTHETIC_ACCOUNT_IDENTIFIER");
  });

  it("keeps a KNOWN code, because it is the server's own vocabulary", async () => {
    const { origin } = await serve((_seen, respond) =>
      respond(400, json({ error: "invalid_device_name" })),
    );
    const failure = await new AccountClient({ context: context(origin) })
      .renameDevice("d1", "x", (v) => v, AbortSignal.timeout(5000))
      .then(() => null, (error: unknown) => error as AccountApiError);
    expect(failure?.serverCode).toBe("invalid_device_name");
  });

  it("never puts the token, the URL or server prose in an error", async () => {
    const { origin } = await serve((_seen, respond) =>
      respond(403, json({ error: "forbidden", detail: "rlm_cli_secret_value leaked here" })),
    );
    const failure = await new AccountClient({ context: context(origin) })
      .profile(AbortSignal.timeout(5000))
      .then(() => null, (error: unknown) => error as AccountApiError);

    expect(failure?.code).toBe("server-refused");
    const text = `${failure?.message ?? ""}${failure?.stack ?? ""}`;
    expect(text).not.toContain("rlm_cli_");
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toContain("leaked here");
    expect(text).not.toContain("forbidden");
  });

  it("keeps its captured origin, bearer and epoch when the CALLER mutates them", async () => {
    // The case a "never changes" test that mutates nothing cannot catch.
    //
    // A caller reusing one context object across accounts — updating `origin`
    // and `bearer` in place — would otherwise send this client's next revoke to
    // the replacement origin with the replacement bearer, aimed at a device id
    // belonging to the account it captured.
    const replacement = await serve((_seen, respond) => respond(200, json({ status: "ok" })));
    const { origin, seen } = await serve((seen, respond) => {
      respond(200, json(seen.url === "/api/me" ? ME : seen.url === "/api/devices" ? DEVICES : USAGE));
    });
    // A MUTABLE object, exactly as a caller would hold it.
    const captured = { origin, bearer: "rlm_cli_secret_value", epoch: 7 };
    const client = new AccountClient({ context: captured });

    captured.origin = replacement.origin;
    captured.bearer = "rlm_cli_replacement_value";
    captured.epoch = 99;

    await client.profile(AbortSignal.timeout(5000));
    await client.devices(AbortSignal.timeout(5000));
    await client.revokeDevice("d1", AbortSignal.timeout(5000));

    // The replacement origin was never contacted.
    expect(replacement.seen).toHaveLength(0);
    expect(seen).toHaveLength(3);
    for (const request of seen) {
      expect(request.authorization).toBe("Bearer rlm_cli_secret_value");
    }
    // And the epoch a caller compares against is still the captured one.
    expect(client.epoch).toBe(7);
  });

  it("refuses a malformed context before it can send anything", async () => {
    for (const bad of [
      { origin: "not a url", bearer: "b", epoch: 1 },
      { origin: "https://relayium.com/api", bearer: "b", epoch: 1 },
      { origin: "https://relayium.com", bearer: "", epoch: 1 },
      { origin: "https://relayium.com", bearer: "b", epoch: 1.5 },
    ]) {
      expect(() => new AccountClient({ context: bad })).toThrow(AccountApiError);
    }
  });
});
