package storage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
)

// A flush may have been ACKed to an in-flight caller before its central DB
// commit. Losing the volatile certificate must never let another request
// shrink or replace that prefix, even when its ledger floor covers the tail.
func TestReplayPreservesEarlierAckAcrossCertificateLoss(t *testing.T) {
	for _, loss := range []string{"restart", "eviction"} {
		t.Run(loss, func(t *testing.T) {
			dir := t.TempDir()
			d, err := NewDiskStore(dir)
			if err != nil {
				t.Fatal(err)
			}
			key := "aaP0prefix"
			tail := []byte("AAAABBBB")
			ctx := context.Background()
			if n, e := d.Append(ctx, key, 0, bytes.NewReader(tail)); e != nil || n != 8 {
				t.Fatal(n, e)
			}
			_, path := d.paths(key)
			if loss == "restart" {
				d, err = NewDiskStore(dir)
				if err != nil {
					t.Fatal(err)
				}
			} else {
				d.durable.forget(key)
			}
			n, e := d.Append(WithSettledThrough(ctx, 8), key, 0, strings.NewReader("AAAA"))
			var nd *NotDurableError
			if !errors.As(e, &nd) || n != 4 || nd.Durable != 4 || nd.Physical != 8 || nd.Written != 4 {
				t.Fatalf("PARTIAL_REPLAY_ASSERTION: %d %v; must retain8 but certify only4", n, e)
			}
			got, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(got, tail) {
				t.Fatalf("EARLIER_ACK_PREFIX_ASSERTION: retained bytes%q err%v", got, err)
			}
			n, e = d.Append(WithSettledThrough(ctx, 8), key, 4, strings.NewReader("BBBB"))
			if e != nil || n != 8 {
				t.Fatalf("remaining replay %d %v", n, e)
			}
			got, err = os.ReadFile(path)
			if err != nil || !bytes.Equal(got, tail) {
				t.Fatalf("completed replay %q %v", got, err)
			}
		})
	}
}

func TestConflictingReplayCannotOverwriteRetainedBytes(t *testing.T) {
	d, _ := NewDiskStore(t.TempDir())
	key := "aaP0conflict"
	ctx := context.Background()
	original := []byte("AAAABBBB")
	if _, e := d.Append(ctx, key, 0, bytes.NewReader(original)); e != nil {
		t.Fatal(e)
	}
	d.durable.forget(key)
	_, path := d.paths(key)
	n, e := d.Append(WithSettledThrough(ctx, 8), key, 0, strings.NewReader("ZZZZ"))
	var nd *NotDurableError
	if !errors.As(e, &nd) || n != 0 || nd.Physical != 8 || nd.Written != 0 {
		t.Fatalf("CONFLICT_REPLAY_ASSERTION: %d %v", n, e)
	}
	got, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(got, original) {
		t.Fatalf("conflict replaced retained prefix %q %v", got, err)
	}
}

func TestEmptySettledReplayNeitherTruncatesNorCertifies(t *testing.T) {
	d, _ := NewDiskStore(t.TempDir())
	key := "aaP0empty"
	ctx := context.Background()
	if _, e := d.Append(ctx, key, 0, strings.NewReader("AAAABBBB")); e != nil {
		t.Fatal(e)
	}
	d.durable.forget(key)
	calls := failSyncs(t, 0, nil)
	n, e := d.Append(WithSettledThrough(ctx, 8), key, 0, bytes.NewReader(nil))
	var nd *NotDurableError
	if !errors.As(e, &nd) || n != 0 || nd.Physical != 8 || nd.Written != 0 || calls.Load() != 0 {
		t.Fatalf("EMPTY_REPLAY_ASSERTION: %d %v syncs%d", n, e, calls.Load())
	}
}

func TestMatchingReplayCanExtendTheRetainedTail(t *testing.T) {
	d, _ := NewDiskStore(t.TempDir())
	key := "aaP0extend"
	ctx := context.Background()
	if _, e := d.Append(ctx, key, 0, strings.NewReader("AAAABBBB")); e != nil {
		t.Fatal(e)
	}
	d.durable.forget(key)
	calls := failSyncs(t, 0, nil)
	want := []byte("AAAABBBBCCCC")
	n, e := d.Append(WithSettledThrough(ctx, 8), key, 0, bytes.NewReader(want))
	if e != nil || n != 12 || calls.Load() != 1 {
		t.Fatalf("matching extension %d %v syncs%d", n, e, calls.Load())
	}
	rc, e := d.Get(ctx, key)
	if e != nil {
		t.Fatal(e)
	}
	defer rc.Close()
	got, e := io.ReadAll(rc)
	if e != nil || !bytes.Equal(got, want) {
		t.Fatalf("extension %q %v", got, e)
	}
}
