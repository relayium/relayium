package account

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"time"
)

type Config struct {
	BaseURL        string
	SessionTTL     time.Duration
	MagicTTL       time.Duration
	GoogleClientID string
	GoogleSecret   string
	GoogleRedirect string
}

type Service struct {
	store           Store
	mailer          Mailer
	cfg             Config
	now             func() time.Time
	fetchGoogleUser func(ctx context.Context, code string) (sub, email, name string, err error)
}

func NewService(store Store, mailer Mailer, cfg Config) *Service {
	svc := &Service{store: store, mailer: mailer, cfg: cfg, now: time.Now}
	svc.fetchGoogleUser = svc.realFetchGoogleUser
	return svc
}

func randToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func (s *Service) IssueSession(ctx context.Context, userID string) (Session, error) {
	now := s.now()
	sess := Session{
		ID:        randToken(),
		UserID:    userID,
		CreatedAt: now.Unix(),
		ExpiresAt: now.Add(s.cfg.SessionTTL).Unix(),
	}
	if err := s.store.CreateSession(ctx, sess); err != nil {
		return Session{}, err
	}
	return sess, nil
}

func (s *Service) ValidateSession(ctx context.Context, sessionID string) (User, bool, error) {
	sess, ok, err := s.store.GetSession(ctx, sessionID)
	if err != nil || !ok {
		return User{}, false, err
	}
	if s.now().Unix() >= sess.ExpiresAt {
		return User{}, false, nil
	}
	u, err := s.store.GetUserByID(ctx, sess.UserID)
	if err != nil {
		return User{}, false, err
	}
	return u, true, nil
}

func (s *Service) RequestMagicLink(ctx context.Context, email string) error {
	email = normEmail(email)
	raw := randToken()
	now := s.now()
	tok := MagicToken{
		TokenHash: hashToken(raw),
		Email:     email,
		CreatedAt: now.Unix(),
		ExpiresAt: now.Add(s.cfg.MagicTTL).Unix(),
	}
	if err := s.store.CreateMagicToken(ctx, tok); err != nil {
		return err
	}
	link := fmt.Sprintf("%s/api/auth/magic/verify?token=%s", s.cfg.BaseURL, url.QueryEscape(raw))
	return s.mailer.SendMagicLink(ctx, email, link)
}

func (s *Service) VerifyMagicLink(ctx context.Context, rawToken string) (Session, error) {
	tok, ok, err := s.store.UseMagicToken(ctx, hashToken(rawToken), s.now().Unix())
	if err != nil {
		return Session{}, err
	}
	if !ok {
		return Session{}, fmt.Errorf("invalid or expired token")
	}
	u, err := s.store.UpsertUserByEmail(ctx, tok.Email, "")
	if err != nil {
		return Session{}, err
	}
	if err := s.store.LinkIdentity(ctx, "email", tok.Email, u.ID); err != nil {
		return Session{}, err
	}
	return s.IssueSession(ctx, u.ID)
}
