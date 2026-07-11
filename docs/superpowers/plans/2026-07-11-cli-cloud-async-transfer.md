# CLI Cloud Async Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add account-bound `up`/`down` cloud transfer to the Relayium CLI, reusing the existing zero-knowledge share storage, with device-code login and admin-configurable retention (burn / N-days / N-downloads).

**Architecture:** A new Go `internal/storecrypto` package byte-for-byte mirrors `web/src/lib/store-crypto.ts` so web↔CLI files interoperate. A new `internal/cloud` package holds the CLI-side credential store + up/down HTTP clients. The `internal/account` server gains a device-code auth grant, a `RequireAuth` middleware accepting either the session cookie or a `Bearer rlm_cli_…` token, a generalized download-count retention model, and admin settings for the default retention policy. `cmd/relayium` gets thin `login`/`logout`/`whoami`/`up`/`down` wiring.

**Tech Stack:** Go (stdlib `crypto/aes`+`crypto/cipher` for AES-256-GCM, `net/http`, `database/sql` + SQLite), existing `internal/account` service, Svelte web (test-only touch for the interop vector).

## Global Constraints

- Crypto contract is FROZEN and must match `web/src/lib/store-crypto.ts` exactly: AES-256-GCM, 32-byte key, 12-byte nonce = 4 zero bytes then 64-bit big-endian counter, manifest at seq 0, file chunks at seq 1…, chunk size `192*1024`, frames are `uint32BE(len(ct)) || ct`, `MAX_FRAME_CT = 192*1024 + 16 + 256`, key encoded base64url **no padding**, manifest JSON is `{"files":[{"name":...,"size":...}]}`.
- Upload wire body = `uint32BE(mlen) || encManifest || framedCiphertext` (matches `handleUploadFile` in `internal/account/files.go`).
- `GET /api/files/{id}/meta` returns `encManifest` as **base64 std** (not url); `/blob` returns the raw framed ciphertext stream.
- Settings are stored as `int64` only (`Store.GetSetting/SetSetting`). Encode the retention mode as an int enum: `0=burn, 1=ttl, 2=count`.
- CLI token format: opaque, prefix `rlm_cli_`, stored **hashed** with the existing `hashToken` (sha256 hex). Never store the raw token server-side.
- Tokens/secrets reuse existing helpers: `randToken()` (32 random bytes hex), `hashToken(raw)` (sha256 hex), `newID()` (16 random bytes hex) — all in `internal/account`.
- CLI credentials file: `<configDir>/credentials`, mode `0600`, where `configDir` comes from `resolveConfigDir("")` in `cmd/relayium/daemon.go` (`$XDG_CONFIG_HOME/relayium` or `~/.config/relayium`).
- `down` requires NO login. Only `up` (and future `cloud ls/rm`) require a token. All pre-existing CLI commands must keep working with no credentials.
- Follow existing patterns: table-driven Go tests, `httptest` for handlers (see `internal/account/*_test.go`), server-rendered HTML pages like `admin_templates.go` for the device-approval page.
- Go module root is `server/`; run all Go commands from `/Users/lily/code/relayium/relayium/server`.

---

## File Structure

- `internal/storecrypto/storecrypto.go` — pure crypto mirror of the TS contract (new).
- `internal/storecrypto/storecrypto_test.go` — unit + fixed cross-language vector (new).
- `internal/storecrypto/testdata/vector.json` — shared interop vector (new).
- `web/src/lib/store-crypto.interop.test.ts` — asserts the web side decrypts the same vector (new).
- `internal/account/store.go` — add `Device.Kind`, `StoredFile.MaxDownloads`; new store methods for device-code + cli tokens + retention settings (modify).
- `internal/account/sqlite.go` — migrations for `max_downloads`, `device_kind`, `cli_device_auth`, `cli_tokens` tables; store method impls (modify).
- `internal/account/files.go` — apply retention default/clamp on upload, generalized download-count enforcement on blob GET (modify).
- `internal/account/settings.go` — retention setting keys, `Settings` fields, `clampMaxDownloads`, seed (modify).
- `internal/account/admin.go` + `admin_templates.go` — retention settings form (modify).
- `internal/account/deviceauth.go` — device-code endpoints + service methods (new).
- `internal/account/deviceauth_test.go` — device-code flow tests (new).
- `internal/account/auth.go` — `RequireAuth` (cookie-or-bearer) middleware (new).
- `internal/account/auth_test.go` — bearer/cookie resolution tests (new).
- `internal/account/devicepage.go` — server-rendered `/device` approval page (new).
- `internal/account/handlers.go` — mount new routes; switch `/api/files` to `RequireAuth` (modify).
- `internal/cloud/creds.go` — credential file load/save/clear (new).
- `internal/cloud/login.go` — device-code login driver (new).
- `internal/cloud/transfer.go` — Upload + Download HTTP clients (new).
- `internal/cloud/*_test.go` — client tests against `httptest` (new).
- `cmd/relayium/cloud.go` — `login`/`logout`/`whoami`/`up`/`down` command wiring (new).
- `cmd/relayium/run.go` — dispatch new subcommands + usage text (modify).
- `cmd/relayium/cloud_e2e_test.go` — end-to-end up/down + web-vector interop (new).

---

## Task 1: `internal/storecrypto` — Go crypto mirror

**Files:**
- Create: `server/internal/storecrypto/storecrypto.go`
- Test: `server/internal/storecrypto/storecrypto_test.go`

**Interfaces:**
- Consumes: nothing (stdlib only).
- Produces:
  - `const ChunkSize = 192 * 1024`
  - `const MaxFrameCT = ChunkSize + 16 + 256`
  - `type Manifest struct { Files []FileEntry `json:"files"` }` and `type FileEntry struct { Name string `json:"name"`; Size int64 `json:"size"` }`
  - `func GenerateKey() ([]byte, error)` — 32 random bytes
  - `func EncodeKey(raw []byte) string` / `func DecodeKey(s string) ([]byte, error)` — base64url no padding
  - `func EncryptManifest(key []byte, m Manifest) ([]byte, error)` / `func DecryptManifest(key, ct []byte) (Manifest, error)`
  - `func FrameChunk(key []byte, seq uint64, plaintext []byte) ([]byte, error)` — returns `uint32BE(len)||ct` for one chunk
  - `type Decryptor struct{…}`; `func NewDecryptor(key []byte) *Decryptor`; `func (d *Decryptor) Push(data []byte, emit func([]byte) error) error`; `func (d *Decryptor) End(expected int64) error`; `func (d *Decryptor) DecryptedBytes() int64`

- [ ] **Step 1: Write the failing test (round-trip + nonce discipline)**

```go
package storecrypto

import (
	"bytes"
	"testing"
)

func TestManifestRoundTrip(t *testing.T) {
	key, err := GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	m := Manifest{Files: []FileEntry{{Name: "a.txt", Size: 3}, {Name: "b/c.bin", Size: 5}}}
	ct, err := EncryptManifest(key, m)
	if err != nil {
		t.Fatal(err)
	}
	got, err := DecryptManifest(key, ct)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Files) != 2 || got.Files[1].Name != "b/c.bin" || got.Files[1].Size != 5 {
		t.Fatalf("bad manifest round-trip: %+v", got)
	}
}

func TestChunkStreamRoundTrip(t *testing.T) {
	key, _ := GenerateKey()
	// three chunks of plaintext across a stream (seq starts at 1)
	parts := [][]byte{bytes.Repeat([]byte("x"), 10), bytes.Repeat([]byte("y"), ChunkSize), []byte("tail")}
	var wire bytes.Buffer
	var seq uint64 = 1
	var total int64
	for _, p := range parts {
		fr, err := FrameChunk(key, seq, p)
		if err != nil {
			t.Fatal(err)
		}
		wire.Write(fr)
		seq++
		total += int64(len(p))
	}
	dec := NewDecryptor(key)
	var out bytes.Buffer
	// feed the wire in awkward slices to exercise frame reassembly
	buf := wire.Bytes()
	for i := 0; i < len(buf); i += 7 {
		end := i + 7
		if end > len(buf) {
			end = len(buf)
		}
		if err := dec.Push(buf[i:end], func(pt []byte) error { out.Write(pt); return nil }); err != nil {
			t.Fatal(err)
		}
	}
	if err := dec.End(total); err != nil {
		t.Fatal(err)
	}
	if int64(out.Len()) != total {
		t.Fatalf("got %d bytes, want %d", out.Len(), total)
	}
}

func TestDecryptorRejectsTruncation(t *testing.T) {
	key, _ := GenerateKey()
	fr, _ := FrameChunk(key, 1, []byte("hello"))
	dec := NewDecryptor(key)
	// drop the last 2 bytes → dangling partial frame
	_ = dec.Push(fr[:len(fr)-2], func([]byte) error { return nil })
	if err := dec.End(5); err == nil {
		t.Fatal("expected truncation error, got nil")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && go test ./internal/storecrypto/ -run TestManifest -v`
Expected: FAIL — package/functions undefined.

- [ ] **Step 3: Write the implementation**

```go
// Package storecrypto is the Go mirror of web/src/lib/store-crypto.ts. It MUST
// stay byte-for-byte compatible: a file uploaded from the browser must decrypt
// here and vice versa. AES-256-GCM, nonce = 4 zero bytes then a 64-bit BE
// counter, manifest at seq 0, file chunks at seq 1…, frames are uint32BE(len)||ct.
package storecrypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
)

const ChunkSize = 192 * 1024

// MaxFrameCT caps a single ciphertext frame: a full plaintext chunk + 16-byte
// GCM tag + slack. The length prefix is attacker-controlled, so this bounds how
// much we buffer for one frame.
const MaxFrameCT = ChunkSize + 16 + 256

type FileEntry struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

type Manifest struct {
	Files []FileEntry `json:"files"`
}

func GenerateKey() ([]byte, error) {
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		return nil, err
	}
	return k, nil
}

func EncodeKey(raw []byte) string { return base64.RawURLEncoding.EncodeToString(raw) }

func DecodeKey(s string) ([]byte, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("storecrypto: bad key: %w", err)
	}
	if len(b) != 32 {
		return nil, errors.New("storecrypto: key must be 32 bytes")
	}
	return b, nil
}

func nonce(seq uint64) []byte {
	n := make([]byte, 12)
	binary.BigEndian.PutUint64(n[4:], seq)
	return n
}

func gcm(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func EncryptManifest(key []byte, m Manifest) ([]byte, error) {
	pt, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	a, err := gcm(key)
	if err != nil {
		return nil, err
	}
	return a.Seal(nil, nonce(0), pt, nil), nil
}

func DecryptManifest(key, ct []byte) (Manifest, error) {
	a, err := gcm(key)
	if err != nil {
		return Manifest{}, err
	}
	pt, err := a.Open(nil, nonce(0), ct, nil)
	if err != nil {
		return Manifest{}, err
	}
	var m Manifest
	if err := json.Unmarshal(pt, &m); err != nil {
		return Manifest{}, err
	}
	return m, nil
}

// FrameChunk encrypts one plaintext chunk at seq and returns uint32BE(len)||ct.
func FrameChunk(key []byte, seq uint64, plaintext []byte) ([]byte, error) {
	a, err := gcm(key)
	if err != nil {
		return nil, err
	}
	ct := a.Seal(nil, nonce(seq), plaintext, nil)
	out := make([]byte, 4+len(ct))
	binary.BigEndian.PutUint32(out, uint32(len(ct)))
	copy(out[4:], ct)
	return out, nil
}

// Decryptor reassembles length-prefixed frames across arbitrary chunk
// boundaries and emits decrypted plaintext in order. seq starts at 1.
type Decryptor struct {
	aead cipher.AEAD
	seq  uint64
	buf  []byte
	n    int64
}

func NewDecryptor(key []byte) *Decryptor {
	a, _ := gcm(key) // key length already validated by DecodeKey callers
	return &Decryptor{aead: a, seq: 1}
}

func (d *Decryptor) DecryptedBytes() int64 { return d.n }

func (d *Decryptor) Push(data []byte, emit func([]byte) error) error {
	d.buf = append(d.buf, data...)
	off := 0
	for off+4 <= len(d.buf) {
		l := binary.BigEndian.Uint32(d.buf[off:])
		if int(l) > MaxFrameCT {
			return fmt.Errorf("storecrypto: frame length %d exceeds %d", l, MaxFrameCT)
		}
		if off+4+int(l) > len(d.buf) {
			break // frame incomplete
		}
		ct := d.buf[off+4 : off+4+int(l)]
		pt, err := d.aead.Open(nil, nonce(d.seq), ct, nil)
		if err != nil {
			return fmt.Errorf("storecrypto: decrypt frame %d: %w", d.seq, err)
		}
		d.seq++
		off += 4 + int(l)
		d.n += int64(len(pt))
		if err := emit(pt); err != nil {
			return err
		}
	}
	d.buf = append([]byte(nil), d.buf[off:]...)
	return nil
}

func (d *Decryptor) End(expected int64) error {
	if len(d.buf) != 0 {
		return errors.New("storecrypto: trailing bytes — truncated stream")
	}
	if expected >= 0 && d.n != expected {
		return fmt.Errorf("storecrypto: length mismatch — got %d, expected %d", d.n, expected)
	}
	return nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && go test ./internal/storecrypto/ -v`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add server/internal/storecrypto/
git commit -m "feat(storecrypto): Go mirror of the zero-knowledge store crypto"
```

---

## Task 2: Cross-language interop vector (Go ⇄ web)

Proves the Go and TS implementations produce/consume identical bytes. The vector is a fixed key + known plaintext encrypted by Go; the web test decrypts it, and the Go test decrypts a web-produced copy embedded in the same file.

**Files:**
- Create: `server/internal/storecrypto/testdata/vector.json`
- Modify: `server/internal/storecrypto/storecrypto_test.go`
- Create: `web/src/lib/store-crypto.interop.test.ts`

**Interfaces:**
- Consumes: Task 1's `storecrypto` API; the web `store-crypto.ts` exports.
- Produces: `testdata/vector.json` = `{ "keyB64Url": string, "manifestCtB64Std": string, "chunkFramesB64Std": string, "plaintext": "hello world", "manifest": {...} }`.

- [ ] **Step 1: Write a Go generator test that WRITES the vector, then a checker test that reads it**

Add to `storecrypto_test.go`:

```go
func TestGenerateInteropVector(t *testing.T) {
	if testing.Short() {
		t.Skip()
	}
	// Fixed key so the vector is stable across runs.
	key, err := DecodeKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") // 32 zero bytes
	if err != nil {
		t.Fatal(err)
	}
	m := Manifest{Files: []FileEntry{{Name: "hello.txt", Size: 11}}}
	mct, _ := EncryptManifest(key, m)
	fr, _ := FrameChunk(key, 1, []byte("hello world"))
	vec := map[string]any{
		"keyB64Url":         EncodeKey(key),
		"manifestCtB64Std":  base64.StdEncoding.EncodeToString(mct),
		"chunkFramesB64Std": base64.StdEncoding.EncodeToString(fr),
		"plaintext":         "hello world",
	}
	b, _ := json.MarshalIndent(vec, "", "  ")
	if err := os.WriteFile("testdata/vector.json", b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestInteropVectorRoundTrip(t *testing.T) {
	raw, err := os.ReadFile("testdata/vector.json")
	if err != nil {
		t.Fatal(err)
	}
	var vec struct {
		KeyB64Url         string `json:"keyB64Url"`
		ManifestCtB64Std  string `json:"manifestCtB64Std"`
		ChunkFramesB64Std string `json:"chunkFramesB64Std"`
		Plaintext         string `json:"plaintext"`
	}
	if err := json.Unmarshal(raw, &vec); err != nil {
		t.Fatal(err)
	}
	key, err := DecodeKey(vec.KeyB64Url)
	if err != nil {
		t.Fatal(err)
	}
	mct, _ := base64.StdEncoding.DecodeString(vec.ManifestCtB64Std)
	m, err := DecryptManifest(key, mct)
	if err != nil || len(m.Files) != 1 || m.Files[0].Name != "hello.txt" {
		t.Fatalf("manifest decrypt: %v %+v", err, m)
	}
	frames, _ := base64.StdEncoding.DecodeString(vec.ChunkFramesB64Std)
	dec := NewDecryptor(key)
	var out []byte
	if err := dec.Push(frames, func(pt []byte) error { out = append(out, pt...); return nil }); err != nil {
		t.Fatal(err)
	}
	if err := dec.End(int64(len(vec.Plaintext))); err != nil {
		t.Fatal(err)
	}
	if string(out) != vec.Plaintext {
		t.Fatalf("got %q want %q", out, vec.Plaintext)
	}
}
```

Add imports `encoding/base64`, `encoding/json`, `os` to the test file.

- [ ] **Step 2: Generate the vector and verify the Go checker passes**

Run: `cd server && go test ./internal/storecrypto/ -run 'TestGenerateInteropVector|TestInteropVectorRoundTrip' -v`
Expected: PASS; `testdata/vector.json` now exists.

- [ ] **Step 3: Write the web interop test that decrypts the SAME vector**

`web/src/lib/store-crypto.interop.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeKey, importStoreKey, decryptManifest, StoreDecryptor } from "./store-crypto";

// The vector is produced by the Go side (internal/storecrypto). Decoding it here
// proves the two implementations are wire-compatible.
const vectorPath = fileURLToPath(
  new URL("../../../server/internal/storecrypto/testdata/vector.json", import.meta.url),
);

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

describe("store-crypto Go interop", () => {
  it("decrypts a Go-produced manifest and chunk", async () => {
    const vec = JSON.parse(readFileSync(vectorPath, "utf8"));
    const raw = decodeKey(vec.keyB64Url);
    const key = await importStoreKey(raw);
    const manifest = await decryptManifest(key, b64ToBytes(vec.manifestCtB64Std));
    expect(manifest.files[0].name).toBe("hello.txt");
    const dec = new StoreDecryptor(key);
    let out = new Uint8Array(0);
    for await (const pt of dec.push(b64ToBytes(vec.chunkFramesB64Std))) {
      const merged = new Uint8Array(out.length + pt.length);
      merged.set(out);
      merged.set(pt, out.length);
      out = merged;
    }
    await dec.end(vec.plaintext.length).next();
    expect(new TextDecoder().decode(out)).toBe(vec.plaintext);
  });
});
```

- [ ] **Step 4: Run the web test**

Run: `cd web && npx vitest run src/lib/store-crypto.interop.test.ts`
Expected: PASS. (If `atob` is unavailable in the node test env, use `Buffer.from(b64,"base64")` instead.)

- [ ] **Step 5: Commit**

```bash
git add server/internal/storecrypto/ web/src/lib/store-crypto.interop.test.ts
git commit -m "test(storecrypto): cross-language Go<->web interop vector"
```

---

## Task 3: Server retention — `MaxDownloads` model + enforcement

Generalizes burn-after-read into a download-count limit. `MaxDownloads`: `0` = unlimited until TTL; `N` = delete after the Nth successful download; `1` ≡ burn.

**Files:**
- Modify: `server/internal/account/store.go` (add `StoredFile.MaxDownloads`; interface method `ClaimDownloadSlot`)
- Modify: `server/internal/account/sqlite.go` (migration + method impls)
- Modify: `server/internal/account/files.go` (write `MaxDownloads`; enforce on blob GET)
- Test: `server/internal/account/files_maxdownloads_test.go` (new)

**Interfaces:**
- Consumes: existing `StoredFile`, `GetStoredFile`, `DeleteStoredFile`, `IncDownloadCount`.
- Produces:
  - `StoredFile.MaxDownloads int64`
  - `Store.ClaimDownloadSlot(ctx, id string, at int64) (claimed bool, err error)` — atomically increments `download_count` by 1 only while `download_count < max_downloads` (or `max_downloads = 0` = unlimited), returning `claimed` true when a slot was taken.
  - `Store.ReleaseDownloadSlot(ctx, id string, at int64) error` — decrement `download_count` by 1 (floor 0) to undo a failed delivery.
  - `Store.SpentDownloads(f StoredFile) bool` helper is NOT needed; use `MaxDownloads>0 && DownloadCount>=MaxDownloads` inline.

- [ ] **Step 1: Write the failing test (count enforcement + burn compatibility)**

`files_maxdownloads_test.go` (follow the existing `files_download_test.go` harness — a helper there builds a `Service` with an in-memory SQLite store and a fake blob store; reuse it):

```go
package account

import (
	"context"
	"testing"
)

func TestClaimDownloadSlot_CountLimit(t *testing.T) {
	st := newTestStore(t) // existing helper in the account test suite
	ctx := context.Background()
	f := StoredFile{ID: newID(), UserID: "u1", BlobKey: "b", Size: 1, MaxDownloads: 2, ExpiresAt: 1 << 40, CreatedAt: 1}
	if err := st.CreateStoredFile(ctx, f); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 2; i++ {
		ok, err := st.ClaimDownloadSlot(ctx, f.ID, int64(i))
		if err != nil || !ok {
			t.Fatalf("claim %d: ok=%v err=%v", i, ok, err)
		}
	}
	ok, err := st.ClaimDownloadSlot(ctx, f.ID, 3)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("third claim should fail: max_downloads=2 exhausted")
	}
}

func TestClaimDownloadSlot_Unlimited(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	f := StoredFile{ID: newID(), UserID: "u1", BlobKey: "b", Size: 1, MaxDownloads: 0, ExpiresAt: 1 << 40, CreatedAt: 1}
	_ = st.CreateStoredFile(ctx, f)
	for i := 0; i < 5; i++ {
		ok, err := st.ClaimDownloadSlot(ctx, f.ID, int64(i))
		if err != nil || !ok {
			t.Fatalf("unlimited claim %d must succeed: %v %v", i, ok, err)
		}
	}
}
```

> If `newTestStore` does not yet exist, add a small helper in an existing `_test.go` that opens `OpenSQLite(":memory:")` (see `sqlite_test.go` for how the suite constructs a store) — do NOT invent a new API.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestClaimDownloadSlot -v`
Expected: FAIL — `MaxDownloads`/`ClaimDownloadSlot` undefined.

- [ ] **Step 3a: Add the field + interface method**

In `store.go`, add to `StoredFile`:
```go
	MaxDownloads  int64 // 0 = unlimited until TTL; N = delete after Nth download; 1 = burn-equivalent
```
Add to the `Store` interface near `IncDownloadCount`:
```go
	// ClaimDownloadSlot atomically takes one of a file's remaining download
	// slots: increments download_count only while download_count < max_downloads
	// (max_downloads = 0 means unlimited). Returns claimed=true exactly for the
	// callers that fit under the cap across concurrent requests.
	ClaimDownloadSlot(ctx context.Context, id string, at int64) (claimed bool, err error)
	// ReleaseDownloadSlot undoes a ClaimDownloadSlot after a failed delivery
	// (download_count-1, floored at 0).
	ReleaseDownloadSlot(ctx context.Context, id string, at int64) error
```

- [ ] **Step 3b: Migration + impl in `sqlite.go`**

Follow the existing migration pattern in `sqlite.go` (search for `ALTER TABLE` / the migration list). Add a migration that adds the column with a back-compat default derived from `burn_after_read`:
```sql
ALTER TABLE stored_files ADD COLUMN max_downloads INTEGER NOT NULL DEFAULT 0;
UPDATE stored_files SET max_downloads = 1 WHERE burn_after_read = 1;
```
Update the `CreateStoredFile` INSERT and `GetStoredFile`/`ListStoredFilesByUser`/`ListExpiredStoredFiles` SELECTs to include `max_downloads`. Implement:
```go
func (s *SQLiteStore) ClaimDownloadSlot(ctx context.Context, id string, at int64) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE stored_files
		    SET download_count = download_count + 1,
		        downloaded_at = ?
		  WHERE id = ?
		    AND (max_downloads = 0 OR download_count < max_downloads)`,
		at, id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

func (s *SQLiteStore) ReleaseDownloadSlot(ctx context.Context, id string, at int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE stored_files SET download_count = MAX(download_count - 1, 0) WHERE id = ?`, id)
	return err
}
```
> Use `s.db` (the write pool). Match the exact receiver/field names already used by neighboring methods in `sqlite.go`.

- [ ] **Step 3c: Enforce on blob GET in `files.go`**

Replace the burn-only claim block in `handleFileBlob` with a unified claim. A file with `MaxDownloads == 0` needs no pre-claim (unlimited); otherwise claim a slot before streaming and delete on the final slot. Concretely, in `handleFileBlob`, after `bs.Get` succeeds:
```go
	// Retention: unlimited files (max_downloads==0) stream freely. Limited files
	// claim a slot BEFORE streaming so an offline node never spends a shot;
	// concurrent GETs race on ClaimDownloadSlot and only winners stream.
	limited := sf.MaxDownloads > 0
	var claimAt int64
	if limited {
		claimAt = s.now().Unix()
		claimed, cerr := s.store.ClaimDownloadSlot(r.Context(), sf.ID, claimAt)
		if cerr != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if !claimed {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
	}
```
Change the incomplete-delivery branch to release when `limited`:
```go
	if err != nil || n != sf.Size {
		if limited {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = s.store.ReleaseDownloadSlot(ctx, sf.ID, claimAt)
			cancel()
		}
		return
	}
```
And on success, delete when the last slot is spent:
```go
	if limited {
		// Re-read to see the post-claim count (this request already incremented it).
		if cur, gerr := s.store.GetStoredFile(r.Context(), sf.ID); gerr == nil &&
			cur.MaxDownloads > 0 && cur.DownloadCount >= cur.MaxDownloads {
			if derr := bs.Delete(r.Context(), sf.BlobKey); derr != nil {
				_ = s.store.EnqueueNodeDelete(r.Context(), sf.BlobKey, sf.NodeID, s.now().Unix())
			}
			_ = s.store.DeleteStoredFile(r.Context(), sf.ID)
		}
	}
```
Remove the now-superseded `sf.BurnAfterRead` claim/delete branches. Update `liveFile` so a spent limited file 404s:
```go
	if sf.MaxDownloads > 0 && sf.DownloadCount >= sf.MaxDownloads {
		return StoredFile{}, false
	}
```
> Keep `BurnAfterRead` in the struct and DB for back-compat, but drive all runtime logic off `MaxDownloads` (burn normalizes to `MaxDownloads=1` at upload — Task 4). `ClaimBurnDownload`/`ReleaseBurnDownload` may remain for now; the blob path no longer calls them.

- [ ] **Step 4: Run to verify pass**

Run: `cd server && go test ./internal/account/ -run 'TestClaimDownloadSlot|TestFile' -v`
Expected: PASS. Also run the full package to catch regressions: `go test ./internal/account/`.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/
git commit -m "feat(files): generalize burn-after-read into max-downloads retention"
```

---

## Task 4: Server retention — admin default + per-upload clamp

**Files:**
- Modify: `server/internal/account/settings.go`
- Modify: `server/internal/account/files.go` (apply default + clamp on upload)
- Modify: `server/internal/account/admin.go` + `admin_templates.go`
- Test: `server/internal/account/settings_retention_test.go` (new)

**Interfaces:**
- Consumes: `Settings`, `settingOr`, `clampTTL`, upload handler.
- Produces:
  - Setting keys: `SettingDefaultRetention = "default_retention"` (0=burn,1=ttl,2=count), `SettingDefaultMaxDownloads = "default_max_downloads"`, `SettingMaxMaxDownloads = "max_max_downloads"`.
  - `Settings` fields `DefaultRetention, DefaultMaxDownloads, MaxMaxDownloads int64`.
  - `func clampMaxDownloads(req int64, st Settings) int64`.
  - `func resolveRetention(reqBurn bool, reqTTL, reqMaxDL int64, st Settings) (ttl, maxDL int64)` — the single place upload turns request params + admin defaults into the stored `(ExpiresAt-delta, MaxDownloads)`.

- [ ] **Step 1: Write the failing test**

```go
func TestResolveRetention_DefaultBurn(t *testing.T) {
	st := Settings{DefaultRetention: 0, DefaultTTL: 3600, MaxTTL: 86400, DefaultMaxDownloads: 5, MaxMaxDownloads: 100}
	ttl, maxDL := resolveRetention(false, 0, 0, st) // nothing requested → admin default = burn
	if maxDL != 1 {
		t.Fatalf("burn default should yield maxDL=1, got %d", maxDL)
	}
	if ttl != 3600 {
		t.Fatalf("ttl should still default, got %d", ttl)
	}
}

func TestResolveRetention_ExplicitCountClamped(t *testing.T) {
	st := Settings{DefaultRetention: 0, DefaultTTL: 3600, MaxTTL: 86400, DefaultMaxDownloads: 5, MaxMaxDownloads: 10}
	_, maxDL := resolveRetention(false, 0, 999, st) // request 999 downloads → clamp to 10
	if maxDL != 10 {
		t.Fatalf("expected clamp to 10, got %d", maxDL)
	}
}

func TestResolveRetention_ExplicitBurnWins(t *testing.T) {
	st := Settings{DefaultRetention: 2, DefaultTTL: 3600, MaxTTL: 86400, DefaultMaxDownloads: 5, MaxMaxDownloads: 10}
	_, maxDL := resolveRetention(true, 0, 0, st) // --burn overrides count default
	if maxDL != 1 {
		t.Fatalf("explicit burn should yield maxDL=1, got %d", maxDL)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestResolveRetention -v`
Expected: FAIL — undefined.

- [ ] **Step 3: Implement settings + resolve + seed + upload wiring**

In `settings.go` add the constants, `Settings` fields, `settingOr` reads in `resolveSettings`, seed entries in `SeedSettings` (defaults: `SettingDefaultRetention`→0, `SettingDefaultMaxDownloads`→5, `SettingMaxMaxDownloads`→100 — pull from new `Config` fields with those fallbacks), and:
```go
const (
	SettingDefaultRetention    = "default_retention"     // 0=burn 1=ttl 2=count
	SettingDefaultMaxDownloads = "default_max_downloads"
	SettingMaxMaxDownloads     = "max_max_downloads"
)

const (
	retentionBurn  = 0
	retentionTTL   = 1
	retentionCount = 2
)

func clampMaxDownloads(req int64, st Settings) int64 {
	if req <= 0 {
		req = st.DefaultMaxDownloads
	}
	if req < 1 {
		req = 1
	}
	if st.MaxMaxDownloads > 0 && req > st.MaxMaxDownloads {
		req = st.MaxMaxDownloads
	}
	return req
}

// resolveRetention turns request params + admin settings into stored TTL seconds
// and MaxDownloads. Explicit request params always win over the admin default,
// then are clamped to admin bounds.
func resolveRetention(reqBurn bool, reqTTL, reqMaxDL int64, st Settings) (ttl, maxDL int64) {
	switch {
	case reqBurn:
		maxDL = 1
	case reqMaxDL > 0:
		maxDL = clampMaxDownloads(reqMaxDL, st)
	case reqTTL > 0:
		maxDL = 0 // unlimited within the (clamped) TTL
	default: // nothing requested → apply admin default policy
		switch st.DefaultRetention {
		case retentionBurn:
			maxDL = 1
		case retentionCount:
			maxDL = clampMaxDownloads(0, st)
		default: // retentionTTL
			maxDL = 0
		}
	}
	ttl = clampTTL(reqTTL, st)
	return ttl, maxDL
}
```

In `files.go` `handleUploadFile`, replace the `burn`/`ttl` derivation with:
```go
	burn := r.URL.Query().Get("burnAfterRead") == "1"
	reqTTL, _ := strconv.ParseInt(r.URL.Query().Get("ttl"), 10, 64)
	reqMaxDL, _ := strconv.ParseInt(r.URL.Query().Get("maxDownloads"), 10, 64)
	ttl, maxDL := resolveRetention(burn, reqTTL, reqMaxDL, st)
```
and set on the row:
```go
	sf := StoredFile{
		ID: id, UserID: u.ID, BlobKey: blobKey, EncManifest: encManifest,
		Size: size, BurnAfterRead: maxDL == 1, MaxDownloads: maxDL,
		CreatedAt: now, ExpiresAt: now + ttl, NodeID: nodeID,
	}
```

Add the `Config` fields (`DefaultRetention, DefaultMaxDownloads, MaxMaxDownloads int64`) next to the existing limit fields in `service.go`'s `Config` struct so seeding has fallbacks.

- [ ] **Step 4: Run to verify pass**

Run: `cd server && go test ./internal/account/ -run TestResolveRetention -v && go test ./internal/account/`
Expected: PASS.

- [ ] **Step 5: Admin form**

In `handleAdminSettings` (`admin.go`), parse three new form fields: `default_retention` (0/1/2, allow 0 so don't use the `>0`-requiring `atoi`), `default_max_downloads`, `max_max_downloads`; `SetSetting` them. In `admin_templates.go` `adminSettingsView` add the fields and render a `<select name="default_retention">` (阅后即焚/保存N天/限定次数) plus two number inputs, inside the existing settings `<form>`. Extend the handler's view-builder to populate them from `resolveSettings`.

- [ ] **Step 6: Commit**

```bash
git add server/internal/account/
git commit -m "feat(admin): configurable default retention policy + per-upload clamp"
```

---

## Task 5: Server — device-code + CLI-token store

**Files:**
- Modify: `server/internal/account/store.go` (`Device.Kind`; new types + interface methods)
- Modify: `server/internal/account/sqlite.go` (migrations + impls)
- Test: `server/internal/account/deviceauth_store_test.go` (new)

**Interfaces:**
- Produces:
  - `Device.Kind string` (`""`/`"browser"` default, `"cli"`).
  - `type DeviceAuthRequest struct { UserCode string; DeviceCodeHash string; Status string; UserID string; TokenHash string; CreatedAt, ExpiresAt, ConsumedAt int64 }` (`Status` ∈ `pending|approved|denied`).
  - `type CLIToken struct { TokenHash, UserID, DeviceID string; CreatedAt, LastSeenAt int64 }`.
  - `Store.CreateDeviceAuth(ctx, DeviceAuthRequest) error`
  - `Store.GetDeviceAuthByUserCode(ctx, userCode string) (DeviceAuthRequest, bool, error)`
  - `Store.GetDeviceAuthByCodeHash(ctx, hash string) (DeviceAuthRequest, bool, error)`
  - `Store.ApproveDeviceAuth(ctx, userCode, userID, tokenHash, rawToken string, at int64) (ok bool, err error)` — pending→approved atomically; stashes the raw one-time token in `pending_token`.
  - `Store.ConsumeDeviceAuth(ctx, codeHash string, at int64) (rawToken string, ok bool, err error)` — approved→consumed exactly once, returning and blanking `pending_token`.
  - `Store.CreateCLIToken(ctx, CLIToken) error`
  - `Store.GetCLITokenUser(ctx, tokenHash string) (userID, deviceID string, ok bool, err error)`
  - `Store.TouchCLIToken(ctx, tokenHash string, at int64) error`
  - `Store.DeleteExpiredDeviceAuth(ctx, now int64) error`

- [ ] **Step 1: Write the failing store test**

```go
func TestDeviceAuthApproveConsumeOnce(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	req := DeviceAuthRequest{UserCode: "WDJB-MJHT", DeviceCodeHash: hashToken("dev"), Status: "pending", CreatedAt: 1, ExpiresAt: 1 << 40}
	if err := st.CreateDeviceAuth(ctx, req); err != nil {
		t.Fatal(err)
	}
	ok, err := st.ApproveDeviceAuth(ctx, "WDJB-MJHT", "u1", hashToken("tok"), "rlm_cli_raw", 2)
	if err != nil || !ok {
		t.Fatalf("approve: %v %v", ok, err)
	}
	// second approve on same code must fail (already approved)
	ok2, _ := st.ApproveDeviceAuth(ctx, "WDJB-MJHT", "u1", hashToken("tok"), "rlm_cli_raw", 3)
	if ok2 {
		t.Fatal("double approve should fail")
	}
	tok1, c1, _ := st.ConsumeDeviceAuth(ctx, hashToken("dev"), 4)
	_, c2, _ := st.ConsumeDeviceAuth(ctx, hashToken("dev"), 5)
	if !c1 || c2 || tok1 != "rlm_cli_raw" {
		t.Fatalf("consume should succeed once with token: tok=%q c1=%v c2=%v", tok1, c1, c2)
	}
}

func TestCLITokenLookup(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	_ = st.CreateCLIToken(ctx, CLIToken{TokenHash: hashToken("t"), UserID: "u1", DeviceID: "d1", CreatedAt: 1})
	uid, did, ok, err := st.GetCLITokenUser(ctx, hashToken("t"))
	if err != nil || !ok || uid != "u1" || did != "d1" {
		t.Fatalf("lookup: %v %v %q %q", ok, err, uid, did)
	}
	_, _, ok2, _ := st.GetCLITokenUser(ctx, hashToken("nope"))
	if ok2 {
		t.Fatal("unknown token must not resolve")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && go test ./internal/account/ -run 'TestDeviceAuth|TestCLIToken' -v`
Expected: FAIL — undefined types/methods.

- [ ] **Step 3: Add types, interface methods, migrations, impls**

Add `Kind string` to `Device`. Add the two structs and interface methods above. In `sqlite.go` add migrations (follow the existing migration list pattern):
```sql
ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS cli_device_auth (
  user_code TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL DEFAULT '',
  pending_token TEXT NOT NULL DEFAULT '', -- raw one-time token, held only between approve and the next poll
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cli_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(device_id) REFERENCES devices(id)
);
```
Implement each method. `ApproveDeviceAuth`/`ConsumeDeviceAuth` use conditional UPDATEs and check `RowsAffected()==1`:
```go
func (s *SQLiteStore) ApproveDeviceAuth(ctx context.Context, userCode, userID, tokenHash, rawToken string, at int64) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE cli_device_auth SET status='approved', user_id=?, token_hash=?, pending_token=?
		  WHERE user_code=? AND status='pending' AND expires_at > ?`,
		userID, tokenHash, rawToken, userCode, at)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// ConsumeDeviceAuth marks an approved request consumed exactly once and returns
// the raw one-time token, blanking pending_token so it never lingers at rest.
func (s *SQLiteStore) ConsumeDeviceAuth(ctx context.Context, codeHash string, at int64) (string, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", false, err
	}
	defer tx.Rollback()
	var raw string
	err = tx.QueryRowContext(ctx,
		`SELECT pending_token FROM cli_device_auth
		  WHERE device_code_hash=? AND status='approved' AND consumed_at=0`, codeHash).Scan(&raw)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE cli_device_auth SET consumed_at=?, pending_token='' WHERE device_code_hash=?`,
		at, codeHash); err != nil {
		return "", false, err
	}
	if err := tx.Commit(); err != nil {
		return "", false, err
	}
	return raw, true, nil
}
```
Update `UpsertDevice`/`ListDevices` SELECT/INSERT to carry `kind`.

- [ ] **Step 4: Run to verify pass**

Run: `cd server && go test ./internal/account/ -run 'TestDeviceAuth|TestCLIToken' -v && go test ./internal/account/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/
git commit -m "feat(account): device-code + CLI-token persistence"
```

---

## Task 6: Server — device-code endpoints

**Files:**
- Create: `server/internal/account/deviceauth.go`
- Modify: `server/internal/account/handlers.go` (mount routes)
- Test: `server/internal/account/deviceauth_test.go`

**Interfaces:**
- Consumes: Task 5 store methods; `randToken`, `hashToken`, `newID`, `UpsertDevice`, `writeJSON`, `RequireSession`, `s.cfg.BaseURL`, `s.now()`.
- Produces routes:
  - `POST /api/cli/device/start` → `{user_code, verification_uri, interval, expires_in}` (also returns opaque `device_code` for the CLI to poll with).
  - `POST /api/cli/device/poll` body `{device_code}` → `{status:"authorization_pending"}` | `{status:"slow_down"}` | `{status:"expired"}` | `{status:"denied"}` | `{status:"ok", access_token, account_email}`.
  - `POST /api/cli/device/approve` (session) body `{user_code}` → `{status:"ok", account_email}`; used by the web page.
  - Helper `func genUserCode() string` → e.g. `WDJB-MJHT` from alphabet `BCDFGHJKLMNPQRSTVWXZ23456789` (no vowels, no 0/O/1/I).
  - `deviceCodeTTL = 10 * time.Minute`, `devicePollInterval = 5` (seconds).

- [ ] **Step 1: Write the failing flow test**

```go
func TestDeviceCodeFlow(t *testing.T) {
	s := newTestService(t) // existing helper building a Service with in-mem store
	// start
	start := doJSON(t, s, "POST", "/api/cli/device/start", "", nil)
	userCode := start["user_code"].(string)
	deviceCode := start["device_code"].(string)
	// poll before approval → pending
	p1 := doPoll(t, s, deviceCode)
	if p1["status"] != "authorization_pending" {
		t.Fatalf("want pending, got %v", p1["status"])
	}
	// create a user + session, approve via the session-authed endpoint
	u := mustUser(t, s, "a@example.com")
	sess := mustSession(t, s, u.ID)
	approveWithSession(t, s, sess, userCode)
	// poll after approval → ok + token
	p2 := doPoll(t, s, deviceCode)
	if p2["status"] != "ok" || p2["access_token"] == "" {
		t.Fatalf("want ok+token, got %+v", p2)
	}
	// second poll → already consumed (denied/expired path, not a second token)
	p3 := doPoll(t, s, deviceCode)
	if p3["status"] == "ok" {
		t.Fatal("token must be issued only once")
	}
}
```
> Reuse whatever request helpers the account test suite already defines (see `handlers_test.go`). If none fit, add tiny local helpers that build `httptest` requests against `s.Routes()`. Do not change production signatures for tests.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestDeviceCodeFlow -v`
Expected: FAIL — routes not mounted.

- [ ] **Step 3: Implement `deviceauth.go` and mount routes**

Implement the three handlers plus `genUserCode`.

- `handleDeviceStart`: mint `deviceCode := randToken()` and a `userCode := genUserCode()`; `CreateDeviceAuth(DeviceAuthRequest{UserCode: userCode, DeviceCodeHash: hashToken(deviceCode), Status: "pending", CreatedAt: now, ExpiresAt: now + int64(deviceCodeTTL.Seconds())})`; respond `{user_code, device_code, verification_uri: s.cfg.BaseURL + "/device", interval: devicePollInterval, expires_in: int(deviceCodeTTL.Seconds())}`.
- `handleDeviceApprove(w, r, u)` (session): read `user_code`; mint `raw := "rlm_cli_" + randToken()`; `dev, _ := s.store.UpsertDevice(ctx, Device{ID: newID(), UserID: u.ID, Name: "CLI", Kind: "cli", CreatedAt: now})`; `s.store.CreateCLIToken(ctx, CLIToken{TokenHash: hashToken(raw), UserID: u.ID, DeviceID: dev.ID, CreatedAt: now})`; `ok, _ := s.store.ApproveDeviceAuth(ctx, userCode, u.ID, hashToken(raw), raw, now)`; if `!ok` → 400 (expired/unknown/already used); else `{status:"ok", account_email: u.Email}`.
- `handleDevicePoll`: read `device_code`; `req, ok, _ := s.store.GetDeviceAuthByCodeHash(ctx, hashToken(deviceCode))`; if `!ok` or `now >= req.ExpiresAt` → `{status:"expired"}`; `denied` → `{status:"denied"}`; `pending` → `{status:"authorization_pending"}`; `approved` → `raw, consumed, _ := s.store.ConsumeDeviceAuth(ctx, hashToken(deviceCode), now)`; if `consumed` → `{status:"ok", access_token: raw, account_email: <lookup by req.UserID>}`, else (already consumed) → `{status:"expired"}`.

The raw token lives in `pending_token` only between approve and the next poll, then `ConsumeDeviceAuth` erases it (Task 5).

Mount in `routeMux()` (all before `registerFileRoutes`):
```go
	mux.HandleFunc("POST /api/cli/device/start", s.handleDeviceStart)
	mux.HandleFunc("POST /api/cli/device/poll", s.handleDevicePoll)
	mux.HandleFunc("POST /api/cli/device/approve", s.RequireSession(s.handleDeviceApprove))
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server && go test ./internal/account/ -run TestDeviceCodeFlow -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/
git commit -m "feat(account): device-code authorization endpoints"
```

---

## Task 7: Server — `RequireAuth` (cookie-or-bearer) + protect `/api/files`

**Files:**
- Create: `server/internal/account/auth.go`
- Modify: `server/internal/account/files.go` (`registerFileRoutes` uses `RequireAuth`)
- Test: `server/internal/account/auth_test.go`

**Interfaces:**
- Consumes: `UserFromRequest` (cookie), Task 5 `GetCLITokenUser`/`TouchCLIToken`, `GetUserByID`.
- Produces: `func (s *Service) RequireAuth(next func(http.ResponseWriter, *http.Request, User)) http.HandlerFunc` — resolves the user from the session cookie OR `Authorization: Bearer rlm_cli_…`; 401 otherwise; touches `last_seen_at` on bearer.

- [ ] **Step 1: Write the failing test**

```go
func TestRequireAuthBearer(t *testing.T) {
	s := newTestService(t)
	u := mustUser(t, s, "a@example.com")
	raw := "rlm_cli_" + randTokenForTest()
	dev, _ := s.store.UpsertDevice(context.Background(), Device{ID: newID(), UserID: u.ID, Name: "cli", Kind: "cli", CreatedAt: 1})
	_ = s.store.CreateCLIToken(context.Background(), CLIToken{TokenHash: hashToken(raw), UserID: u.ID, DeviceID: dev.ID, CreatedAt: 1})

	var gotUser string
	h := s.RequireAuth(func(w http.ResponseWriter, r *http.Request, usr User) { gotUser = usr.ID; w.WriteHeader(200) })

	// bearer accepted
	req := httptest.NewRequest("GET", "/x", nil)
	req.Header.Set("Authorization", "Bearer "+raw)
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != 200 || gotUser != u.ID {
		t.Fatalf("bearer: code=%d user=%q", rec.Code, gotUser)
	}
	// bad bearer rejected
	req2 := httptest.NewRequest("GET", "/x", nil)
	req2.Header.Set("Authorization", "Bearer rlm_cli_nope")
	rec2 := httptest.NewRecorder()
	h(rec2, req2)
	if rec2.Code != 401 {
		t.Fatalf("bad bearer should 401, got %d", rec2.Code)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestRequireAuthBearer -v`
Expected: FAIL — `RequireAuth` undefined.

- [ ] **Step 3: Implement `RequireAuth` and switch file routes**

```go
package account

import (
	"net/http"
	"strings"
)

func (s *Service) RequireAuth(next func(http.ResponseWriter, *http.Request, User)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if u, ok := s.UserFromRequest(r); ok { // session cookie
			next(w, r, u)
			return
		}
		const p = "Bearer "
		h := r.Header.Get("Authorization")
		if strings.HasPrefix(h, p) {
			raw := strings.TrimSpace(h[len(p):])
			uid, _, ok, err := s.store.GetCLITokenUser(r.Context(), hashToken(raw))
			if err == nil && ok {
				u, gerr := s.store.GetUserByID(r.Context(), uid)
				if gerr == nil {
					_ = s.store.TouchCLIToken(r.Context(), hashToken(raw), s.now().Unix())
					next(w, r, u)
					return
				}
			}
		}
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}
}
```
In `files.go` `registerFileRoutes`, change upload/list/delete from `s.RequireSession` to `s.RequireAuth`. Leave meta/blob public.

- [ ] **Step 4: Run to verify pass**

Run: `cd server && go test ./internal/account/ -run TestRequireAuthBearer -v && go test ./internal/account/`
Expected: PASS (existing cookie-based file tests still green because `RequireAuth` accepts cookies).

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/
git commit -m "feat(account): RequireAuth cookie-or-bearer; CLI can use /api/files"
```

---

## Task 8: Server — `/device` approval page

**Files:**
- Create: `server/internal/account/devicepage.go`
- Modify: `server/internal/account/handlers.go` (mount `GET /device`)
- Test: `server/internal/account/devicepage_test.go`

**Interfaces:**
- Consumes: `UserFromRequest`, `s.cfg.BaseURL`.
- Produces: `GET /device` — if no session, render a "please sign in first" page linking to `/`; if session, render a form (`POST /api/cli/device/approve`, field `user_code`, prefillable via `?code=WDJB-MJHT`) showing the account email that will be bound. Server-rendered HTML (like `admin_templates.go`), CSRF-guarded consistently with other POSTs (the mux is wrapped by `csrfGuard`; the form must include the same CSRF token mechanism the admin/settings forms use — mirror `admin.go`'s form).

- [ ] **Step 1: Write the failing test**

```go
func TestDevicePageRequiresSession(t *testing.T) {
	s := newTestService(t)
	req := httptest.NewRequest("GET", "/device", nil)
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "sign in") {
		t.Fatalf("anon /device should prompt sign-in, code=%d", rec.Code)
	}
}

func TestDevicePageShowsFormWhenAuthed(t *testing.T) {
	s := newTestService(t)
	u := mustUser(t, s, "a@example.com")
	sess := mustSession(t, s, u.ID)
	req := httptest.NewRequest("GET", "/device?code=WDJB-MJHT", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: sess.ID})
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)
	body := rec.Body.String()
	if !strings.Contains(body, "a@example.com") || !strings.Contains(body, "WDJB-MJHT") {
		t.Fatalf("authed /device should show email + prefilled code")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestDevicePage -v`
Expected: FAIL — route not mounted.

- [ ] **Step 3: Implement the page + mount**

Implement `handleDevicePage` rendering the two states. Mount `mux.HandleFunc("GET /device", s.handleDevicePage)` in `routeMux()`. Match the CSRF token approach used by the admin settings form so the subsequent `POST /api/cli/device/approve` passes `csrfGuard`.

- [ ] **Step 4: Run to verify pass**

Run: `cd server && go test ./internal/account/ -run TestDevicePage -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/
git commit -m "feat(account): /device browser approval page for CLI login"
```

---

## Task 9: CLI — `internal/cloud` credentials store

**Files:**
- Create: `server/internal/cloud/creds.go`
- Test: `server/internal/cloud/creds_test.go`

**Interfaces:**
- Produces:
  - `type Creds struct { Server string `json:"server"`; AccessToken string `json:"access_token"`; AccountEmail string `json:"account_email"` }`
  - `func Load(configDir string) (Creds, bool, error)` — reads `<configDir>/credentials`; `ok=false` if absent.
  - `func Save(configDir string, c Creds) error` — writes `0600`, creating `configDir` `0700`.
  - `func Clear(configDir string) error` — removes the file (no error if absent).
  - `const credsFile = "credentials"`

- [ ] **Step 1: Write the failing test**

```go
package cloud

import (
	"testing"
)

func TestCredsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	if _, ok, _ := Load(dir); ok {
		t.Fatal("expected no creds initially")
	}
	c := Creds{Server: "https://relayium.com", AccessToken: "rlm_cli_x", AccountEmail: "a@example.com"}
	if err := Save(dir, c); err != nil {
		t.Fatal(err)
	}
	got, ok, err := Load(dir)
	if err != nil || !ok || got != c {
		t.Fatalf("round-trip: %v %v %+v", ok, err, got)
	}
	if err := Clear(dir); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := Load(dir); ok {
		t.Fatal("expected cleared")
	}
}

func TestSavePermissions(t *testing.T) {
	dir := t.TempDir()
	_ = Save(dir, Creds{Server: "s", AccessToken: "t"})
	fi, err := os.Stat(filepath.Join(dir, credsFile))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("want 0600, got %o", fi.Mode().Perm())
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && go test ./internal/cloud/ -run TestCreds -v`
Expected: FAIL — undefined.

- [ ] **Step 3: Implement `creds.go`**

```go
// Package cloud is the CLI-side client for account-bound cloud transfer:
// credential storage, device-code login, and up/down over HTTP.
package cloud

import (
	"encoding/json"
	"os"
	"path/filepath"
)

const credsFile = "credentials"

type Creds struct {
	Server       string `json:"server"`
	AccessToken  string `json:"access_token"`
	AccountEmail string `json:"account_email"`
}

func Load(configDir string) (Creds, bool, error) {
	b, err := os.ReadFile(filepath.Join(configDir, credsFile))
	if os.IsNotExist(err) {
		return Creds{}, false, nil
	}
	if err != nil {
		return Creds{}, false, err
	}
	var c Creds
	if err := json.Unmarshal(b, &c); err != nil {
		return Creds{}, false, err
	}
	return c, true, nil
}

func Save(configDir string, c Creds) error {
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(configDir, credsFile), b, 0o600)
}

func Clear(configDir string) error {
	err := os.Remove(filepath.Join(configDir, credsFile))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
```
Add `os`, `path/filepath` imports to the test.

- [ ] **Step 4: Run to verify pass**

Run: `cd server && go test ./internal/cloud/ -run TestCreds -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/cloud/
git commit -m "feat(cloud): CLI credential store"
```

---

## Task 10: CLI — device-code login driver

**Files:**
- Create: `server/internal/cloud/login.go`
- Test: `server/internal/cloud/login_test.go`

**Interfaces:**
- Consumes: Task 6 endpoints; `net/http`.
- Produces:
  - `type Client struct { Server string; HTTP *http.Client; Token string }`
  - `func NewClient(server string) *Client`
  - `type DeviceStart struct { UserCode, VerificationURI, DeviceCode string; Interval, ExpiresIn int }`
  - `func (c *Client) DeviceStart(ctx) (DeviceStart, error)`
  - `func (c *Client) DevicePoll(ctx, deviceCode string) (status, accessToken, email string, err error)`
  - `func (c *Client) Login(ctx, notify func(DeviceStart)) (Creds, error)` — starts, calls `notify` so the caller prints the code+URL, then polls at `Interval` (honoring `slow_down`) until `ok`/`expired`/`denied`/timeout.

- [ ] **Step 1: Write the failing test (against an httptest fake server)**

```go
func TestLoginPollsUntilApproved(t *testing.T) {
	polls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/cli/device/start":
			writeJSONTest(w, map[string]any{"user_code": "WDJB-MJHT", "device_code": "dc", "verification_uri": "http://x/device", "interval": 0, "expires_in": 60})
		case "/api/cli/device/poll":
			polls++
			if polls < 2 {
				writeJSONTest(w, map[string]any{"status": "authorization_pending"})
			} else {
				writeJSONTest(w, map[string]any{"status": "ok", "access_token": "rlm_cli_t", "account_email": "a@example.com"})
			}
		}
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	var shown DeviceStart
	creds, err := c.Login(context.Background(), func(d DeviceStart) { shown = d })
	if err != nil {
		t.Fatal(err)
	}
	if shown.UserCode != "WDJB-MJHT" || creds.AccessToken != "rlm_cli_t" || creds.AccountEmail != "a@example.com" {
		t.Fatalf("bad login result: shown=%+v creds=%+v", shown, creds)
	}
}
```
(`writeJSONTest` is a 2-line local test helper.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && go test ./internal/cloud/ -run TestLogin -v`
Expected: FAIL — undefined.

- [ ] **Step 3: Implement `login.go`**

Implement `Client`, the two request wrappers (POST JSON, decode), and `Login` looping with `time.Sleep(max(interval,1)*time.Second)` between polls (treat `interval==0` as 1s in tests via a `max(interval,1)`), stopping on `ok`/`expired`/`denied` or when `ExpiresIn` elapses. `slow_down` bumps the interval by 5s.

- [ ] **Step 4: Run to verify pass**

Run: `cd server && go test ./internal/cloud/ -run TestLogin -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/cloud/
git commit -m "feat(cloud): device-code login driver"
```

---

## Task 11: CLI — `login` / `logout` / `whoami` commands

**Files:**
- Create: `server/cmd/relayium/cloud.go`
- Modify: `server/cmd/relayium/run.go` (dispatch + usage)
- Test: `server/cmd/relayium/cloud_login_test.go`

**Interfaces:**
- Consumes: `internal/cloud` (`Client`, `Load/Save/Clear`), `resolveConfigDir`.
- Produces: `func runLogin(args []string, stdout, stderr io.Writer) int`, `runLogout`, `runWhoami`. Default server = `defaultCloudServer = "https://relayium.com"`; `--server` overrides.

- [ ] **Step 1: Write the failing test**

```go
func TestWhoamiNotLoggedIn(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir) // resolveConfigDir uses this
	var out bytes.Buffer
	code := runWhoami(nil, &out, &out)
	if code == 0 || !strings.Contains(out.String(), "not logged in") {
		t.Fatalf("want not-logged-in, code=%d out=%q", code, out.String())
	}
}

func TestWhoamiAfterSave(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	cfgDir, _ := resolveConfigDir("")
	_ = cloud.Save(cfgDir, cloud.Creds{Server: "https://relayium.com", AccountEmail: "a@example.com", AccessToken: "t"})
	var out bytes.Buffer
	if code := runWhoami(nil, &out, &out); code != 0 || !strings.Contains(out.String(), "a@example.com") {
		t.Fatalf("want email, code=%d out=%q", code, out.String())
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && go test ./cmd/relayium/ -run TestWhoami -v`
Expected: FAIL — undefined.

- [ ] **Step 3: Implement commands + dispatch**

Implement `runLogin` (parse `--server`; `cloud.NewClient(server).Login(ctx, printFn)` where `printFn` writes `打开 <uri> 输入码: <user_code>`; on success `cloud.Save`), `runLogout` (best-effort server revoke then `cloud.Clear`), `runWhoami`. In `run.go` add cases `"login"`, `"logout"`, `"whoami"` and extend the `usage` text.

- [ ] **Step 4: Run to verify pass**

Run: `cd server && go test ./cmd/relayium/ -run TestWhoami -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/cmd/relayium/
git commit -m "feat(cli): login/logout/whoami commands"
```

---

## Task 12: CLI — `up` (encrypt + upload)

**Files:**
- Modify: `server/internal/cloud/transfer.go` (Upload)
- Modify: `server/cmd/relayium/cloud.go` (`runUp`)
- Modify: `server/cmd/relayium/run.go` (dispatch `up`)
- Test: `server/internal/cloud/transfer_upload_test.go`

**Interfaces:**
- Consumes: `internal/storecrypto`, `Client` (with `Token`), the server upload wire format.
- Produces:
  - `type UploadOpts struct { Burn bool; TTLSeconds int64; MaxDownloads int64 }`
  - `func (c *Client) Upload(ctx, paths []string, opt UploadOpts) (id, keyB64Url string, err error)` — walks paths → `storecrypto.Manifest`, generates key, streams `uint32BE(mlen)||encManifest||frames` to `POST {Server}/api/files?...` with `Authorization: Bearer {Token}`; parses `{id}` from the JSON response.
  - `func (c *Client) DownloadLink(origin, id, keyB64Url string) string` → `origin + "/d/" + id + "#" + keyB64Url`.

- [ ] **Step 1: Write the failing test (upload posts the exact wire format the server expects)**

```go
func TestUploadWireFormat(t *testing.T) {
	var body []byte
	var auth, query string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		query = r.URL.RawQuery
		body, _ = io.ReadAll(r.Body)
		writeJSONTest(w, map[string]any{"id": "abc123", "expiresAt": 999})
	}))
	defer srv.Close()

	tmp := t.TempDir()
	p := filepath.Join(tmp, "hello.txt")
	_ = os.WriteFile(p, []byte("hello world"), 0o644)

	c := NewClient(srv.URL)
	c.Token = "rlm_cli_t"
	id, key, err := c.Upload(context.Background(), []string{p}, UploadOpts{Burn: true})
	if err != nil || id != "abc123" || key == "" {
		t.Fatalf("upload: %v id=%q key=%q", err, id, key)
	}
	if auth != "Bearer rlm_cli_t" {
		t.Fatalf("auth header: %q", auth)
	}
	if !strings.Contains(query, "burnAfterRead=1") {
		t.Fatalf("query: %q", query)
	}
	// body must decrypt with the returned key: mlen || encManifest || frames
	raw, _ := storecrypto.DecodeKey(key)
	mlen := binary.BigEndian.Uint32(body[:4])
	m, err := storecrypto.DecryptManifest(raw, body[4:4+mlen])
	if err != nil || m.Files[0].Name != "hello.txt" || m.Files[0].Size != 11 {
		t.Fatalf("manifest: %v %+v", err, m)
	}
	dec := storecrypto.NewDecryptor(raw)
	var out []byte
	_ = dec.Push(body[4+mlen:], func(pt []byte) error { out = append(out, pt...); return nil })
	if string(out) != "hello world" {
		t.Fatalf("payload: %q", out)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && go test ./internal/cloud/ -run TestUploadWireFormat -v`
Expected: FAIL — `Upload` undefined.

- [ ] **Step 3: Implement `Upload` + `runUp`**

Implement `Upload`: walk each path (files and directory trees; use relative names with forward slashes for the manifest, matching the web's `name`), build the manifest, `storecrypto.GenerateKey`, and stream to an `io.Pipe` whose read end is the POST body: write `uint32BE(len(encManifest))`, the manifest ciphertext, then for each file each 192 KiB chunk via `storecrypto.FrameChunk(key, seq, chunk)` with a global `seq` starting at 1. Build the query from `UploadOpts` (`burnAfterRead=1`, `ttl=<sec>`, `maxDownloads=<n>`). Map HTTP status: 401→"session expired, run relayium login again"; 413→"file exceeds server max size"; 429→"daily quota exceeded".

`runUp` (in `cloud.go`): require creds (`cloud.Load`; else `stderr` "run relayium login first", return 1); parse flags `--burn`, `--ttl`, `--max-downloads`, `--server`; call `Upload`; print the download link via `DownloadLink(creds.Server, id, key)` plus a note it works in a browser and via `relayium down`. Add `case "up":` to `run.go` and usage text.

- [ ] **Step 4: Run to verify pass**

Run: `cd server && go test ./internal/cloud/ -run TestUploadWireFormat -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/cloud/ server/cmd/relayium/
git commit -m "feat(cli): up — encrypt and upload to cloud"
```

---

## Task 13: CLI — `down` (fetch + decrypt)

**Files:**
- Modify: `server/internal/cloud/transfer.go` (Download + link parsing)
- Modify: `server/cmd/relayium/cloud.go` (`runDown`)
- Modify: `server/cmd/relayium/run.go` (dispatch `down`)
- Test: `server/internal/cloud/transfer_download_test.go`

**Interfaces:**
- Consumes: `internal/storecrypto`; the server `/meta` (base64-std encManifest) + `/blob` endpoints.
- Produces:
  - `func ParseClaim(s string) (server, id, keyB64Url string, err error)` — accepts a full link `https://host/d/<id>#<key>` (server = scheme+host) or a bare `<id>#<key>` (server empty → caller supplies default).
  - `func (c *Client) Download(ctx, id, keyB64Url, destDir string) ([]string, error)` — GET `/meta`, decrypt manifest; GET `/blob`, stream-decrypt into files under `destDir`; verify total length; returns written paths.

- [ ] **Step 1: Write the failing test (round-trip against a fake meta/blob server)**

```go
func TestDownloadRoundTrip(t *testing.T) {
	// Prepare ciphertext the way the server stores it.
	raw, _ := storecrypto.GenerateKey()
	m := storecrypto.Manifest{Files: []storecrypto.FileEntry{{Name: "hello.txt", Size: 11}}}
	mct, _ := storecrypto.EncryptManifest(raw, m)
	frame, _ := storecrypto.FrameChunk(raw, 1, []byte("hello world"))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/meta"):
			writeJSONTest(w, map[string]any{"encManifest": base64.StdEncoding.EncodeToString(mct), "size": len(frame)})
		case strings.HasSuffix(r.URL.Path, "/blob"):
			_, _ = w.Write(frame)
		}
	}))
	defer srv.Close()

	dest := t.TempDir()
	c := NewClient(srv.URL)
	paths, err := c.Download(context.Background(), "abc", storecrypto.EncodeKey(raw), dest)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(dest, "hello.txt"))
	if string(got) != "hello world" || len(paths) != 1 {
		t.Fatalf("download: %q paths=%v", got, paths)
	}
}

func TestParseClaim(t *testing.T) {
	srv, id, key, err := ParseClaim("https://relayium.com/d/abc123#deadbeef")
	if err != nil || srv != "https://relayium.com" || id != "abc123" || key != "deadbeef" {
		t.Fatalf("parse full link: %q %q %q %v", srv, id, key, err)
	}
	srv2, id2, key2, err2 := ParseClaim("abc123#deadbeef")
	if err2 != nil || srv2 != "" || id2 != "abc123" || key2 != "deadbeef" {
		t.Fatalf("parse bare code: %q %q %q %v", srv2, id2, key2, err2)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && go test ./internal/cloud/ -run 'TestDownloadRoundTrip|TestParseClaim' -v`
Expected: FAIL — undefined.

- [ ] **Step 3: Implement `Download` + `ParseClaim` + `runDown`**

`Download`: GET `/api/files/{id}/meta`, base64-std-decode `encManifest`, `DecryptManifest`; compute expected total plaintext from manifest file sizes; GET `/api/files/{id}/blob`; feed the response body to a `storecrypto.Decryptor`, routing decrypted bytes into files opened per the manifest order (track per-file remaining bytes to know where one file ends and the next begins — the manifest is the source of truth); `dec.End(expectedTotal)`; write each file under `destDir` (create parent dirs; reject names that escape `destDir` via `filepath.Clean` + prefix check — mirror the existing safeJoin used elsewhere). Distinguish a decrypt error (wrong key/corrupt) from a network read error in the returned message. `ParseClaim` splits on `#`; if it parses as a URL with a `/d/` path, extract the origin + id.

`runDown` (in `cloud.go`): `ParseClaim(arg)`; server = parsed server or `--server`/default; optional `destDir` arg (default `.`); call `Download`; print written files. `down` requires NO creds. Add `case "down":` in `run.go` + usage.

- [ ] **Step 4: Run to verify pass**

Run: `cd server && go test ./internal/cloud/ -run 'TestDownloadRoundTrip|TestParseClaim' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/cloud/ server/cmd/relayium/
git commit -m "feat(cli): down — fetch and decrypt from cloud"
```

---

## Task 14: End-to-end — up→down, web-vector→down, retention

**Files:**
- Create: `server/cmd/relayium/cloud_e2e_test.go`

**Interfaces:**
- Consumes: everything above; a real `account.Service` mounted on `httptest.NewServer(svc.Routes())` with an in-memory SQLite store and a fake/local blob store (reuse the account test harness that builds a Service with blobs — see `files_download_test.go` / `service_test.go`).

- [ ] **Step 1: Write the e2e test**

```go
func TestCloudUpDownE2E(t *testing.T) {
	svc := newE2EService(t)               // account.Service with blobs + in-mem store
	srv := httptest.NewServer(svc.Routes())
	defer srv.Close()

	// issue a CLI token directly (login flow covered in Task 10)
	u := mustUser(t, svc, "a@example.com")
	raw := "rlm_cli_" + randTokenForTest()
	dev, _ := svc.Store().UpsertDevice(context.Background(), account.Device{ID: "d1", UserID: u.ID, Kind: "cli", CreatedAt: 1})
	_ = svc.Store().CreateCLIToken(context.Background(), account.CLIToken{TokenHash: account.HashTokenForTest(raw), UserID: u.ID, DeviceID: dev.ID, CreatedAt: 1})

	// up
	src := filepath.Join(t.TempDir(), "hello.txt")
	_ = os.WriteFile(src, []byte("hello world"), 0o644)
	c := cloud.NewClient(srv.URL)
	c.Token = raw
	id, key, err := c.Upload(context.Background(), []string{src}, cloud.UploadOpts{MaxDownloads: 2})
	if err != nil {
		t.Fatal(err)
	}

	// down (twice, since max-downloads=2), then third must 404
	for i := 0; i < 2; i++ {
		dest := t.TempDir()
		if _, err := c.Download(context.Background(), id, key, dest); err != nil {
			t.Fatalf("download %d: %v", i, err)
		}
		got, _ := os.ReadFile(filepath.Join(dest, "hello.txt"))
		if string(got) != "hello world" {
			t.Fatalf("content %d: %q", i, got)
		}
	}
	if _, err := c.Download(context.Background(), id, key, t.TempDir()); err == nil {
		t.Fatal("third download should fail: max-downloads=2 spent")
	}
}
```
> `newE2EService`, `mustUser`, `randTokenForTest`, and any exported test shims (`svc.Store()`, `account.HashTokenForTest`) should reuse existing test scaffolding where present; add minimal exported test helpers only if the suite has no equivalent. Prefer building the CLI token through the real device-code flow if that is simpler than exposing `Store()`.

- [ ] **Step 2: Run to verify it fails, then passes**

Run: `cd server && go test ./cmd/relayium/ -run TestCloudUpDownE2E -v`
Expected: initially FAIL if helpers are missing; after wiring them, PASS.

- [ ] **Step 3: Full regression + vet**

Run:
```bash
cd server && go build ./... && go vet ./... && go test ./...
cd ../web && npx vitest run
```
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add server/cmd/relayium/
git commit -m "test(cli): end-to-end cloud up/down with retention enforcement"
```

---

## Self-Review Notes

- **Spec coverage:** Module 1 (binding) → Tasks 5–8, 10–11. Module 2 (up/down) → Tasks 1–2, 12–13. Module 3 (retention) → Tasks 3–4. Module 4 (web interop) → Task 2 (vector) + Task 13 (`down` accepts web links) — no web runtime change, matching the spec. Error handling → mapped in Tasks 12/13. Testing → Task 14 + per-task tests.
- **Type consistency:** `ConsumeDeviceAuth(ctx, codeHash, at) (rawToken string, ok bool, err error)` and `ApproveDeviceAuth(ctx, userCode, userID, tokenHash, rawToken, at)` are defined with their final signatures in Task 5 and consumed unchanged in Task 6 — no cross-task drift. `MaxDownloads` semantics (0=unlimited, 1=burn, N=count) are used identically in Tasks 3, 4, 12, 14. `Client.Token` is set by the caller before `Upload` (Tasks 12/14). `hashToken`/`randToken`/`newID` are the account-package helpers used throughout the server tasks.
- **Out of scope (unchanged from spec):** account deletion (sub-project A), `cloud ls/rm`, vault-passphrase pull-by-name, web `--max-downloads` UI, watched folder mirroring.
