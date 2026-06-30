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
