# 节点自动更新 · 第 1 部分：节点侧闭环 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一台节点能安全地把自己升到指定版本——验签、原子替换、重启，新版本起不来时自动换回旧的——并且升级时不掐断在途传输。

**Architecture:** 节点本体（沙箱内、非 root）永远不具备更新能力；更新由 `relayium-node update` 子命令完成，它由 root 执行。本计划里这个子命令**手动指定目标版本**（`-to v0.9.0`），第 2 部分再接上中央的串行队列实现全自动。节点每次心跳成功后 touch 一个文件，更新器靠它判断新版本是否真的活着。

**Tech Stack:** Go 1.x（stdlib + 已有的 `internal/selfupdate`）、systemd、shell。

## Global Constraints

- 依据 spec：`docs/superpowers/specs/2026-07-22-node-auto-update-design.md`
- **绝不**给节点沙箱开 `/usr/local/bin` 写权限。更新器是独立进程，节点本体永不具备更新能力。
- 更新的二进制**必须**通过 `internal/selfupdate` 的 ECDSA 签名 + sha256 校验。不新增任何绕过校验的路径。
- 降级**默认拒绝**，只在显式传入允许降级时执行。
- Go 代码注释用英语；commit message 用英语；文档用中文。
- 测试不允许 `time.Sleep` 等待状态变化——用注入的时钟或轮询超时。

---

### Task 1: 优雅停机

升级 = 重启 = 掐断这台节点上所有在途的中继和下载。现在的关停走 `blobSrv.Close()` / `dlSrv.Close()`（`relay.go` 的 defer），会立刻切断在途连接。改成 `Shutdown()` 等在途请求跑完。

**Files:**
- Modify: `server/cmd/relayium-node/relay.go`（`run()` 里的两处 `defer ...Close()`，以及 `ctx.Done()` 分支）
- Modify: `web/public/install-node.sh`（unit 加 `TimeoutStopSec`）
- Test: `server/cmd/relayium-node/shutdown_test.go`（新建）

**Interfaces:**
- Consumes: 无
- Produces: `gracefulShutdown(srvs []*http.Server, d time.Duration) error` — 供本文件内部使用，无跨任务消费者。

- [ ] **Step 1: 写失败的测试**

新建 `server/cmd/relayium-node/shutdown_test.go`：

```go
package main

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A request in flight when shutdown starts must be allowed to finish, not cut
// off — an update restarts the node, and cutting live downloads on every
// rollout is exactly what graceful shutdown exists to prevent.
func TestGracefulShutdownLetsInFlightRequestFinish(t *testing.T) {
	started := make(chan struct{})
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		time.Sleep(200 * time.Millisecond) // simulate a download still streaming
		fmt.Fprint(w, "done")
	}))
	srv.Start()
	defer srv.Close()

	body := make(chan string, 1)
	go func() {
		resp, err := http.Get(srv.URL)
		if err != nil {
			body <- "ERR:" + err.Error()
			return
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		body <- string(b)
	}()

	<-started
	if err := gracefulShutdown([]*http.Server{srv.Config}, 5*time.Second); err != nil {
		t.Fatalf("gracefulShutdown: %v", err)
	}

	select {
	case got := <-body:
		if got != "done" {
			t.Errorf("in-flight request got %q, want %q", got, "done")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("in-flight request never completed")
	}
}

// A request that outlives the grace period must not hold shutdown open
// forever; the updater is waiting on this process to exit.
func TestGracefulShutdownGivesUpAfterDeadline(t *testing.T) {
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(3 * time.Second)
	}))
	srv.Start()
	defer srv.Close()

	go http.Get(srv.URL) //nolint:errcheck // the client side is expected to fail here
	time.Sleep(50 * time.Millisecond)

	start := time.Now()
	err := gracefulShutdown([]*http.Server{srv.Config}, 300*time.Millisecond)
	elapsed := time.Since(start)

	if err == nil {
		t.Error("want a deadline error when a request outlives the grace period, got nil")
	}
	if elapsed > 2*time.Second {
		t.Errorf("gracefulShutdown blocked %v, want it to give up near the 300ms deadline", elapsed)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

```
cd server && go test ./cmd/relayium-node/ -run TestGracefulShutdown -v
```
预期：编译失败，`undefined: gracefulShutdown`

- [ ] **Step 3: 实现 gracefulShutdown**

在 `server/cmd/relayium-node/relay.go` 文件末尾追加：

```go
// gracefulShutdown stops the given servers, letting in-flight requests finish
// within d. An update restarts the node, so without this every rollout would
// cut live downloads and relay sessions on every node it touches. Returns the
// deadline error if a request outlives d — the caller exits regardless, since
// the updater is waiting on this process.
func gracefulShutdown(srvs []*http.Server, d time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	var firstErr error
	for _, s := range srvs {
		if s == nil {
			continue
		}
		if err := s.Shutdown(ctx); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
```

- [ ] **Step 4: 跑测试确认通过**

```
cd server && go test ./cmd/relayium-node/ -run TestGracefulShutdown -v
```
预期：两个测试都 PASS

- [ ] **Step 5: 在 run() 里接上**

在 `run()` 中，把 `blobSrv` 和 `dlSrv` 收集到一个切片里，替换掉原来的 `defer blobSrv.Close()` / `defer dlSrv.Close()`。

在 `blobSrv` 创建处（`relay.go` 中 `defer blobSrv.Close()` 那一行）之前，于 `run()` 顶部靠近 `var storTotal, storFree int64` 处加：

```go
	// Servers that must drain rather than be cut off when we shut down.
	var httpSrvs []*http.Server
```

把 `defer blobSrv.Close()` 替换为：

```go
		httpSrvs = append(httpSrvs, blobSrv)
```

把 `defer dlSrv.Close()` 替换为：

```go
			httpSrvs = append(httpSrvs, dlSrv)
```

把 `ctx.Done()` 分支替换为：

```go
		case <-ctx.Done():
			log.Printf("relayium-node: draining in-flight requests (up to %s)", shutdownGrace)
			if err := gracefulShutdown(httpSrvs, shutdownGrace); err != nil {
				log.Printf("relayium-node: shutdown deadline hit: %v", err)
			}
			log.Printf("relayium-node: shutting down")
			return nil
```

并在 `relay.go` 顶部的常量区加：

```go
// shutdownGrace bounds how long we let in-flight downloads and relay sessions
// finish on SIGTERM. systemd's TimeoutStopSec must exceed this.
const shutdownGrace = 60 * time.Second
```

确认 `relay.go` 的 import 里有 `"context"`（已有，`signal.NotifyContext` 在用）。

- [ ] **Step 6: 跑全量测试**

```
cd server && go test ./cmd/relayium-node/
```
预期：ok

- [ ] **Step 7: unit 加 TimeoutStopSec**

`web/public/install-node.sh` 中生成 unit 的 heredoc，在 `RestartSec=5` 之后加一行：

```
TimeoutStopSec=90
```

同步更新 `docs/node-hardening.md` 的 Step 4 示例 unit（同样加在 `RestartSec=2` 之后）。

- [ ] **Step 8: 提交**

```bash
git add server/cmd/relayium-node/relay.go server/cmd/relayium-node/shutdown_test.go web/public/install-node.sh docs/node-hardening.md
git commit -m "feat(node): drain in-flight requests on SIGTERM instead of cutting them

An update restarts the node, so without draining every rollout would kill live
downloads and relay sessions on each node it touches. Swap Close() for
Shutdown() with a 60s grace period and give systemd a 90s TimeoutStopSec."
```

---

### Task 2: 中央 302 前检查节点在线

`server/internal/account/files.go:383` 决定是否 302 到节点时只看它有没有 `DownloadURL`，不看是否在线。节点重启的那几十秒里，下载者会被重定向到一台正在重启的机器（CF 表现为 522）。这个 bug 独立于自动更新存在，但自动更新会让它每次滚动都被触发十几次。

**Files:**
- Modify: `server/internal/account/files.go:380-387`
- Test: `server/internal/account/files_direct_online_test.go`（新建）

**Interfaces:**
- Consumes: 已有的 `nodeOnlineWindow` 常量、`Node.LastSeenAt`
- Produces: 无新导出符号

- [ ] **Step 1: 写失败的测试**

新建 `server/internal/account/files_direct_online_test.go`。fixture 沿用
`files_directdl_test.go:20` 的 `newFileServer` / `UpsertNode` / `CreateStoredFile` 三件套：

```go
package account

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// A node that stopped heartbeating may be restarting for an update or simply
// gone; either way a 302 there hands the downloader a dead origin (522 through
// Cloudflare). Central must proxy instead. The online case is already covered
// by TestDirectDownloadRedirectsToNode, which sets LastSeenAt to now.
func TestDirectDownloadSkipsOfflineNode(t *testing.T) {
	ts, svc, store, _ := newFileServer(t)
	svc.SetDirectDownload(true)
	ctx := context.Background()
	owner, _ := store.UpsertUserByEmail(ctx, "offline@example.com", "")
	if _, err := store.UpsertNode(ctx, Node{
		ID: "restartingnode", OwnerType: "fleet", StorageEnabled: true,
		StorageURL: "https://internal.node", StorageSecret: "nodesecret",
		DownloadURL: "https://node7.relayium.com", CreatedAt: 1,
		// Well past nodeOnlineWindow — this is what a node mid-restart looks like.
		LastSeenAt: time.Now().Add(-time.Hour).Unix(),
	}); err != nil {
		t.Fatal(err)
	}
	const fid, bkey = "offfile", "offbkey"
	if err := store.CreateStoredFile(ctx, StoredFile{
		ID: fid, UserID: owner.ID, BlobKey: bkey, EncManifest: []byte("m"), Size: 200,
		NodeID: "restartingnode", CreatedAt: 1, ExpiresAt: time.Now().Add(time.Hour).Unix(),
	}); err != nil {
		t.Fatal(err)
	}

	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Get(ts.URL + "/api/files/" + fid + "/blob")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusFound {
		t.Fatalf("offline node still got a 302 to %q; central must proxy instead",
			resp.Header.Get("Location"))
	}
}
```

（断言写成「不是 302」而非某个具体状态码：中央回退代理后会去抓一个不存在的
`StorageURL`，具体错误码不是本次改动要锁定的行为。）

- [ ] **Step 2: 跑测试确认失败**

```
cd server && go test ./internal/account/ -run TestDirectDownloadSkipsOfflineNode -v
```
预期：FAIL——离线节点仍然拿到了 302

- [ ] **Step 3: 实现**

`server/internal/account/files.go`，把：

```go
		if n, ok, nerr := s.store.GetNode(r.Context(), sf.NodeID); nerr == nil && ok &&
			n.DownloadURL != "" && n.StorageSecret != "" {
			directNode, directCapable = n, true
		}
```

改为：

```go
		// A node that has stopped heartbeating may be restarting (an update) or
		// gone; redirecting there just hands the downloader a dead origin. Fall
		// back to central proxying, which is always correct if slower.
		online := s.now().Add(-nodeOnlineWindow).Unix()
		if n, ok, nerr := s.store.GetNode(r.Context(), sf.NodeID); nerr == nil && ok &&
			n.DownloadURL != "" && n.StorageSecret != "" && n.LastSeenAt >= online {
			directNode, directCapable = n, true
		}
```

- [ ] **Step 4: 跑测试确认通过**

```
cd server && go test ./internal/account/ -run TestDirectDownload -v
```
预期：新增的 PASS，已有的 `TestDirectDownloadRedirectsToNode` 和
`TestByoOwnNodeDirectDownloadIsFree` 也仍然 PASS——它们的 fixture 已经在设
`LastSeenAt: time.Now().Unix()`，本来就是在线的。

若有别的直连测试因此变红，那是它的 fixture 漏设了 `LastSeenAt`，补成在线即可，**不是实现有错**。

- [ ] **Step 5: 跑 account 包全量**

```
cd server && go test ./internal/account/
```
预期：ok

- [ ] **Step 6: 提交**

```bash
git add server/internal/account/files.go server/internal/account/files_direct_online_test.go
git commit -m "fix(download): don't redirect to a node that stopped heartbeating

The direct-download branch only checked that the node advertised a DownloadURL,
so a restarting or dead node still received 302s and the downloader got a 522
through Cloudflare. Require LastSeenAt within nodeOnlineWindow and fall back to
central proxying otherwise."
```

---

### Task 3: selfupdate 支持指定版本与降级

`selfupdate.Update()` 目前写死走 `LatestTag()`。中央下发的是一个**具体版本号**，而且回滚时那个版本比当前版本低——所以需要「装指定 tag」和「显式允许降级」两个能力。

**Files:**
- Modify: `server/internal/selfupdate/selfupdate.go`（`Options` 加两个字段，`Update()` 用上）
- Test: `server/internal/selfupdate/target_tag_test.go`（新建）

**Interfaces:**
- Consumes: 已有的 `Options`、`Update()`、`LatestTag()`、`compareVersions()`
- Produces:
  - `Options.TargetTag string` — 空则沿用「装最新版」的既有行为；非空则装这个 tag。
  - `Options.AllowDowngrade bool` — 为 true 时不因目标版本低于当前版本而拒绝。
  - `Update()` 签名不变：`(ctx context.Context, o Options, progress io.Writer) (from, to string, changed bool, err error)`

- [ ] **Step 1: 给 fakeRelease 加一个「latest 与被请求的 tag 不同」的能力**

现有的 `fakeRelease`（`internal/selfupdate/selfupdate_test.go:82`）用同一个 `f.tag`
既回答 `/releases/latest` 又提供下载资产，因此无法表达「latest 是 v9.9.9，但我要装
v0.8.0」。加一个字段：

在 `fakeRelease` 结构体里加：

```go
	// latestTag, when set, is what /releases/latest reports while the assets
	// stay under tag. Lets a test prove TargetTag wins over "latest".
	latestTag string
```

并把 `server()` 里的 latest 处理器改为：

```go
	mux.HandleFunc("/repos/relayium/relayium/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		latest := f.latestTag
		if latest == "" {
			latest = f.tag
		}
		fmt.Fprintf(w, `{"tag_name":%q}`, latest)
	})
```

跑一遍确认没弄坏现有测试：

```
cd server && go test ./internal/selfupdate/
```
预期：ok

- [ ] **Step 2: 写失败的测试**

新建 `server/internal/selfupdate/target_tag_test.go`：

```go
package selfupdate

import (
	"context"
	"io"
	"os"
	"runtime"
	"testing"
)

// Central hands out an exact version, never "latest". If a node resolved latest
// itself, a release published mid-rollout would leave the fleet on two
// versions — the precise thing a staged rollout exists to prevent.
func TestUpdateInstallsTargetTagNotLatest(t *testing.T) {
	const payload = "BINARY-v0.8.0"
	fr := &fakeRelease{
		tag:       "v0.8.0",
		latestTag: "v9.9.9", // newer release exists; we must NOT take it
		asset:     AssetName(runtime.GOOS, runtime.GOARCH),
		archive:   tarGzWith(t, payload),
	}
	srv := fr.server(t)
	defer srv.Close()
	target := writeTarget(t, "OLD")

	o := baseOpts(srv, target)
	o.CurrentVersion = "v0.7.0"
	o.TargetTag = "v0.8.0"

	from, to, changed, err := Update(context.Background(), o, io.Discard)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if !changed {
		t.Error("changed = false, want true")
	}
	if from != "v0.7.0" {
		t.Errorf("from = %q, want %q", from, "v0.7.0")
	}
	if to != "v0.8.0" {
		t.Errorf("to = %q, want the pinned tag v0.8.0, not latest", to)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != payload {
		t.Errorf("installed binary = %q, want %q", got, payload)
	}
}

// A rollback names a lower version. Without an explicit opt-in that must be
// refused, so nothing can quietly walk a node back to a known-vulnerable build.
func TestUpdateRefusesDowngradeByDefault(t *testing.T) {
	fr := &fakeRelease{
		tag:     "v0.7.0",
		asset:   AssetName(runtime.GOOS, runtime.GOARCH),
		archive: tarGzWith(t, "OLDER-BINARY"),
	}
	srv := fr.server(t)
	defer srv.Close()
	target := writeTarget(t, "CURRENT")

	o := baseOpts(srv, target)
	o.CurrentVersion = "v0.9.0"
	o.TargetTag = "v0.7.0"

	_, _, changed, err := Update(context.Background(), o, io.Discard)
	if err == nil {
		t.Error("Update err = nil for a downgrade, want a refusal")
	}
	if changed {
		t.Error("changed = true, want false")
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "CURRENT" {
		t.Errorf("binary = %q after a refused downgrade, want it untouched", got)
	}
}

func TestUpdateAllowsDowngradeWhenOptedIn(t *testing.T) {
	const payload = "OLDER-BINARY"
	fr := &fakeRelease{
		tag:     "v0.7.0",
		asset:   AssetName(runtime.GOOS, runtime.GOARCH),
		archive: tarGzWith(t, payload),
	}
	srv := fr.server(t)
	defer srv.Close()
	target := writeTarget(t, "CURRENT")

	o := baseOpts(srv, target)
	o.CurrentVersion = "v0.9.0"
	o.TargetTag = "v0.7.0"
	o.AllowDowngrade = true

	_, to, changed, err := Update(context.Background(), o, io.Discard)
	if err != nil {
		t.Fatalf("Update with AllowDowngrade: %v", err)
	}
	if !changed || to != "v0.7.0" {
		t.Errorf("changed=%v to=%q, want true and v0.7.0", changed, to)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != payload {
		t.Errorf("installed binary = %q, want the rollback payload %q", got, payload)
	}
}
```

- [ ] **Step 3: 跑测试确认失败**

```
cd server && go test ./internal/selfupdate/ -run "TargetTag|Downgrade" -v
```
预期：编译失败（`unknown field TargetTag`）

- [ ] **Step 4: 实现**

`Options` 结构体加两个字段：

```go
	// TargetTag pins the exact release to install. Empty means "latest" (the
	// CLI's `relayium update` behaviour). Node rollouts always set it: central
	// hands out an exact version so a release published mid-rollout can't
	// scatter the fleet across two versions.
	TargetTag string
	// AllowDowngrade permits installing a version older than CurrentVersion.
	// Off by default so nothing can walk a node back to a known-vulnerable
	// build; only an explicit rollback sets it.
	AllowDowngrade bool
```

在 `Update()` 里，把解析目标 tag 的那一步从「总是 `LatestTag`」改为：

```go
	tag := o.TargetTag
	if tag == "" {
		var err error
		if tag, err = LatestTag(ctx, o); err != nil {
			return "", "", false, err
		}
	}
```

并在既有的降级判定处（`compareVersions` 的使用点）把拒绝条件加上 `&& !o.AllowDowngrade`。签名校验、sha256 校验、原子替换的代码**一行都不要动**。

- [ ] **Step 5: 跑测试确认通过**

```
cd server && go test ./internal/selfupdate/ -v
```
预期：新增三个 PASS，已有测试（含 `downgrade_test.go`、`signing_test.go`）全 PASS

- [ ] **Step 6: 提交**

```bash
git add server/internal/selfupdate/
git commit -m "feat(selfupdate): install an exact tag and gate downgrades behind a flag

Node rollouts are driven by an exact version from central, not by whatever is
latest at the moment each node polls. Add Options.TargetTag for that, plus
AllowDowngrade so a rollback can install an older build while the default still
refuses to walk a node back to a known-vulnerable version."
```

---

### Task 4: 节点上报健康信号（last-heartbeat）

更新器需要判断「新版本是不是真的活着」。进程活着不够——它可能起来了但连不上中央。判据是**成功心跳过一次**。节点每次心跳成功后 touch 状态目录里的一个文件，更新器看它的 mtime。

**Files:**
- Modify: `server/cmd/relayium-node/relay.go`（`sendHeartbeat` 成功分支）
- Create: `server/cmd/relayium-node/health.go`
- Test: `server/cmd/relayium-node/health_test.go`

**Interfaces:**
- Consumes: `c.StateDir`
- Produces:
  - `func healthFilePath(stateDir string) string` — 返回 `<stateDir>/last-heartbeat`
  - `func markHealthy(stateDir string) error` — touch 该文件（不存在则创建）
  - `func lastHealthy(stateDir string) (time.Time, error)` — 读 mtime；文件不存在返回零值 time 和 nil

- [ ] **Step 1: 写失败的测试**

新建 `server/cmd/relayium-node/health_test.go`：

```go
package main

import (
	"testing"
	"time"
)

func TestLastHealthyIsZeroBeforeAnyHeartbeat(t *testing.T) {
	dir := t.TempDir()
	got, err := lastHealthy(dir)
	if err != nil {
		t.Fatalf("lastHealthy on a fresh dir: %v", err)
	}
	if !got.IsZero() {
		t.Errorf("lastHealthy = %v, want zero time before any heartbeat", got)
	}
}

func TestMarkHealthyRecordsATimeAndAdvancesIt(t *testing.T) {
	dir := t.TempDir()
	if err := markHealthy(dir); err != nil {
		t.Fatalf("markHealthy: %v", err)
	}
	first, err := lastHealthy(dir)
	if err != nil {
		t.Fatalf("lastHealthy: %v", err)
	}
	if first.IsZero() {
		t.Fatal("lastHealthy is zero right after markHealthy")
	}

	// The updater compares this against the moment it restarted the node, so a
	// second heartbeat must move the timestamp forward, not just recreate it.
	time.Sleep(10 * time.Millisecond)
	if err := markHealthy(dir); err != nil {
		t.Fatalf("second markHealthy: %v", err)
	}
	second, err := lastHealthy(dir)
	if err != nil {
		t.Fatalf("second lastHealthy: %v", err)
	}
	if !second.After(first) {
		t.Errorf("second markHealthy left mtime at %v (first was %v), want it to advance", second, first)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

```
cd server && go test ./cmd/relayium-node/ -run "Healthy" -v
```
预期：编译失败，`undefined: lastHealthy`

- [ ] **Step 3: 实现**

新建 `server/cmd/relayium-node/health.go`：

```go
package main

import (
	"os"
	"path/filepath"
	"time"
)

// healthFile is touched after every successful heartbeat. The updater reads its
// mtime to decide whether a freshly-installed version is actually working:
// "the process is running" is not enough — a binary can start fine and still
// fail to reach central, which is exactly the failure a rollout must catch.
const healthFile = "last-heartbeat"

func healthFilePath(stateDir string) string {
	return filepath.Join(stateDir, healthFile)
}

// markHealthy records that a heartbeat just succeeded.
func markHealthy(stateDir string) error {
	p := healthFilePath(stateDir)
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if cerr := f.Close(); cerr != nil {
		return cerr
	}
	now := time.Now()
	return os.Chtimes(p, now, now)
}

// lastHealthy returns the time of the last successful heartbeat. A missing file
// means "never" and is not an error — a node that has not heartbeated yet is a
// normal state, not a failure.
func lastHealthy(stateDir string) (time.Time, error) {
	fi, err := os.Stat(healthFilePath(stateDir))
	if os.IsNotExist(err) {
		return time.Time{}, nil
	}
	if err != nil {
		return time.Time{}, err
	}
	return fi.ModTime(), nil
}
```

- [ ] **Step 4: 跑测试确认通过**

```
cd server && go test ./cmd/relayium-node/ -run "Healthy" -v
```
预期：两个 PASS

- [ ] **Step 5: 在心跳成功后调用**

`sendHeartbeat` 目前的签名是：

```go
func sendHeartbeat(rp *reporter, nodeID string, reg *allocRegistry, storageDir string, blobGauge *blobUsage, lim *limits)
```

它已经收了 `storageDir`，但我们需要的是 `stateDir`。加一个参数（放在 `storageDir` 之后）：

```go
func sendHeartbeat(rp *reporter, nodeID string, reg *allocRegistry, storageDir, stateDir string, blobGauge *blobUsage, lim *limits)
```

在函数体内，心跳 POST 成功（没有 error）的那个分支末尾加：

```go
	// Record the success so the updater can tell a working new version from one
	// that starts but can't reach central.
	if err := markHealthy(stateDir); err != nil {
		log.Printf("relayium-node: record heartbeat health: %v", err)
	}
```

在 `run()` 的调用点补上实参：

```go
			sendHeartbeat(rp, nodeID, reg, c.StorageDir, c.StateDir, blobGauge, lim)
```

- [ ] **Step 6: 跑全量测试**

```
cd server && go test ./cmd/relayium-node/
```
预期：ok（若已有测试调用了 `sendHeartbeat`，按新签名补参数）

- [ ] **Step 7: 提交**

```bash
git add server/cmd/relayium-node/
git commit -m "feat(node): record a health marker after each successful heartbeat

The updater needs to distinguish a working new version from one that starts but
can't reach central. Touch <stateDir>/last-heartbeat on every heartbeat success
so the updater can compare its mtime against the restart it just performed."
```

---

### Task 5: update 子命令骨架

节点二进制目前没有子命令——`main()` 直接 `parseConfig()` 然后 `run()`。加一个子命令分发，使 `relayium-node update` 走另一条路径。

**Files:**
- Modify: `server/cmd/relayium-node/main.go`（`main()` 加分发）
- Create: `server/cmd/relayium-node/update.go`
- Test: `server/cmd/relayium-node/update_test.go`

**Interfaces:**
- Consumes: `env()`、`loadState()`
- Produces:
  - `type updateConfig struct { StateDir, BinPath, TargetTag string; AllowDowngrade bool; Repo string }`
  - `func parseUpdateFlags(args []string, stderr io.Writer) (updateConfig, error)`
  - `func runUpdate(uc updateConfig, stdout, stderr io.Writer) int` — 返回进程退出码

- [ ] **Step 1: 写失败的测试**

新建 `server/cmd/relayium-node/update_test.go`：

```go
package main

import (
	"bytes"
	"testing"
)

func TestParseUpdateFlagsRequiresTargetTag(t *testing.T) {
	var errBuf bytes.Buffer
	// Part 1 drives updates by hand; part 2 supplies -to from central. Either
	// way an update without an explicit target is a bug, never "just take
	// latest" — that is how a fleet scatters across versions.
	if _, err := parseUpdateFlags(nil, &errBuf); err == nil {
		t.Error("parseUpdateFlags with no -to returned nil error, want a failure")
	}
}

func TestParseUpdateFlagsReadsTargetAndDowngrade(t *testing.T) {
	var errBuf bytes.Buffer
	uc, err := parseUpdateFlags([]string{"-to", "v0.7.0", "-allow-downgrade"}, &errBuf)
	if err != nil {
		t.Fatalf("parseUpdateFlags: %v (stderr=%s)", err, errBuf.String())
	}
	if uc.TargetTag != "v0.7.0" {
		t.Errorf("TargetTag = %q, want %q", uc.TargetTag, "v0.7.0")
	}
	if !uc.AllowDowngrade {
		t.Error("AllowDowngrade = false, want true")
	}
}

func TestParseUpdateFlagsDefaultsStateDir(t *testing.T) {
	var errBuf bytes.Buffer
	uc, err := parseUpdateFlags([]string{"-to", "v0.9.0"}, &errBuf)
	if err != nil {
		t.Fatalf("parseUpdateFlags: %v", err)
	}
	if uc.StateDir != "/var/lib/relayium-node" {
		t.Errorf("StateDir = %q, want the same default run() uses", uc.StateDir)
	}
	if uc.AllowDowngrade {
		t.Error("AllowDowngrade defaults to true, want false — downgrades must be opt-in")
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

```
cd server && go test ./cmd/relayium-node/ -run ParseUpdateFlags -v
```
预期：编译失败，`undefined: parseUpdateFlags`

- [ ] **Step 3: 实现**

新建 `server/cmd/relayium-node/update.go`：

```go
package main

import (
	"errors"
	"flag"
	"io"
	"os"
)

// updateRepo is the GitHub repo node updates are pulled from. Same repo as the
// CLI; the node ships in its own archive (see .goreleaser.yaml).
const updateRepo = "relayium/relayium"

// defaultBinPath is where install-node.sh puts the binary.
const defaultBinPath = "/usr/local/bin/relayium-node"

type updateConfig struct {
	StateDir       string
	BinPath        string
	TargetTag      string
	AllowDowngrade bool
	Repo           string
}

// parseUpdateFlags parses `relayium-node update` arguments. The target version
// is always explicit: this command never resolves "latest" on its own, because
// a rollout that raced a new release would leave the fleet on two versions.
func parseUpdateFlags(args []string, stderr io.Writer) (updateConfig, error) {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	fs.SetOutput(stderr)
	uc := updateConfig{Repo: updateRepo}
	fs.StringVar(&uc.StateDir, "state-dir", env("RELAYIUM_NODE_STATE_DIR", "/var/lib/relayium-node"), "directory holding state.json")
	fs.StringVar(&uc.BinPath, "bin", env("RELAYIUM_NODE_BIN", defaultBinPath), "path of the binary to replace")
	fs.StringVar(&uc.TargetTag, "to", "", "exact release tag to install, e.g. v0.9.0 (required)")
	fs.BoolVar(&uc.AllowDowngrade, "allow-downgrade", false, "permit installing a version older than the running one")
	if err := fs.Parse(args); err != nil {
		return uc, err
	}
	if uc.TargetTag == "" {
		return uc, errors.New("relayium-node update: -to <version> is required")
	}
	return uc, nil
}

// runUpdate is the entry point for the update subcommand. Implemented across
// tasks 6-8; this task only wires the command up.
func runUpdate(uc updateConfig, stdout, stderr io.Writer) int {
	_ = os.Getpid
	return 0
}
```

在 `server/cmd/relayium-node/main.go` 的 `main()` 开头加分发：

```go
func main() {
	// Subcommand dispatch. The node proper runs sandboxed and unprivileged and
	// can never modify binaries; `update` is a separate, root-run entry point.
	if len(os.Args) > 1 && os.Args[1] == "update" {
		uc, err := parseUpdateFlags(os.Args[2:], os.Stderr)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		os.Exit(runUpdate(uc, os.Stdout, os.Stderr))
	}

	c, err := parseConfig()
	...
```

- [ ] **Step 4: 跑测试确认通过**

```
cd server && go test ./cmd/relayium-node/ -run ParseUpdateFlags -v
```
预期：三个 PASS

- [ ] **Step 5: 手动确认分发生效**

```
cd server && go run ./cmd/relayium-node update
```
预期：打印 `relayium-node update: -to <version> is required`，退出码 2

- [ ] **Step 6: 提交**

```bash
git add server/cmd/relayium-node/main.go server/cmd/relayium-node/update.go server/cmd/relayium-node/update_test.go
git commit -m "feat(node): add an update subcommand skeleton

The node proper runs sandboxed and unprivileged and can never modify binaries,
so updates need a separate root-run entry point. Dispatch \`relayium-node
update\` before the normal config parse. The target version is always explicit —
this command never resolves 'latest' itself."
```

---

### Task 6: 备份与替换

更新器换二进制之前先把旧的存下来，这是本地自救的前提。

**Files:**
- Modify: `server/cmd/relayium-node/update.go`
- Test: `server/cmd/relayium-node/update_backup_test.go`

**Interfaces:**
- Consumes: `updateConfig`
- Produces:
  - `func backupPath(binPath string) string` — 返回 `<binPath>.prev`
  - `func backupBinary(binPath string) error` — 复制并保留权限位
  - `func restoreBinary(binPath string) error` — 用 `.prev` 覆盖回去（原子 rename）

- [ ] **Step 1: 写失败的测试**

新建 `server/cmd/relayium-node/update_backup_test.go`：

```go
package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBackupAndRestoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "relayium-node")
	if err := os.WriteFile(bin, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := backupBinary(bin); err != nil {
		t.Fatalf("backupBinary: %v", err)
	}
	if _, err := os.Stat(backupPath(bin)); err != nil {
		t.Fatalf("backup not created: %v", err)
	}

	// Simulate a successful replace that turns out to be broken.
	if err := os.WriteFile(bin, []byte("NEW-BROKEN"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := restoreBinary(bin); err != nil {
		t.Fatalf("restoreBinary: %v", err)
	}

	got, err := os.ReadFile(bin)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "OLD" {
		t.Errorf("after restore, binary = %q, want %q", got, "OLD")
	}
}

// The restored binary has to stay executable or the node never comes back —
// which is the exact situation restore exists to fix.
func TestBackupPreservesExecutableBit(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "relayium-node")
	if err := os.WriteFile(bin, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := backupBinary(bin); err != nil {
		t.Fatalf("backupBinary: %v", err)
	}
	fi, err := os.Stat(backupPath(bin))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm()&0o111 == 0 {
		t.Errorf("backup mode = %v, want the executable bit set", fi.Mode().Perm())
	}
}

func TestRestoreWithoutBackupFails(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "relayium-node")
	if err := os.WriteFile(bin, []byte("NEW"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := restoreBinary(bin); err == nil {
		t.Error("restoreBinary with no .prev returned nil, want an error")
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

```
cd server && go test ./cmd/relayium-node/ -run "Backup|Restore" -v
```
预期：编译失败，`undefined: backupBinary`

- [ ] **Step 3: 实现**

在 `server/cmd/relayium-node/update.go` 追加：

```go
// backupPath is where the pre-update binary is kept so a broken new version can
// be undone locally. It lives next to the binary, owned by root and outside the
// node sandbox's writable paths — a compromised node cannot touch it.
func backupPath(binPath string) string { return binPath + ".prev" }

// backupBinary copies the current binary aside, preserving its mode. This is
// the precondition for the local self-rescue in task 7: central cannot roll
// back a node that never comes up, because such a node never asks central
// anything.
func backupBinary(binPath string) error {
	src, err := os.Open(binPath)
	if err != nil {
		return err
	}
	defer src.Close()
	fi, err := src.Stat()
	if err != nil {
		return err
	}
	tmp := backupPath(binPath) + ".tmp"
	dst, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, fi.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		os.Remove(tmp)
		return err
	}
	if err := dst.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	// Rename last so a crash mid-copy never leaves a truncated "backup" that
	// would be restored over a working binary.
	return os.Rename(tmp, backupPath(binPath))
}

// restoreBinary puts the backed-up binary back. Rename is atomic, so a crash
// here leaves either the new or the old binary in place — never a partial one.
func restoreBinary(binPath string) error {
	prev := backupPath(binPath)
	if _, err := os.Stat(prev); err != nil {
		return fmt.Errorf("no backup to restore at %s: %w", prev, err)
	}
	return os.Rename(prev, binPath)
}
```

在 `update.go` 的 import 里补 `"fmt"` 和 `"io"`（`io` 已有）。

- [ ] **Step 4: 跑测试确认通过**

```
cd server && go test ./cmd/relayium-node/ -run "Backup|Restore" -v
```
预期：三个 PASS

- [ ] **Step 5: 提交**

```bash
git add server/cmd/relayium-node/update.go server/cmd/relayium-node/update_backup_test.go
git commit -m "feat(node): back up the binary before replacing it

Central can't roll back a node that never comes up, because such a node never
asks central anything. Keeping the previous binary next to the new one is the
precondition for the local self-rescue. Rename last so a crash mid-copy can't
leave a truncated backup that would later be restored over a working binary."
```

---

### Task 7: 健康守护与自救回滚

更新器的核心：替换 → 重启 → 守 10 分钟 → 不健康就换回去。

**Files:**
- Modify: `server/cmd/relayium-node/update.go`
- Test: `server/cmd/relayium-node/update_watchdog_test.go`

**Interfaces:**
- Consumes: `lastHealthy()`（Task 4）、`backupBinary()` / `restoreBinary()`（Task 6）
- Produces:
  - `type serviceCtl interface { Restart() error }` — 让测试能替掉 systemctl
  - `type systemctlCtl struct{ Unit string }`，实现 `Restart()`
  - `func waitHealthy(stateDir string, since time.Time, timeout, poll time.Duration) bool` — 在 timeout 内出现晚于 `since` 的心跳则 true

- [ ] **Step 1: 写失败的测试**

新建 `server/cmd/relayium-node/update_watchdog_test.go`：

```go
package main

import (
	"testing"
	"time"
)

func TestWaitHealthyReturnsTrueWhenHeartbeatArrives(t *testing.T) {
	dir := t.TempDir()
	since := time.Now()

	go func() {
		time.Sleep(30 * time.Millisecond)
		_ = markHealthy(dir)
	}()

	if !waitHealthy(dir, since, 2*time.Second, 5*time.Millisecond) {
		t.Error("waitHealthy = false, want true once a heartbeat lands after `since`")
	}
}

func TestWaitHealthyTimesOutWhenNodeNeverComesBack(t *testing.T) {
	dir := t.TempDir()
	since := time.Now()

	start := time.Now()
	if waitHealthy(dir, since, 100*time.Millisecond, 5*time.Millisecond) {
		t.Error("waitHealthy = true, want false when no heartbeat ever lands")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Errorf("waitHealthy blocked %v, want it to give up near the 100ms timeout", elapsed)
	}
}

// A heartbeat written by the OLD version before the restart must not be
// mistaken for the new version working. This is the bug that would make the
// self-rescue useless.
func TestWaitHealthyIgnoresHeartbeatFromBeforeRestart(t *testing.T) {
	dir := t.TempDir()
	if err := markHealthy(dir); err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Millisecond)
	since := time.Now() // the restart happens here

	if waitHealthy(dir, since, 100*time.Millisecond, 5*time.Millisecond) {
		t.Error("waitHealthy = true using a pre-restart heartbeat, want false")
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

```
cd server && go test ./cmd/relayium-node/ -run WaitHealthy -v
```
预期：编译失败，`undefined: waitHealthy`

- [ ] **Step 3: 实现**

在 `server/cmd/relayium-node/update.go` 追加：

```go
// serviceCtl restarts the node service. An interface so tests don't shell out.
type serviceCtl interface{ Restart() error }

type systemctlCtl struct{ Unit string }

func (s systemctlCtl) Restart() error {
	cmd := exec.Command("systemctl", "restart", s.Unit)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl restart %s: %w (%s)", s.Unit, err, bytes.TrimSpace(out))
	}
	return nil
}

// waitHealthy reports whether the node produced a successful heartbeat AFTER
// `since` within timeout. Comparing against `since` (the restart moment) is the
// whole point: a heartbeat left behind by the previous version must never be
// read as the new one working.
func waitHealthy(stateDir string, since time.Time, timeout, poll time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if ts, err := lastHealthy(stateDir); err == nil && ts.After(since) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(poll)
	}
}
```

import 补 `"bytes"`、`"os/exec"`、`"time"`。

- [ ] **Step 4: 跑测试确认通过**

```
cd server && go test ./cmd/relayium-node/ -run WaitHealthy -v
```
预期：三个 PASS

- [ ] **Step 5: 串起完整的 runUpdate**

把 `update.go` 里的占位 `runUpdate` 替换为：

```go
// healthWindow is how long the updater waits for the new version to prove
// itself by completing one heartbeat.
const healthWindow = 10 * time.Minute

// nodeUnit is the systemd unit install-node.sh creates.
const nodeUnit = "relayium-node"

func runUpdate(uc updateConfig, stdout, stderr io.Writer) int {
	return runUpdateWith(uc, systemctlCtl{Unit: nodeUnit}, healthWindow, 2*time.Second, stdout, stderr)
}

// runUpdateWith is runUpdate with its side-effecting dependencies injected so
// the rollback path can be tested without systemd.
func runUpdateWith(uc updateConfig, svc serviceCtl, window, poll time.Duration, stdout, stderr io.Writer) int {
	if failedBefore(uc.StateDir, uc.TargetTag) {
		fmt.Fprintf(stderr, "refusing to retry %s: it already failed on this node\n", uc.TargetTag)
		return 1
	}
	if err := backupBinary(uc.BinPath); err != nil {
		fmt.Fprintf(stderr, "backup failed, not touching the binary: %v\n", err)
		return 1
	}

	from, to, changed, err := selfupdate.Update(context.Background(), selfupdate.Options{
		Repo:           uc.Repo,
		CurrentVersion: version,
		GOOS:           runtime.GOOS,
		GOARCH:         runtime.GOARCH,
		TargetPath:     uc.BinPath,
		TargetTag:      uc.TargetTag,
		AllowDowngrade: uc.AllowDowngrade,
	}, stdout)
	if err != nil {
		// Verification or download failed — the live binary was never touched.
		fmt.Fprintf(stderr, "update to %s failed, binary untouched: %v\n", uc.TargetTag, err)
		return 1
	}
	if !changed {
		fmt.Fprintf(stdout, "already on %s, nothing to do\n", to)
		return 0
	}

	restartedAt := time.Now()
	if err := svc.Restart(); err != nil {
		fmt.Fprintf(stderr, "restart failed: %v — rolling back\n", err)
		rollback(uc, svc, stderr)
		return 1
	}

	if !waitHealthy(uc.StateDir, restartedAt, window, poll) {
		fmt.Fprintf(stderr, "%s did not heartbeat within %s — rolling back to %s\n", to, window, from)
		rollback(uc, svc, stderr)
		recordFailed(uc.StateDir, uc.TargetTag, stderr)
		return 1
	}

	fmt.Fprintf(stdout, "updated %s -> %s and confirmed healthy\n", from, to)
	os.Remove(backupPath(uc.BinPath))
	return 0
}

// rollback restores the previous binary and restarts. Best-effort and loud:
// if this fails the node is down and needs a human.
func rollback(uc updateConfig, svc serviceCtl, stderr io.Writer) {
	if err := restoreBinary(uc.BinPath); err != nil {
		fmt.Fprintf(stderr, "CRITICAL: rollback failed, node is likely down: %v\n", err)
		return
	}
	if err := svc.Restart(); err != nil {
		fmt.Fprintf(stderr, "CRITICAL: restart after rollback failed: %v\n", err)
	}
}
```

import 补 `"context"`、`"runtime"`，以及 `"github.com/relayium/relayium/internal/selfupdate"`。

`failedBefore` / `recordFailed` 在 Task 8 实现——**本步骤先加两个临时定义**放在 `update.go` 末尾，Task 8 会替换掉：

```go
func failedBefore(stateDir, tag string) bool          { return false }
func recordFailed(stateDir, tag string, w io.Writer)  {}
```

- [ ] **Step 6: 写回滚路径的测试**

在 `update_watchdog_test.go` 追加：

```go
type fakeSvc struct{ restarts int; failRestart bool }

func (f *fakeSvc) Restart() error {
	f.restarts++
	if f.failRestart {
		return errTestRestart
	}
	return nil
}

var errTestRestart = errors.New("restart refused")

// The whole point of the local self-rescue: a version that installs fine but
// never heartbeats gets undone without central's involvement.
func TestRunUpdateRollsBackWhenNewVersionNeverHeartbeats(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "relayium-node")
	if err := os.WriteFile(bin, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Pre-create the backup and a "new" binary to stand in for a completed
	// selfupdate, then drive only the watchdog half via rollback().
	if err := backupBinary(bin); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, []byte("NEW-BROKEN"), 0o755); err != nil {
		t.Fatal(err)
	}

	svc := &fakeSvc{}
	var errBuf bytes.Buffer
	rollback(updateConfig{BinPath: bin, StateDir: dir}, svc, &errBuf)

	got, err := os.ReadFile(bin)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "OLD" {
		t.Errorf("after rollback, binary = %q, want the previous %q", got, "OLD")
	}
	if svc.restarts != 1 {
		t.Errorf("restarts = %d, want 1 (the node must be restarted onto the old binary)", svc.restarts)
	}
}
```

import 补 `"bytes"`、`"errors"`、`"os"`、`"path/filepath"`。

- [ ] **Step 7: 跑测试确认通过**

```
cd server && go test ./cmd/relayium-node/ -v -run "WaitHealthy|RunUpdate"
```
预期：全 PASS

- [ ] **Step 8: 提交**

```bash
git add server/cmd/relayium-node/update.go server/cmd/relayium-node/update_watchdog_test.go
git commit -m "feat(node): roll back locally when a new version never heartbeats

Central-driven rollback has a blind spot: a node that won't start never
receives the rollback order, because it never asks. So the updater closes the
loop locally — restart, wait for one heartbeat newer than the restart, and
restore the previous binary if none arrives. Comparing against the restart
moment matters: a heartbeat left by the old version must not read as success."
```

---

### Task 8: 防撞墙（failed-version）

自救回滚之后，下一次触发不能再去装同一个坏版本，否则节点会陷入「装→炸→回滚→装」的循环。

**Files:**
- Modify: `server/cmd/relayium-node/update.go`（替换 Task 7 的两个临时定义）
- Test: `server/cmd/relayium-node/update_failed_test.go`

**Interfaces:**
- Consumes: `updateConfig.StateDir`
- Produces:
  - `func recordFailed(stateDir, tag string, w io.Writer)` — 把 tag 追加进 `<stateDir>/failed-versions`
  - `func failedBefore(stateDir, tag string) bool` — 该 tag 是否已被记为失败

- [ ] **Step 1: 写失败的测试**

新建 `server/cmd/relayium-node/update_failed_test.go`：

```go
package main

import (
	"bytes"
	"testing"
)

func TestFailedBeforeIsFalseOnAFreshNode(t *testing.T) {
	if failedBefore(t.TempDir(), "v0.9.0") {
		t.Error("failedBefore = true on a fresh node, want false")
	}
}

// Without this the node loops forever: install the bad version, roll back, get
// told to install it again on the next tick.
func TestRecordFailedStopsARetryOfTheSameVersion(t *testing.T) {
	dir := t.TempDir()
	var w bytes.Buffer
	recordFailed(dir, "v0.9.0", &w)

	if !failedBefore(dir, "v0.9.0") {
		t.Error("failedBefore = false for a version already recorded as failed, want true")
	}
}

// A later good release must still install — the block is per version, not a
// permanent freeze of the node.
func TestRecordFailedDoesNotBlockOtherVersions(t *testing.T) {
	dir := t.TempDir()
	var w bytes.Buffer
	recordFailed(dir, "v0.9.0", &w)

	if failedBefore(dir, "v0.9.1") {
		t.Error("failedBefore = true for a different version, want false")
	}
}

// A prefix must not be mistaken for a match: v0.9.0 failing must not block
// v0.9.0-hotfix or v0.9.01.
func TestFailedBeforeMatchesWholeVersionsOnly(t *testing.T) {
	dir := t.TempDir()
	var w bytes.Buffer
	recordFailed(dir, "v0.9.0", &w)

	if failedBefore(dir, "v0.9.01") {
		t.Error("failedBefore matched a prefix, want whole-line matching only")
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

```
cd server && go test ./cmd/relayium-node/ -run "Failed" -v
```
预期：`TestRecordFailedStopsARetry...` FAIL（Task 7 的临时实现永远返回 false）

- [ ] **Step 3: 实现**

在 `server/cmd/relayium-node/update.go` 里删掉 Task 7 的两个临时定义，换成：

```go
// failedVersionsFile lists releases that already broke this node. Without it a
// node that rolls back would be told to install the same bad version on the
// next tick, forever.
const failedVersionsFile = "failed-versions"

func recordFailed(stateDir, tag string, w io.Writer) {
	p := filepath.Join(stateDir, failedVersionsFile)
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		fmt.Fprintf(w, "could not record failed version %s: %v\n", tag, err)
		return
	}
	defer f.Close()
	if _, err := fmt.Fprintln(f, tag); err != nil {
		fmt.Fprintf(w, "could not record failed version %s: %v\n", tag, err)
	}
}

// failedBefore reports whether tag already failed on this node. Matching is
// whole-line so v0.9.0 failing never blocks v0.9.01.
func failedBefore(stateDir, tag string) bool {
	b, err := os.ReadFile(filepath.Join(stateDir, failedVersionsFile))
	if err != nil {
		return false // no record (or unreadable) means nothing is known to have failed
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.TrimSpace(line) == tag {
			return true
		}
	}
	return false
}
```

import 补 `"path/filepath"`、`"strings"`。

- [ ] **Step 4: 跑测试确认通过**

```
cd server && go test ./cmd/relayium-node/ -run "Failed" -v
```
预期：四个 PASS

- [ ] **Step 5: 跑全量**

```
cd server && go build ./... && go vet ./cmd/relayium-node/ && go test ./...
```
预期：全 ok

- [ ] **Step 6: 提交**

```bash
git add server/cmd/relayium-node/update.go server/cmd/relayium-node/update_failed_test.go
git commit -m "feat(node): never retry a release that already broke this node

After a self-rescue rollback the next tick would be handed the same bad version
again, looping install -> crash -> roll back forever. Record failures per
version in the state dir and refuse to reinstall them; matching is whole-line
so v0.9.0 failing doesn't block v0.9.01."
```

---

## 本计划的交付物

完成后，一台节点上可以执行：

```sh
sudo relayium-node update -to v0.9.0
```

它会：验签下载 → 备份旧二进制 → 原子替换 → 重启 → 守 10 分钟确认新版本真的能心跳 →
不行就自动换回旧的并记下这个版本不再重试。同时升级过程中在途的下载和中继会被排空而
不是掐断，中央也不会再把下载者重定向到正在重启的节点。

这已经比今天「SSH 登进去手动换二进制」安全得多，且**不依赖第 2 部分**。

## 第 2 部分预告（不在本计划内）

中央串行队列、`/api/nodes/update-check` 端点、systemd timer、admin UI、
`RELAYIUM_NODE_AUTO_UPDATE` 开关——即把 `-to` 从人手输入换成中央下发。
