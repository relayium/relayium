package metering

import "testing"

const sampleChannel = "turn/realm/relayium.app/user/1751200000:abc123def/allocation/alloc-77/total_traffic"

func TestAllocIDFromChannel(t *testing.T) {
	if got := allocIDFromChannel(sampleChannel); got != "alloc-77" {
		t.Fatalf("allocID = %q, want alloc-77", got)
	}
	if got := allocIDFromChannel("garbage"); got != "" {
		t.Fatalf("garbage channel should yield empty allocID, got %q", got)
	}
}

func TestUsernameFromChannel(t *testing.T) {
	if got := usernameFromChannel(sampleChannel); got != "1751200000:abc123def" {
		t.Fatalf("username = %q, want 1751200000:abc123def", got)
	}
}

func TestRelayedBytesFromPayload(t *testing.T) {
	// coturn total_traffic payload (key=value pairs).
	n, err := relayedBytesFromPayload("rcvp=10, rcvb=2000, sentp=8, sentb=1500")
	if err != nil || n != 3500 {
		t.Fatalf("bytes = %d (err %v), want 3500", n, err)
	}
	// Tolerant of ordering/spacing.
	n, err = relayedBytesFromPayload("sentb=1 rcvb=2")
	if err != nil || n != 3 {
		t.Fatalf("bytes = %d (err %v), want 3", n, err)
	}
	// No traffic fields → error.
	if _, err := relayedBytesFromPayload("rcvp=10, sentp=8"); err == nil {
		t.Fatalf("payload without rcvb/sentb should error")
	}
}
