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

// errStrictNodeFull is the other half of the strict-mode refusal: the user's own
// storage node IS online with storage enabled, it just cannot take this upload
// (not enough free bytes, or the volume is already past the 80% reserve). Same
// 503, different message — telling someone their node is "offline" when it is
// alive and merely full sends them to reboot a healthy machine.
var errStrictNodeFull = errors.New("account: strict mode and own node has no room")

// errStrictNodeUnreachable is the third strict-mode refusal: the user's own node
// is online and has room, but central cannot reach its blob endpoint, so an
// upload placed there would fail on every chunk. Distinct from the other two
// because the fix is distinct — open the port, not free up space or start the
// node — and because the node's heartbeat makes it look fine everywhere else.
var errStrictNodeUnreachable = errors.New("account: strict mode and own node unreachable")

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
	return storage.NewRemoteBlobStore(n.StorageURL, n.StorageSecret, n.StorageFP, s.nodeHTTP), nil
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
// size is the declared ciphertext size of THIS upload (0 when the client did not
// declare one); it sets the free-space bar a candidate node has to clear. See
// placementMinFree for why it is not MaxFileSize.
func (s *Service) placeUpload(ctx context.Context, userID string, size int64) (string, storage.BlobStore, bool, error) {
	minFree := s.placementMinFree(ctx, size)
	since := s.now().Add(-nodeOnlineWindow).Unix()
	// Prefer the user's own online storage node (free).
	if own, err := s.store.UserStorageNodes(ctx, userID, since, minFree); err == nil && len(own) > 0 {
		n := own[s.pickN(len(own))]
		return n.ID, storage.NewRemoteBlobStore(n.StorageURL, n.StorageSecret, n.StorageFP, s.nodeHTTP), false, nil
	}
	// Strict users do not fall back to our infrastructure.
	if u, err := s.store.GetUserByID(ctx, userID); err == nil && u.OnlyOwnNodes {
		// 在线且开了存储的自有节点存在，却没被上面选中 —— 原因有两种，报错必须
		// 分开：中心连不上它的 blob 端口（storage_unreachable），或者空间不够
		// （minFree 或 80% 保留闸）。都不能报"离线"，因为心跳是通的。
		if own, err := s.store.UserNodes(ctx, userID, since); err == nil {
			for _, n := range own {
				if n.StorageEnabled && n.StorageURL != "" && n.StorageUnreachable {
					return "", nil, false, errStrictNodeUnreachable
				}
			}
			for _, n := range own {
				if n.StorageEnabled && n.StorageURL != "" {
					return "", nil, false, errStrictNodeFull
				}
			}
		}
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
		if s.ResolveSettings(ctx).DisableCentralFallback {
			return "", nil, false, errStrictNoNode
		}
		return "", s.blobs, true, nil
	}
	n := nodes[s.pickN(len(nodes))]
	return n.ID, storage.NewRemoteBlobStore(n.StorageURL, n.StorageSecret, n.StorageFP, s.nodeHTTP), true, nil
}

// placementMinFree 把"这台节点放得下吗"的门槛钉在**这一次上传**的声明大小上。
//
// 它以前是 MaxFileSize：问的是"放不放得下一个最大尺寸的文件"，与实际大小无关。
// 单文件上限从 50 MiB 提到 1 GiB 之后，那等于把所有上传（包括 1 KiB 的）的放置
// 门槛一起 ×20 —— strict 用户的自有节点会因为"剩余空间 < 1 GiB"被整个滤掉而拿到
// 一个 503，fleet 节点则会静默退出放置池，把流量赶回 app server 本机盘。
//
// 两侧都夹一下：
//   - 下限 minBillableBytes：声明 0（chunked 编码，或客户端谎报）不能变成"任何
//     快满的节点都行"。谎报者拿不到额外写入配额（sessionWriteCap 全部服务端自算，
//     不看 ?size=），最坏结果是自己撞上节点的 507，代价由谎报者自己承担。
//   - 上限 MaxFileSize：声明一个超限的大小不该把所有节点滤空 —— 那会让本该是
//     413（超过单文件上限）的请求变成 503（无处安放）。
func (s *Service) placementMinFree(ctx context.Context, size int64) int64 {
	if size < minBillableBytes {
		size = minBillableBytes
	}
	if max := s.ResolveSettings(ctx).MaxFileSize; max > 0 && size > max {
		size = max
	}
	return size
}
