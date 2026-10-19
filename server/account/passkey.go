package account

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/url"

	"github.com/go-webauthn/webauthn/webauthn"
)

// rpDisplayName is shown by the platform's passkey prompt.
const rpDisplayName = "Relayium 后台"

// AdminRelyingParty derives the WebAuthn origin and RP ID from a base URL.
// RPID must be the bare host with no port (browsers reject a port in the RP
// ID), while the origin check uses the full scheme://host[:port] value. The
// server and the local admin command both use this one function, so the
// binding a grant is minted with and the one it is checked against cannot
// drift apart.
func AdminRelyingParty(baseURL string) (origin, rpID string, err error) {
	u, err := url.Parse(baseURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", "", errors.New("passkey: BaseURL 未配置或无效")
	}
	origin = u.Scheme + "://" + u.Host
	rpID = u.Hostname()
	if rpID == "" {
		return "", "", errors.New("passkey: BaseURL 缺少 host")
	}
	return origin, rpID, nil
}

// adminRP builds the WebAuthn relying party from BaseURL.
func (s *Service) adminRP() (*webauthn.WebAuthn, error) {
	origin, rpID, err := AdminRelyingParty(s.cfg.BaseURL)
	if err != nil {
		return nil, err
	}
	return webauthn.New(&webauthn.Config{
		RPID:          rpID,
		RPDisplayName: rpDisplayName,
		RPOrigins:     []string{origin},
	})
}

// adminPasskeyUser is the single WebAuthn user backing the admin panel. handle
// is the stable WebAuthn user ID, deliberately independent of the configured
// admin username: name is display-only.
type adminPasskeyUser struct {
	handle []byte
	name   string
	creds  []webauthn.Credential
}

func (u *adminPasskeyUser) WebAuthnID() []byte                         { return u.handle }
func (u *adminPasskeyUser) WebAuthnName() string                       { return u.name }
func (u *adminPasskeyUser) WebAuthnDisplayName() string                { return u.name }
func (u *adminPasskeyUser) WebAuthnCredentials() []webauthn.Credential { return u.creds }

// loadAdminPasskeyUser assembles the admin user from stored credentials. With
// no credentials registered the handle is empty; the first enrollment mints
// one (AdminAuthStore.StartEnrollment).
func (s *Service) loadAdminPasskeyUser(ctx context.Context) (*adminPasskeyUser, error) {
	u := &adminPasskeyUser{name: s.adminUser()}
	handle, ok, err := s.store.AdminUserHandle(ctx)
	if err != nil {
		return nil, err
	}
	if ok {
		u.handle = handle
	}
	rows, err := s.store.ListAdminCredentials(ctx)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		var c webauthn.Credential
		if err := json.Unmarshal(row.CredJSON, &c); err != nil {
			// A single corrupt row must not lock the admin out of every passkey.
			log.Printf("passkey: skipping unreadable credential row: %v", err)
			continue
		}
		u.creds = append(u.creds, c)
	}
	return u, nil
}

// AdminPasskeyCount reports how many passkeys are registered; 0 means the login
// page must not offer the passkey button.
func (s *Service) AdminPasskeyCount(ctx context.Context) int {
	// The login page calls this on every render. With no store to ask, answer
	// "no passkeys": the page then explains how to enroll one, and nothing can
	// sign in or confirm a high-risk action (both require a registered key).
	if s.store == nil {
		return 0
	}
	n, err := s.store.CountAdminCredentials(ctx)
	if err != nil {
		log.Printf("passkey: CountAdminCredentials failed: %v (hiding passkey button)", err)
		return 0
	}
	return n
}
