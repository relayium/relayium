package account

import (
	"context"
	"fmt"
	"log"

	"github.com/relayium/relayium/internal/storage"
)

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

// placeUpload chooses where a new upload's ciphertext should land: a random
// eligible storage node, or central-local ("") when none is available. Headroom
// is one MaxFileSize so a near-full node is not chosen.
func (s *Service) placeUpload(ctx context.Context) (string, storage.BlobStore) {
	minFree := s.resolveSettings(ctx).MaxFileSize
	since := s.now().Add(-nodeOnlineWindow).Unix()
	nodes, err := s.store.StorageNodes(ctx, since, minFree)
	if err != nil {
		log.Printf("placeUpload: StorageNodes read failed: %v (using central)", err)
	}
	if len(nodes) == 0 {
		return "", s.blobs
	}
	n := nodes[s.pickN(len(nodes))]
	return n.ID, storage.NewRemoteBlobStore(n.StorageURL, n.StorageSecret, s.nodeHTTP)
}
