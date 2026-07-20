package account

import (
	"testing"
	"time"
)

// 后台的「可用」列必须是 usableBytes(剩余)（即剩余 × 70%），不是总量、也不是
// 总量-剩余（后者是已用）。用用户报的那组真实数字：剩余 2.9 GB、总量 18.3 GB。
func TestNodeViewDerivesUsableBytes(t *testing.T) {
	const gb = int64(1000 * 1000 * 1000)
	free := 29 * gb / 10   // 2.9 GB
	total := 183 * gb / 10 // 18.3 GB

	views := nodeViews([]Node{{
		ID: "n1", OwnerType: "fleet", StorageEnabled: true,
		StorageFree: free, StorageTotal: total,
	}}, map[string]int64{}, time.Unix(10000, 0), Settings{})

	if len(views) != 1 {
		t.Fatalf("nodeViews returned %d views, want 1", len(views))
	}
	want := usableBytes(free)
	if views[0].UsableBytes != want {
		t.Fatalf("UsableBytes = %d, want %d (usableBytes of 2.9 GB free). Note %d would be total-free, i.e. bytes already used by anything on the volume — that is the number this column must never show.",
			views[0].UsableBytes, want, total-free)
	}
}

// EffectiveTrafficLimitBytes must be the *resolved* limit (resolveNodeTrafficLimit),
// not the raw node column: a node with TrafficLimitBytes=0 inherits the global
// default rather than being unlimited (see nodes.go's 2026-07 semantics change).
func TestNodeViewsEffectiveTrafficLimitInheritsGlobalDefault(t *testing.T) {
	const gib = int64(1) << 30
	now := time.Unix(10000, 0)
	st := Settings{NodeTrafficDefault: 1024 * gib} // 1 TiB

	views := nodeViews([]Node{{ID: "n1", TrafficLimitBytes: 0}}, map[string]int64{}, now, st)
	if len(views) != 1 {
		t.Fatalf("nodeViews returned %d views, want 1", len(views))
	}
	if views[0].EffectiveTrafficLimitBytes != st.NodeTrafficDefault {
		t.Fatalf("EffectiveTrafficLimitBytes = %d, want global default %d", views[0].EffectiveTrafficLimitBytes, st.NodeTrafficDefault)
	}
}

// A node with its own TrafficLimitBytes set must show that override, not the
// global default, even when the default is larger.
func TestNodeViewsEffectiveTrafficLimitUsesNodeOverride(t *testing.T) {
	const gib = int64(1) << 30
	now := time.Unix(10000, 0)
	st := Settings{NodeTrafficDefault: 1024 * gib} // 1 TiB
	override := 500 * gib

	views := nodeViews([]Node{{ID: "n1", TrafficLimitBytes: override}}, map[string]int64{}, now, st)
	if len(views) != 1 {
		t.Fatalf("nodeViews returned %d views, want 1", len(views))
	}
	if views[0].EffectiveTrafficLimitBytes != override {
		t.Fatalf("EffectiveTrafficLimitBytes = %d, want node override %d", views[0].EffectiveTrafficLimitBytes, override)
	}
}
