package account

import (
	"log"
	"net/http"
)

// 审计动作名。集中定义而不是散在各 handler 里写字面量，
// 是为了让审计页的过滤下拉框和写入端不可能拼错到对不上。
const (
	AuditLoginOK      = "login.ok"
	AuditLoginFail    = "login.fail"
	AuditLogout       = "logout"
	AuditSettings     = "settings.update"
	AuditPlanUpsert   = "plan.upsert"
	AuditUserPlan     = "user.plan"
	AuditNodeDelete   = "node.delete"
	AuditNodeLimits   = "node.limits"
	AuditNodeLabel    = "node.label"
	AuditNodeDraining = "node.draining"
	AuditNodeRestore  = "node.restore"
	AuditNodeRemove   = "node.remove"
	// 节点自助下线：卸载脚本调用 /api/nodes/deregister 的那一次。与
	// node.remove（管理员在后台手工标记）分开记，因为"是机器自己走的"和
	// "是人把它拔掉的"在事后复盘时是两件事，混在一个 action 里就只能靠
	// actor 去猜。
	AuditNodeDeregister = "node.deregister"
	AuditTokenMint      = "token.mint"
	AuditTokenRevoke    = "token.revoke"
	AuditPasskeyDelete  = "passkey.delete"
	// 节点版本发布。四个常规动作各自独立记账，紧急发布单列一个 action ——
	// 事后翻审计日志时，"这次是谁跳过了分批" 必须一眼可查，不能混在
	// rollout.target 里靠 changes 字段去猜。
	AuditRolloutTarget    = "rollout.target"
	AuditRolloutPause     = "rollout.pause"
	AuditRolloutResume    = "rollout.resume"
	AuditRolloutRollback  = "rollout.rollback"
	AuditRolloutEmergency = "rollout.emergency"
	// AuditReleaseRollout is the release-notice "发布到机队" button. It funnels
	// into the exact same SetTargetVersion write as AuditRolloutTarget (the
	// hand-typed fleet-target form), and gets a SEPARATE action anyway — same
	// reasoning as AuditRolloutTarget vs AuditRolloutRollback just above:
	// "the operator typed a version in" and "the operator clicked the button
	// the release notice offered" are different facts about how a rollout
	// started, and an incident review wants to tell them apart, not have them
	// collapse into one action because the resulting row looks the same.
	AuditReleaseRollout = "release.rollout"
	// AuditReleaseDismiss records dismissing (or, with an empty new value,
	// un-dismissing) a release-check notice. Its own action for the same
	// reason as AuditReleaseRollout above: dismissing changes nothing about
	// the fleet track, it only silences a notice, which is itself a fact an
	// incident review would want distinguishable from either rollout action.
	AuditReleaseDismiss = "release.dismiss"
)

// auditActions lists every known action, in the same order as the const
// block above, for the audit page's filter dropdown. Kept as a derived slice
// rather than hand-typed literals so it can never drift from the constants
// themselves — a new action added above and forgotten here would just be
// unfilterable, not wrong.
var auditActions = []string{
	AuditLoginOK, AuditLoginFail, AuditLogout, AuditSettings,
	AuditPlanUpsert, AuditUserPlan, AuditNodeDelete, AuditNodeLimits,
	AuditNodeLabel, AuditNodeDraining, AuditNodeRestore, AuditNodeRemove, AuditNodeDeregister,
	AuditTokenMint, AuditTokenRevoke, AuditPasskeyDelete,
	AuditRolloutTarget, AuditRolloutPause, AuditRolloutResume,
	AuditRolloutRollback, AuditRolloutEmergency,
	AuditReleaseRollout, AuditReleaseDismiss,
}

// 步进因子取值。"" = 该操作无需步进；grace = 落在宽限期内跳过了校验。
const (
	StepUpNone     = ""
	StepUpPasskey  = "passkey"
	StepUpTOTP     = "totp"
	StepUpPassword = "password"
	StepUpGrace    = "grace"
)

// WriteAudit 追加一条审计记录。
//
// **它绝不返回错误，也绝不让调用方失败。** 业务操作此时已经成功提交，把审计
// 写入失败上报成 500 会让管理员以为操作没生效而重试一次，反而造成二次变更。
// 写不进去就记到进程日志里，这是我们能做的最好补救。
func (s *Service) WriteAudit(r *http.Request, action, target string, fields []ChangeField, stepUp string) {
	if s.store == nil {
		// Some lightweight handler tests build a *Service with a nil store
		// (NewService(nil, nil, Config{...})). WriteAudit must never break the
		// request it's attached to, and a nil store is just a more extreme
		// version of "the audit write failed" — same rule applies.
		return
	}
	e := AuditEntry{
		At:      s.now().Unix(),
		Actor:   s.adminUsername(),
		IP:      s.clientIP(r),
		Auth:    s.adminAuthMethod(r),
		Action:  action,
		Target:  target,
		Changes: encodeChanges(fields),
		StepUp:  stepUp,
	}
	if err := s.store.InsertAudit(r.Context(), e); err != nil {
		log.Printf("admin audit write failed (action=%s target=%s): %v", action, target, err)
	}
}

// nodeAuditActor 是"这条记录不是人做的"的写法：actor 写成 node:<id>，
// auth 写成 node-token。
//
// 绝不能退回去用 WriteAudit —— 它取的是 s.adminUsername()，在没有管理员登录的
// 请求里就是空字符串，审计页上会渲染成一个没有名字的管理员，等于把一次机器自
// 助下线记成"某个我们没记下名字的人干的"。审计日志在最要紧的地方说谎，比没有
// 这条记录更糟。
const nodeAuditAuth = "node-token"

func nodeAuditActor(nodeID string) string { return "node:" + nodeID }

// writeNodeAudit 追加一条**由节点自己发起**的审计记录。
//
// 与 WriteAudit 同样：绝不返回错误、绝不让请求失败。这里的理由更强——调用方是
// 卸载脚本，它把每一次失败都当成非致命并继续卸载，所以为了写不进审计而回一个
// 500，只会让"机器已经走了"这个事实连日志都留不下。
func (s *Service) writeNodeAudit(r *http.Request, action, nodeID string, fields []ChangeField) {
	if s.store == nil {
		return
	}
	// clientIP is wired by NewService. The node endpoints are also reachable from
	// a hand-built *Service (they need nothing else from it), and an audit write
	// must never be the thing that panics a request — least of all this one,
	// whose caller is a machine mid-uninstall.
	ip := ""
	if s.clientIP != nil {
		ip = s.clientIP(r)
	}
	e := AuditEntry{
		At:      s.now().Unix(),
		Actor:   nodeAuditActor(nodeID),
		IP:      ip,
		Auth:    nodeAuditAuth,
		Action:  action,
		Target:  "node:" + nodeID,
		Changes: encodeChanges(fields),
		StepUp:  StepUpNone,
	}
	if err := s.store.InsertAudit(r.Context(), e); err != nil {
		log.Printf("node audit write failed (action=%s node=%s): %v", action, nodeID, err)
	}
}
