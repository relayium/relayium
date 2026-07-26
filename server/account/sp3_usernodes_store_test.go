package account

import (
	"context"
	"testing"
)

func TestOnlyOwnNodesFlag(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "s@x.com", "s")
	if g, _ := st.GetUserByID(ctx, u.ID); g.OnlyOwnNodes {
		t.Fatal("default must be false")
	}
	if err := st.SetOnlyOwnNodes(ctx, u.ID, true); err != nil {
		t.Fatalf("set: %v", err)
	}
	if g, _ := st.GetUserByID(ctx, u.ID); !g.OnlyOwnNodes {
		t.Fatal("flag not persisted")
	}
}

func TestUserNodesAndStorageNodes(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "un@x.com", "u")
	other, _ := st.UpsertUserByEmail(ctx, "ot@x.com", "o")
	st.UpsertNode(ctx, Node{ID: "mine", OwnerType: "user", OwnerUserID: u.ID, URLs: []string{"turn:a:3478"}, TURNSecret: "s", StorageEnabled: true, StorageFree: 10 << 30, CreatedAt: 1, LastSeenAt: 1000})
	st.UpsertNode(ctx, Node{ID: "theirs", OwnerType: "user", OwnerUserID: other.ID, URLs: []string{"turn:b:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1000})
	st.UpsertNode(ctx, Node{ID: "fleet", OwnerType: "fleet", URLs: []string{"turn:c:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1000})

	mine, _ := st.UserNodes(ctx, u.ID, 500)
	if len(mine) != 1 || mine[0].ID != "mine" {
		t.Fatalf("UserNodes = %+v", mine)
	}
	sn, _ := st.UserStorageNodes(ctx, u.ID, 500, 4<<30)
	if len(sn) != 1 || sn[0].ID != "mine" {
		t.Fatalf("UserStorageNodes = %+v", sn)
	}
	if got, _ := st.UserStorageNodes(ctx, u.ID, 500, 20<<30); len(got) != 0 {
		t.Fatal("node with 10GiB free excluded for minFree=20GiB")
	}
}
