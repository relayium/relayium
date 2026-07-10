package account

import (
	"testing"
	"time"
)

func TestNodeViewsOnlineFlag(t *testing.T) {
	now := time.Unix(10000, 0)
	nodes := []Node{
		{ID: "fresh", LastSeenAt: now.Unix() - 10, RelayedBytes: 100},
		{ID: "stale", LastSeenAt: now.Unix() - 1000},
	}
	views := nodeViews(nodes, now)
	if len(views) != 2 {
		t.Fatalf("want 2 views")
	}
	if !views[0].Online {
		t.Fatal("fresh node should be online")
	}
	if views[1].Online {
		t.Fatal("stale node should be offline")
	}
}
