package account

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// errInjectedRowFault is what a real SQLite read failure (I/O error, corrupt
// page, interrupted statement) looks like to database/sql: Rows.Next returns
// false, Rows.Err carries the cause, and the automatic close means a later
// Rows.Close returns nil. Loops that only check Scan and Close therefore treat
// a truncated result set as complete evidence.
var errInjectedRowFault = errors.New("test: injected mid-iteration SQLite row fault")

// rowFault arms a one-shot failure for the next query whose SQL contains
// match. The query runs against real SQLite; after `after` rows have been
// delivered, the next row the engine actually produced is replaced by
// errInjectedRowFault. A result set with no further row never fires, so a
// passing case also proves the fault truncated real data.
type rowFault struct {
	mu    sync.Mutex
	match string
	after int
	armed bool
	fired []string
}

func (f *rowFault) arm(match string, after int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.match, f.after, f.armed, f.fired = match, after, true, nil
}

// disarm returns every query the fault truncated since it was armed.
func (f *rowFault) disarm() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.armed = false
	return f.fired
}

func (f *rowFault) wrap(query string, rows driver.Rows) driver.Rows {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.armed || !strings.Contains(query, f.match) {
		return rows
	}
	f.armed = false
	return &rowFaultRows{Rows: rows, fault: f, query: query, failAt: f.after}
}

type rowFaultRows struct {
	driver.Rows
	fault     *rowFault
	query     string
	failAt, n int
}

func (r *rowFaultRows) Next(dest []driver.Value) error {
	if err := r.Rows.Next(dest); err != nil {
		return err
	}
	if r.n == r.failAt {
		r.fault.mu.Lock()
		r.fault.fired = append(r.fault.fired, r.query)
		r.fault.mu.Unlock()
		return errInjectedRowFault
	}
	r.n++
	return nil
}

type rowFaultConnector struct {
	dsn   string
	drv   driver.Driver
	fault *rowFault
}

func (c *rowFaultConnector) Connect(context.Context) (driver.Conn, error) {
	conn, err := c.drv.Open(c.dsn)
	if err != nil {
		return nil, err
	}
	return &rowFaultConn{Conn: conn, fault: c.fault}, nil
}

func (c *rowFaultConnector) Driver() driver.Driver { return c.drv }

// rowFaultConn forwards every operation to the real modernc SQLite connection
// and only wraps the rows it returns.
type rowFaultConn struct {
	driver.Conn
	fault *rowFault
}

func (c *rowFaultConn) Prepare(query string) (driver.Stmt, error) {
	return c.PrepareContext(context.Background(), query)
}

func (c *rowFaultConn) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	var stmt driver.Stmt
	var err error
	if p, ok := c.Conn.(driver.ConnPrepareContext); ok {
		stmt, err = p.PrepareContext(ctx, query)
	} else {
		stmt, err = c.Conn.Prepare(query)
	}
	if err != nil {
		return nil, err
	}
	return &rowFaultStmt{Stmt: stmt, query: query, fault: c.fault}, nil
}

func (c *rowFaultConn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	if b, ok := c.Conn.(driver.ConnBeginTx); ok {
		return b.BeginTx(ctx, opts)
	}
	return nil, errors.New("test: wrapped SQLite connection lacks BeginTx")
}

func (c *rowFaultConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if e, ok := c.Conn.(driver.ExecerContext); ok {
		return e.ExecContext(ctx, query, args)
	}
	return nil, driver.ErrSkip
}

func (c *rowFaultConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	q, ok := c.Conn.(driver.QueryerContext)
	if !ok {
		return nil, driver.ErrSkip
	}
	rows, err := q.QueryContext(ctx, query, args)
	if err != nil {
		return nil, err
	}
	return c.fault.wrap(query, rows), nil
}

func (c *rowFaultConn) CheckNamedValue(v *driver.NamedValue) error {
	if checker, ok := c.Conn.(driver.NamedValueChecker); ok {
		return checker.CheckNamedValue(v)
	}
	return driver.ErrSkip
}

func (c *rowFaultConn) ResetSession(ctx context.Context) error {
	if r, ok := c.Conn.(driver.SessionResetter); ok {
		return r.ResetSession(ctx)
	}
	return nil
}

func (c *rowFaultConn) IsValid() bool {
	if v, ok := c.Conn.(driver.Validator); ok {
		return v.IsValid()
	}
	return true
}

func (c *rowFaultConn) Ping(ctx context.Context) error {
	if p, ok := c.Conn.(driver.Pinger); ok {
		return p.Ping(ctx)
	}
	return nil
}

type rowFaultStmt struct {
	driver.Stmt
	query string
	fault *rowFault
}

func (s *rowFaultStmt) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	if e, ok := s.Stmt.(driver.StmtExecContext); ok {
		return e.ExecContext(ctx, args)
	}
	return nil, errors.New("test: wrapped SQLite statement lacks ExecContext")
}

func (s *rowFaultStmt) QueryContext(ctx context.Context, args []driver.NamedValue) (driver.Rows, error) {
	q, ok := s.Stmt.(driver.StmtQueryContext)
	if !ok {
		return nil, errors.New("test: wrapped SQLite statement lacks QueryContext")
	}
	rows, err := q.QueryContext(ctx, args)
	if err != nil {
		return nil, err
	}
	return s.fault.wrap(s.query, rows), nil
}

// newRowFaultStore bootstraps a real file-backed schema with OpenSQLite, then
// replaces its pools with one writer pool (the :memory: shape: reader() falls
// back to it) whose connections forward to the same modernc driver and DSN.
func newRowFaultStore(t *testing.T) (*SQLiteStore, *rowFault) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "rowfault.db")
	base, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	drv := base.db.Driver()
	if err := base.Close(); err != nil {
		t.Fatal(err)
	}
	fault := &rowFault{}
	db := sql.OpenDB(&rowFaultConnector{dsn: withPragmas(path, connPragmas...) + "&_txlock=immediate", drv: drv, fault: fault})
	db.SetMaxOpenConns(1)
	store := &SQLiteStore{db: db}
	t.Cleanup(func() { store.Close() })
	return store, fault
}

// billingStateDump is a full, ordered dump of every table a truncated billing
// scan could otherwise commit into. Equality before and after a faulted call is
// the rollback proof.
func billingStateDump(t *testing.T, store *SQLiteStore) string {
	t.Helper()
	var b strings.Builder
	for _, table := range []string{"users", "email_tokens", "stripe_customer_history", "billing_purchase_attempts", "billing_deletion_holds", "billing_cancellation_outbox", "billing_deletion_manual_actions", "billing_deletion_refund_constituents", "billing_deletion_refund_inbox", "billing_deletion_refund_events", "billing_deletion_refund_failures", "billing_duplicate_refunds", "billing_duplicate_refund_invoices", "billing_duplicate_refund_liabilities", "billing_duplicate_refund_actions", "billing_duplicate_refund_constituents", "billing_duplicate_refund_failures"} {
		rows, err := store.db.Query(`SELECT * FROM ` + table + ` ORDER BY rowid`)
		if err != nil {
			t.Fatalf("dump %s: %v", table, err)
		}
		cols, _ := rows.Columns()
		for rows.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				rows.Close()
				t.Fatalf("dump %s: %v", table, err)
			}
			fmt.Fprintf(&b, "%s%v\n", table, vals)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			t.Fatalf("dump %s: %v", table, err)
		}
		rows.Close()
	}
	return b.String()
}

func mustExec(t *testing.T, store *SQLiteStore, query string, args ...any) {
	t.Helper()
	if _, err := store.db.Exec(query, args...); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
}

func progressJSON(t *testing.T, p BillingDeletionProgress) string {
	t.Helper()
	if p.Resources == nil {
		p.Resources = map[string]BillingDeletionResource{}
	}
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func seedDeletionOutbox(t *testing.T, store *SQLiteStore, id, subject, state, mode string, generation int64, p BillingDeletionProgress, customerID, subscriptionID string, cutoff int64) {
	t.Helper()
	mustExec(t, store, `INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,customer_id,subscription_id,idempotency_key,state,progress_json,created_at,updated_at,generation,mode,cutoff_at) VALUES(?,?,'stripe',?,?,?,?,?,?,?,?,?,?)`,
		id, subject, customerID, subscriptionID, "key-"+id, state, progressJSON(t, p), cutoff, cutoff, generation, mode, cutoff)
}

func outboxProgress(t *testing.T, store *SQLiteStore, id string) BillingDeletionProgress {
	t.Helper()
	var raw string
	if err := store.db.QueryRow(`SELECT progress_json FROM billing_cancellation_outbox WHERE id=?`, id).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	p, err := decodeDeletionProgressStrict(raw)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func progressHasResource(p BillingDeletionProgress, id string) bool {
	for _, r := range p.Resources {
		if r.ID == id {
			return true
		}
	}
	return false
}

// seedDuplicateRefundJob stores a terminal, fully refunded duplicate job whose
// succeeded action is bound to refundID, exactly as the operator path leaves it.
func seedDuplicateRefundJob(t *testing.T, store *SQLiteStore, n int, refundID string) string {
	t.Helper()
	job := fmt.Sprintf("dupjob-%d", n)
	invoice, payment, pi := fmt.Sprintf("in_dup_%d", n), fmt.Sprintf("inpay_dup_%d", n), fmt.Sprintf("pi_dup_%d", n)
	mustExec(t, store, `INSERT INTO billing_duplicate_refunds(id,user_id,customer_id,canonical_subscription_id,duplicate_subscription_id,state,subscription_canceled,refund_complete,liability_revision,created_at,updated_at) VALUES(?,?,?,?,?,'terminal',1,1,1,1,1)`,
		job, fmt.Sprintf("dupuser-%d", n), fmt.Sprintf("cus_dup_%d", n), fmt.Sprintf("sub_canon_%d", n), fmt.Sprintf("sub_dup_%d", n))
	mustExec(t, store, `INSERT INTO billing_duplicate_refund_invoices(job_id,invoice_id,status,amount_paid,created_at,updated_at) VALUES(?,?,'paid',500,1,1)`, job, invoice)
	mustExec(t, store, `INSERT INTO billing_duplicate_refund_liabilities(job_id,invoice_id,invoice_payment_id,payment_type,payment_intent_id,charge_id,amount_paid,charge_amount,paid_at,created_at) VALUES(?,?,?,'payment_intent',?,?,500,500,10,1)`, job, invoice, payment, pi, "ch_dup_"+fmt.Sprint(n))
	liabilities, err := loadDuplicateRefundLiabilities(context.Background(), store.db, job)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, _, err := duplicateRefundLiabilitySnapshot(liabilities)
	if err != nil {
		t.Fatal(err)
	}
	action := duplicateRefundActionID(job, 1)
	mustExec(t, store, `INSERT INTO billing_duplicate_refund_actions(id,job_id,generation,liability_revision,actor,reason,state,snapshot_json,proof_json,created_at,updated_at) VALUES(?,?,1,1,'operator','audit','succeeded',?,'proof',1,1)`, action, job, string(snapshot))
	mustExec(t, store, `INSERT INTO billing_duplicate_refund_constituents(action_id,job_id,generation,invoice_payment_id,payment_intent_id,refund_id,amount,status) VALUES(?,?,1,?,?,?,500,'succeeded')`, action, job, payment, pi, refundID)
	return job
}

// rowsErrCase is one billing iteration whose truncated result set must be an
// error. setup seeds at least two matching rows and returns the operation and
// the verification of the healthy, complete-scan outcome.
type rowsErrCase struct {
	name, match string
	setup       func(t *testing.T, store *SQLiteStore) (run func(context.Context) error, healthy func(t *testing.T, err error))
	// faulted replaces the whole-database equality check for an operation
	// whose earlier transactions are durable retry evidence by design; it must
	// prove the faulted transaction itself committed nothing.
	faulted func(t *testing.T, store *SQLiteStore)
}

func accountDeletionRowsCase(t *testing.T, store *SQLiteStore, seed func(User)) (func(context.Context) error, *User) {
	t.Helper()
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{BaseURL: "http://example.test", SessionTTL: time.Hour, AccountGraceDays: 30, BillingHoldSecret: "test-only-billing-hold-secret"})
	u, err := store.UpsertUserByEmail(context.Background(), fmt.Sprintf("rows-%d@example.test", time.Now().UnixNano()), "")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.RequestAccountDeletion(context.Background(), u.ID, u.Email); err != nil {
		t.Fatal(err)
	}
	token := mail.lastDeleteToken(t)
	seed(u)
	return func(ctx context.Context) error { return svc.ConfirmAccountDeletion(ctx, token) }, &u
}

func deletionOutboxFor(t *testing.T, store *SQLiteStore, userID string) BillingDeletionProgress {
	t.Helper()
	var id string
	if err := store.db.QueryRow(`SELECT id FROM billing_cancellation_outbox WHERE billing_subject_id=? AND state='pending' AND mode='account_deletion'`, userID).Scan(&id); err != nil {
		t.Fatalf("deletion outbox: %v", err)
	}
	return outboxProgress(t, store, id)
}

func rowsErrCases() []rowsErrCase {
	hazard := BillingDeletionResource{Kind: "checkout_session", ID: "cs_rows_late", Status: "expired"}
	return []rowsErrCase{
		{
			name:  "CommitAccountDeletion/customer history",
			match: `SELECT customer_id FROM stripe_customer_history WHERE user_id=?`,
			setup: func(t *testing.T, store *SQLiteStore) (func(context.Context) error, func(*testing.T, error)) {
				run, u := accountDeletionRowsCase(t, store, func(u User) {
					mustExec(t, store, `INSERT INTO stripe_customer_history(user_id,customer_id,created_at) VALUES(?,'cus_hist_a',1),(?,'cus_hist_b',2)`, u.ID, u.ID)
				})
				return run, func(t *testing.T, err error) {
					p := deletionOutboxFor(t, store, u.ID)
					if err != nil || !containsString(p.Customers, "cus_hist_a") || !containsString(p.Customers, "cus_hist_b") {
						t.Fatalf("customers=%v err=%v", p.Customers, err)
					}
				}
			},
		},
		{
			name:  "CommitAccountDeletion/purchase attempts",
			match: `SELECT id,provider_session_id,provider_subscription_id FROM billing_purchase_attempts`,
			setup: func(t *testing.T, store *SQLiteStore) (func(context.Context) error, func(*testing.T, error)) {
				run, u := accountDeletionRowsCase(t, store, func(u User) {
					mustExec(t, store, `INSERT INTO billing_purchase_attempts(id,user_id,provider,product_id,state,provider_session_id,provider_subscription_id,epoch,created_at) VALUES('att-rows-a',?,'stripe','pro','resolved','cs_rows_a','',1,1),('att-rows-b',?,'stripe','pro','resolved','cs_rows_b','sub_rows_b',2,2)`, u.ID, u.ID)
				})
				return run, func(t *testing.T, err error) {
					p := deletionOutboxFor(t, store, u.ID)
					if err != nil || !progressHasResource(p, "cs_rows_a") || !progressHasResource(p, "cs_rows_b") || !progressHasResource(p, "sub_rows_b") {
						t.Fatalf("resources=%+v err=%v", p.Resources, err)
					}
				}
			},
		},
		{
			name:  "AppendStripeActiveAccountDeletionHazard/pending generations",
			match: `SELECT id,progress_json FROM billing_cancellation_outbox WHERE billing_subject_id=?`,
			setup: func(t *testing.T, store *SQLiteStore) (func(context.Context) error, func(*testing.T, error)) {
				seedDeletionOutbox(t, store, "out-active-1", "subj-active", "pending", "account_deletion", 1, BillingDeletionProgress{}, "", "", 1)
				seedDeletionOutbox(t, store, "out-active-2", "subj-active", "pending", "account_deletion", 2, BillingDeletionProgress{}, "", "", 1)
				return func(ctx context.Context) error {
						return store.AppendStripeActiveAccountDeletionHazard(ctx, "subj-active", hazard)
					}, func(t *testing.T, err error) {
						if err != nil || !progressHasResource(outboxProgress(t, store, "out-active-1"), hazard.ID) || !progressHasResource(outboxProgress(t, store, "out-active-2"), hazard.ID) {
							t.Fatalf("hazard not journaled on every generation: err=%v", err)
						}
					}
			},
		},
		{
			name:  "AppendStripeActiveAccountDeletionHazardForCustomer/subjects",
			match: `SELECT DISTINCT o.billing_subject_id FROM billing_cancellation_outbox o JOIN stripe_customer_history`,
			setup: func(t *testing.T, store *SQLiteStore) (func(context.Context) error, func(*testing.T, error)) {
				for _, subject := range []string{"subj-amb-a", "subj-amb-b"} {
					mustExec(t, store, `INSERT INTO stripe_customer_history(user_id,customer_id,created_at) VALUES(?,'cus_amb_active',1)`, subject)
					seedDeletionOutbox(t, store, "out-"+subject, subject, "pending", "account_deletion", 1, BillingDeletionProgress{}, "", "", 1)
				}
				return func(ctx context.Context) error {
						_, err := store.AppendStripeActiveAccountDeletionHazardForCustomer(ctx, "cus_amb_active", "", hazard)
						return err
					}, func(t *testing.T, err error) {
						if err == nil || !strings.Contains(err.Error(), "ambiguous") {
							t.Fatalf("shared customer must fail closed as ambiguous: %v", err)
						}
					}
			},
		},
		{
			name:  "AppendStripeActiveAccountDeletionHazardForCustomer/pending generations",
			match: `SELECT id,progress_json FROM billing_cancellation_outbox WHERE billing_subject_id=?`,
			setup: func(t *testing.T, store *SQLiteStore) (func(context.Context) error, func(*testing.T, error)) {
				mustExec(t, store, `INSERT INTO stripe_customer_history(user_id,customer_id,created_at) VALUES('subj-one','cus_one',1)`)
				seedDeletionOutbox(t, store, "out-one-1", "subj-one", "pending", "account_deletion", 1, BillingDeletionProgress{}, "", "", 1)
				seedDeletionOutbox(t, store, "out-one-2", "subj-one", "pending", "account_deletion", 2, BillingDeletionProgress{}, "", "", 1)
				return func(ctx context.Context) error {
						_, err := store.AppendStripeActiveAccountDeletionHazardForCustomer(ctx, "cus_one", "subj-one", hazard)
						return err
					}, func(t *testing.T, err error) {
						if err != nil || !progressHasResource(outboxProgress(t, store, "out-one-1"), hazard.ID) || !progressHasResource(outboxProgress(t, store, "out-one-2"), hazard.ID) {
							t.Fatalf("hazard not journaled on every generation: err=%v", err)
						}
					}
			},
		},
		{
			name:  "appendStripeDeletionHazardsTx/pending rows",
			match: `SELECT id,progress_json,mode FROM billing_cancellation_outbox`,
			setup: func(t *testing.T, store *SQLiteStore) (func(context.Context) error, func(*testing.T, error)) {
				// The compensation row sorts first; losing the account-deletion
				// row would make the subscription observation a silent no-op.
				seedDeletionOutbox(t, store, "out-mixed-1", "subj-mixed", "pending", "exact_compensation", 1, BillingDeletionProgress{}, "", "", 1)
				seedDeletionOutbox(t, store, "out-mixed-2", "subj-mixed", "pending", "account_deletion", 2, BillingDeletionProgress{}, "", "", 1)
				return func(ctx context.Context) error {
						return store.AppendStripeDeletionHazard(ctx, "subj-mixed", BillingDeletionResource{Kind: "subscription", ID: "sub_rows_late", Status: "observed"})
					}, func(t *testing.T, err error) {
						if err != nil || !progressHasResource(outboxProgress(t, store, "out-mixed-2"), "sub_rows_late") {
							t.Fatalf("subscription hazard dropped: err=%v", err)
						}
					}
			},
		},
		{
			name:  "appendStripeCustomerDeletionHazards/subjects",
			match: `SELECT DISTINCT user_id FROM stripe_customer_history WHERE customer_id=?`,
			setup: func(t *testing.T, store *SQLiteStore) (func(context.Context) error, func(*testing.T, error)) {
				mustExec(t, store, `INSERT INTO stripe_customer_history(user_id,customer_id,created_at) VALUES('subj-cus-a','cus_amb_hazard',1),('subj-cus-b','cus_amb_hazard',1)`)
				return func(ctx context.Context) error {
						return store.AppendStripePaidInvoiceDeletionHazards(ctx, "cus_amb_hazard", []BillingDeletionResource{{Kind: "invoice", ID: "in_rows_amb", Status: "paid"}})
					}, func(t *testing.T, err error) {
						if err == nil || !strings.Contains(err.Error(), "ambiguous") {
							t.Fatalf("shared customer must fail closed as ambiguous: %v", err)
						}
					}
			},
		},
		{
			name:  "AppendCanonicalStripePaidInvoiceDeletionHazards/subjects",
			match: `SELECT DISTINCT user_id FROM stripe_customer_history WHERE customer_id=?`,
			setup: func(t *testing.T, store *SQLiteStore) (func(context.Context) error, func(*testing.T, error)) {
				mustExec(t, store, `INSERT INTO stripe_customer_history(user_id,customer_id,created_at) VALUES('subj-canon-a','cus_amb_canon',1),('subj-canon-b','cus_amb_canon',1)`)
				invoice := CanonicalStripePaidInvoice{InvoiceID: "in_rows_canon", CustomerID: "cus_amb_canon", SubscriptionID: "sub_rows_canon", CreatedAt: 10, PaidAt: 20}
				return func(ctx context.Context) error {
						return store.AppendCanonicalStripePaidInvoiceDeletionHazards(ctx, invoice, []BillingDeletionResource{{Kind: "invoice", ID: "in_rows_canon", Status: "paid"}})
					}, func(t *testing.T, err error) {
						if err == nil || !strings.Contains(err.Error(), "not unique") {
							t.Fatalf("shared customer must fail closed as not unique: %v", err)
						}
					}
			},
		},
		{
			name:  "AppendCanonicalStripePaidInvoiceDeletionHazards/terminal epochs",
			match: `SELECT id,customer_id,subscription_id,captured_source_id,created_at,cutoff_at,progress_json FROM billing_cancellation_outbox`,
			setup: func(t *testing.T, store *SQLiteStore) (func(context.Context) error, func(*testing.T, error)) {
				// Two completed epochs both match the paid invoice: the only
				// correct answer is an ambiguity error, never a partial unique match.
				mustExec(t, store, `INSERT INTO stripe_customer_history(user_id,customer_id,created_at) VALUES('subj-term','cus_term',1)`)
				for gen := int64(1); gen <= 2; gen++ {
					seedDeletionOutbox(t, store, fmt.Sprintf("out-term-%d", gen), "subj-term", "terminal", "account_deletion", gen, BillingDeletionProgress{Customers: []string{"cus_term"}}, "cus_term", "sub_term", 5)
				}
				invoice := CanonicalStripePaidInvoice{InvoiceID: "in_rows_term", CustomerID: "cus_term", SubscriptionID: "sub_term", CreatedAt: 10, PaidAt: 20}
				return func(ctx context.Context) error {
						return store.AppendCanonicalStripePaidInvoiceDeletionHazards(ctx, invoice, []BillingDeletionResource{{Kind: "invoice", ID: "in_rows_term", Status: "paid"}})
					}, func(t *testing.T, err error) {
						if err == nil || !strings.Contains(err.Error(), "does not identify one deletion epoch") {
							t.Fatalf("two matching epochs must fail closed: %v", err)
						}
					}
			},
		},
		{
			name:  "DuplicateRefundBySubscription/liabilities",
			match: `FROM billing_duplicate_refund_invoices i LEFT JOIN billing_duplicate_refund_liabilities`,
			setup: func(t *testing.T, store *SQLiteStore) (func(context.Context) error, func(*testing.T, error)) {
				seedDuplicateRefundJob(t, store, 1, "re_rows_liability")
				mustExec(t, store, `INSERT INTO billing_duplicate_refund_invoices(job_id,invoice_id,status,amount_paid,created_at,updated_at) VALUES('dupjob-1','in_dup_1b','paid',700,1,1)`)
				mustExec(t, store, `INSERT INTO billing_duplicate_refund_liabilities(job_id,invoice_id,invoice_payment_id,payment_type,payment_intent_id,charge_id,amount_paid,charge_amount,paid_at,created_at) VALUES('dupjob-1','in_dup_1b','inpay_dup_1b','payment_intent','pi_dup_1b','ch_dup_1b',700,700,11,1)`)
				var job DuplicateRefundJob
				return func(ctx context.Context) error {
						var err error
						job, _, err = store.DuplicateRefundBySubscription(ctx, "sub_dup_1")
						return err
					}, func(t *testing.T, err error) {
						if err != nil || len(job.Liabilities) != 2 {
							t.Fatalf("liabilities=%+v err=%v", job.Liabilities, err)
						}
					}
			},
		},
		{
			name:  "recordDuplicateRefundFailuresTx/jobs",
			match: `SELECT DISTINCT job_id FROM billing_duplicate_refund_constituents WHERE refund_id=?`,
			setup: func(t *testing.T, store *SQLiteStore) (func(context.Context) error, func(*testing.T, error)) {
				jobs := []string{seedDuplicateRefundJob(t, store, 1, "re_rows_shared"), seedDuplicateRefundJob(t, store, 2, "re_rows_shared")}
				return func(ctx context.Context) error {
						return store.RecordStripeDeletionRefundLifecycle(ctx, "evt_rows_dup_failed", "re_rows_shared", "", "", "failed", 200)
					}, func(t *testing.T, err error) {
						if err != nil {
							t.Fatal(err)
						}
						assertDuplicateJobsReopened(t, store, jobs)
					}
			},
		},
		{
			name:  "finishDuplicateRefundAction/stored constituents",
			match: `SELECT refund_id,invoice_payment_id,payment_intent_id,status,amount FROM billing_duplicate_refund_constituents`,
			setup: func(t *testing.T, store *SQLiteStore) (func(context.Context) error, func(*testing.T, error)) {
				state := &duplicateStripeState{active: true, refunds: map[string]int64{}}
				client, closeServer := newDuplicateStripe(t, state, true)
				t.Cleanup(closeServer)
				job := prepareCanceledManualDuplicate(t, store, client, state)
				var result DuplicateRefundOperatorResult
				return func(ctx context.Context) error {
						var err error
						result, err = resolveDuplicateRefundCurrent(ctx, store, client, job.ID, "operator", "rows audit")
						return err
					}, func(t *testing.T, err error) {
						state.mu.Lock()
						posts := state.refundPosts
						state.mu.Unlock()
						if err != nil || result.State != "succeeded" || posts != 2 {
							t.Fatalf("result=%+v posts=%d err=%v: retry must finish without another provider refund", result, posts, err)
						}
					}
			},
			// Prepare and provider-observation binding commit before finish by
			// design; the truncated finish must leave the job manual and the
			// action prepared so the operator retry can complete it.
			faulted: func(t *testing.T, store *SQLiteStore) {
				var jobState, actionState string
				var complete, constituents int
				if err := store.db.QueryRow(`SELECT state,refund_complete FROM billing_duplicate_refunds WHERE duplicate_subscription_id='sub_dup'`).Scan(&jobState, &complete); err != nil {
					t.Fatal(err)
				}
				if err := store.db.QueryRow(`SELECT state FROM billing_duplicate_refund_actions ORDER BY generation DESC LIMIT 1`).Scan(&actionState); err != nil {
					t.Fatal(err)
				}
				if err := store.db.QueryRow(`SELECT COUNT(*) FROM billing_duplicate_refund_constituents`).Scan(&constituents); err != nil {
					t.Fatal(err)
				}
				if jobState != "manual" || complete != 0 || actionState != "prepared" || constituents != 2 {
					t.Fatalf("job=%q complete=%d action=%q constituents=%d: truncated proof reached a terminal state", jobState, complete, actionState, constituents)
				}
			},
		},
		{
			name:  "recordStripeDeletionRefundFailuresTx/actions",
			match: `SELECT DISTINCT a.id FROM billing_deletion_manual_actions a`,
			setup: func(t *testing.T, store *SQLiteStore) (func(context.Context) error, func(*testing.T, error)) {
				seedSharedDeletionRefund(t, store)
				return func(ctx context.Context) error {
					return store.RecordStripeDeletionRefundLifecycle(ctx, "evt_rows_shared_fail", "re_shared", "", "pi_shared", "failed", 200)
				}, func(t *testing.T, err error) { assertSharedDeletionRefundReopened(t, store, err) }
			},
		},
	}
}

func assertDuplicateJobsReopened(t *testing.T, store *SQLiteStore, jobs []string) {
	t.Helper()
	for _, job := range jobs {
		var state, reason string
		var complete, prepared int
		if err := store.db.QueryRow(`SELECT state,manual_reason,refund_complete FROM billing_duplicate_refunds WHERE id=?`, job).Scan(&state, &reason, &complete); err != nil {
			t.Fatal(err)
		}
		if err := store.db.QueryRow(`SELECT COUNT(*) FROM billing_duplicate_refund_actions WHERE job_id=? AND generation=2 AND state='prepared'`, job).Scan(&prepared); err != nil {
			t.Fatal(err)
		}
		if state != "manual" || reason != "provider_refund_failed" || complete != 0 || prepared != 1 {
			t.Fatalf("%s state=%q reason=%q complete=%d prepared=%d: failed refund liability lost", job, state, reason, complete, prepared)
		}
	}
}

// seedSharedDeletionRefund is the TestRefundFailureRotatesEveryDependentAction
// shape: one provider refund proves two deletion subjects' manual refunds, and
// both holds were released on that proof.
func seedSharedDeletionRefund(t *testing.T, store *SQLiteStore) {
	t.Helper()
	p := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{"payment_intent:pi_shared": {Kind: "payment_intent", ID: "pi_shared", PaymentIntentID: "pi_shared", Status: "refunded", Terminal: true}}}
	for i := 1; i <= 2; i++ {
		out, subject, action := fmt.Sprintf("out-%d", i), fmt.Sprintf("subject-%d", i), fmt.Sprintf("action-%d", i)
		mustExec(t, store, `INSERT INTO billing_deletion_holds(billing_subject_id,email_hmac,provider,created_at,expires_at,review_at,subject_released_at) VALUES(?,X'09','stripe',1,2,3,99)`, subject)
		mustExec(t, store, `INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,progress_json,created_at,updated_at,generation) VALUES(?,?,'stripe',?,'pending',?,1,1,1)`, out, subject, "key-"+out, progressJSON(t, p))
		mustExec(t, store, `INSERT INTO billing_deletion_manual_actions(id,outbox_id,resource_key,actor,reason,payment_intent_id,refund_id,state,retry_generation,provider_status,refund_proof,created_at,updated_at) VALUES(?,?,'payment_intent:pi_shared','operator','audit','pi_shared','re_primary','succeeded',0,'succeeded','proof',1,1)`, action, out)
		mustExec(t, store, `INSERT INTO billing_deletion_refund_constituents(action_id,outbox_id,payment_intent_id,proof_generation,refund_id,amount,status) VALUES(?,?,'pi_shared',0,'re_shared',500,'succeeded')`, action, out)
	}
}

func assertSharedDeletionRefundReopened(t *testing.T, store *SQLiteStore, err error) {
	t.Helper()
	var failed, prepared, reheld int
	_ = store.db.QueryRow(`SELECT COUNT(*) FROM billing_deletion_manual_actions WHERE state='failed'`).Scan(&failed)
	_ = store.db.QueryRow(`SELECT COUNT(*) FROM billing_deletion_manual_actions WHERE state='prepared' AND retry_generation=1`).Scan(&prepared)
	_ = store.db.QueryRow(`SELECT COUNT(*) FROM billing_deletion_holds WHERE subject_released_at=0`).Scan(&reheld)
	if err != nil || failed != 2 || prepared != 2 || reheld != 2 {
		t.Fatalf("failed=%d prepared=%d reheld=%d err=%v: a failed refund left a released hold", failed, prepared, reheld, err)
	}
}

// TestBillingRowIterationErrorsFailClosed truncates each billing scan after one
// real row. The operation must return the scan error, commit nothing, and the
// same call must converge to the complete-scan outcome once the fault clears.
func TestBillingRowIterationErrorsFailClosed(t *testing.T) {
	for _, tc := range rowsErrCases() {
		t.Run(tc.name, func(t *testing.T) {
			store, fault := newRowFaultStore(t)
			run, healthy := tc.setup(t, store)
			before := billingStateDump(t, store)
			fault.arm(tc.match, 1)
			err := run(context.Background())
			fired := fault.disarm()
			if len(fired) != 1 {
				t.Fatalf("fault did not truncate exactly one real scan: fired=%q", fired)
			}
			if !errors.Is(err, errInjectedRowFault) {
				t.Fatalf("truncated scan was treated as complete evidence: err=%v", err)
			}
			if tc.faulted != nil {
				tc.faulted(t, store)
			} else if after := billingStateDump(t, store); after != before {
				t.Fatalf("truncated scan committed state:\nbefore:\n%s\nafter:\n%s", before, after)
			}
			healthy(t, run(context.Background()))
		})
	}
}

// TestBillingRowIterationZeroAndCompleteScansUnchanged is the success-path
// control: an armed fault that finds no further row never fires, so the
// ordinary outcome is unchanged for empty and fully delivered result sets.
func TestBillingRowIterationZeroAndCompleteScansUnchanged(t *testing.T) {
	for _, tc := range rowsErrCases() {
		t.Run(tc.name, func(t *testing.T) {
			store, fault := newRowFaultStore(t)
			run, healthy := tc.setup(t, store)
			fault.arm(tc.match, 1<<30)
			err := run(context.Background())
			if fired := fault.disarm(); len(fired) != 0 {
				t.Fatalf("complete scan fault fired: %q", fired)
			}
			healthy(t, err)
		})
	}
	store, fault := newRowFaultStore(t)
	fault.arm(`SELECT DISTINCT a.id FROM billing_deletion_manual_actions a`, 0)
	if err := store.RecordStripeDeletionRefundLifecycle(context.Background(), "evt_rows_empty", "re_rows_empty", "", "pi_rows_empty", "failed", 1); err != nil {
		t.Fatalf("zero-row failure scan: %v", err)
	}
	if fired := fault.disarm(); len(fired) != 0 {
		t.Fatalf("zero-row scan fault fired: %q", fired)
	}
	var status string
	if err := store.db.QueryRow(`SELECT status FROM billing_deletion_refund_inbox WHERE refund_id='re_rows_empty'`).Scan(&status); err != nil || status != "failed" {
		t.Fatalf("zero-row failure not durable: status=%q err=%v", status, err)
	}
}

// TestRowFaultHarnessMatchesDatabaseSQLSemantics pins why the fix is needed: a
// mid-iteration error leaves Close returning nil and is visible only on Err.
func TestRowFaultHarnessMatchesDatabaseSQLSemantics(t *testing.T) {
	store, fault := newRowFaultStore(t)
	mustExec(t, store, `INSERT INTO stripe_customer_history(user_id,customer_id,created_at) VALUES('harness','cus_h1',1),('harness','cus_h2',2)`)
	fault.arm(`FROM stripe_customer_history WHERE user_id='harness'`, 1)
	rows, err := store.db.Query(`SELECT customer_id FROM stripe_customer_history WHERE user_id='harness' ORDER BY customer_id`)
	if err != nil {
		t.Fatal(err)
	}
	var seen []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			t.Fatal(err)
		}
		seen = append(seen, c)
	}
	closeErr := rows.Close()
	if len(seen) != 1 || closeErr != nil || !errors.Is(rows.Err(), errInjectedRowFault) || len(fault.disarm()) != 1 {
		t.Fatalf("seen=%v close=%v err=%v", seen, closeErr, rows.Err())
	}
}

// TestFailedRefundWebhookScanFaultKeepsEveryLiabilityRetryable is the end-to-end
// financial consequence through the real webhook handler: a refund.failed
// event whose dependent-action scan is truncated must not be acknowledged, must
// leave every hold and duplicate liability untouched, and the provider's retry
// of the same event must reopen all of them exactly once.
func TestFailedRefundWebhookScanFaultKeepsEveryLiabilityRetryable(t *testing.T) {
	for _, tc := range []struct {
		name, match string
		seed        func(t *testing.T, store *SQLiteStore) func(t *testing.T)
	}{
		{"deletion holds", `SELECT DISTINCT a.id FROM billing_deletion_manual_actions a`, func(t *testing.T, store *SQLiteStore) func(t *testing.T) {
			seedSharedDeletionRefund(t, store)
			return func(t *testing.T) { assertSharedDeletionRefundReopened(t, store, nil) }
		}},
		{"duplicate refunds", `SELECT DISTINCT job_id FROM billing_duplicate_refund_constituents WHERE refund_id=?`, func(t *testing.T, store *SQLiteStore) func(t *testing.T) {
			jobs := []string{seedDuplicateRefundJob(t, store, 1, "re_shared"), seedDuplicateRefundJob(t, store, 2, "re_shared")}
			return func(t *testing.T) { assertDuplicateJobsReopened(t, store, jobs) }
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store, fault := newRowFaultStore(t)
			svc := NewService(store, &capturingMailer{}, Config{BaseURL: "http://example.test", SessionTTL: time.Hour})
			svc.biller = NewStripeClient("sk_test_x", "whsec", "bpc_x")
			ts := httptest.NewServer(svc.Routes())
			t.Cleanup(ts.Close)
			verify := tc.seed(t, store)
			before := billingStateDump(t, store)
			body := fmt.Sprintf(`{"id":"evt_rows_refund_failed","type":"refund.failed","created":%d,"data":{"object":{"id":"re_shared","object":"refund","payment_intent":"pi_shared","status":"failed"}}}`, time.Now().Unix())
			fault.arm(tc.match, 1)
			resp := postWebhook(t, ts, "whsec", body)
			resp.Body.Close()
			if fired := fault.disarm(); len(fired) != 1 || resp.StatusCode == 200 {
				t.Fatalf("truncated scan acknowledged: status=%d fired=%q", resp.StatusCode, fired)
			}
			if after := billingStateDump(t, store); after != before {
				t.Fatalf("unacknowledged webhook committed state:\nbefore:\n%s\nafter:\n%s", before, after)
			}
			for attempt := 0; attempt < 2; attempt++ {
				resp = postWebhook(t, ts, "whsec", body)
				resp.Body.Close()
				if resp.StatusCode != 200 {
					t.Fatalf("retry %d status=%d", attempt, resp.StatusCode)
				}
				verify(t)
			}
		})
	}
}
