package account

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func authRiskRequest(s *Service, path, email, ip string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", path, strings.NewReader(fmt.Sprintf(`{"email":%q,"password":"wrong-password","deviceName":"Demo"}`, email)))
	r.RemoteAddr = ip + ":12345"
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	if strings.HasSuffix(path, "/forgot") {
		s.handleForgotPassword(w, r)
	} else if strings.Contains(path, "/native/") {
		s.handleNativeLogin(w, r)
	} else {
		s.handlePasswordLogin(w, r)
	}
	return w
}

func TestAuthRiskPasswordSourceBudgetSharedAcrossWebAndNative(t *testing.T) {
	s := NewService(newTestStore(t), &capturingMailer{}, Config{})
	now := time.Now()
	s.now = func() time.Time { return now }
	for i := 0; i < 20; i++ {
		path := "/api/auth/password/login"
		if i%2 == 1 {
			path = "/api/auth/native/login"
		}
		if w := authRiskRequest(s, path, fmt.Sprintf("unknown-%d@example.com", i), "198.51.100.1"); w.Code != http.StatusUnauthorized {
			t.Fatalf("admission %d: got %d, want401", i, w.Code)
		}
	}
	if w := authRiskRequest(s, "/api/auth/password/login", "another@example.com", "198.51.100.1"); w.Code != http.StatusTooManyRequests {
		t.Fatalf("source rotating emails bypassed budget: got%d, want429", w.Code)
	}
	if w := authRiskRequest(s, "/api/auth/native/login", "another@example.com", "198.51.100.2"); w.Code != http.StatusUnauthorized {
		t.Fatalf("unrelated source blocked: %d", w.Code)
	}
	now = now.Add(time.Minute)
	if w := authRiskRequest(s, "/api/auth/native/login", "another@example.com", "198.51.100.1"); w.Code != http.StatusUnauthorized {
		t.Fatalf("source did not recover at60seconds: %d", w.Code)
	}
}

func TestAuthRiskResetCooldownAcrossSourcesAndPriorLinkSurvives(t *testing.T) {
	m := &capturingMailer{}
	s := NewService(newTestStore(t), m, Config{BaseURL: "https://relayium.test", ResetTTL: time.Hour, VerifyTTL: 24 * time.Hour, SessionTTL: time.Hour})
	now := time.Now()
	s.now = func() time.Time { return now }
	if _, err := s.Register(t.Context(), "owner@example.com", "original-password", ""); err != nil {
		t.Fatal(err)
	}
	m.count = 0
	first := authRiskRequest(s, "/api/auth/password/forgot", "owner@example.com", "198.51.100.1")
	token := tokenFromLink(t, m.lastLink)
	second := authRiskRequest(s, "/api/auth/password/forgot", "OWNER@example.com", "198.51.100.2")
	if first.Code != 200 || second.Code != 200 || first.Body.String() != second.Body.String() {
		t.Fatal("reset suppression changed neutral response")
	}
	if m.count != 1 {
		t.Fatalf("duplicate reset sends inside60seconds: got%d, want1", m.count)
	}
	now = now.Add(59 * time.Second)
	authRiskRequest(s, "/api/auth/password/forgot", "owner@example.com", "198.51.100.3")
	if m.count != 1 {
		t.Fatal("cooldown ended before60seconds")
	}
	now = now.Add(time.Second)
	authRiskRequest(s, "/api/auth/password/forgot", "owner@example.com", "198.51.100.4")
	if m.count != 2 {
		t.Fatalf("no resend at exact60second boundary: got%d,want2", m.count)
	}
	if _, err := s.ResetPassword(t.Context(), token, "replacement-password"); err != nil {
		t.Fatalf("earlier reset link lost after suppression/resend: %v", err)
	}
}

func TestAuthRiskEmailBudgetReservationIsAtomic(t *testing.T) {
	s := NewService(newTestStore(t), &capturingMailer{}, Config{})
	const workers = 256
	start := make(chan struct{})
	var wg sync.WaitGroup
	var admitted atomic.Int32
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			r := httptest.NewRequest("POST", "/api/auth/magic/request", nil)
			r.RemoteAddr = fmt.Sprintf("198.51.100.%d:1234", i)
			if s.allowEmailSend(s.magicRequests, "target@example.com", r) {
				admitted.Add(1)
			}
		}(i)
	}
	close(start)
	wg.Wait()
	if got := admitted.Load(); got != 5 {
		t.Fatalf("concurrent sources admitted%d mail sends, want exact5", got)
	}
}

func TestAuthRiskPasswordConcurrentAdmissionAndRetryAfter(t *testing.T) {
	s := NewService(newTestStore(t), &capturingMailer{}, Config{})
	now := time.Now()
	s.now = func() time.Time { return now }
	const workers = 128
	start := make(chan struct{})
	var wg sync.WaitGroup
	var admitted atomic.Int32
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			r := httptest.NewRequest("POST", "/api/auth/password/login", nil)
			r.RemoteAddr = "198.51.100.1:1234"
			w := httptest.NewRecorder()
			if s.allowPasswordAttempt(w, r) {
				admitted.Add(1)
			} else if w.Code != 429 || w.Header().Get("Retry-After") != "60" {
				t.Errorf("bad throttle response:%d/%q", w.Code, w.Header().Get("Retry-After"))
			}
		}()
	}
	close(start)
	wg.Wait()
	if got := admitted.Load(); got != 20 {
		t.Fatalf("concurrent admitted=%d,want20", got)
	}
	now = now.Add(59*time.Second + time.Millisecond)
	r := httptest.NewRequest("POST", "/api/auth/native/login", nil)
	r.RemoteAddr = "198.51.100.1:1234"
	w := httptest.NewRecorder()
	if s.allowPasswordAttempt(w, r) || w.Header().Get("Retry-After") != "1" {
		t.Fatalf("late-window retry response:%d/%s", w.Code, w.Header().Get("Retry-After"))
	}
	now = now.Add(time.Second)
	if !s.allowPasswordAttempt(httptest.NewRecorder(), r) {
		t.Fatal("blocked requests extended source cooldown")
	}
}

func TestAuthRiskSourceStateIsBoundedAndExpires(t *testing.T) {
	b := newPasswordAttemptBudget(20)
	now := time.Now()
	for i := 0; i < passwordAttemptSources; i++ {
		if ok, _ := b.allow(fmt.Sprint(i), now); !ok {
			t.Fatalf("source%d unexpectedly blocked", i)
		}
	}
	if ok, _ := b.allow("overflow", now); ok {
		t.Fatal("unbounded source allocation")
	}
	if len(b.entries) != passwordAttemptSources {
		t.Fatal("source state grew past cap")
	}
	if ok, _ := b.allow("0", now); !ok {
		t.Fatal("full table stole an existing source budget")
	}
	if ok, _ := b.allow("overflow", now.Add(time.Minute)); !ok {
		t.Fatal("expired sources were not reclaimed")
	}
	if ok, _ := b.allow("overflow", now.Add(-time.Minute)); !ok {
		t.Fatal("clock rollback left a source indefinitely locked")
	}
}

func TestAuthRiskMailStateIsBoundedAndExpires(t *testing.T) {
	th := newLoginThrottle(5)
	now := time.Now()
	for i := 0; i < emailSendBudgetKeys; i++ {
		th.entries[fmt.Sprint(i)] = &failEntry{count: 1, last: now}
	}
	if th.reserveEmail("new-source", "new-budget", now, 0) {
		t.Fatal("unbounded mail allocation")
	}
	if len(th.entries) != emailSendBudgetKeys {
		t.Fatal("mail state grew past cap")
	}
	if !th.reserveEmail("0", "1", now, 0) {
		t.Fatal("full table stole an existing mail budget")
	}
	if !th.reserveEmail("new-source", "new-budget", now.Add(adminLoginLockWindow+time.Second), 0) {
		t.Fatal("expired mail entries were not reclaimed")
	}
	if len(th.entries) != 2 {
		t.Fatalf("stale state not pruned:%d", len(th.entries))
	}
}

func TestAuthRiskResetConcurrentCooldownDoesNotLockLogin(t *testing.T) {
	m := &capturingMailer{}
	s := NewService(newTestStore(t), m, Config{BaseURL: "https://relayium.test", ResetTTL: time.Hour, VerifyTTL: 24 * time.Hour, SessionTTL: time.Hour})
	const email = "owner@example.com"
	const password = "original-password"
	if _, err := s.Register(t.Context(), email, password, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.VerifyEmail(t.Context(), tokenFromLink(t, m.lastLink), password); err != nil {
		t.Fatal(err)
	}
	m.count = 0
	const workers = 64
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			w := authRiskRequest(s, "/api/auth/password/forgot", email, fmt.Sprintf("198.51.100.%d", i))
			if w.Code != 200 {
				t.Errorf("reset response%d", w.Code)
			}
		}(i)
	}
	close(start)
	wg.Wait()
	if m.count != 1 {
		t.Fatalf("parallel reset mails=%d,want1", m.count)
	}
	r := httptest.NewRequest("POST", "/api/auth/password/login", strings.NewReader(`{"email":"owner@example.com","password":"original-password"}`))
	r.RemoteAddr = "203.0.113.1:1234"
	w := httptest.NewRecorder()
	s.handlePasswordLogin(w, r)
	if w.Code != 200 || len(w.Result().Cookies()) == 0 {
		t.Fatalf("reset spam locked owner login:%d", w.Code)
	}
}

func TestAuthRiskBlockedPasswordAttemptNeverTouchesStore(t *testing.T) {
	s := NewService(newTestStore(t), &capturingMailer{}, Config{})
	r := httptest.NewRequest("POST", "/api/auth/password/login", nil)
	r.RemoteAddr = "198.51.100.1:1234"
	for range 20 {
		if !s.allowPasswordAttempt(httptest.NewRecorder(), r) {
			t.Fatal("budget did not admit first20")
		}
	}
	// No credential lookup/hash/session work is permitted after the cap. A nil
	// store makes a misplaced late admission check fail as a panic, not a timing guess.
	s.store = nil
	for _, path := range []string{"/api/auth/password/login", "/api/auth/native/login"} {
		if w := authRiskRequest(s, path, "owner@example.com", "198.51.100.1"); w.Code != 429 {
			t.Fatalf("blocked %s returned%d", path, w.Code)
		}
	}
}

func TestAuthRiskFailedLoginCannotLockOwnerAtAnotherSource(t *testing.T) {
	m := &capturingMailer{}
	s := NewService(newTestStore(t), m, Config{BaseURL: "https://relayium.test", VerifyTTL: 24 * time.Hour, SessionTTL: time.Hour})
	if _, err := s.Register(t.Context(), "owner@example.com", "original-password", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.VerifyEmail(t.Context(), tokenFromLink(t, m.lastLink), "original-password"); err != nil {
		t.Fatal(err)
	}
	for range 5 {
		if w := authRiskRequest(s, "/api/auth/password/login", "owner@example.com", "198.51.100.1"); w.Code != 401 {
			t.Fatalf("bad credential response%d", w.Code)
		}
	}
	if w := authRiskRequest(s, "/api/auth/native/login", "owner@example.com", "198.51.100.1"); w.Code != 429 {
		t.Fatalf("failed source not paused:%d", w.Code)
	}
	r := httptest.NewRequest("POST", "/api/auth/password/login", strings.NewReader(`{"email":"owner@example.com","password":"original-password"}`))
	r.RemoteAddr = "203.0.113.1:1234"
	w := httptest.NewRecorder()
	s.handlePasswordLogin(w, r)
	if w.Code != 200 || len(w.Result().Cookies()) == 0 {
		t.Fatalf("attacker locked owner's unrelated source:%d", w.Code)
	}
}
