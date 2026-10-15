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

// ErrOffsetMismatch is returned by Append when the requested offset does not
// equal the object's current size, so a resumable upload can re-sync to the
// real offset instead of writing a gap or overwriting.
var ErrOffsetMismatch = errors.New("storage: append offset does not match current size")

// ErrUnattestedSize is joined to ErrOffsetMismatch when the size came from a
// node that does not speak relayium-append-durability-v1: the number is the
// blob's PHYSICAL size, which may include bytes no flush certified.
var ErrUnattestedSize = errors.New("storage: blob size is not attested durable")

// The relayium-append-durability-v1 wire, central -> node. Central sends
// AppendDurabilityHeader on every append and SettledThroughHeader when it
// authorizes a repair; a node that speaks the version echoes
// AppendDurabilityHeader on every answer and reports a not-durable result as
// HTTP 500 with a NotDurableBody. See docs/protocol/relayium-append-durability-v1.md.
const (
	AppendDurabilityHeader = "X-Relayium-Append-Durability"
	AppendDurabilityV1     = "v1"
	SettledThroughHeader   = "X-Relayium-Settled-Through"
)

// NotDurableBody is the JSON a v1 node answers a not-durable append with.
type NotDurableBody struct {
	NotDurable bool  `json:"notDurable"`
	Durable    int64 `json:"durable"`
	Physical   int64 `json:"physical"`
	Written    int64 `json:"written"`
}

// BlobStore persists opaque byte objects keyed by an unguessable token.
type BlobStore interface {
	// Put streams r into object `key`, returning the number of bytes written.
	Put(ctx context.Context, key string, r io.Reader) (int64, error)
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	// GetRange returns the object's bytes from `start` to the end; start==0 is
	// equivalent to Get. It backs resumable downloads (HTTP Range). The returned
	// reader always begins exactly at `start`.
	GetRange(ctx context.Context, key string, start int64) (io.ReadCloser, error)
	// Append writes r at `offset`, which must equal the object's current size
	// (0 creates it), and returns the new total size. A mismatched offset yields
	// ErrOffsetMismatch with the object's real current size, so a resumable
	// upload can re-sync. Backs chunked uploads.
	//
	// Under relayium-append-durability-v1 a returned size is DURABLE; bytes the
	// store holds but cannot vouch for come back as a *NotDurableError (see
	// DiskStore.Append), and ErrUnattestedSize marks a mismatch size from a
	// store that cannot say either way (a legacy node).
	Append(ctx context.Context, key string, offset int64, r io.Reader) (int64, error)
	Delete(ctx context.Context, key string) error
}
