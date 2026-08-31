package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/account"
	"github.com/relayium/relayium/internal/signal"
)

type activationCall struct {
	period string
	stage  account.ActivationStage
}

func TestSharedPairLifecycleFailureLogContainsNoSensitiveValues(t *testing.T) {
	var out bytes.Buffer
	oldWriter := log.Writer()
	oldFlags := log.Flags()
	oldPrefix := log.Prefix()
	log.SetOutput(&out)
	log.SetFlags(0)
	log.SetPrefix("")
	t.Cleanup(func() {
		log.SetOutput(oldWriter)
		log.SetFlags(oldFlags)
		log.SetPrefix(oldPrefix)
	})
	logPairLifecycleWriteFailure()
	got := out.String()
	if !strings.Contains(got, "queued for retry") {
		t.Fatalf("missing operational state: %s", got)
	}
	for _, sensitive := range []string{"424242", "account-secret", "user-secret", "203.0.113.9", "generation-secret", "room-secret", "token-secret"} {
		if strings.Contains(got, sensitive) {
			t.Errorf("shared lifecycle log contains %q: %s", sensitive, got)
		}
	}
}

type activationStoreStub struct {
	calls chan activationCall
	block <-chan struct{}
	err   error
}

func (s *activationStoreStub) IncrementActivationFunnel(ctx context.Context, period string, stage account.ActivationStage) error {
	if s.calls != nil {
		s.calls <- activationCall{period: period, stage: stage}
	}
	if s.block != nil {
		select {
		case <-s.block:
		case <-ctx.Done():
		}
	}
	return s.err
}

func TestActivationRecorderUsesUTCMonthAndFixedStage(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	blocked := make(chan struct{})
	store := &activationStoreStub{calls: make(chan activationCall, 2), block: blocked}
	var clockMu sync.Mutex
	clock := time.Date(2026, 8, 31, 23, 59, 58, 0, time.UTC)
	now := func() time.Time {
		clockMu.Lock()
		defer clockMu.Unlock()
		return clock
	}
	recorder := newActivationRecorder(ctx, store, now, t.Logf, 4)

	// Occupy the only worker before queueing the action under test. This makes
	// it impossible for that action to reach persistence until after the clock
	// has crossed the UTC month boundary.
	recorder.Record(account.ActivationCodeMinted)
	select {
	case <-store.calls:
	case <-time.After(time.Second):
		t.Fatal("first write did not occupy the worker")
	}

	clockMu.Lock()
	clock = time.Date(2026, 8, 31, 23, 59, 59, 0, time.UTC)
	clockMu.Unlock()
	recorder.Record(account.ActivationRoomOpened)
	clockMu.Lock()
	clock = time.Date(2026, 9, 1, 0, 0, 1, 0, time.UTC)
	clockMu.Unlock()
	close(blocked)

	select {
	case got := <-store.calls:
		if got.period != "202608" || got.stage != account.ActivationRoomOpened {
			t.Fatalf("queued write = %+v, want August room_opened", got)
		}
	case <-time.After(time.Second):
		t.Fatal("queued aggregate write did not run")
	}
}

func TestActivationRecorderNeverBlocksProductPathAndLogsNoErrorPayload(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	blocked := make(chan struct{})
	store := &activationStoreStub{
		calls: make(chan activationCall, 2), block: blocked,
		err: errors.New("secret-code=424242 path=/private/database"),
	}
	var mu sync.Mutex
	var logs []string
	logf := func(format string, args ...any) {
		mu.Lock()
		logs = append(logs, fmt.Sprintf(format, args...))
		mu.Unlock()
	}
	recorder := newActivationRecorder(ctx, store, time.Now, logf, 1)

	recorder.Record(account.ActivationRoomOpened)
	<-store.calls // worker is now blocked inside persistence
	start := time.Now()
	recorder.Record(account.ActivationRoomPaired) // occupies the one queue slot
	recorder.Record(account.ActivationCodeMinted) // drops immediately
	if elapsed := time.Since(start); elapsed > 100*time.Millisecond {
		t.Fatalf("bounded enqueue blocked for %v", elapsed)
	}
	close(blocked)

	deadline := time.Now().Add(time.Second)
	for {
		mu.Lock()
		joined := strings.Join(logs, "\n")
		mu.Unlock()
		if strings.Contains(joined, "write failed") && strings.Contains(joined, "queue full") {
			if strings.Contains(joined, "424242") || strings.Contains(joined, "/private") {
				t.Fatalf("log leaked error payload: %s", joined)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("missing bounded failure logs: %s", joined)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestActivationHooksMapRegistryMilestonesWithoutDuplicates(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	nowUnix := int64(1000)
	registry := signal.NewPairRegistry(300, func() int64 { return nowUnix })
	code, _ := registry.MintFor("owner")
	store := &activationStoreStub{calls: make(chan activationCall, 8)}
	recorder := newActivationRecorder(ctx, store, func() time.Time { return time.Unix(nowUnix, 0) }, t.Logf, 8)
	hooks := activationHooks{recorder: recorder}

	hooks.afterMint()
	room, ok := registry.RoomFor(code)
	if !ok {
		t.Fatal("minted code has no room")
	}
	_, first, _ := registry.ObserveAdmittedRoom(room, 1)
	hooks.admitted(first)
	_, duplicate, _ := registry.ObserveAdmittedRoom(room, 1)
	hooks.admitted(duplicate)
	_, paired, _ := registry.ObserveAdmittedRoom(room, 2)
	hooks.admitted(paired)
	_, duplicatePair, _ := registry.ObserveAdmittedRoom(room, 2)
	hooks.admitted(duplicatePair)

	seen := map[account.ActivationStage]int{}
	for i := 0; i < 3; i++ {
		select {
		case call := <-store.calls:
			seen[call.stage]++
		case <-time.After(time.Second):
			t.Fatalf("received %d writes, want 3", i)
		}
	}
	for _, stage := range []account.ActivationStage{account.ActivationCodeMinted, account.ActivationRoomOpened, account.ActivationRoomPaired} {
		if seen[stage] != 1 {
			t.Fatalf("stage %s count = %d, all=%v", stage, seen[stage], seen)
		}
	}
}

func TestMainWiresMintAdmissionAndOpaqueRoomGeneration(t *testing.T) {
	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, required := range []string{
		"resolvePair:  pairReg.RoomFor",
		"pairReg.ObserveAdmittedRoom(room, peers)",
		"pairActivity.Store(&observeActivity)",
		"acct.PairMintRefusal, activationHook.afterMint",
	} {
		if !strings.Contains(text, required) {
			t.Errorf("main activation wiring lacks %q", required)
		}
	}
}
