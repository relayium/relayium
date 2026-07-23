# 端到端测试

## `lan-transfer.mjs` — 两个真标签页之间的一次真传输

`npm run test:e2e`

跑之前要有两件东西：

```bash
# 1) 构建产物（服务器直接吐 web/dist，测的就是它——别拿旧 dist 测出一个假绿）
cd web && npm run build

# 2) 本地服务器（同时兜 SPA、/ws 信令和 /api/ice）
cd server && RELAYIUM_ADDR=:8099 go run .
```

然后 `cd web && npm run test:e2e`（换端口用 `node e2e/lan-transfer.mjs --url http://localhost:1234`；
调试时加 `--keep` 保留 Chrome 的临时 profile）。

### 它测的是什么

vitest 那 580 条测试**一行都覆盖不到实时传输管道**：收发两条管道原本长在 App.svelte
里、现在在 `transfer-session.svelte.ts` 里，两者都需要两个真实的浏览器上下文、一条真
WebSocket 信令和一个真 RTCPeerConnection 才跑得起来。这个脚本就是它们唯一的回归网：

1. **握手到落盘的全链路**：两个标签页进同一个 LAN 房间 → 互相发现 → 塞进一个 3MB 文件
   → commit-reveal → DataChannel → 分块 AES-GCM → 流控 ACK → 逐文件完整性校验 → 落盘。
   最后按 **SHA-256 比对收到的字节**，不是"看见进度条到 100% 就算过"。
2. **文件名出现在确认卡片上** —— 那是用户做信任决策的地方。
3. **两侧 SAS 一致**（中间人防护里用户看得见的那一半）。SAS 只在传输**进行中**显示，
   所以是从点下"接受"起后台采样的；采不到就算失败，而不是悄悄跳过。
4. **建连途中失败要报得干净**：第二幕给收方注入一个"数据通道打开前就 failed"的
   RTCPeerConnection。这一窗口出过真 bug（掉线处理函数当时还在 TDZ 里，抛
   ReferenceError 而不是失败卡片），所以用例直接断言"没有 ReferenceError"。

### 只桩掉一样东西

`showSaveFilePicker`（操作系统的另存为对话框，无头浏览器开不出来）被换成一个把字节
攒进内存的假句柄。除此之外全是真的：真服务器、真信令、真 WebRTC、真加密。

### 已知的环境坑

- **必须关掉 mDNS 候选隐藏**（`--disable-features=WebRtcHideLocalIpsWithMdns`）。
  Chrome 默认把本机 IP 藏成 `.local` 候选，无头环境里没有解析器，两个标签页于是永远
  配不出可用候选对，ICE 直接 failed。
- **Go 服务器的 CSP 必须带 `'wasm-unsafe-eval'`**（`server/spa.go`）。libsodium 是
  WASM，缺这个 token 浏览器拒绝编译它，应用连信令都连不上。有 Go 单测钉着。
- 脚本启动时会先 `pkill` 掉上一轮残留的浏览器：它们的标签页还挂着 WebSocket，攒够
  几个就会撞上服务器的**每 IP 并发 /ws 上限**，新标签页静默连不上——那种失败看起来
  和真回归一模一样。
