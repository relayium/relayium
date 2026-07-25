package account

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/authx"
)

// 会话令牌就是 cookie 的值。明文入库意味着任何一次**只读**的库泄露——备份、快照、
// 卷、一条 SELECT 的注入——都直接等于所有在线用户的会话，而 TTL 是 14 天。
// 本项目其余每一种令牌本来就都是哈希存的，这几条用例把用户会话也钉在同一条线上。
func TestSessionTokenNotStoredInPlaintext(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "s@example.com", "S")

	raw := authx.RandToken()
	if err := store.CreateSession(ctx, Session{ID: raw, UserID: u.ID, CreatedAt: 1, ExpiresAt: 1 << 40}); err != nil {
		t.Fatal(err)
	}

	var stored string
	if err := store.db.QueryRowContext(ctx, `SELECT id FROM sessions WHERE user_id = ?`, u.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored == raw {
		t.Fatal("session token is stored verbatim — a read-only DB leak hands over every live session")
	}
	if stored != authx.HashToken(raw) {
		t.Fatalf("stored id = %q, want sha256 of the token", stored)
	}

	// 哈希之后仍然必须能用原始令牌查回来，否则就是把所有人都登出了。
	got, ok, err := store.GetSession(ctx, raw)
	if err != nil || !ok {
		t.Fatalf("GetSession(raw) = %v, %v — the cookie must still authenticate", ok, err)
	}
	if got.ID != raw {
		t.Errorf("GetSession returned ID %q, want the raw token — a hash handed back here could end up in a Set-Cookie", got.ID)
	}
	if got.UserID != u.ID {
		t.Errorf("session belongs to %q, want %q", got.UserID, u.ID)
	}
	// 拿库里那个哈希当 cookie 用必须无效（否则泄露了哈希就等于泄露了会话）。
	if _, ok, _ := store.GetSession(ctx, stored); ok {
		t.Error("the stored hash authenticates as a token — hashing bought nothing")
	}
}

func TestRevokeSessionHashesToken(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "r@example.com", "R")
	raw := authx.RandToken()
	_ = store.CreateSession(ctx, Session{ID: raw, UserID: u.ID, CreatedAt: 1, ExpiresAt: 1 << 40})

	if err := store.RevokeSession(ctx, raw); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := store.GetSession(ctx, raw); ok {
		t.Fatal("logout did not revoke the session — RevokeSession must hash the same way GetSession does")
	}
}

// 改密码走的是「撤销除当前会话外的全部」。exceptID 忘了哈希的话，比较永远不相等，
// 用户改完密码连自己也被登出——一个只在真用户手里才会发现的 bug。
func TestRevokeUserSessionsKeepsTheCurrentOne(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "k@example.com", "K")
	mine, other := authx.RandToken(), authx.RandToken()
	_ = store.CreateSession(ctx, Session{ID: mine, UserID: u.ID, CreatedAt: 1, ExpiresAt: 1 << 40})
	_ = store.CreateSession(ctx, Session{ID: other, UserID: u.ID, CreatedAt: 1, ExpiresAt: 1 << 40})

	if err := store.RevokeUserSessions(ctx, u.ID, mine); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := store.GetSession(ctx, mine); !ok {
		t.Error("the current session was revoked too — exceptID must be hashed before comparing")
	}
	if _, ok, _ := store.GetSession(ctx, other); ok {
		t.Error("the other session survived — it should have been revoked")
	}
}

// 升级路径：老库里存的是原始令牌。切换之后那些行既不该再验证通过，也不该被
// 「原样当 cookie 用」这条最朴素的攻击打穿。
func TestLegacyPlaintextSessionRowsAreInert(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "l@example.com", "L")

	legacy := authx.RandToken()
	if _, err := store.db.ExecContext(ctx,
		`INSERT INTO sessions (id, user_id, created_at, expires_at, revoked) VALUES (?, ?, 1, ?, 0)`,
		legacy, u.ID, int64(1)<<40); err != nil && !strings.Contains(err.Error(), "UNIQUE") {
		t.Fatal(err)
	}
	if _, ok, _ := store.GetSession(ctx, legacy); ok {
		t.Fatal("a pre-upgrade plaintext session row still authenticates")
	}
	// 到期时会被 DeleteExpiredSessions 收走，不需要单独迁移。
	var n int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sessions`).Scan(&n); err != nil && err != sql.ErrNoRows {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("expected the legacy row to still be present (harmless), got %d rows", n)
	}
}
