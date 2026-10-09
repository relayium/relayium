package account

import (
	"context"
	"database/sql"
	"fmt"
	"maps"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/coturnbridge/wire"
)

// Startup demotion (money): a central startup in which the ingest is not
// billable demotes every existing billable binding to shadow before the
// handler exists, so those allocations' bytes from a shadow or disabled window
// are never billed later — even when no snapshot for the binding arrives
// during that window.

// The G1 regression: 1000 B billed, central restarts in shadow and receives
// NOTHING for the allocation, 4000 B are relayed, billable returns with a
// later activation time, and the final 5500 B arrive (then are replayed).
// Only the 1000 B billed before the shadow startup may ever be billed.
func TestCoturnStartupShadowDemotesSilentBillableBinding(t *testing.T) {
	since := cmSep30
	e := newCMEnv(t, CoturnMeteringBillable, since)
	a := e.user("silent@example.com")
	e.set(since + 10)
	al := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess1, user: a, tag: "g1", firstObs: since + 1}
	al.seq, al.stream = 1, 1000
	if ack := e.one(al.build()); ack.Ledger != wire.LedgerBillable || ack.Accepted != 1000 {
		t.Fatalf("activation-period binding: %+v", ack)
	}

	e.cfg.Mode, e.cfg.BillableSince = CoturnMeteringShadow, 0
	e.set(since + 100)
	e.rebuild() // shadow startup; zero snapshots follow in this window

	e.cfg.Mode, e.cfg.BillableSince = CoturnMeteringBillable, since+200
	e.set(since + 300)
	e.rebuild()
	al.seq, al.stream, al.final, al.finalSeen = 2, 5500, 5500, true
	ack := e.one(al.build())
	if ack.Ledger != wire.LedgerShadow {
		t.Fatalf("binding silent through a shadow startup is still %s: %+v", ack.Ledger, ack)
	}
	if again := e.one(al.build()); again.Ledger != wire.LedgerShadow { // lost-ACK replay of the final
		t.Fatalf("final replay: %+v", again)
	}
	if got := e.relayed(a); got != 1000 {
		t.Fatalf("billed %d, want only the 1000 B billed before the shadow startup", got)
	}
}

// cmEnvOn is newCMEnv over a given store (a file-backed one, to reopen).
func cmEnvOn(t *testing.T, st *SQLiteStore, mode string, billableSince int64) *cmEnv {
	t.Helper()
	e := &cmEnv{t: t, st: st, clock: cmSep30, deny: map[string]string{}}
	e.cfg = CoturnMeteringConfig{
		Relays:        map[string][32]byte{cmRelayA: cmHash(cmTokenA), cmRelayB: cmHash(cmTokenB)},
		Mode:          mode,
		BillableSince: billableSince,
	}
	e.rebuild()
	return e
}

// cmStartup restarts the ingest in mode (a central restart).
func (e *cmEnv) cmStartup(mode string, billableSince int64) {
	e.t.Helper()
	e.cfg.Mode, e.cfg.BillableSince = mode, billableSince
	e.rebuild()
}

// cmDumpTable is every row of table, all columns, sorted: the before/after
// evidence that a startup changed nothing it must not.
func cmDumpTable(t *testing.T, db *sql.DB, table string, skip ...string) []string {
	t.Helper()
	rows, err := db.Query(`SELECT * FROM ` + table)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	var out []string
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			t.Fatal(err)
		}
		var b strings.Builder
		for i, c := range cols {
			if slices.Contains(skip, c) {
				continue
			}
			fmt.Fprintf(&b, "%s=%v;", c, vals[i])
		}
		out = append(out, b.String())
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	sort.Strings(out)
	return out
}

// cmLedgers maps session id → ledger for every binding.
func (e *cmEnv) cmLedgers() map[string]string {
	e.t.Helper()
	bs, err := e.st.CoturnBindings(context.Background())
	if err != nil {
		e.t.Fatal(err)
	}
	out := map[string]string{}
	for _, b := range bs {
		out[b.SessionID] = b.Ledger
	}
	return out
}

const cmSess2, cmSess3, cmSess4 = "001000000000000002", "001000000000000003", "001000000000000004"

// Durable: the demotion is committed when the shadow handler exists, survives
// closing and reopening the SQLite file, and a billable startup on the
// reopened database does not undo it. A second shadow startup demotes nothing.
func TestCoturnStartupDemotionIsDurableAcrossReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cm.db")
	st, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	since := cmSep30
	e := cmEnvOn(t, st, CoturnMeteringBillable, since)
	a := e.user("durable@example.com")
	e.set(since + 10)
	al := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess1, user: a, tag: "g1", firstObs: since + 1, seq: 1, stream: 1000}
	wantAck(t, e.one(al.build()), wire.AckAccepted, 1000)

	e.set(since + 100)
	e.cmStartup(CoturnMeteringShadow, 0)
	if !e.logged("demoted 1 billable binding") {
		t.Fatalf("shadow startup did not log the demotion: %v", e.logs)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	st2, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st2.Close() })
	e.st = st2
	if got := e.cmLedgers()[cmSess1]; got != wire.LedgerShadow {
		t.Fatalf("after reopen the binding is %q", got)
	}
	if n, err := st2.DemoteCoturnBillableBindings(context.Background()); err != nil || n != 0 {
		t.Fatalf("repeat demotion: %d %v", n, err)
	}

	e.set(since + 300)
	e.cmStartup(CoturnMeteringBillable, since+200)
	al.seq, al.stream, al.final, al.finalSeen = 2, 5500, 5500, true
	if ack := e.one(al.build()); ack.Ledger != wire.LedgerShadow || ack.Accepted != 5500 {
		t.Fatalf("final after reopen + re-enable: %+v", ack)
	}
	if got := e.relayed(a); got != 1000 {
		t.Fatalf("billed %d, want 1000", got)
	}
}

// An inferred end (ended_unfinalized) is terminal yet can still grow to its
// final, so it is demoted too; the final after re-enable — and its replay and
// a reordered older snapshot — bill nothing more.
func TestCoturnStartupDemotesEndedUnfinalized(t *testing.T) {
	since := cmSep30
	e := newCMEnv(t, CoturnMeteringBillable, since)
	a := e.user("ended@example.com")
	e.set(since + 10)
	base := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess1, user: a, tag: "g1", firstObs: since + 1}
	live, ended, final := base, base, base
	live.seq, live.stream = 1, 300
	ended.seq, ended.stream, ended.live, ended.state = 2, 300, 400, wire.StateEndedUnfinalized
	final.seq, final.stream, final.live, final.final, final.finalSeen = 3, 300, 400, 3400, true
	wantAck(t, e.one(live.build()), wire.AckAccepted, 300)
	wantAck(t, e.one(ended.build()), wire.AckAccepted, 400)

	e.set(since + 100)
	e.cmStartup(CoturnMeteringShadow, 0)
	e.set(since + 300)
	e.cmStartup(CoturnMeteringBillable, since+200)
	for _, s := range []cmSnap{final, final} { // the final, then its lost-ACK retry
		if ack := e.one(s.build()); ack.Status != wire.AckAccepted || ack.Ledger != wire.LedgerShadow || ack.Accepted != 3400 {
			t.Fatalf("final after re-enable: %+v", ack)
		}
	}
	if ack := e.one(ended.build()); ack.Status != wire.AckStale || ack.Ledger != wire.LedgerShadow {
		t.Fatalf("reordered ended: %+v", ack)
	}
	if got := e.relayed(a); got != 400 {
		t.Fatalf("billed %d, want the 400 billed before the shadow startup", got)
	}
}

// Demotion does not depend on the relay still being configured: relay B's
// binding is demoted by a shadow startup whose allowlist names only relay A,
// and stays shadow when B is configured again in billable mode.
func TestCoturnStartupDemotesBindingsOfUnlistedRelays(t *testing.T) {
	since := cmSep30
	e := newCMEnv(t, CoturnMeteringBillable, since)
	a := e.user("relayb@example.com")
	e.set(since + 10)
	sb := cmSnap{relay: cmRelayB, boot: cmBoot2, pid: 8, ticks: 88, sess: cmSess1, user: a, tag: "g1", firstObs: since + 1, seq: 1, stream: 100}
	wantAck(t, e.one(sb.build()), wire.AckAccepted, 100)

	e.cfg.Relays = map[string][32]byte{cmRelayA: cmHash(cmTokenA)}
	e.cmStartup(CoturnMeteringShadow, 0)
	if got := e.cmLedgers()[cmSess1]; got != wire.LedgerShadow {
		t.Fatalf("unlisted relay's binding is %q after shadow startup", got)
	}

	e.cfg.Relays = map[string][32]byte{cmRelayA: cmHash(cmTokenA), cmRelayB: cmHash(cmTokenB)}
	e.set(since + 300)
	e.cmStartup(CoturnMeteringBillable, since+200)
	sb.seq, sb.stream = 2, 900
	if ack := e.one(sb.build()); ack.Ledger != wire.LedgerShadow {
		t.Fatalf("relay B binding after re-enable: %+v", ack)
	}
	if got := e.relayed(a); got != 100 {
		t.Fatalf("billed %d, want 100", got)
	}
}

// The startup touches only the bindings' ledger column: every other binding
// column (receipt, counters, owner, alloc id, timestamps, purge tombstone),
// every usage_events/usage_periods row (coturn and node alike) and the users
// are byte-for-byte the same, and the shadow-ledger set is exactly the
// formerly billable bindings plus those already shadow.
func TestCoturnStartupChangesOnlyBindingLedger(t *testing.T) {
	since := cmSep30
	e := newCMEnv(t, CoturnMeteringBillable, since)
	ctx := context.Background()
	a, b, c, d := e.user("a@example.com"), e.user("b@example.com"), e.user("c@example.com"), e.user("d@example.com")
	e.set(since + 10)
	wantAck(t, e.one(cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess1, user: a, tag: "g1", firstObs: since + 1, seq: 1, stream: 1000}.build()), wire.AckAccepted, 1000)
	ended := cmSnap{relay: cmRelayB, boot: cmBoot2, pid: 8, ticks: 88, sess: cmSess2, user: b, tag: "g2", firstObs: since + 1, seq: 1, stream: 50, live: 60, state: wire.StateEndedUnfinalized}
	wantAck(t, e.one(ended.build()), wire.AckAccepted, 60)
	unknown := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess3, user: c, tag: "g3", firstObs: 1, seq: 1, stream: 70}
	if ack := e.one(unknown.build()); ack.Ledger != wire.LedgerShadow {
		t.Fatalf("unknown start: %+v", ack)
	}
	wantAck(t, e.one(cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess4, user: d, tag: "g4", firstObs: since + 1, seq: 1, stream: 80}.build()), wire.AckAccepted, 80)
	if err := e.st.SetAccountDeletion(ctx, d, 1, 100); err != nil {
		t.Fatal(err)
	}
	if err := e.st.ArchiveAndPurgeUser(ctx, d, 200); err != nil {
		t.Fatal(err)
	}
	if err := e.st.RecordUsage(ctx, UsageEvent{AllocID: "node-alloc-1", Token: "t", UserID: a, RelayedBytes: 55, RecordedAt: since + 10, Billable: true}); err != nil {
		t.Fatal(err)
	}
	wantLedgers := map[string]string{cmSess1: "billable", cmSess2: "billable", cmSess3: "shadow", cmSess4: "shadow"}
	if got := e.cmLedgers(); !maps.Equal(got, wantLedgers) {
		t.Fatalf("setup ledgers %v", got)
	}
	billedBefore := e.relayed(a) + e.relayed(b)

	tables := []string{"usage_events", "usage_periods", "users"}
	before := map[string][]string{}
	for _, tb := range tables {
		before[tb] = cmDumpTable(t, e.st.db, tb)
	}
	bindingsBefore := cmDumpTable(t, e.st.db, "coturn_metering_bindings", "ledger")
	tombstoneBefore := e.rawBinding(cmSess4)

	e.set(since + 100)
	e.cmStartup(CoturnMeteringShadow, 0)

	for _, tb := range tables {
		if after := cmDumpTable(t, e.st.db, tb); !slices.Equal(after, before[tb]) {
			t.Fatalf("%s changed by the startup:\nbefore %v\nafter  %v", tb, before[tb], after)
		}
	}
	if after := cmDumpTable(t, e.st.db, "coturn_metering_bindings", "ledger"); !slices.Equal(after, bindingsBefore) {
		t.Fatalf("binding columns other than ledger changed:\nbefore %v\nafter  %v", bindingsBefore, after)
	}
	if got := e.rawBinding(cmSess4); !maps.Equal(got, tombstoneBefore) {
		t.Fatalf("tombstone changed: %v -> %v", tombstoneBefore, got)
	}
	for sess, l := range e.cmLedgers() {
		if l != wire.LedgerShadow {
			t.Fatalf("%s still %s", sess, l)
		}
	}
	if got := e.relayed(a) + e.relayed(b); got != billedBefore || got != 1000+60+55 {
		t.Fatalf("billed %d after the startup, %d before", got, billedBefore)
	}
}

// Billable restarts never demote: an open billable binding stays billable
// through repeated billable startups and its growth is billed exactly once.
// An allocation that starts after a legitimate re-enable is billable, and
// stays so across later billable restarts — only a non-billable startup
// demotes, and only what exists at that startup.
func TestCoturnStartupBillableRestartAndNewAllocationAfterReenable(t *testing.T) {
	since := cmSep30
	e := newCMEnv(t, CoturnMeteringBillable, since)
	a := e.user("restart@example.com")
	e.set(since + 10)
	al := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess1, user: a, tag: "g1", firstObs: since + 1, seq: 1, stream: 1000}
	wantAck(t, e.one(al.build()), wire.AckAccepted, 1000)
	for range 2 {
		e.cmStartup(CoturnMeteringBillable, since)
	}
	if e.logged("demoted") {
		t.Fatalf("billable startup demoted: %v", e.logs)
	}
	al.seq, al.stream = 2, 3000
	if ack := e.one(al.build()); ack.Ledger != wire.LedgerBillable || ack.Accepted != 3000 {
		t.Fatalf("growth after billable restarts: %+v", ack)
	}
	e.one(al.build()) // lost-ACK retry
	if got := e.relayed(a); got != 3000 {
		t.Fatalf("billed %d, want 3000", got)
	}

	// Shadow window, then a legitimate re-enable with a later activation time.
	e.set(since + 100)
	e.cmStartup(CoturnMeteringShadow, 0)
	since2 := since + 200
	e.set(since2 + 10)
	e.cmStartup(CoturnMeteringBillable, since2)
	fresh := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess2, user: a, tag: "g2", firstObs: since2 + 1, seq: 1, stream: 200}
	if ack := e.one(fresh.build()); ack.Ledger != wire.LedgerBillable || ack.Accepted != 200 {
		t.Fatalf("allocation after re-enable: %+v", ack)
	}
	e.cmStartup(CoturnMeteringBillable, since2)
	fresh.seq, fresh.stream = 2, 500
	if ack := e.one(fresh.build()); ack.Ledger != wire.LedgerBillable || ack.Accepted != 500 {
		t.Fatalf("new allocation after a billable restart: %+v", ack)
	}
	al.seq, al.stream = 3, 9000
	if ack := e.one(al.build()); ack.Ledger != wire.LedgerShadow {
		t.Fatalf("pre-shadow binding after re-enable: %+v", ack)
	}
	if got := e.relayed(a); got != 3000+500 {
		t.Fatalf("billed %d, want 3500", got)
	}
}

// An invalid configuration is refused before anything is written: the
// billable binding keeps its ledger and every binding column.
func TestCoturnStartupInvalidConfigDoesNotMutate(t *testing.T) {
	since := cmSep30
	e := newCMEnv(t, CoturnMeteringBillable, since)
	a := e.user("invalid@example.com")
	e.set(since + 10)
	wantAck(t, e.one(cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess1, user: a, tag: "g1", firstObs: since + 1, seq: 1, stream: 1000}.build()), wire.AckAccepted, 1000)
	before := cmDumpTable(t, e.st.db, "coturn_metering_bindings")
	good := map[string][32]byte{cmRelayA: cmHash(cmTokenA)}
	for name, tc := range map[string]struct {
		store Store
		cfg   CoturnMeteringConfig
	}{
		"bogus mode":             {e.st, CoturnMeteringConfig{Relays: good, Mode: "bogus"}},
		"empty mode":             {e.st, CoturnMeteringConfig{Relays: good}},
		"mode case":              {e.st, CoturnMeteringConfig{Relays: good, Mode: "Shadow"}},
		"billable without since": {e.st, CoturnMeteringConfig{Relays: good, Mode: CoturnMeteringBillable}},
		"no relays, shadow":      {e.st, CoturnMeteringConfig{Mode: CoturnMeteringShadow}},
		"bad relay id, shadow":   {e.st, CoturnMeteringConfig{Relays: map[string][32]byte{"Bad Id!": cmHash(cmTokenA)}, Mode: CoturnMeteringShadow}},
		"shared token, shadow":   {e.st, CoturnMeteringConfig{Relays: map[string][32]byte{cmRelayA: cmHash(cmTokenA), cmRelayB: cmHash(cmTokenA)}, Mode: CoturnMeteringShadow}},
		"non-SQLite store":       {nil, CoturnMeteringConfig{Relays: good, Mode: CoturnMeteringShadow}},
	} {
		if h, err := NewCoturnMeteringIngest(tc.store, nil, tc.cfg); err == nil || h != nil {
			t.Fatalf("%s: built %v", name, h)
		}
		if after := cmDumpTable(t, e.st.db, "coturn_metering_bindings"); !slices.Equal(after, before) {
			t.Fatalf("%s mutated bindings:\nbefore %v\nafter  %v", name, before, after)
		}
	}
}

// A failure is all or nothing and leaves no handler. A real SQLite trigger
// raises on the LAST billable binding (rowid order of the full scan), after
// the earlier ones were already rewritten by the statement, with each SQLite
// conflict resolution: ABORT undoes the statement, but FAIL keeps the rows
// already changed, and ROLLBACK ends the transaction — so only an explicit
// transaction committed after success makes all three leave every binding,
// and every ledger row, as it was. The constructor returns no handler. With
// the trigger dropped the same startup demotes all three — the control that
// the trigger, not something else, caused the failure. A canceled context
// and a closed database demote nothing either.
func TestCoturnStartupDemotionFailureIsAtomicAndRefusesHandler(t *testing.T) {
	for _, raise := range []string{"ABORT", "FAIL", "ROLLBACK"} {
		t.Run(raise, func(t *testing.T) {
			since := cmSep30
			e := newCMEnv(t, CoturnMeteringBillable, since)
			a := e.user("atomic@example.com")
			e.set(since + 10)
			for _, s := range []string{cmSess1, cmSess2, cmSess3} {
				wantAck(t, e.one(cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: s, user: a, tag: "g1", firstObs: since + 1, seq: 1, stream: 100}.build()), wire.AckAccepted, 100)
			}
			if _, err := e.st.db.Exec(`CREATE TRIGGER cm_inject BEFORE UPDATE OF ledger ON coturn_metering_bindings
				WHEN OLD.session_id = '` + cmSess3 + `' AND NEW.ledger = 'shadow' BEGIN SELECT RAISE(` + raise + `, 'injected demotion failure'); END`); err != nil {
				t.Fatal(err)
			}
			snapshot := func() []string {
				var out []string
				for _, tb := range []string{"coturn_metering_bindings", "usage_events", "usage_periods"} {
					out = append(out, cmDumpTable(t, e.st.db, tb)...)
				}
				return out
			}
			before := snapshot()
			cfg := CoturnMeteringConfig{Relays: e.cfg.Relays, Mode: CoturnMeteringShadow, Logf: t.Logf}
			h, err := NewCoturnMeteringIngest(e.st, nil, cfg)
			if h != nil || err == nil || !strings.Contains(err.Error(), "injected demotion failure") {
				t.Fatalf("shadow startup over a failing demotion: %v %v", h, err)
			}
			if after := snapshot(); !slices.Equal(after, before) {
				t.Fatalf("partial demotion:\nbefore %v\nafter  %v", before, after)
			}
			if n, err := e.st.DemoteCoturnBillableBindings(context.Background()); err == nil || n != 0 {
				t.Fatalf("store demotion under the trigger: %d %v", n, err)
			}
			if after := snapshot(); !slices.Equal(after, before) {
				t.Fatalf("partial demotion by the store call:\nbefore %v\nafter  %v", before, after)
			}

			if _, err := e.st.db.Exec(`DROP TRIGGER cm_inject`); err != nil {
				t.Fatal(err)
			}
			canceled, cancel := context.WithCancel(context.Background())
			cancel()
			if n, err := e.st.DemoteCoturnBillableBindings(canceled); err == nil || n != 0 {
				t.Fatalf("demotion with a canceled context: %d %v", n, err)
			}
			if after := snapshot(); !slices.Equal(after, before) {
				t.Fatalf("canceled context demoted:\nbefore %v\nafter  %v", before, after)
			}
			if h, err := NewCoturnMeteringIngest(e.st, nil, cfg); h == nil || err != nil {
				t.Fatalf("control without the trigger: %v %v", h, err)
			}
			for sess, l := range e.cmLedgers() {
				if l != wire.LedgerShadow {
					t.Fatalf("control: %s still %s", sess, l)
				}
			}

			// A closed database: no handler in shadow mode.
			if err := e.st.Close(); err != nil {
				t.Fatal(err)
			}
			if h, err := NewCoturnMeteringIngest(e.st, nil, cfg); h != nil || err == nil {
				t.Fatalf("shadow startup over a closed database: %v %v", h, err)
			}
		})
	}
}

// Service.CoturnMeteringDisabled (the startup step for an unconfigured
// ingest) demotes like a shadow startup, and is a no-op over a store with no
// coturn bindings.
func TestCoturnStartupDisabledIngestDemotes(t *testing.T) {
	since := cmSep30
	e := newCMEnv(t, CoturnMeteringBillable, since)
	a := e.user("disabled@example.com")
	e.set(since + 10)
	al := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess1, user: a, tag: "g1", firstObs: since + 1, seq: 1, stream: 1000}
	wantAck(t, e.one(al.build()), wire.AckAccepted, 1000)
	svc := &Service{store: e.st}
	if err := svc.CoturnMeteringDisabled(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := e.cmLedgers()[cmSess1]; got != wire.LedgerShadow {
		t.Fatalf("disabled startup left %q", got)
	}
	e.set(since + 300)
	e.cmStartup(CoturnMeteringBillable, since+200)
	al.seq, al.stream = 2, 5000
	if ack := e.one(al.build()); ack.Ledger != wire.LedgerShadow {
		t.Fatalf("after re-enable: %+v", ack)
	}
	if got := e.relayed(a); got != 1000 {
		t.Fatalf("billed %d, want 1000", got)
	}
	if err := (&Service{}).CoturnMeteringDisabled(context.Background()); err != nil {
		t.Fatalf("store without the capability: %v", err)
	}
}
