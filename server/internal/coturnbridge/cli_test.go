package coturnbridge

import (
	"bufio"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeCLI speaks coturn's CLI dialogue (turn_admin_server.c): greeting,
// "Enter password: ", "> " cursor; psd writes the dump file, cs records ids.
type fakeCLI struct {
	ln        net.Listener
	password  string
	dump      string // what psd writes
	reply     string // overrides the psd reply (before the cursor)
	cutPrompt bool   // close mid-prompt after the password
	iac       bool   // prefix the greeting with telnet negotiation
	cancelled []string
	mu        sync.Mutex // guards dump/reply changes made while serving
}

func (f *fakeCLI) set(dump, reply string) {
	f.mu.Lock()
	f.dump, f.reply = dump, reply
	f.mu.Unlock()
}

func startFakeCLI(t *testing.T, f *fakeCLI) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f.ln = ln
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go f.serve(c)
		}
	}()
	return ln.Addr().String()
}

func (f *fakeCLI) serve(c net.Conn) {
	defer c.Close()
	w := func(s string) { c.Write([]byte(strings.ReplaceAll(s, "\n", "\r\n"))) }
	if f.iac {
		c.Write([]byte{0xff, 0xfc, 0x01, 0xff, 0xfe, 0x1f})
	}
	w("TURN Server\nCoturn-4.6.1 'Gorst'\n\nType '?' for help\n")
	authed := f.password == ""
	if authed {
		w("> ")
	} else {
		w("Enter password: \n")
	}
	r := bufio.NewReader(c)
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		cmd := strings.TrimRight(line, "\r\n")
		switch {
		case !authed:
			if cmd != f.password {
				w("Enter password: \n")
				continue
			}
			authed = true
			if f.cutPrompt {
				c.Write([]byte(">"))
				return
			}
			w("> ")
		case strings.HasPrefix(cmd, "psd "):
			path := strings.TrimPrefix(cmd, "psd ")
			f.mu.Lock()
			dump, reply := f.dump, f.reply
			f.mu.Unlock()
			if reply != "" {
				w(reply)
			} else if err := os.WriteFile(path, []byte(dump), 0o600); err != nil {
				w("Cannot open file for writing\n\n")
			}
			w("> ")
		case strings.HasPrefix(cmd, "cs "):
			f.mu.Lock()
			f.cancelled = append(f.cancelled, strings.TrimPrefix(cmd, "cs "))
			f.mu.Unlock()
			w("> ")
		default:
			w("> ")
		}
	}
}

func TestCLIDumpAndCancel(t *testing.T) {
	f := &fakeCLI{password: "pw", dump: psdTwo, iac: true}
	addr := startFakeCLI(t, f)
	path := filepath.Join(t.TempDir(), "psd.txt")
	os.WriteFile(path, []byte("stale earlier dump"), 0o600)

	cli, err := DialCLI(addr, "pw", 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer cli.Close()
	got, err := cli.DumpSessions(path, 1<<20)
	if err != nil || len(got) != 1 || got[0].Bytes != 3990000 {
		t.Fatalf("dump: %+v %v", got, err)
	}
	if err := cli.CancelSession("007000000000000001"); err != nil {
		t.Fatal(err)
	}
	if err := cli.CancelSession("7; shutdown"); err == nil {
		t.Fatal("injected command accepted")
	}
	if _, err := cli.command("psd x\r\nshutdown"); err == nil {
		t.Fatal("line break in a command accepted")
	}
}

func TestCLIFailuresAreErrors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "psd.txt")
	// Wrong password.
	addr := startFakeCLI(t, &fakeCLI{password: "pw", dump: psdTwo})
	if _, err := DialCLI(addr, "nope", time.Second); !errors.Is(err, ErrCLI) {
		t.Fatalf("wrong password: %v", err)
	}
	// Password required but none configured.
	if _, err := DialCLI(addr, "", time.Second); !errors.Is(err, ErrCLI) {
		t.Fatalf("no password: %v", err)
	}
	// Partial prompt, then the connection closes.
	addr = startFakeCLI(t, &fakeCLI{password: "pw", cutPrompt: true})
	if _, err := DialCLI(addr, "pw", time.Second); err == nil {
		t.Fatal("partial prompt accepted")
	}
	// psd cannot write its file.
	addr = startFakeCLI(t, &fakeCLI{password: "pw", reply: "Cannot open file for writing\n\n"})
	cli, err := DialCLI(addr, "pw", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cli.DumpSessions(path, 1<<20); !errors.Is(err, ErrCLI) {
		t.Fatalf("psd failure: %v", err)
	}
	cli.Close()
	// A reply that never ends in a prompt and grows without bound.
	addr = startFakeCLI(t, &fakeCLI{password: "pw", reply: strings.Repeat("x", maxCLIReply+10)})
	cli, err = DialCLI(addr, "pw", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cli.DumpSessions(path, 1<<20); !errors.Is(err, ErrCLI) {
		t.Fatalf("oversized reply: %v", err)
	}
	cli.Close()
	// A truncated dump file is not evidence.
	addr = startFakeCLI(t, &fakeCLI{password: "pw", dump: psdTwo[:200]})
	cli, err = DialCLI(addr, "pw", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cli.DumpSessions(path, 1<<20); !errors.Is(err, ErrPSDIncomplete) {
		t.Fatalf("truncated dump: %v", err)
	}
	// A dump larger than the bound is refused before parsing.
	if _, err := cli.DumpSessions(path, 10); !errors.Is(err, ErrCLI) {
		t.Fatalf("oversized dump: %v", err)
	}
	cli.Close()
}
