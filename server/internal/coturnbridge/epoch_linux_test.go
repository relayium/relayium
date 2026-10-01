package coturnbridge

import (
	"os"
	"strconv"
	"testing"
)

func TestParseProcStat(t *testing.T) {
	// Field 22 (starttime) after a comm containing spaces and ')'.
	stat := "4242 (turn) server) S 1 4242 4242 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 9 0 987654321 123456 789 18446744073709551615 0 0 0 0 0 0 0 4096 0 0 0 0 17 3 0 0 0 0 0\n"
	name, start, err := parseProcStat(stat)
	if err != nil || name != "turn) server" || start != 987654321 {
		t.Fatalf("%q %d %v", name, start, err)
	}
	for _, bad := range []string{"", "4242 turnserver S 1", "4242 (turnserver) S 1 2 3", "4242 (turnserver) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 x"} {
		if _, _, err := parseProcStat(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

// The running test process stands in for coturn: its own epoch is readable,
// stable, and Alive; a PID that names no process is not.
func TestProcessEpochSourceLinux(t *testing.T) {
	dir := t.TempDir()
	pidfile := dir + "/p.pid"
	os.WriteFile(pidfile, []byte("1\n"), 0o600)
	name, _, err := processStart(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(pidfile, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o600)
	src := &ProcessEpochSource{PIDFile: pidfile, Comm: name}
	e1, err := src.Read()
	if err != nil || !e1.Valid() {
		t.Fatalf("%+v %v", e1, err)
	}
	e2, _ := src.Read()
	if e1 != e2 || !src.Alive(e1) {
		t.Fatalf("unstable epoch %v %v", e1, e2)
	}
	// Another name for the same PID is not coturn.
	if _, err := (&ProcessEpochSource{PIDFile: pidfile, Comm: "turnserver-x"}).Read(); err == nil {
		t.Fatal("wrong process name accepted")
	}
	gone := e1
	gone.PID = 1 << 22 // above pid_max on default kernels
	if src.Alive(gone) {
		t.Fatal("non-existent pid reported alive")
	}
}
