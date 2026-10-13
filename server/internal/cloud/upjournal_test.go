//go:build unix

package cloud

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func preparedFixture(t *testing.T) *PreparedUpload {
	t.Helper()
	p := filepath.Join(t.TempDir(), "a.txt")
	if err := os.WriteFile(p, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	prep, err := PrepareUpload([]string{p}, UploadOpts{TTLSeconds: 3600})
	if err != nil {
		t.Fatal(err)
	}
	return prep
}

func savedOp(t *testing.T) (string, UpOperation) {
	t.Helper()
	cfg := t.TempDir()
	op, err := NewUpOperation(preparedFixture(t), "https://relayium.example/", "a@example.com", 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := SaveUpOperation(cfg, op); err != nil {
		t.Fatal(err)
	}
	return cfg, op
}

// The prepared body length is exactly what the body writer produces.
func TestPreparedBodyLengthMatchesWrittenBody(t *testing.T) {
	dir := t.TempDir()
	for name, size := range map[string]int{"empty": 0, "small": 5, "chunk": 192 << 10, "chunk+1": 192<<10 + 1, "three": 3*192<<10 - 7} {
		if err := os.WriteFile(filepath.Join(dir, name), bytes.Repeat([]byte("x"), size), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	prep, err := PrepareUpload([]string{dir}, UploadOpts{})
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := writeUploadBody(&buf, prep.encManifest, prep.files, prep.key, nil); err != nil {
		t.Fatal(err)
	}
	if int64(buf.Len()) != prep.BodyLength {
		t.Fatalf("BodyLength %d, body written %d", prep.BodyLength, buf.Len())
	}
}

func TestUpOperationRoundTripIsPrivate(t *testing.T) {
	cfg, op := savedOp(t)
	got, err := LoadUpOperation(cfg, op.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.OpKey != op.OpKey || got.ContentKey != op.ContentKey || got.BodyLength != op.BodyLength || got.Server != "https://relayium.example" {
		t.Fatalf("round trip: %+v", got)
	}
	info, err := os.Stat(filepath.Join(UpJournalDir(cfg), op.ID+".json"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("record mode %v, %v", info.Mode(), err)
	}
	dinfo, _ := os.Stat(UpJournalDir(cfg))
	if dinfo.Mode().Perm() != 0o700 {
		t.Fatalf("journal dir mode %v", dinfo.Mode())
	}
	list, err := ListUpOperations(cfg)
	if err != nil || len(list) != 1 || list[0].ID != op.ID {
		t.Fatalf("list %+v %v", list, err)
	}
	if b, _ := os.ReadFile(filepath.Join(UpJournalDir(cfg), op.ID+".json")); !strings.Contains(string(b), op.ContentKey) {
		t.Fatal("fixture premise: the record holds the key")
	}
	for _, s := range list {
		if strings.Contains(s.ID+s.Server+s.Account+s.Problem, op.ContentKey) {
			t.Fatal("a listing carries the key")
		}
	}
}

// Every unusable record is refused and left exactly as it was.
func TestUpOperationRefusesUnsafeOrCorruptRecords(t *testing.T) {
	cases := map[string]func(t *testing.T, path string){
		"corrupt json": func(t *testing.T, p string) { mustWrite(t, p, "{not json", 0o600) },
		"trailing value": func(t *testing.T, p string) {
			b, _ := os.ReadFile(p)
			mustWrite(t, p, string(b)+` {"version":1}`, 0o600)
		},
		"trailing delimiter": func(t *testing.T, p string) {
			b, _ := os.ReadFile(p)
			mustWrite(t, p, string(b)+"}", 0o600)
		},
		"oversized": func(t *testing.T, p string) {
			b, _ := os.ReadFile(p)
			mustWrite(t, p, string(b)+strings.Repeat(" ", maxUpRecord), 0o600)
		},
		"impossible counts": func(t *testing.T, p string) {
			b, _ := os.ReadFile(p)
			mustWrite(t, p, strings.Replace(string(b), `"fileCount":1`, `"fileCount":100000`, 1), 0o600)
		},
		"unknown field": func(t *testing.T, p string) {
			b, _ := os.ReadFile(p)
			mustWrite(t, p, strings.Replace(string(b), "{", `{"extra":1,`, 1), 0o600)
		},
		"bad key": func(t *testing.T, p string) {
			b, _ := os.ReadFile(p)
			s := string(b)
			i := strings.Index(s, `"contentKey":"`) + len(`"contentKey":"`)
			mustWrite(t, p, s[:i]+"short"+s[strings.Index(s[i:], `"`)+i:], 0o600)
		},
		"group readable": func(t *testing.T, p string) {
			if err := os.Chmod(p, 0o640); err != nil {
				t.Fatal(err)
			}
		},
		"symlink": func(t *testing.T, p string) {
			real := p + ".real"
			if err := os.Rename(p, real); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(real, p); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			cfg, op := savedOp(t)
			p := filepath.Join(UpJournalDir(cfg), op.ID+".json")
			mutate(t, p)
			before, _ := os.Lstat(p)
			beforeBytes, _ := os.ReadFile(p)
			_, err := LoadUpOperation(cfg, op.ID)
			if !errors.Is(err, ErrUpOperationCorrupt) && !errors.Is(err, ErrUpOperationUnsafe) {
				t.Fatalf("err = %v", err)
			}
			after, _ := os.Lstat(p)
			afterBytes, _ := os.ReadFile(p)
			if before.Mode() != after.Mode() || !bytes.Equal(beforeBytes, afterBytes) {
				t.Fatal("a refused record was changed")
			}
		})
	}
	if _, err := LoadUpOperation(t.TempDir(), "0123456789abcdef0123456789abcdef"); !errors.Is(err, ErrUpOperationNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if _, err := LoadUpOperation(t.TempDir(), "../../etc/passwd"); !errors.Is(err, ErrUpOperationNotFound) {
		t.Fatalf("path id: %v", err)
	}
}

func mustWrite(t *testing.T, p, s string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(p, []byte(s), mode); err != nil {
		t.Fatal(err)
	}
}

// One operation, one holder at a time.
func TestUpOperationLockIsExclusive(t *testing.T) {
	cfg, op := savedOp(t)
	l1, err := LockUpOperation(cfg, op.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := LockUpOperation(cfg, op.ID); !errors.Is(err, ErrUpOperationBusy) {
		t.Fatalf("second lock: %v", err)
	}
	l1.Release()
	l2, err := LockUpOperation(cfg, op.ID)
	if err != nil {
		t.Fatalf("after release: %v", err)
	}
	l2.Release()
}
