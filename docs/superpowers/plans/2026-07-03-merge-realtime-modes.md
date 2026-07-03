# 合并实时直传模式（配对码 ⊕ 分享链接）+ TTL 15 分钟 + 先选文件再配对 — 实现方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 跨网络页从「配对码 / 分享链接 / 下载链接」三卡合并为「实时直传 / 下载链接」两卡：实时直传免登录，一次生成同时给出 6 位码 + 加入链接 + 二维码；配对码 TTL 从 5 分钟延长到 15 分钟；发送方先选文件、再生成码，对方一加入自动发起传输。

**Architecture:** 分享链接（`/api/transfers` token 通路）前后端全量下线——它在机制上是配对码房间（`c:<code>`）的重复实现（`t:<token>`），且配对码已自带加入链接与二维码。前端新增一个共享「待发送文件」store（outbox），统一承载 OS 分享进来的文件与配对前选好的文件，复用 App 现有的"单 peer 自动发送" effect 实现"对方加入即自动 offer"。TURN 计量改为匿名记账（去掉 token→用户归因；将来"登录用户 mint 配对码归属账号"落地时恢复归因，见 deferred item）。

**Tech Stack:** Go（`server/`，`go test ./...`）、Svelte 5 runes + TypeScript + Vitest（`web/`）、SQLite（idempotent schema on open）、六语言 i18n（`web/src/lib/i18n/{zh,en,ja,ko,de,fr}.ts`）。

## Global Constraints

- 每个 task 结束时 `cd server && go test ./...` 与 `cd web && npx vitest run` 必须全绿；涉及 web 的 task 另跑 `cd web && npm run check`。
- i18n 六语言必须同一 commit 内同步修改（`types.ts` 是唯一 schema，缺 key 编译即失败）。
- 提交信息遵循仓库惯例：`feat(server): …` / `feat(web): …` / `docs: …`；结尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 不引入新依赖。
- 保留 `#c=<code>` 加入链接格式不变（线上已分发的二维码/链接继续有效）。

## 已确认的事实与决策（执行者无需再调研）

1. **`user_stats.transfers_total` 统计的是托管上传**（`sqlite.go` AddUploadStat），与 `/api/transfers` 无关。删除 token 通路不影响 `/me` 个人中心和 admin 看板的这项数字。
2. **TURN 计量（metering）现状**：coturn username 为 `<expiry>:<token或code>`；`metering.Worker` 只认 token（GetTransfer→UserID），配对码流量今天就会被 skip。线上尚未部署 coturn（见 memory），metering 从未真正运行。**决策：metering 改为匿名记账**（UserID 置空写入 `usage_events`），全局中继流量统计保留，按用户归因暂停——`usage_events.user_id` 的 FK 不生效（OpenSQLite 未开 `PRAGMA foreign_keys`，SQLite 默认 OFF），空字符串可安全写入。
3. **旧 `#t=` 分享链接**：TTL 1 小时，部署后至多 1 小时内的存量链接失效（打开落在无房间的 /cross-network 页）。影响窗口可忽略，不做兼容。
4. **`transfers` 表**：schema 里删除 DDL，并在 OpenSQLite 的幂等迁移区追加 `DROP TABLE IF EXISTS transfers`。
5. **静态 SEO 页是构建产物**：`web/public/**/index.html` 由 `npm run gen:pages`（`scripts/pages/content/*.mjs`）生成，改内容源后重新生成即可。
6. **反向用例保留**：接收方想让对方发起（如"电脑上开码、手机扫码后从手机发"）——生成码的卡片保留一个低调的"不选文件，仅创建连接"文字按钮，行为等同现状的"生成配对码"。
7. **iOS 无文件夹选择器**：`webkitdirectory` 不可用。现有 `isIOS()`/`folderUploadSupported` 逻辑在 `App.svelte:394-399`，提取到新模块 `platform.ts` 供 CodePairing 复用。

---

### Task 1: server — 信令路由去掉 token 房间

**Files:**
- Modify: `server/internal/signal/route.go`
- Modify: `server/internal/signal/route_test.go`
- Modify: `server/main.go:128-163`（/ws handler 与 `validateRoom` 接线）

**Interfaces:**
- Produces: `signal.RoomFor(code string, validatePair func(string) bool) (room string, maxPeers int, lan bool, ok bool)` — 后续无人再传 token。

- [ ] **Step 1: 改写 route_test.go 为目标行为（先失败）**

删除 `TestRoomForTokenStillWorks`、`TestRoomForCodeTakesPrecedenceOverToken`，其余测试改为新签名：

```go
package signal

import "testing"

func TestRoomForCode(t *testing.T) {
	ok := func(string) bool { return true }
	room, max, lan, valid := RoomFor("424242", ok)
	if room != "c:424242" || max != 2 || lan || !valid {
		t.Fatalf("got %q %d lan=%v ok=%v", room, max, lan, valid)
	}
}

func TestRoomForCodeRejected(t *testing.T) {
	no := func(string) bool { return false }
	if _, _, _, valid := RoomFor("424242", no); valid {
		t.Fatal("bad code must be rejected")
	}
	// nil validator also rejects.
	if _, _, _, ok := RoomFor("424242", nil); ok {
		t.Fatal("nil pair-validator must reject a code")
	}
}

func TestRoomForLAN(t *testing.T) {
	room, max, lan, valid := RoomFor("", nil)
	if room != "" || max != 0 || !lan || !valid {
		t.Fatalf("got %q %d lan=%v ok=%v", room, max, lan, valid)
	}
}
```

- [ ] **Step 2: 运行确认编译失败**

Run: `cd server && go test ./internal/signal/`
Expected: FAIL（RoomFor 参数个数不匹配）

- [ ] **Step 3: 改 route.go**

```go
package signal

// RoomFor decides the signaling room for a /ws request from its query params.
// A pairing code names a 2-peer room "c:<code>"; without one the caller derives
// the LAN room from the client IP (RoomKey) with unlimited peers. When ok is
// false the request must be rejected (HTTP 403). A nil validator rejects.
func RoomFor(code string, validatePair func(string) bool) (room string, maxPeers int, lan bool, ok bool) {
	if code != "" {
		if validatePair == nil || !validatePair(code) {
			return "", 0, false, false
		}
		return "c:" + code, 2, false, true
	}
	return "", 0, true, true
}
```

- [ ] **Step 4: 更新 main.go 的 /ws handler**

删除 `main.go:128-130` 的 `validateRoom` 声明与注释、`main.go:195` 的 `validateRoom = acct.ValidateTransferToken` 及其上方注释行。/ws handler 中：

```go
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		if code != "" && !wsCodeLimiter.Allow(ipx.IP(r)) {
			http.Error(w, "too many pairing attempts", http.StatusTooManyRequests)
			return
		}
		room, maxPeers, lan, ok := signal.RoomFor(code, pairReg.Validate)
		if !ok {
			http.Error(w, "invalid or expired pairing code", http.StatusForbidden)
			return
		}
		// …其余（lan 分支、websocket.Accept、handle）不变
	})
```

- [ ] **Step 5: 全量测试通过后提交**

Run: `cd server && go test ./...`
Expected: PASS

```bash
git add server/internal/signal/route.go server/internal/signal/route_test.go server/main.go
git commit -m "refactor(server): signaling rooms are pairing-code-only, drop token rooms"
```

---

### Task 2: server — 配对码 TTL 5 分钟 → 15 分钟

**Files:**
- Modify: `server/main.go:117`

**Interfaces:**
- Produces: `/api/pair` 返回的 `expiresAt` 相应后移；前端倒计时（`m:ss`）无需改动。

- [ ] **Step 1: 修改常数与注释**

```go
	pairReg := signal.NewPairRegistry(900, func() int64 { return time.Now().Unix() }) // 15 min
```

（`PairRegistry` 的 TTL 是注入参数，`pair_test.go` 自带注入，无测试要改。）

- [ ] **Step 2: 测试 + 提交**

Run: `cd server && go test ./...`
Expected: PASS

```bash
git add server/main.go
git commit -m "feat(server): extend pairing-code TTL to 15 minutes"
```

---

### Task 3: server — /api/ice 去掉 token 分支

**Files:**
- Modify: `server/internal/account/turn.go:34-48`
- Modify: `server/internal/account/turn_test.go`

**Interfaces:**
- Consumes: `s.validatePairCode`（已有，`SetPairCodeValidator` 注入）。
- Produces: `/api/ice?code=<code>` 仍发 TURN 凭证；`?room=` 参数被忽略（返回 STUN-only）。

- [ ] **Step 1: 更新 turn_test.go（先失败）**

删除 `TestICEValidTokenIncludesTurn`、`TestICEInvalidTokenReturnsStunOnly`（它们调用 `svc.CreateTransfer`）。把 `TestICENoTokenReturnsStunOnly` 改名为 `TestICENoRendezvousReturnsStunOnly`（断言内容不变：无 query 参数 → 只有 STUN）。新增一个回归测试，确认 `?room=` 不再发凭证：

```go
func TestICERoomParamIsIgnored(t *testing.T) {
	// 旧版分享链接的 ?room= 参数已下线；带上它必须不再返回 TURN 凭证。
	svc := newTestService(t) // 沿用该文件现有的构造 helper 与 TURN 配置方式
	req := httptest.NewRequest("GET", "/api/ice?room=deadbeef", nil)
	rec := httptest.NewRecorder()
	svc.handleICE(rec, req)
	var out struct{ IceServers []ICEServer `json:"iceServers"` }
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	for _, s := range out.IceServers {
		if s.Credential != "" {
			t.Fatalf("room param must not yield TURN credentials, got %+v", s)
		}
	}
}
```

（构造 helper 的名字以文件内现有测试为准——`TestICEValidPairCodeIncludesTurn` 用什么就用什么。）

- [ ] **Step 2: 运行确认失败**

Run: `cd server && go test ./internal/account/ -run TestICE`
Expected: FAIL（token 分支还在，`?room=` 仍可能发凭证 / 旧测试编译错误）

- [ ] **Step 3: 改 turn.go 的 handleICE**

```go
// handleICE serves the RTCConfiguration.iceServers list. STUN is always
// included; a TURN entry with an ephemeral credential is added only when the
// request names a live pairing code (?code=<code>) AND a TURN secret is
// configured. Without this, pairing-code transfers would be STUN-only and fail
// to relay across strict/symmetric NATs. It always returns 200 and never
// reveals code validity.
func (s *Service) handleICE(w http.ResponseWriter, r *http.Request) {
	servers := s.stunServers()
	if s.cfg.TURNSecret != "" && len(s.cfg.TURNURLs) > 0 {
		// The credential username embeds the pairing code so coturn validates it
		// and relay accounting can key usage by code.
		if code := r.URL.Query().Get("code"); code != "" && s.validatePairCode != nil && s.validatePairCode(code) {
			expiry := s.now().Add(s.cfg.TURNCredTTL).Unix()
			servers = append(servers, turnCredentials(s.cfg.TURNSecret, code, expiry, s.cfg.TURNURLs))
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"iceServers": servers})
}
```

同时更新 `service.go:71` 附近 `SetPairCodeValidator` 的注释（不再有"transfer token"对照物，改为"pairing-code rooms are the only realtime rendezvous"口径）。

- [ ] **Step 4: 测试 + 提交**

Run: `cd server && go test ./...`
Expected: PASS

```bash
git add server/internal/account/turn.go server/internal/account/turn_test.go server/internal/account/service.go
git commit -m "refactor(server): /api/ice hands TURN credentials to pairing codes only"
```

---

### Task 4: server — 下线 POST /api/transfers

**Files:**
- Modify: `server/internal/account/handlers.go:85, 233-243`
- Modify: `server/internal/account/handlers_test.go:367-…`（`TestCreateTransferRequiresSessionAndReturnsToken`）

- [ ] **Step 1: 删除测试 `TestCreateTransferRequiresSessionAndReturnsToken`**（handlers_test.go:367 起整个函数）。

- [ ] **Step 2: 删除路由注册与 handler**

删 `handlers.go:85` 的 `mux.HandleFunc("POST /api/transfers", …)` 和 `handlers.go:233-243` 的 `handleCreateTransfer`。

- [ ] **Step 3: 测试 + 提交**

Run: `cd server && go test ./...`
Expected: PASS

```bash
git add server/internal/account/handlers.go server/internal/account/handlers_test.go
git commit -m "feat(server): remove POST /api/transfers (share-link tokens retired)"
```

---

### Task 5: server — 移除 Transfer 数据模型，metering 匿名记账

**Files:**
- Modify: `server/internal/account/service.go`（删 `CreateTransfer`、`ValidateTransferToken`；`Config` 删 `TransferTTL`）
- Modify: `server/internal/account/store.go`（删 `Transfer` struct、接口方法 `CreateTransfer`/`GetTransfer`；更新 `UsageEvent` 注释）
- Modify: `server/internal/account/sqlite.go`（删 transfers DDL/索引与两个实现；OpenSQLite 迁移区加 `DROP TABLE IF EXISTS transfers`）
- Modify: `server/internal/account/service_test.go`（删 `TestCreateAndValidateTransferToken`、`TestValidateTransferTokenRejectsExpiredEmptyAndUnknown`）
- Modify: `server/internal/account/sqlite_test.go`（删 `TestCreateAndGetTransfer`、`TestGetTransferMissingReturnsErrNotFound`）
- Modify: `server/internal/metering/metering.go`
- Modify: `server/internal/metering/metering_test.go`
- Modify: `server/main.go:177`（删 `TransferTTL: time.Hour,`）

**Interfaces:**
- Produces: `metering.Sink` 收窄为 `{ RecordUsage(ctx, account.UsageEvent) error }`；usage 记录 `UserID: ""`（匿名）。
- 注意：若 `CreateTransfer` 用到的随机 token helper 同时被 session/magic-link 复用，保留 helper 本身，只删调用方。

- [ ] **Step 1: 先改 metering_test.go 为目标行为（先失败）**

`fakeSink` 删掉 `GetTransfer`；`TestWorkerRecordsAndAttributes` 改名并断言匿名：

```go
func TestWorkerRecordsAnonymously(t *testing.T) {
	sink := &fakeSink{}
	w := &Worker{Sink: sink, Now: func() int64 { return 42 }, Log: log.New(io.Discard, "", 0)}
	w.handle(context.Background(), UsageEvent{AllocID: "a1", Username: "99:424242", RelayedBytes: 7})
	if len(sink.recorded) != 1 {
		t.Fatalf("want 1 usage row, got %d", len(sink.recorded))
	}
	got := sink.recorded[0]
	if got.Token != "424242" || got.UserID != "" || got.RelayedBytes != 7 || got.RecordedAt != 42 {
		t.Fatalf("unexpected record: %+v", got)
	}
}
```

删除 `TestWorkerSkipsUnknownToken`（"unknown token"概念已不存在）；`TestWorkerSkipsMalformedUsername`、`TestWorkerKeepsMaxPerAlloc` 保留（按需适配 fakeSink 字段）。

- [ ] **Step 2: 改 metering.go**

```go
// Sink is the subset of account.Store the worker needs.
type Sink interface {
	RecordUsage(ctx context.Context, e account.UsageEvent) error
}

func (w *Worker) handle(ctx context.Context, ev UsageEvent) {
	token := tokenFromUsername(ev.Username)
	if token == "" {
		w.Log.Printf("metering: skip alloc %s, malformed username %q", ev.AllocID, ev.Username)
		return
	}
	// Pairing codes are anonymous, so relay usage is recorded unattributed
	// (empty UserID): global relay accounting keeps working, per-user
	// attribution returns if/when signed-in users mint codes bound to their
	// account (deferred).
	rec := account.UsageEvent{
		AllocID:      ev.AllocID,
		Token:        token,
		UserID:       "",
		RelayedBytes: ev.RelayedBytes,
		RecordedAt:   w.Now(),
	}
	if err := w.Sink.RecordUsage(ctx, rec); err != nil {
		w.Log.Printf("metering: record alloc %s failed: %v", ev.AllocID, err)
	}
}
```

包注释同步改（"records it against the user who owns the transfer token" → "records it keyed by pairing code, unattributed"）。

- [ ] **Step 3: 删 account 包的 Transfer 机制**

- `store.go`: 删 `Transfer` struct（~56-66 行）及接口里的 `CreateTransfer`/`GetTransfer`（177-179 行连同 "transfers (cross-network rendezvous)" 注释）；`UsageEvent` 的注释（67-68 行）改为 "Recorded unattributed (empty UserID) since pairing codes are anonymous; kept for global relay accounting."
- `service.go`: 删 `CreateTransfer`（88-101）、`ValidateTransferToken`（103-115 附近）；`Config` 删 `TransferTTL` 字段。
- `sqlite.go`: 删 schema 里 `CREATE TABLE IF NOT EXISTS transfers`（51-56）与 `idx_transfers_user`（57）；删 `CreateTransfer`/`GetTransfer` 实现（325-340 附近）。在 `OpenSQLite` 的幂等迁移区（`download_count` ALTER 之后）加：

```go
	// The transfers table backed the retired share-link mode (one-time
	// rendezvous tokens). Dropping it is idempotent and safe: tokens lived
	// at most one hour, so nothing in an existing deployment still needs it.
	if _, err := db.ExecContext(context.Background(),
		`DROP TABLE IF EXISTS transfers`); err != nil {
		db.Close()
		return nil, err
	}
```

- `main.go`: 删 `TransferTTL: time.Hour,`。
- 测试文件按 **Files** 清单删对应用例。

- [ ] **Step 4: 测试 + 提交**

Run: `cd server && go test ./...`
Expected: PASS

```bash
git add server/internal/account server/internal/metering server/main.go
git commit -m "refactor(server): retire transfer tokens; meter relay usage anonymously"
```

---

### Task 6: web — outbox store 与 platform 模块，App 迁移

**Files:**
- Create: `web/src/lib/outbox.svelte.ts`
- Create: `web/src/lib/outbox.test.ts`
- Create: `web/src/lib/platform.ts`
- Modify: `web/src/App.svelte`（`pendingShared` → outbox；`isIOS`/`folderUploadSupported` → platform）

**Interfaces:**
- Produces: `outbox(): PickedFile[]`、`setOutbox(files: PickedFile[]): void`、`takeOutbox(): PickedFile[]`、`clearOutbox(): void`；`folderUploadSupported: boolean`、`isIOS(): boolean`。
- Consumes: `PickedFile`（`web/src/lib/drag.ts:31`）。

- [ ] **Step 1: 写 outbox.test.ts（先失败）**

```ts
import { describe, it, expect } from "vitest";
import { outbox, setOutbox, takeOutbox, clearOutbox } from "./outbox.svelte";

const pf = (name: string) => ({ file: new File(["x"], name) });

describe("outbox", () => {
  it("starts empty and holds what was set", () => {
    clearOutbox();
    expect(outbox()).toEqual([]);
    const files = [pf("a.txt"), pf("b.txt")];
    setOutbox(files);
    expect(outbox()).toEqual(files);
  });
  it("take drains atomically", () => {
    const files = [pf("a.txt")];
    setOutbox(files);
    expect(takeOutbox()).toEqual(files);
    expect(outbox()).toEqual([]);
    expect(takeOutbox()).toEqual([]);
  });
  it("clear empties", () => {
    setOutbox([pf("a.txt")]);
    clearOutbox();
    expect(outbox()).toEqual([]);
  });
});
```

Run: `cd web && npx vitest run src/lib/outbox.test.ts` — Expected: FAIL（模块不存在）

- [ ] **Step 2: 写 outbox.svelte.ts**

```ts
// Shared "files waiting for a peer" queue. Two producers fill it: the OS share
// sheet (share-target) and the pick-files-then-pair flow (CodePairing). App's
// auto-send effect drains it the moment exactly one peer is reachable, so the
// sender never has to re-pick after the connection comes up.

import type { PickedFile } from "./drag";

let files = $state<PickedFile[]>([]);

/** Reactive read of the queued files ([] when none). */
export function outbox(): PickedFile[] {
  return files;
}

/** Replace the queue (a fresh pick supersedes any stale leftovers). */
export function setOutbox(next: PickedFile[]): void {
  files = next;
}

/** Drain the queue atomically: returns the files and empties it, so two racing
 *  consumers can't double-send the same batch. */
export function takeOutbox(): PickedFile[] {
  const drained = files;
  files = [];
  return drained;
}

export function clearOutbox(): void {
  files = [];
}
```

Run: `cd web && npx vitest run src/lib/outbox.test.ts` — Expected: PASS

- [ ] **Step 3: 写 platform.ts（从 App.svelte 平移，逻辑不改）**

```ts
// Platform sniffs shared across components. Kept out of App so feature cards
// (e.g. the pairing card's folder button) can gate on them too.

/** iOS/iPadOS Safari has no folder picker (webkitdirectory is inert), so any
 *  "send folder" affordance just misbehaves there. iPadOS 13+ reports a Mac UA,
 *  so a touch-capable "Mac" is treated as iOS-like as well. */
export function isIOS(): boolean {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

export const folderUploadSupported = !isIOS();
```

- [ ] **Step 4: App.svelte 迁移**

逐处替换（行号为当前版本）：

1. imports 增加：`import { outbox, setOutbox, takeOutbox } from "./lib/outbox.svelte";`、`import { folderUploadSupported } from "./lib/platform";`
2. 删 `App.svelte:86` 的 `let pendingShared = $state<File[]>([]);`
3. `App.svelte:394-399` 的 `isIOS()` 函数与 `const folderUploadSupported = !isIOS();` 删除（改用 import）。
4. `App.svelte:223` onMount 里：

```ts
    drainSharedFiles().then((files) => {
      if (files.length) setOutbox(files.map((file) => ({ file })));
    });
```

5. 自动发送 effect（`App.svelte:197-203`）：

```ts
  // Queued files (OS share sheet, or picked before pairing) auto-send the
  // moment there's exactly one reachable device and nothing else in flight;
  // with several devices the user picks one (the peer cards become targets).
  $effect(() => {
    if (outbox().length && surfaceShown && !busy && visiblePeers.length === 1) {
      sendFiles(visiblePeers[0].id, takeOutbox());
    }
  });
```

6. 模板 `App.svelte:980-982`：`{#if pendingShared.length && …}` → `{#if outbox().length && visiblePeers.length !== 1}`，内容 `t.sharePending(outbox().length)`。
7. 模板 `App.svelte:1011` 的 pick input onclick 捷径：

```svelte
              <input id={`pick-${p.id}`} type="file" multiple disabled={busy}
                onclick={(e) => { if (outbox().length) { e.preventDefault(); sendFiles(p.id, takeOutbox()); } }}
                onchange={(e) => pickFile(e, p.id)} />
```

- [ ] **Step 5: 全量校验 + 提交**

Run: `cd web && npx vitest run && npm run check`
Expected: PASS / 0 errors

```bash
git add web/src/lib/outbox.svelte.ts web/src/lib/outbox.test.ts web/src/lib/platform.ts web/src/App.svelte
git commit -m "refactor(web): shared outbox for queued files; extract platform sniffs"
```

---

### Task 7: web — CodePairing 先选文件再配对

**Files:**
- Modify: `web/src/lib/CodePairing.svelte`
- Modify: `web/src/lib/i18n/types.ts`（`pair` 增加 `queued`、`bareConnect`）
- Modify: `web/src/lib/i18n/{zh,en,ja,ko,de,fr}.ts`
- Modify: `web/src/lib/CrossPage.svelte:27-36`（startOver 清空 outbox）

**Interfaces:**
- Consumes: Task 6 的 `outbox`/`setOutbox`/`clearOutbox`、`folderUploadSupported`、`pickedFromInput`（drag.ts）、`formatSize`（format.ts）。
- Produces: 选文件 → `setOutbox(picked)` → mint code → `enterRoom({code})`；对方加入后由 App 的 effect 自动发送（Task 6 已就位）。

- [ ] **Step 1: types.ts 的 pair 块新增两个 key**

```ts
  pair: {
    sendCode: string;
    enterCode: string;
    enterHint: string;
    joinBtn: string;
    yourCode: string;
    scanHint: string; // caption under the pairing-code QR
    waiting: string;
    queued: (n: number, size: string) => string; // files picked before pairing, auto-send on join
    bareConnect: string; // secondary: open a room without picking files (receiver-initiated flows)
    expiresIn: (s: string) => string;
    expired: string;
    copy: string;
    copied: string;
    copyLink: string; // copies the full join link for forwarding
    errExpired: string;
    mintFailed: string; // minting a fresh code failed (network/server), not expiry
    back: string; // return from code entry to the send/receive choice
  };
```

- [ ] **Step 2: 六语言补 key**（各文件 `pair` 块内、`waiting` 之后插入）：

zh：
```ts
    queued: (n, s) => `已选 ${n} 个文件 · ${s}，对方加入后自动发送`,
    bareConnect: "不选文件，仅创建连接",
```
en：
```ts
    queued: (n, s) => `${n} file(s) · ${s} — sends automatically once the other side joins`,
    bareConnect: "Create a connection without picking files",
```
ja：
```ts
    queued: (n, s) => `${n} 個のファイル · ${s} — 相手が参加すると自動送信されます`,
    bareConnect: "ファイルを選ばずに接続だけ作成",
```
ko：
```ts
    queued: (n, s) => `${n}개 파일 · ${s} — 상대가 참여하면 자동으로 전송됩니다`,
    bareConnect: "파일 없이 연결만 만들기",
```
de：
```ts
    queued: (n, s) => `${n} Datei(en) · ${s} — wird automatisch gesendet, sobald die Gegenseite beitritt`,
    bareConnect: "Nur verbinden, ohne Dateien auszuwählen",
```
fr：
```ts
    queued: (n, s) => `${n} fichier(s) · ${s} — envoi automatique dès que l'autre appareil rejoint`,
    bareConnect: "Créer une connexion sans choisir de fichiers",
```

- [ ] **Step 3: 改 CodePairing.svelte**

script 区新增 import 与逻辑（在现有基础上）：

```ts
  import { outbox, setOutbox, clearOutbox } from "./outbox.svelte";
  import { pickedFromInput } from "./drag";
  import { formatSize } from "./format";
  import { folderUploadSupported } from "./platform";
```

```ts
  const queuedBytes = $derived(outbox().reduce((n, p) => n + p.file.size, 0));

  // Files-first entry: pick files, then mint — the batch waits in the outbox
  // and App auto-offers it the moment the recipient joins the code room.
  async function pickAndSend(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const picked = input.files?.length ? pickedFromInput(input.files) : [];
    input.value = ""; // allow re-picking the same files
    if (!picked.length) return;
    setOutbox(picked);
    await send();
  }
```

`send()` 的 catch 里补一行（mint 失败时不能留下永不发送的队列）：

```ts
    } catch {
      busy = false;
      clearOutbox(); // no room to deliver into — a stale queue would surprise-send later
      err = t.pair.mintFailed;
    }
```

choose 分支模板（替换现有 `{:else}` 分支，第 137-143 行）：

```svelte
  {:else}
    <div class="choices">
      <label class="btn btn-primary" class:disabled={busy}>
        📄 {t.sendFile}
        <input type="file" multiple disabled={busy} onchange={pickAndSend} />
      </label>
      {#if folderUploadSupported}
        <label class="btn btn-primary" class:disabled={busy}>
          📁 {t.sendFolder}
          <input type="file" webkitdirectory multiple disabled={busy} onchange={pickAndSend} />
        </label>
      {/if}
      <button class="btn btn-ghost" onclick={() => (mode = "receive")}>{t.pair.enterCode}</button>
    </div>
    <button class="btn-link" disabled={busy} onclick={send}>{busy ? t.generating : t.pair.bareConnect}</button>
    {#if err}<p class="error">{err}</p>{/if}
  {/if}
```

minter 等待区（`{#if isMinter}` 分支内、QR 之后 `waiting` 之前）插入已选文件摘要：

```svelte
      {#if outbox().length}
        <p class="queued">{t.pair.queued(outbox().length, formatSize(queuedBytes))}</p>
      {/if}
```

timedOut 重新生成按钮（第 103 行）改为保留队列重 mint：

```svelte
    <button class="btn btn-primary" onclick={() => { timedOut ? void send() : (sessionStorage.removeItem(EXP_KEY), enterRoom({})); }}>{timedOut ? t.pair.sendCode : t.pair.enterCode}</button>
```

style 区追加：

```css
  .choices label.btn input[type="file"] { display: none; }
  .queued { margin: 0; font-size: var(--fs-xs); color: var(--text-h); text-align: center; }
```

- [ ] **Step 4: CrossPage.svelte 的 startOver 清空队列**

```ts
  import { clearOutbox } from "./outbox.svelte";
```

`startOver()` 内、`dismissLan?.()` 之前加：

```ts
    // Queued-but-unsent files belong to the abandoned pairing attempt — drop
    // them so they can't surprise-send to the next peer that appears.
    clearOutbox();
```

- [ ] **Step 5: 校验 + 提交**

Run: `cd web && npx vitest run && npm run check`
Expected: PASS / 0 errors

```bash
git add web/src/lib/CodePairing.svelte web/src/lib/CrossPage.svelte web/src/lib/i18n
git commit -m "feat(web): pick files first, then pair — auto-send when the peer joins"
```

---

### Task 8: web — 下线分享链接模式（token 通路前端全删）

**Files:**
- Delete: `web/src/lib/CrossNetwork.svelte`
- Modify: `web/src/lib/transfer-link.ts`（删 `parseTransferToken`/`buildTransferLink`/`createTransfer`；`wsURL` 去 token 参数）
- Modify: `web/src/lib/transfer-link.test.ts`
- Modify: `web/src/lib/room.svelte.ts`（只剩 code）
- Modify: `web/src/lib/router.svelte.ts:19`、`web/src/lib/router.test.ts`
- Modify: `web/src/lib/ice.ts`、`web/src/lib/ice.test.ts`
- Modify: `web/src/App.svelte`（roomToken 全删）
- Modify: `web/src/lib/CrossPage.svelte`（两卡布局）
- Modify: `web/src/lib/i18n/types.ts` + 六语言（crossnet 收缩、methods.share→methods.realtime）

**Interfaces:**
- Produces: `wsURL(loc, code = "")`；`fetchIceServers(code = "")`；`enterRoom({ code? })`；`roomCode()`（`roomToken` 消失）；`Messages.methods = { realtime: {name, sub, badge}; stored: {...} }`；`Messages.crossnet = { realtimeTitle; realtimeSub; realtimeFoot }`。

- [ ] **Step 1: 先改纯逻辑模块的测试（先失败）**

`transfer-link.test.ts`：删 `parseTransferToken`、`buildTransferLink`、`createTransfer` 三个 describe 与旧 `wsURL` describe；保留/改写为：

```ts
import { describe, it, expect } from "vitest";
import { wsURL, parseCodeParam } from "./transfer-link";

describe("wsURL", () => {
  const loc = { protocol: "https:", host: "relayium.com" };
  it("uses ?code= when a code is given", () => {
    expect(wsURL(loc, "424242")).toBe("wss://relayium.com/ws?code=424242");
  });
  it("is the LAN socket without a code, ws on http", () => {
    expect(wsURL(loc, "")).toBe("wss://relayium.com/ws");
    expect(wsURL({ protocol: "http:", host: "localhost:8080" }, "")).toBe("ws://localhost:8080/ws");
  });
});
```

（`parseCodeParam` 的 describe 原样保留。`createPair` 无现有用例，不新增。）

`ice.test.ts`：删所有 token 用例（`?room=` 相关 4 个），改为 code 版本：

```ts
  it("requests /api/ice with ?code= for a pairing code", async () => { /* fetchIceServers("424242") → "/api/ice?code=424242" */ });
  it("omits the query when no code", async () => { /* fetchIceServers("") → "/api/ice" */ });
```

fallback 三个用例把 `fetchIceServers("tok")` 改成 `fetchIceServers("424242")`。

`router.test.ts`：删 `#t=` 用例（14-18 行的 describe 项），`#c=` 用例保留。

- [ ] **Step 2: 运行确认失败**

Run: `cd web && npx vitest run src/lib/transfer-link.test.ts src/lib/ice.test.ts src/lib/router.test.ts`
Expected: FAIL

- [ ] **Step 3: 改纯逻辑模块**

`transfer-link.ts` 整体收缩为：

```ts
// Cross-network realtime rendezvous: a short pairing code minted anonymously
// via POST /api/pair. The join link carries it in the URL fragment
// (#c=<code>) so it never reaches server logs or the Referer header; anyone
// holding a live code can join its 2-peer room (capability model).

/** Error carrying the HTTP status of a failed mint. A thrown TypeError (fetch
 *  never reached the server) is left as-is and surfaces as a network error. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

/** Extract a 6-digit pairing code from a hash like "#c=424242". "" if none. */
export function parseCodeParam(hash: string): string {
  const m = /^#c=(\d{6})$/.exec(hash);
  return m ? m[1] : "";
}

/** Path of the cross-network page; join links and the originator both target it. */
export const CROSS_PATH = "/cross-network";

/** Path prefix of the public stored-download page: /d/<id>. Single source of truth. */
export const DOWNLOAD_PREFIX = "/d/";

/** Construct the signaling websocket URL: the code's 2-peer room, or with no
 *  code the LAN (IP-grouped) socket. */
export function wsURL(loc: { protocol: string; host: string }, code = ""): string {
  const proto = loc.protocol === "https:" ? "wss" : "ws";
  const base = `${proto}://${loc.host}/ws`;
  return code ? `${base}?code=${encodeURIComponent(code)}` : base;
}

/** Mint an anonymous short pairing code. No session required. */
export async function createPair(): Promise<{ code: string; expiresAt: number }> {
  const res = await fetch("/api/pair", { method: "POST" });
  if (!res.ok) throw new HttpError(res.status, `createPair failed: ${res.status}`);
  return res.json();
}
```

`room.svelte.ts`：

```ts
// Reactive cross-network "room" the page is currently in, driven by the URL
// fragment (#c=<code>). Entering a room updates both this state and the URL
// *without a page reload*; App reacts and rebinds the signaling socket.

import { parseCodeParam, CROSS_PATH } from "./transfer-link";

let code = $state("");

/** Reactive read of the active 6-digit pairing code ("" when none). */
export function roomCode(): string { return code; }

/** Seed the room from the current URL fragment (call once on load + on popstate). */
export function initRoomFromLocation(): void {
  code = parseCodeParam(location.hash);
}

/** Enter (or leave, with {}) a room: rewrite the URL fragment and update state.
 *  Uses replaceState so a plain tab switch elsewhere still drops the room, and
 *  never reloads — App's effect reconnects the socket. */
export function enterRoom(next: { code?: string }): void {
  const c = next.code ?? "";
  history.replaceState({}, "", `${CROSS_PATH}${c ? `#c=${c}` : ""}`);
  code = c;
}

/** Drop any active room without touching the URL — the caller owns navigation
 *  (used by the tab router, which sets its own pathname). */
export function clearRoom(): void { code = ""; }
```

`router.svelte.ts:19`：`if (parseCodeParam(hash)) return "cross";`（删 `parseTransferToken` import 与调用；文件头注释同步去掉 `#t=` 表述）。

`ice.ts`：

```ts
export async function fetchIceServers(code = ""): Promise<RTCIceServer[]> {
  const q = code ? `?code=${encodeURIComponent(code)}` : "";
  // …fetch/fallback 逻辑不变
}
```

头注释去掉 share-link token 表述。

- [ ] **Step 4: App.svelte 摘除 roomToken**

1. import 行：`roomToken as roomTokenStore` 删除；`const roomToken = $derived(…)` 删除（第 92 行）。
2. `onMount`（230-231）：`iceServers = await fetchIceServers(roomCode);`、`new SignalingClient(wsURL(location, roomCode), selfName)`。
3. `onClose`（242）：`if (roomCode && !joinedRoom) { linkDead = true; return; }`
4. `socketRoomKey`（253、306）：`socketRoomKey = roomCode;` / `const key = roomCode;`
5. `scheduleReconnect`（266）与 `switchRoom`（296、302）：`fetchIceServers(roomCode)`、`wsURL(location, roomCode)`。
6. 模板（1094）：`<CrossPage {roomCode} {linkDead} {showTransfer} {transferSurface} dismissLan={…} />`（去掉 `{roomToken}`）。

- [ ] **Step 5: CrossPage.svelte 两卡化**

1. props 去掉 `roomToken`；`const inRoom = $derived(!!roomCode);`
2. `startOver()` 删 `sessionStorage.removeItem("relayium_xfer_token");` 行及注释里对 CrossNetwork/ORIGIN_KEY 的提及。
3. 模板 `cards` 区替换为：

```svelte
  <div class="cards" class:single={showTransfer || inRoom}>
    {#if showTransfer && transferSurface}
      <!-- Active realtime transfer — one focused card, regardless of how they connected -->
      <section class="card focus">
        <h2>⚡ {t.crossnet.realtimeTitle}</h2>
        <p class="cardsub">{t.crossnet.realtimeSub}</p>
        {@render transferSurface()}
        <p class="foot">{t.crossnet.realtimeFoot}</p>
        <button class="startover" onclick={startOver}>{t.startOver}</button>
      </section>
    {:else if roomCode}
      <!-- In a code room (minter waiting, or recipient who joined via code/link) -->
      <section class="card focus">
        <div class="mhead"><h2>{t.methods.realtime.name}</h2></div>
        <p class="cardsub">{t.methods.realtime.sub}</p>
        <CodePairing {roomCode} expired={linkDead} />
        <button class="startover" onclick={startOver}>{t.startOver}</button>
      </section>
    {:else}
      <!-- Realtime direct + stored download link, side by side -->
      <section class="card">
        <div class="mhead"><h2>{t.methods.realtime.name}</h2><span class="badge ok">{t.methods.realtime.badge}</span></div>
        <p class="cardsub">{t.methods.realtime.sub}</p>
        <CodePairing />
      </section>

      <section class="card">
        <div class="mhead"><h2>{t.methods.stored.name}</h2><span class="badge">{t.methods.stored.badge}</span></div>
        <p class="cardsub">{t.methods.stored.sub}</p>
        {#if session().user}
          <StoredUpload />
        {:else}
          <div class="signin">
            <button class="btn btn-primary" onclick={() => (loginOpen = true)}>{t.account.signIn}</button>
          </div>
        {/if}
      </section>
    {/if}
  </div>
```

（`{#if linkDead && !roomCode}` 错误块删除；`import CrossNetwork` 删除；`.signin .hint` 若无引用连同 CSS 一起删。）
4. CSS：`.cards { grid-template-columns: repeat(2, 1fr); max-width: 900px; margin: 0 auto; }`（3 列改 2 列；760px 断点的单列规则保留）。`.badge.need` 规则已无使用，删除。

- [ ] **Step 6: 删除 CrossNetwork.svelte，收缩 i18n**

```bash
git rm web/src/lib/CrossNetwork.svelte
```

`types.ts`：

```ts
  crossnet: {
    realtimeTitle: string;
    realtimeSub: string;
    realtimeFoot: string;
  };
  methods: {
    realtime: { name: string; sub: string; badge: string };
    stored: { name: string; sub: string; badge: string };
  };
```

六语言同步：删除 crossnet 里 `sendAcross/loginFirst/shareHint/copy/copied/connecting/linkDead/sessionExpired/netError` 九个 key；`methods.pairing` + `methods.share` 合并为 `methods.realtime`，`realtimeFoot` 更新。各语言值：

zh：
```ts
  crossnet: {
    realtimeTitle: "实时直传",
    realtimeSub: "对方此刻在线 · 点对点直连 · 文件不经服务器",
    realtimeFoot: "免登录 · 登录后可用下载链接",
  },
  methods: {
    realtime: { name: "⚡ 实时直传", sub: "选好文件生成 6 位码，念码、发链接或扫码任选其一；对方加入即点对点直连、自动开始传输。", badge: "免登录" },
    stored: { name: "📦 下载链接", sub: "浏览器先加密再暂存，对方无需在线、无需登录，凭链接随时下载。", badge: "对方可离线" },
  },
```
en：
```ts
  crossnet: {
    realtimeTitle: "Realtime direct",
    realtimeSub: "Both online now · peer-to-peer · files never touch the server",
    realtimeFoot: "No sign-in needed · sign in to use download links",
  },
  methods: {
    realtime: { name: "⚡ Realtime direct", sub: "Pick your files and get a 6-digit code — read it out, send the link, or show the QR; the moment the other side joins, the transfer starts peer-to-peer.", badge: "No sign-in" },
    stored: { name: "📦 Download link", sub: "Your browser encrypts then stores; the recipient downloads anytime, no live session and no account needed.", badge: "Offline OK" },
  },
```
ja：
```ts
  crossnet: {
    realtimeTitle: "リアルタイム直接転送",
    realtimeSub: "両者が今オンライン · P2P · ファイルはサーバーを経由しません",
    realtimeFoot: "ログイン不要 · ログインでダウンロードリンクが使えます",
  },
  methods: {
    realtime: { name: "⚡ リアルタイム直接転送", sub: "ファイルを選ぶと6桁コードを発行。口頭で伝える・リンクを送る・QRを見せる、いずれでも相手が参加した瞬間にP2P転送が自動で始まります。", badge: "ログイン不要" },
    stored: { name: "📦 ダウンロードリンク", sub: "ブラウザで暗号化してから一時保存。受信者はオンラインもアカウントも不要で、いつでもダウンロードできます。", badge: "相手オフライン可" },
  },
```
ko：
```ts
  crossnet: {
    realtimeTitle: "실시간 직접 전송",
    realtimeSub: "양쪽 모두 온라인 · P2P · 파일은 서버를 거치지 않습니다",
    realtimeFoot: "로그인 불필요 · 로그인하면 다운로드 링크 사용 가능",
  },
  methods: {
    realtime: { name: "⚡ 실시간 직접 전송", sub: "파일을 고르면 6자리 코드가 생성됩니다. 코드를 불러주거나 링크를 보내거나 QR을 보여주세요. 상대가 참여하는 순간 P2P 전송이 자동으로 시작됩니다.", badge: "로그인 불필요" },
    stored: { name: "📦 다운로드 링크", sub: "브라우저에서 암호화한 뒤 임시 보관하며, 받는 사람은 접속도 계정도 필요 없이 언제든 다운로드합니다.", badge: "상대 오프라인 OK" },
  },
```
de：
```ts
  crossnet: {
    realtimeTitle: "Echtzeit-Direktübertragung",
    realtimeSub: "Beide jetzt online · Peer-to-Peer · Dateien berühren nie den Server",
    realtimeFoot: "Keine Anmeldung nötig · angemeldet für Download-Links",
  },
  methods: {
    realtime: { name: "⚡ Echtzeit-Direktübertragung", sub: "Dateien auswählen und einen 6-stelligen Code erhalten — vorlesen, als Link verschicken oder QR zeigen; sobald die Gegenseite beitritt, startet die Peer-to-Peer-Übertragung automatisch.", badge: "Ohne Anmeldung" },
    stored: { name: "📦 Download-Link", sub: "Dein Browser verschlüsselt und speichert zwischen; die empfangende Person lädt jederzeit herunter — ohne Sitzung, ohne Konto.", badge: "Auch offline" },
  },
```
fr：
```ts
  crossnet: {
    realtimeTitle: "Transfert direct en temps réel",
    realtimeSub: "Les deux en ligne · pair-à-pair · les fichiers ne passent jamais par le serveur",
    realtimeFoot: "Sans connexion · connectez-vous pour les liens de téléchargement",
  },
  methods: {
    realtime: { name: "⚡ Transfert direct en temps réel", sub: "Choisissez vos fichiers et obtenez un code à 6 chiffres — dictez-le, envoyez le lien ou montrez le QR ; dès que l'autre appareil rejoint, le transfert pair-à-pair démarre automatiquement.", badge: "Sans connexion" },
    stored: { name: "📦 Lien de téléchargement", sub: "Votre navigateur chiffre puis stocke temporairement ; le destinataire télécharge quand il veut, sans session ni compte.", badge: "Même hors ligne" },
  },
```

- [ ] **Step 7: 校验 + 提交**

Run: `cd web && npx vitest run && npm run check && npm run build`
Expected: 全部 PASS / 0 errors

```bash
git add -A web/src
git commit -m "feat(web): merge share-link mode into realtime pairing — one card, no sign-in"
```

---

### Task 9: web — 营销区文案随口径更新（六语言）

**Files:**
- Modify: `web/src/lib/i18n/{zh,en,ja,ko,de,fr}.ts`（howItWorks、compare.rows[0]、faq 两条、crossPitch、homeCross.desc）

组件（HowItWorks/ModeCompare/Faq）都是数据驱动渲染数组，条数变化无需改组件。

- [ ] **Step 1: howItWorks 三方式 → 两方式**

zh：
```ts
  howItWorks: {
    title: "跨网络，两种方式",
    sub: "不在同一个局域网也能传：对方在线就实时直传，不在线就留个下载链接。",
    ways: [
      { icon: "⚡", name: "实时直传", how: "双方都在线时，一方选好文件生成 6 位配对码——念码、发链接或扫二维码都能加入，加入即点对点直连并自动开始传输。免登录；打洞失败时经加密 TURN 中继转发，依然端到端加密。", tag: "文件不经服务器" },
      { icon: "📥", name: "下载链接", how: "浏览器先加密再上传，服务器只存密文。对方无需在线、无需登录，凭链接随时下载，可设有效期或阅后即焚。", tag: "仅存密文" },
    ],
  },
```
en：
```ts
  howItWorks: {
    title: "Two ways across networks",
    sub: "Not on the same LAN? Transfer in realtime when both are online, or leave a download link when they're not.",
    ways: [
      { icon: "⚡", name: "Realtime direct", how: "When both are online, one side picks files and gets a 6-digit code — read it out, send the join link, or show the QR. The moment the other side joins, a direct peer-to-peer transfer starts automatically. No sign-in; if hole-punching fails it falls back to an encrypted TURN relay, still end-to-end encrypted.", tag: "Files never touch the server" },
      { icon: "📥", name: "Download link", how: "Your browser encrypts before upload; the server stores only ciphertext. The recipient needs no account and no live session — they download anytime, with an expiry or burn-after-reading.", tag: "Ciphertext only" },
    ],
  },
```
ja：
```ts
  howItWorks: {
    title: "ネットワークをまたぐ2つの方法",
    sub: "同じLANにいなくても大丈夫。相手がオンラインならリアルタイム転送、いなければダウンロードリンクを。",
    ways: [
      { icon: "⚡", name: "リアルタイム直接転送", how: "双方がオンラインなら、一方がファイルを選んで6桁コードを発行。口頭で伝える・リンクを送る・QRを見せる、どれでも参加でき、参加した瞬間にP2P直結の転送が自動で始まります。ログイン不要。ホールパンチング失敗時は暗号化TURNリレーへ切り替わりますが、エンドツーエンド暗号化のままです。", tag: "ファイルはサーバーを経由しません" },
      { icon: "📥", name: "ダウンロードリンク", how: "アップロード前にブラウザ側で暗号化し、サーバーは暗号文しか保存しません。受信者はアカウントもリアルタイム接続も不要で、失効期限や閲覧後削除付きでいつでもダウンロードできます。", tag: "暗号文のみ" },
    ],
  },
```
ko：
```ts
  howItWorks: {
    title: "네트워크 간 전송의 두 가지 방법",
    sub: "같은 LAN이 아니어도 됩니다. 상대가 온라인이면 실시간 전송, 아니면 다운로드 링크를 남기세요.",
    ways: [
      { icon: "⚡", name: "실시간 직접 전송", how: "둘 다 온라인일 때 한쪽이 파일을 고르면 6자리 코드가 나옵니다. 코드를 불러주거나 링크를 보내거나 QR을 보여주면 되고, 상대가 참여하는 순간 P2P 직접 전송이 자동으로 시작됩니다. 로그인 불필요. 홀 펀칭 실패 시 암호화된 TURN 중계로 전환되지만 종단간 암호화는 유지됩니다.", tag: "파일은 서버를 거치지 않습니다" },
      { icon: "📥", name: "다운로드 링크", how: "브라우저가 업로드 전에 암호화하므로 서버는 암호문만 저장합니다. 받는 사람은 계정도, 실시간 연결도 필요 없이 언제든 다운로드하며, 만료 또는 열람 후 삭제를 적용할 수 있습니다.", tag: "암호문만 저장" },
    ],
  },
```
de：
```ts
  howItWorks: {
    title: "Zwei Wege über Netzgrenzen hinweg",
    sub: "Nicht im selben LAN? Übertrage in Echtzeit, wenn beide online sind — oder hinterlasse einen Download-Link, wenn nicht.",
    ways: [
      { icon: "⚡", name: "Echtzeit-Direktübertragung", how: "Sind beide online, wählt eine Seite Dateien aus und erhält einen 6-stelligen Code — vorlesen, als Link verschicken oder QR zeigen. Sobald die Gegenseite beitritt, startet die direkte Peer-to-Peer-Übertragung automatisch. Ohne Anmeldung; scheitert das Hole-Punching, wird auf ein verschlüsseltes TURN-Relay ausgewichen, weiterhin Ende-zu-Ende-verschlüsselt.", tag: "Dateien erreichen nie den Server" },
      { icon: "📥", name: "Download-Link", how: "Dein Browser verschlüsselt vor dem Upload; der Server speichert nur Chiffretext. Die empfangende Person braucht kein Konto und keine laufende Sitzung — sie lädt jederzeit herunter, mit Ablauf oder Löschen nach dem Lesen.", tag: "Nur Chiffretext" },
    ],
  },
```
fr：
```ts
  howItWorks: {
    title: "Deux façons de franchir les réseaux",
    sub: "Pas sur le même réseau local ? Transférez en temps réel si les deux sont en ligne, ou laissez un lien de téléchargement sinon.",
    ways: [
      { icon: "⚡", name: "Transfert direct en temps réel", how: "Quand les deux sont en ligne, un côté choisit ses fichiers et obtient un code à 6 chiffres — dictez-le, envoyez le lien ou montrez le QR. Dès que l'autre appareil rejoint, le transfert direct pair-à-pair démarre automatiquement. Sans connexion ; en cas d'échec du hole-punching, bascule vers un relais TURN chiffré, toujours chiffré de bout en bout.", tag: "Les fichiers ne passent jamais par le serveur" },
      { icon: "📥", name: "Lien de téléchargement", how: "Votre navigateur chiffre avant l'envoi ; le serveur ne stocke que du chiffré. Le destinataire n'a besoin ni de compte ni de session active — il télécharge quand il veut, avec expiration ou destruction après lecture.", tag: "Chiffré uniquement" },
    ],
  },
```

- [ ] **Step 2: compare.rows[0]（登录行）**

- zh: `{ label: "是否需登录", realtime: "免登录", stored: "发送方需登录" }`
- en: `{ label: "Sign-in needed", realtime: "No", stored: "Sender signs in" }`
- ja: `{ label: "ログインの要否", realtime: "不要", stored: "送信者はログインが必要" }`
- ko: `{ label: "로그인 필요", realtime: "불필요", stored: "보내는 사람이 로그인" }`
- de: `{ label: "Anmeldung nötig", realtime: "Nein", stored: "Sender meldet sich an" }`
- fr: `{ label: "Connexion requise", realtime: "Non", stored: "L'expéditeur se connecte" }`

- [ ] **Step 3: faq 两条（"连不上"与"要不要账号"）**

zh（items[1] 与 items[4]）：
```ts
      { q: "连不上 / 看不到对方怎么办？", a: "实时直传会先尝试点对点直连（STUN 打洞），失败时自动切换到加密 TURN 中继转发（中继也只经手密文，无法解密）。若仍然连不上，改用下载链接最稳妥——它是异步的，双方无需同时在线。" },
      { q: "一定要注册账号吗？", a: "实时直传（局域网与跨网络配对码/链接）完全免登录。只有下载链接需要发送方登录，用于暂存加密后的密文；接收方永远不需要账号。" },
```
en：
```ts
      { q: "What if it won't connect?", a: "Realtime transfers first try a direct peer-to-peer path (STUN hole-punching) and automatically fall back to an encrypted TURN relay when that fails (the relay only ever forwards ciphertext and cannot decrypt). Still stuck? A download link is the most reliable option — it's asynchronous, so both sides don't need to be online at once." },
      { q: "Do I have to create an account?", a: "Realtime transfers — on the LAN or across networks via a pairing code or its join link — need no sign-in at all. Only download links require the sender to sign in, so the encrypted ciphertext can be stored; recipients never need an account." },
```
ja：
```ts
      { q: "接続できない／相手が見えないときは？", a: "リアルタイム転送はまずP2P直結（STUNホールパンチング）を試み、失敗すると自動的に暗号化TURNリレーへ切り替わります（リレーも暗号文しか扱えず、復号できません）。それでもつながらない場合は、非同期で双方同時オンラインが不要なダウンロードリンクが最も確実です。" },
      { q: "アカウント登録は必須？", a: "リアルタイム転送（LAN、およびペアリングコード/参加リンクによるネットワーク間転送）は一切ログイン不要です。暗号文を一時保存するダウンロードリンクの作成時のみ送信者のログインが必要で、受信者にアカウントは一切不要です。" },
```
ko：
```ts
      { q: "연결이 안 되면 어떻게 하나요?", a: "실시간 전송은 먼저 P2P 직접 연결(STUN 홀 펀칭)을 시도하고, 실패하면 암호화된 TURN 중계로 자동 전환됩니다(중계는 암호문만 전달하며 복호화할 수 없습니다). 그래도 안 되면 비동기라서 양쪽이 동시에 접속할 필요가 없는 다운로드 링크가 가장 확실합니다." },
      { q: "반드시 계정을 만들어야 하나요?", a: "실시간 전송(LAN, 그리고 페어링 코드/참여 링크를 통한 네트워크 간 전송)은 로그인이 전혀 필요 없습니다. 암호문을 임시 보관하는 다운로드 링크를 만들 때만 보내는 사람의 로그인이 필요하며, 받는 사람은 계정이 전혀 필요 없습니다." },
```
de：
```ts
      { q: "Was, wenn keine Verbindung zustande kommt?", a: "Echtzeitübertragungen versuchen zuerst eine direkte Peer-to-Peer-Verbindung (STUN-Hole-Punching) und weichen bei Fehlschlag automatisch auf ein verschlüsseltes TURN-Relay aus (das Relay leitet nur Chiffretext weiter und kann nicht entschlüsseln). Immer noch nichts? Ein Download-Link ist am zuverlässigsten — er ist asynchron, sodass nicht beide Seiten gleichzeitig online sein müssen." },
      { q: "Muss ich ein Konto anlegen?", a: "Echtzeitübertragungen — im LAN oder netzübergreifend per Kopplungscode bzw. dessen Beitrittslink — brauchen überhaupt keine Anmeldung. Nur Download-Links erfordern, dass sich der Sender anmeldet, damit der verschlüsselte Chiffretext gespeichert werden kann; Empfänger brauchen nie ein Konto." },
```
fr：
```ts
      { q: "Que faire si ça ne connecte pas ?", a: "Les transferts en temps réel tentent d'abord une connexion directe de pair à pair (hole-punching STUN) et basculent automatiquement vers un relais TURN chiffré en cas d'échec (le relais ne transmet que du chiffré et ne peut pas déchiffrer). Toujours bloqué ? Un lien de téléchargement est le plus fiable — il est asynchrone, les deux parties n'ont donc pas besoin d'être en ligne en même temps." },
      { q: "Faut-il obligatoirement créer un compte ?", a: "Les transferts en temps réel — en réseau local ou entre réseaux via un code d'appairage ou son lien — ne nécessitent aucune connexion. Seuls les liens de téléchargement exigent que l'expéditeur se connecte, afin de stocker le chiffré ; les destinataires n'ont jamais besoin de compte." },
```

- [ ] **Step 4: crossPitch 与 homeCross.desc**

- zh: `crossPitch: "同一网络下用「局域网传输」更省事；不在同一网络，就用下面两种方式。"`；`homeCross.desc: "跨网络传输支持免登录的实时直传（码/链接/二维码）与加密下载链接，异地也能端到端加密。"`
- en: `crossPitch: "On the same network, “LAN transfer” is simplest; when you're apart, use one of the two ways below."`；`homeCross.desc: "Cross-network transfer offers sign-in-free realtime direct (code / link / QR) and encrypted download links — end-to-end encrypted, even across the world."`
- ja: `crossPitch: "同じネットワーク内なら「LAN転送」が最も簡単です。離れている場合は、下の2つの方法を使ってください。"`；`homeCross.desc: "ネットワークをまたぐ転送は、ログイン不要のリアルタイム直接転送（コード/リンク/QR）と暗号化ダウンロードリンクに対応。世界の反対側でもエンドツーエンド暗号化です。"`
- ko: `crossPitch: "같은 네트워크에서는 'LAN 전송'이 가장 간단합니다. 서로 떨어져 있을 때는 아래 두 가지 방법을 사용하세요."`；`homeCross.desc: "네트워크 간 전송은 로그인 없는 실시간 직접 전송(코드/링크/QR)과 암호화 다운로드 링크를 지원합니다 — 지구 반대편이라도 종단간 암호화로."`
- de: `crossPitch: "Im selben Netzwerk ist „LAN-Übertragung“ am einfachsten; seid ihr getrennt, nutze einen der zwei Wege unten."`；`homeCross.desc: "Netzübergreifende Übertragung bietet anmeldefreie Echtzeit-Direktübertragung (Code / Link / QR) und verschlüsselte Download-Links — Ende-zu-Ende-verschlüsselt, selbst um die halbe Welt."`
- fr: `crossPitch: "Sur le même réseau, le « transfert en réseau local » est le plus simple ; à distance, utilisez l'une des deux façons ci-dessous."`；`homeCross.desc: "Le transfert inter-réseaux offre un transfert direct en temps réel sans connexion (code / lien / QR) et des liens de téléchargement chiffrés — chiffré de bout en bout, même à l'autre bout du monde."`

- [ ] **Step 5: 校验 + 提交**

Run: `cd web && npx vitest run && npm run check`
Expected: PASS / 0 errors

```bash
git add web/src/lib/i18n
git commit -m "docs(web): marketing copy follows the merged two-mode story (6 locales)"
```

---

### Task 10: 对外口径修正 — README / llms.txt / SEO 内容源 / docs

**Files:**
- Modify: `README.md:53, 69, 191`
- Modify: `web/public/llms.txt`（行 3、9、14-15、17、30、36、41、57、62）
- Modify: `web/scripts/pages/content/legal/security.mjs:157`（及其英文对应句）
- Modify: `docs/DEPLOYMENT.md` / `docs/TESTING.md` / `docs/enable-turn.md` / `docs/coturn.md`（按 grep 结果）
- Regenerate: `cd web && npm run gen:pages`

**统一口径（所有语言按此表述）**：实时传输（局域网、跨网络配对码及其加入链接/二维码）全部免账号；只有「下载链接」（托管密文）需要发送方登录；配对码 15 分钟有效；「分享链接」不再作为独立模式出现。

- [ ] **Step 1: README 三处**

- 行 53：`- ⚡ **No install, ever** — just open a URL. All realtime transfers (LAN, pairing code, join link/QR) need **no account**; only stored download links require the sender to sign in.`
- 行 69 及行 191 的同类句子改成同一口径（`\* Realtime transfers need no account. Creating a **stored download link** requires the sender to sign in.`）。

- [ ] **Step 2: llms.txt**

将每一处 "share link" 独立模式的表述合并进 pairing code 模式；示例（行 14-15 合并为一条）：

```
- **Realtime — pairing code (cross-network):** one side picks files and gets a 6-digit code plus a join link and QR; the other enters the code or opens the link to connect directly across networks. No account, codes live 15 minutes.
```

其余各行（3、9、17、30、36、41、57、62）把 "creating a share link or a stored download link requires the sender to sign in" 统一改为 "only stored download links require the sender to sign in"；"pairing code or share link" 统一改为 "pairing code (or its join link)"。

- [ ] **Step 3: SEO 内容源**

```bash
grep -rn "share link\|分享链接\|sign in\|登录" web/scripts/pages/content/ | grep -i "share\|分享"
```

按 grep 结果逐处核对：`security.mjs:157` 的 "只有配对码与分享链接的会话才会获发中继凭证" → "只有配对码会话（含其生成的加入链接）才会获发中继凭证"，其英文对应句同理（"only pairing-code sessions (including their join links) are issued relay credentials"）。`compare-snapdrop.mjs`、`howto-*.mjs` 里 "pairing code or a share link / 配对码或分享链接" 改为 "pairing code (or the join link it generates) / 配对码（或它生成的加入链接）"——`howto-android-to-iphone.mjs:44` 已是该口径可不动。确认没有任何页面残留 "requires sign-in to create a share link" 类句子。

- [ ] **Step 4: docs/ 巡检**

```bash
grep -rn "api/transfers\|分享链接\|share link\|TransferTTL\|transfer token" docs/ --include="*.md"
```

命中处按新口径更新（尤其 `enable-turn.md`/`coturn.md` 若提到 token 计量，注明现为匿名记账）。

- [ ] **Step 5: 重新生成静态页并全文验证**

Run: `cd web && npm run gen:pages && grep -rn "requires the sender to sign in\|需要发送方登录" web/public | grep -i "share\|分享"`
Expected: grep 无输出（不再有"分享链接需登录"类残留）

- [ ] **Step 6: 提交**

```bash
git add README.md web/public docs web/scripts/pages/content
git commit -m "docs: copy follows merged realtime mode — no sign-in for any realtime transfer"
```

---

### Task 11: 端到端验证（/verify）

**Files:** 无代码改动；发现问题回上游 task 修。

- [ ] **Step 1: 全量套件**

Run: `cd server && go test ./... && cd ../web && npx vitest run && npm run check && npm run build`
Expected: 全绿

- [ ] **Step 2: 真机流程（本地起 server + 两个浏览器窗口/隐身窗）**

启动：`cd server && go run . -db <scratch>/dev.db -blob-dir <scratch>/blobs`，`cd web && npm run dev`。逐条走查：

1. **先选文件再配对**：窗口 A 跨网络页 →「📄 发送文件」选 2 个文件 → 出现 6 位码 + 链接 + QR + "已选 2 个文件"摘要 + 倒计时（≈15:00 起跳）。
2. **码加入自动发送**：窗口 B（隐身）「输入配对码」→ 输完 6 位自动连接 → B 立即收到接收确认卡（无需 A 再点任何按钮）→ 接受 → 传完校验文件一致。
3. **链接加入**：A 重新选文件生成码 → 复制链接在 B 打开 → 同样自动收到确认卡。
4. **仅创建连接（反向）**：A 点「不选文件，仅创建连接」→ B 输码加入 → B 从 peer 卡选文件发给 A，成功。
5. **Start over 清队列**：A 选文件生成码 → 点「← 重新选择」→ A 重新「仅创建连接」建新房，B 加入新房后**不**自动收到先前选过的文件（旧队列已被 startOver 清空）。（注：旧码在 TTL 内仍可被 B 加入，只会进入空房等待，属预期。）
6. **mint 失败路径**：停掉 server 后点「发送文件」→ 显示 mintFailed 错误、无残留队列（恢复 server 后重试正常）。
7. **旧分享链接**：手动访问 `/cross-network#t=deadbeef` → 落在正常方法选择页（无报错、无卡死）。
8. **/api/ice 回归**：`curl 'http://localhost:8080/api/ice?room=xyz'` → 仅 STUN；`curl -X POST http://localhost:8080/api/pair` 拿 code 后 `curl "http://localhost:8080/api/ice?code=<code>"` →（配置 TURN secret 时）含 TURN 凭证。
9. **登录 + 下载链接卡**：登录后托管上传流程不受影响；`/me` 统计正常显示。

- [ ] **Step 3: 收尾**

问题清零后，按 superpowers:finishing-a-development-branch 处理分支整合。
