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
	Append(ctx context.Context, key string, offset int64, r io.Reader) (int64, error)
	Delete(ctx context.Context, key string) error
}
