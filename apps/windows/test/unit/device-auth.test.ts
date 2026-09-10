import { describe, expect, it } from "vitest";
import {
  DeviceAuthClient,
  DEVICE_APPROVAL_PATH,
  approvalURL,
  parseDevicePoll,
  parseDeviceStart,
  type DeviceAuthTransport,
} from "../../src/main/account/device-auth.js";

const ORIGIN = "https://relayium.com";
const good = {
  user_code: "WDJB-MJHT",
  device_code: "opaque-device-code",
  verification_uri: `${ORIGIN}${DEVICE_APPROVAL_PATH}`,
  interval: 5,
  expires_in: 600,
};

describe("parseDeviceStart", () => {
  it("accepts a well-formed response", () => {
    expect(parseDeviceStart(good, ORIGIN)).toMatchObject({
      userCode: "WDJB-MJHT",
      deviceCode: "opaque-device-code",
      interval: 5,
      expiresIn: 600,
    });
  });

  // The verification URL is handed to the system browser. An unchecked value is
  // an open redirect carrying the user's trust to a credential-harvesting page
  // that looks exactly like the real approval screen.
  it("refuses a URL on another origin", () => {
    expect(() => parseDeviceStart({ ...good, verification_uri: "https://evil.example/device" }, ORIGIN))
      .toThrow();
  });

  it("refuses embedded credentials, which move the real host into the userinfo", () => {
    expect(() =>
      parseDeviceStart(
        { ...good, verification_uri: `https://relayium.com@evil.example${DEVICE_APPROVAL_PATH}` },
        ORIGIN,
      ),
    ).toThrow();
  });

  it("refuses a non-http scheme before it can reach a browser", () => {
    for (const uri of ["javascript:alert(1)", "file:///etc/passwd", "relayium://device"]) {
      expect(() => parseDeviceStart({ ...good, verification_uri: uri }, ORIGIN)).toThrow();
    }
  });

  it("refuses another path on the right origin", () => {
    expect(() =>
      parseDeviceStart({ ...good, verification_uri: `${ORIGIN}/somewhere-else` }, ORIGIN),
    ).toThrow();
  });

  // An unbounded interval is a hot poll loop; an unbounded expiry is a client
  // that never gives up.
  it("refuses timings that are not bounded positive integers", () => {
    for (const interval of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 3600, "5"]) {
      expect(() => parseDeviceStart({ ...good, interval }, ORIGIN)).toThrow();
    }
    for (const expires of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 10 ** 9]) {
      expect(() => parseDeviceStart({ ...good, expires_in: expires }, ORIGIN)).toThrow();
    }
  });

  it("refuses empty or oversized codes", () => {
    expect(() => parseDeviceStart({ ...good, user_code: "" }, ORIGIN)).toThrow();
    expect(() => parseDeviceStart({ ...good, device_code: "x".repeat(513) }, ORIGIN)).toThrow();
  });
});

describe("approvalURL", () => {
  it("pre-fills the code so approving is one click", () => {
    const url = new URL(approvalURL(parseDeviceStart(good, ORIGIN), ORIGIN));
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe(DEVICE_APPROVAL_PATH);
    expect(url.searchParams.get("code")).toBe("WDJB-MJHT");
  });

  it("re-checks the origin, being the value that reaches the browser", () => {
    const start = parseDeviceStart(good, ORIGIN);
    expect(() => approvalURL(start, "https://other.example")).toThrow();
  });
});

describe("parseDevicePoll", () => {
  it("reads each documented status", () => {
    expect(parseDevicePoll({ status: "authorization_pending" })).toEqual({ status: "pending" });
    expect(parseDevicePoll({ status: "denied" })).toEqual({ status: "denied" });
    expect(parseDevicePoll({ status: "expired" })).toEqual({ status: "expired" });
    expect(parseDevicePoll({ status: "ok", access_token: "t", account_email: "a@b.c" })).toEqual({
      status: "ok",
      accessToken: "t",
      accountEmail: "a@b.c",
    });
  });

  // An empty token lands the session in "signed in" with a bearer that 401s on
  // the very next request.
  it("refuses an empty token", () => {
    expect(() => parseDevicePoll({ status: "ok", access_token: "" })).toThrow();
    expect(() => parseDevicePoll({ status: "ok" })).toThrow();
  });

  // Never guess: a future status read as success signs someone in wrongly.
  it("refuses an unknown status rather than assuming", () => {
    expect(() => parseDevicePoll({ status: "almost" })).toThrow();
    expect(() => parseDevicePoll({})).toThrow();
  });
});

describe("the installation hint", () => {
  const record = () => {
    const calls: { url: string; body: unknown }[] = [];
    const transport: DeviceAuthTransport = {
      async postJSON(url, body) {
        calls.push({ url, body });
        return url.endsWith("/start")
          ? { status: 200, body: good }
          : { status: 200, body: { status: "authorization_pending" } };
      },
    };
    return { calls, transport };
  };

  it("rides start, and never poll — the call that returns a bearer", async () => {
    const { calls, transport } = record();
    const client = new DeviceAuthClient(ORIGIN, transport, "i".repeat(43));
    await client.start();
    await client.poll("opaque-device-code");

    expect(calls[0]!.body).toEqual({ install_id: "i".repeat(43) });
    expect(JSON.stringify(calls[1]!.body)).not.toContain("install_id");
    expect(calls[1]!.body).toEqual({ device_code: "opaque-device-code" });
  });

  it("sends a bodyless start when there is no hint, matching every shipped CLI", async () => {
    const { calls, transport } = record();
    await new DeviceAuthClient(ORIGIN, transport).start();
    expect(calls[0]!.body).toBeUndefined();
  });
});
