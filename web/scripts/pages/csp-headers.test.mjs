// Guards the nginx security snippet's CSP against silently going stale.
//
// deploy/nginx/relayium-security.conf hardcodes the sha256 of the pre-paint
// theme snippet in web/index.html (the same hash server/spa.go computes at
// runtime). nginx can't compute it dynamically the way Go does, so if the theme
// snippet is ever edited, the hardcoded hash stops matching and the browser
// refuses to run it — a theme flash plus a console CSP error, on every page.
// This test fails the build in that case, pointing at the file to update.
//
// The production nginx config now lives in the private relayium-ops repo (see
// docs/self-hosting.md), so it's normally absent here — this guard only runs
// when a relayium-ops checkout's nginx directory is copied in at
// <repo>/deploy/nginx/ (gitignored; see .gitignore).
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");
const nginxSnippetPath = "../deploy/nginx/relayium-security.conf";
const hasNginxSnippet = existsSync(resolve(process.cwd(), nginxSnippetPath));

// The same extraction server/spa.go's spaScriptHashes uses: an inline <script>
// with no src and no non-JS type. The theme snippet is the first such block in
// index.html.
function firstInlineScriptHash(html) {
  for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1].toLowerCase();
    if (attrs.includes("src=")) continue;
    if (attrs.includes("type=") && !attrs.includes("text/javascript") && !attrs.includes("module")) continue;
    return "sha256-" + createHash("sha256").update(m[2]).digest("base64");
  }
  throw new Error("no inline script found in index.html");
}

describe("nginx CSP snippet", () => {
  if (!hasNginxSnippet) {
    it.skip("relayium-ops checkout not present — see docs/self-hosting.md", () => {});
    return;
  }

  const snippet = read(nginxSnippetPath);
  const csp = snippet.match(/Content-Security-Policy "([^"]*)"/)?.[1];

  it("exists and has the expected shape", () => {
    expect(csp, "CSP add_header not found in snippet").toBeTruthy();
    // The tokens that actually keep the app working — drop any and something breaks.
    expect(csp).toContain("'wasm-unsafe-eval'"); // libsodium WASM compiles
    expect(csp).toContain("frame-ancestors 'none'"); // clickjacking defense
    expect(csp).toContain("https://*.relayium.com:2053"); // node download subdomains
    // 'unsafe-inline' is allowed in style-src (Svelte style attributes) but must
    // never appear in script-src.
    const scriptSrc = csp.match(/script-src ([^;]*)/)?.[1] ?? "";
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toMatch(/\bhttps:(?!\/\/\*\.relayium)/); // no broad script host
  });

  it("carries the current theme-snippet hash from web/index.html", () => {
    const want = firstInlineScriptHash(read("index.html"));
    expect(csp, `theme-snippet hash drifted — recompute per the snippet's header comment; expected ${want}`).toContain(`'${want}'`);
  });
});
