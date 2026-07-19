package account

import (
	"context"
	"crypto/rand"
	"net/http"
	"strings"
	"testing"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

// RP ID 必须是去端口的 host：带端口会被浏览器拒绝。
func TestAdminRPIDDerivation(t *testing.T) {
	cases := []struct {
		baseURL string
		wantRP  string
		wantErr bool
	}{
		{"https://relayium.com", "relayium.com", false},
		{"https://relayium.com:8443", "relayium.com", false},
		{"http://localhost:8080", "localhost", false},
		{"", "", true},
	}
	for _, tc := range cases {
		s := &Service{cfg: Config{BaseURL: tc.baseURL}}
		rp, err := s.adminRP()
		if tc.wantErr {
			if err == nil {
				t.Fatalf("%q: want error, got none", tc.baseURL)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%q: %v", tc.baseURL, err)
		}
		if rp.Config.RPID != tc.wantRP {
			t.Fatalf("%q: RPID=%q want %q", tc.baseURL, rp.Config.RPID, tc.wantRP)
		}
	}
}

// 库层完整往返：注册一枚凭据，再用它做 discoverable 登录。
func TestPasskeyRoundTripAtLibraryLayer(t *testing.T) {
	const rpID, origin = "localhost", "https://localhost"
	w, err := webauthn.New(&webauthn.Config{
		RPID: rpID, RPDisplayName: "Relayium 后台", RPOrigins: []string{origin},
	})
	if err != nil {
		t.Fatalf("new rp: %v", err)
	}

	auth := newTestAuthenticator(t)
	handle := make([]byte, 32)
	if _, err := rand.Read(handle); err != nil {
		t.Fatalf("handle: %v", err)
	}
	user := &adminPasskeyUser{handle: handle, name: "admin"}

	creation, sess, err := w.BeginRegistration(user,
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		}),
	)
	if err != nil {
		t.Fatalf("begin registration: %v", err)
	}
	if creation.Response.Challenge.String() == "" {
		t.Fatalf("empty challenge")
	}

	req, _ := http.NewRequest("POST", "/", strings.NewReader(
		auth.registerBody(t, rpID, origin, sess.Challenge)))
	req.Header.Set("Content-Type", "application/json")

	cred, err := w.FinishRegistration(user, *sess, req)
	if err != nil {
		t.Fatalf("finish registration: %v", err)
	}
	user.creds = append(user.creds, *cred)

	_, lsess, err := w.BeginDiscoverableLogin(
		webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		t.Fatalf("begin login: %v", err)
	}
	lreq, _ := http.NewRequest("POST", "/", strings.NewReader(
		auth.assertBody(t, rpID, origin, lsess.Challenge, handle)))
	lreq.Header.Set("Content-Type", "application/json")

	handler := func(rawID, userHandle []byte) (webauthn.User, error) { return user, nil }
	_, lcred, err := w.FinishPasskeyLogin(handler, *lsess, lreq)
	if err != nil {
		t.Fatalf("finish login: %v", err)
	}
	if lcred.Authenticator.CloneWarning {
		t.Fatalf("unexpected clone warning on first login")
	}
}

// 错误 challenge 必须被拒绝。
func TestPasskeyRejectsWrongChallenge(t *testing.T) {
	const rpID, origin = "localhost", "https://localhost"
	w, _ := webauthn.New(&webauthn.Config{
		RPID: rpID, RPDisplayName: "Relayium 后台", RPOrigins: []string{origin},
	})
	auth := newTestAuthenticator(t)
	handle := make([]byte, 32)
	rand.Read(handle)
	user := &adminPasskeyUser{handle: handle, name: "admin"}

	_, sess, _ := w.BeginRegistration(user,
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		}))
	req, _ := http.NewRequest("POST", "/", strings.NewReader(
		auth.registerBody(t, rpID, origin, "aGVsbG8td3JvbmctY2hhbGxlbmdl")))
	req.Header.Set("Content-Type", "application/json")
	if _, err := w.FinishRegistration(user, *sess, req); err == nil {
		t.Fatalf("wrong challenge accepted")
	}
}

// 空表时 loadAdminPasskeyUser 返回空 handle 的 user（首次注册再铸 handle）。
func TestLoadAdminPasskeyUserEmpty(t *testing.T) {
	s := &Service{cfg: Config{BaseURL: "https://localhost", AdminUser: "root"}, store: newTestStore(t)}
	u, err := s.loadAdminPasskeyUser(context.Background())
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(u.handle) != 0 || len(u.creds) != 0 {
		t.Fatalf("empty store: handle=%d creds=%d, want 0/0", len(u.handle), len(u.creds))
	}
	if u.WebAuthnName() != "root" {
		t.Fatalf("name=%q want root", u.WebAuthnName())
	}
}
