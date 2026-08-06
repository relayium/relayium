package account

import (
	"net/http"
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
	"节点":                            "Node",
	"状态":                            "Status",
	"当前版本":                          "Current version",
	"更新结果":                          "Update result",
	"从版本":                           "From version",
	"下发时间(UTC)":                     "Dispatched (UTC)",
	"本批次":                           "This batch",
	"重试":                            "Retry",
	"该轨道下暂无节点":                      "No nodes on this track yet",
	"Relayium Admin · 确认操作":         "Relayium Admin · Confirm action",
	"请确认这项操作":                       "Confirm this action",
	"动作：":                           "Action:",
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
}

// adminLangFrom picks the console language for one request.
//
// Deliberately crude: it looks for an English preference and otherwise keeps
// Chinese, which is what the console rendered before this existed. A full
// Accept-Language parse (q-values, regional subtags, a language negotiation
// table) would be more code than the two-language choice it decides, and every
// extra branch is a way to serve an operator a language they did not ask for.
func adminLangFrom(r *http.Request) string {
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
