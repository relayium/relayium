package account

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"

	"github.com/go-webauthn/webauthn/webauthn"
)

// rpDisplayName is shown by the platform's passkey prompt.
const rpDisplayName = "Relayium 后台"

// adminRP builds the WebAuthn relying party from BaseURL. RPID must be the bare
// host with no port (browsers reject a port in the RP ID), while the origin
// check uses the full scheme://host[:port] value.
func (s *Service) adminRP() (*webauthn.WebAuthn, error) {
	origin := s.selfOrigin()
	if origin == "" {
		return nil, errors.New("passkey: BaseURL 未配置或无效")
	}
	u, err := url.Parse(origin)
	if err != nil {
		return nil, err
	}
	host := u.Hostname()
	if host == "" {
		return nil, errors.New("passkey: BaseURL 缺少 host")
	}
	return webauthn.New(&webauthn.Config{
		RPID:          host,
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
// no credentials registered the handle is empty; the first registration mints
// one.
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
			continue
		}
		u.creds = append(u.creds, c)
	}
	return u, nil
}

// adminPasskeyCount reports how many passkeys are registered; 0 means the login
// page must not offer the passkey button.
func (s *Service) adminPasskeyCount(ctx context.Context) int {
	rows, err := s.store.ListAdminCredentials(ctx)
	if err != nil {
		return 0
	}
	return len(rows)
}
