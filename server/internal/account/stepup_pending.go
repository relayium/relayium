package account

import (
	"net/url"
	"time"
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
	expires    time.Time
}

// putPending 暂存一个待确认操作，返回其 token。容量已满时返回 false，
// 调用方必须据此拒绝请求而不是继续往下走。
func (s *Service) putPending(sessionTok, action string, form url.Values) (string, bool) {
	tok := randToken()
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	now := s.now()
	for k, p := range s.pendingActions {
		if now.After(p.expires) {
			delete(s.pendingActions, k)
		}
	}
	if len(s.pendingActions) >= pendingActionCap {
		// 拒绝而非驱逐：驱逐会让洪泛把管理员正在确认的操作挤掉。
		return "", false
	}
	s.pendingActions[tok] = pendingAction{
		action: action, sessionTok: sessionTok, form: form,
		expires: now.Add(pendingActionTTL),
	}
	return tok, true
}

// takePending 一次性取出待执行操作，且只在 sessionTok 与铸造时一致才成功。
//
// 无条件删除（与 takeCeremony 同样的处理）：会话不匹配的尝试也要烧掉 token，
// 否则攻击者可以拿着它反复试探而不消耗掉这次机会。
func (s *Service) takePending(tok, sessionTok string) (pendingAction, bool) {
	if tok == "" || sessionTok == "" {
		return pendingAction{}, false
	}
	s.pendingMu.Lock()
	p, ok := s.pendingActions[tok]
	delete(s.pendingActions, tok)
	s.pendingMu.Unlock()
	if !ok || s.now().After(p.expires) {
		return pendingAction{}, false
	}
	// 常量时间比较不是必需的：token 是本地 map 的键，攻击者无法通过时序
	// 逐字节猜出它 —— 猜错一次就被上面的 delete 烧掉了。
	if p.sessionTok != sessionTok {
		return pendingAction{}, false
	}
	return p, true
}
