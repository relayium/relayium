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
- Modify: `server/internal/account/nodes.go`
- Test: `server/internal/account/rollout_endpoint_test.go`（新建）

**Interfaces:**
- Consumes: `s.nodeOwner(r)`（已有，见下）、`decideFleet`/`decideByo`（Task 2/3）、`GetRolloutTrack`/`PutRolloutTrack`（Task 1）
- Produces:
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

**已确认的既有事实（照抄，别自己发明）：**

鉴权用 `s.nodeOwner(r) (ownerType, ownerUserID string, ok bool)`，`ownerType` 为
`"fleet"` 或 `"user"` —— 这正好就是节点属于哪条轨道。路由注册在 `nodes.go` 里，形如
`mux.HandleFunc("POST /api/nodes/download-receipt", s.handleDownloadReceipt)`。
请求体解码一律走 `json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))`。

> **信任模型提示**：机队 token 是**全机队共用**的，不绑定具体 nodeID。所以一台机队节点
> 理论上可以谎报 `nodeID`、替别的节点上报结果。这与既有的 register/heartbeat 是同一套
> 信任模型，本任务**沿用即可，不要额外设计**；但请在处理器的注释里写明这一点，别让后人
> 误以为 nodeID 是被鉴权绑定的。

- [ ] **Step 1: 写失败的测试**

新建 `server/internal/account/rollout_endpoint_test.go`。用 `newFileServer(t)`
（`files_test.go:22`，返回 `(*httptest.Server, *Service, *SQLiteStore, *capturingMailer)`）
起服务，用 `store.UpsertNode` 造节点。**注意**：这些测试要控制时间，`Service` 有 `now` 字段可赋值。

```go
package account

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

func postUpdateCheck(t *testing.T, ts *httptest.Server, token string, body updateCheckReq) (*http.Response, updateCheckResp) {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest("POST", ts.URL+"/api/nodes/update-check", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var out updateCheckResp
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp, out
}

// An unauthenticated caller must learn nothing — not even which version the
// fleet is being moved to, which would tell an attacker exactly which release
// to look for known vulnerabilities in.
func TestUpdateCheckRejectsMissingToken(t *testing.T) {
	// Arrange: a rolling fleet track with target v0.9.0.
	// Act: POST with no Authorization header.
	// Assert: 401, and the decoded body's TargetVersion is empty.
}

// The node the state machine picked is the ONLY one told to move.
func TestUpdateCheckMarksTheChosenNodeEligible(t *testing.T) {
	// Arrange: fleet track rolling at v0.9.0, two online fleet nodes on v0.8.0,
	//   nothing in flight (CurrentNodeID empty).
	// Act: the node decideFleet would pick asks.
	// Assert: Eligible true, TargetVersion "v0.9.0"; and the track row now
	//   records CurrentNodeID == that node and a non-zero StageStartedAt
	//   (claiming the slot is what makes "strictly serial" hold).
}

// Strict serial: everyone else waits, and is told so without being told to move.
func TestUpdateCheckMarksOtherNodesIneligible(t *testing.T) {
	// Arrange: same, but the track already has CurrentNodeID = some OTHER node.
	// Act: a different node asks.
	// Assert: Eligible false. TargetVersion may be returned; Reason non-empty.
}

// A node reporting that it rolled back must stop the queue dead.
func TestUpdateCheckHaltsTheTrackOnRolledBack(t *testing.T) {
	// Arrange: fleet track rolling, CurrentNodeID = n1, n1 mid-update.
	// Act: n1 posts Result "rolled_back".
	// Assert: the node row's update_result == "rolled_back" AND the track's
	//   Status == "halted" with a non-empty HaltedReason.
}

// A BYO node must be answered from the BYO track, never the fleet one —
// otherwise user machines would follow our fleet's rollout in lockstep.
func TestUpdateCheckRoutesUserNodesToTheByoTrack(t *testing.T) {
	// Arrange: fleet track complete at v0.9.0; BYO track rolling at v0.8.0.
	// Act: a node whose token resolves to ownerType "user" asks.
	// Assert: TargetVersion is the BYO track's v0.8.0, not v0.9.0.
}
```

**实现者注意**：上面五个用例的 Arrange/Act/Assert 是规格。Step 1 的产出必须是**填实后能跑**
的测试——先读 `files_directdl_test.go` 和 `nodes_test.go` 看清 `UpsertNode` / 机队 token /
用户 token 的真实造法，再动手。不得提交空函数体或 `t.Skip`。

- [ ] **Step 2: 跑测试确认失败**

```
cd server && go test ./internal/account/ -run UpdateCheck -v
```
预期：编译失败（`undefined: updateCheckReq`）

- [ ] **Step 3: 实现**

在 `nodes.go` 注册路由，紧邻既有的 node 端点：

```go
	mux.HandleFunc("POST /api/nodes/update-check", s.handleUpdateCheck)
```

处理器逻辑，**顺序即规格**：

1. `ownerType, _, ok := s.nodeOwner(r)`；`!ok` → 401。
2. 解码请求体（`MaxBytesReader` 4KiB）；`NodeID` 为空 → 400。
3. 若 `req.Result != ""`：先把结果落到该节点行（`update_result`），再按轨道规则判断是否
   要 `halted`（机队：`failed`/`rolled_back` 即停；BYO：按失败率）。**先落库再决策**，
   这样即使随后的决策出错，上报也不会丢。
4. `track := "fleet"`；`ownerType == "user"` 时为 `"byo"`。读该轨道；不存在或
   `Status != "rolling"` → 返回 `Eligible: false`。
5. 取该轨道的节点快照，调 `decideFleet` / `decideByo`。
6. 决策指向本节点 → 把 `CurrentNodeID`/`StageStartedAt`（BYO 为批次）与该节点的
   `update_started_at` 写回，返回 `Eligible: true`。**认领动作必须落库**，否则两台节点
   在同一轮里都会认为轮到自己，严格串行就破了。
7. 否则 `Eligible: false` + `Reason`。

`AllowDowngrade` 仅在**目标版本低于该节点当前版本**时为 true——即管理员显式把轨道回退到
旧版本。用 `selfupdate.IsPlainVersion` + 版本比较判断，不要用字符串大小比较。

- [ ] **Step 4: 跑测试确认通过 + 全量**

```
cd server && go test ./internal/account/ -run UpdateCheck -v && go test ./internal/account/
```

- [ ] **Step 5: 提交**

```bash
git add server/internal/account/
git commit -m "feat(rollout): add POST /api/nodes/update-check

The root updater asks central what to run rather than the sandboxed node being
told — the node proper stays entirely out of the update path, so a compromised
node has no channel through which to request a binary swap. Claiming the slot
is persisted before the node is told to move, so two nodes can never both
believe it is their turn."
```

---

### Task 6: 更新器接上中央

把第 1 部分里人手输入的 `-to`，改为「未指定时问中央」。

**Files:**
- Modify: `server/cmd/relayium-node/update.go`
- Test: `server/cmd/relayium-node/update_central_test.go`（新建）

**Interfaces:**
- Produces:
  ```go
  // fetchTarget asks central what this node should be running.
  func fetchTarget(centralURL, token, nodeID, currentVersion, prevResult string, hc *http.Client) (
      tag string, eligible, allowDowngrade bool, err error)
  ```
- `updateConfig` 加 `CentralURL`、`NodeToken` 两个字段，来源同 `StateDir`：flag > 进程 env > `/etc/relayium-node/env` > 默认。

**第 1 部分已落地、本任务必须沿用的事实：**
- `parseUpdateFlags` 已实现 flag > env > env 文件 > 默认的优先级链，并有 `-env-file` 覆盖。
  照它加 `RELAYIUM_CENTRAL_URL` / `RELAYIUM_NODE_TOKEN` 两个键。
- `-to` 目前是**必填**；本任务改为选填，缺省则问中央。但**非 semver 的 `-to` 仍必须被拒**
  （`selfupdate.IsPlainVersion`），中央返回的版本同样要过这一关——中央也可能出 bug。
- 退出码常量已在第 1 部分定义（0 成功 / 2 skipped / 3 failed / …）。「中央说不该我动」要复用
  **skipped** 那个码，不要新增。

- [ ] **Step 1: 写失败的测试**

新建 `server/cmd/relayium-node/update_central_test.go`，用 `httptest` 假中央：

```go
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func fakeCentral(t *testing.T, status int, body map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}))
}

func TestFetchTargetReturnsEligibleTarget(t *testing.T) {
	srv := fakeCentral(t, 200, map[string]any{
		"targetVersion": "v0.9.0", "eligible": true, "allowDowngrade": false,
	})
	defer srv.Close()

	tag, eligible, allowDown, err := fetchTarget(srv.URL, "tok", "n1", "0.8.0", "", srv.Client())
	if err != nil {
		t.Fatalf("fetchTarget: %v", err)
	}
	if tag != "v0.9.0" || !eligible || allowDown {
		t.Errorf("got tag=%q eligible=%v allowDowngrade=%v, want v0.9.0/true/false", tag, eligible, allowDown)
	}
}

// The overwhelmingly common answer is "not your turn" — it must be a cheap,
// quiet, non-error path, because every node asks every few minutes forever.
func TestFetchTargetHandlesIneligible(t *testing.T) {
	srv := fakeCentral(t, 200, map[string]any{"targetVersion": "v0.9.0", "eligible": false})
	defer srv.Close()

	_, eligible, _, err := fetchTarget(srv.URL, "tok", "n1", "0.8.0", "", srv.Client())
	if err != nil {
		t.Errorf("fetchTarget returned an error for the normal not-my-turn answer: %v", err)
	}
	if eligible {
		t.Error("eligible = true, want false")
	}
}

// A bad token must be a loud error, not silently read as "not my turn" —
// otherwise a node would sit un-updated forever and look healthy doing it.
func TestFetchTargetErrorsOnUnauthorized(t *testing.T) {
	srv := fakeCentral(t, 200, nil)
	defer srv.Close()

	if _, _, _, err := fetchTarget(srv.URL, "wrong-token", "n1", "0.8.0", "", srv.Client()); err == nil {
		t.Error("fetchTarget err = nil on 401, want an error")
	}
}

// Central being down must not touch the binary. The node keeps running the
// version it has; that is always the safe outcome.
func TestFetchTargetErrorsWhenCentralUnreachable(t *testing.T) {
	if _, _, _, err := fetchTarget("http://127.0.0.1:1", "tok", "n1", "0.8.0", "", http.DefaultClient); err == nil {
		t.Error("fetchTarget err = nil against an unreachable central, want an error")
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

```
cd server && go test ./cmd/relayium-node/ -run FetchTarget -v
```
预期：编译失败，`undefined: fetchTarget`

- [ ] **Step 3: 实现 `fetchTarget`**

POST `<centralURL>/api/nodes/update-check`，`Authorization: Bearer <token>`，请求体
`{nodeID, currentVersion, result}`。非 200 一律返回 error。**给 HTTP client 设一个短超时**
（连接+响应头各几秒即可，这是个小 JSON 请求，不是下载）——但**不要**给下载阶段的 client 设
`Timeout`，第 1 部分的 `selfupdate.DefaultHTTPClient` 已经解释过为什么。

- [ ] **Step 4: `-to` 改为选填**

`parseUpdateFlags`：`-to` 为空时不再报错。`runUpdate` 在 `-to` 为空时调 `fetchTarget`：
- `err != nil` → 打印错误，退出码 = failed，**不碰二进制**。
- `!eligible` → 打印「不该我动」，退出码 = skipped。
- 拿到 tag → 校验 `IsPlainVersion`，然后走原有的更新流程。
- 上一次的结果（成功/失败/回滚）通过 `prevResult` 带给中央：把它落在状态目录一个小文件里，
  下次启动时读出来上报，上报成功后清掉。

- [ ] **Step 5: 跑测试确认通过 + 全量**

```
cd server && go test ./cmd/relayium-node/ -count=1 && go build ./...
```

- [ ] **Step 6: 提交**

```bash
git add server/cmd/relayium-node/
git commit -m "feat(node): ask central which version to run

Replaces the hand-typed -to with a query to the rollout queue. Central being
unreachable leaves the binary untouched — the node keeps running what it has,
which is always the safe outcome. A non-semver version is refused even when
central is the one that sent it."
```

---

### Task 7: systemd timer 与开关

**Files:**
- Modify: `web/public/install-node.sh`
- Modify: `docs/node-hardening.md`、`docs/direct-download-deploy.md`

- [ ] **Step 1: 安装脚本写入两个 unit**

`RELAYIUM_NODE_AUTO_UPDATE`（默认 `on`）为 `on` 时才装。

`/etc/systemd/system/relayium-node-update.service`：
```ini
[Unit]
Description=Relayium node self-update (central-driven)
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/relayium-node/env
ExecStart=/usr/local/bin/relayium-node update
# The watchdog waits up to 10 minutes for the new version to prove itself.
# systemd's default TimeoutStartSec (90s) would SIGTERM the updater mid-watch,
# leaving an unverified binary, a stale .prev and no rollback. Must exceed
# healthWindow with room for the 60s drain plus the download.
TimeoutStartSec=20min
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

**注意**：这个 service **不加**节点本体的沙箱指令——它需要 root 才能替换二进制。这是刻意的：
它是全系统唯一有此权限的东西，且只做这一件事。

- [ ] **Step 2: env 文件加开关键**

`/etc/relayium-node/env` 增加 `RELAYIUM_NODE_AUTO_UPDATE=${RELAYIUM_NODE_AUTO_UPDATE:-on}`。
同时补上第 1 部分发现缺失的 `RELAYIUM_NODE_BIN=${INSTALL_DIR}/relayium-node` —— 否则装到
非默认目录时，更新器会去动 `/usr/local/bin` 下的错文件。

- [ ] **Step 3: 卸载 timer 的幂等处理**

重跑安装脚本且 `AUTO_UPDATE=off` 时，必须 `disable --now` 并删掉这两个 unit，否则关不掉。

- [ ] **Step 4: 安装输出打印自动更新状态**

在结尾摘要里写明：自动更新是开还是关、怎么关、以及「中央只下发版本号，二进制由本机验签」。

- [ ] **Step 5: `sh -n` + `shellcheck` + 容器实测**

```
sh -n web/public/install-node.sh && shellcheck -s sh web/public/install-node.sh
```
容器里至少验证：`AUTO_UPDATE=on` 装出两个 unit 文件且内容含 `TimeoutStartSec=20min`；
`AUTO_UPDATE=off` 不装（或已存在则删除）。

- [ ] **Step 6: 更新两份文档 + 提交**

---

### Task 8: admin 两块面板

**Files:**
- Modify: `server/internal/account/admin.go`、`server/internal/account/admin_templates.go`
- Test: `server/internal/account/admin_rollout_test.go`（新建）

**已确认的既有事实：** admin 是 Go 服务端模板（`admin_templates.go`），节点区在
`<section class="nodes">`（约 419 行），既有表单形如
`<form method="post" action="/admin/nodes/{{.ID}}/limits">`。照这个模式加，不要引入前端框架。

- [ ] **Step 1: 写失败的测试**

新建 `server/internal/account/admin_rollout_test.go`，覆盖四条（照 `admin_nodes_test.go`
的既有 admin 会话构造法写实，不得留空函数体）：

1. 页面渲染出两块面板，各自显示自己的目标版本、状态、进度
2. **BYO 轨 `halted` 时，提交机队轨的新目标版本仍然成功**（这是两轨分离的核心保证）
3. 提交一个机队轨尚未 `complete` 的版本给 BYO 轨 → 返回可读错误，且 BYO 轨状态不变
4. 紧急发布按钮走独立 action，且会写审计日志

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

两块**独立**面板，各带「设定目标版本 / 暂停 / 继续 / 回滚」。每台节点显示版本、更新结果、
失败原因。**紧急发布**是单独的 action（跳过分批，对整条轨道放行），需二次确认，并按
`docs/admin-2fa.md` 的 step-up 模式写审计日志。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 提交**

---

### Task 9: BYO 节点更新窗口内豁免计费

**用户决策（2026-07-22）**：自动更新会让 BYO 节点例行重启，重启窗口内其所有者本该免费的下载会
跌落到计量的中央代理路径而被静默计费。用户裁定：**这个窗口内豁免计费。**

**为什么现在才能精确实现**：Part 1 只知道"节点离线"，无法区分「用户自己把机器关了」和「我们正在
更新它」。前者继续计费是对的（中央确实在掏带宽，且不是我们造成的）；后者是我们造成的，不该让用户
买单。Task 1 加的 `update_started_at` 列让这个区分成为可能，所以豁免可以**只覆盖真正的更新窗口**，
而不是笼统地给所有离线情况免单。

**Files:**
- Modify: `server/internal/account/files.go`（计量分支，约 509-517 行「Meter the central egress
  against the owner for every file — own-node included」那段）
- Test: `server/internal/account/files_byo_update_exempt_test.go`（新建）

**Interfaces:**
- Consumes: `Node.UpdateStartedAt`（Task 1）、`nodeOnlineWindow`
- Produces: 无新导出符号

- [ ] **Step 1: 读清现有计量分支**

```
cd server && sed -n '495,525p' internal/account/files.go
```
看清楚 BYO 自有节点直连（免费）与中央代理（计量）两条路径的分叉点，以及计量实际发生在哪一行。
**不要**动直连那条路径——它本来就免费。

- [ ] **Step 2: 写失败的测试**

新建 `server/internal/account/files_byo_update_exempt_test.go`。fixture 沿用
`files_directdl_test.go` 的 `newFileServer` / `UpsertNode` / `CreateStoredFile`：

```go
package account

import (
	"context"
	"testing"
	"time"
)

// A BYO owner's downloads from their OWN node are free — that is the whole
// deal: it is their disk and their bandwidth. When we restart that node to
// update it, central proxies instead and would normally meter the owner. That
// bill exists only because WE chose to update their machine, so we eat it.
func TestByoOwnNodeDownloadIsNotMeteredDuringItsUpdateWindow(t *testing.T) {
	// Arrange: direct download on; owner has a BYO node holding one of their
	//   files; the node is offline (LastSeenAt older than nodeOnlineWindow) AND
	//   UpdateStartedAt is recent (within the update window).
	// Act: GET the blob (falls back to central proxy).
	// Assert: the owner's metered usage is UNCHANGED.
}

// The exemption must be narrow. A user who simply powered their node off is not
// our doing, and central really is paying that egress — keep metering it.
func TestByoOwnNodeDownloadIsStillMeteredWhenOfflineForOtherReasons(t *testing.T) {
	// Arrange: same, but UpdateStartedAt is zero (no update in flight).
	// Act: GET the blob.
	// Assert: the owner IS metered the served bytes.
}

// The window must expire. A node that was commanded to update hours ago and
// never came back is a broken node, not an update in progress — metering
// resumes, otherwise a single stuck update would grant permanent free egress.
func TestByoUpdateExemptionExpires(t *testing.T) {
	// Arrange: same, but UpdateStartedAt is far older than the exemption window.
	// Act: GET the blob.
	// Assert: the owner IS metered.
}

// Fleet nodes are ours; their egress is an operator cost either way. The
// exemption must not silently widen to fleet-hosted files.
func TestFleetNodeDownloadIsStillMeteredDuringItsUpdateWindow(t *testing.T) {
	// Arrange: the file lives on a FLEET node with a recent UpdateStartedAt.
	// Act: GET the blob.
	// Assert: the owner IS metered exactly as before.
}

var _ = context.Background
var _ = time.Now
```

**实现者注意**：以上四个用例的 Arrange/Act/Assert 是规格。产出必须是照 `files_directdl_test.go`
的真实 fixture 填实后**能跑**的测试（那个文件里有现成的 `MonthlyUsage` 断言写法可抄），
不得提交空函数体或 `t.Skip`。

- [ ] **Step 3: 跑测试确认失败**

```
cd server && go test ./internal/account/ -run ByoUpdate -v
```
预期：豁免用例 FAIL（当前仍在计费）

- [ ] **Step 4: 实现**

在计量分支前加一道豁免判断，条件**全部**满足才免：

1. 文件在该文件所有者**自己的** BYO 节点上（`OwnerType == "user" && OwnerUserID == sf.UserID`
   —— 与 `files.go:395` 判断 BYO 直连免费用的是同一个条件，抄它）
2. 该节点有更新在途：`UpdateStartedAt != 0` 且 `now - UpdateStartedAt <= byoUpdateExemptWindow`

新增常量：

```go
// byoUpdateExemptWindow bounds how long a BYO owner's downloads stay free while
// we restart their node to update it. It must cover a real update (download +
// the node's 60s drain + restart + the updater's 10-minute health watch) but
// must expire: a node commanded hours ago and never seen again is broken, not
// updating, and a permanently "updating" node would otherwise earn permanent
// free egress. Deliberately a little longer than the updater's health window.
const byoUpdateExemptWindow = 20 * time.Minute
```

**只豁免计量，不要豁免流量闸**——两者是不同的东西，别顺手把配额检查也关了。若两者在同一段代码里，
在报告中明确说明你动了哪一个、没动哪一个。

- [ ] **Step 5: 跑测试确认通过 + 全量**

```
cd server && go test ./internal/account/ -run ByoUpdate -v && go test ./internal/account/ -count=1
```

- [ ] **Step 6: 提交**

```bash
git add server/internal/account/
git commit -m "feat(billing): don't meter a BYO owner while we restart their node

Downloads from a user's own node are free — their disk, their bandwidth. When
the rollout restarts that node, central proxies instead and would bill the
owner for egress they only incurred because we chose to update their machine.
Exempt exactly that window: their own node, an update genuinely in flight, and
bounded so a node stuck mid-update can't earn permanent free egress. Nodes
offline for any other reason stay metered, and fleet nodes are unaffected."
```

---

## 本计划的交付物

在 admin 里设一个目标版本，机队自己一台台滚完（约 14 小时），确认无误后把 BYO 轨也指
向该版本，用户节点分三批跟上。任一环节出问题自动停住并告警，且**BYO 卡住绝不影响机队
发下一个版本**。
