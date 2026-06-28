# Relayium 账号地基（Spec ①）设计文档

- 日期：2026-06-28
- 状态：待评审
- 代号：Project Relay / Relayium
- 里程碑：M2a 的第一份 spec（账号地基）。第二份「跨网络传输」依赖本份。

## 1. 背景与定位

局域网传输（M0）已完成。下一步是**跨网络传输**——而跨网会通过 TURN 中继产生真实带宽成本，
短期免费、长期收费。因此需要一个**账号系统**作为「认证 + 计量 + 计费」的锚点。

把跨网这一摊拆成两份独立 spec：

- **本份 ①「账号地基」**：账号、登录、最小设备注册表。纯增量，不碰传输层，**局域网无登录
  路径完全不受影响**。
- **② 跨网络传输**（后续）：令牌房间信令、ICE/TURN 凭据、分享链接 / 受信设备两种寻址、
  中继字节计量。依赖本份的会话与设备注册表。

### 1.1 设计红线：账号不破坏 E2E 与隐私叙事

账号系统**只负责会合、认证、计量**，**绝不接触文件内容、文件名或会话密钥**。现有 E2E
（crypto_kx + AES-256-GCM + SAS）与传输/帧层在本份 spec 中**完全不改动**。账号关联的信息
保持最小：邮箱（或 OAuth 主体标识）、设备昵称、在线与否——不记录传了什么。

### 1.2 范围边界（重要）

**本份做：** Google OAuth + 邮箱 magic link 登录；会话（可吊销）；最小 `users` / `devices`
注册表；登录/登出 UI；未登录仍可用局域网传输。

**本份不做（明确推迟）：** 信令改动、TURN、跨网传输、计费/订阅、配额强制、持久设备密钥 /
免 SAS、CLI 的 device token、设备管理 UI 精修、Postgres。

## 2. 技术选型（已拍板）

- **后端落点**：复用现有 Go 服务器，在**同一个二进制**内新增 HTTP 路由，守住「单二进制 +
  轻量」气质。
- **存储**：**SQLite**（嵌入、零额外运维）。所有数据访问走一层薄 `Store` 接口，将来数据量
  上来可迁 Postgres，业务代码不改。
- **登录方式**：**Google OAuth** + **邮箱 magic link**（OAuth 图方便；magic link 给不愿用
  Google 的隐私用户留退路）。
- **会话机制**：`httpOnly + Secure + SameSite=Lax` 会话 Cookie，配 DB `sessions` 表（服务端
  可吊销）。**不在 JS 里存 JWT**。未来 CLI 的 device token 另行设计。
- **发信**：抽象成 `Mailer` 接口，v1 实现走 SMTP 或事务邮件 API（如 Resend），可配置。

## 3. 架构与组件

```
现有：  [Browser SPA] ──WS──> [Go 信令 hub] （局域网传输，不动）
新增：  [Browser SPA] ──HTTPS──> [Go HTTP 路由 (新)]
                                   ├─ Auth 处理器  (OAuth / magic link / session)
                                   ├─ Account 处理器 (/me, /devices)
                                   ├─ Mailer 接口  (SMTP / Resend)
                                   └─ Store 接口   ──> SQLite (users/sessions/magic_tokens/devices)
```

组件职责单一、可独立测试：

- **Store（接口）**：CRUD 数据访问，唯一触碰 SQLite 的地方。便于 mock 与将来换库。
- **Auth 处理器**：登录全流程，签发/校验/吊销会话。
- **Account 处理器**：`/me`、设备列表与增删。
- **Mailer（接口）**：只负责发 magic link 邮件。
- **前端 auth 模块**：登录入口、账号菜单、`/me` 状态；与现有传输 UI 解耦。

## 4. 数据模型（SQLite）

```sql
users(
  id            TEXT PRIMARY KEY,      -- 随机 ID
  email         TEXT UNIQUE NOT NULL,  -- OAuth 或 magic link 的邮箱（小写归一）
  display_name  TEXT,
  created_at    INTEGER NOT NULL
)

-- OAuth 主体与 user 的映射（一个 user 可绑多个 provider，同邮箱归并）
identities(
  provider      TEXT NOT NULL,         -- 'google' | 'email'
  subject       TEXT NOT NULL,         -- provider 内的唯一标识（google sub / 邮箱）
  user_id       TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (provider, subject)
)

sessions(
  id            TEXT PRIMARY KEY,      -- 高熵随机串，存在 cookie 里
  user_id       TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked       INTEGER NOT NULL DEFAULT 0
)

magic_tokens(
  token_hash    TEXT PRIMARY KEY,      -- 存哈希而非明文 token
  email         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,      -- 短时效（如 15 分钟）
  used_at       INTEGER                -- 一次性，用过即作废
)

devices(
  id            TEXT PRIMARY KEY,      -- 浏览器侧持久保存以便再次识别
  user_id       TEXT NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,         -- 默认取设备名，可改
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
)
```

> 注：`devices` 在本份只做静态注册（注册/列出/改名/删除）。**在线状态/会合属于 Spec ②**，
> 由信令层维护，不在本份建模。

## 5. API 设计

所有响应 JSON；鉴权接口要求有效会话 Cookie。

| 方法 & 路径 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/auth/google/start` | 否 | 重定向到 Google 同意页（带 state，防 CSRF） |
| `GET /api/auth/google/callback` | 否 | 校验 code/state → upsert user/identity → 建会话 → set-cookie → 跳回首页 |
| `POST /api/auth/magic/request` | 否 | body `{email}` → 生成一次性 token、发邮件。无论邮箱是否存在都返回 200（防枚举） |
| `GET /api/auth/magic/verify` | 否 | query `?token=` → 校验未过期/未用 → upsert user → 建会话 → set-cookie → 跳回首页 |
| `POST /api/auth/logout` | 是 | 吊销当前会话、清 cookie |
| `GET /api/me` | 是 | 返回 `{user, currentDevice}`；未登录返回 401 |
| `GET /api/devices` | 是 | 列出本账号设备 |
| `POST /api/devices` | 是 | 注册/认领当前浏览器为设备：body `{id?, name}`；返回设备记录 |
| `PATCH /api/devices/:id` | 是 | 改名 |
| `DELETE /api/devices/:id` | 是 | 删除设备 |

**设备认领流程**：浏览器在 `localStorage` 存一个本地生成的 `deviceId`。登录后前端调
`POST /api/devices`（带该 id 与默认设备名）；服务端 upsert 到当前 user 名下。再次登录时
同一浏览器复用同一条设备记录。

## 6. 前端改动

- 新增 `auth.svelte.ts`：会话状态（runes），封装 `/api/me`、登录、登出。
- 顶部新增账号区：未登录显示「登录」（弹 Google / 邮箱两种入口）；已登录显示头像/邮箱 +
  登出。
- **局域网传输 UI 与流程零改动**：未登录照常可用。账号只是多出来的一块。
- 复用现有 i18n（6 语言）补登录相关文案。

## 7. 安全考量

- **会话 Cookie**：`httpOnly + Secure + SameSite=Lax`；服务端可吊销；设合理过期。
- **OAuth**：校验 `state` 防 CSRF；只取邮箱 + sub，不要多余 scope。
- **Magic link**：token 高熵、存哈希、短时效、一次性；请求接口对存在/不存在邮箱返回一致
  响应防枚举；对发信做限频。
- **邮箱归一**：统一小写，避免重复账号；Google 与 magic link 同邮箱归并到同一 user。
- **限频**：magic link 请求、登录回调按 IP/邮箱限频，防滥用。
- **隐私**：除邮箱与设备昵称外不存额外 PII；不记录传输内容。

## 8. 错误处理

- 未登录访问鉴权接口 → 401，前端引导登录。
- Magic link 过期/已用/无效 → 友好提示「链接已失效，请重新获取」。
- OAuth 失败/取消 → 跳回首页并提示，不留半截会话。
- 发信失败 → 对用户提示稍后重试；记录服务端日志。
- DB 不可用 → 账号功能降级报错，但**局域网传输不受影响**（信令 hub 与 DB 解耦）。

## 9. 测试策略

- **单元（Go）**：
  - `Store`：users/identities/sessions/magic_tokens/devices 的 CRUD 与约束（用内存 SQLite）。
  - Magic token：生成→校验→一次性失效→过期失效。
  - 会话：建立、校验、吊销、过期。
  - 邮箱归一与同邮箱跨 provider 归并。
- **处理器层**：用 `Mailer`/`Store` 的 mock 测各 API 的鉴权、状态码、防枚举一致响应。
- **前端**：`auth.svelte.ts` 的状态流（已/未登录）；登录组件渲染。
- **回归**：现有 transfer/crypto/signaling 测试不动，确认账号是纯增量。

## 10. 交付边界回顾

完成标准：用户能用 Google 或邮箱登录、登出；登录后当前浏览器被注册为一台可改名/删除的
设备；未登录用户的局域网传输体验与现在**完全一致**。计费、配额、跨网、TURN、持久设备密钥、
CLI 均**不在本份**。
