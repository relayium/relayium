# 节点自动更新 · 第 2 部分：中央滚动队列 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**前置：第 1 部分（`2026-07-22-node-update-part1-node-side.md`）必须已合并。** 本计划把
`relayium-node update -to <版本>` 里那个人手输入的版本，换成中央下发。

**Goal:** 中央按严格串行（机队）/ 按比例分批（BYO）两条**互不阻塞**的轨道，自动把机队和用户节点滚动到目标版本，任一环节出问题就停住并告警。

**Architecture:** 两行 `node_rollout` 状态（`fleet` / `byo` 轨），一个纯函数状态机决定「此刻谁该更新」，一个 node-token 鉴权的端点让更新器来问，一个 systemd timer 让它定期问。状态机是纯函数 + 注入时钟，全部可表驱动测试，不需要真的等 6 小时。

**Tech Stack:** Go（stdlib）、SQLite/Postgres（沿用现有 store 抽象）、systemd timer、Go html/template（admin）。

## Global Constraints

- 依据 spec：`docs/superpowers/specs/2026-07-22-node-auto-update-design.md` 第 6 节
- **BYO 轨永远不能阻塞机队轨。** 两条轨道的 `status` 互不影响；唯一耦合是单向门禁：BYO 轨的 `target_version` 只能设为机队轨已 `complete` 的版本。
- 机队轨：严格一次一台。首台 = 当前在途传输最少者，观察 **6h**；其余按 `hash(nodeID+targetVersion)` 排序，每台 **30min**。
- BYO 轨：10% → 6h → 50% → 6h → 100%。停止条件是**失败率** > 20% 且失败数 ≥ 2（单台失败不停队列）。
- 时间与随机全部注入，测试不得 `time.Sleep` 等待状态推进。
- Go 注释英语，commit message 英语，文档中文。

---

### Task 1: 滚动状态的持久化

**Files:**
- Modify: `server/internal/account/store.go`（或该包内定义 store 接口处——先 grep 确认）
- Modify: 迁移文件（先 `ls server/internal/account/` 找到现有迁移的组织方式，照做）
- Create: `server/internal/account/rollout_store.go`
- Test: `server/internal/account/rollout_store_test.go`

**Interfaces:**
- Produces:
  ```go
  type RolloutTrack struct {
      Track          string // "fleet" | "byo"
      TargetVersion  string
      CurrentNodeID  string // fleet track only
      ByoBatch       int    // byo track only: 10 | 50 | 100
      StageStartedAt int64
      Status         string // "rolling" | "halted" | "complete"
      HaltedReason   string
  }
  // on Store:
  GetRolloutTrack(ctx context.Context, track string) (RolloutTrack, bool, error)
  PutRolloutTrack(ctx context.Context, t RolloutTrack) error
  ```
- 节点表新增列：`update_started_at INTEGER`、`update_from_version TEXT`、`update_result TEXT`，并在 `Node` 结构体上加对应字段。

- [ ] **Step 1: 摸清现有 store 与迁移的写法**

```
cd server && ls internal/account/ | grep -i "store\|migrat\|schema"
```
读其中的建表/迁移代码，**照现有模式**加表和列。不要引入新的迁移框架。

- [ ] **Step 2: 写失败的测试**

新建 `server/internal/account/rollout_store_test.go`。用该包现有测试构造 store 的方式
（读一个现有的 `*_test.go` 看它怎么起 store），写：

```go
package account

import (
	"context"
	"testing"
)

func TestRolloutTrackRoundTrips(t *testing.T) {
	store := newTestStore(t) // ← 换成该包实际的测试 store 构造函数
	ctx := context.Background()

	if _, ok, err := store.GetRolloutTrack(ctx, "fleet"); err != nil || ok {
		t.Fatalf("fresh DB: got ok=%v err=%v, want ok=false err=nil", ok, err)
	}

	want := RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", CurrentNodeID: "node7",
		StageStartedAt: 1000, Status: "rolling",
	}
	if err := store.PutRolloutTrack(ctx, want); err != nil {
		t.Fatalf("PutRolloutTrack: %v", err)
	}
	got, ok, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil || !ok {
		t.Fatalf("GetRolloutTrack: ok=%v err=%v", ok, err)
	}
	if got != want {
		t.Errorf("round trip = %+v, want %+v", got, want)
	}
}

// The two tracks are independent state: a halted BYO track must never be
// readable as, or writable through, the fleet track.
func TestRolloutTracksAreIndependent(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v0.8.0", Status: "halted", HaltedReason: "failure rate 30%",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
	}); err != nil {
		t.Fatal(err)
	}

	fleet, _, _ := store.GetRolloutTrack(ctx, "fleet")
	byo, _, _ := store.GetRolloutTrack(ctx, "byo")
	if fleet.Status != "rolling" {
		t.Errorf("fleet status = %q, want rolling — a halted BYO track must not affect it", fleet.Status)
	}
	if byo.Status != "halted" {
		t.Errorf("byo status = %q, want halted", byo.Status)
	}
	if fleet.TargetVersion == byo.TargetVersion {
		t.Error("tracks share a target version; they must hold separate ones")
	}
}
```

- [ ] **Step 3: 跑测试确认失败**

```
cd server && go test ./internal/account/ -run Rollout -v
```
预期：编译失败，`undefined: RolloutTrack`

- [ ] **Step 4: 实现建表 + 读写**

照 Step 1 摸清的模式，加 `node_rollout` 表（主键 `track`）和 `nodes` 表的三个新列，
实现 `GetRolloutTrack` / `PutRolloutTrack`（upsert）。

- [ ] **Step 5: 跑测试确认通过**

```
cd server && go test ./internal/account/ -run Rollout -v
```
预期：两个 PASS

- [ ] **Step 6: 提交**

```bash
git add server/internal/account/
git commit -m "feat(rollout): persist per-track rollout state

Two independent rows, fleet and byo, so a stalled user-node rollout can never
block the next fleet release. Adds the per-node update bookkeeping columns the
state machine reads."
```

---

### Task 2: 机队轨状态机（纯函数）

这是整个第 2 部分的核心。做成纯函数：给它当前轨道状态 + 节点快照 + 当前时间，它返回
「下一步该做什么」。这样 6 小时的观察窗口在测试里是一个整数，不是一次真的等待。

**Files:**
- Create: `server/internal/account/rollout_fleet.go`
- Test: `server/internal/account/rollout_fleet_test.go`

**Interfaces:**
- Produces:
  ```go
  // NodeSnapshot is what the state machine needs to know about one node.
  type NodeSnapshot struct {
      ID             string
      Version        string
      LastSeenAt     int64
      ActiveTransfers int
      UpdateStartedAt int64
      UpdateResult    string // "" | "ok" | "failed" | "rolled_back" | "skipped"
  }

  type RolloutDecision struct {
      Action   string // "wait" | "update" | "halt" | "complete"
      NodeID   string // set when Action == "update"
      Reason   string // set when Action == "halt"
  }

  func decideFleet(tr RolloutTrack, nodes []NodeSnapshot, now int64) RolloutDecision
  ```
- 常量：`fleetFirstWindow = 6 * 3600`、`fleetStepWindow = 30 * 60`、`updateSilenceLimit = 15 * 60`、`nodeOnlineWindow`（复用已有的）

- [ ] **Step 1: 写失败的测试**

新建 `server/internal/account/rollout_fleet_test.go`：

```go
package account

import "testing"

const (
	tNow  = int64(1_000_000)
	tHour = int64(3600)
)

func node(id, ver string, seen int64) NodeSnapshot {
	return NodeSnapshot{ID: id, Version: ver, LastSeenAt: seen}
}

func TestDecideFleet(t *testing.T) {
	tests := []struct {
		name   string
		track  RolloutTrack
		nodes  []NodeSnapshot
		want   RolloutDecision
	}{
		{
			// The first node exposed to a new version should be the one with the
			// least to lose.
			name:  "first pick is the node with fewest active transfers",
			track: RolloutTrack{Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling"},
			nodes: []NodeSnapshot{
				{ID: "busy", Version: "v0.8.0", LastSeenAt: tNow, ActiveTransfers: 9},
				{ID: "idle", Version: "v0.8.0", LastSeenAt: tNow, ActiveTransfers: 0},
			},
			want: RolloutDecision{Action: "update", NodeID: "idle"},
		},
		{
			// Strict serial: while one node is mid-update nothing else moves.
			name: "waits while the current node is still updating",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n1", StageStartedAt: tNow - 60,
			},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow, UpdateStartedAt: tNow - 60},
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "wait"},
		},
		{
			// 6h observation for the first node — a version that dies after an
			// hour of real traffic must not reach the rest of the fleet.
			name: "waits out the 6h first-node window even when healthy",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n1", StageStartedAt: tNow - 2*tHour,
			},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok", UpdateStartedAt: tNow - 2*tHour},
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "wait"},
		},
		{
			name: "advances to the next node after the 6h window",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n1", StageStartedAt: tNow - 7*tHour,
			},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok", UpdateStartedAt: tNow - 7*tHour},
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "update", NodeID: "n2"},
		},
		{
			// One failure stops the fleet queue dead — 16 nodes are all ours and
			// one breaking is a signal, not noise.
			name: "halts when the current node rolled back",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n1", StageStartedAt: tNow - tHour,
			},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow, UpdateResult: "rolled_back", UpdateStartedAt: tNow - tHour},
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "halt", Reason: "node n1 rolled back"},
		},
		{
			// A node that went dark after being told to update is the worst case:
			// it may be a brick. Stop and get a human.
			name: "halts when the current node goes silent past the limit",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n1", StageStartedAt: tNow - 20*60,
			},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow - 20*60, UpdateStartedAt: tNow - 20*60},
			},
			want: RolloutDecision{Action: "halt", Reason: "node n1 silent since update started"},
		},
		{
			name: "completes when every fleet node is on target",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n2", StageStartedAt: tNow - tHour,
			},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok"},
				{ID: "n2", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok", UpdateStartedAt: tNow - tHour},
			},
			want: RolloutDecision{Action: "complete"},
		},
		{
			// An offline node must not stall the queue forever; skip and move on.
			name: "skips a node that is offline when its turn comes",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "", StageStartedAt: 0,
			},
			nodes: []NodeSnapshot{
				{ID: "gone", Version: "v0.8.0", LastSeenAt: tNow - 10*tHour},
				{ID: "here", Version: "v0.8.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "update", NodeID: "here"},
		},
		{
			name:  "does nothing when halted",
			track: RolloutTrack{Track: "fleet", TargetVersion: "v0.9.0", Status: "halted"},
			nodes: []NodeSnapshot{{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow}},
			want:  RolloutDecision{Action: "wait"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := decideFleet(tc.track, tc.nodes, tNow)
			if got.Action != tc.want.Action || got.NodeID != tc.want.NodeID {
				t.Errorf("decideFleet = %+v, want %+v", got, tc.want)
			}
			if tc.want.Reason != "" && got.Reason == "" {
				t.Errorf("decideFleet gave no halt reason; want one describing %q", tc.want.Reason)
			}
		})
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

```
cd server && go test ./internal/account/ -run DecideFleet -v
```
预期：编译失败，`undefined: decideFleet`

- [ ] **Step 3: 实现**

新建 `server/internal/account/rollout_fleet.go`，实现 `decideFleet`。判定顺序（**顺序本身
就是规格**，写在代码注释里）：

1. `Status != "rolling"` → `wait`
2. 有 `CurrentNodeID` 时：
   - 该节点 `UpdateResult` 是 `failed`/`rolled_back` → `halt`
   - 该节点自 `UpdateStartedAt` 起静默超过 `updateSilenceLimit` → `halt`
   - 该节点尚未到达目标版本 → `wait`
   - 已到目标版本但未过观察窗口（首台 `fleetFirstWindow`，其余 `fleetStepWindow`）→ `wait`
3. 所有在线节点都在目标版本 → `complete`
4. 否则挑下一台：首台按 `ActiveTransfers` 升序，其余按 `hash(nodeID+targetVersion)`
   升序；跳过离线的 → `update`

`hash` 用 `crypto/sha256` 对 `nodeID+targetVersion` 取前 8 字节做 uint64，**不要**用
`math/rand`（必须可重现）。

- [ ] **Step 4: 跑测试确认通过**

```
cd server && go test ./internal/account/ -run DecideFleet -v
```
预期：九个子测试全 PASS

- [ ] **Step 5: 提交**

```bash
git add server/internal/account/rollout_fleet.go server/internal/account/rollout_fleet_test.go
git commit -m "feat(rollout): fleet track state machine

Strict serial: one node at a time, first pick is whichever node has the fewest
active transfers, 6h observation on that first node and 30min on the rest. A
single rollback or a node going silent halts the queue — with sixteen nodes all
ours, one breaking is a signal rather than noise. Pure function over injected
time so the 6h window is an integer in tests, not a wait."
```

---

### Task 3: BYO 轨状态机（按比例分批）

**Files:**
- Create: `server/internal/account/rollout_byo.go`
- Test: `server/internal/account/rollout_byo_test.go`

**Interfaces:**
- Consumes: `RolloutTrack`、`NodeSnapshot`、`RolloutDecision`（Task 2）
- Produces:
  ```go
  // decideByo returns which BYO nodes may update now. Unlike the fleet track it
  // returns a set, not one node.
  func decideByo(tr RolloutTrack, nodes []NodeSnapshot, now int64) (action string, eligible []string, reason string)
  ```
- 常量：`byoBatches = []int{10, 50, 100}`、`byoBatchWindow = 6 * 3600`、`byoFailureRate = 0.20`、`byoFailureFloor = 2`

- [ ] **Step 1: 写失败的测试**

新建 `server/internal/account/rollout_byo_test.go`：

```go
package account

import "testing"

func byoNodes(n int, ver string, seen int64) []NodeSnapshot {
	out := make([]NodeSnapshot, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, NodeSnapshot{ID: string(rune('a' + i)), Version: ver, LastSeenAt: seen})
	}
	return out
}

// BYO can be hundreds of machines; strict serial would take days and none of
// them are ours to babysit.
func TestDecideByoFirstBatchIsTenPercent(t *testing.T) {
	tr := RolloutTrack{Track: "byo", TargetVersion: "v0.9.0", Status: "rolling", ByoBatch: 0}
	nodes := byoNodes(20, "v0.8.0", tNow)

	action, eligible, _ := decideByo(tr, nodes, tNow)
	if action != "update" {
		t.Fatalf("action = %q, want update", action)
	}
	if len(eligible) != 2 {
		t.Errorf("eligible = %d nodes, want 2 (10%% of 20)", len(eligible))
	}
}

// One flaky user machine is normal, not a signal — halting on it would leave
// the BYO track permanently stuck.
func TestDecideByoToleratesASingleFailure(t *testing.T) {
	nodes := byoNodes(20, "v0.9.0", tNow)
	nodes[0].UpdateResult = "rolled_back"
	nodes[0].Version = "v0.8.0"
	tr := RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
		ByoBatch: 10, StageStartedAt: tNow - 7*tHour,
	}

	action, _, _ := decideByo(tr, nodes, tNow)
	if action == "halt" {
		t.Error("action = halt on a single BYO failure; want the rollout to continue")
	}
}

func TestDecideByoHaltsAboveFailureRate(t *testing.T) {
	nodes := byoNodes(20, "v0.9.0", tNow)
	for i := 0; i < 5; i++ { // 25% > 20% threshold, and >= 2 absolute
		nodes[i].UpdateResult = "failed"
		nodes[i].Version = "v0.8.0"
	}
	tr := RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
		ByoBatch: 50, StageStartedAt: tNow - 7*tHour,
	}

	action, _, reason := decideByo(tr, nodes, tNow)
	if action != "halt" {
		t.Fatalf("action = %q with a 25%% failure rate, want halt", action)
	}
	if reason == "" {
		t.Error("halt with no reason; admin needs to know why")
	}
}

func TestDecideByoAdvancesBatchesAfterWindow(t *testing.T) {
	nodes := byoNodes(20, "v0.9.0", tNow)
	tr := RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
		ByoBatch: 10, StageStartedAt: tNow - 7*tHour,
	}
	action, eligible, _ := decideByo(tr, nodes, tNow)
	if action != "update" || len(eligible) == 0 {
		t.Fatalf("action=%q eligible=%d, want the 50%% batch to open", action, len(eligible))
	}
}

func TestDecideByoWaitsInsideWindow(t *testing.T) {
	nodes := byoNodes(20, "v0.9.0", tNow)
	tr := RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
		ByoBatch: 10, StageStartedAt: tNow - tHour,
	}
	if action, _, _ := decideByo(tr, nodes, tNow); action != "wait" {
		t.Errorf("action = %q one hour into a 6h batch window, want wait", action)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

```
cd server && go test ./internal/account/ -run DecideByo -v
```
预期：编译失败，`undefined: decideByo`

- [ ] **Step 3: 实现**

新建 `server/internal/account/rollout_byo.go`。批次成员用同一个
`hash(nodeID+targetVersion)` 排序后取前 N%——保证 10% 的那批是 50% 那批的子集，节点不
会被更新两次。

- [ ] **Step 4: 跑测试确认通过**

```
cd server && go test ./internal/account/ -run DecideByo -v
```
预期：五个 PASS

- [ ] **Step 5: 提交**

```bash
git add server/internal/account/rollout_byo.go server/internal/account/rollout_byo_test.go
git commit -m "feat(rollout): BYO track rolls in 10/50/100 batches

Strict serial only suits the sixteen machines we own; hundreds of user nodes at
30min each would take days. Batch by a stable hash so each batch is a superset
of the last, and halt on a failure RATE rather than a single failure — one
flaky user machine is normal, and halting on it would wedge the track forever."
```

---

### Task 4: 轨道隔离与单向门禁

spec 里最容易被实现漏掉的一条：BYO 出问题绝不能拖住机队。

**Files:**
- Create: `server/internal/account/rollout_gate.go`
- Test: `server/internal/account/rollout_gate_test.go`

**Interfaces:**
- Produces:
  ```go
  // SetTargetVersion is the only way a track's target changes. It enforces the
  // one-way gate: BYO may only target a version the fleet already finished.
  func (s *Service) SetTargetVersion(ctx context.Context, track, version string) error
  ```
- 错误：`ErrByoAheadOfFleet`

- [ ] **Step 1: 写失败的测试**

新建 `server/internal/account/rollout_gate_test.go`：

```go
package account

import (
	"context"
	"errors"
	"testing"
)

// The whole point of the two-track split: user nodes stuck on a bad version
// must never stop us shipping the next fleet release.
func TestHaltedByoTrackDoesNotBlockFleetTarget(t *testing.T) {
	svc, store := newRolloutService(t) // ← 照该包现有 Service 测试构造法实现
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v0.8.0", Status: "halted", HaltedReason: "failure rate 30%",
	}); err != nil {
		t.Fatal(err)
	}

	if err := svc.SetTargetVersion(ctx, "fleet", "v0.9.0"); err != nil {
		t.Fatalf("setting a fleet target while BYO is halted: %v — BYO must never block the fleet", err)
	}
	got, _, _ := store.GetRolloutTrack(ctx, "fleet")
	if got.TargetVersion != "v0.9.0" || got.Status != "rolling" {
		t.Errorf("fleet track = %+v, want v0.9.0 rolling", got)
	}
}

// Our own fleet is the canary for user machines.
func TestByoCannotTargetAVersionTheFleetHasNotFinished(t *testing.T) {
	svc, store := newRolloutService(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
	}); err != nil {
		t.Fatal(err)
	}

	err := svc.SetTargetVersion(ctx, "byo", "v0.9.0")
	if !errors.Is(err, ErrByoAheadOfFleet) {
		t.Errorf("err = %v, want ErrByoAheadOfFleet — user machines must not lead our own fleet", err)
	}
}

func TestByoMayTargetAVersionTheFleetCompleted(t *testing.T) {
	svc, store := newRolloutService(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "complete",
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.SetTargetVersion(ctx, "byo", "v0.9.0"); err != nil {
		t.Errorf("SetTargetVersion(byo, v0.9.0) after the fleet completed it: %v", err)
	}
}

// Fix-forward: a stuck BYO track jumps straight to the newest fleet-completed
// version rather than being made to replay the bad one.
func TestHaltedByoTrackMayJumpToANewerCompletedVersion(t *testing.T) {
	svc, store := newRolloutService(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v0.8.0", Status: "halted",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "complete",
	}); err != nil {
		t.Fatal(err)
	}

	if err := svc.SetTargetVersion(ctx, "byo", "v0.9.0"); err != nil {
		t.Fatalf("halted BYO track jumping to v0.9.0: %v", err)
	}
	got, _, _ := store.GetRolloutTrack(ctx, "byo")
	if got.Status != "rolling" {
		t.Errorf("byo status = %q after a new target, want rolling (the halt is cleared)", got.Status)
	}
}
```

**实现者注意**：`newRolloutService` 需要你按该包现有 `Service` 测试的构造方式实现一个
小 helper，产出必须是真正能跑的测试。

- [ ] **Step 2: 跑测试确认失败**

```
cd server && go test ./internal/account/ -run "Byo|Fleet.*Target" -v
```
预期：编译失败

- [ ] **Step 3: 实现**

新建 `server/internal/account/rollout_gate.go`：

```go
package account

import (
	"context"
	"errors"
	"fmt"
)

// ErrByoAheadOfFleet rejects pointing user nodes at a version our own fleet has
// not finished running. Our fleet is the canary for user machines; that
// ordering is the entire justification for auto-updating machines we don't own.
var ErrByoAheadOfFleet = errors.New("BYO track cannot target a version the fleet has not completed")

// SetTargetVersion sets a track's target. The gate is deliberately one-way:
// BYO waits on the fleet, and a broken BYO track never blocks the fleet.
func (s *Service) SetTargetVersion(ctx context.Context, track, version string) error {
	if track == "byo" {
		fleet, ok, err := s.store.GetRolloutTrack(ctx, "fleet")
		if err != nil {
			return err
		}
		if !ok || fleet.Status != "complete" || fleet.TargetVersion != version {
			return fmt.Errorf("%w: fleet is on %q/%q", ErrByoAheadOfFleet, fleet.TargetVersion, fleet.Status)
		}
	}
	// A new target always clears a prior halt — that is how fix-forward works.
	return s.store.PutRolloutTrack(ctx, RolloutTrack{
		Track: track, TargetVersion: version, Status: "rolling",
		StageStartedAt: s.now().Unix(),
	})
}
```

- [ ] **Step 4: 跑测试确认通过**

```
cd server && go test ./internal/account/ -run "Byo|Fleet.*Target" -v
```
预期：四个 PASS

- [ ] **Step 5: 提交**

```bash
git add server/internal/account/rollout_gate.go server/internal/account/rollout_gate_test.go
git commit -m "feat(rollout): one-way gate between the BYO and fleet tracks

BYO may only target a version the fleet already completed — our own machines
are the canary for users'. The gate never runs the other way: a halted BYO
track leaves the fleet free to ship, and pointing a stuck BYO track at a newer
completed version clears the halt so it can fix forward past the bad release."
```

---

### Task 5: `/api/nodes/update-check` 端点

**Files:**
- Modify: `server/internal/account/nodes.go`（照现有 `/api/nodes/*` 处理器的鉴权模式加）
- Test: `server/internal/account/rollout_endpoint_test.go`

**Interfaces:**
- 请求：`POST /api/nodes/update-check`，node token 鉴权
  ```go
  type updateCheckReq struct {
      NodeID         string `json:"nodeID"`
      CurrentVersion string `json:"currentVersion"`
      Result         string `json:"result,omitempty"` // outcome of the PREVIOUS update
  }
  type updateCheckResp struct {
      TargetVersion  string `json:"targetVersion"`
      Eligible       bool   `json:"eligible"`
      AllowDowngrade bool   `json:"allowDowngrade"`
      Reason         string `json:"reason,omitempty"`
  }
  ```

- [ ] **Step 1: 读现有节点端点的鉴权写法**

```
cd server && grep -n "download-receipt\|func (s \*Service) handleNode" internal/account/nodes.go | head
```
照 `/api/nodes/download-receipt` 的鉴权与错误处理**完全一致**地写新端点。不要另发明一套。

- [ ] **Step 2: 写失败的测试**

新建 `server/internal/account/rollout_endpoint_test.go`，覆盖四条：

1. 无 token / 错 token → 401，且响应体里不含 `targetVersion`
2. 轨道 `rolling` 且该节点正是 `decideFleet` 选中的那台 → `eligible: true`，`targetVersion` 正确
3. 同轨道但该节点不是当前该动的那台 → `eligible: false`
4. 带 `result: "rolled_back"` 上报 → 落库到该节点的 `update_result`，且轨道变 `halted`

（每条都要写成完整可跑的测试，用 Task 1/2 的 store 与状态机。）

- [ ] **Step 3: 跑测试确认失败**

```
cd server && go test ./internal/account/ -run UpdateCheck -v
```

- [ ] **Step 4: 实现**

处理器逻辑：鉴权 → 若带 `Result` 则先落库并按需 halt → 读轨道（按节点 `OwnerType` 选
`fleet`/`byo`）→ 调对应状态机 → 若决策是 `update` 且指向本节点则 `eligible: true`，并把
`CurrentNodeID`/`StageStartedAt`/`update_started_at` 写回 → 否则 `eligible: false`。

`AllowDowngrade` 仅当目标版本低于该节点当前版本**且**该轨道的目标是管理员显式设定的回滚
时为 true。

- [ ] **Step 5: 跑测试确认通过 + 全量**

```
cd server && go test ./internal/account/
```

- [ ] **Step 6: 提交**

```bash
git add server/internal/account/
git commit -m "feat(rollout): add POST /api/nodes/update-check

The root updater asks central what to run rather than the sandboxed node being
told — the node proper stays entirely out of the update path, so a compromised
node has no channel through which to request a binary swap."
```

---

### Task 6: 更新器接上中央

把第 1 部分的 `-to` 从必填人手输入，改为「未指定时问中央」。

**Files:**
- Modify: `server/cmd/relayium-node/update.go`
- Test: `server/cmd/relayium-node/update_central_test.go`

**Interfaces:**
- Produces: `func fetchTarget(centralURL, token, nodeID, currentVersion, prevResult string, hc *http.Client) (tag string, eligible, allowDowngrade bool, err error)`

- [ ] **Step 1: 写失败的测试**（httptest 假中央，覆盖 eligible=true/false、401、网络错误不炸）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 `fetchTarget`；`parseUpdateFlags` 的 `-to` 改为选填，缺省则走中央**
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交**

---

### Task 7: systemd timer 与开关

**Files:**
- Modify: `web/public/install-node.sh`
- Modify: `docs/node-hardening.md`、`docs/direct-download-deploy.md`

- [ ] **Step 1: 安装脚本写入 timer**

`RELAYIUM_NODE_AUTO_UPDATE`（默认 `on`）为 `on` 时才装以下两个 unit：

`/etc/systemd/system/relayium-node-update.service`：
```ini
[Unit]
Description=Relayium node self-update (central-driven)
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/relayium-node/env
ExecStart=/usr/local/bin/relayium-node update
```

`/etc/systemd/system/relayium-node-update.timer`：
```ini
[Unit]
Description=Check for a Relayium node update

[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
# Smear polls across the fleet so central isn't hit in lockstep. Central
# enforces one-node-at-a-time regardless; this only spreads the questions.
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
```

**注意**：这个 service **不加**节点本体的沙箱指令——它需要 root 才能替换二进制。这是
刻意的，它是全系统里唯一有此权限的东西，且只做这一件事。

- [ ] **Step 2: env 里加开关**，`uninstall` 时一并清理（第 3 部分负责）
- [ ] **Step 3: 安装输出打印自动更新状态与关闭方法**
- [ ] **Step 4: 容器里实测装→timer 生效→`systemctl list-timers` 可见**
- [ ] **Step 5: 更新文档**
- [ ] **Step 6: 提交**

---

### Task 8: admin 两块面板

**Files:**
- Modify: `server/internal/account/admin.go`、`server/internal/account/admin_templates.go`
- Test: `server/internal/account/admin_rollout_test.go`

- [ ] **Step 1: 写失败的测试**——两条轨道各自渲染出目标版本/状态/进度；BYO `halted` 时机队面板仍可提交新目标；提交越过门禁的 BYO 目标返回可读错误
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**——两块独立面板，各带「设定目标版本 / 暂停 / 继续 / 回滚」；**紧急发布**按钮走单独路径，跳过分批直接对全轨放行，需二次确认，并写审计日志（照 `docs/admin-2fa.md` 的 step-up 模式）
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交**

## 本计划的交付物

在 admin 里设一个目标版本，机队自己一台台滚完（约 14 小时），确认无误后把 BYO 轨也指
向该版本，用户节点分三批跟上。任一环节出问题自动停住并告警，且**BYO 卡住绝不影响机队
发下一个版本**。
