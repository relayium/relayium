package account

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/relayium/relayium/authx"
)

// Browsers cap persistent cookies. Refresh on each authorized request, while
// server-side authorization remains valid until explicitly revoked.
const adminBrowserCookieLifetime = 400 * 24 * time.Hour

// Preserve compatibility with older readers of the NOT NULL expires_at column.
// This legacy metadata is not an authorization deadline in current readers.
const adminBrowserLegacyExpiry int64 = 253402300799 // 9999-12-31T23:59:59Z
const adminBrowserCapacity = 1024

var ErrAdminBrowserGrant = errors.New("browser authorization link is invalid, expired, cancelled or already used")

var adminBrowserSchema = []string{
	`CREATE TABLE IF NOT EXISTS admin_browser_grants (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 origin TEXT NOT NULL, admin_path TEXT NOT NULL, created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, consumed_at INTEGER NOT NULL DEFAULT 0,
 cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0,1)))`,
	`CREATE TABLE IF NOT EXISTS admin_browsers (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 origin TEXT NOT NULL, admin_path TEXT NOT NULL, created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, revoked_at INTEGER NOT NULL DEFAULT 0)`,
}

type AdminBrowserGrant struct {
	ID, Token, Name string
	ExpiresAt       int64
}
type AdminBrowserInfo struct {
	ID, Name                        string
	CreatedAt, ExpiresAt, RevokedAt int64
}

func browserHash(token string) string      { return authx.HashToken("admin-browser-cookie:" + token) }
func browserGrantHash(token string) string { return authx.HashToken("admin-browser-grant:" + token) }
func browserTokenShape(token string) bool {
	if len(token) != 64 {
		return false
	}
	for _, c := range token {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// StartBrowserGrant is local-CLI authority only. Only hashes are persisted;
// grants are purpose-separated from cookies and bound to the exact console.
func (a *AdminAuthStore) StartBrowserGrant(ctx context.Context, name, origin, path string, ttl time.Duration, now int64, actor string) (AdminBrowserGrant, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 64 || strings.ContainsAny(name, "\x00\r\n") {
		return AdminBrowserGrant{}, fmt.Errorf("--name must contain 1-64 characters on one line")
	}
	o, _, err := AdminRelyingParty(origin)
	if err != nil || o != origin {
		return AdminBrowserGrant{}, fmt.Errorf("invalid browser authorization origin")
	}
	p, err := ResolveAdminPath(path)
	if err != nil || p != path {
		return AdminBrowserGrant{}, fmt.Errorf("invalid browser authorization path")
	}
	if ttl < time.Minute || ttl > time.Hour {
		return AdminBrowserGrant{}, fmt.Errorf("--ttl must be between 1m and 1h")
	}
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return AdminBrowserGrant{}, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `DELETE FROM admin_browser_grants WHERE expires_at<=?`, now); err != nil {
		return AdminBrowserGrant{}, err
	}
	g := AdminBrowserGrant{ID: authx.NewID(), Token: authx.RandToken(), Name: name, ExpiresAt: now + int64(ttl/time.Second)}
	result, err := tx.ExecContext(ctx, `INSERT INTO admin_browser_grants(id,token_hash,name,origin,admin_path,created_at,expires_at)
 SELECT ?,?,?,?,?,?,? WHERE (SELECT count(*) FROM admin_browser_grants)<1024
 AND (SELECT count(*) FROM admin_browser_grants WHERE consumed_at=0 AND cancelled=0 AND expires_at>?)<16`, g.ID, browserGrantHash(g.Token), name, origin, path, now, g.ExpiresAt, now)
	if err != nil {
		return AdminBrowserGrant{}, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return AdminBrowserGrant{}, err
	}
	if n != 1 {
		return AdminBrowserGrant{}, fmt.Errorf("too many browser authorization links; cancel open links or wait for expiry")
	}
	if err = insertCLIAudit(ctx, tx, now, actor, "browser.grant.start", "browser-grant:"+g.ID, []ChangeField{{Field: "name", New: name}}); err != nil {
		return AdminBrowserGrant{}, err
	}
	return g, tx.Commit()
}

// Consuming the grant and minting exactly one browser are one writer
// transaction. A concurrent cancellation/redemption cannot reuse the grant.
func (s *SQLiteStore) RedeemAdminBrowserGrant(ctx context.Context, token, origin, path string, now int64) (string, error) {
	if !browserTokenShape(token) {
		return "", ErrAdminBrowserGrant
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var id, name string
	err = tx.QueryRowContext(ctx, `SELECT id,name FROM admin_browser_grants WHERE token_hash=? AND origin=? AND admin_path=? AND expires_at>? AND consumed_at=0 AND cancelled=0`, browserGrantHash(token), origin, path, now).Scan(&id, &name)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrAdminBrowserGrant
	}
	if err != nil {
		return "", err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM admin_browsers WHERE revoked_at>0`); err != nil {
		return "", err
	}
	var count int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM admin_browsers`).Scan(&count); err != nil {
		return "", err
	}
	if count >= adminBrowserCapacity {
		return "", fmt.Errorf("browser authorization capacity reached")
	}
	raw := authx.RandToken()
	if _, err = tx.ExecContext(ctx, `INSERT INTO admin_browsers(id,token_hash,name,origin,admin_path,created_at,expires_at) VALUES(?,?,?,?,?,?,?)`, authx.NewID(), browserHash(raw), name, origin, path, now, adminBrowserLegacyExpiry); err != nil {
		return "", err
	}
	result, err := tx.ExecContext(ctx, `UPDATE admin_browser_grants SET consumed_at=? WHERE id=? AND consumed_at=0 AND cancelled=0 AND expires_at>?`, now, id, now)
	if err != nil {
		return "", err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return "", err
	}
	if n != 1 {
		return "", ErrAdminBrowserGrant
	}
	if err = tx.Commit(); err != nil {
		return "", err
	}
	return raw, nil
}

func (s *SQLiteStore) AdminBrowserAuthorized(ctx context.Context, token, origin, path string, now int64) (bool, error) {
	if !browserTokenShape(token) {
		return false, nil
	}
	var one int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM admin_browsers WHERE token_hash=? AND origin=? AND admin_path=? AND revoked_at=0`, browserHash(token), origin, path).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (a *AdminAuthStore) ListBrowsers(ctx context.Context) ([]AdminBrowserInfo, error) {
	rows, err := a.db.QueryContext(ctx, `SELECT id,name,created_at,expires_at,revoked_at FROM admin_browsers ORDER BY created_at,id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AdminBrowserInfo{}
	for rows.Next() {
		var b AdminBrowserInfo
		if err = rows.Scan(&b.ID, &b.Name, &b.CreatedAt, &b.ExpiresAt, &b.RevokedAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (a *AdminAuthStore) ChangeBrowserAuthorization(ctx context.Context, id string, cancelGrant bool, now int64, actor string) error {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	query := `UPDATE admin_browsers SET revoked_at=? WHERE id=? AND revoked_at=0`
	action := "browser.revoke"
	if cancelGrant {
		query = `UPDATE admin_browser_grants SET cancelled=1 WHERE ? > 0 AND id=? AND consumed_at=0 AND cancelled=0`
		action = "browser.grant.cancel"
	}
	result, err := tx.ExecContext(ctx, query, now, id)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return fmt.Errorf("authorization not found or already decided")
	}
	if err = insertCLIAudit(ctx, tx, now, actor, action, "browser:"+id, nil); err != nil {
		return err
	}
	return tx.Commit()
}
