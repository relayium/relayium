package main

import (
	"fmt"
	"go/parser"
	"go/token"
	"io/fs"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"
)

// H2 guard. The direct coturn->Redis ingest keys the usage ledger by coturn's
// raw session id, which restarts from zero on every coturn restart and is
// shared across coturn hosts, so enabling it would add one user's relay bytes
// to another user's bill. Setting -redis-addr must therefore start nothing:
// no worker, no Redis subscription, no watchdog. It must also not crash the
// server. These tests pin that.

func TestRedisAddrSetStartsNoMeteringIngest(t *testing.T) {
	// A real listener stands in for Redis. The retired wiring dialled it at
	// once (worker.Run -> RedisSource.Events -> PSubscribe + Receive), so any
	// accepted connection proves an ingest was started.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	accepted := make(chan struct{}, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		c.Close()
		accepted <- struct{}{}
	}()

	var lines []string
	logf := func(format string, args ...any) { lines = append(lines, fmt.Sprintf(format, args...)) }
	if started := guardCoturnRedisMetering(ln.Addr().String(), logf); started {
		t.Fatal("guard reported the coturn->Redis ingest as started")
	}
	select {
	case <-accepted:
		t.Fatal("something dialled the configured Redis address: the coturn metering ingest was started")
	case <-time.After(750 * time.Millisecond):
	}
	if len(lines) != 1 {
		t.Fatalf("want exactly one startup line, got %d: %q", len(lines), lines)
	}
	for _, want := range []string{"DISABLED", "F02", "RELAYIUM_REDIS_ADDR"} {
		if !strings.Contains(lines[0], want) {
			t.Errorf("startup line lacks %q: %s", want, lines[0])
		}
	}
}

func TestRedisAddrUnsetIsSilent(t *testing.T) {
	var lines []string
	logf := func(format string, args ...any) { lines = append(lines, fmt.Sprintf(format, args...)) }
	if guardCoturnRedisMetering("", logf) {
		t.Fatal("guard reported an ingest started with no address")
	}
	if len(lines) != 0 {
		t.Fatalf("unset flag must log nothing, got %q", lines)
	}
}

// The guard is only meaningful while nothing else in package main wires the
// ingest. Re-introducing it (in main.go or any other non-test file here) must
// be a deliberate change that also deletes this test, not an accident.
func TestMainPackageDoesNotImportMetering(t *testing.T) {
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, ".", func(fi fs.FileInfo) bool {
		return !strings.HasSuffix(fi.Name(), "_test.go")
	}, parser.ImportsOnly)
	if err != nil {
		t.Fatal(err)
	}
	for _, pkg := range pkgs {
		for name, f := range pkg.Files {
			for _, imp := range f.Imports {
				path, _ := strconv.Unquote(imp.Path.Value)
				if strings.HasSuffix(path, "/internal/metering") {
					t.Errorf("%s imports %s: the coturn->Redis ingest must stay unwired until F02 re-keys it", name, path)
				}
			}
		}
	}
}
