package account

import (
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
)

// The admin console is the one product surface that was Chinese-only. These
// tests hold the three things that make the English translation safe rather
// than merely present.

func TestAdminLangFromAcceptLanguage(t *testing.T) {
	cases := []struct{ header, want string }{
		{"", "zh"}, // no header: keep what the console always rendered
		{"en-US,en;q=0.9", "en"},
		{"en", "en"},
		{"zh-CN,zh;q=0.9,en;q=0.8", "zh"}, // Chinese first wins, even with English present
		{"en-GB,zh;q=0.5", "en"},          // and the other way round
		{"de-DE,de;q=0.9", "zh"},          // a language we do not have falls back, it does not error
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "/admin", nil)
		if c.header != "" {
			r.Header.Set("Accept-Language", c.header)
		}
		if got := adminLangFrom(r); got != c.want {
			t.Errorf("Accept-Language %q = %q, want %q", c.header, got, c.want)
		}
	}
}

func TestAdminTFallsBackToChinese(t *testing.T) {
	// The property that makes a partial translation shippable: an unknown string
	// renders as the Chinese that is on the page today, never as an empty label
	// or a raw key. Without it, every commit that adds a template string would
	// be able to ship a blank control to a self-hoster.
	if got := adminT("en", "这一句还没有翻译"); got != "这一句还没有翻译" {
		t.Errorf("untranslated string in English = %q, want the Chinese back", got)
	}
	if got := adminT("zh", "登录"); got != "登录" {
		t.Errorf("Chinese request returned %q", got)
	}
	if got := adminT("en", "登录"); got != "Sign in" {
		t.Errorf("English %q, want %q", got, "Sign in")
	}
}

func TestAdminLoginRendersInEnglish(t *testing.T) {
	var sb strings.Builder
	if err := adminLoginTmpl.Execute(&sb, adminLoginData{Lang: "en", TOTP: true, Passkey: true}); err != nil {
		t.Fatalf("execute: %v", err)
	}
	out := sb.String()
	for _, want := range []string{"Relayium admin", "Admin username", "Admin password", "Sign in"} {
		if !strings.Contains(out, want) {
			t.Errorf("English login page missing %q", want)
		}
	}
	// And the Chinese it replaced is gone, so this cannot pass on a page that
	// simply renders both.
	for _, gone := range []string{"管理员账号", "管理员密码"} {
		if strings.Contains(out, gone) {
			t.Errorf("English login page still shows %q", gone)
		}
	}
}

func TestAdminLoginStillRendersChineseByDefault(t *testing.T) {
	// The zero value of Lang is "", which must keep the console exactly as it
	// was. A regression here is invisible to Chinese operators until they see an
	// English console one morning.
	var sb strings.Builder
	if err := adminLoginTmpl.Execute(&sb, adminLoginData{}); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !strings.Contains(sb.String(), "管理员账号") {
		t.Error("default render is no longer Chinese")
	}
}

var cjk = regexp.MustCompile(`\p{Han}`)

// wrappedStrings returns every literal passed to {{t $.Lang "..."}} in the
// admin templates, read from the source rather than from a hand-kept list.
func wrappedStrings(t *testing.T) map[string]bool {
	t.Helper()
	src, err := os.ReadFile("admin_templates.go")
	if err != nil {
		t.Fatalf("read templates: %v", err)
	}
	out := map[string]bool{}
	re := regexp.MustCompile(`\{\{t \$\.Lang "((?:[^"\\]|\\.)*)"\}\}`)
	for _, m := range re.FindAllStringSubmatch(string(src), -1) {
		out[strings.ReplaceAll(m[1], `\"`, `"`)] = true
	}
	return out
}

func TestEveryTranslationIsActuallyUsed(t *testing.T) {
	// A dead entry is not harmless: it is a string someone believes is
	// translated. When the template it belonged to changes wording, the map
	// keeps answering for text that no longer exists and nobody notices the
	// real string went untranslated.
	used := wrappedStrings(t)
	if len(used) < 100 {
		t.Fatalf("only found %d wrapped strings — the scan is broken, not the map", len(used))
	}
	for zh := range adminEN {
		if !used[zh] {
			t.Errorf("adminEN has %q, which no template asks for", zh)
		}
	}
}

func TestEveryWrappedStringHasEnglish(t *testing.T) {
	// The other direction. Fallback means a gap is not a crash, so nothing else
	// would ever tell us a label is still Chinese for an English operator.
	for zh := range wrappedStrings(t) {
		if !cjk.MatchString(zh) {
			continue // some wrapped strings are already language-neutral
		}
		if _, ok := adminEN[zh]; !ok {
			t.Errorf("no English for %q", zh)
		}
	}
}

func TestConfirmTextIsTranslatedAndJSEscaped(t *testing.T) {
	// The confirm() strings live in a JS string inside an HTML attribute. That is
	// the context where html/template escaping is easiest to get wrong and
	// hardest to notice, and it is attached to rollback and removal buttons — so
	// it gets its own test rather than riding on the generic render check.
	var sb strings.Builder
	data := adminHomeData{Lang: "en", RolloutFleet: rolloutPanelView{Lang: "en", Track: "fleet", Configured: true, Status: "rolling"}}
	if err := adminUsersTmpl.Execute(&sb, data); err != nil {
		t.Fatalf("execute: %v", err)
	}
	out := sb.String()
	for _, want := range []string{"Pause this track", "Roll this track back"} {
		if !strings.Contains(out, want) {
			t.Errorf("English admin page missing confirm text %q", want)
		}
	}
	if strings.Contains(out, "暂停该轨的发布？") {
		t.Error("English page still carries the Chinese confirm text")
	}
}

func TestATranslationCannotBreakOutOfTheConfirmString(t *testing.T) {
	// Adversarial: a translation containing a quote must be escaped by the
	// template, not end the JS string. If this ever regresses, a translator --
	// or anyone who edits adminEN -- gains script injection on the admin console.
	orig, had := adminEN["暂停该轨的发布？"]
	adminEN["暂停该轨的发布？"] = `x'); alert('pwned`
	defer func() {
		if had {
			adminEN["暂停该轨的发布？"] = orig
		} else {
			delete(adminEN, "暂停该轨的发布？")
		}
	}()

	var sb strings.Builder
	data := adminHomeData{Lang: "en", RolloutFleet: rolloutPanelView{Lang: "en", Track: "fleet", Configured: true, Status: "rolling"}}
	if err := adminUsersTmpl.Execute(&sb, data); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if strings.Contains(sb.String(), `alert('pwned`) {
		t.Error("a quote in a translation escaped the JS string literal")
	}
}

func TestAdminLangCookieBeatsTheHeader(t *testing.T) {
	// The reason the picker exists: a great many browsers send en-US first no
	// matter who is holding them, so the header alone handed Chinese operators an
	// English console. An explicit choice has to win.
	r := httptest.NewRequest("GET", "/admin", nil)
	r.Header.Set("Accept-Language", "en-US,en;q=0.9")
	r.AddCookie(&http.Cookie{Name: adminLangCookie, Value: "zh"})
	if got := adminLangFrom(r); got != "zh" {
		t.Errorf("cookie zh with English header = %q, want zh", got)
	}

	r2 := httptest.NewRequest("GET", "/admin", nil)
	r2.Header.Set("Accept-Language", "zh-CN")
	r2.AddCookie(&http.Cookie{Name: adminLangCookie, Value: "en"})
	if got := adminLangFrom(r2); got != "en" {
		t.Errorf("cookie en with Chinese header = %q, want en", got)
	}

	// A junk cookie must not win, and must not error — it falls back to the
	// header, which is the same as never having chosen.
	r3 := httptest.NewRequest("GET", "/admin", nil)
	r3.Header.Set("Accept-Language", "en")
	r3.AddCookie(&http.Cookie{Name: adminLangCookie, Value: "../../etc/passwd"})
	if got := adminLangFrom(r3); got != "en" {
		t.Errorf("junk cookie = %q, want the header's en", got)
	}
}

func TestAdminLangReturnPathCannotLeaveTheConsole(t *testing.T) {
	// The Referer is attacker-influenceable, so it is reduced to a path under
	// /admin or discarded. Anything else would make the console a redirector.
	cases := map[string]string{
		"":                                 "/admin",
		"https://relayium.com/admin/audit": "/admin/audit",
		"https://relayium.com/admin?q=x":   "/admin?q=x",
		"https://evil.example/admin/audit": "/admin/audit", // host discarded, path kept
		"https://relayium.com/me":          "/admin",
		"https://evil.example/":            "/admin",
		"//evil.example/admin":             "/admin",
		"/adminsomething":                  "/admin",
		"::::not a url":                    "/admin",
	}
	for referer, want := range cases {
		if got := adminReturnPath(referer); got != want {
			t.Errorf("adminReturnPath(%q) = %q, want %q", referer, got, want)
		}
	}
}

func TestLanguagePickerIsOnEveryConsolePage(t *testing.T) {
	// One page having it is worse than none: an operator who lands on the audit
	// log with the console in the wrong language should not have to guess that
	// the control lives somewhere else.
	pages := map[string]func() (string, error){
		"login": func() (string, error) {
			var sb strings.Builder
			err := adminLoginTmpl.Execute(&sb, adminLoginData{Lang: "en"})
			return sb.String(), err
		},
		"home": func() (string, error) {
			var sb strings.Builder
			err := adminUsersTmpl.Execute(&sb, adminHomeData{Lang: "en"})
			return sb.String(), err
		},
		"audit": func() (string, error) {
			var sb strings.Builder
			err := adminAuditTmpl.Execute(&sb, adminAuditData{Lang: "en"})
			return sb.String(), err
		},
	}
	for name, render := range pages {
		out, err := render()
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !strings.Contains(out, `action="/admin/lang"`) {
			t.Errorf("%s page has no language picker", name)
		}
		// The current language is marked, so the control says which one you are
		// on rather than only offering a swap.
		if !strings.Contains(out, `value="en" class="on"`) {
			t.Errorf("%s page does not mark English as current", name)
		}
	}
}
