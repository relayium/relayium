package account

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
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
	_, sess, err := rp.BeginRegistration(user, adminRegistrationOpts()...)
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
	if admin == "" || !s.validAdmin(admin) {
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
func TestPasskeyEndpointsRequireOrigin(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	registerTestPasskey(t, s)
	req, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/begin", nil)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("no-Origin begin status=%d want 403", resp.StatusCode)
	}
}

// 核心安全断言：passkey 失败刷爆后，密码后备通道必须仍然可用。
// 两者共用一个 throttle 桶会让攻击者用 passkey 失败锁死唯一退路。
func TestPasskeyThrottleDoesNotLockPasswordLogin(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	auth, handle := registerTestPasskey(t, s)
	rp, _ := s.adminRP()

	for i := 0; i < adminLoginMaxFails+3; i++ {
		// 取一个合法 ceremony，再用错误 challenge 签名 → 必然验签失败
		breq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/begin", nil)
		breq.Header.Set("Origin", s.selfOrigin())
		bresp, err := srv.Client().Do(breq)
		if err != nil {
			t.Fatalf("begin %d: %v", i, err)
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
		fresp.Body.Close()
		if fresp.StatusCode == http.StatusOK {
			t.Fatalf("bad challenge accepted at attempt %d", i)
		}
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
