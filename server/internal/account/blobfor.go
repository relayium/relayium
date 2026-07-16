package account

import (
	"context"
	"errors"
	"fmt"
	"log"

	"github.com/relayium/relayium/internal/storage"
)

// errStrictNoNode signals that a user with OnlyOwnNodes set has no online own
// storage node right now: uploads must fail fast rather than silently fall
// back to fleet/central infrastructure they opted out of.
var errStrictNoNode = errors.New("account: strict mode and no online own node")

// blobFor returns the blob store holding (or to hold) a file with the given
// node_id: the local DiskStore for "" (central-local), else a RemoteBlobStore
// pointed at the node's storage endpoint.
func (s *Service) blobFor(ctx context.Context, nodeID string) (storage.BlobStore, error) {
	if nodeID == "" {
		return s.blobs, nil
	}
	n, ok, err := s.store.GetNode(ctx, nodeID)
	if err != nil {
		return nil, err
	}
	if !ok || !n.StorageEnabled || n.StorageURL == "" {
		return nil, fmt.Errorf("node %s has no storage endpoint", nodeID)
	}
	return storage.NewRemoteBlobStore(n.StorageURL, n.StorageSecret, s.nodeHTTP), nil
}

// BlobForNode is the exported resolver GC (wired from main) uses.
func (s *Service) BlobForNode(ctx context.Context, nodeID string) (storage.BlobStore, error) {
	return s.blobFor(ctx, nodeID)
}

// placeUpload chooses where a new upload's ciphertext should land, in order:
//  1. the user's own online storage node (free, quota-exempt: billable=false);
//  2. for a strict user (OnlyOwnNodes) with no own node online, fail fast with
//     errStrictNoNode rather than silently using our infrastructure;
//  3. otherwise, SP2's fleet/central pick (billable=true).
//
// Headroom is one MaxFileSize so a near-full node is not chosen.
func (s *Service) placeUpload(ctx context.Context, userID string) (string, storage.BlobStore, bool, error) {
	minFree := s.resolveSettings(ctx).MaxFileSize
	since := s.now().Add(-nodeOnlineWindow).Unix()
	// Prefer the user's own online storage node (free).
	if own, err := s.store.UserStorageNodes(ctx, userID, since, minFree); err == nil && len(own) > 0 {
		n := own[s.pickN(len(own))]
		return n.ID, storage.NewRemoteBlobStore(n.StorageURL, n.StorageSecret, s.nodeHTTP), false, nil
	}
	// Strict users do not fall back to our infrastructure.
	if u, err := s.store.GetUserByID(ctx, userID); err == nil && u.OnlyOwnNodes {
		return "", nil, false, errStrictNoNode
	}
	// Non-strict fallback: fleet storage node or central (billable).
	nodes, err := s.store.StorageNodes(ctx, since, minFree)
	if err != nil {
		log.Printf("placeUpload: StorageNodes read failed: %v (central)", err)
	}
	if len(nodes) == 0 {
		// Admin opted out of central storage: no node → fail rather than land the
		// file on the app server's own disk.
		if s.resolveSettings(ctx).DisableCentralFallback {
			return "", nil, false, errStrictNoNode
		}
		return "", s.blobs, true, nil
	}
	n := nodes[s.pickN(len(nodes))]
	return n.ID, storage.NewRemoteBlobStore(n.StorageURL, n.StorageSecret, s.nodeHTTP), true, nil
}
