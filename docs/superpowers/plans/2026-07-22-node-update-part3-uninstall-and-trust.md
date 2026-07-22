# 节点自动更新 · 第 3 部分：卸载与安全性说明 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**前置：第 1 部分必须已合并（卸载脚本要清理 `.prev` 备份）；第 2 部分建议已合并（卸载要清理 timer）。** 若第 2 部分未合并，Task 3 里清理 timer 的部分写成幂等的「存在才删」即可。

**Goal:** 让「不再当节点」有一条安全、不误删用户数据的退出路径，并把「为什么让我用 root 跑一条 curl 管道是合理的」讲清楚。

**Architecture:** 卸载分两阶段——先在 admin 把节点标记为排空（仍服务下载、不再接新上传），等文件自然过期后再跑卸载脚本。安全性说明落在已有的 BYO 指南页和安装脚本的收尾输出里。

**Tech Stack:** Go、shell、静态 HTML（9 语言）。

## Global Constraints

- 依据 spec：`docs/superpowers/specs/2026-07-22-node-auto-update-design.md` 第 8、9 节
- **卸载脚本默认不删存储目录。** 里面是别人的文件；只有显式 `RELAYIUM_NODE_PURGE_STORAGE=1` 才清。
- 每个文件只绑定一个 `NodeID`，**不做副本**——卸载一台存储节点等于永久销毁其上的文件。所有措辞都必须让这一点无法被误读。
- **blob 迁移不在本计划内**，明确留作独立功能。
- Go 注释英语，commit message 英语，用户可见文案按所在语言。

---

### Task 1: 节点排空标记

**Files:**
- Modify: `server/internal/account/nodes.go`（`Node` 加 `Draining bool` + 迁移）
- Modify: `server/internal/account/blobfor.go:57` 附近的投放查询
- Test: `server/internal/account/nodes_draining_test.go`

**Interfaces:**
- Produces: `Node.Draining bool`；`func (s *Service) SetNodeDraining(ctx context.Context, nodeID string, on bool) error`

- [ ] **Step 1: 写失败的测试**

新建 `server/internal/account/nodes_draining_test.go`。fixture 沿用
`blobfor_test.go:100` 的 `TestPlaceUploadPicksNodeOrFallsBack`（`newTestStore` +
手搭 `Service`）和 `files_directdl_test.go:20` 的 `newFileServer`：

```go
package account

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// Draining is the first half of a safe uninstall: stop feeding the node new
// files so the ones already on it can age out. Without this there is no moment
// at which the node is safe to remove — new files keep arriving.
func TestDrainingNodeReceivesNoNewUploads(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	s := &Service{store: st, now: func() time.Time { return time.Unix(1000, 0) },
		nodeHTTP: http.DefaultClient, cfg: Config{MaxFileSize: 1 << 20},
		pickN: func(n int) int { return 0 }}

	n, err := st.UpsertNode(ctx, Node{
		OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "t",
		StorageEnabled: true, StorageURL: "http://x:8081", StorageSecret: "ss",
		StorageFree: 100 << 30, CreatedAt: 1, LastSeenAt: 1000,
		Draining: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	id, _, billable, err := s.placeUpload(ctx, "nobody", 1<<10)
	if err != nil {
		t.Fatalf("placeUpload: %v", err)
	}
	if id == n.ID {
		t.Errorf("upload placed on draining node %q; it must be out of the pool", id)
	}
	if id != "" || !billable {
		t.Errorf("got node %q billable=%v, want the central fallback (\"\", true)", id, billable)
	}
}

// Draining must NOT break downloads: the files already on the node have to stay
// reachable for their full TTL — that wait is the entire point of draining.
func TestDrainingNodeStillServesExistingDownloads(t *testing.T) {
	ts, svc, store, _ := newFileServer(t)
	svc.SetDirectDownload(true)
	ctx := context.Background()
	owner, _ := store.UpsertUserByEmail(ctx, "drain@example.com", "")
	if _, err := store.UpsertNode(ctx, Node{
		ID: "drainingnode", OwnerType: "fleet", StorageEnabled: true,
		StorageURL: "https://internal.node", StorageSecret: "nodesecret",
		DownloadURL: "https://node7.relayium.com", CreatedAt: 1,
		LastSeenAt: time.Now().Unix(), Draining: true,
	}); err != nil {
		t.Fatal(err)
	}
	const fid, bkey = "drainfile", "drainbkey"
	if err := store.CreateStoredFile(ctx, StoredFile{
		ID: fid, UserID: owner.ID, BlobKey: bkey, EncManifest: []byte("m"), Size: 200,
		NodeID: "drainingnode", CreatedAt: 1, ExpiresAt: time.Now().Add(time.Hour).Unix(),
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
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("draining node returned %d for an existing file, want a 302 — draining is not offline",
			resp.StatusCode)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

```
cd server && go test ./internal/account/ -run Draining -v
```

- [ ] **Step 3: 实现**

`Node` 加 `Draining` 列；在 `blobfor.go` 挑选可投放节点的查询条件里加 `AND draining = 0`。
**不要**动下载路径——排空节点必须继续服务下载。

- [ ] **Step 4: 跑测试确认通过 + 全量**

```
cd server && go test ./internal/account/
```

- [ ] **Step 5: 提交**

```bash
git add server/internal/account/
git commit -m "feat(nodes): add a draining flag that stops new placements

Uninstalling a storage node destroys every file on it — each file binds to a
single NodeID and we keep no replicas. Draining is the safe first half: stop
feeding it new files so the existing ones can age out, while downloads keep
working for their full TTL."
```

---

### Task 2: admin 排空控制与倒计时

**Files:**
- Modify: `server/internal/account/admin.go`、`admin_templates.go`
- Test: `server/internal/account/admin_draining_test.go`

- [ ] **Step 1: 写失败的测试**——节点行显示 `Draining` 状态、其上剩余文件数、以及**最晚过期时间**（该节点上所有文件 `ExpiresAt` 的最大值，即最早可安全卸载的时刻）；点击切换排空后状态落库
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**——加一个 store 查询 `CountFilesOnNode(ctx, nodeID) (count int, maxExpiresAt int64, err error)`
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交**

---

### Task 3: 卸载脚本

**Files:**
- Create: `web/public/uninstall-node.sh`
- Test: `server/cmd/relayium-node/testdata/` 无需；用容器手测 + `shellcheck`

- [ ] **Step 1: 写脚本**

新建 `web/public/uninstall-node.sh`：

```sh
#!/bin/sh
# Relayium relay-node uninstaller.
#   curl -fsSL https://relayium.com/uninstall-node.sh | sudo sh
#
# THIS IS NOT THE UPGRADE PATH. Upgrades replace the binary in place and never
# touch your data — see `relayium-node update`. Uninstall is for "this machine
# is no longer a node", which is permanent.
#
# Optional:
#   RELAYIUM_NODE_PURGE_STORAGE=1  also delete the blob storage directory
#   RELAYIUM_NODE_FORCE=1          skip the "node still holds files" confirmation
set -eu

err() { echo "relayium-node-uninstall: $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || err "run as root (sudo)"

ENV_FILE=/etc/relayium-node/env
STATE_DIR=/var/lib/relayium-node
BIN=/usr/local/bin/relayium-node

STORAGE_DIR=""
CENTRAL_URL=""
NODE_TOKEN=""
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  STORAGE_DIR="${RELAYIUM_NODE_STORAGE_DIR:-}"
  CENTRAL_URL="${RELAYIUM_CENTRAL_URL:-}"
  NODE_TOKEN="${RELAYIUM_NODE_TOKEN:-}"
fi

# Uninstalling a storage node destroys the files on it: each file binds to one
# node and there are no replicas. Refuse to do that silently.
if [ -n "$STORAGE_DIR" ] && [ -d "$STORAGE_DIR" ]; then
  left=$(find "$STORAGE_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
  if [ "$left" -gt 0 ] && [ "${RELAYIUM_NODE_FORCE:-}" != "1" ]; then
    echo "This node still holds ${left} stored file(s)." >&2
    echo "They exist ONLY here — there are no replicas. Uninstalling now makes them" >&2
    echo "permanently unreachable for their owners." >&2
    echo "" >&2
    echo "Mark the node as draining in the admin panel first and wait for its files" >&2
    echo "to expire (up to 14 days), then re-run this script." >&2
    echo "To proceed anyway: RELAYIUM_NODE_FORCE=1" >&2
    exit 1
  fi
fi

# Tell central we're going away so it stops handing out this node and the admin
# list doesn't accumulate permanently-offline ghosts. Best effort.
if [ -n "$CENTRAL_URL" ] && [ -n "$NODE_TOKEN" ] && command -v curl >/dev/null 2>&1; then
  curl -fsS -X POST "${CENTRAL_URL}/api/nodes/deregister" \
    -H "Authorization: Bearer ${NODE_TOKEN}" >/dev/null 2>&1 \
    && echo "deregistered from ${CENTRAL_URL}" \
    || echo "could not reach central to deregister (continuing)" >&2
fi

for unit in relayium-node.service relayium-node-update.timer relayium-node-update.service; do
  if systemctl list-unit-files "$unit" >/dev/null 2>&1; then
    systemctl disable --now "$unit" >/dev/null 2>&1 || true
  fi
  rm -f "/etc/systemd/system/$unit"
done
systemctl daemon-reload

rm -f "$BIN" "${BIN}.prev"
rm -rf /etc/relayium-node "$STATE_DIR"

# The storage directory is other people's data; deleting it is opt-in only.
if [ -n "$STORAGE_DIR" ] && [ -d "$STORAGE_DIR" ]; then
  if [ "${RELAYIUM_NODE_PURGE_STORAGE:-}" = "1" ]; then
    rm -rf "$STORAGE_DIR"
    echo "purged storage directory ${STORAGE_DIR}"
  else
    echo "left storage directory ${STORAGE_DIR} in place (RELAYIUM_NODE_PURGE_STORAGE=1 to delete)"
  fi
fi

if id relayium-node >/dev/null 2>&1; then
  userdel relayium-node >/dev/null 2>&1 || true
fi

echo "relayium-node uninstalled."
```

- [ ] **Step 2: 语法与 lint**

```
cd /Users/lily/code/relayium/relayium && sh -n web/public/uninstall-node.sh && shellcheck -s sh web/public/uninstall-node.sh
```
预期：无输出（干净）

- [ ] **Step 3: 容器实测装→卸**

```
docker run --rm -it --privileged -v "$PWD:/src" debian:12 bash
# 容器内：装 systemd 有难度，至少验证脚本在缺少 systemd 时不崩、
# 且在 STORAGE_DIR 有文件时正确拒绝、FORCE=1 时继续。
```
最低验收：存储目录有文件 → 退出码 1 且不删任何东西；`RELAYIUM_NODE_FORCE=1` → 继续且
存储目录**仍在**；再加 `PURGE_STORAGE=1` → 存储目录被删。

- [ ] **Step 4: 加 `/api/nodes/deregister` 端点**

`server/internal/account/nodes.go`，照现有 node-token 鉴权模式加：把该节点标记为已移除
（不是物理删行——保留历史便于审计），并让它不再出现在投放池与 ICE 列表里。配套测试：
注销后该节点不再被 `blobfor` 选中、不再收到 302。

- [ ] **Step 5: 跑全量 + 提交**

```bash
cd server && go test ./...
cd .. && git add web/public/uninstall-node.sh server/internal/account/
git commit -m "feat(node): add an uninstaller and a deregister endpoint

Uninstall is not the upgrade path and the script says so up front. It refuses
to run while the node still holds files — they exist only there, so leaving
would make them permanently unreachable — and it never deletes the storage
directory unless explicitly told to, because that is other people's data."
```

---

### Task 4: 安装脚本收尾摘要

root 执行的那一刻就交代清楚做了什么，比藏在文档里强。

**Files:**
- Modify: `web/public/install-node.sh`

- [ ] **Step 1: 在脚本末尾（systemd 分支成功后）加输出**

```sh
  cat <<SUMMARY

  ── what this installer just did with your root ──────────────
   user      created system user 'relayium-node' (no shell, no home)
             the node runs as this user, never as root
   sandbox   ProtectSystem=strict, ProtectHome=yes, NoNewPrivileges,
             no capabilities; the only writable path is your storage dir
   units     relayium-node.service${AUTO_UPDATE_UNITS}
   ports     TURN ${RELAYIUM_NODE_TURN_PORT:-3478}/udp, storage ${RELAYIUM_NODE_STORAGE_PORT:-8081}/tcp${DL_PORT_NOTE}
   updates   ${AUTO_UPDATE_STATE}
   data      files stored here are end-to-end encrypted; this node holds no
             keys and cannot read what it stores
   remove    curl -fsSL ${RELAYIUM_CENTRAL_URL}/uninstall-node.sh | sudo sh

  Full details: ${RELAYIUM_CENTRAL_URL}/guides/bring-your-own-node
  ─────────────────────────────────────────────────────────────

SUMMARY
```

其中 `AUTO_UPDATE_STATE` 在开启时为
`enabled — central picks the version, the binary is signature-verified (RELAYIUM_NODE_AUTO_UPDATE=off to disable)`，
关闭时为 `disabled`。

- [ ] **Step 2: `sh -n` + `shellcheck` + 实跑一次看排版**
- [ ] **Step 3: 提交**

---

### Task 5: BYO 指南新增安全性一节（9 语言）

**Files:**
- Modify: `web/public/guides/bring-your-own-node/index.html` 及
  `web/public/{zh,ja,ko,fr,de,es,pt,ar}/guides/bring-your-own-node/index.html`

- [ ] **Step 1: 先写英文版**

在 `web/public/guides/bring-your-own-node/index.html` 加一节
「Is it safe to run this installer as root?」，六个论点（照 spec 第 9 节）：

1. root 只存在于安装的那几秒——建用户、装 unit；装完立刻降权
2. 表格：每条加固指令挡住了什么（从 `docs/node-hardening.md` 的速查表搬）
3. 自动更新只下发版本号；二进制由节点用**编译进自己二进制里**的公钥验 ECDSA 签名——
   中央被攻破也变不出能通过验签的二进制
4. 更新器与节点是两个进程：有 root 的只做更新，笼子里的永远无权改二进制
5. 存的是端到端加密的密文，节点没有密钥
6. 能关（`RELAYIUM_NODE_AUTO_UPDATE=off`）也能走（一行卸载）

并明确写：**BYO 节点与官方机队节点跑的是同一套代码、同一套加固，唯一差别是机器归谁。**

- [ ] **Step 2: 人工核对英文版每条陈述都与代码相符**

逐条对照：`install-node.sh` 的 `useradd` 与 unit 内容、`docs/node-hardening.md` 的表、
`internal/selfupdate/release_pubkey.go` 的嵌入公钥、第 2 部分 Task 7 的两个 unit。
**任何一条对不上就改文案，不要改代码去迁就文案。**

- [ ] **Step 3: 翻译到其余 8 语言**

`zh, ja, ko, fr, de, es, pt, ar`。**ar 是 RTL**——照该页现有的逻辑属性/`dir` 机制处理，
不要引入新的方向性样式。

- [ ] **Step 4: 9 个页面逐一在浏览器打开检查**（含 ar 的 RTL 排版）

- [ ] **Step 5: 提交**

```bash
git add web/public/guides/
git commit -m "docs(guides): explain what running the node installer as root does

BYO nodes run the same code and the same hardening as our own fleet; the only
difference is whose machine it is. Spell out that root exists only for the few
seconds of install, what each sandbox directive blocks, why central can only
name a signed version rather than push code, and how to turn updates off or
remove the node entirely."
```

---

### Task 6: 运维文档

**Files:**
- Modify: `docs/node-hardening.md`（加卸载一节 + 两个 unit 的说明）
- Modify: `docs/direct-download-deploy.md`（加「换机器/下线节点」流程）

- [ ] **Step 1: 写「下线一台节点」的完整 runbook**：admin 标记排空 → 看倒计时 → 到期 → 跑卸载脚本 → 确认 admin 里已注销
- [ ] **Step 2: 明确写出「更新不需要这套流程」**，并解释为什么（磁盘数据不受重启影响）
- [ ] **Step 3: 提交**

## 本计划的交付物

一条安全的节点退出路径（不会误删别人的文件、不会留幽灵节点），以及一份能让人放心把
`| sudo sh` 敲下去的说明。

## 明确不做

**blob 迁移**（把文件搬到另一台节点再改 `NodeID`）——需要节点间传输、一致性与失败回
滚，比自动更新本身还大。排空+等待对 14 天 TTL 够用。留作独立功能。
