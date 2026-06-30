# 桌面整页拖拽发送 — 设计文档

日期：2026-06-30
状态：已批准，待写实现计划

## 目标

桌面端把文件拖到浏览器窗口**任意位置**即可发送给实时对端，不必精准拖到某张设备卡片上。
覆盖最高频的"只有一台对端设备"场景做到零选择。

## 既有事实

- 当前拖放仅作用于单张设备卡片：`App.svelte` 的每个 peer `<li>` 有 `ondragover/ondragleave/ondrop`，
  `onDrop(e, peerId)` → `sendFiles(peerId, files)`。没有窗口级拖放。
- 实时传输界面（设备列表 + 进度卡）已抽成 `transferSurface` snippet，在 LAN 页与跨网络页（连上对端时）都渲染。
- `App.svelte` 持有 `visiblePeers`（已排除自己）、`busy`（有进行中的收发/待确认）、`sendFiles(peerId, files)`、`flash(msg)`。
- 跨网络页：连上实时对端（`showTransfer`）时「存储链接」上传卡已隐藏（`{#if !inRoom}`），故二者落点不冲突。

## 交互规则

激活条件：拖入窗口的是**文件**（`dataTransfer.types` 含 `"Files"`）、当前 `visiblePeers.length >= 1` 且 `!busy`。

落下行为，由纯函数 `dropTarget(peerCount, busy)` 决定：
- `busy` 或 `peerCount === 0` → `off`：不激活，浮层不出现，落点交还页面（不抢「存储链接」上传卡的落点）。
- `peerCount === 1` → `send`：拖到窗口任意处落下即发给该唯一设备。
- `peerCount > 1` → `pick`：浮层提示"拖到某台设备上发送"，设备卡片高亮；**空白处落下不发**，需落到具体卡片（复用现有卡片拖放）。

两个页面通用：LAN 页（有设备时）、跨网络页（连上对端时，此时存储卡已隐藏）。

## 组件与实现

### 纯逻辑（可测）
- 新文件 `web/src/lib/drag.ts`：
  - `hasFiles(types: readonly string[] | DOMStringList): boolean` —— 是否为文件拖拽（含 `"Files"`）。
  - `dropTarget(peerCount: number, busy: boolean): "off" | "send" | "pick"` —— 上述判定。
  两者纯函数，vitest 单测。

### App.svelte
- 新增 `let dragActive = $state(false)` 与一个进入计数器 `let dragDepth = 0`（非响应式局部）解决 dragenter/dragleave 抖动。
- `onMount` 注册窗口级监听，`onMount` 的返回函数（或 `onDestroy`）移除：
  - `dragenter`：若 `hasFiles(e.dataTransfer.types)` 则 `dragDepth++`，`dragActive = true`。
  - `dragover`：`e.preventDefault()`（否则浏览器打开文件）。仅在 `hasFiles` 时设置 `dropEffect="copy"`。
  - `dragleave`：`dragDepth--`；归零时 `dragActive = false`。
  - `drop`：`e.preventDefault()`；`dragDepth = 0`；`dragActive = false`；按 `dropTarget(visiblePeers.length, busy)`：
    - `send` → `sendFiles(visiblePeers[0].id, e.dataTransfer.files)`。
    - 其他 → 不处理（`pick`/`off` 由卡片或页面落点负责）。
- 浮层标记：`{#if dragActive && dropTarget(visiblePeers.length, busy) !== "off"}` 渲染一个 `position: fixed` 全屏浮层（`pointer-events: none`，不拦截卡片拖放）：
  - `send` 模式（`visiblePeers.length === 1`）：文案 `t.dragSendOne(visiblePeers[0].name)`。
  - `pick` 模式（多台）：文案 `t.dragSendMany`，并在传输界面给设备卡片加高亮态（`class:dragging={dragActive}` 于 peers `<ul>` 或各 `<li>`）。
- 现有卡片 `onDrop` 增加 `e.stopPropagation()`，避免落在卡片上时事件冒泡到窗口 `drop` 造成双发。卡片拖放逻辑其余不变（含 `busy` 时 flash 忽略）。

### i18n
- `Messages` 顶层新增 `dragSendOne: (name: string) => string` 与 `dragSendMany: string`，6 语言全覆盖。

## 边界与错误处理

- 浮层 `pointer-events: none`，绝不挡住卡片的拖放命中。
- `busy` 时不激活（避免在传输中误发）；窗口 `drop` 即便触发也走 `sendFiles`，其内部已有 `busy` 保护并 flash。
- 非文件拖拽（页面内元素/选中文本）不激活。
- 移动端无拖放，本特性纯桌面增强，不影响触控。
- 跨网络未连接（0 对端）→ `off`，浮层不出现，「存储链接」上传卡的任何自有拖放/选择不受影响。

## 测试

- **单元（vitest）**：`hasFiles`（含/不含 "Files"、空）；`dropTarget`（0/1/多 × busy 真假 → off/send/pick）。
- **i18n 完整性**：纳入 `dragSendOne`/`dragSendMany`。
- **手动冒烟**：
  1. LAN 仅 1 台设备：窗口任意处拖放 → 发送。
  2. LAN 多台：空白处落下不发；拖到某卡片 → 发给该设备；拖动时卡片高亮。
  3. 跨网络连上对端：窗口拖放 → 发送；存储卡（未连接时）不被整页拖放误触发。
  4. 传输进行中拖放 → 不激活/不误发。

## 集成点

- `web/src/lib/drag.ts`（新）+ `web/src/lib/drag.test.ts`（新）。
- `web/src/App.svelte` —— 窗口监听、`dragActive`、浮层、`transferSurface`/卡片 `stopPropagation` 与高亮。
- `web/src/lib/i18n.svelte.ts` + `i18n.test.ts` —— `dragSendOne`/`dragSendMany`（6 语言）。
