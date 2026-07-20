# 管理员后台：高危操作步进认证 + 操作审计日志

日期：2026-07-20
状态：设计已确认，待实现

## 背景与动机

`/admin` 目前的安全模型是"一次登录，全程放行"：登录（密码+TOTP，或 passkey）后拿到 12 小时的会话 cookie，此后**任何写操作都不再校验任何东西**，只查 `isAdminReq`。

这带来两个问题：

1. **误点击无法挽回。** 后台一个表单能改掉全局配额、套餐价格、用户档位，点下去立刻生效，没有二次确认，也没有任何地方能看出"刚才改了什么"。
2. **完全没有审计线索。** 全库没有任何 audit/history 表；管理员 handler 里的 `log.Printf` 只记录失败诊断，**成功的变更一行都不记**。登录失败同样不记录——有人在撞密码也无从得知。

（`usage_events` / `upload_events` 这些是按用户计量字节的账本，不是操作日志，且 `gc.go:70` 会在约 25 小时后清掉 `upload_events`。）

## 关键洞察

**2FA 弹窗本身防不住误点击。** 人面对熟悉的验证码输入框会条件反射地填进去，不会重新审视自己要做什么。真正防误点的是**执行前把改动摊开展示**。

因此本设计把"确认页展示 diff"作为主要机制，2FA 是叠加在其上的第二道防线，而不是反过来。这也带来一个结构性好处：确认页需要的 diff 计算，和审计日志需要的 diff 计算是同一套逻辑，一次实现两处受益。

## 已确认的决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 验证粒度 | 只对高危操作 | 全量验证会被 TOTP 的 30 秒单调计数器锁死 |
| 高危范围 | 6 个端点（见下） | 按"出错后能否自行恢复"划分 |
| 步进因子 | passkey > TOTP > 重输密码 | passkey 无 30 秒限制；两者都没配时降级而非拒绝，避免把操作者锁在功能外 |
| 回滚方式 | 只记录，手动改回 | 自动撤销有真实陷阱（见"不做什么"） |
| 审计范围 | 全部写操作 + 登录事件 | 每条仅几百字节，成本可忽略 |
| 保留期 | 永久 | 审计日志的价值恰在于能查很久以前 |
| 架构 | 先预览再执行 | 唯一真正解决误点击的方案 |
| TOTP 连发 | 60 秒宽限期 | 确认页照常弹，只免重复掉码 |

## 高危操作的划分

**高危（需步进认证 + 确认页）：**

| 端点 | Handler | 为什么高危 |
|---|---|---|
| `POST /admin/settings` | `handleAdminSettings` | 10 个全局开关，一改立刻影响所有用户 |
| `POST /admin/plans` | `handleAdminUpsertPlan` | 套餐价格与配额，涉及计费 |
| `POST /admin/users/plan` | `handleAdminSetUserPlan` | 写入 `plan_source='admin'`，**该账号从此对 Stripe webhook 永久免疫**，等于摘出计费体系 |
| `POST /admin/nodes/{id}/delete` | `handleAdminDeleteNode` | 行被删除，不可逆 |
| `POST /admin/nodes/token` | `handleAdminMintToken` | 签发承载凭据 |
| `POST /admin/passkey/delete` | `handleAdminPasskeyDelete` | 移除登录凭据 |

**低危（不拦，但仍记日志）：** 改节点标签、改节点限额、废除 fleet token。这三项重新操作一次即可恢复。

**认证类端点不拦：** login / logout / passkey 的四个 ceremony 端点。拦截它们会造成自我死锁。

### 需要同步修改的既有注释

`passkey_register.go:136-138` 目前明确论证"删除 passkey 不需要步进认证，因为删自己的凭据只会把自己锁在外面"。本设计推翻该决定，**必须同步改写这段注释**，不能让代码与注释互相矛盾。

## 架构

### 步进认证流程

高危路由在 `RegisterAdmin` 中包一层中间件，保持声明式——从路由表一眼看出哪些受保护：

```go
mux.HandleFunc("POST /admin/settings", csrfGuard(s.requireStepUp("settings.update", s.handleAdminSettings)))
```

流程：

1. **拦截**：`requireStepUp` 先 `r.ParseForm()`，把已解析的表单值 + 目标动作名存入 `pendingActions`
2. **暂存**：仿照现有 `putCeremony`/`takeCeremony`——一次性消费、5 分钟 TTL、总量上限（防内存膨胀）
3. **算 diff**：调用该动作注册的 `beforeImage` 函数读当前值，与表单值比对
4. **渲染确认页**：改动清单（可读单位）+ 2FA 输入区
5. **验证**：passkey ceremony 或 TOTP 或密码，按可用性降级
6. **执行**：`takePending` 取出表单，塞回 `r.Form`，调用原 handler
7. **记账**：写 `admin_audit`

### pending token 必须绑定会话

**这是本设计最关键的安全约束。** 若 pending token 不绑定发起它的管理员会话，任何拿到 token 的人都能在另一个会话里兑现它，步进认证就被绕过了。

复用现有 ceremony 的 `kind` 标记机制（`passkey_login.go:41-46` 有一段注释精确描述了同类攻击：把未认证的 `login/begin` ceremony 拿到已认证的 `finish` 去花掉）。新增 `ceremonyStepUp` 常量。`putCeremony` 把 `kind` 设为必填参数，正是为了让任何调用点都铸不出无标记的 ceremony——沿用这个约束。

### 60 秒宽限期

步进验证成功后，会话上记 `lastStepUpAt`。60 秒内的高危操作跳过因子校验，**但确认页照常展示**。

这样防误点击的能力一点不打折（每次都要看 diff 并点确认），只是免去批量调参时反复掉码。

会话结构需要从 `map[string]int64`（token→过期时间）改成 `map[string]adminSession`（含过期时间、认证方式、`lastStepUpAt`）。插入点集中在 `admin.go:269-297` 加两个铸造点，改动面很小。

### 降级链

```
有 passkey        → passkey ceremony（无 30 秒限制，体验最好）
无 passkey，有TOTP → TOTP 验证码（受 60 秒宽限期保护）
两者都没有         → 重输管理员密码
```

最后一档安全增益几乎为零（同一个密码刚用来建的会话），但作为防误点击的摩擦仍然有效，且不会把只配了密码的自建者锁在功能外。确认页会明确提示"建议配置 2FA"。

## 数据模型

```sql
CREATE TABLE IF NOT EXISTS admin_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  actor      TEXT NOT NULL,
  ip         TEXT NOT NULL,
  auth       TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT NOT NULL,
  changes    TEXT NOT NULL,
  step_up    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit(at DESC);
```

- `actor`：恒为 `cfg.AdminUser`——管理员不是 `users` 表里的行，而是配置文件身份。真正有区分度的是 `ip` 和 `auth`。
- `auth`：**建立当前会话时**用的登录方式（`password` | `passkey`）。登录类事件记录本次尝试所用的方式。
- `step_up`：**本次操作**实际使用的步进因子，取值 `''` | `passkey` | `totp` | `password` | `grace`。它与 `auth` 是两回事——用 passkey 登录、用 TOTP 步进是完全正常的组合，两列分开才能如实还原当时发生了什么。空串表示该操作无需步进（低危操作）；`grace` 表示落在 60 秒宽限期内、跳过了因子校验。**把宽限期单独标出来，而不是记成"验过了"**，这样"这条变更究竟有没有当场验第二因子"在日志里一目了然。
- `action`：`settings.update` / `plan.upsert` / `user.plan` / `node.delete` / `node.limits` / `node.label` / `token.mint` / `token.revoke` / `passkey.delete` / `login.ok` / `login.fail` / `logout`
- `target`：`plan:plus` / `node:abc123` / `user:<id>` / `-`
- `changes`：JSON 数组 `[{"field":"storage_bytes","old":5368709120,"new":1073741824}]`

### changes 存储层原始值，不存展示值

表单提交的是 MB/GB/天，数据库存的是 bytes/secs。**必须在存储层做 diff**，展示时再转可读单位。混用单位早晚会出现"日志说改成了 5，实际是 5368709120"这类对不上的情况。

### 三条绝不记录的红线

1. **fleet token 明文**——只记 token id 与标签。明文仅在铸造时内联显示一次（`admin.go:735-736`），库里只存 `hashToken(raw)`。
2. **passkey 的 `cred_json` blob**——只记凭据 id、名称、创建时间。
3. **管理员密码**——任何形式，包括校验失败时的输入。

## diff 计算

每个受审计的动作注册一个 `beforeImage(ctx, r) (map[string]any, error)`：

- `settings`：`resolveSettings` 在渲染 `/admin` 时本就读过（`admin.go:425`），成本极低
- `plans`：handler 已在停用路径调用 `GetPlan`（`admin.go:649`），改为无条件调用即可
- `node.delete`：没有"新值"，记录完整的删除前快照
- 低危操作同样需要 —— **diff 逻辑必须能独立于确认页使用**

## 查看界面

`/admin` 目前是单页做完所有事。审计日志带分页，塞进去会让该页继续膨胀，因此新增独立路由 `GET /admin/audit`：倒序列表 + 按 action/日期过滤 + 分页。这是本设计新增的**唯一只读端点**。

## 明确不做什么（YAGNI）

- **不做"一键撤销"按钮。** 陷阱是真实的：回滚套餐价格时用户可能已按新价扣款；节点删除后行已不存在；连续改两次后跳着撤第一次会得到错误结果。要做就得逐类处理，成本远超收益。日志写清楚，手动改回，而手动改回本身也会被记入日志。
- **不做日志导出/告警。** 有需要再说。
- **不给低危操作加确认页。** 它们重做一次就能恢复，加摩擦不划算。
- **不改 CSRF 机制。** 现有的 Origin 校验（`handlers.go:54-76`）与本设计正交。注意它在 `Origin` 缺失时放行——这是既有问题，不在本次范围内，但值得单独记一笔。

## 测试策略

- **步进绕过**：pending token 在**另一个会话**中兑现必须失败（最关键的一条）
- **kind 混用**：`login/begin` 的 ceremony 拿到 step-up finish 必须失败，反之亦然
- **一次性消费**：同一个 pending token 兑现两次，第二次必须失败
- **TTL**：过期的 pending token 必须失败
- **降级链**：三种配置（有 passkey / 只有 TOTP / 都没有）各验一遍
- **60 秒宽限**：窗口内跳过因子校验但确认页仍出现；窗口外重新要求因子
- **TOTP 重放**：同一个码在步进中用第二次必须失败（现有单调计数器语义不能被破坏）
- **审计完整性**：6 个高危 + 3 个低危端点各产生恰好一条记录；`changes` 的 old/new 与实际库中的值一致
- **红线**：铸造 fleet token 后，审计表中**不得出现明文 token**（正向断言，不是靠人眼检查）
- **低危不拦**：改标签不弹确认页，但仍写日志

## 部署注意

- 新表通过既有 migration 列表创建，无数据回填需求
- 会话结构从 `map[string]int64` 改为结构体：**进程重启会清空所有管理员会话**（现在也是如此，因为本就是内存态），部署后需要重新登录
- 无需新配置项；降级链自动适配现有的 TOTP/passkey 配置状态
