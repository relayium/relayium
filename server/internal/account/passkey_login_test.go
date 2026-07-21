package account

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
)

// registerTestPasskey 走库层注册一枚凭据并写库，返回 authenticator 与 handle。
func registerTestPasskey(t *testing.T, s *Service) (*testAuthenticator, []byte) {
	t.Helper()
	ctx := context.Background()
	rp, err := s.adminRP()
	if err != nil {
		t.Fatalf("rp: %v", err)
	}
	handle := make([]byte, 32)
	if _, err := rand.Read(handle); err != nil {
		t.Fatalf("handle: %v", err)
	}
	user := &adminPasskeyUser{handle: handle, name: s.adminUser()}
	_, sess, err := rp.BeginRegistration(user, adminRegistrationOpts(user.creds)...)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	auth := newTestAuthenticator(t)
	req, _ := http.NewRequest("POST", "/", strings.NewReader(
		auth.registerBody(t, rp.Config.RPID, s.selfOrigin(), sess.Challenge)))
	req.Header.Set("Content-Type", "application/json")
	cred, err := rp.FinishRegistration(user, *sess, req)
	if err != nil {
		t.Fatalf("finish: %v", err)
	}
	blob, _ := json.Marshal(cred)
	err = s.store.InsertAdminCredential(ctx, AdminCredential{
		ID: b64url(cred.ID), UserHandle: handle, CredJSON: blob,
		Name: "测试设备", CreatedAt: s.now().Unix(),
	})
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	return auth, handle
}

func TestPasskeyLoginEndToEnd(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	auth, handle := registerTestPasskey(t, s)

	// begin
	req, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/begin", nil)
	req.Header.Set("Origin", s.selfOrigin())
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("begin status=%d want 200", resp.StatusCode)
	}
	var opts struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&opts); err != nil {
		t.Fatalf("decode: %v", err)
	}
	resp.Body.Close()
	if opts.PublicKey.Challenge == "" {
		t.Fatalf("empty challenge")
	}
	ceremony := resp.Cookies()

	// finish
	rp, _ := s.adminRP()
	body := auth.assertBody(t, rp.Config.RPID, s.selfOrigin(), opts.PublicKey.Challenge, handle)
	freq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/finish", strings.NewReader(body))
	freq.Header.Set("Content-Type", "application/json")
	freq.Header.Set("Origin", s.selfOrigin())
	for _, c := range ceremony {
		freq.AddCookie(c)
	}
	fresp, err := srv.Client().Do(freq)
	if err != nil {
		t.Fatalf("finish: %v", err)
	}
	defer fresp.Body.Close()
	if fresp.StatusCode != http.StatusOK {
		t.Fatalf("finish status=%d want 200", fresp.StatusCode)
	}

	// 必须种下管理员会话 cookie
	var admin string
	for _, c := range fresp.Cookies() {
		if c.Name == adminCookie {
			admin = c.Value
		}
	}
	if admin == "" || !s.validAdmin(context.Background(), admin) {
		t.Fatalf("no valid admin session issued")
	}

	// last_used_at 必须被回写
	rows, _ := s.store.ListAdminCredentials(context.Background())
	if len(rows) != 1 || rows[0].LastUsedAt == 0 {
		t.Fatalf("last_used_at not written: %+v", rows)
	}
}

// 无 ceremony cookie 的 finish 必须被拒（防止跨会话拼接 challenge）。
func TestPasskeyLoginFinishWithoutCeremony(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	registerTestPasskey(t, s)
	req, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/finish",
		strings.NewReader(`{"id":"x","type":"public-key"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", s.selfOrigin())
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatalf("finish without ceremony succeeded")
	}
}

// 缺失 Origin 头必须被拒：这些端点只由 fetch 调用，fetch 必带 Origin。
// finish 是真正种下管理员会话的端点，是这条防线里最值钱的一环，必须一并覆盖。
func TestPasskeyEndpointsRequireOrigin(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	registerTestPasskey(t, s)

	req, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/begin", nil)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("begin do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("no-Origin begin status=%d want 403", resp.StatusCode)
	}

	freq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/finish",
		strings.NewReader(`{"id":"x","type":"public-key"}`))
	freq.Header.Set("Content-Type", "application/json")
	fresp, err := srv.Client().Do(freq)
	if err != nil {
		t.Fatalf("finish do: %v", err)
	}
	defer fresp.Body.Close()
	if fresp.StatusCode != http.StatusForbidden {
		t.Fatalf("no-Origin finish status=%d want 403", fresp.StatusCode)
	}
}

// 核心安全断言：passkey 失败刷爆后，密码后备通道必须仍然可用；同时 passkey
// 自己的桶必须确实生效（否则下面"密码没被锁"这条断言在桶是空操作时也会通过）。
func TestPasskeyThrottleDoesNotLockPasswordLogin(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	auth, handle := registerTestPasskey(t, s)
	rp, _ := s.adminRP()

	sawThrottled := false
	for i := 0; i < adminLoginMaxFails+3; i++ {
		// 取一个合法 ceremony，再用错误 challenge 签名 → 必然验签失败
		breq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/begin", nil)
		breq.Header.Set("Origin", s.selfOrigin())
		bresp, err := srv.Client().Do(breq)
		if err != nil {
			t.Fatalf("begin %d: %v", i, err)
		}
		if bresp.StatusCode == http.StatusTooManyRequests {
			sawThrottled = true
		}
		cookies := bresp.Cookies()
		bresp.Body.Close()

		bad := auth.assertBody(t, rp.Config.RPID, s.selfOrigin(),
			"d3JvbmctY2hhbGxlbmdlLXZhbHVl", handle)
		freq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/finish",
			strings.NewReader(bad))
		freq.Header.Set("Content-Type", "application/json")
		freq.Header.Set("Origin", s.selfOrigin())
		for _, c := range cookies {
			freq.AddCookie(c)
		}
		fresp, err := srv.Client().Do(freq)
		if err != nil {
			t.Fatalf("finish %d: %v", i, err)
		}
		if fresp.StatusCode == http.StatusTooManyRequests {
			sawThrottled = true
		}
		fresp.Body.Close()
		if fresp.StatusCode == http.StatusOK {
			t.Fatalf("bad challenge accepted at attempt %d", i)
		}
	}
	if !sawThrottled {
		t.Fatalf("passkey throttle never returned 429 after %d failures — bucket may be a no-op",
			adminLoginMaxFails+3)
	}

	// 密码通道必须没被连带锁死
	form := strings.NewReader("username=admin&password=pw")
	preq, _ := http.NewRequest("POST", srv.URL+"/admin/login", form)
	preq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	preq.Header.Set("Origin", s.selfOrigin())
	presp, err := srv.Client().Do(preq)
	if err != nil {
		t.Fatalf("password login: %v", err)
	}
	defer presp.Body.Close()
	if presp.StatusCode == http.StatusTooManyRequests {
		t.Fatalf("passkey failures locked the password fallback — throttle buckets are shared")
	}
}

// 克隆凭据（计数器回退）必须被拒。
func TestPasskeyRejectsClonedCredential(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	auth, handle := registerTestPasskey(t, s)
	rp, _ := s.adminRP()

	login := func(body string, cookies []*http.Cookie) int {
		req, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/finish",
			strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", s.selfOrigin())
		for _, c := range cookies {
			req.AddCookie(c)
		}
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatalf("do: %v", err)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}
	begin := func() (string, []*http.Cookie) {
		req, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/begin", nil)
		req.Header.Set("Origin", s.selfOrigin())
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatalf("begin: %v", err)
		}
		defer resp.Body.Close()
		var o struct {
			PublicKey struct {
				Challenge string `json:"challenge"`
			} `json:"publicKey"`
		}
		json.NewDecoder(resp.Body).Decode(&o)
		return o.PublicKey.Challenge, resp.Cookies()
	}

	// 先正常登录若干次，把 sign count 推上去
	for i := 0; i < 3; i++ {
		ch, ck := begin()
		if code := login(auth.assertBody(t, rp.Config.RPID, s.selfOrigin(), ch, handle), ck); code != http.StatusOK {
			t.Fatalf("legit login %d: status=%d", i, code)
		}
	}
	// 再用回退的计数器（克隆特征）
	ch, ck := begin()
	body := auth.replayAssertBody(t, rp.Config.RPID, s.selfOrigin(), ch, handle, 1)
	if code := login(body, ck); code == http.StatusOK {
		t.Fatalf("cloned credential (rolled-back counter) was accepted")
	}
}

// 过期 ceremony 必须被拒：challenge 不得在 TTL 之后仍可兑换。
func TestPasskeyCeremonyExpires(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	auth, handle := registerTestPasskey(t, s)
	rp, _ := s.adminRP()

	breq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/begin", nil)
	breq.Header.Set("Origin", s.selfOrigin())
	bresp, err := srv.Client().Do(breq)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	var o struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	json.NewDecoder(bresp.Body).Decode(&o)
	cookies := bresp.Cookies()
	bresp.Body.Close()

	// 把时钟推过 ceremony TTL
	base := s.now()
	s.now = func() time.Time { return base.Add(passkeyCeremonyTTL + time.Minute) }

	freq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/finish",
		strings.NewReader(auth.assertBody(t, rp.Config.RPID, s.selfOrigin(), o.PublicKey.Challenge, handle)))
	freq.Header.Set("Content-Type", "application/json")
	freq.Header.Set("Origin", s.selfOrigin())
	for _, c := range cookies {
		freq.AddCookie(c)
	}
	fresp, err := srv.Client().Do(freq)
	if err != nil {
		t.Fatalf("finish: %v", err)
	}
	defer fresp.Body.Close()
	if fresp.StatusCode == http.StatusOK {
		t.Fatalf("expired ceremony was accepted")
	}
}

// ceremony 必须一次性消费：同一枚 cookie+body 成功登录一次后，重放必须被拒。
// 这是 spec 明确要求的"一次性消费，不得可重放"。
func TestPasskeyLoginCeremonyIsOneShot(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	auth, handle := registerTestPasskey(t, s)
	rp, _ := s.adminRP()

	breq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/begin", nil)
	breq.Header.Set("Origin", s.selfOrigin())
	bresp, err := srv.Client().Do(breq)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	var o struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	json.NewDecoder(bresp.Body).Decode(&o)
	cookies := bresp.Cookies()
	bresp.Body.Close()

	body := auth.assertBody(t, rp.Config.RPID, s.selfOrigin(), o.PublicKey.Challenge, handle)
	doFinish := func() int {
		freq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/finish", strings.NewReader(body))
		freq.Header.Set("Content-Type", "application/json")
		freq.Header.Set("Origin", s.selfOrigin())
		for _, c := range cookies {
			freq.AddCookie(c)
		}
		resp, err := srv.Client().Do(freq)
		if err != nil {
			t.Fatalf("finish: %v", err)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}

	if code := doFinish(); code != http.StatusOK {
		t.Fatalf("first finish status=%d want 200", code)
	}
	// 断言必须是 takeCeremony 消费失败时唯一会走到的 400（"验证已过期，请重试"），
	// 而不是宽松的 != 200：克隆计数器检查在重放时也会独立触发（测试用的认证器每次
	// 签名都会递增 signCount），返回 401，会在 guard 被拿掉的情况下悄悄让断言通过。
	if code := doFinish(); code != http.StatusBadRequest {
		t.Fatalf("replay status=%d want 400 (one-shot guard); a non-400 rejection means "+
			"the ceremony may not have been consumed and something else (e.g. the clone-warning "+
			"check) independently rejected the replay", code)
	}
}

// 未认证的 login/begin 必须存在容量上限：否则攻击者可以循环调用 begin，
// 让 in-flight ceremony 的 map 无界增长，并让每次 begin 里的过期清扫
// 退化成越来越大的 O(n) 全表扫描（还是在持锁状态下做的）。
// ceremonyCount reads the number of stored in-flight ceremonies (replaces the
// old in-memory map length now that ceremonies live in the DB).
func ceremonyCount(t *testing.T, s *Service) int {
	t.Helper()
	var n int
	if err := s.store.(*SQLiteStore).db.QueryRow(`SELECT COUNT(*) FROM admin_passkey_ceremonies`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// Two Service values sharing ONE store: a ceremony minted on instance A is
// spendable on instance B (with its SessionData intact across the JSON round
// trip) and only once — the second attempt on A fails.
func TestPasskeyCeremonySharedAcrossInstances(t *testing.T) {
	store := newTestStore(t)
	mk := func() *Service { return NewService(store, nil, Config{AdminUser: "admin", AdminPassword: "pw"}) }
	svcA, svcB := mk(), mk()

	rec := httptest.NewRecorder()
	sess := webauthn.SessionData{UserID: []byte("user-handle-42")}
	if !svcA.putCeremony(context.Background(), rec, ceremonyLogin, sess, "laptop") {
		t.Fatal("A: putCeremony failed")
	}
	var cookie *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == passkeyCeremonyCookie {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("no ceremony cookie written")
	}

	r := httptest.NewRequest("POST", "/admin/passkey/login/finish", nil)
	r.AddCookie(cookie)
	cer, ok := svcB.takeCeremony(r)
	if !ok || cer.kind != ceremonyLogin || cer.name != "laptop" {
		t.Fatalf("B must spend the ceremony A minted: ok=%v cer=%+v", ok, cer)
	}
	if string(cer.session.UserID) != "user-handle-42" {
		t.Fatalf("SessionData did not round-trip through the store: %q", cer.session.UserID)
	}

	r2 := httptest.NewRequest("POST", "/admin/passkey/login/finish", nil)
	r2.AddCookie(cookie)
	if _, ok := svcA.takeCeremony(r2); ok {
		t.Fatal("SECURITY: the ceremony was spendable a second time on instance A")
	}
}

func TestPasskeyCeremonyCapEnforced(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	registerTestPasskey(t, s)

	// 直接灌 s.putCeremony 而不走完整 WebAuthn 握手：验证的是容量上限本身，
	// 不需要每条 ceremony 都携带真实、可校验的 challenge。
	discard := httptest.NewRecorder()
	for i := 0; i < passkeyCeremonyCap; i++ {
		if !s.putCeremony(context.Background(), discard, ceremonyLogin, webauthn.SessionData{}, "") {
			t.Fatalf("putCeremony rejected before reaching the cap at i=%d", i)
		}
	}
	if n := ceremonyCount(t, s); n != passkeyCeremonyCap {
		t.Fatalf("stored ceremonies=%d want %d after filling to the cap", n, passkeyCeremonyCap)
	}

	// 再灌一条必须被拒绝，且不得继续增长（不驱逐已有条目，只拒绝新的）。
	if s.putCeremony(context.Background(), discard, ceremonyLogin, webauthn.SessionData{}, "") {
		t.Fatalf("putCeremony accepted a ceremony past the cap")
	}
	if n2 := ceremonyCount(t, s); n2 != passkeyCeremonyCap {
		t.Fatalf("stored ceremonies grew past the cap: %d want %d", n2, passkeyCeremonyCap)
	}

	// HTTP 层：到达上限后，login/begin 必须开始拒绝新请求（503），而不是悄悄放行。
	req, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/begin", nil)
	req.Header.Set("Origin", s.selfOrigin())
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("begin at cap status=%d want 503", resp.StatusCode)
	}
}
