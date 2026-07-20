# 个人中心会员区块 + 节点存储容量口径修正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/me` 页面展示用户的会员等级、权益与升级入口；同时修正管理员后台节点存储数字的口径错误，并引入"剩余 × 70%"的可用容量概念。

**Architecture:** 两组互不依赖的改动。Part B（Task 1-4）修节点侧存储统计：`storedBytes` 从"整卷已用"改为"blob 目录实际占用"，并在中心端派生 `剩余 × 70%` 作为展示与调度口径。Part A（Task 5-8）在已有的 `/api/me/usage` 上增量挂 `plan` 字段，前端新增 `PlanCard.svelte` 并抽出共享的 usage fetch 缓存。

**Tech Stack:** Go 1.x（`server/`，标准库 + SQLite）、Svelte 5 runes + TypeScript + Vite（`web/`）、vitest（前端组件测试）、`html/template`（管理员后台）。

## Global Constraints

- Go 测试运行目录是 `server/`，模块路径 `github.com/relayium/relayium`（注意：`internal/storage` 的 import 是 `github.com/relayium/relayium/internal/storage`，不含 `server/` 段）。
- 前端测试：`cd web && npx vitest run <file>`；类型检查 `cd web && npm run check`。
- **i18n 硬约束**：任何新增的 `Messages` 字段必须同时补齐 9 个语言文件 `web/src/lib/i18n/{zh,en,ja,ko,de,fr,ar,es,pt}.ts`，少一个 `npm run check` 就会失败。这是本仓刻意保留的保障机制，不要用可选字段绕开。
- **API 约定**：`/api/me/usage` 对外一律把"无限"规约成 `0`，前端只判断一个值。新增字段必须沿用这个约定。
- **70% 只用于展示与调度，绝不用作写入闸门**。节点本地写入硬闸保持 `server/cmd/relayium-node/relay.go:168` 的「剩余 < 总量 20% 拒写」不变。原因：70% 以 free 为基数，写入会使 free 变小、阈值随之变小，形成自指，永远收敛不到停止条件。
- 新增前端组件沿用 `web/src/lib/QuotaMeters.svelte:63` 的 `.quota` 卡片样式变量（`--border` / `--radius` / `--social-bg` / `--space-*` / `--fs-*`），不要引入新的颜色字面量。
- Part B 与 Part A 无共享代码，可并行实现；但建议先做 Part B（是线上 bug）。

---

## File Structure

**Part B — 节点存储口径**

| 文件 | 责任 |
|---|---|
| `server/internal/storage/disk.go` (修改) | 新增 `DiskStore.UsedBytes()`：走 blob 目录累加真实占用 |
| `server/internal/storage/disk_used_test.go` (新建) | 验证只统计 store 目录内的文件 |
| `server/cmd/relayium-node/counter.go` (修改) | 新增 `blobUsage` 原子缓存 gauge |
| `server/cmd/relayium-node/blob_usage_test.go` (新建) | 验证 gauge 刷新读到真实目录大小 |
| `server/cmd/relayium-node/relay.go` (修改) | 用 gauge 替换两处 `total - free` |
| `server/internal/account/sqlite.go` (修改) | `StorageNodes` 放置过滤应用 70% |
| `server/internal/account/storage_headroom_test.go` (新建) | 验证 70% 过滤边界 |
| `server/internal/account/admin.go` (修改) | `adminNodeView` 派生 `UsableBytes` |
| `server/internal/account/admin_templates.go` (修改) | 后台表格新增「可用(70%)」列 |
| `server/internal/account/admin_usable_test.go` (新建) | 验证派生值 |

**Part A — 个人中心会员区块**

| 文件 | 责任 |
|---|---|
| `server/internal/account/handlers.go` (修改) | `handleMeUsage` 响应挂 `plan` 对象 |
| `server/internal/account/me_usage_test.go` (修改) | 新增 `plan` 字段与 `isTop` 断言 |
| `web/src/lib/usage.svelte.ts` (新建) | `/api/me/usage` 的共享类型与按用户缓存的 fetch |
| `web/src/lib/QuotaMeters.svelte` (修改) | 改用共享 fetch |
| `web/src/lib/QuotaNotice.svelte` (修改) | 改用共享 fetch（保留陈旧响应守卫） |
| `web/src/lib/QuotaNotice.test.ts` (修改) | `afterEach` 清缓存，避免跨用例串味 |
| `web/src/lib/i18n/types.ts` (修改) | `me.plan.*` 五个 key 的类型契约 |
| `web/src/lib/i18n/{9 langs}.ts` (修改) | 九语言文案 |
| `web/src/lib/PlanCard.svelte` (新建) | 套餐卡组件 |
| `web/src/lib/PlanCard.test.ts` (新建) | 免费档/付费档/最高档三种形态 |
| `web/src/lib/MePage.svelte` (修改) | 在 `<QuotaMeters />` 上方挂 `<PlanCard />` |

---

# Part B — 节点存储口径修正

### Task 1: `DiskStore.UsedBytes()`

**问题背景**：`server/internal/storage/usage.go:12` 的 `DiskUsage` 报的是**整个文件系统**的占用（`total - Bavail`），包含操作系统和其它程序。节点却拿它当"relayium 存了多少"上报。需要一个只统计 blob 目录的函数。

**Files:**
- Modify: `server/internal/storage/disk.go`（在 `paths` 方法之后追加）
- Test: `server/internal/storage/disk_used_test.go`（新建）

**Interfaces:**
- Consumes: 无
- Produces: `func (d *DiskStore) UsedBytes() (int64, error)` — Task 2 使用

- [ ] **Step 1: 写失败的测试**

新建 `server/internal/storage/disk_used_test.go`：

```go
package storage

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// UsedBytes 必须只统计 store 自己目录里的东西。这正是它存在的理由：节点原先
// 用整卷 statfs 冒充"relayium 存量"，盘上装了别的程序就严重虚高。目录外的文件
// 一旦被计入，这个 bug 就原样复活了。
func TestUsedBytesCountsOnlyStoreDir(t *testing.T) {
	root := t.TempDir()
	blobDir := filepath.Join(root, "blobs")
	ds, err := NewDiskStore(blobDir)
	if err != nil {
		t.Fatalf("NewDiskStore: %v", err)
	}

	// 目录外的"其它程序数据"——绝不能被计入。
	outsider := filepath.Join(root, "someone-elses-4kb-file")
	if err := os.WriteFile(outsider, bytes.Repeat([]byte("x"), 4096), 0o600); err != nil {
		t.Fatalf("write outsider: %v", err)
	}

	ctx := context.Background()
	if _, err := ds.Put(ctx, "aabbcc", strings.NewReader(strings.Repeat("a", 100))); err != nil {
		t.Fatalf("Put aabbcc: %v", err)
	}
	if _, err := ds.Put(ctx, "ddeeff", strings.NewReader(strings.Repeat("b", 250))); err != nil {
		t.Fatalf("Put ddeeff: %v", err)
	}

	got, err := ds.UsedBytes()
	if err != nil {
		t.Fatalf("UsedBytes: %v", err)
	}
	if got != 350 {
		t.Fatalf("UsedBytes = %d, want 350 (only the two blobs; the 4096-byte file outside the store dir must not count)", got)
	}
}

// 空 store 报 0 而不是报错——节点刚装好、还没存过任何东西时会走到这条路径。
func TestUsedBytesEmptyStore(t *testing.T) {
	ds, err := NewDiskStore(filepath.Join(t.TempDir(), "blobs"))
	if err != nil {
		t.Fatalf("NewDiskStore: %v", err)
	}
	got, err := ds.UsedBytes()
	if err != nil {
		t.Fatalf("UsedBytes: %v", err)
	}
	if got != 0 {
		t.Fatalf("UsedBytes = %d, want 0 for an empty store", got)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd server && go test ./internal/storage/ -run TestUsedBytes -v
```

Expected: 编译失败，`ds.UsedBytes undefined (type *DiskStore has no field or method UsedBytes)`

- [ ] **Step 3: 实现**

在 `server/internal/storage/disk.go` 的 `paths` 方法之后插入：

```go
// UsedBytes reports the total size of the blobs this store holds, by walking
// the store directory.
//
// This is deliberately NOT storage.DiskUsage: that one reports the whole
// filesystem's occupancy (OS, logs, anything else on the volume), which is the
// wrong number to compare against a relayium-specific disk cap. A node that
// shares its volume with other software would otherwise report itself full
// while holding almost no blobs.
//
// In-progress temp files (tmpPrefix) are counted — they occupy the disk right
// now, and a cap check must see them. Entries that vanish mid-walk (a concurrent
// Delete, or a temp file renamed out from under us) are skipped rather than
// failing the whole total: a slightly stale gauge beats no gauge.
func (d *DiskStore) UsedBytes() (int64, error) {
	var total int64
	err := filepath.WalkDir(d.dir, func(_ string, e fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if e.IsDir() {
			return nil
		}
		info, ierr := e.Info()
		if ierr != nil {
			return nil // raced with a delete; skip this entry
		}
		total += info.Size()
		return nil
	})
	return total, err
}
```

同一文件的 import 块加入 `"io/fs"`（`errors`、`path/filepath`、`os` 已在）：

```go
import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd server && go test ./internal/storage/ -run TestUsedBytes -v
```

Expected: `PASS`，两个用例都 ok

- [ ] **Step 5: 提交**

```bash
cd /Users/lily/code/relayium/relayium
git add server/internal/storage/disk.go server/internal/storage/disk_used_test.go
git commit -m "feat(storage): add DiskStore.UsedBytes for real blob-dir footprint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 节点上报真实存量

**问题背景**：`server/cmd/relayium-node/relay.go:242` 的 `storedBytes = t - f` 与 `relay.go:161` 的 `diskUsed` 都是整卷已用。心跳每 30s 一次、blob PUT 每次都要读 `diskUsed`，所以不能每次同步遍历目录——用原子缓存 + 后台刷新。

**Files:**
- Modify: `server/cmd/relayium-node/counter.go`（文件末尾追加）
- Modify: `server/cmd/relayium-node/relay.go:151-184`、`:222`、`:227-248`
- Test: `server/cmd/relayium-node/blob_usage_test.go`（新建）

**Interfaces:**
- Consumes: `(*storage.DiskStore).UsedBytes() (int64, error)`（Task 1）
- Produces: `type blobUsage struct{...}`，`func (b *blobUsage) get() int64`，`func (b *blobUsage) refresh(ds *storage.DiskStore)`，常量 `blobUsageRefresh time.Duration`

- [ ] **Step 1: 写失败的测试**

新建 `server/cmd/relayium-node/blob_usage_test.go`：

```go
package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/storage"
)

// gauge 必须读到 blob 目录的真实大小。这条测试盯的是节点上报口径：曾经上报的是
// 整卷 statfs 已用字节，管理员后台因此把系统盘上的无关数据算成了 relayium 存量。
func TestBlobUsageRefreshReadsRealSize(t *testing.T) {
	ds, err := storage.NewDiskStore(filepath.Join(t.TempDir(), "blobs"))
	if err != nil {
		t.Fatalf("NewDiskStore: %v", err)
	}
	u := &blobUsage{}

	if got := u.get(); got != 0 {
		t.Fatalf("get() = %d before any refresh, want 0", got)
	}

	if _, err := ds.Put(context.Background(), "deadbeef", strings.NewReader(strings.Repeat("z", 777))); err != nil {
		t.Fatalf("Put: %v", err)
	}
	// 刷新前仍是旧值：这正是缓存语义，心跳读的是上一次刷新的结果。
	if got := u.get(); got != 0 {
		t.Fatalf("get() = %d before refresh, want the stale 0", got)
	}

	u.refresh(ds)
	if got := u.get(); got != 777 {
		t.Fatalf("get() = %d after refresh, want 777", got)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd server && go test ./cmd/relayium-node/ -run TestBlobUsage -v
```

Expected: 编译失败，`undefined: blobUsage`

- [ ] **Step 3: 实现 gauge**

在 `server/cmd/relayium-node/counter.go` 末尾追加（import 块需加 `"time"` 和 `"github.com/relayium/relayium/internal/storage"`；`sync/atomic` 已在）：

```go
// blobUsageRefresh is how often the blob-directory size gauge is recomputed.
// Matches the default heartbeat cadence, so central never reports a value more
// than one interval stale.
const blobUsageRefresh = 30 * time.Second

// blobUsage caches the blob directory's total size.
//
// Both readers are hot: the heartbeat fires every ~30s and the blob handler
// consults it on every PUT. Walking the tree on each of those would be O(files)
// work in the request path, so the walk happens on a ticker and readers get an
// atomic load. A value up to one refresh interval stale is fine — the 80%
// volume reserve in relay.go is the real backstop against overshoot.
type blobUsage struct {
	bytes int64 // atomic
}

// get returns the last refreshed total (0 before the first refresh).
func (b *blobUsage) get() int64 { return atomic.LoadInt64(&b.bytes) }

// refresh recomputes the total. A walk error leaves the previous value in place
// rather than zeroing the gauge — reporting 0 used would read as "plenty of
// room" and invite an overfill.
func (b *blobUsage) refresh(ds *storage.DiskStore) {
	if n, err := ds.UsedBytes(); err == nil {
		atomic.StoreInt64(&b.bytes, n)
	}
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd server && go test ./cmd/relayium-node/ -run TestBlobUsage -v
```

Expected: `PASS`

- [ ] **Step 5: 接到 relay.go**

在 `server/cmd/relayium-node/relay.go` 中，把第 151-184 行的存储初始化块替换为：

```go
	var storageURL, storageSecret string
	var storTotal, storFree int64
	var blobGauge *blobUsage
	if c.StorageDir != "" {
		ds, derr := storage.NewDiskStore(c.StorageDir)
		if derr != nil {
			return fmt.Errorf("open storage dir %s: %w", c.StorageDir, derr)
		}
		storageSecret = st.StorageSecret
		// Seed the gauge before anything can read it, so the first PUT and the
		// first heartbeat see a real number rather than 0.
		blobGauge = &blobUsage{}
		blobGauge.refresh(ds)
		go func() {
			tk := time.NewTicker(blobUsageRefresh)
			defer tk.Stop()
			for range tk.C {
				blobGauge.refresh(ds)
			}
		}()
		diskUsed := blobGauge.get
		// Built-in safety reserve: refuse writes once the volume is past 80% used
		// (free < 20%), independent of any admin cap, so relayium can never fill
		// the disk and wedge the host. Fails open on a stat error (don't block).
		//
		// This stays whole-volume on purpose. It is the absolute floor that
		// protects the host from everything on it, whereas diskUsed above is
		// relayium's own footprint measured against the admin cap. Do not
		// "unify" the two — they answer different questions.
		diskFull := func() bool {
			t, f, err := storageReport(c.StorageDir)
			return err == nil && t > 0 && f*5 < t
		}
		blobSrv := &http.Server{Addr: fmt.Sprintf(":%d", c.StoragePort), Handler: newBlobHandler(ds, storageSecret, lim, diskUsed, diskFull)}
		go func() {
			if err := blobSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Printf("relayium-node: blob server exited: %v", err)
			}
		}()
		defer blobSrv.Close()
		storageURL = fmt.Sprintf("http://%s:%d", publicIP, c.StoragePort)
		if t, f, uerr := storageReport(c.StorageDir); uerr == nil {
			storTotal, storFree = t, f
		}
		log.Printf("relayium-node: storage enabled, serving blobs on %s", storageURL)
	}
```

第 222 行的心跳调用改为传 gauge：

```go
			sendHeartbeat(rp, nodeID, reg, c.StorageDir, blobGauge, lim)
```

第 227-248 行的 `sendHeartbeat` 签名与存储部分改为：

```go
func sendHeartbeat(rp *reporter, nodeID string, reg *allocRegistry, storageDir string, blobGauge *blobUsage, lim *limits) {
	samples := reg.snapshot()
	usage := make([]usageItem, 0, len(samples))
	var total int64
	for _, s := range samples {
		if s.Username == "" {
			continue // not yet joined to a username; skip until OnAllocationCreated fires
		}
		usage = append(usage, usageItem{AllocID: s.AllocID, Username: s.Username, RelayedBytes: s.RelayedBytes})
		total += s.RelayedBytes
	}
	var storedBytes, storTotal, storFree int64
	if storageDir != "" {
		if t, f, err := storageReport(storageDir); err == nil {
			storTotal, storFree = t, f
		}
		// relayium's own footprint, NOT total-free. total-free is the whole
		// volume's occupancy and would count every unrelated byte on the host.
		if blobGauge != nil {
			storedBytes = blobGauge.get()
		}
	}
	body := heartbeatBody{
		NodeID: nodeID, Status: "ok", Usage: usage, RelayedTotal: total,
		StoredBytes: storedBytes, StorageTotal: storTotal, StorageFree: storFree,
	}
	hr, err := rp.heartbeat(body)
	if err != nil {
		log.Printf("relayium-node: heartbeat failed (will retry): %v", err)
		return
	}
	if lim != nil {
		lim.sync(hr.RelayedThisMonth, hr.TrafficLimitBytes, hr.DiskLimitBytes)
	}
}
```

- [ ] **Step 6: 全包测试 + 构建**

```bash
cd server && go build ./... && go test ./cmd/relayium-node/ ./internal/storage/
```

Expected: 构建无输出，两个包 `ok`。若 `sendHeartbeat` 还有其它调用点未改，构建会报参数数量不符——按同样方式补 `blobGauge` 参数。

- [ ] **Step 7: 提交**

```bash
cd /Users/lily/code/relayium/relayium
git add server/cmd/relayium-node/
git commit -m "fix(node): report blob-dir footprint instead of whole-volume usage

The whole-volume statfs reading counted the OS and every other program on
the host as relayium storage, inflating the admin dashboard and making
central's placement filter treat nodes as out of quota. Replaced with a
cached walk of the blob directory. The write gate still uses the 80%
whole-volume reserve -- the two answer different questions.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 放置调度应用 70% 余量

**Files:**
- Modify: `server/internal/account/sqlite.go:2120-2134`
- Test: `server/internal/account/storage_headroom_test.go`（新建）

**Interfaces:**
- Consumes: 无
- Produces: 无新符号（`StorageNodes` 签名不变）

**注意**：本任务**只改 fleet 节点的 `StorageNodes`，不改 `UserStorageNodes`（`sqlite.go:2162`）**。用户自有节点是用户自己的盘、自己选择接入的，替他们预留 30% 是越界；那条路径上的整卷 80% 硬保留继续生效，足以防止把宿主机撑爆。

- [ ] **Step 1: 写失败的测试**

新建 `server/internal/account/storage_headroom_test.go`：

```go
package account

import (
	"context"
	"testing"
)

// 放置时只承诺用掉剩余空间的 70%，留 30% 余量。边界用 2.9 GiB 剩余构造：
// 0.7 × 2.9 = 2.03 GiB，所以 1.5 GiB 的放置进得去、2.5 GiB 的进不去。
// 如果有人把过滤条件退回成裸的 storage_free >= minFree，第二个断言会失败。
func TestStorageNodesReserves30PercentHeadroom(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	const now = 10000
	const gib = int64(1) << 30

	// 剩余 2.9 GiB / 总量 18.3 GiB。整卷 80% 硬保留在这里不会误伤：
	// 2.9 × 5 = 14.5 < 18.3 会被排除，所以刻意把总量设小一点让它通过，
	// 单独隔离出 70% 这一条件。
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "tight", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s",
		CreatedAt: 1, LastSeenAt: now, StorageEnabled: true,
		StorageTotal: 4 * gib, StorageFree: 2900 * gib / 1000})

	small, err := st.StorageNodes(ctx, now-1, 1500*gib/1000) // 1.5 GiB
	if err != nil {
		t.Fatalf("StorageNodes(1.5GiB): %v", err)
	}
	if len(small) != 1 {
		t.Fatalf("1.5 GiB placement got %d nodes, want 1 (2.9 GiB free × 0.7 = 2.03 GiB is enough)", len(small))
	}

	big, err := st.StorageNodes(ctx, now-1, 2500*gib/1000) // 2.5 GiB
	if err != nil {
		t.Fatalf("StorageNodes(2.5GiB): %v", err)
	}
	if len(big) != 0 {
		t.Fatalf("2.5 GiB placement got %d nodes, want 0 (only 2.03 GiB is offerable from 2.9 GiB free)", len(big))
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd server && go test ./internal/account/ -run TestStorageNodesReserves30PercentHeadroom -v
```

Expected: FAIL — `2.5 GiB placement got 1 nodes, want 0`（当前是裸的 `storage_free >= minFree`，2.9 ≥ 2.5 就放行了）

- [ ] **Step 3: 实现**

把 `server/internal/account/sqlite.go:2120-2134` 的 `StorageNodes` 替换为：

```go
// StorageNodes returns fleet storage nodes that are online since `since` and can
// offer at least minFree bytes — candidates for placing a new node-backed blob.
func (s *SQLiteStore) StorageNodes(ctx context.Context, since, minFree int64) ([]Node, error) {
	// storage_free*7/10 >= minFree only ever promises 70% of what's left on the
	// volume, keeping a 30% cushion so placement never drives a node right up to
	// its disk. Note this is a *scheduling* reserve, evaluated per placement —
	// it is not a write gate. A gate defined against free space would be
	// self-referential (writing shrinks free, which shrinks the threshold, which
	// never converges); the node's own absolute floor in relay.go handles that.
	//
	// storage_free*5 >= storage_total keeps the volume at most 80% full: never
	// place a new blob on a node whose disk is already past that reserve, so a
	// node can't be filled to the point of wedging its host.
	return s.queryNodes(ctx,
		`SELECT `+nodeCols+` FROM nodes
		   WHERE owner_type='fleet' AND storage_enabled=1 AND last_seen_at >= ? AND storage_free * 7 / 10 >= ?
		     AND (disk_limit_bytes = 0 OR disk_limit_bytes - stored_bytes >= ?)
		     AND (storage_total = 0 OR storage_free * 5 >= storage_total)
		   ORDER BY last_seen_at DESC`, since, minFree, minFree)
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd server && go test ./internal/account/ -run 'TestStorageNodes|TestStorageNodesRespectsDiskLimit' -v
```

Expected: 两个测试都 `PASS`。`TestStorageNodesRespectsDiskLimit` 的节点剩余 50-150 GiB，70% 后仍远超 1 GiB 的 minFree，不受影响。

- [ ] **Step 5: 提交**

```bash
cd /Users/lily/code/relayium/relayium
git add server/internal/account/sqlite.go server/internal/account/storage_headroom_test.go
git commit -m "fix(nodes): offer only 70% of a node's free space during placement

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 后台展示「可用(70%)」

**Files:**
- Modify: `server/internal/account/admin.go:33-49`（`adminNodeView` 结构体与 `nodeViews`）
- Modify: `server/internal/account/admin_templates.go:277`、`:287`
- Test: `server/internal/account/admin_usable_test.go`（新建）

**Interfaces:**
- Consumes: 无
- Produces: `adminNodeView.UsableBytes int64`

- [ ] **Step 1: 写失败的测试**

新建 `server/internal/account/admin_usable_test.go`：

```go
package account

import (
	"testing"
	"time"
)

// 后台的「可用」列必须是 剩余 × 70%，不是总量、也不是 总量-剩余（后者是已用）。
// 用用户报的那组真实数字：剩余 2.9 GB、总量 18.3 GB -> 可用 2.03 GB。
func TestNodeViewDerivesUsableBytes(t *testing.T) {
	const gb = int64(1000 * 1000 * 1000)
	free := 29 * gb / 10   // 2.9 GB
	total := 183 * gb / 10 // 18.3 GB

	views := nodeViews([]Node{{
		ID: "n1", OwnerType: "fleet", StorageEnabled: true,
		StorageFree: free, StorageTotal: total,
	}}, map[string]int64{}, time.Unix(10000, 0))

	if len(views) != 1 {
		t.Fatalf("nodeViews returned %d views, want 1", len(views))
	}
	want := free * 7 / 10
	if views[0].UsableBytes != want {
		t.Fatalf("UsableBytes = %d, want %d (2.9 GB free × 0.7). Note %d would be total-free, i.e. bytes already used by anything on the volume — that is the number this column must never show.",
			views[0].UsableBytes, want, total-free)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd server && go test ./internal/account/ -run TestNodeViewDerivesUsableBytes -v
```

Expected: 编译失败，`views[0].UsableBytes undefined`

- [ ] **Step 3: 实现**

`server/internal/account/admin.go`，在 `adminNodeView` 结构体的 `StorageFree` 字段后加一行：

```go
	StorageTotal      int64
	StorageFree       int64
	// UsableBytes is how much of StorageFree placement will actually offer:
	// 70%, leaving a 30% cushion so a node is never driven right up to its
	// disk. Mirrors the SQL reserve in SQLiteStore.StorageNodes — change both
	// together. Purely derived; not stored and not reported by the node.
	UsableBytes       int64
```

`nodeViews` 的构造里对应加一行（放在 `StorageFree` 之后）：

```go
			StorageFree:       n.StorageFree,
			UsableBytes:       n.StorageFree * 7 / 10,
```

`server/internal/account/admin_templates.go:277` 的表头，把 `<th>盘 剩余/总量</th>` 改为：

```html
<th>盘 剩余/总量</th><th>可用(70%)</th>
```

`:287` 的数据行，在盘剩余/总量那个 `<td>` 之后插入一格：

```html
<td>{{if .StorageEnabled}}{{bytes .StorageFree}} / {{bytes .StorageTotal}}{{else}}—{{end}}</td>
<td>{{if .StorageEnabled}}{{bytes .UsableBytes}}{{else}}—{{end}}</td>
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd server && go test ./internal/account/ -run 'TestNodeView|TestAdminNodes' -v
```

Expected: `PASS`。表头与数据行的 `<td>` 数量必须一致——若 `admin_nodes_test.go` 有列数断言而失败，说明少插了一格。

- [ ] **Step 5: 提交**

```bash
cd /Users/lily/code/relayium/relayium
git add server/internal/account/admin.go server/internal/account/admin_templates.go server/internal/account/admin_usable_test.go
git commit -m "feat(admin): add usable-capacity (70%) column to the node table

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# Part A — 个人中心会员区块

### Task 5: `/api/me/usage` 返回套餐信息

**Files:**
- Modify: `server/internal/account/handlers.go:412-456`
- Test: `server/internal/account/me_usage_test.go`（追加用例）

**Interfaces:**
- Consumes: `s.store.ListPlans(ctx) ([]Plan, error)`、`s.store.GetPlan(ctx, id) (Plan, bool, error)`（均已存在）
- Produces: `/api/me/usage` 响应中的 `plan` 对象，字段：`id`(string)、`name`(string)、`storageBytes`(int64)、`trafficBytes`(int64)、`retentionSecs`(int64)、`priceMonthly`(int64)、`isTop`(bool)、`subscriptionStatus`(string)、`subscriptionEnd`(int64)。Task 6/8 依赖这组字段名。

- [ ] **Step 1: 写失败的测试**

在 `server/internal/account/me_usage_test.go` 末尾追加：

```go
// 个人中心要展示会员等级与权益，光有 used/cap 两个数不够——用户看不出自己在哪
// 个档、这个档买到了什么。plan 块就是那份信息，且必须复用 handler 里已经查过的
// plan 行，不额外打 DB。
func TestMeUsageIncludesPlan(t *testing.T) {
	ts, _, _, mail := newBillingServer(t)
	cookie := loginCookie(t, ts, mail, "plan@b.c")

	req, _ := http.NewRequest("GET", ts.URL+"/api/me/usage", nil)
	req.AddCookie(cookie)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	var body struct {
		Plan struct {
			ID                 string `json:"id"`
			Name               string `json:"name"`
			StorageBytes       int64  `json:"storageBytes"`
			TrafficBytes       int64  `json:"trafficBytes"`
			RetentionSecs      int64  `json:"retentionSecs"`
			PriceMonthly       int64  `json:"priceMonthly"`
			IsTop              bool   `json:"isTop"`
			SubscriptionStatus string `json:"subscriptionStatus"`
			SubscriptionEnd    int64  `json:"subscriptionEnd"`
		} `json:"plan"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// 新注册用户在免费档。
	if body.Plan.ID != "free" {
		t.Fatalf("plan.id = %q, want \"free\"", body.Plan.ID)
	}
	if body.Plan.Name == "" {
		t.Fatalf("plan.name is empty; the card has nothing to show as the tier label")
	}
	if body.Plan.StorageBytes <= 0 || body.Plan.TrafficBytes <= 0 || body.Plan.RetentionSecs <= 0 {
		t.Fatalf("plan perks = storage %d / traffic %d / retention %d; free tier has finite values for all three",
			body.Plan.StorageBytes, body.Plan.TrafficBytes, body.Plan.RetentionSecs)
	}
	if body.Plan.PriceMonthly != 0 {
		t.Fatalf("plan.priceMonthly = %d, want 0 for the free tier", body.Plan.PriceMonthly)
	}
	// free 不是最高档——否则卡片会把免费用户当成"已是最高档"，把升级入口藏掉。
	if body.Plan.IsTop {
		t.Fatalf("plan.isTop = true for the free tier; the upgrade CTA would be hidden from exactly the users who need it")
	}
	if body.Plan.SubscriptionStatus != "" || body.Plan.SubscriptionEnd != 0 {
		t.Fatalf("subscription = %q/%d, want empty for a user who never checked out",
			body.Plan.SubscriptionStatus, body.Plan.SubscriptionEnd)
	}
}

// 最高档用户不该看到"升级"引导。isTop 由 active plans 里最大的 sort_order 判定。
func TestMeUsageMarksTopTier(t *testing.T) {
	ts, _, store, mail := newBillingServer(t)
	cookie := loginCookie(t, ts, mail, "top@b.c")

	plans, err := store.ListPlans(t.Context())
	if err != nil {
		t.Fatalf("ListPlans: %v", err)
	}
	top := Plan{}
	for _, p := range plans {
		if p.Active && p.SortOrder >= top.SortOrder {
			top = p
		}
	}
	if top.ID == "" {
		t.Fatalf("no active plans seeded; cannot exercise isTop")
	}
	u, ok, err := store.UserByCanonicalEmail(t.Context(), "top@b.c")
	if err != nil || !ok {
		t.Fatalf("lookup user: %v ok=%v", err, ok)
	}
	if err := store.SetUserPlan(t.Context(), u.ID, top.ID, "admin"); err != nil {
		t.Fatalf("SetUserPlan: %v", err)
	}

	req, _ := http.NewRequest("GET", ts.URL+"/api/me/usage", nil)
	req.AddCookie(cookie)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()
	var body struct {
		Plan struct {
			ID    string `json:"id"`
			IsTop bool   `json:"isTop"`
		} `json:"plan"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Plan.ID != top.ID {
		t.Fatalf("plan.id = %q, want %q", body.Plan.ID, top.ID)
	}
	if !body.Plan.IsTop {
		t.Fatalf("plan.isTop = false on the highest active tier (%q); the card would keep nagging a Max user to upgrade", top.ID)
	}
}
```

**实现者注意**：`SetUserPlan` 的确切签名请先确认——运行 `cd server && grep -n "SetUserPlan" internal/account/store.go`。若签名不同（例如不接 source 参数，或叫别的名字），按实际签名调整这一行；这是测试脚手架，不是被测行为。

- [ ] **Step 2: 运行测试确认失败**

```bash
cd server && go test ./internal/account/ -run 'TestMeUsageIncludesPlan|TestMeUsageMarksTopTier' -v
```

Expected: FAIL — `plan.id = "", want "free"`（响应里还没有 `plan` 块）

- [ ] **Step 3: 实现**

`server/internal/account/handlers.go`，在 `handleMeUsage` 的 `if !ok { plan = freePlanFallback() }`（约 438-440 行）之后、`writeJSON` 之前插入：

```go
	// isTop: 用户已经在最高档时，卡片要把"升级"换成"已是最高档"——把 Max 用户
	// 往定价页赶是负体验。用 ListPlans 而不是新加一个 store 方法，是因为 plans
	// 表只有个位数行、且已被 /api/plans 以同样方式读取；新增接口方法还得在所有
	// 测试替身里实现，不划算。
	isTop := true
	if plans, perr := s.store.ListPlans(ctx); perr == nil {
		for _, p := range plans {
			if p.Active && p.SortOrder > plan.SortOrder {
				isTop = false
				break
			}
		}
	}
```

`writeJSON` 调用替换为：

```go
	writeJSON(w, http.StatusOK, map[string]any{
		"period":   period,
		"resetsAt": monthEnd,
		"traffic":  map[string]any{"used": traffic, "cap": trafficCap},
		"storage":  map[string]any{"used": storage, "cap": storageCap},
		// 套餐信息复用上面已经查出的 plan 行，不额外打 DB。
		// trafficBytes 是这个档的**标称**月上限，和上面 traffic.cap 不同：后者
		// 对月中改过档的用户是按段折算过的实际额度。卡片要宣传的是标称值。
		"plan": map[string]any{
			"id":                 plan.ID,
			"name":               plan.Name,
			"storageBytes":       storageCap,
			"trafficBytes":       nonNegCap(plan.TrafficBytes),
			"retentionSecs":      nonNegCap(plan.RetentionSecs),
			"priceMonthly":       plan.PriceMonthly,
			"isTop":              isTop,
			"subscriptionStatus": u.SubscriptionStatus,
			"subscriptionEnd":    u.SubscriptionEnd,
		},
	})
}

// nonNegCap 把"无限"的各种内部表示（负数）规约成对外约定的 0。前端只判断一个值。
func nonNegCap(v int64) int64 {
	if v < 0 {
		return 0
	}
	return v
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd server && go test ./internal/account/ -run TestMeUsage -v
```

Expected: 三个 `TestMeUsage*` 全部 `PASS`（含原有的 `TestMeUsageReportsMonthToDate`）

- [ ] **Step 5: 提交**

```bash
cd /Users/lily/code/relayium/relayium
git add server/internal/account/handlers.go server/internal/account/me_usage_test.go
git commit -m "feat(api): return current plan and its perks from /api/me/usage

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 共享 usage fetch

**问题背景**：`/api/me/usage` 现被 `QuotaMeters` 和 `QuotaNotice` 各 fetch 一次，Task 8 的 `PlanCard` 会变成第三次。抽一个按用户 id 缓存的模块。

**Files:**
- Create: `web/src/lib/usage.svelte.ts`
- Modify: `web/src/lib/QuotaMeters.svelte:1-24`
- Modify: `web/src/lib/QuotaNotice.svelte:1-38`
- Modify: `web/src/lib/QuotaNotice.test.ts`（`afterEach` 加清缓存）

**Interfaces:**
- Consumes: Task 5 的 `plan` 字段形状
- Produces: `interface Bucket`、`interface PlanInfo`、`interface Usage`、`function fetchUsage(userId: string): Promise<Usage | null>`、`function invalidateUsage(): void` — Task 8 使用

- [ ] **Step 1: 建共享模块**

新建 `web/src/lib/usage.svelte.ts`：

```ts
// /api/me/usage 被三个组件读：PlanCard 与 QuotaMeters（都在 /me 页），以及传输
// 页的 QuotaNotice。三者各自 fetch 会在打开个人中心时打出三次同样的请求，所以
// 这里按用户 id 缓存在途 promise。换用户（登录、切号、登出）自然失效。
//
// 缓存的是 promise 而非结果：三个组件在同一帧挂载时都能命中同一个在途请求。

export interface Bucket {
  used: number;
  cap: number; // 0 表示无限——服务端已把内部的负数表示规约掉了
}

export interface PlanInfo {
  id: string;
  name: string;
  storageBytes: number; // 0 = 无限
  trafficBytes: number; // 0 = 无限；这是标称月上限，不是折算后的实际额度
  retentionSecs: number; // 0 = 永久保留
  priceMonthly: number; // 美分
  isTop: boolean; // 已在最高档：隐藏升级引导
  subscriptionStatus: string; // '' = 从未结账
  subscriptionEnd: number; // unix 秒；0 = 无订阅
}

export interface Usage {
  period: string;
  resetsAt: number;
  traffic: Bucket;
  storage: Bucket;
  plan?: PlanInfo; // 可选：老版本服务端不返回它时前端要能降级
}

let cacheKey: string | null = null;
let cached: Promise<Usage | null> | null = null;

// 取当前用户的用量。同一 userId 的并发/后续调用共享一次请求。
// 取不到时 resolve 成 null（而不是 reject）——用量是附加信息，调用方一律
// "拿不到就不渲染"，没有需要区分错误类型的场景。
export function fetchUsage(userId: string): Promise<Usage | null> {
  if (cacheKey === userId && cached) return cached;
  cacheKey = userId;
  cached = fetch("/api/me/usage", { credentials: "include" })
    .then((r) => (r.ok ? (r.json() as Promise<Usage>) : null))
    .catch(() => null);
  return cached;
}

// 丢弃缓存，下次 fetchUsage 重新请求。用量或套餐变化后调用（上传完成、改档）。
// 测试必须在 afterEach 里调它，否则 mock 的响应会跨用例串味。
export function invalidateUsage(): void {
  cacheKey = null;
  cached = null;
}
```

- [ ] **Step 2: 改 QuotaMeters 用共享 fetch**

`web/src/lib/QuotaMeters.svelte` 的 `<script>` 段（第 1-25 行）替换为：

```svelte
<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { session } from "./auth.svelte";
  import { formatSize } from "./format";
  import { fetchUsage, type Bucket, type Usage } from "./usage.svelte";

  const t = $derived<Messages>(messages[lang()]);

  let usage = $state<Usage | null>(null);

  // 跟着会话走：登出清空，换账号重取。与 QuotaNotice 同款守卫——本组件所在的
  // /me 页在登出后不会立刻卸载，无条件写 usage 会把上一个账号的数字画出来。
  $effect(() => {
    const uid = session().user?.id ?? null;
    if (!uid) { usage = null; return; }
    fetchUsage(uid).then((u) => {
      if (session().user?.id !== uid) return; // 陈旧响应，丢弃
      usage = u;
    });
  });

  // cap === 0 表示无限档，此时不画进度条——画一条永远填不满的槽只会误导。
  const pct = (b: Bucket) => (b.cap > 0 ? Math.min(100, Math.round((b.used / b.cap) * 100)) : 0);
  const resetDate = $derived(
    usage ? new Date(usage.resetsAt * 1000).toLocaleDateString(lang()) : "",
  );
</script>
```

注意组件内原有的本地 `interface Bucket`/`interface Usage` 定义已被 import 取代，模板部分完全不动。

- [ ] **Step 3: 改 QuotaNotice 用共享 fetch**

`web/src/lib/QuotaNotice.svelte` 的 `$effect` 块（第 14-38 行）替换为：

```svelte
  // 跟着会话走：登出后清零，换账号后重取。未登录用户没有配额可言。
  $effect(() => {
    const uid = session().user?.id ?? null;
    if (!uid) { pct = 0; loadedFor = null; return; }
    if (uid === loadedFor) return;
    loadedFor = uid;
    fetchUsage(uid).then((u) => {
      // 陈旧响应守卫：这个请求是给 `uid` 发的，但它兑现时会话可能已经登出或切到
      // 了别的账号——登出控件和本组件同页共存（Nav 不会卸载 QuotaNotice），所以
      // “无条件写 pct”会把上一个账号的百分比在登出后重新画出来。一旦会话已经不
      // 是发起请求时的那个，直接丢弃这次响应。不要因为看着像多余判断就删掉。
      if (session().user?.id !== uid) return;
      // cap === 0 是无限档，永远不提醒。取不到用量时 fetchUsage resolve null。
      const cap = u?.traffic?.cap ?? 0;
      pct = cap > 0 ? Math.min(100, Math.round((u!.traffic.used / cap) * 100)) : 0;
    });
  });
```

同文件 import 段加入：

```svelte
  import { fetchUsage } from "./usage.svelte";
```

- [ ] **Step 4: 测试隔离**

`web/src/lib/QuotaNotice.test.ts` 的 `afterEach` 改为（并在 import 段加 `import { invalidateUsage } from "./usage.svelte";`）：

```ts
afterEach(() => {
  if (app) unmount(app as never);
  target?.remove();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
  // usage.svelte.ts 按用户 id 缓存在途 promise。用例之间用的是同一个 user id，
  // 不清掉的话第二个用例会命中第一个用例 mock 出来的响应。
  invalidateUsage();
});
```

- [ ] **Step 5: 跑测试与类型检查**

```bash
cd web && npx vitest run src/lib/QuotaNotice.test.ts && npm run check
```

Expected: QuotaNotice 全部用例 `PASS`；`npm run check` 无错误

- [ ] **Step 6: 提交**

```bash
cd /Users/lily/code/relayium/relayium
git add web/src/lib/usage.svelte.ts web/src/lib/QuotaMeters.svelte web/src/lib/QuotaNotice.svelte web/src/lib/QuotaNotice.test.ts
git commit -m "refactor(web): share a per-user cached fetch for /api/me/usage

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 会员卡文案（i18n）

**Files:**
- Modify: `web/src/lib/i18n/types.ts`（`me` 块内，`signIn` 之后）
- Modify: `web/src/lib/i18n/{zh,en,ja,ko,de,fr,ar,es,pt}.ts`（各自 `me` 块内）

**Interfaces:**
- Consumes: 无
- Produces: `t.me.plan.perks(storage, traffic, retention)`、`t.me.plan.retentionDays(n)`、`t.me.plan.retentionForever`、`t.me.plan.hint`、`t.me.plan.topTier` — Task 8 使用。复用已存在的 `t.billing.currentPlan / upgrade / manageBilling / portalError` 与 `t.quota.unlimited`。

- [ ] **Step 1: 加类型契约**

`web/src/lib/i18n/types.ts` 的 `me: {` 块内，在 `signIn: string;` 之后插入：

```ts
    // 个人中心的会员卡（PlanCard）。等级名与升级/管理订阅按钮复用 billing.* 的
    // 既有文案，这里只补卡片独有的三段。
    plan: {
      // 权益一行；三个参数都已格式化好（体积字符串 + 下面两个 retention 文案之一）
      perks: (storage: string, traffic: string, retention: string) => string;
      retentionDays: (n: number) => string; // 文件保留 n 天
      retentionForever: string; // retentionSecs === 0 的无限档
      hint: string; // 引导句：不够用可以升级
      topTier: string; // 已在最高档时替代升级按钮
    };
```

- [ ] **Step 2: 确认类型检查失败**

```bash
cd web && npm run check
```

Expected: 9 个语言文件各报一处 `Property 'plan' is missing in type ...`

- [ ] **Step 3: 补九个语言文件**

在每个文件的 `me: {` 块内、`signIn` 之后插入对应块。

`en.ts`:
```ts
    plan: {
      perks: (storage, traffic, retention) => `${storage} storage · ${traffic}/mo traffic · ${retention}`,
      retentionDays: (n) => `Files kept ${n} day${n === 1 ? "" : "s"}`,
      retentionForever: "Files kept indefinitely",
      hint: "Running out of room? Upgrading gets you more capacity and longer retention.",
      topTier: "You're on the highest tier.",
    },
```

`zh.ts`:
```ts
    plan: {
      perks: (storage, traffic, retention) => `${storage} 存储 · ${traffic}/月流量 · ${retention}`,
      retentionDays: (n) => `文件保留 ${n} 天`,
      retentionForever: "文件永久保留",
      hint: "空间不够用？升级可获得更大容量和更长保留期。",
      topTier: "你已在最高档。",
    },
```

`ja.ts`:
```ts
    plan: {
      perks: (storage, traffic, retention) => `ストレージ ${storage} · 月間転送量 ${traffic} · ${retention}`,
      retentionDays: (n) => `ファイル保持 ${n} 日`,
      retentionForever: "ファイルを無期限に保持",
      hint: "容量が足りませんか？アップグレードで容量と保持期間が増えます。",
      topTier: "最上位プランをご利用中です。",
    },
```

`ko.ts`:
```ts
    plan: {
      perks: (storage, traffic, retention) => `저장공간 ${storage} · 월 트래픽 ${traffic} · ${retention}`,
      retentionDays: (n) => `파일 ${n}일 보관`,
      retentionForever: "파일 무기한 보관",
      hint: "공간이 부족한가요? 업그레이드하면 용량과 보관 기간이 늘어납니다.",
      topTier: "이미 최고 등급입니다.",
    },
```

`de.ts`:
```ts
    plan: {
      perks: (storage, traffic, retention) => `${storage} Speicher · ${traffic}/Monat Traffic · ${retention}`,
      retentionDays: (n) => `Dateien ${n} Tag${n === 1 ? "" : "e"} aufbewahrt`,
      retentionForever: "Dateien unbegrenzt aufbewahrt",
      hint: "Platz wird knapp? Ein Upgrade bringt mehr Kapazität und längere Aufbewahrung.",
      topTier: "Du nutzt bereits den höchsten Tarif.",
    },
```

`fr.ts`:
```ts
    plan: {
      perks: (storage, traffic, retention) => `${storage} de stockage · ${traffic}/mois de trafic · ${retention}`,
      retentionDays: (n) => `Fichiers conservés ${n} jour${n === 1 ? "" : "s"}`,
      retentionForever: "Fichiers conservés indéfiniment",
      hint: "Vous manquez d'espace ? Passer à l'offre supérieure augmente la capacité et la durée de conservation.",
      topTier: "Vous êtes déjà sur l'offre la plus élevée.",
    },
```

`ar.ts`（RTL——文案里不要放方向性标点包裹变量，插值顺序保持与其它语言一致）:
```ts
    plan: {
      perks: (storage, traffic, retention) => `${storage} تخزين · ${traffic}/شهر نقل بيانات · ${retention}`,
      retentionDays: (n) => `يتم الاحتفاظ بالملفات ${n} يوم`,
      retentionForever: "يتم الاحتفاظ بالملفات إلى أجل غير مسمى",
      hint: "هل تنفد المساحة؟ الترقية تمنحك سعة أكبر ومدة احتفاظ أطول.",
      topTier: "أنت على أعلى باقة بالفعل.",
    },
```

`es.ts`:
```ts
    plan: {
      perks: (storage, traffic, retention) => `${storage} de almacenamiento · ${traffic}/mes de tráfico · ${retention}`,
      retentionDays: (n) => `Archivos guardados ${n} día${n === 1 ? "" : "s"}`,
      retentionForever: "Archivos guardados indefinidamente",
      hint: "¿Te quedas sin espacio? Mejorar tu plan te da más capacidad y mayor retención.",
      topTier: "Ya tienes el plan más alto.",
    },
```

`pt.ts`:
```ts
    plan: {
      perks: (storage, traffic, retention) => `${storage} de armazenamento · ${traffic}/mês de tráfego · ${retention}`,
      retentionDays: (n) => `Arquivos mantidos ${n} dia${n === 1 ? "" : "s"}`,
      retentionForever: "Arquivos mantidos indefinidamente",
      hint: "Ficando sem espaço? Fazer upgrade dá mais capacidade e retenção mais longa.",
      topTier: "Você já está no plano mais alto.",
    },
```

- [ ] **Step 4: 确认类型检查通过**

```bash
cd web && npm run check
```

Expected: 无错误

- [ ] **Step 5: 提交**

```bash
cd /Users/lily/code/relayium/relayium
git add web/src/lib/i18n/
git commit -m "i18n: add member-card copy for all nine languages

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `PlanCard.svelte`

**Files:**
- Create: `web/src/lib/PlanCard.svelte`
- Create: `web/src/lib/PlanCard.test.ts`
- Modify: `web/src/lib/MePage.svelte:233`

**Interfaces:**
- Consumes: `fetchUsage(userId)`、`PlanInfo`（Task 6）；`t.me.plan.*`（Task 7）；`t.billing.currentPlan / upgrade / manageBilling / portalError`、`t.quota.unlimited`（已存在）
- Produces: 无

- [ ] **Step 1: 写失败的测试**

新建 `web/src/lib/PlanCard.test.ts`（沿用 `QuotaNotice.test.ts` 的 mount + flushSync 套路）：

```ts
// 会员卡的组件级覆盖。三种形态各钉一条：免费档（要有升级引导）、付费档（要有
// 管理订阅）、最高档（升级引导必须消失）。用真实的 session/i18n 模块 + mock
// fetch，与 QuotaNotice.test.ts 同款。
import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import PlanCard from "./PlanCard.svelte";
import { refreshSession } from "./auth.svelte";
import { loadLang } from "./i18n.svelte";
import { invalidateUsage } from "./usage.svelte";

let target: HTMLDivElement;
let app: unknown;

function plan(over: Record<string, unknown> = {}) {
  return {
    id: "free", name: "Free", storageBytes: 100 * 1024 * 1024,
    trafficBytes: 1024 * 1024 * 1024, retentionSecs: 3 * 86400,
    priceMonthly: 0, isTop: false, subscriptionStatus: "", subscriptionEnd: 0,
    ...over,
  };
}

// 登录并让 /api/me/usage 返回指定套餐。
async function mountWith(p: Record<string, unknown>) {
  const user = { id: "u1", email: "a@b.c" };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/me") return { ok: true, status: 200, json: async () => ({ user }) };
    if (url === "/api/me/usage") return {
      ok: true, status: 200,
      json: async () => ({
        period: "202607", resetsAt: 0,
        traffic: { used: 0, cap: 0 }, storage: { used: 0, cap: 0 },
        plan: p,
      }),
    };
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch);
  await refreshSession();
  await loadLang("en");
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(PlanCard, { target });
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

afterEach(() => {
  if (app) unmount(app as never);
  target?.remove();
  vi.unstubAllGlobals();
  invalidateUsage();
});

describe("PlanCard", () => {
  it("免费档显示等级名、权益与升级入口", async () => {
    await mountWith(plan());
    const html = target.textContent ?? "";
    expect(html).toContain("Free");
    expect(html).toContain("100 MB");         // 存储权益
    expect(html).toContain("Files kept 3 days"); // 保留期
    expect(html).toContain("Running out of room?"); // 引导句
    const btns = [...target.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(btns).toContain("Upgrade");
    expect(btns).not.toContain("Manage billing");
  });

  it("付费档额外给出管理订阅入口", async () => {
    await mountWith(plan({ id: "pro", name: "Pro", priceMonthly: 890, subscriptionStatus: "active" }));
    const btns = [...target.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(btns).toContain("Upgrade");
    expect(btns).toContain("Manage billing");
  });

  it("最高档不再引导升级", async () => {
    await mountWith(plan({ id: "max", name: "Max", isTop: true, subscriptionStatus: "active" }));
    const btns = [...target.querySelectorAll("button")].map((b) => b.textContent?.trim());
    // 已经买到顶了还催升级是负体验，也没有目标页可去。
    expect(btns).not.toContain("Upgrade");
    expect(target.textContent).toContain("You're on the highest tier.");
  });

  it("无限档的权益不显示成 0", async () => {
    await mountWith(plan({ id: "max", name: "Max", storageBytes: 0, trafficBytes: 0, retentionSecs: 0 }));
    const text = target.textContent ?? "";
    expect(text).toContain("Unlimited");
    expect(text).toContain("Files kept indefinitely");
    expect(text).not.toMatch(/\b0 B\b/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd web && npx vitest run src/lib/PlanCard.test.ts
```

Expected: FAIL — `Failed to resolve import "./PlanCard.svelte"`

- [ ] **Step 3: 实现组件**

新建 `web/src/lib/PlanCard.svelte`：

```svelte
<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { session } from "./auth.svelte";
  import { navigate } from "./router.svelte";
  import { formatSize } from "./format";
  import { fetchUsage, type PlanInfo } from "./usage.svelte";

  const t = $derived<Messages>(messages[lang()]);

  let plan = $state<PlanInfo | null>(null);
  let portalBusy = $state(false);
  let portalError = $state("");

  // 与 QuotaMeters 共用 fetchUsage 的缓存，所以同页两个组件只打一次请求。
  // 陈旧响应守卫同款：登出后不要把上一个账号的套餐画出来。
  $effect(() => {
    const uid = session().user?.id ?? null;
    if (!uid) { plan = null; return; }
    fetchUsage(uid).then((u) => {
      if (session().user?.id !== uid) return;
      plan = u?.plan ?? null;
    });
  });

  // cap === 0 是无限档，显示"无限"而不是"0 B"。
  const cap = (v: number) => (v > 0 ? formatSize(v) : t.quota.unlimited);
  const retention = $derived(
    plan && plan.retentionSecs > 0
      ? t.me.plan.retentionDays(Math.round(plan.retentionSecs / 86400))
      : t.me.plan.retentionForever,
  );
  const subEnd = $derived(
    plan?.subscriptionEnd
      ? new Date(plan.subscriptionEnd * 1000).toLocaleDateString(lang())
      : "",
  );

  // 照抄 Account.svelte 的 onManageBilling：跳 Stripe 客户门户。
  async function onManageBilling() {
    if (portalBusy) return;
    portalError = "";
    portalBusy = true;
    try {
      const res = await fetch("/api/billing/portal", { method: "POST", credentials: "include" });
      if (!res.ok) { portalError = t.billing.portalError; return; }
      const data = (await res.json()) as { url?: string };
      if (data.url) location.href = data.url;
      else portalError = t.billing.portalError;
    } catch {
      portalError = t.billing.portalError;
    } finally {
      portalBusy = false;
    }
  }
</script>

<!-- 取不到套餐信息时整块不渲染，与 QuotaMeters 的策略一致：会员卡是附加信息，
     画一张空卡比不画更糟。 -->
{#if plan}
  <section class="plan-card">
    <div class="head">
      <h3>{t.billing.currentPlan}</h3>
      <span class="badge">{plan.name}</span>
    </div>

    <p class="perks">{t.me.plan.perks(cap(plan.storageBytes), cap(plan.trafficBytes), retention)}</p>

    {#if plan.subscriptionStatus}
      <p class="sub">{plan.subscriptionStatus}{#if subEnd} · {subEnd}{/if}</p>
    {/if}

    {#if plan.isTop}
      <p class="hint">{t.me.plan.topTier}</p>
    {:else}
      <p class="hint">{t.me.plan.hint}</p>
    {/if}

    <div class="actions">
      {#if !plan.isTop}
        <button class="btn btn-primary" onclick={() => navigate("pricing")}>{t.billing.upgrade}</button>
      {/if}
      {#if plan.subscriptionStatus}
        <button class="btn" disabled={portalBusy} onclick={onManageBilling}>{t.billing.manageBilling}</button>
      {/if}
    </div>
    {#if portalError}<p class="err">{portalError}</p>{/if}
  </section>
{/if}

<style>
  /* 与 QuotaMeters.svelte 的 .quota 同款卡片：两块在 /me 页上下相邻，视觉重量
     必须一致，否则会读成主次关系。 */
  .plan-card {
    padding: var(--space-5) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--social-bg);
    margin-bottom: var(--space-3);
  }
  .head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .head h3 { margin: 0; font-size: var(--fs-h3); color: var(--text-h); }
  .badge {
    padding: 2px var(--space-2);
    border-radius: 999px;
    background: var(--accent);
    color: var(--btn-text, #fff);
    font-size: var(--fs-xs);
  }
  .perks { margin: var(--space-3) 0 0; color: var(--text-h); }
  .sub { margin: var(--space-2) 0 0; color: var(--text); font-size: var(--fs-xs); }
  .hint { margin: var(--space-3) 0 0; color: var(--text); font-size: var(--fs-xs); }
  .actions { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-3); }
  .err { margin: var(--space-2) 0 0; color: var(--danger, #c00); font-size: var(--fs-xs); }
</style>
```

**实现者注意**：`--btn-text` 和 `--danger` 带了 fallback，因为不确定本仓是否定义了它们。跑完 Step 4 后在浏览器里看一眼徽章与错误文字的颜色；若仓库里已有对应变量（`grep -rn "\-\-danger\|\-\-btn-text" web/src/`），改用真实变量名并去掉 fallback。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd web && npx vitest run src/lib/PlanCard.test.ts
```

Expected: 四个用例全 `PASS`

- [ ] **Step 5: 挂到 MePage**

`web/src/lib/MePage.svelte` 第 233 行，在 `<QuotaMeters />` **之前**插入 `<PlanCard />`：

```svelte
    <PlanCard />
    <QuotaMeters />
```

同文件 import 段（与 `QuotaMeters` 的 import 相邻）加入：

```svelte
  import PlanCard from "./PlanCard.svelte";
```

- [ ] **Step 6: 全量校验**

```bash
cd web && npm run check && npx vitest run && npm run build
```

Expected: 类型检查无错误；全部前端测试 `PASS`；构建成功

- [ ] **Step 7: 提交**

```bash
cd /Users/lily/code/relayium/relayium
git add web/src/lib/PlanCard.svelte web/src/lib/PlanCard.test.ts web/src/lib/MePage.svelte
git commit -m "feat(me): add member card with tier, perks and upgrade CTA

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 收尾验证

- [ ] **全量测试**

```bash
cd server && go build ./... && go test ./... 2>&1 | tail -30
cd ../web && npm run check && npx vitest run && npm run build
```

Expected: Go 全部包 `ok` 或 `no test files`；前端类型检查、测试、构建全过。

- [ ] **人工确认（部署后）**

1. `/me` 页登录后应先看到会员卡，再看到本月用量；点「升级套餐」跳 `/pricing`。
2. 管理员后台节点表：「盘 剩余/总量」旁多出「可用(70%)」，其值 ≈ 剩余 × 0.7。
3. **预期中的观感变化**：「存储」列的数字会从"整卷已用"（例如 15.4 GB）骤降到 blob 实际占用（可能只有几 MB）。这是修复生效的表现，不是数据丢失。节点需要重新部署新二进制后该列才会变。

---

## Self-Review 记录

- **Spec 覆盖**：Part A 三项要求（展示等级 / 引导升级 / 升级跳转）分别落在 Task 5(数据)、Task 7(引导文案)、Task 8(跳转)；Part B 五节分别落在 Task 1-2(口径)、Task 3(调度)、Task 4(展示)、以及 Global Constraints 中"硬闸不动"的约束。
- **与 spec 的两处偏离，已确认**：
  1. spec 说要修正 `node_disk_cap_test.go`。读代码后确认不需要：该测试直接往 DB 写 `stored_bytes` 构造用例，口径修复后它的构造反而变成正确语义。Task 3 Step 4 里改为验证它仍然通过。
  2. spec 说新增 3 个 i18n key，实际 5 个：保留期存在 `retentionSecs === 0` 的无限档，需要独立文案（`retentionDays` / `retentionForever`），无法塞进单个插值。
- **符号一致性**：`UsedBytes` / `blobUsage.get` / `blobUsage.refresh` / `UsableBytes` / `fetchUsage` / `invalidateUsage` / `nonNegCap` / `t.me.plan.*` 在定义任务与消费任务中拼写一致。
- **已知待确认项（已在对应步骤内标注，不是占位符）**：Task 5 的 `SetUserPlan` 签名、Task 8 的 `--btn-text` / `--danger` 变量是否存在——两处都给了确认命令与调整方式。
