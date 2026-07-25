package account

import (
	"context"
	"net/url"
	"time"

	"github.com/relayium/relayium/internal/authx"
)

const (
	pendingActionTTL = 5 * time.Minute
	// pendingActionCap 限制在途的待确认操作数量。铸造需要已认证的管理员会话，
	// 所以这里不像 passkeyCeremonyCap 那样面对未认证洪泛，但仍然要有上限：
	// 管理员反复打开确认页却不提交，同样会让 map 无界增长。
	pendingActionCap = 256
)

// pendingAction 是一个已通过 CSRF 与认证、但尚未执行的高危操作。
type pendingAction struct {
	action string
	// sessionTok 是发起这个操作的管理员会话 cookie 值。
	//
	// **这是本功能的核心安全约束。** 不绑定会话的话，任何拿到 pending token 的人
	// 都能在自己的会话里兑现它，步进认证形同虚设 —— 与 passkey_login.go 里
	// ceremonyKind 注释描述的是同一类攻击：把一个上下文里铸出的凭据拿到另一个
	// 上下文去花掉。
	sessionTok string
	form       url.Values
	// pathID carries the {id} path wildcard of the original request. The
	// confirmation POST lands on /admin/confirm, which has no {id} segment, so
	// without stashing it here a path-scoped action (e.g. node delete, whose
	// handler reads r.PathValue("id")) would forward with an empty id and
	// silently no-op. handleAdminConfirm re-applies it via SetPathValue.
	pathID  string
	expires time.Time
}

// putPending 暂存一个待确认操作，返回其 token。容量已满时返回 false，
// 调用方必须据此拒绝请求而不是继续往下走。Stored in the DB so the confirm token
// is claimable on any instance (form is query-string encoded).
func (s *Service) putPending(ctx context.Context, sessionTok, action, pathID string, form url.Values) (string, bool) {
	tok := authx.RandToken()
	now := s.now().Unix()
	ok, err := s.store.PutPendingAction(ctx, tok, sessionTok, action, form.Encode(), pathID,
		now, now+int64(pendingActionTTL.Seconds()), pendingActionCap)
	if err != nil || !ok {
		return "", false
	}
	return tok, true
}

// takePending 一次性取出待执行操作，且只在 sessionTok 与铸造时一致才成功。
//
// 无条件删除（与 takeCeremony 同样的处理）：会话不匹配的尝试也要烧掉 token，
// 否则攻击者可以拿着它反复试探而不消耗掉这次机会。The atomic DELETE ... RETURNING
// in the store makes the claim exactly-once across instances.
func (s *Service) takePending(ctx context.Context, tok, sessionTok string) (pendingAction, bool) {
	if tok == "" || sessionTok == "" {
		return pendingAction{}, false
	}
	st, action, formEnc, pathID, expires, ok, err := s.store.TakePendingAction(ctx, tok)
	if err != nil || !ok {
		return pendingAction{}, false
	}
	if s.now().Unix() > expires {
		return pendingAction{}, false
	}
	// st is the STORED hash of the minting session's cookie (the store hashes
	// session_tok on write), so compare it against the hash of the current cookie.
	if st != authx.HashToken(sessionTok) {
		return pendingAction{}, false // burned above; a mismatched session can't retry
	}
	form, _ := url.ParseQuery(formEnc)
	// Carry the raw current cookie (equal to the minting session, just verified)
	// as sessionTok — downstream stepUpFresh re-looks it up and the store hashes
	// it again, so a hash here would double-hash and never match.
	return pendingAction{
		action: action, sessionTok: sessionTok, form: form, pathID: pathID,
		expires: time.Unix(expires, 0),
	}, true
}
