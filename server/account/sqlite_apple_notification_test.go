package account

import (
	"context"
	"testing"
)

func TestPruneTerminalAppleNotificationsKeepsUnfinishedAndBoundaryRows(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	type row struct {
		uuid  string
		state string
		at    int64
		gone  bool
	}
	rows := []row{
		{"10000000-0000-4000-8000-000000000001", appleNotificationApplied, 99, true},
		{"10000000-0000-4000-8000-000000000002", appleNotificationIgnored, 99, true},
		{"10000000-0000-4000-8000-000000000003", appleNotificationUnsupported, 99, true},
		{"10000000-0000-4000-8000-000000000004", appleNotificationApplied, 100, false},
		{"10000000-0000-4000-8000-000000000005", appleNotificationReceived, 99, false},
		{"10000000-0000-4000-8000-000000000006", appleNotificationPending, 99, false},
		{"10000000-0000-4000-8000-000000000007", appleNotificationConflict, 99, false},
	}

	for _, tc := range rows {
		if _, fresh, err := s.ClaimAppleNotification(ctx, AppleNotificationRecord{
			UUID: tc.uuid, Type: "TEST", ReceivedAt: tc.at,
		}); err != nil || !fresh {
			t.Fatalf("claim %s: fresh=%v err=%v", tc.uuid, fresh, err)
		}
		if tc.state != appleNotificationReceived {
			if err := s.SetAppleNotificationState(ctx, tc.uuid, tc.state, tc.at); err != nil {
				t.Fatalf("state %s: %v", tc.uuid, err)
			}
		}
	}

	if err := s.PruneTerminalAppleNotifications(ctx, 100); err != nil {
		t.Fatalf("prune: %v", err)
	}
	for _, tc := range rows {
		_, ok, err := s.GetAppleNotification(ctx, tc.uuid)
		if err != nil {
			t.Fatalf("get %s: %v", tc.uuid, err)
		}
		if ok == tc.gone {
			t.Errorf("%s state=%s at=%d: present=%v, want %v", tc.uuid, tc.state, tc.at, ok, !tc.gone)
		}
	}
}
