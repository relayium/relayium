package account

import (
	"log"
	"net/http"
)

// 审计动作名。集中定义而不是散在各 handler 里写字面量，
// 是为了让审计页的过滤下拉框和写入端不可能拼错到对不上。
const (
	AuditLoginOK       = "login.ok"
	AuditLoginFail     = "login.fail"
	AuditLogout        = "logout"
	AuditSettings      = "settings.update"
	AuditVersionPolicy = "version-policy.update"
	AuditPlanUpsert    = "plan.upsert"
	AuditUserPlan      = "user.plan"
	AuditNodeDelete    = "node.delete"
	AuditNodeLimits    = "node.limits"
	AuditNodeLabel     = "node.label"
	AuditNodeDraining  = "node.draining"
	AuditNodeRestore   = "node.restore"
	AuditNodeRemove    = "node.remove"
	// 节点自助下线：卸载脚本调用 /api/nodes/deregister 的那一次。与
	// node.remove（管理员在后台手工标记）分开记，因为"是机器自己走的"和
	// "是人把它拔掉的"在事后复盘时是两件事，混在一个 action 里就只能靠
	// actor 去猜。
	AuditNodeDeregister = "node.deregister"
	AuditTokenMint      = "token.mint"
	AuditTokenRevoke    = "token.revoke"
	AuditPasskeyDelete  = "passkey.delete"
	// AuditAppleProduct records an operator writing one row of the App Store
	// product catalog — creating a mapping, repointing it at another tier or
	// cycle, or retiring it.
	//
	// Its own action rather than a variant of plan.upsert: this table decides
	// which tier an already-paid App Store purchase resolves to, and "who wired
	// this product to this tier, and when" is a money question an incident
	// review has to answer from the action name. One action covers create,
	// change and retire because the changes field carries active's old and new
	// value — the same shape plan.upsert uses for a plan's own retirement.
	AuditAppleProduct = "apple.product"
	// AuditApplePurchases records an operator opening or closing the global
	// App Store new-purchase gate (billing_apple_pause.go).
	//
	// Its own action rather than a settings.update, and not a variant of
	// apple.product either. It is the only control that changes what EVERY
	// already-installed App Store build may sell, in one click, and the question
	// an incident review asks of it — "when did we stop selling, and when did we
	// start again, and who decided" — has to be answerable from the action name
	// with no reading of a changes field. One action covers both directions
	// because the changes field carries the old and new value, the same shape
	// plan.upsert uses for a tier's retirement.
	AuditApplePurchases = "apple.purchases"
	// AuditAppleLegacyRelease records the exceptional operator release of one
	// pre-continuation App Store purchase attempt. It is distinct from opening
	// the global purchase gate: this action advances one account's durable money
	// authority after an evidence-bound owner decision.
	AuditAppleLegacyRelease = "apple.purchase.legacy-release"
	// 节点版本发布。四个常规动作各自独立记账，紧急发布单列一个 action ——
	// 事后翻审计日志时，"这次是谁跳过了分批" 必须一眼可查，不能混在
	// rollout.target 里靠 changes 字段去猜。
	AuditRolloutTarget    = "rollout.target"
	AuditRolloutPause     = "rollout.pause"
	AuditRolloutResume    = "rollout.resume"
	AuditRolloutRollback  = "rollout.rollback"
	AuditRolloutEmergency = "rollout.emergency"
	// AuditRolloutRetry is the per-node 重试 on a finished rollout. Its own
	// action for the same reason as the four above: it restarts a track that had
	// already stopped, aimed at ONE machine, and "who re-opened a completed
	// rollout, and for which node" is exactly the question an incident review
	// asks. Collapsing it into rollout.resume would lose the node.
	AuditRolloutRetry = "rollout.retry"
	// AuditRolloutFast is the manual fast fleet push: start a rollout NOW and
	// run the fleet ladder without its canary observation window or its
	// between-node soak, while keeping one-node-at-a-time, each node's own
	// install/health/rollback, and the halt on any bad result.
	//
	// Its own action, and this is the case where sharing one would do the most
	// damage. It is NOT rollout.emergency: that action deliberately releases the
	// whole track at once with no queue and no failure gating, and an incident
	// review reading "rollout.emergency" would conclude the operator had
	// abandoned staging entirely when they had not. It is not rollout.target
	// either — "who chose to skip ~14 hours of observation, and when" is exactly
	// the question a post-incident review asks, and it must be answerable from
	// the action name alone rather than by inferring it from a changes field.
	AuditRolloutFast = "rollout.fast"
	// AuditRolloutFastCanary is the SAFE fast fleet push: start a rollout now,
	// keep the canary's ENTIRE six-hour observation window and its
	// reported-success requirement, and drop only the soak between the machines
	// that come after it.
	//
	// Its own action, distinct from rollout.fast, and the reason is the same one
	// that separates rollout.fast from rollout.emergency: the two are different
	// answers to "what did this operator decide to skip". rollout.fast means the
	// canary window was skipped, which is only defensible for a version some
	// fleet canary has already carried; this one means it was kept. An incident
	// review that could not tell them apart would have to reconstruct which from
	// timestamps, and would read every safe push as if it had skipped the
	// observation the release actually got.
	AuditRolloutFastCanary = "rollout.fast_canary"
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
	AuditLoginOK, AuditLoginFail, AuditLogout, AuditSettings, AuditVersionPolicy,
	AuditPlanUpsert, AuditUserPlan, AuditNodeDelete, AuditNodeLimits,
	AuditNodeLabel, AuditNodeDraining, AuditNodeRestore, AuditNodeRemove, AuditNodeDeregister,
	AuditTokenMint, AuditTokenRevoke, AuditPasskeyDelete, AuditAppleProduct,
	AuditApplePurchases, AuditAppleLegacyRelease,
	AuditRolloutTarget, AuditRolloutPause, AuditRolloutResume,
	AuditRolloutRollback, AuditRolloutEmergency, AuditRolloutRetry,
	AuditRolloutFast, AuditRolloutFastCanary,
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
