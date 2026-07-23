package main

import (
	"context"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Release mirror: central re-serves this project's own GitHub release assets so
// a node that cannot reach github.com can still update.
//
// Why this is not a trust decision: the updater verifies every download against
// checksums.txt AND an ECDSA signature over that file, with the public key
// compiled into the binary (see selfupdate.verifyReleaseSignature). A mirror
// that served a tampered archive would fail that check on the node, before
// anything is installed. So where the bytes come from is a reachability
// question, not a security one — which is exactly why it is safe to solve the
// China-reachability problem this way instead of by relaxing verification.
//
// The path deliberately mirrors GitHub's own shape, so pointing a node or the
// installer at this host is a pure prefix swap:
//
//	https://github.com/relayium/relayium/releases/download/v0.10.2/<asset>
//	https://relayium.com/gh/relayium/relayium/releases/download/v0.10.2/<asset>
const mirrorPrefix = "/gh/"

// mirrorUpstreamFor is where the bytes actually come from. A var, not a const,
// only so the test can point it at a stand-in instead of reaching the network.
var mirrorUpstreamFor = "https://github.com"

// mirrorPath is the ONLY shape this handler will fetch: our own repo, a release
// download, a release tag, and one of the artifact names goreleaser produces.
// It is an allowlist rather than a sanitizer because the alternative — pass the
// tail through to github.com after cleaning it — turns central into an open
// proxy the moment the cleaning has a gap.
var mirrorPath = regexp.MustCompile(`^relayium/relayium/releases/download/v[0-9]+\.[0-9]+\.[0-9]+/` +
	`(relayium(-node)?_(linux|darwin)_(amd64|arm64)\.tar\.gz|relayium_windows_(amd64|arm64)\.zip|checksums\.txt(\.sig)?)$`)

// mirrorMaxBytes caps a single proxied asset. The real artifacts are ~10 MB; a
// cap keeps a surprise upstream (a redirect loop, a mangled release) from
// streaming unbounded bytes through central.
const mirrorMaxBytes = 256 << 20

// handleReleaseMirror streams one release asset from GitHub. It does not cache:
// updates are rare, the fleet is small, and a cache is a second place for a
// stale or half-written artifact to live. If that ever costs real egress, add
// one — the verification story does not change.
func handleReleaseMirror(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, mirrorPrefix)
	if !mirrorPath.MatchString(rest) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, mirrorUpstreamFor+"/"+rest, nil)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	resp, err := mirrorClient.Do(req)
	if err != nil {
		log.Printf("release mirror: fetch %s: %v", rest, err)
		http.Error(w, "upstream unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		http.Error(w, "not found upstream", resp.StatusCode)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		h.Set("Content-Length", cl)
	}
	// Release assets are immutable: a tag never changes what it points at.
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	w.WriteHeader(http.StatusOK)
	if _, err := io.Copy(w, io.LimitReader(resp.Body, mirrorMaxBytes)); err != nil {
		log.Printf("release mirror: stream %s: %v", rest, err)
	}
}

// mirrorClient follows GitHub's redirect to its CDN; the default client already
// does, this just gives the hop a bounded timeout of its own.
var mirrorClient = &http.Client{Timeout: 10 * time.Minute}
