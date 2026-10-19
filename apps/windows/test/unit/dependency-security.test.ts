// The packager's dependency graph, and the download path the override touches.
//
// `electron-builder` 26.15.3 nests `@electron/get` 3.1.0 under `app-builder-lib`,
// and that copy optionally depends on `global-agent` 3.0.0 → `roarr` 2.15.4 →
// `sprintf-js` 1.1.3 (GHSA-hp3w-g68c-fv3c). `package.json` overrides that ONE
// edge to `global-agent` 4.1.3, which has no `roarr` at all. Why the override is
// scoped this way, what it does not fix, and when to delete it is in
// `DEPENDENCY-SECURITY.md`.
//
// Two kinds of check, because each misses what the other catches:
//
// - the graph, read from both the lock and the INSTALLED tree. The lock is what
//   CI installs from; the installed tree is what actually runs, and an override
//   that npm silently declined to apply would show up only there.
// - a real `downloadArtifact` through the packager's own `@electron/get`, in a
//   child process with a clean environment, against loopback servers. Swapping
//   a major version of the module that patches `http`/`https` process-wide is
//   only safe if proxying, `NO_PROXY`, TLS verification and the SHA-256 check
//   still behave; a `typeof bootstrap === "function"` check proves none of that.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign, X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const appRoot = fileURLToPath(new URL("../../", import.meta.url));
const readJson = (file: string): any => JSON.parse(readFileSync(file, "utf8"));

type Entry = { location: string; name: string; version: string; dev: boolean; dependencies: Record<string, string> };

/** Lock entries, keyed by their install location. */
function lockEntries(lock: any): Entry[] {
  return Object.entries<any>(lock.packages)
    .filter(([location]) => location !== "")
    .map(([location, value]) => ({
      location,
      name: value.name ?? location.slice(location.lastIndexOf("node_modules/") + "node_modules/".length),
      version: value.version,
      dev: value.dev === true,
      dependencies: { ...value.dependencies, ...value.optionalDependencies },
    }));
}

/** Every package physically present under `node_modules`, at any depth. */
function installedEntries(): Entry[] {
  const found: Entry[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const child of readdirSync(dir)) {
      if (child.startsWith(".")) continue;
      const names = child.startsWith("@") ? readdirSync(path.join(dir, child)).map((n) => `${child}/${n}`) : [child];
      for (const name of names) {
        const pkgDir = path.join(dir, name);
        const manifest = path.join(pkgDir, "package.json");
        if (!existsSync(manifest)) continue;
        const pkg = readJson(manifest);
        found.push({
          location: path.relative(appRoot, pkgDir).split(path.sep).join("/"),
          name: pkg.name ?? name,
          version: pkg.version,
          dev: false,
          dependencies: { ...pkg.dependencies, ...pkg.optionalDependencies },
        });
        walk(path.join(pkgDir, "node_modules"));
      }
    }
  };
  walk(path.join(appRoot, "node_modules"));
  return found;
}

const semverParts = (v: string): number[] => v.split(/[.+-]/).slice(0, 3).map(Number);
const lessThan = (a: string, b: string): boolean => {
  const [x, y] = [semverParts(a), semverParts(b)];
  for (let i = 0; i < 3; i++) if (x[i]! !== y[i]!) return x[i]! < y[i]!;
  return false;
};

/**
 * The rules the override exists to satisfy. `sprintf-js` has no fixed release
 * (the advisory's range is `<= 1.1.3`, the latest), so any copy at or below it
 * is a finding; `roarr` is the only route that brought it in.
 */
function violations(entries: Entry[]): string[] {
  const found: string[] = [];
  for (const e of entries) {
    if (e.name === "sprintf-js" && !lessThan("1.1.3", e.version)) found.push(`${e.location}@${e.version}`);
    if (e.name === "roarr") found.push(`${e.location}@${e.version}`);
    if (e.name === "global-agent" && lessThan(e.version, "4.1.3")) found.push(`${e.location}@${e.version}`);
  }
  return found;
}

describe("the packager's dependency graph", () => {
  const lock = readJson(path.join(appRoot, "package-lock.json"));
  const pkg = readJson(path.join(appRoot, "package.json"));

  it("catches the graph this change replaced, so a green result is not vacuous", () => {
    // The exact entries `package-lock.json` held before the override.
    const before = lockEntries({
      packages: {
        "node_modules/global-agent": { version: "3.0.0", dev: true, dependencies: { roarr: "^2.15.3" } },
        "node_modules/roarr": { version: "2.15.4", dev: true, dependencies: { "sprintf-js": "^1.1.2" } },
        "node_modules/sprintf-js": { version: "1.1.3", dev: true },
      },
    });
    expect(violations(before)).toEqual([
      "node_modules/global-agent@3.0.0",
      "node_modules/roarr@2.15.4",
      "node_modules/sprintf-js@1.1.3",
    ]);
  });

  it("has no affected sprintf-js, no roarr and no old global-agent in the lock", () => {
    const entries = lockEntries(lock);
    expect(entries.length).toBeGreaterThan(100);
    expect(violations(entries)).toEqual([]);
    expect(entries.filter((e) => e.name === "global-agent").map((e) => e.version)).toEqual(["4.1.3"]);
  });

  it("has none in the installed tree either, so npm really applied the override", () => {
    const entries = installedEntries();
    expect(entries.length).toBeGreaterThan(100);
    expect(violations(entries)).toEqual([]);
    const get = readJson(path.join(appRoot, "node_modules/app-builder-lib/node_modules/@electron/get/package.json"));
    expect(get.version).toBe("3.1.0");
    expect(entries.filter((e) => e.name === "global-agent").map((e) => e.version)).toEqual(["4.1.3"]);
  });

  it("scopes the override to the one edge it is for, and keeps the toolchain pins", () => {
    // Keyed on @electron/get@3.1.0 exactly: when electron-builder moves to a
    // different @electron/get, the override stops matching and the graph tests
    // above say whether it is still needed.
    expect(pkg.overrides).toEqual({ "@electron/get@3.1.0": { "global-agent": "4.1.3" } });
    expect(pkg.devDependencies.electron).toBe("44.3.0");
    expect(pkg.devDependencies["electron-builder"]).toBe("26.15.3");
    expect(lock.packages["node_modules/electron"].version).toBe("44.3.0");
    expect(lock.packages["node_modules/electron-builder"].version).toBe("26.15.3");
    // Electron's own installer uses @electron/get 5, which has no proxy module.
    const own = lock.packages["node_modules/@electron/get"];
    expect(own.version).toBe("5.1.0");
    expect({ ...own.dependencies, ...own.optionalDependencies }).not.toHaveProperty("global-agent");
  });

  it("keeps everything touched here out of the packaged app", () => {
    // electron-builder ships `dependencies`, not `devDependencies`. A non-dev
    // lock entry is one the installer could carry.
    const shipped = lockEntries(lock).filter((e) => !e.dev);
    const names = new Set(shipped.map((e) => e.name));
    for (const name of ["electron-builder", "app-builder-lib", "@electron/get", "got", "cacheable-request",
      "http-cache-semantics", "global-agent", "roarr", "sprintf-js", "matcher", "serialize-error"]) {
      expect(names.has(name), name).toBe(false);
    }
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["libsodium-wrappers", "qrcode"]);
  });

  it("reaches http-cache-semantics only through got's opt-in cache, which nothing here enables", () => {
    // GHSA-ch52-4w7c-c8xp is NOT fixed by this change — see DEPENDENCY-SECURITY.md.
    // What this pins is the reachability argument for leaving it: one route,
    // dev-only, through a got option the packager never sets. The download
    // tests below observe the same thing dynamically: zero CachePolicy
    // constructions on a real download, and some once the option is set.
    const entries = lockEntries(lock);
    const dependents = (name: string): string[] =>
      entries.filter((e) => name in e.dependencies).map((e) => e.location).sort();
    expect(entries.filter((e) => e.name === "http-cache-semantics").every((e) => e.dev)).toBe(true);
    expect(dependents("http-cache-semantics")).toEqual(["node_modules/cacheable-request"]);
    expect(dependents("cacheable-request")).toEqual(["node_modules/got"]);
    expect(dependents("got")).toEqual(["node_modules/app-builder-lib/node_modules/@electron/get"]);
    const gotCore = readFileSync(path.join(appRoot, "node_modules/got/dist/source/core/index.js"), "utf8");
    expect(gotCore).toMatch(/const \{ cache \} = options;\s*if \(cache\) \{/);
    const downloader = readFileSync(
      path.join(appRoot, "node_modules/app-builder-lib/node_modules/@electron/get/dist/cjs/GotDownloader.js"), "utf8");
    expect(downloader).not.toMatch(/\bcache\s*:/);
    expect(readFileSync(path.join(appRoot, "electron-builder.yml"), "utf8")).not.toMatch(/electronDownload/);
  });
});

describe("fast-uri as the packager's Ajv loads it", () => {
  // GHSA-hrr3-gc8f-f4qj: before 3.1.8 the host was lower-cased before it was
  // percent-decoded, so `//%41.com` kept an upper-case `A` that `//A.com` did
  // not. Resolved from Ajv's own directory: the copy it actually requires.
  const ajvDir = path.dirname(createRequire(path.join(appRoot, "node_modules/app-builder-lib/package.json"))
    .resolve("ajv/package.json"));
  const fastUriFile = createRequire(path.join(ajvDir, "package.json")).resolve("fast-uri");
  const fastUri = createRequire(import.meta.url)(fastUriFile);

  it("is a release with the fix, inside Ajv's declared range", () => {
    const manifest = readJson(path.join(path.dirname(fastUriFile), "package.json"));
    expect(lessThan(manifest.version, "3.1.8")).toBe(false);
    expect(manifest.version.startsWith("3.")).toBe(true);
    expect(readJson(path.join(ajvDir, "package.json")).dependencies["fast-uri"]).toBe("^3.0.1");
  });

  it("parses, normalizes and compares a percent-encoded upper-case host like its plain form", () => {
    expect(fastUri.parse("//%41.com").host).toBe(fastUri.parse("//a.com").host);
    expect(fastUri.normalize("//%41.com")).toBe(fastUri.normalize("//a.com"));
    expect(fastUri.equal("//%41.com", "//a.com")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A real download through @electron/get 3.1.0 + global-agent.

/** Minimal DER, enough for one self-signed P-256 certificate. */
const der = (tag: number, body: Buffer): Buffer => {
  const len = body.length < 0x80 ? Buffer.from([body.length])
    : body.length < 0x100 ? Buffer.from([0x81, body.length]) : Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
};
const seq = (...parts: Buffer[]): Buffer => der(0x30, Buffer.concat(parts));
// Arcs as numbers rather than a dotted string: a dotted OID reads as an IP
// literal to the repository's production-identifier scan.
const oid = (arcs: readonly number[]): Buffer => {
  const [a, b, ...rest] = arcs;
  const bytes = [a! * 40 + b!];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
};
const utcTime = (d: Date): Buffer =>
  der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));

/**
 * A fresh, throwaway certificate for 127.0.0.1/localhost. Generated per run so
 * no key material is committed; trusted only when a test hands it to the child
 * through NODE_EXTRA_CA_CERTS.
 */
function selfSignedCert(): { key: string; certPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const sigAlg = seq(oid([1, 2, 840, 10045, 4, 3, 2]));
  const name = seq(der(0x31, seq(oid([2, 5, 4, 3]), der(0x0c, Buffer.from("relayium dependency-security test")))));
  const now = Date.now();
  const san = seq(der(0x82, Buffer.from("localhost")), der(0x87, Buffer.from([127, 0, 0, 1])));
  const extensions = der(0xa3, seq(seq(oid([2, 5, 29, 17]), der(0x04, san))));
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1, ...createHash("sha256").update(String(now)).digest().subarray(0, 8)])),
    sigAlg, name,
    seq(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 3_600_000))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const signature = sign("sha256", tbs, privateKey);
  const cert = seq(tbs, sigAlg, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const certPem = `-----BEGIN CERTIFICATE-----\n${cert.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
  new X509Certificate(certPem); // parses, or the test fails here rather than downstream
  return { key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), certPem };
}

const VERSION = "44.3.0";
const FILE = `electron-v${VERSION}-win32-x64.zip`;
const PAYLOAD = Buffer.alloc(64 * 1024, 0x5a);
const PAYLOAD_SHA = createHash("sha256").update(PAYLOAD).digest("hex");
const WRONG_SHA = createHash("sha256").update("not the payload").digest("hex");

type Seen = { origin: string[]; proxy: string[] };
const seen: Seen = { origin: [], proxy: [] };
const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
let httpOrigin = "";
let httpsOrigin = "";
let proxyUrl = "";
let work = "";
let caFile = "";
const getDir = path.join(appRoot, "node_modules/app-builder-lib/node_modules/@electron/get");
const fixture = fileURLToPath(new URL("../fixtures/dependency-security-proxy.cjs", import.meta.url));

const listen = (server: net.Server): Promise<string> =>
  new Promise((resolve) => {
    servers.push(server);
    server.on("connection", (socket: net.Socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1", () => resolve(`127.0.0.1:${(server.address() as AddressInfo).port}`));
  });

const serve = (label: string) => (req: http.IncomingMessage, res: http.ServerResponse): void => {
  seen.origin.push(`${label} ${req.url}`);
  if (req.url === `/v${VERSION}/${FILE}`) {
    res.writeHead(200, { "content-type": "application/zip", "content-length": PAYLOAD.length });
    res.end(PAYLOAD);
  } else {
    res.writeHead(404).end();
  }
};

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), "relayium-depsec-"));
  const { key, certPem } = selfSignedCert();
  caFile = path.join(work, "ca.pem");
  writeFileSync(caFile, certPem);
  httpOrigin = `http://${await listen(http.createServer(serve("http")))}/`;
  httpsOrigin = `https://${await listen(https.createServer({ key, cert: certPem }, serve("https")))}/`;
  // A forwarding proxy: absolute-URI GETs for http, CONNECT tunnels for https.
  const proxy = http.createServer((req, res) => {
    seen.proxy.push(`GET ${req.url}`);
    const upstream = http.request(req.url!, { method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  proxy.on("connect", (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    seen.proxy.push(`CONNECT ${req.url}`);
    const [host, port] = req.url!.split(":");
    const upstream = net.connect(Number(port), host, () => {
      sockets.add(upstream);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  proxyUrl = `http://${await listen(proxy)}`;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  if (work) rmSync(work, { recursive: true, force: true });
});

type Outcome = {
  electronGetVersion: string; globalAgentVersion: string | null; globalAgentBootstrapped: boolean;
  cachePolicy: { file: string; version: string; constructions: number; restored: number };
  ok: boolean; sha256?: string; fileName?: string; error?: string; code?: string | null;
};

/** One download in a child whose environment holds only what is passed here. */
function download(
  mirror: string, checksum: string, extraEnv: Record<string, string>, { enableGotCache = false } = {},
): Promise<Outcome> {
  seen.origin.length = 0;
  seen.proxy.length = 0;
  const run = mkdtempSync(path.join(work, "run-"));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    TMPDIR: run, TEMP: run, TMP: run,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ELECTRON_GET_USE_PROXY: "1",
    ...extraEnv,
  };
  const request = JSON.stringify({
    version: VERSION, mirror, checksums: { [FILE]: checksum },
    cacheRoot: path.join(run, "cache"), tempDirectory: run, enableGotCache,
  });
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [fixture, getDir, request], { env, timeout: 20_000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`child failed: ${error.message}\n${stderr}`));
      const outcome = JSON.parse(stdout.trim().split("\n").pop()!);
      if (outcome.crashed) return reject(new Error(outcome.crashed));
      resolve(outcome);
    });
  });
}

// Each case spawns one Node process; a cold start plus a 64 KiB download is well
// under a second, so the margin here is for a loaded CI runner, not for retries.
describe("downloading through the packager's @electron/get with global-agent 4", { timeout: 30_000 }, () => {
  const expectedUrl = (): string => `${httpOrigin}v${VERSION}/${FILE}`;

  it("bootstraps global-agent 4.1.3 from the real CJS path and sends the download through the proxy", async () => {
    const out = await download(httpOrigin, PAYLOAD_SHA, { HTTP_PROXY: proxyUrl });
    expect(out.electronGetVersion).toBe("3.1.0");
    expect(out.globalAgentVersion).toBe("4.1.3");
    expect(out.globalAgentBootstrapped).toBe(true);
    expect(out, out.error).toMatchObject({ ok: true, fileName: FILE, sha256: PAYLOAD_SHA });
    expect(seen.proxy).toEqual([`GET ${expectedUrl()}`]);
    expect(seen.origin).toEqual([`http /v${VERSION}/${FILE}`]);
    // The http-cache-semantics copy cacheable-request would load was never used:
    // a completed default download built no CachePolicy.
    expect(out.cachePolicy.file.split(path.sep).join("/")).toMatch(/\/node_modules\/http-cache-semantics\/index\.js$/);
    expect(out.cachePolicy).toMatchObject({ constructions: 0, restored: 0 });
  });

  it("would see http-cache-semantics run if got's cache were enabled, so the zero above is real", async () => {
    const out = await download(httpOrigin, PAYLOAD_SHA, { HTTP_PROXY: proxyUrl }, { enableGotCache: true });
    expect(out, out.error).toMatchObject({ ok: true, sha256: PAYLOAD_SHA });
    expect(out.cachePolicy.constructions).toBeGreaterThan(0);
  });

  it("goes direct for a host NO_PROXY names", async () => {
    const out = await download(httpOrigin, PAYLOAD_SHA, { HTTP_PROXY: proxyUrl, NO_PROXY: "127.0.0.1" });
    expect(out.globalAgentBootstrapped).toBe(true);
    expect(out, out.error).toMatchObject({ ok: true, sha256: PAYLOAD_SHA });
    expect(seen.proxy).toEqual([]);
    expect(seen.origin).toEqual([`http /v${VERSION}/${FILE}`]);
  });

  it("still refuses a download whose bytes do not match the expected SHA-256", async () => {
    const out = await download(httpOrigin, WRONG_SHA, { HTTP_PROXY: proxyUrl });
    expect(seen.proxy).toEqual([`GET ${expectedUrl()}`]);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/checksum/i);
  });

  it("still refuses an untrusted certificate through the proxy tunnel", async () => {
    const out = await download(httpsOrigin, PAYLOAD_SHA, { HTTPS_PROXY: proxyUrl });
    expect(seen.proxy).toEqual([`CONNECT ${new URL(httpsOrigin).host}`]);
    expect(out.ok).toBe(false);
    expect(`${out.code} ${out.error}`).toMatch(/SELF_SIGNED|self.signed|unable to verify/i);
    // TLS failed before any HTTP request reached the origin.
    expect(seen.origin).toEqual([]);
  });

  it("accepts the same server once its certificate is trusted, so the refusal above is about trust", async () => {
    const out = await download(httpsOrigin, PAYLOAD_SHA, { HTTPS_PROXY: proxyUrl, NODE_EXTRA_CA_CERTS: caFile });
    expect(out, out.error).toMatchObject({ ok: true, sha256: PAYLOAD_SHA });
    expect(seen.proxy).toEqual([`CONNECT ${new URL(httpsOrigin).host}`]);
    expect(seen.origin).toEqual([`https /v${VERSION}/${FILE}`]);
  });
});
