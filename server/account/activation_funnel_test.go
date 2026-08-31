package account

import (
	"context"
	"database/sql"
	"math"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestActivationFunnelSchemaHasOnlyPrivacyAggregateColumns(t *testing.T) {
	store := newTestStore(t)
	rows, err := store.db.Query(`PRAGMA table_info(activation_funnel_monthly)`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type column struct {
		name, typ   string
		notNull, pk int
	}
	var got []column
	for rows.Next() {
		var cid int
		var c column
		var defaultValue any
		if err := rows.Scan(&cid, &c.name, &c.typ, &c.notNull, &defaultValue, &c.pk); err != nil {
			t.Fatal(err)
		}
		got = append(got, c)
	}
	want := []column{{"period", "TEXT", 1, 1}, {"stage", "TEXT", 1, 2}, {"count", "INTEGER", 1, 0}}
	if len(got) != len(want) {
		t.Fatalf("table has %d columns (%+v), want exactly 3", len(got), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("column %d = %+v, want %+v", i, got[i], want[i])
		}
	}

	var ddl string
	if err := store.db.QueryRow(`SELECT sql FROM sqlite_master WHERE type='table' AND name='activation_funnel_monthly'`).Scan(&ddl); err != nil {
		t.Fatal(err)
	}
	compact := strings.Join(strings.Fields(strings.ToLower(ddl)), " ")
	for _, required := range []string{
		"cast(substr(period, 1, 4) as integer) between 1 and 9999",
		"stage in ('code_minted','room_opened','room_paired')",
		"check (count >= 0)",
		"primary key (period, stage)",
		"length(period) = 6",
		"strict, without rowid",
	} {
		if !strings.Contains(compact, required) {
			t.Fatalf("schema lacks %q: %s", required, compact)
		}
	}
	var ncol, withoutRowID, strict int
	if err := store.db.QueryRow(`SELECT ncol, wr, strict FROM pragma_table_list WHERE name='activation_funnel_monthly'`).Scan(&ncol, &withoutRowID, &strict); err != nil {
		t.Fatal(err)
	}
	if ncol != 3 || withoutRowID != 1 || strict != 1 {
		t.Fatalf("table options = ncol:%d wr:%d strict:%d", ncol, withoutRowID, strict)
	}
	if _, err := store.db.Exec(`SELECT rowid FROM activation_funnel_monthly LIMIT 0`); err == nil {
		t.Fatal("rowid query succeeded on aggregate table")
	}
}

func TestActivationFunnelConcurrentIncrementIsAtomic(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shared.db")
	store, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	other, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	const increments = 200
	var wg sync.WaitGroup
	errs := make(chan error, increments)
	for i := 0; i < increments; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			writer := store
			if i%2 == 1 {
				writer = other
			}
			errs <- writer.IncrementActivationFunnel(context.Background(), "202608", ActivationRoomOpened)
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("increment: %v", err)
		}
	}
	got, err := store.ActivationFunnel(context.Background(), "202608")
	if err != nil {
		t.Fatal(err)
	}
	if got.RoomOpened != increments {
		t.Fatalf("RoomOpened = %d, want %d", got.RoomOpened, increments)
	}
}

func TestActivationFunnelSaturatesAndRejectsInvalidInputs(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	if _, err := store.db.Exec(`INSERT INTO activation_funnel_monthly(period,stage,count) VALUES(?,?,?)`, "202608", ActivationRoomPaired, int64(math.MaxInt64)); err != nil {
		t.Fatal(err)
	}
	if err := store.IncrementActivationFunnel(ctx, "202608", ActivationRoomPaired); err != nil {
		t.Fatal(err)
	}
	got, err := store.ActivationFunnel(ctx, "202608")
	if err != nil || got.RoomPaired != math.MaxInt64 {
		t.Fatalf("saturated count = %d, err=%v", got.RoomPaired, err)
	}

	for _, period := range []string{"", "2026-08", "000000", "000001", "202600", "202613", "20260x"} {
		if err := store.IncrementActivationFunnel(ctx, period, ActivationCodeMinted); err == nil {
			t.Errorf("period %q was accepted", period)
		}
		if _, err := store.ActivationFunnel(ctx, period); err == nil {
			t.Errorf("read period %q was accepted", period)
		}
	}
	if err := store.IncrementActivationFunnel(ctx, "202608", ActivationStage("client_event")); err == nil {
		t.Fatal("arbitrary stage was accepted")
	}
	for _, statement := range []string{
		`INSERT INTO activation_funnel_monthly VALUES('000001','code_minted',1)`,
		`INSERT INTO activation_funnel_monthly VALUES('202613','code_minted',1)`,
		`INSERT INTO activation_funnel_monthly VALUES('202608','client_event',1)`,
		`INSERT INTO activation_funnel_monthly VALUES('202608','code_minted',-1)`,
		`INSERT INTO activation_funnel_monthly VALUES('202608','code_minted','not-an-integer')`,
	} {
		if _, err := store.db.Exec(statement); err == nil {
			t.Errorf("database accepted invalid row: %s", statement)
		}
	}
}

func TestActivationFunnelRejectsMalformedPrecreatedTableAtStartup(t *testing.T) {
	for _, ddl := range []string{
		`CREATE TABLE activation_funnel_monthly(period TEXT, stage TEXT, count INTEGER)`,
		`CREATE TABLE activation_funnel_monthly(period TEXT NOT NULL, stage TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(period,stage)) WITHOUT ROWID`,
		`CREATE TABLE activation_funnel_monthly(period TEXT NOT NULL, stage TEXT NOT NULL, count INTEGER NOT NULL, user_id TEXT, exact_timestamp INTEGER, PRIMARY KEY(period,stage)) STRICT, WITHOUT ROWID`,
	} {
		path := filepath.Join(t.TempDir(), "malformed.db")
		db, err := sql.Open("sqlite", path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(ddl); err != nil {
			t.Fatal(err)
		}
		_ = db.Close()
		if store, err := OpenSQLite(path); err == nil {
			store.Close()
			t.Fatalf("OpenSQLite accepted malformed pre-created table: %s", ddl)
		}
	}
}

func TestActivationFunnelConcurrentFirstOpenIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "first-open.db")
	type result struct {
		store *SQLiteStore
		err   error
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	for i := 0; i < 2; i++ {
		go func() {
			<-start
			store, err := OpenSQLite(path)
			results <- result{store: store, err: err}
		}()
	}
	close(start)
	opened := make([]*SQLiteStore, 0, 2)
	for i := 0; i < 2; i++ {
		got := <-results
		if got.err != nil {
			for _, store := range opened {
				_ = store.Close()
			}
			t.Fatalf("concurrent OpenSQLite %d: %v", i+1, got.err)
		}
		opened = append(opened, got.store)
	}
	defer func() {
		for _, store := range opened {
			_ = store.Close()
		}
	}()

	for _, store := range opened {
		if err := store.IncrementActivationFunnel(context.Background(), "202608", ActivationCodeMinted); err != nil {
			t.Fatal(err)
		}
	}
	for i, store := range opened {
		counts, err := store.ActivationFunnel(context.Background(), "202608")
		if err != nil || counts.CodeMinted != 2 {
			t.Fatalf("store %d count = %d, err=%v", i+1, counts.CodeMinted, err)
		}
		var ncol, withoutRowID, strict int
		if err := store.db.QueryRow(`SELECT ncol, wr, strict FROM pragma_table_list WHERE name='activation_funnel_monthly'`).Scan(&ncol, &withoutRowID, &strict); err != nil {
			t.Fatal(err)
		}
		if ncol != 3 || withoutRowID != 1 || strict != 1 {
			t.Fatalf("store %d table options = ncol:%d wr:%d strict:%d", i+1, ncol, withoutRowID, strict)
		}
	}
}

func TestActivationFunnelMigratesOldDatabaseIdempotently(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE legacy_marker(id INTEGER PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 2; i++ {
		store, err := OpenSQLite(path)
		if err != nil {
			t.Fatalf("OpenSQLite pass %d: %v", i+1, err)
		}
		if err := store.IncrementActivationFunnel(context.Background(), "202608", ActivationCodeMinted); err != nil {
			t.Fatalf("increment pass %d: %v", i+1, err)
		}
		if err := store.Close(); err != nil {
			t.Fatal(err)
		}
	}
	store, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	var marker string
	if err := store.db.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name='legacy_marker'`).Scan(&marker); err != nil {
		t.Fatalf("legacy table did not survive migration: %v", err)
	}
	got, err := store.ActivationFunnel(context.Background(), "202608")
	if err != nil || got.CodeMinted != 2 {
		t.Fatalf("idempotent migration count = %d, err=%v", got.CodeMinted, err)
	}
}
