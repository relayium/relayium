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
	AuditPlanUpsert    = "plan.upsert"
	AuditUserPlan      = "user.plan"
	AuditNodeDelete    = "node.delete"
	AuditNodeLimits    = "node.limits"
	AuditNodeLabel     = "node.label"
	AuditNodeDraining  = "node.draining"
	AuditTokenMint     = "token.mint"
	AuditTokenRevoke   = "token.revoke"
	AuditPasskeyDelete = "passkey.delete"
	// 节点版本发布。四个常规动作各自独立记账，紧急发布单列一个 action ——
	// 事后翻审计日志时，"这次是谁跳过了分批" 必须一眼可查，不能混在
	// rollout.target 里靠 changes 字段去猜。
	AuditRolloutTarget    = "rollout.target"
	AuditRolloutPause     = "rollout.pause"
	AuditRolloutResume    = "rollout.resume"
	AuditRolloutRollback  = "rollout.rollback"
	AuditRolloutEmergency = "rollout.emergency"
)

// auditActions lists every known action, in the same order as the const
// block above, for the audit page's filter dropdown. Kept as a derived slice
// rather than hand-typed literals so it can never drift from the constants
// themselves — a new action added above and forgotten here would just be
// unfilterable, not wrong.
var auditActions = []string{
	AuditLoginOK, AuditLoginFail, AuditLogout, AuditSettings,
	AuditPlanUpsert, AuditUserPlan, AuditNodeDelete, AuditNodeLimits,
	AuditNodeLabel, AuditNodeDraining, AuditTokenMint, AuditTokenRevoke, AuditPasskeyDelete,
	AuditRolloutTarget, AuditRolloutPause, AuditRolloutResume,
	AuditRolloutRollback, AuditRolloutEmergency,
}

// 步进因子取值。"" = 该操作无需步进；grace = 落在宽限期内跳过了校验。
const (
	StepUpNone     = ""
	StepUpPasskey  = "passkey"
	StepUpTOTP     = "totp"
	StepUpPassword = "password"
	StepUpGrace    = "grace"
)

// writeAudit 追加一条审计记录。
//
// **它绝不返回错误，也绝不让调用方失败。** 业务操作此时已经成功提交，把审计
// 写入失败上报成 500 会让管理员以为操作没生效而重试一次，反而造成二次变更。
// 写不进去就记到进程日志里，这是我们能做的最好补救。
func (s *Service) writeAudit(r *http.Request, action, target string, fields []ChangeField, stepUp string) {
	if s.store == nil {
		// Some lightweight handler tests build a *Service with a nil store
		// (NewService(nil, nil, Config{...})). writeAudit must never break the
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
