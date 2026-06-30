# 跨网络异步传输（上传 → 下载链接）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional zero-knowledge "upload → one-time download link" mode to Relayium's cross-network page: a logged-in user encrypts files in-browser, uploads ciphertext, and shares a `/d/<id>#k=<key>` link that anyone can open (no login) to stream-decrypt the files.

**Architecture:** The browser generates a random AES-256-GCM key, encrypts the filename/size manifest and the file bytes (reusing transfer.ts framing), and POSTs ciphertext to a new `account` HTTP surface backed by a pluggable `storage.BlobStore` (local disk first). SQLite gains `stored_files` (lifecycle), `upload_events` (rolling-24h quota), and `settings` (admin-editable limits) tables. The decryption key travels only in the URL fragment, so the server stores ciphertext, ciphertext size, and timestamps — never plaintext, filenames, or keys. The existing realtime WebRTC mode is untouched.

**Tech Stack:** Go net/http, modernc.org/sqlite, Svelte 5 runes, Vitest, libsodium-wrappers, AES-256-GCM.

## Global Constraints

- Zero-knowledge server: it stores only ciphertext (blob), ciphertext manifest, ciphertext byte count, timestamps, owning account — never plaintext content, filenames, or keys.
- The 256-bit key lives only in the URL fragment `#k=<base64url>`; it is never sent to the server, never logged, never in Referer.
- Filenames + sizes are encrypted into `enc_manifest` under the same key; the server never sees plaintext names.
- Single-file max size: 50 MiB (default `RELAYIUM_MAX_FILE_SIZE` = `50*1024*1024`).
- Per-account quota: 200 MiB per rolling 24h window (default `RELAYIUM_DAILY_QUOTA` = `200*1024*1024`).
- Default TTL: 1 day (default `RELAYIUM_FILE_TTL` = `86400`); max TTL: 7 days (default `RELAYIUM_FILE_TTL_MAX` = `604800`).
- These 4 limits live in a DB `settings` table, editable in `/admin`; env/flag values seed them at startup; a DB value overrides the env default; the limits are read live per upload request.
- Local-disk pluggable `BlobStore` (`RELAYIUM_BLOB_DIR` default `./blobs`), startup-only (never in the admin dashboard).
- Coexists with realtime WebRTC mode — do NOT remove or weaken it.
- No new npm deps beyond what exists (libsodium-wrappers + qrcode are already present).
- Legal/positioning copy must distinguish "direct P2P realtime never touches the server" vs "optional zero-knowledge stored download links".
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

### Execution order (dependency-correct)

Tasks are numbered for readability, but **i18n (Task 14) must be implemented before the UI tasks (12, 13)** — `StoredUpload.svelte` and `DownloadPage.svelte` reference `t.stored.*` / `t.download.*` keys, so `npm run check` fails if those keys are absent. Execute in this order: **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 14 → 12 → 13 → 15.**

### Wire-format / naming decisions resolved here (spec left these open — every later task MUST match)

- **Blob upload body** (`POST /api/files`): `uint32BE(len(encManifest)) || encManifest || blobStream`, where `blobStream` is a concatenation of encrypted file frames, each framed as `uint32BE(len(ct)) || ct`. The server reads the 4-byte length, reads that many bytes as the opaque `enc_manifest`, then streams the remaining bytes verbatim into the blob (counting them as `size`). The server treats `enc_manifest` and `blobStream` as opaque bytes.
- **AES-GCM nonce space** (single key per stored file): 12-byte nonce = `0x00000000 || uint64BE(seq)`. The encrypted manifest uses `seq = 0`; file chunks use `seq = 1, 2, 3, …` globally across all files in the batch. This guarantees no nonce reuse between manifest and chunks. Plaintext chunk size = 192 KiB; ciphertext = plaintext + 16-byte GCM tag.
- **JSON field names**: meta returns `{ "encManifest": "<base64-std>", "size": <int>, "burnAfterRead": <bool>, "expiresAt": <int> }`; upload returns `{ "id": "<hex>", "expiresAt": <int> }`; list returns `{ "files": [{ "id", "size", "createdAt", "expiresAt", "burnAfterRead", "downloaded" }] }`.
- **Query params** on `POST /api/files`: `?burnAfterRead=1` (or `0`) and `?ttl=<seconds>` (0/absent → default TTL; clamped to `[60, max_ttl]`).
- **Settings keys** (integers): `max_file_size` (bytes), `daily_quota` (bytes), `default_ttl` (seconds), `max_ttl` (seconds).
- **IDs**: public file `id` = `newID()` (32 hex chars); `blob_key` = `randToken()` (64 hex chars), decoupled from `id`; upload-event `id` = `newID()`.
- **Link path prefix**: `DOWNLOAD_PREFIX = "/d/"`, lives in `web/src/lib/transfer-link.ts` (single source, light module imported by both router and stored-file).

---

## Task 1: `storage` package — BlobStore interface + DiskStore

**Files:**
- Create `server/internal/storage/blob.go`
- Create `server/internal/storage/disk.go`
- Test `server/internal/storage/disk_test.go`

**Interfaces:**
- Produces: `type BlobStore interface { Put(ctx context.Context, key string, r io.Reader) (int64, error); Get(ctx context.Context, key string) (io.ReadCloser, error); Delete(ctx context.Context, key string) error }`
- Produces: `var ErrNotFound = errors.New("storage: blob not found")`
- Produces: `func NewDiskStore(dir string) (*DiskStore, error)` — `*DiskStore` implements `BlobStore`; objects at `<dir>/<key[:2]>/<key>`; atomic write via temp file + rename.

**Steps:**

1. - [ ] Write the failing test `server/internal/storage/disk_test.go`:
   ```go
   package storage

   import (
   	"bytes"
   	"context"
   	"io"
   	"os"
   	"path/filepath"
   	"testing"
   )

   func TestDiskStorePutGetDeleteRoundtrip(t *testing.T) {
   	d, err := NewDiskStore(t.TempDir())
   	if err != nil {
   		t.Fatalf("new: %v", err)
   	}
   	ctx := context.Background()
   	key := "abcdef0123456789"
   	payload := []byte("zero-knowledge ciphertext bytes")
   	n, err := d.Put(ctx, key, bytes.NewReader(payload))
   	if err != nil || n != int64(len(payload)) {
   		t.Fatalf("put: n=%d err=%v", n, err)
   	}
   	rc, err := d.Get(ctx, key)
   	if err != nil {
   		t.Fatalf("get: %v", err)
   	}
   	got, _ := io.ReadAll(rc)
   	rc.Close()
   	if !bytes.Equal(got, payload) {
   		t.Fatalf("roundtrip mismatch: %q", got)
   	}
   	if err := d.Delete(ctx, key); err != nil {
   		t.Fatalf("delete: %v", err)
   	}
   	if _, err := d.Get(ctx, key); err != ErrNotFound {
   		t.Fatalf("get after delete: want ErrNotFound, got %v", err)
   	}
   }

   func TestDiskStoreShardsByPrefix(t *testing.T) {
   	dir := t.TempDir()
   	d, _ := NewDiskStore(dir)
   	key := "ffee112233"
   	if _, err := d.Put(context.Background(), key, bytes.NewReader([]byte("x"))); err != nil {
   		t.Fatalf("put: %v", err)
   	}
   	if _, err := os.Stat(filepath.Join(dir, "ff", key)); err != nil {
   		t.Fatalf("expected sharded file <dir>/ff/%s: %v", key, err)
   	}
   }

   func TestDiskStoreMissingKeyIsErrNotFound(t *testing.T) {
   	d, _ := NewDiskStore(t.TempDir())
   	if _, err := d.Get(context.Background(), "nope"); err != ErrNotFound {
   		t.Fatalf("want ErrNotFound, got %v", err)
   	}
   	// Delete of a missing key is a no-op (idempotent GC).
   	if err := d.Delete(context.Background(), "nope"); err != nil {
   		t.Fatalf("delete missing should be nil, got %v", err)
   	}
   }
   ```
2. - [ ] Run to fail: `cd server && go test ./internal/storage/` → expect `# github.com/relayium/relayium/internal/storage [build failed]` (no `blob.go`/`disk.go`).
3. - [ ] Implement `server/internal/storage/blob.go`:
   ```go
   // Package storage abstracts opaque blob persistence for stored-transfer
   // ciphertext. DiskStore is the local-disk implementation; an S3 impl can
   // replace it without touching callers (account.Service depends only on BlobStore).
   package storage

   import (
   	"context"
   	"errors"
   	"io"
   )

   // ErrNotFound is returned by Get when the object does not exist.
   var ErrNotFound = errors.New("storage: blob not found")

   // BlobStore persists opaque byte objects keyed by an unguessable token.
   type BlobStore interface {
   	// Put streams r into object `key`, returning the number of bytes written.
   	Put(ctx context.Context, key string, r io.Reader) (int64, error)
   	Get(ctx context.Context, key string) (io.ReadCloser, error)
   	Delete(ctx context.Context, key string) error
   }
   ```
4. - [ ] Implement `server/internal/storage/disk.go`:
   ```go
   package storage

   import (
   	"context"
   	"io"
   	"os"
   	"path/filepath"
   )

   // DiskStore writes each object to <dir>/<key[:2]>/<key>. The two-char shard
   // keeps any single directory from accumulating too many files.
   type DiskStore struct{ dir string }

   func NewDiskStore(dir string) (*DiskStore, error) {
   	if err := os.MkdirAll(dir, 0o755); err != nil {
   		return nil, err
   	}
   	return &DiskStore{dir: dir}, nil
   }

   func (d *DiskStore) paths(key string) (shardDir, full string) {
   	shard := key
   	if len(key) >= 2 {
   		shard = key[:2]
   	}
   	shardDir = filepath.Join(d.dir, shard)
   	return shardDir, filepath.Join(shardDir, key)
   }

   func (d *DiskStore) Put(ctx context.Context, key string, r io.Reader) (int64, error) {
   	shardDir, full := d.paths(key)
   	if err := os.MkdirAll(shardDir, 0o755); err != nil {
   		return 0, err
   	}
   	// Write to a temp file in the same dir, then atomically rename, so a
   	// concurrent Get never observes a half-written object.
   	tmp, err := os.CreateTemp(shardDir, ".tmp-*")
   	if err != nil {
   		return 0, err
   	}
   	tmpName := tmp.Name()
   	n, err := io.Copy(tmp, r)
   	if cerr := tmp.Close(); err == nil {
   		err = cerr
   	}
   	if err != nil {
   		os.Remove(tmpName) // propagate the reader/copy error (e.g. oversize abort)
   		return 0, err
   	}
   	if err := os.Rename(tmpName, full); err != nil {
   		os.Remove(tmpName)
   		return 0, err
   	}
   	return n, nil
   }

   func (d *DiskStore) Get(ctx context.Context, key string) (io.ReadCloser, error) {
   	_, full := d.paths(key)
   	f, err := os.Open(full)
   	if os.IsNotExist(err) {
   		return nil, ErrNotFound
   	}
   	if err != nil {
   		return nil, err
   	}
   	return f, nil
   }

   func (d *DiskStore) Delete(ctx context.Context, key string) error {
   	_, full := d.paths(key)
   	if err := os.Remove(full); err != nil && !os.IsNotExist(err) {
   		return err
   	}
   	return nil
   }
   ```
5. - [ ] Run to pass: `cd server && go test ./internal/storage/` → expect `ok  	github.com/relayium/relayium/internal/storage`.
6. - [ ] Commit: `git add server/internal/storage && git commit -m "feat(storage): pluggable BlobStore + local DiskStore with sharded atomic writes" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`.

---

## Task 2: DB layer — stored_files / upload_events / settings tables, entities, Store methods

**Files:**
- Modify `server/internal/account/store.go` (entity structs + Store interface methods)
- Modify `server/internal/account/sqlite.go` (schema + impls + helpers)
- Test `server/internal/account/sqlite_test.go` (append)

**Interfaces:**
- Produces entities: `StoredFile{ID, UserID, BlobKey string; EncManifest []byte; Size int64; BurnAfterRead bool; CreatedAt, ExpiresAt, DownloadedAt int64}`, `UploadEvent{ID, UserID string; Bytes, UploadedAt int64}`, `Setting{Key string; Value, UpdatedAt int64}`.
- Produces Store methods: `CreateStoredFile(ctx, StoredFile) error`; `GetStoredFile(ctx, id) (StoredFile, error)` (ErrNotFound when missing); `ListStoredFilesByUser(ctx, userID) ([]StoredFile, error)`; `MarkDownloaded(ctx, id string, at int64) error`; `DeleteStoredFile(ctx, id) error`; `ListExpiredStoredFiles(ctx, now int64) ([]StoredFile, error)`; `RecordUpload(ctx, UploadEvent) error`; `UserUploadedSince(ctx, userID string, since int64) (int64, error)`; `PruneUploadEvents(ctx, before int64) error`; `GetSetting(ctx, key string) (int64, bool, error)`; `SetSetting(ctx, key string, value, at int64) error`; `ListSettings(ctx) ([]Setting, error)`.

**Steps:**

1. - [ ] Append failing tests to `server/internal/account/sqlite_test.go`:
   ```go
   func TestStoredFileCRUDAndExpiry(t *testing.T) {
   	s := newTestStore(t)
   	ctx := context.Background()
   	u, _ := s.UpsertUserByEmail(ctx, "sf@example.com", "SF")
   	f := StoredFile{
   		ID: "file1", UserID: u.ID, BlobKey: "blobkey1",
   		EncManifest: []byte{0xde, 0xad, 0xbe, 0xef}, Size: 1234,
   		BurnAfterRead: true, CreatedAt: 100, ExpiresAt: 200,
   	}
   	if err := s.CreateStoredFile(ctx, f); err != nil {
   		t.Fatalf("create: %v", err)
   	}
   	got, err := s.GetStoredFile(ctx, "file1")
   	if err != nil {
   		t.Fatalf("get: %v", err)
   	}
   	if got.UserID != u.ID || got.BlobKey != "blobkey1" || got.Size != 1234 ||
   		!got.BurnAfterRead || got.ExpiresAt != 200 || got.DownloadedAt != 0 ||
   		string(got.EncManifest) != string(f.EncManifest) {
   		t.Fatalf("roundtrip mismatch: %+v", got)
   	}
   	list, _ := s.ListStoredFilesByUser(ctx, u.ID)
   	if len(list) != 1 || list[0].ID != "file1" {
   		t.Fatalf("list: %+v", list)
   	}
   	if err := s.MarkDownloaded(ctx, "file1", 150); err != nil {
   		t.Fatalf("mark: %v", err)
   	}
   	if g, _ := s.GetStoredFile(ctx, "file1"); g.DownloadedAt != 150 {
   		t.Fatalf("downloaded_at = %d, want 150", g.DownloadedAt)
   	}
   	if err := s.DeleteStoredFile(ctx, "file1"); err != nil {
   		t.Fatalf("delete: %v", err)
   	}
   	if _, err := s.GetStoredFile(ctx, "file1"); err != ErrNotFound {
   		t.Fatalf("get after delete: want ErrNotFound, got %v", err)
   	}
   }

   func TestListExpiredStoredFiles(t *testing.T) {
   	s := newTestStore(t)
   	ctx := context.Background()
   	u, _ := s.UpsertUserByEmail(ctx, "e@example.com", "E")
   	_ = s.CreateStoredFile(ctx, StoredFile{ID: "old", UserID: u.ID, BlobKey: "k1", EncManifest: []byte{1}, Size: 1, CreatedAt: 1, ExpiresAt: 100})
   	_ = s.CreateStoredFile(ctx, StoredFile{ID: "fresh", UserID: u.ID, BlobKey: "k2", EncManifest: []byte{1}, Size: 1, CreatedAt: 1, ExpiresAt: 5000})
   	exp, err := s.ListExpiredStoredFiles(ctx, 1000)
   	if err != nil {
   		t.Fatalf("list expired: %v", err)
   	}
   	if len(exp) != 1 || exp[0].ID != "old" {
   		t.Fatalf("expired = %+v, want only [old]", exp)
   	}
   }

   func TestUserUploadedSinceRollingWindow(t *testing.T) {
   	s := newTestStore(t)
   	ctx := context.Background()
   	u, _ := s.UpsertUserByEmail(ctx, "q@example.com", "Q")
   	// now = 100000; window start = now - 86400 = 13600.
   	_ = s.RecordUpload(ctx, UploadEvent{ID: "e1", UserID: u.ID, Bytes: 1000, UploadedAt: 10000}) // before window
   	_ = s.RecordUpload(ctx, UploadEvent{ID: "e2", UserID: u.ID, Bytes: 2000, UploadedAt: 50000}) // in window
   	_ = s.RecordUpload(ctx, UploadEvent{ID: "e3", UserID: u.ID, Bytes: 3000, UploadedAt: 90000}) // in window
   	total, err := s.UserUploadedSince(ctx, u.ID, 13600)
   	if err != nil || total != 5000 {
   		t.Fatalf("uploaded since = %d (err %v), want 5000", total, err)
   	}
   	// Unknown user → 0, no error.
   	if z, err := s.UserUploadedSince(ctx, "nobody", 0); err != nil || z != 0 {
   		t.Fatalf("unknown user = %d (err %v), want 0", z, err)
   	}
   	// PruneUploadEvents drops rows strictly older than the cutoff.
   	if err := s.PruneUploadEvents(ctx, 13600); err != nil {
   		t.Fatalf("prune: %v", err)
   	}
   	if total, _ := s.UserUploadedSince(ctx, u.ID, 0); total != 5000 {
   		t.Fatalf("after prune total = %d, want 5000 (only e1 pruned)", total)
   	}
   }

   func TestSettingsGetSetList(t *testing.T) {
   	s := newTestStore(t)
   	ctx := context.Background()
   	if _, ok, err := s.GetSetting(ctx, "max_file_size"); err != nil || ok {
   		t.Fatalf("unset key: ok=%v err=%v", ok, err)
   	}
   	if err := s.SetSetting(ctx, "max_file_size", 52428800, 1); err != nil {
   		t.Fatalf("set: %v", err)
   	}
   	v, ok, err := s.GetSetting(ctx, "max_file_size")
   	if err != nil || !ok || v != 52428800 {
   		t.Fatalf("get: v=%d ok=%v err=%v", v, ok, err)
   	}
   	// Upsert overwrites.
   	_ = s.SetSetting(ctx, "max_file_size", 99, 2)
   	if v, _, _ := s.GetSetting(ctx, "max_file_size"); v != 99 {
   		t.Fatalf("after upsert v = %d, want 99", v)
   	}
   	_ = s.SetSetting(ctx, "daily_quota", 200, 3)
   	all, err := s.ListSettings(ctx)
   	if err != nil || len(all) != 2 {
   		t.Fatalf("list: %+v err=%v", all, err)
   	}
   }
   ```
2. - [ ] Run to fail: `cd server && go test ./internal/account/ -run 'StoredFile|Expired|UploadedSince|Settings'` → expect build failure (undefined `StoredFile`, `CreateStoredFile`, etc.).
3. - [ ] Add entity structs to `server/internal/account/store.go` (after the `UsageEvent` struct, before `AdminUserRow`):
   ```go
   // StoredFile is one zero-knowledge stored-transfer object's lifecycle row. The
   // server holds only ciphertext: EncManifest (encrypted filenames/sizes) and the
   // blob it points at are opaque. It never sees plaintext content, names, or the key.
   type StoredFile struct {
   	ID            string
   	UserID        string
   	BlobKey       string
   	EncManifest   []byte
   	Size          int64 // ciphertext byte count
   	BurnAfterRead bool
   	CreatedAt     int64
   	ExpiresAt     int64
   	DownloadedAt  int64 // 0 = not yet downloaded
   }

   // UploadEvent is an immutable ledger row for the rolling-24h upload quota. It is
   // independent of StoredFile lifecycle: a file may be burned/expired and deleted,
   // but the day's quota still counts. GC prunes rows older than ~25h.
   type UploadEvent struct {
   	ID         string
   	UserID     string
   	Bytes      int64
   	UploadedAt int64
   }

   // Setting is one admin-editable integer config value (bytes or seconds).
   type Setting struct {
   	Key       string
   	Value     int64
   	UpdatedAt int64
   }
   ```
4. - [ ] Add the methods to the `Store` interface in `store.go` (append inside the interface, after `AdminListUsers`):
   ```go
   	// stored files (zero-knowledge stored transfer)
   	CreateStoredFile(ctx context.Context, f StoredFile) error
   	GetStoredFile(ctx context.Context, id string) (StoredFile, error)
   	ListStoredFilesByUser(ctx context.Context, userID string) ([]StoredFile, error)
   	MarkDownloaded(ctx context.Context, id string, at int64) error
   	DeleteStoredFile(ctx context.Context, id string) error
   	ListExpiredStoredFiles(ctx context.Context, now int64) ([]StoredFile, error)
   	// upload events (rolling-24h quota ledger)
   	RecordUpload(ctx context.Context, e UploadEvent) error
   	UserUploadedSince(ctx context.Context, userID string, since int64) (int64, error)
   	PruneUploadEvents(ctx context.Context, before int64) error
   	// settings (admin-editable limits)
   	GetSetting(ctx context.Context, key string) (int64, bool, error)
   	SetSetting(ctx context.Context, key string, value, at int64) error
   	ListSettings(ctx context.Context) ([]Setting, error)
   ```
5. - [ ] Extend the `schema` const in `sqlite.go` (append before the closing backtick, after the `usage_events` block):
   ```go
   CREATE TABLE IF NOT EXISTS stored_files (
     id              TEXT PRIMARY KEY,
     user_id         TEXT NOT NULL REFERENCES users(id),
     blob_key        TEXT NOT NULL,
     enc_manifest    BLOB NOT NULL,
     size            INTEGER NOT NULL,
     burn_after_read INTEGER NOT NULL DEFAULT 0,
     created_at      INTEGER NOT NULL,
     expires_at      INTEGER NOT NULL,
     downloaded_at   INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX IF NOT EXISTS idx_stored_files_user ON stored_files(user_id);
   CREATE INDEX IF NOT EXISTS idx_stored_files_expires ON stored_files(expires_at);
   CREATE TABLE IF NOT EXISTS upload_events (
     id          TEXT PRIMARY KEY,
     user_id     TEXT NOT NULL REFERENCES users(id),
     bytes       INTEGER NOT NULL,
     uploaded_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_upload_events_user ON upload_events(user_id, uploaded_at);
   CREATE TABLE IF NOT EXISTS settings (
     key        TEXT PRIMARY KEY,
     value      INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   ```
6. - [ ] Append impls + helpers to `sqlite.go`:
   ```go
   func b2i(b bool) int {
   	if b {
   		return 1
   	}
   	return 0
   }

   type rowScanner interface{ Scan(dest ...any) error }

   func scanStoredFile(sc rowScanner) (StoredFile, error) {
   	var f StoredFile
   	var burn int
   	err := sc.Scan(&f.ID, &f.UserID, &f.BlobKey, &f.EncManifest, &f.Size,
   		&burn, &f.CreatedAt, &f.ExpiresAt, &f.DownloadedAt)
   	f.BurnAfterRead = burn != 0
   	return f, err
   }

   const storedFileCols = `id, user_id, blob_key, enc_manifest, size, burn_after_read, created_at, expires_at, downloaded_at`

   func (s *SQLiteStore) CreateStoredFile(ctx context.Context, f StoredFile) error {
   	_, err := s.db.ExecContext(ctx,
   		`INSERT INTO stored_files (`+storedFileCols+`)
   		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
   		f.ID, f.UserID, f.BlobKey, f.EncManifest, f.Size,
   		b2i(f.BurnAfterRead), f.CreatedAt, f.ExpiresAt, f.DownloadedAt)
   	return err
   }

   func (s *SQLiteStore) GetStoredFile(ctx context.Context, id string) (StoredFile, error) {
   	f, err := scanStoredFile(s.db.QueryRowContext(ctx,
   		`SELECT `+storedFileCols+` FROM stored_files WHERE id = ?`, id))
   	if err == sql.ErrNoRows {
   		return StoredFile{}, ErrNotFound
   	}
   	return f, err
   }

   func (s *SQLiteStore) ListStoredFilesByUser(ctx context.Context, userID string) ([]StoredFile, error) {
   	rows, err := s.db.QueryContext(ctx,
   		`SELECT `+storedFileCols+` FROM stored_files WHERE user_id = ? ORDER BY created_at DESC`, userID)
   	if err != nil {
   		return nil, err
   	}
   	defer rows.Close()
   	var out []StoredFile
   	for rows.Next() {
   		f, err := scanStoredFile(rows)
   		if err != nil {
   			return nil, err
   		}
   		out = append(out, f)
   	}
   	return out, rows.Err()
   }

   func (s *SQLiteStore) MarkDownloaded(ctx context.Context, id string, at int64) error {
   	_, err := s.db.ExecContext(ctx,
   		`UPDATE stored_files SET downloaded_at = ? WHERE id = ?`, at, id)
   	return err
   }

   func (s *SQLiteStore) DeleteStoredFile(ctx context.Context, id string) error {
   	_, err := s.db.ExecContext(ctx, `DELETE FROM stored_files WHERE id = ?`, id)
   	return err
   }

   func (s *SQLiteStore) ListExpiredStoredFiles(ctx context.Context, now int64) ([]StoredFile, error) {
   	rows, err := s.db.QueryContext(ctx,
   		`SELECT `+storedFileCols+` FROM stored_files WHERE expires_at < ?`, now)
   	if err != nil {
   		return nil, err
   	}
   	defer rows.Close()
   	var out []StoredFile
   	for rows.Next() {
   		f, err := scanStoredFile(rows)
   		if err != nil {
   			return nil, err
   		}
   		out = append(out, f)
   	}
   	return out, rows.Err()
   }

   func (s *SQLiteStore) RecordUpload(ctx context.Context, e UploadEvent) error {
   	_, err := s.db.ExecContext(ctx,
   		`INSERT INTO upload_events (id, user_id, bytes, uploaded_at) VALUES (?, ?, ?, ?)`,
   		e.ID, e.UserID, e.Bytes, e.UploadedAt)
   	return err
   }

   func (s *SQLiteStore) UserUploadedSince(ctx context.Context, userID string, since int64) (int64, error) {
   	var total sql.NullInt64
   	err := s.db.QueryRowContext(ctx,
   		`SELECT SUM(bytes) FROM upload_events WHERE user_id = ? AND uploaded_at >= ?`,
   		userID, since).Scan(&total)
   	if err != nil {
   		return 0, err
   	}
   	return total.Int64, nil // SUM over no rows is NULL → 0
   }

   func (s *SQLiteStore) PruneUploadEvents(ctx context.Context, before int64) error {
   	_, err := s.db.ExecContext(ctx, `DELETE FROM upload_events WHERE uploaded_at < ?`, before)
   	return err
   }

   func (s *SQLiteStore) GetSetting(ctx context.Context, key string) (int64, bool, error) {
   	var v int64
   	err := s.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = ?`, key).Scan(&v)
   	if err == sql.ErrNoRows {
   		return 0, false, nil
   	}
   	if err != nil {
   		return 0, false, err
   	}
   	return v, true, nil
   }

   func (s *SQLiteStore) SetSetting(ctx context.Context, key string, value, at int64) error {
   	_, err := s.db.ExecContext(ctx,
   		`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
   		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
   		key, value, at)
   	return err
   }

   func (s *SQLiteStore) ListSettings(ctx context.Context) ([]Setting, error) {
   	rows, err := s.db.QueryContext(ctx, `SELECT key, value, updated_at FROM settings ORDER BY key`)
   	if err != nil {
   		return nil, err
   	}
   	defer rows.Close()
   	var out []Setting
   	for rows.Next() {
   		var st Setting
   		if err := rows.Scan(&st.Key, &st.Value, &st.UpdatedAt); err != nil {
   			return nil, err
   		}
   		out = append(out, st)
   	}
   	return out, rows.Err()
   }
   ```
7. - [ ] Run to pass: `cd server && go test ./internal/account/ -run 'StoredFile|Expired|UploadedSince|Settings'` → expect `ok`. Then full package: `go test ./internal/account/` → `ok` (interface still satisfied by `SQLiteStore`).
8. - [ ] Commit: `git add server/internal/account/store.go server/internal/account/sqlite.go server/internal/account/sqlite_test.go && git commit -m "feat(account): stored_files/upload_events/settings tables + Store methods" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`.

---

## Task 3: Settings resolver (DB-with-env-fallback) + TTL clamp + seed

**Files:**
- Modify `server/internal/account/service.go` (Config fields)
- Create `server/internal/account/settings.go`
- Test `server/internal/account/settings_test.go`

**Interfaces:**
- Consumes: `Store.GetSetting`, `Store.SetSetting` (Task 2); `Service.now` (service.go).
- Produces: `Config` gains `MaxFileSize, DailyQuota, DefaultTTL, MaxTTL int64`.
- Produces: setting key consts `SettingMaxFileSize="max_file_size"`, `SettingDailyQuota="daily_quota"`, `SettingDefaultTTL="default_ttl"`, `SettingMaxTTL="max_ttl"`; `minTTL int64 = 60`.
- Produces: `type Settings struct{ MaxFileSize, DailyQuota, DefaultTTL, MaxTTL int64 }`; `(s *Service) resolveSettings(ctx) Settings`; `clampTTL(req int64, st Settings) int64`; `(s *Service) SeedSettings(ctx) error`.

**Steps:**

1. - [ ] Write the failing test `server/internal/account/settings_test.go`:
   ```go
   package account

   import (
   	"context"
   	"testing"
   	"time"
   )

   func newSettingsService(t *testing.T) (*Service, *SQLiteStore) {
   	t.Helper()
   	store := newTestStore(t)
   	svc := NewService(store, &capturingMailer{}, Config{
   		BaseURL:     "http://example.test",
   		MaxFileSize: 50 << 20,
   		DailyQuota:  200 << 20,
   		DefaultTTL:  86400,
   		MaxTTL:      604800,
   	})
   	svc.now = func() time.Time { return time.Unix(1000, 0) }
   	return svc, store
   }

   func TestResolveSettingsFallsBackToEnvDefaults(t *testing.T) {
   	svc, _ := newSettingsService(t)
   	st := svc.resolveSettings(context.Background())
   	if st.MaxFileSize != 50<<20 || st.DailyQuota != 200<<20 || st.DefaultTTL != 86400 || st.MaxTTL != 604800 {
   		t.Fatalf("env fallback wrong: %+v", st)
   	}
   }

   func TestResolveSettingsDBOverridesEnv(t *testing.T) {
   	svc, store := newSettingsService(t)
   	if err := store.SetSetting(context.Background(), SettingMaxFileSize, 1234, 1); err != nil {
   		t.Fatalf("set: %v", err)
   	}
   	st := svc.resolveSettings(context.Background())
   	if st.MaxFileSize != 1234 {
   		t.Fatalf("DB override = %d, want 1234", st.MaxFileSize)
   	}
   	if st.DailyQuota != 200<<20 { // untouched key still falls back
   		t.Fatalf("daily quota = %d, want env default", st.DailyQuota)
   	}
   }

   func TestClampTTL(t *testing.T) {
   	st := Settings{DefaultTTL: 86400, MaxTTL: 604800}
   	cases := []struct{ in, want int64 }{
   		{0, 86400},       // absent → default
   		{-5, 86400},      // negative → default
   		{30, 60},         // below floor → minTTL
   		{100000, 100000}, // within range → unchanged
   		{999999999, 604800}, // above max → max
   	}
   	for _, c := range cases {
   		if got := clampTTL(c.in, st); got != c.want {
   			t.Errorf("clampTTL(%d) = %d, want %d", c.in, got, c.want)
   		}
   	}
   }

   func TestSeedSettingsInsertsDefaultsOnceAndKeepsExisting(t *testing.T) {
   	svc, store := newSettingsService(t)
   	ctx := context.Background()
   	_ = store.SetSetting(ctx, SettingDailyQuota, 777, 1) // pre-existing override
   	if err := svc.SeedSettings(ctx); err != nil {
   		t.Fatalf("seed: %v", err)
   	}
   	all, _ := store.ListSettings(ctx)
   	if len(all) != 4 {
   		t.Fatalf("want 4 settings seeded, got %d (%+v)", len(all), all)
   	}
   	if v, _, _ := store.GetSetting(ctx, SettingDailyQuota); v != 777 {
   		t.Fatalf("seed overwrote existing daily_quota = %d, want 777", v)
   	}
   	if v, _, _ := store.GetSetting(ctx, SettingMaxFileSize); v != 50<<20 {
   		t.Fatalf("seed max_file_size = %d, want default", v)
   	}
   }
   ```
2. - [ ] Run to fail: `cd server && go test ./internal/account/ -run 'Settings|ClampTTL'` → expect build failure (undefined `Config.MaxFileSize`, `resolveSettings`, `clampTTL`, `SeedSettings`).
3. - [ ] Add fields to `Config` in `service.go` (append inside the struct, after `AdminPassword`):
   ```go
   	// Stored-transfer limits (env/flag defaults; DB settings table overrides these live).
   	MaxFileSize int64 // bytes
   	DailyQuota  int64 // bytes per rolling 24h
   	DefaultTTL  int64 // seconds
   	MaxTTL      int64 // seconds
   ```
4. - [ ] Create `server/internal/account/settings.go`:
   ```go
   package account

   import "context"

   // Setting keys for the admin-editable stored-transfer limits.
   const (
   	SettingMaxFileSize = "max_file_size"
   	SettingDailyQuota  = "daily_quota"
   	SettingDefaultTTL  = "default_ttl"
   	SettingMaxTTL      = "max_ttl"
   )

   // minTTL is the floor a requested TTL is clamped up to; well below default_ttl.
   const minTTL int64 = 60

   // Settings is the resolved live view of the four limits for one request.
   type Settings struct {
   	MaxFileSize int64
   	DailyQuota  int64
   	DefaultTTL  int64
   	MaxTTL      int64
   }

   // settingOr returns the DB value for key, or def when unset/on error (fail to env).
   func (s *Service) settingOr(ctx context.Context, key string, def int64) int64 {
   	v, ok, err := s.store.GetSetting(ctx, key)
   	if err != nil || !ok {
   		return def
   	}
   	return v
   }

   // resolveSettings reads the four limits live: DB value if present, else the
   // env/flag default seeded into Config. "Admin change > env default."
   func (s *Service) resolveSettings(ctx context.Context) Settings {
   	return Settings{
   		MaxFileSize: s.settingOr(ctx, SettingMaxFileSize, s.cfg.MaxFileSize),
   		DailyQuota:  s.settingOr(ctx, SettingDailyQuota, s.cfg.DailyQuota),
   		DefaultTTL:  s.settingOr(ctx, SettingDefaultTTL, s.cfg.DefaultTTL),
   		MaxTTL:      s.settingOr(ctx, SettingMaxTTL, s.cfg.MaxTTL),
   	}
   }

   // clampTTL maps a requested TTL (seconds) into [minTTL, MaxTTL]; 0/negative
   // means "unspecified" and yields DefaultTTL.
   func clampTTL(req int64, st Settings) int64 {
   	if req <= 0 {
   		req = st.DefaultTTL
   	}
   	if req < minTTL {
   		req = minTTL
   	}
   	if req > st.MaxTTL {
   		req = st.MaxTTL
   	}
   	return req
   }

   // SeedSettings writes the Config defaults into the settings table for any of the
   // four keys not already present, so the admin form shows live values. Existing
   // (admin-set) values are left untouched.
   func (s *Service) SeedSettings(ctx context.Context) error {
   	defaults := []struct {
   		key string
   		val int64
   	}{
   		{SettingMaxFileSize, s.cfg.MaxFileSize},
   		{SettingDailyQuota, s.cfg.DailyQuota},
   		{SettingDefaultTTL, s.cfg.DefaultTTL},
   		{SettingMaxTTL, s.cfg.MaxTTL},
   	}
   	now := s.now().Unix()
   	for _, d := range defaults {
   		_, ok, err := s.store.GetSetting(ctx, d.key)
   		if err != nil {
   			return err
   		}
   		if ok {
   			continue
   		}
   		if err := s.store.SetSetting(ctx, d.key, d.val, now); err != nil {
   			return err
   		}
   	}
   	return nil
   }
   ```
5. - [ ] Run to pass: `cd server && go test ./internal/account/ -run 'Settings|ClampTTL'` → expect `ok`.
6. - [ ] Commit: `git add server/internal/account/service.go server/internal/account/settings.go server/internal/account/settings_test.go && git commit -m "feat(account): live settings resolver (DB over env) + TTL clamp + seeding" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`.

---

## Task 4: Upload handler `POST /api/files`

**Files:**
- Modify `server/internal/account/service.go` (add `blobs storage.BlobStore` field + `SetBlobStore`)
- Create `server/internal/account/files.go` (upload handler + helpers + register in a new helper called from `Routes()`)
- Modify `server/internal/account/handlers.go` (`Routes()` calls `s.registerFileRoutes(mux)`)
- Test `server/internal/account/files_test.go`

**Interfaces:**
- Consumes: body wire format `uint32BE(len(encManifest)) || encManifest || blobStream` (Global Constraints); `resolveSettings`, `clampTTL` (Task 3); `Store.UserUploadedSince`, `Store.RecordUpload`, `Store.CreateStoredFile` (Task 2); `storage.BlobStore`, `storage.ErrNotFound` (Task 1).
- Produces: `func (s *Service) SetBlobStore(b storage.BlobStore)`; `func (s *Service) registerFileRoutes(mux *http.ServeMux)`; handler `POST /api/files` (RequireSession) → `{ "id", "expiresAt" }`; sentinel `errTooLarge`. `maxManifestBytes = 64 * 1024`.

**Steps:**

1. - [ ] Write the failing test `server/internal/account/files_test.go`:
   ```go
   package account

   import (
   	"bytes"
   	"context"
   	"encoding/binary"
   	"net/http"
   	"net/http/httptest"
   	"strings"
   	"testing"
   	"time"

   	"github.com/relayium/relayium/internal/storage"
   )

   // newFileServer builds a magic-link-capable account server with a disk blob store.
   func newFileServer(t *testing.T) (*httptest.Server, *Service, *SQLiteStore, *capturingMailer) {
   	t.Helper()
   	store := newTestStore(t)
   	mail := &capturingMailer{}
   	svc := NewService(store, mail, Config{
   		BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: 15 * time.Minute,
   		TransferTTL: time.Hour, EnableMagic: true,
   		MaxFileSize: 1024, DailyQuota: 4096, DefaultTTL: 3600, MaxTTL: 7200,
   	})
   	disk, err := storage.NewDiskStore(t.TempDir())
   	if err != nil {
   		t.Fatalf("disk: %v", err)
   	}
   	svc.SetBlobStore(disk)
   	ts := httptest.NewServer(svc.Routes())
   	t.Cleanup(ts.Close)
   	return ts, svc, store, mail
   }

   // loginCookie logs a user in via magic link and returns the session cookie.
   func loginCookie(t *testing.T, ts *httptest.Server, mail *capturingMailer, email string) *http.Cookie {
   	t.Helper()
   	client := ts.Client()
   	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
   	_, _ = client.PostForm(ts.URL+"/api/auth/magic/request", map[string][]string{"email": {email}})
   	i := strings.Index(mail.lastLink, "token=")
   	verify, _ := client.Get(ts.URL + "/api/auth/magic/verify?token=" + mail.lastLink[i+len("token="):])
   	for _, c := range verify.Cookies() {
   		if c.Name == sessionCookie {
   			return c
   		}
   	}
   	t.Fatal("no session cookie")
   	return nil
   }

   // uploadBody frames an opaque manifest + blob stream per the wire format.
   func uploadBody(manifest, blob []byte) *bytes.Buffer {
   	var buf bytes.Buffer
   	_ = binary.Write(&buf, binary.BigEndian, uint32(len(manifest)))
   	buf.Write(manifest)
   	buf.Write(blob)
   	return &buf
   }

   func postUpload(t *testing.T, ts *httptest.Server, cookie *http.Cookie, query string, body *bytes.Buffer) *http.Response {
   	t.Helper()
   	req, _ := http.NewRequest("POST", ts.URL+"/api/files"+query, body)
   	if cookie != nil {
   		req.AddCookie(cookie)
   	}
   	resp, err := ts.Client().Do(req)
   	if err != nil {
   		t.Fatalf("do: %v", err)
   	}
   	return resp
   }

   func TestUploadSuccess(t *testing.T) {
   	ts, _, store, mail := newFileServer(t)
   	cookie := loginCookie(t, ts, mail, "up@example.com")
   	resp := postUpload(t, ts, cookie, "?burnAfterRead=1&ttl=0", uploadBody([]byte("manifestCT"), []byte("ciphertextblob")))
   	if resp.StatusCode != http.StatusOK {
   		t.Fatalf("upload: %d", resp.StatusCode)
   	}
   	var out struct {
   		ID        string `json:"id"`
   		ExpiresAt int64  `json:"expiresAt"`
   	}
   	decodeJSON(t, resp, &out)
   	if out.ID == "" || out.ExpiresAt == 0 {
   		t.Fatalf("bad response %+v", out)
   	}
   	sf, err := store.GetStoredFile(context.Background(), out.ID)
   	if err != nil {
   		t.Fatalf("stored file missing: %v", err)
   	}
   	if !sf.BurnAfterRead || sf.Size != int64(len("ciphertextblob")) || string(sf.EncManifest) != "manifestCT" {
   		t.Fatalf("stored row wrong: %+v", sf)
   	}
   	// ttl=0 → DefaultTTL (3600); created at now → expiresAt ≈ now+3600.
   	if out.ExpiresAt != sf.ExpiresAt {
   		t.Fatalf("expiresAt mismatch")
   	}
   }

   func TestUploadOversizeIs413(t *testing.T) {
   	ts, _, _, mail := newFileServer(t)
   	cookie := loginCookie(t, ts, mail, "big@example.com")
   	big := bytes.Repeat([]byte("x"), 2048) // > MaxFileSize 1024
   	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), big))
   	if resp.StatusCode != http.StatusRequestEntityTooLarge {
   		t.Fatalf("oversize: want 413, got %d", resp.StatusCode)
   	}
   }

   func TestUploadOverQuotaIs429(t *testing.T) {
   	ts, _, store, mail := newFileServer(t)
   	cookie := loginCookie(t, ts, mail, "quota@example.com")
   	u, _ := store.UpsertUserByEmail(context.Background(), "quota@example.com", "")
   	// Pre-fill the rolling window to within 100 bytes of the 4096 quota.
   	_ = store.RecordUpload(context.Background(), UploadEvent{ID: newID(), UserID: u.ID, Bytes: 4000, UploadedAt: time.Now().Unix()})
   	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), bytes.Repeat([]byte("y"), 500)))
   	if resp.StatusCode != http.StatusTooManyRequests {
   		t.Fatalf("over quota: want 429, got %d", resp.StatusCode)
   	}
   }

   func TestUploadUnauthIs401(t *testing.T) {
   	ts, _, _, _ := newFileServer(t)
   	resp := postUpload(t, ts, nil, "?ttl=0", uploadBody([]byte("m"), []byte("c")))
   	if resp.StatusCode != http.StatusUnauthorized {
   		t.Fatalf("unauth: want 401, got %d", resp.StatusCode)
   	}
   }
   ```
2. - [ ] Add the shared test JSON helper to `files_test.go` (used by Task 5 too):
   ```go
   func decodeJSON(t *testing.T, resp *http.Response, v any) {
   	t.Helper()
   	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
   		t.Fatalf("decode: %v", err)
   	}
   }
   ```
   and add `"encoding/json"` to the test imports.
3. - [ ] Run to fail: `cd server && go test ./internal/account/ -run Upload` → expect build failure (`SetBlobStore` undefined, route 404).
4. - [ ] Add the blob field + setter to `service.go`. Add import `"github.com/relayium/relayium/internal/storage"`, add field to `Service` struct after `adminMu`:
   ```go
   	blobs storage.BlobStore // nil until SetBlobStore; stored-transfer disabled when nil
   ```
   and append the setter:
   ```go
   // SetBlobStore wires the ciphertext blob backend for stored transfers. Called
   // once at startup when the DB (and thus account features) are available.
   func (s *Service) SetBlobStore(b storage.BlobStore) { s.blobs = b }
   ```
5. - [ ] Create `server/internal/account/files.go`:
   ```go
   package account

   import (
   	"bufio"
   	"encoding/binary"
   	"errors"
   	"io"
   	"net/http"
   	"strconv"

   	"github.com/relayium/relayium/internal/storage"
   )

   const (
   	dayWindow       = int64(86400)
   	maxManifestBytes = 64 * 1024
   )

   // errTooLarge is returned by cappedReader once the upload exceeds the live
   // max_file_size; it propagates out of BlobStore.Put so no oversize blob commits.
   var errTooLarge = errors.New("account: upload exceeds max file size")

   // cappedReader fails the copy as soon as more than max bytes are read.
   type cappedReader struct {
   	r   io.Reader
   	n   int64
   	max int64
   }

   func (c *cappedReader) Read(p []byte) (int, error) {
   	n, err := c.r.Read(p)
   	c.n += int64(n)
   	if c.n > c.max {
   		return n, errTooLarge
   	}
   	return n, err
   }

   // registerFileRoutes mounts the stored-transfer endpoints on the account mux.
   // Public routes (meta/blob) are unauthenticated; the rest require a session.
   func (s *Service) registerFileRoutes(mux *http.ServeMux) {
   	mux.HandleFunc("POST /api/files", s.RequireSession(s.handleUploadFile))
   	mux.HandleFunc("GET /api/files", s.RequireSession(s.handleListFiles))
   	mux.HandleFunc("DELETE /api/files/{id}", s.RequireSession(s.handleDeleteFile))
   	mux.HandleFunc("GET /api/files/{id}/meta", s.handleFileMeta)
   	mux.HandleFunc("GET /api/files/{id}/blob", s.handleFileBlob)
   }

   func (s *Service) handleUploadFile(w http.ResponseWriter, r *http.Request, u User) {
   	if s.blobs == nil {
   		http.Error(w, "storage unavailable", http.StatusServiceUnavailable)
   		return
   	}
   	st := s.resolveSettings(r.Context())
   	burn := r.URL.Query().Get("burnAfterRead") == "1"
   	reqTTL, _ := strconv.ParseInt(r.URL.Query().Get("ttl"), 10, 64)
   	ttl := clampTTL(reqTTL, st)

   	br := bufio.NewReader(r.Body)
   	// Length-prefixed opaque encrypted manifest.
   	var mlen uint32
   	if err := binary.Read(br, binary.BigEndian, &mlen); err != nil {
   		http.Error(w, "bad request", http.StatusBadRequest)
   		return
   	}
   	if int64(mlen) > maxManifestBytes {
   		http.Error(w, "manifest too large", http.StatusBadRequest)
   		return
   	}
   	encManifest := make([]byte, mlen)
   	if _, err := io.ReadFull(br, encManifest); err != nil {
   		http.Error(w, "bad request", http.StatusBadRequest)
   		return
   	}

   	now := s.now().Unix()
   	blobKey := randToken()
   	capped := &cappedReader{r: br, max: st.MaxFileSize}
   	size, err := s.blobs.Put(r.Context(), blobKey, capped)
   	if err != nil {
   		// Put cleans up its temp file on error, so nothing is committed.
   		if errors.Is(err, errTooLarge) {
   			http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
   			return
   		}
   		http.Error(w, "server error", http.StatusInternalServerError)
   		return
   	}

   	// Daily quota: rolling 24h sum + this upload must stay within the limit.
   	used, err := s.store.UserUploadedSince(r.Context(), u.ID, now-dayWindow)
   	if err != nil {
   		_ = s.blobs.Delete(r.Context(), blobKey)
   		http.Error(w, "server error", http.StatusInternalServerError)
   		return
   	}
   	if used+size > st.DailyQuota {
   		_ = s.blobs.Delete(r.Context(), blobKey)
   		http.Error(w, "daily quota exceeded", http.StatusTooManyRequests)
   		return
   	}

   	if err := s.store.RecordUpload(r.Context(), UploadEvent{
   		ID: newID(), UserID: u.ID, Bytes: size, UploadedAt: now,
   	}); err != nil {
   		_ = s.blobs.Delete(r.Context(), blobKey)
   		http.Error(w, "server error", http.StatusInternalServerError)
   		return
   	}
   	id := newID()
   	sf := StoredFile{
   		ID: id, UserID: u.ID, BlobKey: blobKey, EncManifest: encManifest,
   		Size: size, BurnAfterRead: burn, CreatedAt: now, ExpiresAt: now + ttl,
   	}
   	if err := s.store.CreateStoredFile(r.Context(), sf); err != nil {
   		_ = s.blobs.Delete(r.Context(), blobKey)
   		http.Error(w, "server error", http.StatusInternalServerError)
   		return
   	}
   	writeJSON(w, http.StatusOK, map[string]any{"id": id, "expiresAt": sf.ExpiresAt})
   }

   // ensure storage import is used even before Task 5 adds blob streaming.
   var _ = storage.ErrNotFound
   ```
6. - [ ] Wire `registerFileRoutes` into `Routes()` in `handlers.go` — add this line just before `return mux`:
   ```go
   	s.registerFileRoutes(mux)
   ```
7. - [ ] Run to pass: `cd server && go test ./internal/account/ -run Upload` → expect `ok`.
8. - [ ] Commit: `git add server/internal/account/service.go server/internal/account/files.go server/internal/account/handlers.go server/internal/account/files_test.go && git commit -m "feat(account): zero-knowledge upload handler POST /api/files (413 oversize, 429 quota)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`.

---

## Task 5: Public + owner handlers — meta, blob (burn), list, delete

**Files:**
- Modify `server/internal/account/files.go` (4 handlers; remove the `var _ = storage.ErrNotFound` placeholder)
- Test `server/internal/account/files_test.go` (append)

**Interfaces:**
- Consumes: `Store.GetStoredFile`, `Store.ListStoredFilesByUser`, `Store.MarkDownloaded`, `Store.DeleteStoredFile` (Task 2); `BlobStore.Get`, `BlobStore.Delete` (Task 1); `registerFileRoutes` already mounts these (Task 4).
- Produces: `GET /api/files/{id}/meta` (public) → `{encManifest(base64-std), size, burnAfterRead, expiresAt}`; `GET /api/files/{id}/blob` (public) → octet-stream, burns on full read; `GET /api/files` (RequireSession) → own list, no plaintext names; `DELETE /api/files/{id}` (RequireSession, owner-only).

**Steps:**

1. - [ ] Append failing tests to `files_test.go`:
   ```go
   func TestFileMetaOKAnd404(t *testing.T) {
   	ts, _, _, mail := newFileServer(t)
   	cookie := loginCookie(t, ts, mail, "m@example.com")
   	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("MANIFEST"), []byte("blobby")))
   	var up struct{ ID string `json:"id"` }
   	decodeJSON(t, resp, &up)

   	// Public meta — no cookie needed.
   	mresp, _ := ts.Client().Get(ts.URL + "/api/files/" + up.ID + "/meta")
   	if mresp.StatusCode != http.StatusOK {
   		t.Fatalf("meta: %d", mresp.StatusCode)
   	}
   	var meta struct {
   		EncManifest   string `json:"encManifest"`
   		Size          int64  `json:"size"`
   		BurnAfterRead bool   `json:"burnAfterRead"`
   		ExpiresAt     int64  `json:"expiresAt"`
   	}
   	decodeJSON(t, mresp, &meta)
   	if meta.Size != int64(len("blobby")) {
   		t.Fatalf("meta size = %d", meta.Size)
   	}
   	dec, _ := base64.StdEncoding.DecodeString(meta.EncManifest)
   	if string(dec) != "MANIFEST" {
   		t.Fatalf("encManifest decode = %q", dec)
   	}
   	// Missing id → 404.
   	r404, _ := ts.Client().Get(ts.URL + "/api/files/deadbeef/meta")
   	if r404.StatusCode != http.StatusNotFound {
   		t.Fatalf("missing meta: want 404, got %d", r404.StatusCode)
   	}
   }

   func TestBlobStreamsAndBurnDeletes(t *testing.T) {
   	ts, _, store, mail := newFileServer(t)
   	cookie := loginCookie(t, ts, mail, "b@example.com")
   	resp := postUpload(t, ts, cookie, "?burnAfterRead=1&ttl=0", uploadBody([]byte("m"), []byte("CIPHERTEXT")))
   	var up struct{ ID string `json:"id"` }
   	decodeJSON(t, resp, &up)

   	bresp, _ := ts.Client().Get(ts.URL + "/api/files/" + up.ID + "/blob")
   	if bresp.StatusCode != http.StatusOK {
   		t.Fatalf("blob: %d", bresp.StatusCode)
   	}
   	body, _ := io.ReadAll(bresp.Body)
   	if string(body) != "CIPHERTEXT" {
   		t.Fatalf("blob body = %q", body)
   	}
   	// Burn-after-read: the row is gone and a second fetch 404s.
   	if _, err := store.GetStoredFile(context.Background(), up.ID); err != ErrNotFound {
   		t.Fatalf("burned file should be deleted, got err=%v", err)
   	}
   	again, _ := ts.Client().Get(ts.URL + "/api/files/" + up.ID + "/blob")
   	if again.StatusCode != http.StatusNotFound {
   		t.Fatalf("second blob fetch: want 404, got %d", again.StatusCode)
   	}
   }

   func TestListOwnFilesNoPlaintextNames(t *testing.T) {
   	ts, _, _, mail := newFileServer(t)
   	cookie := loginCookie(t, ts, mail, "l@example.com")
   	_ = postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), []byte("c1")))
   	req, _ := http.NewRequest("GET", ts.URL+"/api/files", nil)
   	req.AddCookie(cookie)
   	resp, _ := ts.Client().Do(req)
   	if resp.StatusCode != http.StatusOK {
   		t.Fatalf("list: %d", resp.StatusCode)
   	}
   	var out struct {
   		Files []map[string]any `json:"files"`
   	}
   	decodeJSON(t, resp, &out)
   	if len(out.Files) != 1 {
   		t.Fatalf("want 1 file, got %d", len(out.Files))
   	}
   	if _, hasName := out.Files[0]["name"]; hasName {
   		t.Fatalf("list must not expose plaintext names")
   	}
   }

   func TestDeleteFileOwnerGate(t *testing.T) {
   	ts, _, _, mail := newFileServer(t)
   	owner := loginCookie(t, ts, mail, "owner@example.com")
   	resp := postUpload(t, ts, owner, "?ttl=0", uploadBody([]byte("m"), []byte("c")))
   	var up struct{ ID string `json:"id"` }
   	decodeJSON(t, resp, &up)

   	// A different user cannot see/delete it → 404 (no existence leak).
   	other := loginCookie(t, ts, mail, "other@example.com")
   	req, _ := http.NewRequest("DELETE", ts.URL+"/api/files/"+up.ID, nil)
   	req.AddCookie(other)
   	r, _ := ts.Client().Do(req)
   	if r.StatusCode != http.StatusNotFound {
   		t.Fatalf("non-owner delete: want 404, got %d", r.StatusCode)
   	}
   	// Owner deletes → 200, then meta 404.
   	req, _ = http.NewRequest("DELETE", ts.URL+"/api/files/"+up.ID, nil)
   	req.AddCookie(owner)
   	r, _ = ts.Client().Do(req)
   	if r.StatusCode != http.StatusOK {
   		t.Fatalf("owner delete: %d", r.StatusCode)
   	}
   	m, _ := ts.Client().Get(ts.URL + "/api/files/" + up.ID + "/meta")
   	if m.StatusCode != http.StatusNotFound {
   		t.Fatalf("meta after delete: want 404, got %d", m.StatusCode)
   	}
   }
   ```
   Add `"encoding/base64"` and `"io"` to the test imports.
2. - [ ] Run to fail: `cd server && go test ./internal/account/ -run 'FileMeta|Blob|ListOwn|DeleteFile'` → expect build failure (handlers undefined).
3. - [ ] In `files.go`, replace the placeholder line `var _ = storage.ErrNotFound` with the four handlers, and add imports `"encoding/base64"`:
   ```go
   func (s *Service) handleFileMeta(w http.ResponseWriter, r *http.Request) {
   	sf, ok := s.liveFile(r, r.PathValue("id"))
   	if !ok {
   		http.Error(w, "not found", http.StatusNotFound)
   		return
   	}
   	writeJSON(w, http.StatusOK, map[string]any{
   		"encManifest":   base64.StdEncoding.EncodeToString(sf.EncManifest),
   		"size":          sf.Size,
   		"burnAfterRead": sf.BurnAfterRead,
   		"expiresAt":     sf.ExpiresAt,
   	})
   }

   func (s *Service) handleFileBlob(w http.ResponseWriter, r *http.Request) {
   	if s.blobs == nil {
   		http.Error(w, "storage unavailable", http.StatusServiceUnavailable)
   		return
   	}
   	sf, ok := s.liveFile(r, r.PathValue("id"))
   	if !ok {
   		http.Error(w, "not found", http.StatusNotFound)
   		return
   	}
   	rc, err := s.blobs.Get(r.Context(), sf.BlobKey)
   	if err != nil {
   		http.Error(w, "not found", http.StatusNotFound)
   		return
   	}
   	defer rc.Close()
   	w.Header().Set("Content-Type", "application/octet-stream")
   	w.Header().Set("Content-Length", strconv.FormatInt(sf.Size, 10))
   	n, err := io.Copy(w, rc)
   	if err != nil {
   		return // client hung up mid-stream; leave the file intact
   	}
   	// Burn-after-read: only after the whole blob streamed out. Row-state delete
   	// is idempotent so a double download can't 500.
   	if sf.BurnAfterRead && n == sf.Size {
   		_ = s.store.MarkDownloaded(r.Context(), sf.ID, s.now().Unix())
   		_ = s.blobs.Delete(r.Context(), sf.BlobKey)
   		_ = s.store.DeleteStoredFile(r.Context(), sf.ID)
   	}
   }

   func (s *Service) handleListFiles(w http.ResponseWriter, r *http.Request, u User) {
   	files, err := s.store.ListStoredFilesByUser(r.Context(), u.ID)
   	if err != nil {
   		http.Error(w, "server error", http.StatusInternalServerError)
   		return
   	}
   	out := make([]map[string]any, 0, len(files))
   	for _, f := range files {
   		out = append(out, map[string]any{
   			"id":            f.ID,
   			"size":          f.Size,
   			"createdAt":     f.CreatedAt,
   			"expiresAt":     f.ExpiresAt,
   			"burnAfterRead": f.BurnAfterRead,
   			"downloaded":    f.DownloadedAt > 0,
   		})
   	}
   	writeJSON(w, http.StatusOK, map[string]any{"files": out})
   }

   func (s *Service) handleDeleteFile(w http.ResponseWriter, r *http.Request, u User) {
   	sf, err := s.store.GetStoredFile(r.Context(), r.PathValue("id"))
   	if err != nil || sf.UserID != u.ID {
   		// Non-owner and missing are indistinguishable: no existence leak.
   		http.Error(w, "not found", http.StatusNotFound)
   		return
   	}
   	if s.blobs != nil {
   		_ = s.blobs.Delete(r.Context(), sf.BlobKey)
   	}
   	if err := s.store.DeleteStoredFile(r.Context(), sf.ID); err != nil {
   		http.Error(w, "server error", http.StatusInternalServerError)
   		return
   	}
   	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
   }

   // liveFile fetches a stored file that exists and has not expired; ok=false maps
   // to a 404 for missing, expired, or store errors (fail closed).
   func (s *Service) liveFile(r *http.Request, id string) (StoredFile, bool) {
   	sf, err := s.store.GetStoredFile(r.Context(), id)
   	if err != nil || s.now().Unix() >= sf.ExpiresAt {
   		return StoredFile{}, false
   	}
   	return sf, true
   }
   ```
   Note: the `import ( … "github.com/relayium/relayium/internal/storage" … )` block stays (Task 4 added it); the package-level `var _ = storage.ErrNotFound` is now removed because `storage` is still referenced by the `SetBlobStore`/field types in service.go — but `files.go` no longer references `storage` directly. To avoid an "imported and not used" error in `files.go`, drop `"github.com/relayium/relayium/internal/storage"` from `files.go`'s import block in this step (it was only there for the placeholder; the field type lives in service.go).
4. - [ ] Run to pass: `cd server && go test ./internal/account/ -run 'FileMeta|Blob|ListOwn|DeleteFile'` → `ok`. Then `go test ./internal/account/` → `ok`.
5. - [ ] Commit: `git add server/internal/account/files.go server/internal/account/files_test.go && git commit -m "feat(account): public meta/blob (burn-after-read) + owner list/delete for stored files" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`.

---

## Task 6: GC sweeper goroutine

**Files:**
- Create `server/internal/account/gc.go`
- Test `server/internal/account/gc_test.go`

**Interfaces:**
- Consumes: `Store.ListExpiredStoredFiles`, `Store.DeleteStoredFile`, `Store.PruneUploadEvents` (Task 2); `storage.BlobStore.Delete` (Task 1).
- Produces: `type GC struct { Store Store; Blobs storage.BlobStore; Now func() int64; Log *log.Logger }`; `(g *GC) sweep(ctx)`; `(g *GC) Run(ctx, interval time.Duration)` (initial sweep + ticker, modeled on metering.Worker). Prune cutoff = `now - 90000` (~25h).

**Steps:**

1. - [ ] Write the failing test `server/internal/account/gc_test.go`:
   ```go
   package account

   import (
   	"context"
   	"io"
   	"log"
   	"testing"

   	"github.com/relayium/relayium/internal/storage"
   )

   func TestGCSweepRemovesOnlyExpired(t *testing.T) {
   	store := newTestStore(t)
   	disk, _ := storage.NewDiskStore(t.TempDir())
   	ctx := context.Background()
   	u, _ := store.UpsertUserByEmail(ctx, "g@example.com", "G")

   	// One expired, one fresh stored file, each with a blob present.
   	for _, f := range []StoredFile{
   		{ID: "old", UserID: u.ID, BlobKey: "kold", EncManifest: []byte{1}, Size: 1, CreatedAt: 1, ExpiresAt: 100},
   		{ID: "new", UserID: u.ID, BlobKey: "knew", EncManifest: []byte{1}, Size: 1, CreatedAt: 1, ExpiresAt: 9000},
   	} {
   		_ = store.CreateStoredFile(ctx, f)
   	}
   	mustPut := func(k string) {
   		if _, err := disk.Put(ctx, k, strings1("x")); err != nil {
   			t.Fatalf("put %s: %v", k, err)
   		}
   	}
   	mustPut("kold")
   	mustPut("knew")

   	// Upload events: one ancient (prune), one recent (keep).
   	_ = store.RecordUpload(ctx, UploadEvent{ID: "ev_old", UserID: u.ID, Bytes: 1, UploadedAt: 100})
   	_ = store.RecordUpload(ctx, UploadEvent{ID: "ev_new", UserID: u.ID, Bytes: 1, UploadedAt: 999000})

   	g := &GC{Store: store, Blobs: disk, Now: func() int64 { return 1000000 }, Log: log.New(io.Discard, "", 0)}
   	g.sweep(ctx)

   	if _, err := store.GetStoredFile(ctx, "old"); err != ErrNotFound {
   		t.Fatalf("expired file not deleted: %v", err)
   	}
   	if _, err := store.GetStoredFile(ctx, "new"); err != nil {
   		t.Fatalf("fresh file wrongly deleted: %v", err)
   	}
   	if _, err := disk.Get(ctx, "kold"); err != storage.ErrNotFound {
   		t.Fatalf("expired blob not deleted: %v", err)
   	}
   	if _, err := disk.Get(ctx, "knew"); err != nil {
   		t.Fatalf("fresh blob wrongly deleted: %v", err)
   	}
   	// Ancient upload event pruned (cutoff = 1000000 - 90000 = 910000), recent kept.
   	if total, _ := store.UserUploadedSince(ctx, u.ID, 0); total != 1 {
   		t.Fatalf("upload events after prune total = %d, want 1", total)
   	}
   }
   ```
2. - [ ] Add the tiny reader helper used by the test to `gc_test.go`:
   ```go
   import "strings"

   func strings1(s string) io.Reader { return strings.NewReader(s) }
   ```
   (Merge the `strings` import into the existing import block.)
3. - [ ] Run to fail: `cd server && go test ./internal/account/ -run GCSweep` → expect build failure (`GC` undefined).
4. - [ ] Create `server/internal/account/gc.go`:
   ```go
   package account

   import (
   	"context"
   	"log"
   	"time"

   	"github.com/relayium/relayium/internal/storage"
   )

   // pruneMargin keeps upload_events ~25h: a touch beyond the 24h quota window so a
   // rolling-window sum never loses a row it still needs.
   const pruneMargin = int64(90000) // 25h

   // GC periodically deletes expired stored files (and their blobs) and prunes the
   // upload-events ledger. Modeled on metering.Worker; Now is injected for tests.
   type GC struct {
   	Store Store
   	Blobs storage.BlobStore
   	Now   func() int64
   	Log   *log.Logger
   }

   func (g *GC) sweep(ctx context.Context) {
   	now := g.Now()
   	expired, err := g.Store.ListExpiredStoredFiles(ctx, now)
   	if err != nil {
   		g.Log.Printf("gc: list expired: %v", err)
   		return
   	}
   	for _, f := range expired {
   		if g.Blobs != nil {
   			_ = g.Blobs.Delete(ctx, f.BlobKey)
   		}
   		if err := g.Store.DeleteStoredFile(ctx, f.ID); err != nil {
   			g.Log.Printf("gc: delete file %s: %v", f.ID, err)
   		}
   	}
   	if err := g.Store.PruneUploadEvents(ctx, now-pruneMargin); err != nil {
   		g.Log.Printf("gc: prune upload events: %v", err)
   	}
   }

   // Run sweeps once immediately, then every interval until ctx is cancelled.
   func (g *GC) Run(ctx context.Context, interval time.Duration) {
   	t := time.NewTicker(interval)
   	defer t.Stop()
   	g.sweep(ctx)
   	for {
   		select {
   		case <-ctx.Done():
   			return
   		case <-t.C:
   			g.sweep(ctx)
   		}
   	}
   }
   ```
5. - [ ] Run to pass: `cd server && go test ./internal/account/ -run GCSweep` → `ok`.
6. - [ ] Commit: `git add server/internal/account/gc.go server/internal/account/gc_test.go && git commit -m "feat(account): GC sweeper for expired stored files + upload-event pruning" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`.

---

## Task 7: main.go wiring + envInt64

**Files:**
- Modify `server/config.go` (add `envInt64`)
- Modify `server/main.go` (flags, blob store, seed, GC goroutine)
- Test `server/config_test.go` (append `TestEnvInt64Fallback`)

**Interfaces:**
- Consumes: `storage.NewDiskStore` (Task 1); `account.Config` new fields, `Service.SetBlobStore`, `Service.SeedSettings` (Tasks 3-4); `account.GC` (Task 6).
- Produces: flags `-blob-dir`, `-max-file-size`, `-daily-quota`, `-file-ttl`, `-file-ttl-max` with the matching `RELAYIUM_*` env fallbacks; `func envInt64(key string, def int64) int64`.

**Steps:**

1. - [ ] Append failing test to `server/config_test.go`:
   ```go
   func TestEnvInt64Fallback(t *testing.T) {
   	os.Unsetenv("RELAYIUM_TEST_INT")
   	if got := envInt64("RELAYIUM_TEST_INT", 42); got != 42 {
   		t.Errorf("unset: got %d, want 42", got)
   	}
   	t.Setenv("RELAYIUM_TEST_INT", "100")
   	if got := envInt64("RELAYIUM_TEST_INT", 42); got != 100 {
   		t.Errorf("set: got %d, want 100", got)
   	}
   	// Unparseable → default.
   	t.Setenv("RELAYIUM_TEST_INT", "notanumber")
   	if got := envInt64("RELAYIUM_TEST_INT", 42); got != 42 {
   		t.Errorf("garbage: got %d, want 42", got)
   	}
   }
   ```
2. - [ ] Run to fail: `cd server && go test . -run EnvInt64` → expect build failure (`envInt64` undefined).
3. - [ ] Add `envInt64` to `server/config.go` (after `envBool`):
   ```go
   // envInt64 parses the env var key as a base-10 int64; on an unset or unparseable
   // value it returns def.
   func envInt64(key string, def int64) int64 {
   	if v, ok := os.LookupEnv(key); ok {
   		if n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil {
   			return n
   		}
   	}
   	return def
   }
   ```
4. - [ ] Run to pass: `cd server && go test . -run EnvInt64` → `ok`.
5. - [ ] Add flags to `main.go` after the `adminPass` flag line (before `flag.Parse()`):
   ```go
   	blobDir := flag.String("blob-dir", envStr("RELAYIUM_BLOB_DIR", "./blobs"), "directory for stored-transfer ciphertext blobs")
   	maxFileSize := flag.Int64("max-file-size", envInt64("RELAYIUM_MAX_FILE_SIZE", 50<<20), "stored-transfer max single-file size in bytes (default 50 MiB)")
   	dailyQuota := flag.Int64("daily-quota", envInt64("RELAYIUM_DAILY_QUOTA", 200<<20), "stored-transfer per-account upload quota per 24h in bytes (default 200 MiB)")
   	fileTTL := flag.Int64("file-ttl", envInt64("RELAYIUM_FILE_TTL", 86400), "stored-transfer default link TTL in seconds (default 1 day)")
   	fileTTLMax := flag.Int64("file-ttl-max", envInt64("RELAYIUM_FILE_TTL_MAX", 604800), "stored-transfer max link TTL in seconds (default 7 days)")
   ```
6. - [ ] Add the four limit fields to the `account.Config{…}` literal in `main.go` (after `AdminPassword: *adminPass,`):
   ```go
   			MaxFileSize: *maxFileSize,
   			DailyQuota:  *dailyQuota,
   			DefaultTTL:  *fileTTL,
   			MaxTTL:      *fileTTLMax,
   ```
7. - [ ] Inside the `else` branch (DB available), after `validateRoom = acct.ValidateTransferToken`, construct the blob store, seed settings, and start GC:
   ```go
   		if disk, derr := storage.NewDiskStore(*blobDir); derr != nil {
   			log.Printf("WARNING: open blob dir %q: %v — stored transfers disabled", *blobDir, derr)
   		} else {
   			acct.SetBlobStore(disk)
   			if err := acct.SeedSettings(context.Background()); err != nil {
   				log.Printf("WARNING: seed settings: %v", err)
   			}
   			gc := &account.GC{
   				Store: store,
   				Blobs: disk,
   				Now:   func() int64 { return time.Now().Unix() },
   				Log:   log.Default(),
   			}
   			go gc.Run(context.Background(), 10*time.Minute)
   			log.Printf("stored transfers enabled: blobs in %s", *blobDir)
   		}
   ```
8. - [ ] Add `"github.com/relayium/relayium/internal/storage"` to `main.go` imports.
9. - [ ] Smoke: `cd server && go build ./... && go test ./...` → both succeed (`ok` for each package). Optionally `go vet ./...`.
10. - [ ] Commit: `git add server/config.go server/main.go server/config_test.go && git commit -m "feat(server): wire blob store, settings seed, GC goroutine + stored-transfer flags" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`.

---

## Task 8: Admin settings — editable form + `POST /admin/settings`

**Files:**
- Modify `server/internal/account/admin.go` (combined home data, settings section in the template, POST handler + route)
- Test `server/internal/account/admin_test.go` (append)

**Interfaces:**
- Consumes: `resolveSettings` (Task 3), `Store.SetSetting`, `Store.ListSettings` (Task 2), `isAdminReq` (admin.go).
- Produces: `adminHomeData{Users []AdminUserRow; Settings adminSettingsView}`; `adminSettingsView{MaxFileSizeMB, DailyQuotaMB, DefaultTTLHrs, MaxTTLHrs int64}`; route `POST /admin/settings` → validates (positive ints, `default_ttl <= max_ttl`), writes settings in bytes/seconds, redirects to `/admin`. Friendly units: file size/quota in MiB, TTLs in hours.

**Steps:**

1. - [ ] Append failing tests to `admin_test.go`:
   ```go
   func newAdminSettingsServer(t *testing.T) (*httptest.Server, *SQLiteStore) {
   	t.Helper()
   	store := newTestStore(t)
   	svc := NewService(store, &capturingMailer{}, Config{
   		BaseURL: "http://example.test", AdminUser: "boss", AdminPassword: "s3cret",
   		MaxFileSize: 50 << 20, DailyQuota: 200 << 20, DefaultTTL: 86400, MaxTTL: 604800,
   	})
   	mux := http.NewServeMux()
   	svc.RegisterAdmin(mux)
   	ts := httptest.NewServer(mux)
   	t.Cleanup(ts.Close)
   	return ts, store
   }

   func adminLogin(t *testing.T, ts *httptest.Server) *http.Cookie {
   	t.Helper()
   	client := ts.Client()
   	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
   	resp, _ := client.PostForm(ts.URL+"/admin/login",
   		map[string][]string{"username": {"boss"}, "password": {"s3cret"}})
   	for _, c := range resp.Cookies() {
   		if c.Name == adminCookie {
   			return c
   		}
   	}
   	t.Fatal("no admin cookie")
   	return nil
   }

   func TestAdminSettingsUpdateValid(t *testing.T) {
   	ts, store := newAdminSettingsServer(t)
   	cookie := adminLogin(t, ts)
   	client := ts.Client()
   	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
   	// 10 MiB file, 100 MiB quota, 12h default, 48h max.
   	req, _ := http.NewRequest("POST", ts.URL+"/admin/settings", strings.NewReader(
   		"max_file_size_mb=10&daily_quota_mb=100&default_ttl_hours=12&max_ttl_hours=48"))
   	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
   	req.AddCookie(cookie)
   	resp, _ := client.Do(req)
   	if resp.StatusCode != http.StatusFound {
   		t.Fatalf("valid settings POST: want 302, got %d", resp.StatusCode)
   	}
   	v, _, _ := store.GetSetting(context.Background(), SettingMaxFileSize)
   	if v != 10*1024*1024 {
   		t.Fatalf("max_file_size = %d, want 10 MiB", v)
   	}
   	if d, _, _ := store.GetSetting(context.Background(), SettingDefaultTTL); d != 12*3600 {
   		t.Fatalf("default_ttl = %d, want 43200", d)
   	}
   }

   func TestAdminSettingsRejectsInvalid(t *testing.T) {
   	ts, store := newAdminSettingsServer(t)
   	cookie := adminLogin(t, ts)
   	client := ts.Client()
   	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
   	post := func(form string) int {
   		req, _ := http.NewRequest("POST", ts.URL+"/admin/settings", strings.NewReader(form))
   		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
   		req.AddCookie(cookie)
   		resp, _ := client.Do(req)
   		return resp.StatusCode
   	}
   	// default_ttl (48h) > max_ttl (24h) → rejected.
   	if code := post("max_file_size_mb=10&daily_quota_mb=100&default_ttl_hours=48&max_ttl_hours=24"); code != http.StatusBadRequest {
   		t.Fatalf("default>max: want 400, got %d", code)
   	}
   	// Negative value → rejected.
   	if code := post("max_file_size_mb=-1&daily_quota_mb=100&default_ttl_hours=12&max_ttl_hours=48"); code != http.StatusBadRequest {
   		t.Fatalf("negative: want 400, got %d", code)
   	}
   	// Nothing persisted by the rejected posts.
   	if _, ok, _ := store.GetSetting(context.Background(), SettingMaxFileSize); ok {
   		t.Fatalf("invalid POST must not write settings")
   	}
   }

   func TestAdminSettingsRequiresAdmin(t *testing.T) {
   	ts, _ := newAdminSettingsServer(t)
   	resp, _ := ts.Client().Post(ts.URL+"/admin/settings", "application/x-www-form-urlencoded",
   		strings.NewReader("max_file_size_mb=10&daily_quota_mb=100&default_ttl_hours=12&max_ttl_hours=48"))
   	if resp.StatusCode != http.StatusUnauthorized {
   		t.Fatalf("unauth settings POST: want 401, got %d", resp.StatusCode)
   	}
   }
   ```
   Add `"context"` and `"strings"` to the `admin_test.go` imports (context is already imported; add strings).
2. - [ ] Run to fail: `cd server && go test ./internal/account/ -run AdminSettings` → expect build failure / 404 (route + handler undefined).
3. - [ ] In `admin.go`, register the route inside `RegisterAdmin` (after the logout line):
   ```go
   	mux.HandleFunc("POST /admin/settings", s.handleAdminSettings)
   ```
4. - [ ] In `admin.go`, replace `handleAdminHome` so it passes combined data:
   ```go
   type adminSettingsView struct {
   	MaxFileSizeMB int64
   	DailyQuotaMB  int64
   	DefaultTTLHrs int64
   	MaxTTLHrs     int64
   }

   type adminHomeData struct {
   	Users    []AdminUserRow
   	Settings adminSettingsView
   }

   func (s *Service) handleAdminHome(w http.ResponseWriter, r *http.Request) {
   	if !s.isAdminReq(r) {
   		renderAdminLogin(w, "")
   		return
   	}
   	rows, err := s.store.AdminListUsers(r.Context())
   	if err != nil {
   		http.Error(w, "server error", http.StatusInternalServerError)
   		return
   	}
   	st := s.resolveSettings(r.Context())
   	data := adminHomeData{
   		Users: rows,
   		Settings: adminSettingsView{
   			MaxFileSizeMB: st.MaxFileSize / (1024 * 1024),
   			DailyQuotaMB:  st.DailyQuota / (1024 * 1024),
   			DefaultTTLHrs: st.DefaultTTL / 3600,
   			MaxTTLHrs:     st.MaxTTL / 3600,
   		},
   	}
   	if err := adminUsersTmpl.Execute(w, data); err != nil {
   		http.Error(w, "server error", http.StatusInternalServerError)
   	}
   }

   func (s *Service) handleAdminSettings(w http.ResponseWriter, r *http.Request) {
   	if !s.isAdminReq(r) {
   		http.Error(w, "unauthorized", http.StatusUnauthorized)
   		return
   	}
   	atoi := func(k string) (int64, bool) {
   		n, err := strconv.ParseInt(strings.TrimSpace(r.FormValue(k)), 10, 64)
   		return n, err == nil && n > 0
   	}
   	mb, ok1 := atoi("max_file_size_mb")
   	quota, ok2 := atoi("daily_quota_mb")
   	defH, ok3 := atoi("default_ttl_hours")
   	maxH, ok4 := atoi("max_ttl_hours")
   	if !(ok1 && ok2 && ok3 && ok4) || defH > maxH {
   		http.Error(w, "invalid settings (positive integers; default_ttl <= max_ttl)", http.StatusBadRequest)
   		return
   	}
   	now := s.now().Unix()
   	updates := []struct {
   		key string
   		val int64
   	}{
   		{SettingMaxFileSize, mb * 1024 * 1024},
   		{SettingDailyQuota, quota * 1024 * 1024},
   		{SettingDefaultTTL, defH * 3600},
   		{SettingMaxTTL, maxH * 3600},
   	}
   	for _, u := range updates {
   		if err := s.store.SetSetting(r.Context(), u.key, u.val, now); err != nil {
   			http.Error(w, "server error", http.StatusInternalServerError)
   			return
   		}
   	}
   	http.Redirect(w, r, "/admin", http.StatusFound)
   }
   ```
   Add `"strings"` to the `admin.go` import block (it already imports `strconv`, `html/template`, `net/http`, `time`, `crypto/subtle`).
5. - [ ] In `admin.go`, update `adminUsersTmpl` to consume the combined struct: the template now ranges over `.Users` and renders a settings form from `.Settings`. Replace the template body (between the `<body>` and `</body>` tags) with:
   ```html
   <body>
   <div class="top"><h1>注册用户（{{len .Users}}）</h1>
   <form method="post" action="/admin/logout"><button type="submit">退出</button></form></div>

   <section class="settings">
   <h2>暂存传输设置</h2>
   <form method="post" action="/admin/settings" class="grid">
   <label>单文件上限 (MiB)<input type="number" name="max_file_size_mb" min="1" value="{{.Settings.MaxFileSizeMB}}"></label>
   <label>每账号每日额度 (MiB)<input type="number" name="daily_quota_mb" min="1" value="{{.Settings.DailyQuotaMB}}"></label>
   <label>默认有效期 (小时)<input type="number" name="default_ttl_hours" min="1" value="{{.Settings.DefaultTTLHrs}}"></label>
   <label>最长有效期 (小时)<input type="number" name="max_ttl_hours" min="1" value="{{.Settings.MaxTTLHrs}}"></label>
   <button type="submit">保存设置</button>
   </form>
   </section>

   <table><thead><tr>
   <th>邮箱</th><th>显示名</th><th>注册时间(UTC)</th><th>登录方式</th><th>设备</th><th>中继流量</th>
   </tr></thead><tbody>
   {{range .Users}}<tr>
   <td>{{.Email}}</td><td>{{.DisplayName}}</td><td>{{ts .CreatedAt}}</td>
   <td>{{range $i, $m := .Methods}}{{if $i}}, {{end}}{{$m}}{{end}}</td>
   <td>{{.DeviceCount}}</td><td>{{bytes .RelayedBytes}}</td>
   </tr>{{end}}
   </tbody></table>
   </body></html>
   ```
   and extend the `<style>` block with:
   ```css
   .settings{margin:18px 0 26px}.settings h2{font-size:16px}
   .settings .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;max-width:520px}
   .settings label{display:flex;flex-direction:column;font-size:13px;gap:4px}
   .settings input{font:inherit;padding:6px 8px}
   .settings button{font:inherit;padding:8px 14px;grid-column:1/-1;width:max-content}
   ```
6. - [ ] Run to pass: `cd server && go test ./internal/account/ -run 'Admin'` → `ok` (existing `TestAdminLoginGate` still passes: it checks the page contains `seen@example.com`, still rendered via `.Users`).
7. - [ ] Commit: `git add server/internal/account/admin.go server/internal/account/admin_test.go && git commit -m "feat(admin): editable stored-transfer settings form + POST /admin/settings with validation" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`.

---

## Task 9: `web/src/lib/store-crypto.ts` — random key, streaming AES-256-GCM, manifest, base64url

**Files:**
- Create `web/src/lib/store-crypto.ts`
- Test `web/src/lib/store-crypto.test.ts`

**Interfaces:**
- Consumes: `ready` from `./crypto`; `libsodium-wrappers` (`randombytes_buf`, `to_base64`/`from_base64` with `URLSAFE_NO_PADDING`).
- Produces: `STORE_CHUNK_SIZE = 192*1024`; `type StoredManifest = { files: { name: string; size: number }[] }`; `type StoreKey = { key: CryptoKey; raw: Uint8Array }`; `generateStoreKey()`, `importStoreKey(raw)`, `encodeKey(raw)`, `decodeKey(s)`, `encryptManifest(key, m)`, `decryptManifest(key, ct)`, `encryptFiles(files, key)` (async generator of `uint32BE(len) || ct` frames, seq from 1), `class StoreDecryptor` (`push(data)`/`end()` async generators yielding plaintext). Nonce = `0x00000000 || uint64BE(seq)`; manifest seq=0, chunks seq≥1.

**Steps:**

1. - [ ] Write the failing test `web/src/lib/store-crypto.test.ts`:
   ```ts
   import { describe, it, expect } from "vitest";
   import {
     generateStoreKey,
     importStoreKey,
     encodeKey,
     decodeKey,
     encryptManifest,
     decryptManifest,
     encryptFiles,
     StoreDecryptor,
     type StoredManifest,
   } from "./store-crypto";

   function concat(parts: Uint8Array[]): Uint8Array {
     const total = parts.reduce((n, p) => n + p.length, 0);
     const out = new Uint8Array(total);
     let off = 0;
     for (const p of parts) { out.set(p, off); off += p.length; }
     return out;
   }

   describe("store-crypto base64url", () => {
     it("roundtrips a 32-byte key", async () => {
       const sk = await generateStoreKey();
       expect(sk.raw.length).toBe(32);
       const s = encodeKey(sk.raw);
       expect(s).not.toContain("+");
       expect(s).not.toContain("/");
       expect(s).not.toContain("=");
       expect(decodeKey(s)).toEqual(sk.raw);
     });
   });

   describe("store-crypto manifest", () => {
     it("encrypt → decrypt yields the original manifest", async () => {
       const sk = await generateStoreKey();
       const m: StoredManifest = { files: [{ name: "secret.pdf", size: 42 }, { name: "图片.png", size: 7 }] };
       const ct = await encryptManifest(sk.key, m);
       expect(await decryptManifest(sk.key, ct)).toEqual(m);
     });
     it("fails to decrypt a tampered manifest", async () => {
       const sk = await generateStoreKey();
       const ct = await encryptManifest(sk.key, { files: [{ name: "a", size: 1 }] });
       ct[0] ^= 0xff;
       await expect(decryptManifest(sk.key, ct)).rejects.toBeTruthy();
     });
   });

   describe("store-crypto file stream", () => {
     it("encrypt → decrypt roundtrips multi-chunk bytes", async () => {
       const sk = await generateStoreKey();
       // 400 KiB → 3 chunks at 192 KiB.
       const bytes = new Uint8Array(400 * 1024);
       for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
       const file = new File([bytes], "big.bin");
       const frames: Uint8Array[] = [];
       for await (const fr of encryptFiles([file], sk.key)) frames.push(fr);
       const blob = concat(frames);

       const dec = new StoreDecryptor(await importStoreKey(sk.raw));
       const out: Uint8Array[] = [];
       // Feed the blob in awkward 100 KiB slices to exercise frame reassembly.
       for (let off = 0; off < blob.length; off += 100 * 1024) {
         for await (const pt of dec.push(blob.slice(off, off + 100 * 1024))) out.push(pt);
       }
       for await (const pt of dec.end()) out.push(pt);
       expect(concat(out)).toEqual(bytes);
     });

     it("throws on a tampered ciphertext frame", async () => {
       const sk = await generateStoreKey();
       const file = new File([new Uint8Array([1, 2, 3, 4])], "x");
       const frames: Uint8Array[] = [];
       for await (const fr of encryptFiles([file], sk.key)) frames.push(fr);
       const blob = concat(frames);
       blob[blob.length - 1] ^= 0xff; // corrupt the GCM tag
       const dec = new StoreDecryptor(sk.key);
       await expect(
         (async () => { for await (const _ of dec.push(blob)) { /* drain */ } })(),
       ).rejects.toBeTruthy();
     });
   });
   ```
2. - [ ] Run to fail: `cd web && npx vitest run src/lib/store-crypto.test.ts` → expect `Cannot find module './store-crypto'`.
3. - [ ] Implement `web/src/lib/store-crypto.ts`:
   ```ts
   // Zero-knowledge stored-transfer crypto. A single random AES-256-GCM key per
   // upload encrypts both the manifest (filenames + sizes) and the file bytes,
   // reusing the same nonce-from-counter scheme as transfer.ts. The key lives only
   // in the URL fragment; the server stores opaque ciphertext.
   import sodium from "libsodium-wrappers";
   import { ready } from "./crypto";

   type Bytes = Uint8Array<ArrayBuffer>;

   export const STORE_CHUNK_SIZE = 192 * 1024;

   export interface StoredManifest {
     files: { name: string; size: number }[];
   }

   export interface StoreKey {
     key: CryptoKey;
     raw: Bytes;
   }

   const enc = new TextEncoder();
   const dec = new TextDecoder();

   async function importKey(raw: Bytes): Promise<CryptoKey> {
     return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
   }

   // 12-byte nonce: 4 zero bytes then a 64-bit big-endian counter. Manifest uses
   // seq 0; file chunks use seq 1,2,3… so no nonce is ever reused under one key.
   function nonce(seq: number): Bytes {
     const n = new Uint8Array(12);
     const v = new DataView(n.buffer);
     v.setUint32(4, Math.floor(seq / 2 ** 32));
     v.setUint32(8, seq >>> 0);
     return n;
   }

   export async function generateStoreKey(): Promise<StoreKey> {
     await ready();
     const raw = sodium.randombytes_buf(32) as Bytes;
     return { key: await importKey(raw), raw };
   }

   export async function importStoreKey(raw: Uint8Array): Promise<CryptoKey> {
     return importKey(raw as Bytes);
   }

   export function encodeKey(raw: Uint8Array): string {
     return sodium.to_base64(raw, sodium.base64_variants.URLSAFE_NO_PADDING);
   }

   export function decodeKey(s: string): Bytes {
     return sodium.from_base64(s, sodium.base64_variants.URLSAFE_NO_PADDING) as Bytes;
   }

   export async function encryptManifest(key: CryptoKey, m: StoredManifest): Promise<Bytes> {
     const pt = enc.encode(JSON.stringify(m)) as Bytes;
     const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(0) }, key, pt);
     return new Uint8Array(ct);
   }

   export async function decryptManifest(key: CryptoKey, ct: Uint8Array): Promise<StoredManifest> {
     const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(0) }, key, ct as Bytes);
     return JSON.parse(dec.decode(new Uint8Array(pt))) as StoredManifest;
   }

   // length-prefixed frame: uint32BE(len(ct)) || ct.
   function frame(ct: Uint8Array): Bytes {
     const out = new Uint8Array(4 + ct.length);
     new DataView(out.buffer).setUint32(0, ct.length);
     out.set(ct, 4);
     return out;
   }

   // Stream every file's chunks as encrypted frames; seq is global across files,
   // starting at 1 (0 is the manifest).
   export async function* encryptFiles(files: File[], key: CryptoKey): AsyncGenerator<Bytes> {
     let seq = 1;
     for (const file of files) {
       for (let off = 0; off < file.size; off += STORE_CHUNK_SIZE) {
         const piece = new Uint8Array(await file.slice(off, off + STORE_CHUNK_SIZE).arrayBuffer()) as Bytes;
         const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(seq) }, key, piece));
         yield frame(ct);
         seq++;
       }
     }
   }

   // StoreDecryptor reassembles length-prefixed frames across arbitrary network
   // chunk boundaries and yields decrypted plaintext in order. Throws on tamper.
   export class StoreDecryptor {
     private seq = 1;
     private buf = new Uint8Array(0);
     constructor(private key: CryptoKey) {}

     async *push(data: Uint8Array): AsyncGenerator<Bytes> {
       const merged = new Uint8Array(this.buf.length + data.length);
       merged.set(this.buf, 0);
       merged.set(data, this.buf.length);
       let off = 0;
       while (off + 4 <= merged.length) {
         const len = new DataView(merged.buffer, merged.byteOffset + off, 4).getUint32(0);
         if (off + 4 + len > merged.length) break; // frame incomplete; wait for more
         const ct = merged.slice(off + 4, off + 4 + len) as Bytes;
         const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(this.seq) }, this.key, ct);
         this.seq++;
         off += 4 + len;
         yield new Uint8Array(pt);
       }
       this.buf = off < merged.length ? merged.slice(off) : new Uint8Array(0);
     }

     // eslint-disable-next-line require-yield
     async *end(): AsyncGenerator<Bytes> {
       if (this.buf.length !== 0) throw new Error("store-crypto: trailing bytes — truncated stream");
     }
   }
   ```
4. - [ ] Run to pass: `cd web && npx vitest run src/lib/store-crypto.test.ts` → expect all tests pass.
5. - [ ] Type-check: `cd web && npm run check` → no errors.
6. - [ ] Commit: `git add web/src/lib/store-crypto.ts web/src/lib/store-crypto.test.ts && git commit -m "feat(web): store-crypto — random key + streaming AES-256-GCM + manifest + base64url" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`.

---

## Task 10: `web/src/lib/stored-file.ts` — upload / fetchMeta / downloadBlob / buildDownloadLink

**Files:**
- Modify `web/src/lib/transfer-link.ts` (add `DOWNLOAD_PREFIX`)
- Create `web/src/lib/stored-file.ts`
- Test `web/src/lib/stored-file.test.ts`

**Interfaces:**
- Consumes: `generateStoreKey`, `encryptManifest`, `encryptFiles`, `encodeKey`, `decodeKey`, `importStoreKey`, `StoreDecryptor`, `type StoredManifest` (Task 9); `DOWNLOAD_PREFIX` (transfer-link.ts).
- Produces: `DOWNLOAD_PREFIX = "/d/"` (in transfer-link.ts); `class UploadError extends Error { status: number }`; `uploadFile(files, {burnAfterRead, ttl}, onProgress?) → {id, expiresAt, key}` (POSTs assembled body to `/api/files?burnAfterRead=&ttl=`); `fetchMeta(id) → {encManifest, size, burnAfterRead, expiresAt}`; `downloadBlob(id, key: CryptoKey, onChunk, onProgress?)`; `buildDownloadLink(origin, id, key) → "${origin}/d/${id}#k=${key}"`; `parseDownloadKey(hash) → key|""`.
- Note: body is assembled into a single `Blob` (single-file ≤ 50 MiB) and POSTed; `onProgress` reports client-side encryption progress (plaintext bytes), since fetch+Blob gives no upload progress events. Documented MVP tradeoff.

**Steps:**

1. - [ ] Add to `web/src/lib/transfer-link.ts` (after the `CROSS_PATH` export):
   ```ts
   /** Path prefix of the public stored-download page: /d/<id>. Single source of truth. */
   export const DOWNLOAD_PREFIX = "/d/";
   ```
2. - [ ] Write the failing test `web/src/lib/stored-file.test.ts`:
   ```ts
   import { describe, it, expect, vi, afterEach } from "vitest";
   import {
     uploadFile,
     fetchMeta,
     buildDownloadLink,
     parseDownloadKey,
     UploadError,
   } from "./stored-file";

   afterEach(() => vi.unstubAllGlobals());

   describe("buildDownloadLink", () => {
     it("puts id in the path and key in the fragment", () => {
       expect(buildDownloadLink("https://relayium.app", "abc", "KEY")).toBe(
         "https://relayium.app/d/abc#k=KEY",
       );
     });
   });

   describe("parseDownloadKey", () => {
     it("extracts a base64url key from #k=", () => {
       expect(parseDownloadKey("#k=AbC-_123")).toBe("AbC-_123");
     });
     it("returns empty for missing or malformed fragments", () => {
       expect(parseDownloadKey("")).toBe("");
       expect(parseDownloadKey("#t=abc")).toBe("");
       expect(parseDownloadKey("#k=")).toBe("");
     });
   });

   describe("uploadFile", () => {
     it("POSTs to /api/files with query + credentials and returns id/expiresAt/key", async () => {
       const fetchMock = vi.fn().mockResolvedValue({
         ok: true,
         json: async () => ({ id: "file42", expiresAt: 999 }),
       });
       vi.stubGlobal("fetch", fetchMock);
       const file = new File([new Uint8Array([1, 2, 3])], "secret.txt");
       const out = await uploadFile([file], { burnAfterRead: true, ttl: 3600 });
       expect(out.id).toBe("file42");
       expect(out.expiresAt).toBe(999);
       expect(out.key.length).toBeGreaterThan(0);
       const [url, init] = fetchMock.mock.calls[0];
       expect(url).toBe("/api/files?burnAfterRead=1&ttl=3600");
       expect(init.method).toBe("POST");
       expect(init.credentials).toBe("include");
       expect(init.body).toBeInstanceOf(Blob);
     });

     it("throws UploadError with the HTTP status on failure", async () => {
       vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 413 }));
       const file = new File([new Uint8Array([1])], "x");
       await expect(uploadFile([file], { burnAfterRead: false, ttl: 0 })).rejects.toMatchObject({
         status: 413,
       });
       await expect(uploadFile([file], { burnAfterRead: false, ttl: 0 })).rejects.toBeInstanceOf(UploadError);
     });
   });

   describe("fetchMeta", () => {
     it("GETs /api/files/<id>/meta and parses the body", async () => {
       const fetchMock = vi.fn().mockResolvedValue({
         ok: true,
         json: async () => ({ encManifest: "AAAA", size: 10, burnAfterRead: false, expiresAt: 5 }),
       });
       vi.stubGlobal("fetch", fetchMock);
       const meta = await fetchMeta("abc");
       expect(meta.size).toBe(10);
       expect(fetchMock).toHaveBeenCalledWith("/api/files/abc/meta");
     });
     it("throws on a non-ok response", async () => {
       vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
       await expect(fetchMeta("gone")).rejects.toThrow("404");
     });
   });
   ```
3. - [ ] Run to fail: `cd web && npx vitest run src/lib/stored-file.test.ts` → expect `Cannot find module './stored-file'`.
4. - [ ] Implement `web/src/lib/stored-file.ts`:
   ```ts
   // API wrappers for the zero-knowledge stored-transfer mode. All encryption
   // happens here/in store-crypto; the server only ever receives ciphertext.
   import {
     generateStoreKey,
     importStoreKey,
     encryptManifest,
     encryptFiles,
     decodeKey,
     encodeKey,
     StoreDecryptor,
     type StoredManifest,
   } from "./store-crypto";
   import { DOWNLOAD_PREFIX } from "./transfer-link";

   export interface UploadResult {
     id: string;
     expiresAt: number;
     key: string; // base64url, belongs in the URL fragment only
   }

   export interface StoredFileMeta {
     encManifest: string; // base64 (standard)
     size: number;
     burnAfterRead: boolean;
     expiresAt: number;
   }

   /** Non-ok upload response, carrying the HTTP status so the UI can map 413/429. */
   export class UploadError extends Error {
     constructor(public status: number) {
       super(`upload failed: ${status}`);
       this.name = "UploadError";
     }
   }

   /** Encrypt files in-browser and POST the ciphertext; returns the link parts. */
   export async function uploadFile(
     files: File[],
     opts: { burnAfterRead: boolean; ttl: number },
     onProgress?: (sent: number, total: number) => void,
   ): Promise<UploadResult> {
     const sk = await generateStoreKey();
     const manifest: StoredManifest = { files: files.map((f) => ({ name: f.name, size: f.size })) };
     const encManifest = await encryptManifest(sk.key, manifest);

     const total = files.reduce((n, f) => n + f.size, 0);
     const header = new Uint8Array(4);
     new DataView(header.buffer).setUint32(0, encManifest.length);
     const parts: BlobPart[] = [header, encManifest];
     let sent = 0;
     for await (const fr of encryptFiles(files, sk.key)) {
       parts.push(fr);
       sent += fr.length - 4 - 16; // frame = 4-byte len + (plaintext + 16-byte tag)
       onProgress?.(Math.min(sent, total), total);
     }

     const query = `?burnAfterRead=${opts.burnAfterRead ? 1 : 0}&ttl=${opts.ttl}`;
     const res = await fetch("/api/files" + query, {
       method: "POST",
       credentials: "include",
       body: new Blob(parts),
     });
     if (!res.ok) throw new UploadError(res.status);
     const { id, expiresAt } = (await res.json()) as { id: string; expiresAt: number };
     return { id, expiresAt, key: encodeKey(sk.raw) };
   }

   export async function fetchMeta(id: string): Promise<StoredFileMeta> {
     const res = await fetch(`/api/files/${encodeURIComponent(id)}/meta`);
     if (!res.ok) throw new Error(`meta failed: ${res.status}`);
     return res.json();
   }

   /** Stream the ciphertext, decrypt chunk-by-chunk, and hand plaintext to onChunk. */
   export async function downloadBlob(
     id: string,
     key: CryptoKey,
     onChunk: (pt: Uint8Array) => Promise<void>,
     onProgress?: (received: number) => void,
   ): Promise<void> {
     const res = await fetch(`/api/files/${encodeURIComponent(id)}/blob`);
     if (!res.ok) throw new Error(`blob failed: ${res.status}`);
     if (!res.body) throw new Error("streaming not supported");
     const decryptor = new StoreDecryptor(key);
     const reader = res.body.getReader();
     let received = 0;
     for (;;) {
       const { done, value } = await reader.read();
       if (done) break;
       for await (const pt of decryptor.push(value)) {
         await onChunk(pt);
         received += pt.length;
         onProgress?.(received);
       }
     }
     for await (const pt of decryptor.end()) {
       await onChunk(pt);
       received += pt.length;
       onProgress?.(received);
     }
   }

   /** Build the shareable download link; key goes only in the fragment. */
   export function buildDownloadLink(origin: string, id: string, key: string): string {
     return `${origin}${DOWNLOAD_PREFIX}${id}#k=${key}`;
   }

   /** Extract the base64url key from a location hash like "#k=...". "" if none. */
   export function parseDownloadKey(hash: string): string {
     const m = /^#k=([A-Za-z0-9_-]+)$/.exec(hash);
     return m ? m[1] : "";
   }

   /** Import a base64url key string into a CryptoKey for decryption. */
   export async function keyFromFragment(k: string): Promise<CryptoKey> {
     return importStoreKey(decodeKey(k));
   }
   ```
5. - [ ] Run to pass: `cd web && npx vitest run src/lib/stored-file.test.ts` → all pass.
6. - [ ] Type-check: `cd web && npm run check` → no errors.
7. - [ ] Commit: `git add web/src/lib/stored-file.ts web/src/lib/transfer-link.ts web/src/lib/stored-file.test.ts && git commit -m "feat(web): stored-file API — upload/fetchMeta/downloadBlob/buildDownloadLink" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`.

---

## Task 11: Router — recognize `/d/<id>` download route

**Files:**
- Modify `web/src/lib/router.svelte.ts`
- Test `web/src/lib/router.test.ts` (append)

**Interfaces:**
- Consumes: `DOWNLOAD_PREFIX` from `./transfer-link` (Task 10).
- Produces: `Route` extended to `"lan" | "cross" | "download"`; `routeFromLocation` returns `"download"` for `/d/<id>`; `downloadId(pathname) → id|""`.

**Steps:**

1. - [ ] Append failing tests to `web/src/lib/router.test.ts`:
   ```ts
   import { routeFromLocation as rfl, downloadId } from "./router.svelte";

   describe("download route", () => {
     it("is download for /d/<id>", () => {
       expect(rfl("/d/abc123", "")).toBe("download");
     });
     it("extracts the id from the path", () => {
       expect(downloadId("/d/abc123")).toBe("abc123");
       expect(downloadId("/")).toBe("");
     });
     it("does not treat bare /d/ as a download route", () => {
       expect(rfl("/d/", "")).toBe("lan");
     });
     it("leaves normal routes unaffected", () => {
       expect(rfl("/", "")).toBe("lan");
       expect(rfl(CROSS_PATH, "")).toBe("cross");
     });
   });
   ```
   (The existing file already imports `routeFromLocation` and `CROSS_PATH`; add `downloadId` to the import on line 2 and reuse `CROSS_PATH`. The alias `rfl` avoids redeclaring `routeFromLocation`.)
2. - [ ] Run to fail: `cd web && npx vitest run src/lib/router.test.ts` → expect `downloadId is not exported` / failure.
3. - [ ] Edit `web/src/lib/router.svelte.ts`:
   - Update the import on line 6 to: `import { parseTransferToken, CROSS_PATH, DOWNLOAD_PREFIX } from "./transfer-link";`
   - Change the type: `export type Route = "lan" | "cross" | "download";`
   - Replace `routeFromLocation` with:
     ```ts
     export function routeFromLocation(pathname: string, hash: string): Route {
       if (downloadId(pathname)) return "download";
       if (parseTransferToken(hash)) return "cross";
       return pathname === CROSS_PATH ? "cross" : "lan";
     }

     /** Extract the file id from a /d/<id> path, or "" when not a download path. */
     export function downloadId(pathname: string): string {
       return pathname.startsWith(DOWNLOAD_PREFIX)
         ? pathname.slice(DOWNLOAD_PREFIX.length)
         : "";
     }
     ```
4. - [ ] Run to pass: `cd web && npx vitest run src/lib/router.test.ts` → all pass.
5. - [ ] Type-check: `cd web && npm run check` → no errors.
6. - [ ] Commit: `git add web/src/lib/router.svelte.ts web/src/lib/router.test.ts && git commit -m "feat(web): router recognizes public /d/<id> download route" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`.

---

## Task 12: Upload UI — "生成下载链接" on the cross-network page

> **Ordering note:** This task references i18n keys `t.stored.*` added in **Task 14**. If executing strictly task-by-task, implement **Task 14 before Task 12** (and 13) so `npm run check` passes. The decomposition lists i18n last, but the UI components depend on it.

**Files:**
- Create `web/src/lib/StoredUpload.svelte`
- Modify `web/src/lib/CrossPage.svelte` (render `StoredUpload` for logged-in users)

**Interfaces:**
- Consumes: `uploadFile`, `buildDownloadLink`, `UploadError` (Task 10); `session` from `./auth.svelte`; `lang`/`messages`/`Messages` (i18n); `qrcode` lazy import (existing dep, same pattern as `CrossNetwork.svelte`).
- Produces: a login-gated upload card with file picker, burn checkbox, TTL `<select>` (1 day / 3 days / 7 days), progress, resulting link + copy + QR. No component unit test (matches repo convention); verified via `npm run check` + `npm run build`.

**Steps:**

1. - [ ] Create `web/src/lib/StoredUpload.svelte`:
   ```svelte
   <script lang="ts">
     import { uploadFile, buildDownloadLink, UploadError } from "./stored-file";
     import { lang, messages, type Messages } from "./i18n.svelte";

     const t = $derived<Messages>(messages[lang()]);

     let burn = $state(false);
     let ttl = $state(86400); // default 1 day
     let busy = $state(false);
     let progress = $state(0); // 0..100
     let link = $state("");
     let err = $state("");
     let copied = $state(false);
     let qrDataUrl = $state("");

     $effect(() => {
       if (link) {
         import("qrcode").then((m) =>
           m.toDataURL(link, { margin: 1, width: 192 }).then((u) => (qrDataUrl = u)),
         );
       } else {
         qrDataUrl = "";
       }
     });

     async function onPick(e: Event) {
       const input = e.currentTarget as HTMLInputElement;
       const files = input.files ? Array.from(input.files) : [];
       input.value = "";
       if (files.length === 0) return;
       err = "";
       link = "";
       busy = true;
       progress = 0;
       try {
         const out = await uploadFile(files, { burnAfterRead: burn, ttl }, (sent, total) => {
           progress = total > 0 ? Math.round((sent / total) * 100) : 0;
         });
         link = buildDownloadLink(location.origin, out.id, out.key);
       } catch (e2) {
         if (e2 instanceof UploadError && e2.status === 413) err = t.stored.errTooLarge;
         else if (e2 instanceof UploadError && e2.status === 429) err = t.stored.errQuota;
         else err = t.stored.errUpload;
       } finally {
         busy = false;
       }
     }

     async function copy() {
       await navigator.clipboard.writeText(link);
       copied = true;
       setTimeout(() => (copied = false), 2000);
     }
   </script>

   <section class="stored">
     <h2>{t.stored.title}</h2>
     <p class="desc">{t.stored.desc}</p>

     <div class="opts">
       <label class="opt"><input type="checkbox" bind:checked={burn} />{t.stored.burnLabel}</label>
       <label class="opt">{t.stored.ttlLabel}
         <select bind:value={ttl}>
           <option value={86400}>{t.stored.ttl1d}</option>
           <option value={259200}>{t.stored.ttl3d}</option>
           <option value={604800}>{t.stored.ttl7d}</option>
         </select>
       </label>
     </div>

     <label class="pick" class:disabled={busy}>
       <input type="file" multiple disabled={busy} onchange={onPick} />
       <span>{busy ? t.stored.uploading : t.stored.pick}</span>
     </label>

     {#if busy}
       <div class="bar"><div class="fill" style:width="{progress}%"></div></div>
     {/if}

     {#if err}<p class="error">{err}</p>{/if}

     {#if link}
       <p class="ready">{t.stored.linkReady}</p>
       <div class="row">
         <input readonly value={link} />
         <button onclick={copy}>{copied ? t.stored.copied : t.stored.copy}</button>
       </div>
       {#if qrDataUrl}<img class="qr" src={qrDataUrl} alt="QR" width="192" height="192" />{/if}
     {/if}
   </section>

   <style>
     .stored { border: 1px solid var(--border); border-radius: 14px; padding: 16px 18px; margin: 18px 0; background: var(--social-bg); }
     .stored h2 { font-size: 17px; margin: 0 0 6px; }
     .desc { color: var(--text); font-size: 13.5px; margin: 0 0 12px; }
     .opts { display: flex; flex-wrap: wrap; gap: 18px; margin-bottom: 12px; font-size: 14px; }
     .opt { display: flex; align-items: center; gap: 8px; }
     .pick { display: inline-flex; align-items: center; gap: 10px; padding: 10px 16px; border: 1.5px dashed var(--border); border-radius: 12px; cursor: pointer; }
     .pick.disabled { opacity: .6; cursor: not-allowed; }
     .pick input[type="file"] { display: none; }
     .bar { height: 8px; border-radius: 999px; background: var(--code-bg); overflow: hidden; margin-top: 12px; }
     .fill { height: 100%; background: linear-gradient(90deg, var(--accent), #6d28d9); transition: width .2s; }
     .ready { color: var(--text-h); font-size: 14px; margin: 12px 0 6px; }
     .row { display: flex; gap: 8px; }
     .row input { flex: 1; font: inherit; padding: 8px 10px; }
     .row button { font: inherit; padding: 8px 14px; cursor: pointer; }
     .qr { margin-top: 12px; }
     .error { color: var(--accent); font-size: 13.5px; margin-top: 10px; }
   </style>
   ```
2. - [ ] Edit `web/src/lib/CrossPage.svelte`:
   - Add the import after the `CrossNetwork` import: `import StoredUpload from "./StoredUpload.svelte";`
   - Render it right after `<CrossNetwork {roomToken} />`, gated on a logged-in user who is not a recipient:
     ```svelte
       {#if session().user && !roomToken}
         <StoredUpload />
       {/if}
     ```
   (CrossPage already imports `session`.)
3. - [ ] Type-check: `cd web && npm run check` → no errors (requires Task 14 keys present).
4. - [ ] Build: `cd web && npm run build` → succeeds.
5. - [ ] Commit: `git add web/src/lib/StoredUpload.svelte web/src/lib/CrossPage.svelte && git commit -m "feat(web): stored-transfer upload card (burn/TTL, progress, link, QR) on cross page" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`.

---

## Task 13: Download page `/d/<id>` + App routing

> **Ordering note:** Depends on **Task 14** (i18n keys `t.download.*`).

**Files:**
- Create `web/src/lib/DownloadPage.svelte`
- Modify `web/src/App.svelte` (render `DownloadPage` for the `download` route)

**Interfaces:**
- Consumes: `fetchMeta`, `downloadBlob`, `parseDownloadKey`, `keyFromFragment`, `StoredFileMeta` (Task 10); `decryptManifest`, `type StoredManifest` (Task 9); `pickSaveTarget`, `type SaveTarget`, `type FileSink` (filesink.ts); `downloadId` (Task 11); i18n.
- Produces: a public no-login page that reads `#k=`, fetches meta, decrypts the manifest, lists names/sizes, and on click streams + decrypts + saves via filesink, routing decrypted bytes across files by manifest sizes. Handles invalid/expired/burned (meta 404), missing key, unsupported browser, and decryption failure.

**Steps:**

1. - [ ] Create `web/src/lib/DownloadPage.svelte`:
   ```svelte
   <script lang="ts">
     import { onMount } from "svelte";
     import { fetchMeta, downloadBlob, parseDownloadKey, keyFromFragment } from "./stored-file";
     import { decryptManifest, type StoredManifest } from "./store-crypto";
     import { pickSaveTarget, type SaveTarget, type FileSink } from "./filesink";
     import { lang, messages, legalUrl, type Messages } from "./i18n.svelte";

     let { id }: { id: string } = $props();

     const t = $derived<Messages>(messages[lang()]);

     type State = "loading" | "ready" | "downloading" | "done" | "error";
     let state = $state<State>("loading");
     let errKey = $state<"notFound" | "noKey" | "decryptFail" | "unsupported" | "">("");
     let manifest = $state<StoredManifest | null>(null);
     let key: CryptoKey | null = null;
     let progress = $state(0); // 0..100

     onMount(async () => {
       if (!window.isSecureContext || !crypto.subtle) { state = "error"; errKey = "unsupported"; return; }
       const k = parseDownloadKey(location.hash);
       if (!k) { state = "error"; errKey = "noKey"; return; }
       try {
         const meta = await fetchMeta(id);
         key = await keyFromFragment(k);
         manifest = await decryptManifest(key, base64ToBytes(meta.encManifest));
         state = "ready";
       } catch (e) {
         state = "error";
         errKey = isNotFound(e) ? "notFound" : "decryptFail";
       }
     });

     function isNotFound(e: unknown): boolean {
       return e instanceof Error && /\b404\b/.test(e.message);
     }
     function base64ToBytes(b64: string): Uint8Array {
       const bin = atob(b64);
       const out = new Uint8Array(bin.length);
       for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
       return out;
     }
     const totalBytes = $derived(manifest ? manifest.files.reduce((n, f) => n + f.size, 0) : 0);

     async function download() {
       if (!manifest || !key) return;
       let target: SaveTarget;
       try {
         target = await pickSaveTarget(manifest.files.map((f) => ({ name: f.name, size: f.size })));
       } catch {
         return; // user cancelled the save picker
       }
       state = "downloading";
       progress = 0;
       // Plaintext is the concatenation of all files; split by manifest sizes.
       let fileIdx = 0;
       let intoFile = 0;
       let sink: FileSink | null = manifest.files.length ? await target.file(manifest.files[0].name, manifest.files[0].size) : null;
       try {
         await downloadBlob(
           id,
           key,
           async (pt: Uint8Array) => {
             let off = 0;
             while (off < pt.length && fileIdx < manifest!.files.length) {
               const remaining = manifest!.files[fileIdx].size - intoFile;
               const take = Math.min(remaining, pt.length - off);
               if (take > 0 && sink) { await sink.write(pt.subarray(off, off + take)); intoFile += take; off += take; }
               if (intoFile >= manifest!.files[fileIdx].size) {
                 if (sink) await sink.close();
                 fileIdx++;
                 intoFile = 0;
                 sink = fileIdx < manifest!.files.length ? await target.file(manifest!.files[fileIdx].name, manifest!.files[fileIdx].size) : null;
               }
             }
           },
           (received) => { progress = totalBytes > 0 ? Math.round((received / totalBytes) * 100) : 0; },
         );
         if (sink) await sink.close();
         state = "done";
       } catch {
         state = "error";
         errKey = "decryptFail";
       }
     }

     function formatSize(n: number): string {
       if (n < 1024) return `${n} B`;
       const units = ["KB", "MB", "GB", "TB"];
       let v = n / 1024, i = 0;
       while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
       return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
     }
   </script>

   <main class="dl">
     <h1>Relayium</h1>
     {#if state === "loading"}
       <p>{t.download.loading}</p>
     {:else if state === "error"}
       <p class="error">
         {#if errKey === "notFound"}{t.download.notFound}
         {:else if errKey === "noKey"}{t.download.noKey}
         {:else if errKey === "unsupported"}{t.download.unsupported}
         {:else}{t.download.decryptFail}{/if}
       </p>
     {:else}
       <h2>{t.download.files}</h2>
       <ul class="filelist">
         {#each manifest?.files ?? [] as f}
           <li><span class="fname">{f.name}</span><span class="fsize">{formatSize(f.size)}</span></li>
         {/each}
       </ul>
       {#if state === "downloading"}
         <div class="bar"><div class="fill" style:width="{progress}%"></div></div>
         <p>{t.download.downloading} {progress}%</p>
       {:else if state === "done"}
         <p class="ok">{t.download.done}</p>
       {:else}
         <button class="primary" onclick={download}>{t.download.downloadBtn}</button>
       {/if}
     {/if}
     <footer>
       <a href={legalUrl("privacy", lang())}>{t.legal.privacy}</a>
       <a href={legalUrl("terms", lang())}>{t.legal.terms}</a>
     </footer>
   </main>

   <style>
     .dl { width: 560px; max-width: 100%; margin: 0 auto; padding: 24px 20px 48px; text-align: left; }
     .dl h1 { font-size: 28px; margin: 0 0 18px; }
     .dl h2 { font-size: 16px; margin: 18px 0 10px; }
     .filelist { list-style: none; margin: 0 0 16px; padding: 0; }
     .filelist li { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px dashed var(--border); }
     .fname { color: var(--text-h); word-break: break-all; }
     .fsize { color: var(--text); white-space: nowrap; }
     .bar { height: 8px; border-radius: 999px; background: var(--code-bg); overflow: hidden; }
     .fill { height: 100%; background: linear-gradient(90deg, var(--accent), #6d28d9); transition: width .2s; }
     button.primary { font: inherit; font-size: 15px; padding: 10px 24px; border-radius: 9px; cursor: pointer; background: var(--accent); border: 1px solid var(--accent); color: #fff; }
     .error { color: var(--accent); } .ok { color: #2ecc71; }
     footer { margin-top: 28px; display: flex; gap: 16px; font-size: 12.5px; }
     footer a { color: var(--text-h); text-decoration: none; }
   </style>
   ```
2. - [ ] Edit `web/src/App.svelte`:
   - Add imports: `import DownloadPage from "./lib/DownloadPage.svelte";` and extend the router import to `import { currentRoute, syncRouteFromLocation, downloadId } from "./lib/router.svelte";`
   - In the template, add a branch before the `{#if currentRoute() === "cross"}` block so the download page renders without the LAN/cross chrome. Restructure the top of `<main>`:
     ```svelte
     <main>
       {#if currentRoute() === "download"}
         <DownloadPage id={downloadId(location.pathname)} />
       {:else}
       <Nav />

       {#if currentRoute() === "cross"}
         <CrossPage {roomToken} {linkDead} />
       {:else}
         <!-- existing LAN markup unchanged -->
     ```
     and add a matching closing `{/if}` for the new outer branch at the end of `<main>` (after the existing `{/if}{/if}` that closes the cross/lan and unsupported blocks).
3. - [ ] Type-check: `cd web && npm run check` → no errors.
4. - [ ] Build: `cd web && npm run build` → succeeds.
5. - [ ] Commit: `git add web/src/lib/DownloadPage.svelte web/src/App.svelte && git commit -m "feat(web): public /d/<id> download page — decrypt manifest + stream-to-disk" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`.

---

## Task 14: i18n — stored upload + download page strings (all 6 languages)

> Implement this **before Tasks 12-13** if executing strictly in order (those components consume these keys).

**Files:**
- Modify `web/src/lib/i18n.svelte.ts` (extend `Messages` + all 6 language objects)
- Modify `web/src/lib/i18n.test.ts` (extend completeness check)

**Interfaces:**
- Produces on `Messages`: `stored: { title; desc; pick; uploading; burnLabel; ttlLabel; ttl1d; ttl3d; ttl7d; linkReady; copy; copied; errTooLarge; errQuota; errUpload }` and `download: { loading; files; downloadBtn; downloading; done; notFound; noKey; decryptFail; unsupported }`.

**Steps:**

1. - [ ] Extend the completeness test `web/src/lib/i18n.test.ts` (failing first):
   ```ts
   it("every language has the stored-transfer + download strings", () => {
     for (const { code } of LANGS) {
       const m = messages[code];
       expect(m.stored.title, `${code}.stored.title`).toBeTruthy();
       expect(m.stored.errQuota, `${code}.stored.errQuota`).toBeTruthy();
       expect(m.download.downloadBtn, `${code}.download.downloadBtn`).toBeTruthy();
       expect(m.download.notFound, `${code}.download.notFound`).toBeTruthy();
     }
   });
   ```
2. - [ ] Run to fail: `cd web && npx vitest run src/lib/i18n.test.ts` → fails (`m.stored` undefined) and `npm run check` would fail on `Messages`.
3. - [ ] Add to the `Messages` interface (after the `crossnet` block, before `features`):
   ```ts
     stored: {
       title: string;
       desc: string;
       pick: string;
       uploading: string;
       burnLabel: string;
       ttlLabel: string;
       ttl1d: string;
       ttl3d: string;
       ttl7d: string;
       linkReady: string;
       copy: string;
       copied: string;
       errTooLarge: string;
       errQuota: string;
       errUpload: string;
     };
     download: {
       loading: string;
       files: string;
       downloadBtn: string;
       downloading: string;
       done: string;
       notFound: string;
       noKey: string;
       decryptFail: string;
       unsupported: string;
     };
   ```
4. - [ ] Add the `stored` + `download` blocks to each language object (place after each object's `crossnet` block). **zh:**
   ```ts
     stored: {
       title: "生成下载链接（暂存传输）",
       desc: "浏览器先加密再上传，服务器只存密文；把链接发给对方，对方无需登录即可下载。",
       pick: "选择文件上传",
       uploading: "正在加密并上传…",
       burnLabel: "阅后即焚（首次下载后删除）",
       ttlLabel: "有效期",
       ttl1d: "1 天",
       ttl3d: "3 天",
       ttl7d: "7 天",
       linkReady: "链接已生成，发给对方即可下载：",
       copy: "复制链接",
       copied: "已复制",
       errTooLarge: "文件超过单文件大小上限。",
       errQuota: "已超过今日上传额度，请稍后再试。",
       errUpload: "上传失败，请重试。",
     },
     download: {
       loading: "正在读取链接…",
       files: "待下载文件",
       downloadBtn: "下载并解密",
       downloading: "正在下载并解密…",
       done: "下载完成 ✓",
       notFound: "链接无效、已过期或已被下载删除。",
       noKey: "链接不完整：缺少解密密钥（#k=）。",
       decryptFail: "解密失败：密钥错误或文件已损坏。",
       unsupported: "需要 HTTPS（或 localhost）才能解密下载。",
     },
   ```
   **en:**
   ```ts
     stored: {
       title: "Create a download link (stored transfer)",
       desc: "Your browser encrypts files before upload; the server stores only ciphertext. Share the link — the recipient downloads without signing in.",
       pick: "Choose files to upload",
       uploading: "Encrypting and uploading…",
       burnLabel: "Burn after reading (delete on first download)",
       ttlLabel: "Expires in",
       ttl1d: "1 day",
       ttl3d: "3 days",
       ttl7d: "7 days",
       linkReady: "Link ready — send it to the recipient to download:",
       copy: "Copy link",
       copied: "Copied",
       errTooLarge: "The file exceeds the single-file size limit.",
       errQuota: "You've exceeded today's upload quota — please try again later.",
       errUpload: "Upload failed, please try again.",
     },
     download: {
       loading: "Reading the link…",
       files: "Files to download",
       downloadBtn: "Download & decrypt",
       downloading: "Downloading and decrypting…",
       done: "Download complete ✓",
       notFound: "This link is invalid, expired, or already downloaded and deleted.",
       noKey: "Incomplete link: the decryption key (#k=) is missing.",
       decryptFail: "Decryption failed: wrong key or corrupted file.",
       unsupported: "Decryption requires HTTPS (or localhost).",
     },
   ```
   **ja:**
   ```ts
     stored: {
       title: "ダウンロードリンクを作成（一時保存転送）",
       desc: "ブラウザが暗号化してからアップロードし、サーバーは暗号文のみを保存します。リンクを送れば、相手はログインせずにダウンロードできます。",
       pick: "アップロードするファイルを選択",
       uploading: "暗号化してアップロード中…",
       burnLabel: "閲覧後に削除（最初のダウンロードで削除）",
       ttlLabel: "有効期限",
       ttl1d: "1 日",
       ttl3d: "3 日",
       ttl7d: "7 日",
       linkReady: "リンクを作成しました。相手に送ってダウンロードしてもらえます：",
       copy: "リンクをコピー",
       copied: "コピーしました",
       errTooLarge: "ファイルが単一ファイルの上限を超えています。",
       errQuota: "本日のアップロード上限を超えました。後でもう一度お試しください。",
       errUpload: "アップロードに失敗しました。もう一度お試しください。",
     },
     download: {
       loading: "リンクを読み込み中…",
       files: "ダウンロードするファイル",
       downloadBtn: "ダウンロードして復号",
       downloading: "ダウンロードして復号中…",
       done: "ダウンロード完了 ✓",
       notFound: "このリンクは無効、期限切れ、またはダウンロード済みで削除されています。",
       noKey: "リンクが不完全です：復号キー（#k=）がありません。",
       decryptFail: "復号に失敗しました：キーが違うかファイルが破損しています。",
       unsupported: "復号ダウンロードには HTTPS（または localhost）が必要です。",
     },
   ```
   **ko:**
   ```ts
     stored: {
       title: "다운로드 링크 생성 (임시 보관 전송)",
       desc: "브라우저가 먼저 암호화한 뒤 업로드하며 서버는 암호문만 저장합니다. 링크를 보내면 상대는 로그인 없이 다운로드할 수 있습니다.",
       pick: "업로드할 파일 선택",
       uploading: "암호화 후 업로드 중…",
       burnLabel: "열람 후 삭제 (첫 다운로드 시 삭제)",
       ttlLabel: "유효 기간",
       ttl1d: "1일",
       ttl3d: "3일",
       ttl7d: "7일",
       linkReady: "링크가 생성되었습니다. 상대에게 보내 다운로드하세요:",
       copy: "링크 복사",
       copied: "복사됨",
       errTooLarge: "파일이 단일 파일 크기 한도를 초과했습니다.",
       errQuota: "오늘 업로드 한도를 초과했습니다. 나중에 다시 시도하세요.",
       errUpload: "업로드에 실패했습니다. 다시 시도하세요.",
     },
     download: {
       loading: "링크를 읽는 중…",
       files: "다운로드할 파일",
       downloadBtn: "다운로드 및 복호화",
       downloading: "다운로드 및 복호화 중…",
       done: "다운로드 완료 ✓",
       notFound: "유효하지 않거나 만료되었거나 이미 다운로드되어 삭제된 링크입니다.",
       noKey: "불완전한 링크: 복호화 키(#k=)가 없습니다.",
       decryptFail: "복호화 실패: 키가 틀리거나 파일이 손상되었습니다.",
       unsupported: "복호화 다운로드에는 HTTPS(또는 localhost)가 필요합니다.",
     },
   ```
   **de:**
   ```ts
     stored: {
       title: "Download-Link erstellen (zwischengespeicherte Übertragung)",
       desc: "Ihr Browser verschlüsselt die Dateien vor dem Upload; der Server speichert nur Chiffretext. Teilen Sie den Link — der Empfänger lädt ohne Anmeldung herunter.",
       pick: "Dateien zum Hochladen wählen",
       uploading: "Verschlüsseln und hochladen…",
       burnLabel: "Nach dem Lesen löschen (beim ersten Download)",
       ttlLabel: "Gültig für",
       ttl1d: "1 Tag",
       ttl3d: "3 Tage",
       ttl7d: "7 Tage",
       linkReady: "Link bereit — senden Sie ihn dem Empfänger zum Herunterladen:",
       copy: "Link kopieren",
       copied: "Kopiert",
       errTooLarge: "Die Datei überschreitet das Einzeldatei-Limit.",
       errQuota: "Das heutige Upload-Kontingent ist erschöpft — bitte später erneut versuchen.",
       errUpload: "Upload fehlgeschlagen, bitte erneut versuchen.",
     },
     download: {
       loading: "Link wird gelesen…",
       files: "Herunterzuladende Dateien",
       downloadBtn: "Herunterladen & entschlüsseln",
       downloading: "Herunterladen und entschlüsseln…",
       done: "Download abgeschlossen ✓",
       notFound: "Dieser Link ist ungültig, abgelaufen oder bereits heruntergeladen und gelöscht.",
       noKey: "Unvollständiger Link: Der Entschlüsselungsschlüssel (#k=) fehlt.",
       decryptFail: "Entschlüsselung fehlgeschlagen: falscher Schlüssel oder beschädigte Datei.",
       unsupported: "Für den entschlüsselten Download ist HTTPS (oder localhost) erforderlich.",
     },
   ```
   **fr:**
   ```ts
     stored: {
       title: "Créer un lien de téléchargement (transfert stocké)",
       desc: "Votre navigateur chiffre les fichiers avant l'envoi ; le serveur ne stocke que du chiffré. Partagez le lien — le destinataire télécharge sans se connecter.",
       pick: "Choisir des fichiers à envoyer",
       uploading: "Chiffrement et envoi…",
       burnLabel: "Détruire après lecture (supprimé au premier téléchargement)",
       ttlLabel: "Expire dans",
       ttl1d: "1 jour",
       ttl3d: "3 jours",
       ttl7d: "7 jours",
       linkReady: "Lien prêt — envoyez-le au destinataire pour télécharger :",
       copy: "Copier le lien",
       copied: "Copié",
       errTooLarge: "Le fichier dépasse la taille maximale par fichier.",
       errQuota: "Quota d'envoi du jour dépassé — réessayez plus tard.",
       errUpload: "Échec de l'envoi, veuillez réessayer.",
     },
     download: {
       loading: "Lecture du lien…",
       files: "Fichiers à télécharger",
       downloadBtn: "Télécharger et déchiffrer",
       downloading: "Téléchargement et déchiffrement…",
       done: "Téléchargement terminé ✓",
       notFound: "Ce lien est invalide, expiré, ou déjà téléchargé puis supprimé.",
       noKey: "Lien incomplet : la clé de déchiffrement (#k=) est absente.",
       decryptFail: "Échec du déchiffrement : mauvaise clé ou fichier corrompu.",
       unsupported: "Le téléchargement déchiffré nécessite HTTPS (ou localhost).",
     },
   ```
5. - [ ] Run to pass: `cd web && npx vitest run src/lib/i18n.test.ts` → pass; `cd web && npm run check` → no errors.
6. - [ ] Commit: `git add web/src/lib/i18n.svelte.ts web/src/lib/i18n.test.ts && git commit -m "i18n(web): stored-upload + download-page strings across all 6 languages" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`.

---

## Task 15: Legal / positioning copy (copy-only)

This task adds nothing functional: it distinguishes "realtime direct P2P never touches the server" (unchanged claim) from "optional zero-knowledge stored download links" (new). **Do not weaken any realtime-mode claim.** Verify with `cd web && npm run build` and `npx vitest run src/lib/i18n.test.ts` (both must still pass). No new failing test (pure copy); the i18n completeness test from Task 14 guards taglines.

**Files + exact nature of each edit:**

1. - [ ] `web/index.html` — the absolute `never touch the server` lines (meta description ×3 on lines ~8/29/46, JSON-LD description line ~61, featureList line ~77, body copy lines ~148/180). Edit: scope the absolute phrasing to realtime, e.g. change "Files stream device-to-device over WebRTC and never touch the server." → "In realtime mode, files stream device-to-device over WebRTC and never touch the server; an optional stored download-link mode keeps them as zero-knowledge ciphertext you alone can decrypt." Keep the realtime sentence intact; append the distinction. The FAQ answer on line ~180 ("No. Files stream directly…") gains a second sentence noting the optional zero-knowledge stored-link mode.
2. - [ ] `web/public/llms.txt` — the summary blockquote and the "Privacy" / "Key facts" bullets that assert files "never pass through any server". Edit: keep the realtime claim, add a bullet: "Optional stored download links: for asynchronous transfer the sender may upload zero-knowledge ciphertext (AES-256-GCM, key only in the URL fragment); the server stores ciphertext + ciphertext size + timestamps, never plaintext, filenames, or keys; auto-deleted at expiry or first download."
3. - [ ] `web/src/lib/i18n.svelte.ts` — soften the two absolute strings per language without weakening realtime:
   - `tagline`: keep the realtime promise; it may stay as-is (it already implies P2P). No change required unless a reviewer wants it; leave taglines unchanged to avoid scope creep.
   - `features.items[1]` (the "Files never touch the server" / "文件不经服务器" card): change its `desc` to scope to realtime and mention the optional mode. zh: "实时直传通过 WebRTC 在设备间直接流动，绝不经过服务器；可选的下载链接为零知识加密暂存。" en: "In realtime mode bytes flow device-to-device over WebRTC and never touch the server; the optional download-link mode stores only zero-knowledge ciphertext." Apply the equivalent scoping to ja/ko/de/fr (translate the same two clauses). The card **title** stays, but for en consider "Realtime: files never touch the server" — keep titles short; translating the title is optional, scoping the `desc` is required.
4. - [ ] `web/src/lib/FeatureStrip.svelte` — no code change (it renders `t.features.items`); the wording change lives in i18n (step 3). Listed here only to confirm no markup edit is needed.
5. - [ ] `web/public/privacy/index.html` (en) and `web/public/{zh,de,ko,ja,fr}/privacy/index.html` — add a new `<h2>` section "Stored transfer (download links)" / zh "暂存传输（下载链接）" / ja "一時保存転送（ダウンロードリンク）" / ko "임시 보관 전송(다운로드 링크)" / de "Zwischengespeicherte Übertragung (Download-Links)" / fr "Transfert stocké (liens de téléchargement)". Content (translate per language): zero-knowledge — files are encrypted in your browser and stored only as ciphertext; the server cannot read content, filenames, or the key (the key lives only in the link fragment); we retain ciphertext until expiry or first download, then delete it; we record ciphertext size + timestamps for quota and cleanup; the "we never collect …" list still holds because everything received is ciphertext. Place it after the existing "what an account stores" section and before the "what we never collect" section; do not alter the realtime "LAN transfer collects nothing" section.
6. - [ ] `web/public/terms/index.html` (en) and `web/public/{zh,de,ko,ja,fr}/terms/index.html` — add a new clause "Stored content" / per-language equivalent: acceptable-use (no illegal content), takedown by report against a file `id`, retention until expiry/first download with automatic deletion, and that zero-knowledge means we cannot pre-screen content (the size/TTL/quota limits and report-based takedown are the mitigations). Place it as a new numbered/section clause; leave existing clauses intact.

**Steps:**

1. - [ ] Make the edits in steps 1-6 above, file by file. For the per-language legal pages, mirror the existing page's heading style and surrounding markup (open each file, copy the structure of an adjacent `<h2>` block).
2. - [ ] Verify nothing regressed: `cd web && npx vitest run src/lib/i18n.test.ts` → pass (feature `desc` strings still truthy via existing object shape) and `cd web && npm run build` → succeeds.
3. - [ ] Grep-confirm the realtime claim is intact and the new distinction is present:
   `cd web && grep -rn "zero-knowledge\|零知识\|Zwischengespeicherte\|一時保存\|임시 보관\|stocké" public/ index.html src/lib/i18n.svelte.ts | head` → shows the new copy in each surface.
4. - [ ] Commit: `git add web/index.html web/public/llms.txt web/src/lib/i18n.svelte.ts web/public/privacy web/public/terms web/public/zh web/public/de web/public/ko web/public/ja web/public/fr && git commit -m "docs(legal): distinguish realtime P2P vs optional zero-knowledge stored links" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`.

---

## Self-Review

### Spec coverage
- **Storage abstraction (spec §A):** Task 1 — `BlobStore` interface + `DiskStore` (two-char shard, atomic temp+rename), `RELAYIUM_BLOB_DIR` default `./blobs`, startup-only (Task 7). ✓
- **DB tables (spec §B):** Task 2 — `stored_files`, `upload_events`, `settings` + all Store methods incl. `UserUploadedSince` rolling sum and `ListExpiredStoredFiles`. `blob_key` decoupled from public `id`. ✓
- **Config env+admin (spec §C):** Task 3 resolver (DB > env), Task 7 env defaults seeded, Task 8 admin edit. Only the 4 limits are admin-editable; `RELAYIUM_BLOB_DIR` stays startup-only. ✓
- **HTTP API (spec §D):** Task 4 `POST /api/files` (413 oversize via cappedReader, 429 quota, 401 unauth); Task 5 public `meta`/`blob` (burn-on-full-read), owner `GET /api/files` (no plaintext names), `DELETE` (owner-gated 404). ✓
- **GC (spec §E):** Task 6 — sweeper deletes expired files+blobs and prunes upload_events >25h; burn-after-read deletes synchronously in Task 5, GC is the backstop. ✓
- **Admin write (spec §F):** Task 8 — editable form (MiB/hours) + `POST /admin/settings` with validation (`default_ttl <= max_ttl`, positive), admin-cookie protected. ✓
- **Frontend (spec §G):** Task 9 store-crypto, Task 10 stored-file API, Task 11 router, Task 12 upload UI, Task 13 download page, Task 14 i18n. ✓
- **Link format (spec §H):** `/d/<id>#k=<base64url>` — Task 10 `buildDownloadLink`, key only in fragment. ✓
- **Coexistence + legal (spec §法务):** realtime WebRTC untouched (App.svelte adds a sibling branch; CrossNetwork unchanged); Task 15 distinguishes the two modes without weakening realtime claims. ✓
- **Tests (spec §测试):** every backend Store method, DiskStore, upload 413/429, burn delete, delete authz, GC sweep, admin POST validation, and frontend crypto roundtrip/tamper, base64url, manifest, routing, API wrappers — all covered. ✓

### Placeholder scan
- No `TODO`, no "similar to Task N", no "(omitted)". Every code step contains compilable code. The only deliberate transient placeholder (`var _ = storage.ErrNotFound` in Task 4) is explicitly removed in Task 5 step 3 (which also drops the now-unused `storage` import from `files.go`).

### Type/signature consistency across tasks
- `BlobStore` signatures identical in Task 1 (def), Task 4/5 (use), Task 6 (GC field), Task 7 (wiring). ✓
- `StoredFile`/`UploadEvent`/`Setting` field names identical across store.go (Task 2), sqlite.go (Task 2), files.go (Tasks 4-5), gc.go (Task 6), settings.go/admin.go (Tasks 3/8). ✓
- Upload body wire format (`uint32BE(mlen)‖encManifest‖blobStream`) matches between server reader (Task 4) and client assembler (Task 10); blob frame format (`uint32BE(len)‖ct`) matches between `encryptFiles` (Task 9), the upload assembler (Task 10), and `StoreDecryptor` (Task 9) consumed by `downloadBlob` (Task 10). ✓
- Nonce scheme (manifest seq 0, chunks seq≥1) consistent between `encryptManifest`/`encryptFiles` and `decryptManifest`/`StoreDecryptor` (Task 9). ✓
- JSON field names (`id`, `expiresAt`, `encManifest`, `size`, `burnAfterRead`, `downloaded`) identical between handlers (Tasks 4-5) and client types (Task 10) and the i18n-free tests. ✓
- `DOWNLOAD_PREFIX` single source in transfer-link.ts, consumed by router (Task 11) and stored-file (Task 10). ✓
- i18n keys `t.stored.*`/`t.download.*` defined in Task 14 are exactly those referenced by Task 12 (`StoredUpload.svelte`) and Task 13 (`DownloadPage.svelte`); ordering note flags that Task 14 must land before 12-13 for `npm run check`. ✓
- `Config` new fields (`MaxFileSize/DailyQuota/DefaultTTL/MaxTTL`) defined in Task 3, populated in Task 7, read by `resolveSettings` (Task 3) and `handleAdminHome` (Task 8). ✓

### Open risks for the controller to verify
- Vitest runs the crypto tests under Node's global `crypto.subtle` + `File`/`Blob`/`atob` (Node ≥ 20). Confirm the project's Node version; if a jsdom/happy-dom env is configured, WebCrypto + `File` still resolve via Node globals.
- `App.svelte` template restructure (Task 13 step 2) adds one outer `{#if download}…{:else}…{/if}` wrapper — verify brace balance against the existing nested `{/if}{/if}` after the LAN block.
