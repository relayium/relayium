package account

import (
	"net/http"
	"strings"
	"testing"
)

// 企业邮件网关（Proofpoint / Mimecast / Defender Safe Links）在投递前会预取邮件里的
// 每一个链接。原来的登录链接是一个 GET：读令牌 → 消费 → 下发 30 天会话 cookie。
// 于是每封登录邮件都有两个后果：
//  1. 一次性令牌被扫描器烧掉，用户真的点开时看到"链接已过期"；
//  2. 一个**活着的登录态**被 Set-Cookie 交给了扫描器的 HTTP 客户端。
//
// 这条用例模拟的就是那次预取：先 GET，再 POST。GET 之后 POST 仍然必须成功。
func TestMailGatewayPrefetchDoesNotBurnTheLoginLink(t *testing.T) {
	ts, mail := newTestServer(t)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	if _, err := client.PostForm(ts.URL+"/api/auth/magic/request",
		map[string][]string{"email": {"prefetch@example.com"}}); err != nil {
		t.Fatal(err)
	}
	i := strings.Index(mail.lastLink, "token=")
	if i < 0 {
		t.Fatalf("no link captured: %q", mail.lastLink)
	}
	token := mail.lastLink[i+len("token="):]

	// —— 扫描器预取，甚至预取两次 ——
	for n := 0; n < 2; n++ {
		resp, err := client.Get(ts.URL + "/api/auth/magic/verify?token=" + token)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusFound {
			t.Fatalf("prefetch %d: got %d, want a redirect", n, resp.StatusCode)
		}
		for _, c := range resp.Cookies() {
			if c.Name == sessionCookie {
				t.Fatal("the prefetch received a session cookie — a live login handed to a third-party scanner")
			}
		}
		if loc := resp.Header.Get("Location"); !strings.HasPrefix(loc, magicLinkPath+"?token=") {
			t.Fatalf("prefetch %d redirected to %q, want the SPA page", n, loc)
		}
	}

	// —— 用户随后真的点了页面上的按钮 ——
	resp, err := client.Post(ts.URL+"/api/auth/magic/verify", "application/json",
		strings.NewReader(`{"token":"`+token+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("the real click got %d — the prefetch burned the token", resp.StatusCode)
	}
	if !hasSessionCookie(resp.Cookies()) {
		t.Fatal("the real click did not sign the user in")
	}
}

// 一次性语义必须保留：POST 消费之后，同一个令牌不能再登一次。
func TestMagicTokenIsStillSingleUse(t *testing.T) {
	ts, mail := newTestServer(t)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	_, _ = client.PostForm(ts.URL+"/api/auth/magic/request", map[string][]string{"email": {"once@example.com"}})
	i := strings.Index(mail.lastLink, "token=")
	token := mail.lastLink[i+len("token="):]

	post := func() int {
		resp, err := client.Post(ts.URL+"/api/auth/magic/verify", "application/json",
			strings.NewReader(`{"token":"`+token+`"}`))
		if err != nil {
			t.Fatal(err)
		}
		return resp.StatusCode
	}
	if got := post(); got != http.StatusOK {
		t.Fatalf("first use: %d", got)
	}
	if got := post(); got == http.StatusOK {
		t.Fatal("the token signed in twice — one-time use was lost in the GET->POST move")
	}
}

// GET 不做有效性预检，所以对垃圾令牌也照转不误——它必须不是一个「这个令牌有效吗」
// 的预言机。
func TestMagicGetIsNotAValidityOracle(t *testing.T) {
	ts, _ := newTestServer(t)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Get(ts.URL + "/api/auth/magic/verify?token=totally-made-up")
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("a bogus token got %d — the GET must answer identically for valid and invalid tokens", resp.StatusCode)
	}
}
