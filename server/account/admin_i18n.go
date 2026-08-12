package account

import (
	"net/http"
	"net/url"
	"strings"
)

// The admin console was written in Chinese only. That is a real gap for the
// self-hosters this project invites — the install guide, the CLI and the whole
// site are in nine languages, and then /admin is in one.
//
// Two decisions shape how it is fixed here:
//
//   - THE KEY IS THE CHINESE STRING. Not "admin.login.title". A missing entry
//     therefore falls back to the text that is on the page today, so a partial
//     translation is always shippable and can never render a blank label or a
//     raw key at a self-hoster. Extracting to symbolic keys first would have
//     meant one enormous commit that is correct or broken with nothing in
//     between, on a surface that includes rollout controls and a step-up
//     confirmation page.
//   - THE LANGUAGE COMES FROM Accept-Language, with no new configuration. The
//     browser already states the operator's preference. Adding RELAYIUM_ADMIN_LANG
//     would be one more key to document, test and get wrong, to answer a question
//     the request already answers.
//
// Only English is added: it is the language that unblocks everyone who does not
// read Chinese. More can follow the same shape.

// adminEN maps the console's Chinese source strings to English. Anything absent
// falls through to the Chinese, by design — see the note above.
var adminEN = map[string]string{
	"读取该轨道状态失败，控制按钮已隐藏（另一条轨道不受影响）。": "Could not read this track's state, so its controls are hidden (the other track is unaffected).",
	"紧急发布中（已跳过分批）":                  "Emergency release in progress (batching skipped)",
	"设定目标版本":                        "Set target version",
	"暂停":                            "Pause",
	"继续":                            "Resume",
	"回滚":                            "Roll back",
	"紧急发布":                          "Emergency release",
	"手动快速发布":                        "Manual fast push",
	"手动快速发布中（仍逐台，不设观察窗）": "Manual fast push in progress (still one node at a time, no observation window)",
	"手动快速发布的版本":          "Version for the manual fast push",
	"立刻开始一轮机队发布：不设观察窗、节点之间不等待，但仍一次一台，任一台没有回报成功即中止": "Start a fleet rollout now: no observation window and no wait between nodes, but still one node at a time, and it halts as soon as a node does not report success",
	"⚠ 手动快速发布：跳过 canary 观察窗与节点之间的等待，立刻开始发布":        "⚠ Manual fast push: skips the canary observation window and the wait between nodes, and starts rolling immediately",
	"仍然逐台进行：一次只更新一台节点，每台都要自己校验签名、安装、重启并通过健康检查，并回报成功，队列才会继续下一台。只有「成功」才算过关：失败、回滚、跳过、拿不到产物或超时都会立刻中止本次发布，后面的节点不会被下发。": "Still one node at a time: each node verifies the release signature, installs, restarts, passes its own health check and REPORTS SUCCESS before the queue moves on. Only success counts: a failure, rollback, skip, unobtainable artifact or timeout halts this rollout immediately and no later node is commanded.",
	"节点":                    "Node",
	"状态":                    "Status",
	"当前版本":                  "Current version",
	"更新结果":                  "Update result",
	"从版本":                   "From version",
	"下发时间(UTC)":             "Dispatched (UTC)",
	"本批次":                   "This batch",
	"重试":                    "Retry",
	"该轨道下暂无节点":              "No nodes on this track yet",
	"Relayium Admin · 确认操作": "Relayium Admin · Confirm action",
	"请确认这项操作":               "Confirm this action",
	"动作：":                   "Action:",
	"⚠ 紧急发布：跳过金丝雀与分批，整条轨道一次性放行": "⚠ Emergency release: skips the canary and batching, releasing the whole track at once",
	"字段": "Field",
	"原值": "Old value",
	"新值": "New value",
	"该操作没有逐字段的差异可展示，请确认操作本身无误。": "This action has no field-by-field diff to show. Check that the action itself is what you intended.",
	"用你注册的 passkey 确认这项操作。":     "Confirm this action with your registered passkey.",
	"验证码（TOTP）": "Code (TOTP)",
	"管理员密码":     "Admin password",
	"刚验证过第二因子，此次操作仍在宽限期内，免再输入 —— 但请确认上面的改动无误。": "Your second factor was verified recently, so this action is still inside the grace window and needs no re-entry — but check the changes above.",
	"用 passkey 确认执行":      "Confirm with a passkey",
	"确认执行":                "Confirm",
	"取消":                  "Cancel",
	"Relayium Admin · 用户": "Relayium Admin · Users",
	"后台概览":                "Overview",
	"审计日志":                "Audit log",
	"退出":                  "Sign out",
	"忽略此版本":               "Ignore this version",
	"撤销":                  "Undo",
	"尚未成功检查过":             "No successful check yet",
	"前往该轨面板处理 ↓":          "Go to that track's panel ↓",
	"总用户数":                "Total users",
	"未过期暂存文件":             "Unexpired stored files",
	"占用存储(近似)":            "Storage used (approx.)",
	"新节点 Token（仅显示一次，请立即复制）：": "New node token (shown once — copy it now):",
	"在官方服务器上执行以下命令安装并启动节点：":   "Run this on the server to install and start the node:",
	"生成节点 Token":     "Generate node token",
	"备注 / ID":        "Label / ID",
	"区域":             "Region",
	"中继(本月/累计) / 上限": "Relayed (month / total) / cap",
	"存储 / 硬盘上限":      "Storage / disk cap",
	"盘 剩余/总量":        "Disk free / total",
	"可存储":            "Can store",
	"排空":             "Drain",
	"剩余文件 / 最早可安全卸载": "Files left / earliest safe removal",
	"版本":             "Version",
	"备注名 · 限额(GB)":   "Label · cap (GB)",
	"已卸载":            "Uninstalled",
	"恢复":             "Restore",
	"标记已移除":          "Mark removed",
	"排空中":            "Draining",
	"可以卸载了，在该机器上执行（先下载到文件、确认非空再运行——不要直接": "Safe to uninstall. On that machine run (download to a file and check it is not empty first — do not pipe",
	"等最后一个文件过期后，在该机器上执行":                 "Once the last file expires, run this on that machine",
	"卸载": "Uninstall",
	"改名": "Rename",
	"保存": "Save",
	"删除": "Delete",
	"这些不是我们的机器，是用户贡献的。排空/标记已移除只影响": "These are not our machines — users contribute them. Draining and marking removed affect only",
	"该用户自己的":      "that user's own",
	"搜索":          "Search",
	"清除":          "Clear",
	"自带节点查询失败，下表": "Bring-your-own node query failed, so the table below is",
	"不是":          "not",
	"所属用户":        "Owner",
	"最后心跳(UTC)":   "Last heartbeat (UTC)",
	"← 上一页":       "← Previous",
	"下一页 →":       "Next →",
	"翻页看到的是当前这一刻的快照：在线节点每次心跳都会重新排名，翻页不保证遍历到每一台在线节点（可能跳过或重复）。要确认某一台节点还在，请用上面的搜索定位，不要靠翻页去清点。": "Paging shows a snapshot of this moment: online nodes are re-ranked on every heartbeat, so paging is not guaranteed to visit every one (it can skip or repeat). To confirm a specific node is still there, find it with the search above rather than counting through pages.",
	"已卸载自带节点查询失败，下面": "Uninstalled bring-your-own node query failed, so what follows is",
	"备注名":               "Label",
	"创建时间(UTC)":         "Created (UTC)",
	"最后使用":              "Last used",
	"绑定节点":              "Bound node",
	"节点版本发布":            "Node releases",
	"名称":                "Name",
	"存储(MB)":            "Storage (MB)",
	"流量(GB/月)":          "Traffic (GB/month)",
	"暂存天数":              "Retention (days)",
	"每日额度(MiB)":         "Daily allowance (MiB)",
	"月付(分)":             "Monthly (cents)",
	"年付(分)":             "Yearly (cents)",
	"排序":                "Order",
	"启用":                "Enabled",
	"Stripe 月付价格ID":     "Stripe monthly price ID",
	"Stripe 年付价格ID":     "Stripe yearly price ID",
	"暂存传输设置":            "Stored-transfer settings",
	"单文件上限 (MiB)":       "Max file size (MiB)",
	"每账号每日额度 (MiB)":     "Daily allowance per account (MiB)",
	"默认有效期 (小时)":        "Default lifetime (hours)",
	"最长有效期 (小时)":        "Maximum lifetime (hours)",
	"默认保留策略":            "Default retention policy",
	"阅后即焚":              "Burn after reading",
	"保存N天":              "Keep N days",
	"限定次数":              "Limited downloads",
	"默认下载次数上限":          "Default download limit",
	"下载次数上限的上限":         "Ceiling on the download limit",
	"全局存储上限 (MiB，0=无限)": "Global storage cap (MiB, 0 = unlimited)",
	"节点默认流量上限 (GB/月，0=不限)":              "Default node traffic cap (GB/month, 0 = unlimited)",
	"关闭中央兜底：无可用存储节点时上传直接失败，不再落到本站服务器磁盘": "Disable the central fallback: with no storage node available, an upload fails outright instead of landing on this server's disk",
	"保存设置": "Save settings",
	"凭据列表读取失败，请查看服务端日志": "Could not read the credential list — check the server log",
	"添加时间(UTC)":                "Added (UTC)",
	"从未使用":                     "Never used",
	"尚未添加 passkey":             "No passkey added yet",
	"添加 passkey":               "Add a passkey",
	"用量月份":                     "Usage month",
	"切换":                       "Switch",
	"邮箱":                       "Email",
	"显示名":                      "Display name",
	"注册时间(UTC)":                "Registered (UTC)",
	"登录方式":                     "Sign-in method",
	"设备":                       "Devices",
	"上传":                       "Upload",
	"下载":                       "Download",
	"中继":                       "Relayed",
	"当前存储占用":                   "Storage in use",
	"套餐":                       "Plan",
	"订阅来源":                     "Subscription source",
	"分配":                       "Assign",
	"Relayium Admin · 审计日志":    "Relayium Admin · Audit log",
	"← 返回后台":                   "← Back to admin",
	"全部动作":                     "All actions",
	"筛选":                       "Filter",
	"时间(UTC)":                  "Time (UTC)",
	"动作":                       "Action",
	"目标":                       "Target",
	"变更":                       "Change",
	"步进因子":                     "Step-up factor",
	"暂无记录":                     "No entries yet",
	"目标版本（vMAJOR.MINOR.PATCH）": "Target version (vMAJOR.MINOR.PATCH)",
	"回滚到的版本":                   "Version to roll back to",
	"回到该轨上一个目标版本；该版本当初已通过机队门槛，因此不受机队当前发布状态影响": "Return to this track's previous target version. That version already cleared the fleet gate, so it is unaffected by the fleet's current release state.",
	"紧急发布的版本":                "Version to release urgently",
	"把这台重新放回发布队列；不改目标版本":     "Put this one back in the release queue without changing the target version",
	"6 位动态验证码":               "6-digit code",
	"再次输入密码以确认":              "Re-enter your password to confirm",
	"节点备注名（如 cn-shanghai-1）": "Node label (e.g. cn-shanghai-1)",
	"清除已卸载标记，让节点重新上线（不影响它的文件与历史）": "Clear the uninstalled mark so the node comes back online (its files and history are untouched)",
	"卸载脚本未能联系中央时的人工补救：标记为已移除":     "Manual remedy for when the uninstall script could not reach central: mark it removed",
	"节点备注名":                      "Node label",
	"流量上限 GB/月，0=用全局默认":          "Traffic cap GB/month, 0 = use the global default",
	"硬盘上限 GB，0=无限":               "Disk cap GB, 0 = unlimited",
	"搜索：节点 ID / 用户邮箱 / 备注名 / 区域": "Search: node ID / user email / label / region",
	"把这台用户节点移出服务（可恢复）":           "Take this user node out of service (reversible)",
	"清除已卸载标记（不影响它的文件与历史）":        "Clear the uninstalled mark (its files and history are untouched)",
	"每日额度(MiB)，0 = 用全局设置":        "Daily allowance (MiB), 0 = use the global setting",
	"设备名称，如 MacBook":             "Device name, e.g. MacBook",
	"6 位验证码（如已启用）":               "6-digit code (if enabled)",
	"搜索邮箱或显示名":                   "Search email or display name",
	"Relayium 后台":                "Relayium admin",
	"管理员账号":                      "Admin username",
	"6 位验证码":                     "6-digit code",
	"登录":                         "Sign in",
	"使用 passkey 登录":              "Sign in with a passkey",

	// Fragments that sit either side of a {{...}} interpolation, and prose
	// nodes that span lines in the source. Collapsed to one line as keys.
	"目标版本：":       "Target version:",
	"· 状态：":       "· Status:",
	"中止原因：":       "Halt reason:",
	"回滚到上一版本（":    "Roll back to the previous version (",
	"在线":          "online",
	"离线":          "offline",
	"共":           "of",
	"台，仅列出最需要关注的": "in total; only the ones that need attention are listed —",
	"台（失败 / 发布中 / 落后版本优先），其余": "of them (failed / releasing / behind, in that order), and the remaining",
	"台未显示。":      "are not shown.",
	"轨道：":        "Track:",
	"有新版本：":      "New version available:",
	"· 当前目标":     "· current target",
	"· 尚未配置发布目标": "· no release target configured yet",
	"发布":         "Release",
	"到机队":        "to the fleet",
	"机队轨上有一次发布尚未结束（目标": "A release is still open on the fleet track (target",
	"，正在发布或已暂停），此处不提供一键发布：那会中止它、清掉记录在案的发布位置并从头开始，已暂停的发布也就无法再原样继续。要改目标请到下方机队面板手动设定。": ", releasing or paused), so there is no one-click release here: it would abort that run, discard the recorded position and start over, leaving a paused release unable to resume as it was. To change the target, set it by hand in the fleet panel below.",
	"已忽略":         "ignored",
	"上次成功检查：":     "Last successful check:",
	"发布已中止：":      "Release halted:",
	"· 目标版本":      "· target version",
	"未记录中止原因":     "no halt reason recorded",
	"上传 ·":        "Upload ·",
	"下载 ·":        "Download ·",
	"中继 ·":        "Relayed ·",
	"中央本地存储":      "Central local storage",
	"（已关闭兜底）":     "(fallback disabled)",
	"官方节点（":       "Fleet nodes (",
	"正常":          "healthy",
	"取消排空":        "Cancel drain",
	"开始排空":        "Start drain",
	"个 /":         "of",
	"0 个 · 可随时卸载": "0 · safe to uninstall now",
	"0 个 · 可随时移除": "0 · safe to remove now",
	"查询失败，结果未知":   "query failed, result unknown",
	"没有匹配的自带节点":   "No matching bring-your-own nodes",
	"暂无用户自带节点":    "No user-contributed nodes yet",
	"没有匹配的已卸载节点":  "No matching uninstalled nodes",
	"暂无已卸载节点":     "No uninstalled nodes",
	"活跃节点 Token（": "Active node tokens (",
	"套餐（":         "Plans (",
	"Passkey 登录":  "Passkey sign-in",
	"注册用户（":       "Registered users (",
	"第":           "Page",
	"页":           "",

	// confirm() text on destructive forms. These are the last sentence an
	// operator reads before a rollback or a removal, so they are worth more than
	// their word count. Variables were moved OUT of the translated sentence
	// rather than translated around, which is how fragment translation reads
	// wrong in a language with different word order.
	"重新下发？该轨道会回到发布中。":                 "Re-dispatch? The track goes back to releasing.",
	"把机队轨的目标版本设为该版本并开始发布？":            "Set the fleet track's target to this version and start releasing?",
	"回滚到上一版本？":                        "Roll back to the previous version?",
	"暂停该轨的发布？":                        "Pause this track's release?",
	"把该轨回滚到这个版本？":                     "Roll this track back to this version?",
	"继续该轨的发布？将从头重新分批。":                "Resume this track's release? Batching restarts from the beginning.",
	"删除这枚 passkey？":                   "Delete this passkey?",
	"撤销该 Token？":                      "Revoke this token?",
	"删除该官方节点？":                        "Delete this fleet node?",
	"恢复该节点？它会重新进入放置/ICE/直连下载。":        "Restore this node? It re-enters placement, ICE and direct downloads.",
	"恢复该用户节点？它会重新进入该用户的放置池/ICE/直连下载。": "Restore this user node? It re-enters that user's placement pool, ICE and direct downloads.",
	"标记该用户节点已卸载？它会退出该用户的放置池/ICE/直连下载，文件与历史保留，可随时用「恢复」撤销。":                     "Mark this user node uninstalled? It leaves that user's placement pool, ICE and direct downloads. Files and history are kept, and Restore undoes it at any time.",
	"手动标记该节点已卸载？用于卸载脚本联系不到中央、来不及自动登记的情况；节点会退出放置/ICE/直连下载，文件与历史保留，可随时用「恢复」撤销。": "Mark this node uninstalled by hand? For when the uninstall script could not reach central in time. The node leaves placement, ICE and direct downloads. Files and history are kept, and Restore undoes it at any time.",

	// Passkey script messages. Same JS-string context as the confirm() text, and
	// covered by the same escaping test.
	"服务器错误 ":    "Server error ",
	"验证失败（服务器 ": "Verification failed (server ",
	"已取消，或这台设备上没有可用的 passkey。可用下方密码登录后在设置里添加": "Cancelled, or this device has no usable passkey. Sign in with the password below and add one in settings.",
	"登录失败，请改用下方密码登录":                          "Sign-in failed — use the password below instead",
	"这台设备不支持 passkey，请在注册了 passkey 的设备上确认。":   "This device does not support passkeys. Confirm on a device where one is registered.",
	"已取消，或这台设备上没有可用的 passkey。":                "Cancelled, or this device has no usable passkey.",
	"验证失败，请重试。":                               "Verification failed. Try again.",
	"注册失败（服务器 ":                               "Registration failed (server ",
	"注册失败":                                    "Registration failed",

	// Text that used to be interleaved with {{if}}/{{else}}. The branches were
	// restructured so each holds a whole clause, rather than translating a
	// sentence in pieces whose order only works in Chinese.
	"进度：":        "Progress:",
	"台已在目标版本":    "on the target version",
	"正在更新：":      "Updating:",
	"当前批次：":      "Current batch:",
	"未开批":        "not started",
	"本阶段开始：":     "Stage started:",
	"自带节点（用户机器）": "Bring-your-own nodes (user machines)",
	"已卸载的自带节点":   "Uninstalled bring-your-own nodes",
	"查询失败":       "query failed",
	"(新增)":       "(added)",
	"匹配：":        "Matching:",
	"这些用户节点已被标记卸载，已退出对应用户的放置池/ICE/直连下载。如果是误操作或卸载脚本没跑完整，用「恢复」撤销——不影响它的文件与历史。": "These user nodes are marked uninstalled and have left that user's placement pool, ICE and direct downloads. If that was a mistake, or the uninstall script did not finish, Restore undoes it — files and history are untouched.",

	// Remaining inline fragments around <b>/<code> emphasis.
	"目标：": "Target:",
	"链接一旦暂时不可达，这种管道写法会让整条命令": "if the link is briefly unreachable, piping like that makes the whole command",
	"看起来成功":     "look like it worked",
	"实际什么都没做）：": "while doing nothing):",
	"放置池与直连下载，机器本身仍在用户手里运行；先看清": "placement pool and direct downloads; the machine itself keeps running in the user's hands. Check",
	"剩余文件": "files left",
	"再动手，节点上的文件没有副本。": "before acting — the files on that node have no replica.",
	"没有匹配": "no matches",
	"的结果——是这次查询没跑成功。请查看服务端日志后重试；在确认之前不要据此认定某台节点不存在。": " — the query itself failed. Check the server log and retry; do not conclude a node is gone until you have.",
	"的结果。请查看服务端日志后重试。": " result. Check the server log and retry.",
}

// adminLangCookie holds an explicit choice made in the console's header.
const adminLangCookie = "relayium_admin_lang"

// adminLangFrom picks the console language for one request.
//
// An explicit choice wins over the header, and that ordering is the whole point
// of the cookie existing. Accept-Language alone was not enough in practice: a
// great many browsers send en-US first regardless of who is holding them, so
// Chinese operators were handed an English console by a preference they never
// expressed. A header is a guess; the picker is an answer.
//
// The header remains the default for anyone who has not chosen, and no choice
// plus no English preference still means Chinese — what the console rendered
// before any of this existed.
func adminLangFrom(r *http.Request) string {
	if c, err := r.Cookie(adminLangCookie); err == nil {
		switch c.Value {
		case "zh", "en":
			return c.Value
		}
	}
	for _, part := range strings.Split(r.Header.Get("Accept-Language"), ",") {
		tag := strings.ToLower(strings.TrimSpace(strings.SplitN(part, ";", 2)[0]))
		switch {
		case tag == "zh" || strings.HasPrefix(tag, "zh-"):
			return "zh"
		case tag == "en" || strings.HasPrefix(tag, "en-"):
			return "en"
		}
	}
	return "zh"
}

// adminT is the `t` template function: {{t $.Lang "中文"}}.
func adminT(lang, zh string) string {
	if lang != "en" {
		return zh
	}
	if s, ok := adminEN[zh]; ok {
		return s
	}
	return zh
}

// handleAdminLang records an explicit language choice and returns the operator
// to the page they were on.
//
// POST rather than a link, so it goes through CSRFGuard like every other state
// change in the console. The redirect target is taken from the Referer but only
// ever used as a PATH under /admin: echoing a full URL back into a redirect is
// how an open redirect gets built by accident, and an admin console is the last
// place to hand someone a same-origin-looking hop to elsewhere.
func (s *Service) handleAdminLang(w http.ResponseWriter, r *http.Request) {
	lang := r.FormValue("l")
	if lang != "zh" && lang != "en" {
		lang = "zh"
	}
	http.SetCookie(w, &http.Cookie{
		Name: adminLangCookie, Value: lang, Path: "/admin",
		MaxAge: 365 * 24 * 3600, HttpOnly: true,
		Secure: s.CookieSecure(), SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, adminReturnPath(r.Referer()), http.StatusFound)
}

// adminReturnPath reduces a Referer to a path inside the console, or /admin.
func adminReturnPath(referer string) string {
	if referer == "" {
		return "/admin"
	}
	u, err := url.Parse(referer)
	if err != nil {
		return "/admin"
	}
	// Path only: the host is discarded rather than compared, so there is nothing
	// to get wrong about which hosts count as ours.
	p := u.EscapedPath()
	if p != "/admin" && !strings.HasPrefix(p, "/admin/") {
		return "/admin"
	}
	if u.RawQuery != "" {
		return p + "?" + u.RawQuery
	}
	return p
}
