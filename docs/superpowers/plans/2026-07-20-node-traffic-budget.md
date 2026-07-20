# 节点流量预算 + 单文件上限提升 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给官方节点的中继流量加"全局默认上限 + 每节点覆盖 + 90% 调度余量"，把单文件上限默认值提到 1 GiB，并钉住"盘满的节点仍可中继"这条语义。

**Architecture:** 流量侧完全复刻上一轮存储侧已验证的分层模式——中心端按 90% 收（调度口径，`turn.go` 选中继池时），节点本地 100% 黑洞（硬闸，`counter.go`）。新增一个全局设置项作为默认值，节点行里的 `0` 从"无限"改为"继承默认"。存储侧本轮不动。

**Tech Stack:** Go（`server/`，标准库 + SQLite）、`html/template`（管理员后台）。**本轮无前端改动。**

## Global Constraints

- Go 测试运行目录 `server/`，模块路径 `github.com/relayium/relayium`。
- **commit message 一律用英语**（subject 与 body）。代码注释跟随所在文件既有风格（`internal/account` 中英混用，跟随文件；`cmd/relayium-node` 全英文）。
- **90% 只用于中心端调度，节点本地硬闸保持 100%**。若节点本地也收到 90%，那 10% 缓冲就永远用不到了——它存在的意义正是给已建连会话吐完。
- **比例只定义一次**：`nodeTrafficHeadroomNum/Den` + `usableTraffic()`，任何地方不得再写 `* 9 / 10`。这与上一轮 `storageHeadroomNum/Den` + `usableBytes()` 是同一条纪律。
- **不引入"无限"哨兵值**（`-1` 之类）。节点 `0` = 继承全局默认；全局默认 `0` = 不限。
- **存储侧本轮零改动**：不碰 `usableBytes`、`StorageNodes` 的 70%、节点的 80% 整卷保留。
- 还原临时改动一律用 `cp` 备份，**禁用 `git checkout`**（上一轮有人因此冲掉未提交的工作）。
- 变异验证按**行号**定位并回显被改的那一行自证（上一轮有人用无 `/g` 的正则命中了别处同名代码，得出相反结论）。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `server/main.go` (修改) | `-max-file-size` 默认 50 MiB → 1 GiB；新增 `-node-traffic-default` flag |
| `server/internal/account/service.go` (修改) | `Config` 加 `NodeTrafficDefault` |
| `server/internal/account/settings.go` (修改) | 新增 setting key、`Settings` 字段、`resolveSettings` 接线 |
| `server/internal/account/nodes.go` (修改) | `resolveNodeTrafficLimit` + `nodeLimitsFor` 下发解析后的值 |
| `server/internal/account/turn.go` (修改) | 中继池按 `usableTraffic(生效上限)` 过滤 |
| `server/internal/account/admin.go` (修改) | 设置表单读写新字段；节点视图派生生效上限 |
| `server/internal/account/admin_templates.go` (修改) | 新设置输入框；列改名；中继列显示生效上限 |
| `server/internal/account/node_traffic_test.go` (新建) | 解析规则 + 90% 余量 + 下发值 |
| `server/internal/account/relay_independent_test.go` (新建) | 盘满的节点仍在中继池 |

---

### Task 1: 单文件上限默认值提到 1 GiB

**Files:**
- Modify: `server/main.go:103`
- Test: 无新增测试（见 Step 1 的说明）

**Interfaces:**
- Consumes: 无
- Produces: 无新符号

- [ ] **Step 1: 先找出依赖旧默认值的测试**

```bash
cd server && grep -rn "50 << 20\|50<<20\|52428800\|max-file-size\|MaxFileSize" --include="*_test.go" . | head -20
```

期望：列出所有可能对 50 MiB 有假设的测试。**这些测试大多显式设置自己的 `MaxFileSize`（如 `cloud_e2e_test.go:56` 用 `1 << 20`），不受 flag 默认值影响。** 若发现某个测试确实依赖 flag 默认值，在报告里列出并说明你如何处理。

- [ ] **Step 2: 改默认值**

`server/main.go:103`：

```go
	maxFileSize := flag.Int64("max-file-size", envInt64("RELAYIUM_MAX_FILE_SIZE", 1<<30), "stored-transfer max single-file size in bytes (default 1 GiB)")
```

- [ ] **Step 3: 构建并跑全量测试**

```bash
cd server && go build ./... && go test ./... 2>&1 | grep -E "FAIL|^ok" | tail -20
```

Expected: 全部 `ok`，无 FAIL。若有 FAIL，说明确实有测试依赖旧默认值——**不要为了让测试通过而改回默认值**，而是让那个测试显式声明自己需要的 `MaxFileSize`，并在报告里说明。

- [ ] **Step 4: 提交**

```bash
cd /Users/lily/code/relayium/relayium
git add server/main.go
git commit -m "feat(uploads): raise default max single-file size to 1 GiB

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 节点流量上限的全局默认值

**Files:**
- Modify: `server/internal/account/settings.go`（setting key、`Settings` 字段、`resolveSettings`）
- Modify: `server/internal/account/service.go:90` 附近的 `Config`
- Modify: `server/main.go`（新 flag + 传入 Config）
- Modify: `server/internal/account/nodes.go`（`resolveNodeTrafficLimit`）
- Test: `server/internal/account/node_traffic_test.go`（新建）

**Interfaces:**
- Consumes: 无
- Produces: `SettingNodeTrafficDefault`、`Settings.NodeTrafficDefault int64`、`Config.NodeTrafficDefault int64`、`func resolveNodeTrafficLimit(node Node, st Settings) int64` — Task 3/4 使用

- [ ] **Step 1: 写失败的测试**

新建 `server/internal/account/node_traffic_test.go`：

```go
package account

import "testing"

// 节点行里的 traffic_limit_bytes 语义：0 不再是"无限"，而是"继承全局默认"。
// 这条是本次的行为变更点——现存官方节点该字段大多是 0，改完后会立刻获得默认上限。
func TestResolveNodeTrafficLimit(t *testing.T) {
	const gib = int64(1) << 30
	st := Settings{NodeTrafficDefault: 1024 * gib} // 1 TiB

	cases := []struct {
		name string
		node Node
		st   Settings
		want int64
	}{
		{"节点单独配了值就用它", Node{TrafficLimitBytes: 500 * gib}, st, 500 * gib},
		{"节点配的值大于默认也用它", Node{TrafficLimitBytes: 3072 * gib}, st, 3072 * gib},
		{"节点为 0 时继承全局默认", Node{TrafficLimitBytes: 0}, st, 1024 * gib},
		// 全局默认为 0 = 整体不限流量，保留把这套机制关掉的能力。
		{"全局默认为 0 时不限", Node{TrafficLimitBytes: 0}, Settings{NodeTrafficDefault: 0}, 0},
		{"节点有值则不受全局 0 影响", Node{TrafficLimitBytes: 500 * gib}, Settings{NodeTrafficDefault: 0}, 500 * gib},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := resolveNodeTrafficLimit(c.node, c.st); got != c.want {
				t.Fatalf("resolveNodeTrafficLimit = %d, want %d", got, c.want)
			}
		})
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd server && go test ./internal/account/ -run TestResolveNodeTrafficLimit -v
```

Expected: 编译失败，`undefined: resolveNodeTrafficLimit`（以及 `Settings` 没有 `NodeTrafficDefault` 字段）

- [ ] **Step 3: 加 setting key 与 Settings 字段**

`server/internal/account/settings.go` 的 const 块末尾（`SettingDisableCentralFallback` 之后）加入：

```go
	// SettingNodeTrafficDefault 是官方节点每月中继流量的**默认**上限（字节）。
	// 节点自己的 traffic_limit_bytes 为 0 时继承它；节点有值则以节点为准。
	// 本身为 0 表示"未单独配置的节点不限流量"，保留整体关掉这套机制的能力。
	SettingNodeTrafficDefault = "node_traffic_default"
```

`Settings` 结构体末尾（`DisableCentralFallback` 之后）加入：

```go
	// NodeTrafficDefault 是官方节点月度中继流量的默认上限（字节）；0 = 不限。
	NodeTrafficDefault int64
```

`resolveSettings` 的返回值里加入：

```go
		NodeTrafficDefault:     s.settingOr(ctx, SettingNodeTrafficDefault, s.cfg.NodeTrafficDefault),
```

- [ ] **Step 4: 加 Config 字段与 flag**

`server/internal/account/service.go` 的 `Config` 里，`MaxFileSize int64 // bytes` 附近加入：

```go
	// NodeTrafficDefault 是官方节点月度中继流量的默认上限（字节）；0 = 不限。
	NodeTrafficDefault int64
```

`server/main.go` 在 `maxFileSize` 那行附近加入新 flag：

```go
	nodeTrafficDefault := flag.Int64("node-traffic-default", envInt64("RELAYIUM_NODE_TRAFFIC_DEFAULT", 1<<40), "default monthly relay-traffic cap per official node in bytes, 0 = unlimited (default 1 TiB)")
```

并在构造 `account.Config` 的地方（`main.go:318` 的 `MaxFileSize:` 附近）加入：

```go
			NodeTrafficDefault:   *nodeTrafficDefault,
```

- [ ] **Step 5: 加解析函数**

`server/internal/account/nodes.go`，在 `nodeLimitsFor` 之前插入：

```go
// resolveNodeTrafficLimit 给出一台节点本月真正生效的中继流量上限（字节）。
//
// 节点行里的 traffic_limit_bytes 为 0 表示"继承全局默认"，不再是"无限"——
// 这条语义在 2026-07 改过：官方节点默认应当有一个上限（出厂 1 TiB），管理员
// 想给某台机器单独放开就填一个大数，而不是靠 0。返回 0 仍表示不限，那只会在
// 全局默认也被设成 0（整体关掉这套机制）时发生。
func resolveNodeTrafficLimit(node Node, st Settings) int64 {
	if node.TrafficLimitBytes > 0 {
		return node.TrafficLimitBytes
	}
	return st.NodeTrafficDefault
}
```

- [ ] **Step 6: 运行测试确认通过**

```bash
cd server && go build ./... && go test ./internal/account/ -run TestResolveNodeTrafficLimit -v
```

Expected: 五个子用例全 `PASS`

- [ ] **Step 7: 提交**

```bash
cd /Users/lily/code/relayium/relayium
git add server/main.go server/internal/account/service.go server/internal/account/settings.go server/internal/account/nodes.go server/internal/account/node_traffic_test.go
git commit -m "feat(nodes): add a global default monthly relay-traffic cap

A node's own traffic_limit_bytes of 0 now means "inherit the global
default" rather than "unlimited". Official nodes should carry a cap by
default; an admin who wants one machine uncapped types a large number.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 90% 调度余量 + 下发解析后的上限

**Files:**
- Modify: `server/internal/account/nodes.go`（常量、`usableTraffic`、`nodeLimitsFor`）
- Modify: `server/internal/account/turn.go:145-155`
- Test: `server/internal/account/node_traffic_test.go`（追加）

**Interfaces:**
- Consumes: `resolveNodeTrafficLimit`（Task 2）
- Produces: `nodeTrafficHeadroomNum/Den`、`func usableTraffic(limit int64) int64` — Task 4 使用

- [ ] **Step 1: 写失败的测试**

在 `server/internal/account/node_traffic_test.go` 末尾追加：

```go
// 90% 是**调度**口径：中心端在节点跑到生效上限的 90% 时就不再把它发给新连接。
// 那 10% 不是浪费掉的额度，而是留给**已经建连**的会话吐完——流量检查发生在 ICE
// 建连那一刻，字节却在整个会话期间累积。节点本地仍在 100% 才黑洞出向流量。
func TestUsableTraffic(t *testing.T) {
	const gib = int64(1) << 30
	cases := []struct {
		name  string
		limit int64
		want  int64
	}{
		{"1 TiB 收到 900 GiB", 1024 * gib, 921 * gib + 972 * (gib / 1024)}, // 1024*0.9 = 921.6 GiB
		{"500 GiB 收到 450 GiB", 500 * gib, 450 * gib},
		{"不限时仍是 0", 0, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := usableTraffic(c.limit); got != c.want {
				t.Fatalf("usableTraffic(%d) = %d, want %d", c.limit, got, c.want)
			}
		})
	}
}
```

**实现者注意**：第一个用例的 `want` 表达式是我手算的，**请自己用 Go 验算 `1024*gib*9/10` 的确切值**并改成正确写法（可以直接写 `1024 * gib * 9 / 10`，但那样就与被测实现同源、失去鉴别力）。推荐写法：用一个不依赖被测常量的字面量。若算出来与我写的不符，以你算的为准并在报告里说明。

- [ ] **Step 2: 运行测试确认失败**

```bash
cd server && go test ./internal/account/ -run TestUsableTraffic -v
```

Expected: 编译失败，`undefined: usableTraffic`

- [ ] **Step 3: 加常量与辅助函数**

`server/internal/account/nodes.go`，在 `resolveNodeTrafficLimit` 之前插入：

```go
// 中继流量的调度余量：中心端只把生效上限的 90% 发出去，留 10% 给已经建连的
// 会话吐完。比例只在这里定义一次（与存储侧 storageHeadroomNum/Den 同纪律）。
const nodeTrafficHeadroomNum, nodeTrafficHeadroomDen = 9, 10

// usableTraffic 是中心端愿意排给一台节点的月度流量。limit <= 0（不限）时原样返回。
func usableTraffic(limit int64) int64 {
	if limit <= 0 {
		return limit
	}
	return limit * nodeTrafficHeadroomNum / nodeTrafficHeadroomDen
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd server && go test ./internal/account/ -run TestUsableTraffic -v
```

Expected: 三个子用例 `PASS`

- [ ] **Step 5: 中继池按 90% 过滤**

`server/internal/account/turn.go`，把第 138-152 行那段替换为（注意 `st` 的取得方式要与该函数内既有写法一致，若函数里已有 `s.resolveSettings(r.Context())` 就复用，没有就新取一次）：

```go
			// Per-node monthly traffic cap: withhold any fleet node that has
			// reached 90% of its effective cap. The 90% is a *scheduling*
			// reserve, not the hard stop — traffic is checked once at ICE time
			// but accrues for the whole session, so a node sitting at 99.9%
			// would still be handed out and then blow well past its cap. The
			// node's own 100% blackhole (counter.go overTraffic) is the hard
			// gate; this leaves it 10% to drain established sessions with.
			// Computed once per request; a read error fails open.
			monthStart, _ := monthRange(periodOf(now.Unix()))
			monthlyUsed, muErr := s.store.NodeRelayedSince(r.Context(), monthStart)
			if muErr != nil {
				log.Printf("ice: NodeRelayedSince read failed: %v (traffic caps not enforced this request)", muErr)
			}
			st := s.resolveSettings(r.Context())
			if nodes, err := s.store.OnlineNodes(r.Context(), since); err == nil {
				for _, n := range nodes {
					if n.ID == "" || n.TURNSecret == "" || len(n.URLs) == 0 || seen[n.ID] {
						continue
					}
					if cap := usableTraffic(resolveNodeTrafficLimit(n, st)); cap > 0 && monthlyUsed[n.ID] >= cap {
						continue // at/over the 90% scheduling reserve — withhold this node
					}
					relays = append(relays, relayEntry{ID: n.ID, Region: n.Region,
						ICEServers: []ICEServer{turnCredentials(n.TURNSecret, token, expiry, n.URLs)}})
					seen[n.ID] = true
				}
			} else {
				log.Printf("ice: OnlineNodes read failed: %v (static-only)", err)
			}
```

- [ ] **Step 6: 下发解析后的上限给节点**

`server/internal/account/nodes.go` 的 `nodeLimitsFor`：

```go
// nodeLimitsFor assembles a node's caps and month-to-date relayed total.
func (s *Service) nodeLimitsFor(ctx context.Context, node Node) nodeLimits {
	monthStart, _ := monthRange(periodOf(s.now().Unix()))
	relayed := int64(0)
	if m, err := s.store.NodeRelayedSince(ctx, monthStart); err == nil {
		relayed = m[node.ID]
	}
	return nodeLimits{
		// 下发**解析后**的上限：节点行里可能是 0（继承全局默认），直接发 0 会让
		// 节点以为自己不限流量，本地硬闸永远不触发。
		TrafficLimitBytes: resolveNodeTrafficLimit(node, s.resolveSettings(ctx)),
		DiskLimitBytes:    node.DiskLimitBytes,
		RelayedThisMonth:  relayed,
	}
}
```

同文件 `nodeLimits` 结构体的字段注释也要跟着改：

```go
	TrafficLimitBytes int64 `json:"trafficLimitBytes"` // resolved (node override or global default); 0 = unlimited
```

- [ ] **Step 7: 为这两处各补一条测试**

在 `node_traffic_test.go` 末尾追加。**先读 `internal/account` 包内既有的 handleICE 测试**（`grep -rln "handleICE\|/api/ice" internal/account/*_test.go`）找出构造服务器与请求的惯用手法，照它写，不要自己新造脚手架。

需要覆盖两条：
1. 一台 `traffic_limit_bytes = 0`、全局默认 1 TiB、本月已中继 950 GiB 的 fleet 节点，**不应**出现在 `/api/ice` 的 relays 里（950 > 921.6 = 90%）；同一台节点已中继 900 GiB 时**应当**出现。
2. `nodeLimitsFor` 对 `traffic_limit_bytes = 0` 的节点下发的是全局默认值而不是 0。

- [ ] **Step 8: 全量验证**

```bash
cd server && go build ./... && go vet ./... && go test ./... 2>&1 | grep -E "FAIL|^ok" | tail -20
```

Expected: 全 `ok` 无 FAIL

- [ ] **Step 9: 提交**

```bash
cd /Users/lily/code/relayium/relayium
git add server/internal/account/
git commit -m "feat(nodes): reserve 10% of a node's traffic cap for in-flight sessions

Central withholds a node from the relay pool at 90% of its effective cap.
The node's own 100% blackhole stays the hard gate: traffic is checked once
at ICE time but accrues for the whole session, so the 10% is what drains
already-established sessions rather than headroom thrown away.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 后台设置项与列名

**Files:**
- Modify: `server/internal/account/admin.go`（设置表单读写、`adminNodeView` 派生生效上限）
- Modify: `server/internal/account/admin_templates.go`（新输入框、列改名、中继列显示生效上限）
- Test: `server/internal/account/admin_usable_test.go` 或新建（见 Step 6）

**Interfaces:**
- Consumes: `SettingNodeTrafficDefault`、`resolveNodeTrafficLimit`、`usableTraffic`（Task 2/3）
- Produces: `adminNodeView.EffectiveTrafficLimitBytes int64`

- [ ] **Step 1: 设置表单加字段（读）**

`server/internal/account/admin.go:445` 附近（`MaxFileSizeMB: st.MaxFileSize / (1024*1024)` 那一带）加入：

```go
			NodeTrafficDefaultGB:   st.NodeTrafficDefault / (1024 * 1024 * 1024),
```

`server/internal/account/admin_templates.go:10` 附近的设置视图结构体加入：

```go
	NodeTrafficDefaultGB int64
```

- [ ] **Step 2: 设置表单加字段（写）**

`server/internal/account/admin.go:500` 附近，仿照 `storageCapMB` 的写法加入解析（**注意上限校验**，避免乘出 int64 溢出）：

```go
	nodeTrafficGB, ok9 := func() (int64, bool) {
		n, ok := enumi("node_traffic_default_gb")
		return n, ok && n <= maxConfigMB // 复用同一个上界，远超任何真实盘/流量规模
	}()
```

把 `ok9` 加进那个 `if !(ok1 && ... && ok8)` 的条件里，并在 `updates` 切片加入：

```go
		{SettingNodeTrafficDefault, nodeTrafficGB * 1024 * 1024 * 1024},
```

**实现者注意**：`enumi` 与 `atoi` 的语义差别请先读代码确认（一个可能允许 0、一个可能不允许）。这个字段**必须允许 0**（0 = 不限）。若 `enumi` 不允许 0，用允许 0 的那个，并在报告里说明。

- [ ] **Step 3: 设置区加输入框**

`server/internal/account/admin_templates.go:353` 附近（「单文件上限 (MiB)」那一带）加入：

```html
<label>节点默认流量上限 (GB/月，0=不限)<input type="number" name="node_traffic_default_gb" min="0" value="{{.Settings.NodeTrafficDefaultGB}}"></label>
```

- [ ] **Step 4: 节点视图派生生效上限**

`server/internal/account/admin.go` 的 `adminNodeView` 结构体，在 `TrafficLimitBytes` 之后加入：

```go
	// EffectiveTrafficLimitBytes 是这台节点真正生效的月度上限：节点自己配的值，
	// 或（为 0 时）全局默认。直接显示 TrafficLimitBytes 会让继承默认的节点显示
	// ∞，与实际行为矛盾。
	EffectiveTrafficLimitBytes int64
```

`nodeViews` 需要拿到 `Settings` 才能解析。**这会改变 `nodeViews` 的签名**——请找出它的所有调用点（`grep -rn "nodeViews(" internal/account/`）并全部更新。签名改为：

```go
func nodeViews(nodes []Node, monthly map[string]int64, now time.Time, st Settings) []adminNodeView
```

构造里加入：

```go
			EffectiveTrafficLimitBytes: resolveNodeTrafficLimit(n, st),
```

- [ ] **Step 5: 模板改名与显示生效上限**

`server/internal/account/admin_templates.go:277` 的表头，把 `<th>可用(70%)</th>` 改为：

```html
<th>可存储(70%)</th>
```

`:285` 的中继列，把 `{{if .TrafficLimitBytes}}{{bytes .TrafficLimitBytes}}{{else}}∞{{end}}` 改为用生效上限：

```html
<td>{{bytes .MonthRelayedBytes}} / {{bytes .RelayedBytes}} / {{if .EffectiveTrafficLimitBytes}}{{bytes .EffectiveTrafficLimitBytes}}{{else}}∞{{end}}</td>
```

`:296` 每节点输入框的 title 改为：

```html
<input type="number" name="traffic_limit_gb" min="0" value="{{gib .TrafficLimitBytes}}" title="流量上限 GB/月，0=用全局默认">
```

- [ ] **Step 6: 补测试**

需要覆盖三条（放在 `admin_usable_test.go` 或新建文件，你判断）：
1. `nodeViews` 对 `TrafficLimitBytes = 0` 的节点派生出全局默认值。
2. `nodeViews` 对有覆盖值的节点派生出该覆盖值。
3. **模板真的渲染了新列名与生效上限**。上一轮的教训：模板改动零覆盖时，字段名拼错能让 `/admin` 页面渲染到一半截断而测试全绿。请复用 `admin_official_nodes_ui_test.go` 里已有的手法（那个测试上一轮刚补过 `StorageEnabled` 与断言），断言渲染出的 HTML 含「可存储(70%)」且**不含**「可用(70%)」，以及含生效上限的渲染值。
   
   **注意子串碰撞**：上一轮栽过「`128.0 GiB` 包含 `28.0 GiB`」。用 `strings.Count(html, want) != 1` 而非 `Contains`，并确认 fixture 各值之间无包含关系。

- [ ] **Step 7: 全量验证**

```bash
cd server && go build ./... && go vet ./... && gofmt -l internal/account/ && go test ./... 2>&1 | grep -E "FAIL|^ok" | tail -20
```

Expected: `gofmt -l` 无输出；全 `ok` 无 FAIL

- [ ] **Step 8: 提交**

```bash
cd /Users/lily/code/relayium/relayium
git add server/internal/account/
git commit -m "feat(admin): configure the default node traffic cap; clarify column names

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 钉住「盘满的节点仍可中继」

**Files:**
- Test: `server/internal/account/relay_independent_test.go`（新建）

**Interfaces:**
- Consumes: `OnlineNodes`、`StorageNodes`、`handleICE`
- Produces: 无

**为什么需要这条测试**：中继与存储是两种独立能力。一台盘满的节点不能再接新文件，但网络带宽完全正常，应当继续中继。代码现在就是这样（`OnlineNodes` 完全不看磁盘），但**没有任何测试守着**——哪天有人觉得"盘满了就别用这台了"，顺手给 `OnlineNodes` 加个存储过滤，中继能力会静默丢失且无人报警。

- [ ] **Step 1: 写测试**

新建 `server/internal/account/relay_independent_test.go`。需要覆盖两条：

1. **存储层面确实排除**：一台 `StorageTotal = 18.3 GiB`、`StorageFree = 2 GiB` 的 fleet 节点（剩余 < 总量 20%），`StorageNodes` 返回的结果里**不含**它——证明这台节点在测试里确实是"盘满"状态，否则第 2 条就是空转。
2. **中继层面仍然包含**：同一台节点仍出现在 `OnlineNodes` 结果里，并且仍被 `/api/ice` 发进 relays。

先读既有测试找惯用手法：

```bash
cd server && grep -rln "OnlineNodes\|handleICE\|/api/ice" internal/account/*_test.go
```

照既有手法构造，不要自己新造脚手架。

测试里必须写清楚它守的是什么，例如：

```go
// 中继能力与磁盘状态无关：盘满的节点不能再接新文件，但带宽完全正常，必须继续
// 中继。这条测试存在的唯一理由是拦住"盘满了就别用这台了"这种顺手的过滤——
// 那会静默丢掉一整台机器的中继能力，而且不会有任何别的测试报警。
```

- [ ] **Step 2: 变异验证——这是本任务的核心交付**

给 `OnlineNodes` 的 SQL 加上一条存储过滤（模拟未来有人"顺手优化"）：

```sql
WHERE owner_type='fleet' AND last_seen_at >= ? AND (storage_total = 0 OR storage_free * 5 >= storage_total)
```

跑 `go test ./internal/account/ -count=1`，确认**新测试会失败**。把失败信息原文记进报告，然后从 `cp` 备份还原。

**如果不失败，说明测试没有牙齿，必须重写。**

- [ ] **Step 3: 提交**

```bash
cd /Users/lily/code/relayium/relayium
git add server/internal/account/relay_independent_test.go
git commit -m "test(nodes): pin that a disk-full node stays in the relay pool

Relay and storage are separate capabilities. Nothing guarded this, so a
plausible-looking "skip nodes whose disk is full" filter on OnlineNodes
would silently drop a whole machine's relay capacity with every test green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 收尾验证

- [ ] **全量**

```bash
cd server && go build ./... && go vet ./... && gofmt -l . && go test ./... 2>&1 | grep -E "FAIL|^ok" | tail -25
cd ../web && npm run check && npx vitest run 2>&1 | tail -5
```

Expected: Go 全 `ok`；`gofmt -l` 只列出既有的 `internal/selfupdate/selfupdate_test.go` 与 `internal/signal/guessbreaker_test.go`（分支外的存量问题，不要顺手改）；前端不受本轮影响，应当原样通过。

- [ ] **人工确认（部署后）**

1. 后台设置区出现「节点默认流量上限 (GB/月，0=不限)」，默认值 1024。
2. 节点表列名是「可存储(70%)」，中继列的上限位对未单独配置的节点显示 1 TiB 而非 ∞。
3. 给某台节点填 500，保存后该行上限显示 500 GiB。
4. **⚠️ 现存节点会立刻获得 1 TiB 上限**（此前是无限）。这是预期行为，不是回归。

---

## Self-Review 记录

- **Spec 覆盖**：spec 五节分别落在 Task 1（单文件上限）、Task 2（全局默认 + 解析规则）、Task 3（90% + 下发解析值）、Task 4（后台展示）、Task 5（中继独立性测试）。
- **符号一致性**：`SettingNodeTrafficDefault` / `Settings.NodeTrafficDefault` / `Config.NodeTrafficDefault` / `resolveNodeTrafficLimit` / `nodeTrafficHeadroomNum,Den` / `usableTraffic` / `adminNodeView.EffectiveTrafficLimitBytes` 在定义任务与消费任务中拼写一致。
- **已知待实现者确认项（已在对应步骤内标注，不是占位符）**：Task 3 Step 1 的 `1024*gib*9/10` 手算值需验算；Task 4 Step 2 的 `enumi` vs `atoi` 是否允许 0；Task 4 Step 4 的 `nodeViews` 调用点需全量更新。
- **签名变更的影响面**：`nodeViews` 加参数会波及其所有调用点（含测试），Task 4 Step 4 已明确要求 grep 并全部更新。
