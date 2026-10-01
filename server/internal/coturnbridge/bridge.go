package coturnbridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/relayium/relayium/internal/coturnbridge/wire"
)

// Config configures a Bridge.
type Config struct {
	RelayID string
	Realm   string

	RedisAddr, RedisUser, RedisPassword string

	CLIAddr, CLIPassword string
	// PSDPath is the dump file coturn's psd writes; its directory must be
	// private to coturn and the bridge.
	PSDPath string

	SpoolDir string

	CentralURL, Token string
	HTTPClient        *http.Client

	Epoch EpochSource

	BarrierInterval time.Duration // default 1s
	BarrierTimeout  time.Duration // default 10s
	PSDInterval     time.Duration // default 30s; 0 disables psd
	FlushInterval   time.Duration // default 1s
	ReportInterval  time.Duration // default 10s
	ClampRetry      time.Duration // default 30s
	MissingListings int           // default 2

	SpoolMaxEntries    int   // default 100000
	SpoolMaxBytes      int64 // default 64 KiB per record
	PSDMaxBytes        int64 // default 64 MiB
	SegmentMaxMessages int   // default 200000
	QuarantineMaxBytes int64 // default 256 MiB
	BatchSize          int   // default wire.MaxSnapshotsPerRequest

	Now  func() time.Time
	Logf func(format string, args ...any)
}

var reRealm = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$`)

func (c *Config) defaults() error {
	if !wire.ValidRelayID(c.RelayID) {
		return fmt.Errorf("coturnbridge: relay id %q", c.RelayID)
	}
	if !reRealm.MatchString(c.Realm) {
		return fmt.Errorf("coturnbridge: realm %q", c.Realm)
	}
	if c.Epoch == nil || c.SpoolDir == "" || c.RedisAddr == "" || c.CentralURL == "" || c.Token == "" {
		return errors.New("coturnbridge: epoch source, spool dir, redis address, central URL and token are required")
	}
	def := func(d *time.Duration, v time.Duration) {
		if *d <= 0 {
			*d = v
		}
	}
	def(&c.BarrierInterval, time.Second)
	def(&c.BarrierTimeout, 10*time.Second)
	def(&c.FlushInterval, time.Second)
	def(&c.ReportInterval, 10*time.Second)
	def(&c.ClampRetry, 30*time.Second)
	if c.PSDInterval < 0 {
		c.PSDInterval = 0
	}
	if c.PSDInterval > 0 && (c.CLIAddr == "" || c.PSDPath == "") {
		return errors.New("coturnbridge: psd needs the CLI address and a dump path")
	}
	if c.MissingListings <= 0 {
		c.MissingListings = 2
	}
	// Ordering guard: an end is inferred only after MissingListings listings
	// without the session. A final applied through the stream waits at most a
	// barrier interval plus its timeout; the missing window must exceed that,
	// so a healthy late final normally lands before any inference. (A final
	// that still lands after an inference upgrades it; see Tracker.)
	if c.PSDInterval > 0 && time.Duration(c.MissingListings)*c.PSDInterval <= c.BarrierInterval+c.BarrierTimeout {
		return fmt.Errorf("coturnbridge: %d listings × %v must exceed barrier interval + timeout (%v)",
			c.MissingListings, c.PSDInterval, c.BarrierInterval+c.BarrierTimeout)
	}
	if c.SpoolMaxEntries <= 0 {
		c.SpoolMaxEntries = 100000
	}
	if c.SpoolMaxBytes <= 0 {
		c.SpoolMaxBytes = 64 << 10
	}
	if c.PSDMaxBytes <= 0 {
		c.PSDMaxBytes = 64 << 20
	}
	if c.SegmentMaxMessages <= 0 {
		c.SegmentMaxMessages = 200000
	}
	if c.QuarantineMaxBytes <= 0 {
		c.QuarantineMaxBytes = 256 << 20
	}
	if c.BatchSize <= 0 || c.BatchSize > wire.MaxSnapshotsPerRequest {
		c.BatchSize = wire.MaxSnapshotsPerRequest
	}
	if c.HTTPClient == nil {
		c.HTTPClient = &http.Client{Timeout: 30 * time.Second}
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	return nil
}

// Status is written to <spool>/status.json on every flush for monitoring.
type Status struct {
	UpdatedUnix         int64  `json:"updatedUnix"`
	Epoch               string `json:"epoch"`
	LastTrustedBarrier  int64  `json:"lastTrustedBarrierUnix"`
	LastListing         int64  `json:"lastListingUnix"`
	LastReportOK        int64  `json:"lastReportOkUnix"`
	ReportFailingSince  int64  `json:"reportFailingSinceUnix"`
	Allocations         int    `json:"allocations"`
	Unsettled           int    `json:"unsettled"`
	Unpersisted         int    `json:"unpersisted"`
	Alerts              int64  `json:"alerts"`
	QuarantinedSegments int64  `json:"quarantinedSegments"`
	QuarantinedMessages int64  `json:"quarantinedMessages"`
	Gaps                int64  `json:"gaps"`
	DeadLettered        int64  `json:"deadLettered"`
	Delivered           int64  `json:"delivered"`
	// UnattributedBytes: client bytes coturn reported for sessions with no
	// username (STUN-only, never billable).
	UnattributedBytes int64 `json:"unattributedBytes"`
	SubscriptionUp    bool  `json:"subscriptionUp"`
	// LastTrustedBarrierSentMilli is when the PING of the latest trusted
	// barrier was SENT (unix ms): every message Redis received before then
	// has been applied.
	LastTrustedBarrierSentMilli int64 `json:"lastTrustedBarrierSentMilli"`
	// Held counts allocations with no snapshot yet (persisted, not sendable).
	Held int `json:"held"`
	// RecentFinals lists allocations (AllocKey strings) delivered as final
	// during the last forgetSecs, for drain readiness.
	RecentFinals []string `json:"recentFinals,omitempty"`
	LastError    string   `json:"lastError,omitempty"`
}

// Bridge is the running coturn metering bridge.
type Bridge struct {
	cfg      Config
	spool    *Spool
	reporter *Reporter

	mu          sync.Mutex
	tr          *Tracker
	current     Epoch // last epoch confirmed by a trusted barrier
	unpersisted map[AllocKey]bool
	retryAfter  map[AllocKey]int64
	st          Status
	kick        chan struct{}
	finals      map[string]int64   // recently delivered finals (bridge time)
	gone        map[AllocKey]int64 // gone marks on disk (bridge time)
}

// New builds a bridge and loads its spool.
func New(cfg Config) (*Bridge, error) {
	if err := cfg.defaults(); err != nil {
		return nil, err
	}
	b := &Bridge{
		cfg:         cfg,
		spool:       &Spool{Dir: cfg.SpoolDir, MaxEntries: cfg.SpoolMaxEntries, MaxBytes: cfg.SpoolMaxBytes},
		reporter:    &Reporter{BaseURL: cfg.CentralURL, Token: cfg.Token, RelayID: cfg.RelayID, Client: cfg.HTTPClient},
		unpersisted: map[AllocKey]bool{},
		retryAfter:  map[AllocKey]int64{},
		kick:        make(chan struct{}, 1),
		finals:      map[string]int64{},
		gone:        map[AllocKey]int64{},
	}
	b.tr = NewTracker(cfg.RelayID, b.alert)
	if cfg.PSDInterval > 0 {
		b.tr.HoldUnknownSecs = int64((2*cfg.PSDInterval + 5*time.Second) / time.Second)
	}
	if err := b.spool.Open(); err != nil {
		return nil, err
	}
	loaded, err := b.spool.Load(b.alert)
	if err != nil {
		return nil, err
	}
	gone, err := b.spool.LoadGone(b.alert)
	if err != nil {
		return nil, err
	}
	for k, at := range gone {
		b.gone[k] = at
		b.tr.forgotten[k] = at
	}
	for _, a := range loaded {
		if _, ok := gone[a.Key]; ok {
			// Crashed between writing the gone mark and removing the record:
			// the mark wins; the record (which names the user) goes.
			if err := b.spool.Remove(a.Key); err != nil {
				return nil, err
			}
			continue
		}
		if a.Snap != nil && a.Snap.RelayID != cfg.RelayID {
			return nil, fmt.Errorf("coturnbridge: spool holds relay %q, configured %q", a.Snap.RelayID, cfg.RelayID)
		}
		// Generations restart with the process; anything loaded predates
		// every listing of this run.
		a.FirstGen = 0
		a.MissingListings = 0
		a.MarkPersisted()
		b.tr.Allocs[a.Key] = a
		if a.State == wire.StateLive {
			// Whatever coturn published while the bridge was down is lost to
			// the stream: StreamSum is a lower bound from here on.
			a.StreamGaps++
			a.dirty = true
		}
	}
	b.logf("coturn bridge: loaded %d allocations from %s", len(loaded), cfg.SpoolDir)
	return b, nil
}

func (b *Bridge) logf(format string, args ...any) {
	if b.cfg.Logf != nil {
		b.cfg.Logf(format, args...)
	}
}

// alert logs and counts an anomaly. Every caller holds b.mu (the tracker is
// only used under it) or runs before the loops start.
func (b *Bridge) alert(format string, args ...any) {
	b.st.Alerts++
	b.logf("coturn bridge: "+format, args...)
}

func (b *Bridge) now() int64 { return b.cfg.Now().Unix() }

// Run runs until ctx is cancelled.
func (b *Bridge) Run(ctx context.Context) error {
	var wg sync.WaitGroup
	wg.Go(func() { b.subscribeLoop(ctx) })
	if b.cfg.PSDInterval > 0 {
		wg.Go(func() { b.listingLoop(ctx) })
	}
	wg.Go(func() { b.flushLoop(ctx) })
	wg.Go(func() { b.reportLoop(ctx) })
	wg.Wait()
	// Final flush so nothing observed is left only in memory.
	b.flush()
	return ctx.Err()
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// segMsg is one received pub/sub message awaiting its closing barrier.
type segMsg struct {
	Channel  string `json:"channel"`
	Payload  string `json:"payload"`
	RecvUnix int64  `json:"recvUnix"`
}

// subscribeLoop owns the Redis subscription. Messages are buffered per
// barrier segment and applied only when the segment's epoch is proven; see
// closeSegment.
func (b *Bridge) subscribeLoop(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := b.subscribeOnce(ctx)
		b.mu.Lock()
		b.st.SubscriptionUp = false
		if err != nil && ctx.Err() == nil {
			b.st.LastError = err.Error()
			b.st.Gaps++
			b.tr.NoteGap(b.current)
			b.alert("ALERT redis subscription lost (%v): interval deltas published until resubscribed are lost to the stream", err)
		}
		b.mu.Unlock()
		if !sleepCtx(ctx, backoff) {
			return
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

func (b *Bridge) readEpoch() (Epoch, bool) {
	e, err := b.cfg.Epoch.Read()
	return e, err == nil && e.Valid()
}

func (b *Bridge) subscribeOnce(ctx context.Context) error {
	conn, err := DialRedis(b.cfg.RedisAddr, b.cfg.RedisUser, b.cfg.RedisPassword, 5*time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()

	// Barrier 0 is the subscription itself: nothing published before Redis
	// processed PSUBSCRIBE can be delivered on this connection.
	pre, preOK := b.readEpoch()
	if err := conn.Send("PSUBSCRIBE", "turn/realm/"+b.cfg.Realm+"/user/*"); err != nil {
		return err
	}
	conn.SetReadDeadline(time.Now().Add(b.cfg.BarrierTimeout))
	f, err := conn.Read()
	if err != nil {
		return err
	}
	if pf, err := Classify(f); err != nil || pf.Kind != "psubscribe" {
		return fmt.Errorf("no subscription confirmation (%v, %v)", pf.Kind, err)
	}
	b.mu.Lock()
	b.st.SubscriptionUp = true
	b.mu.Unlock()
	b.logf("coturn bridge: subscribed to %s on %s", "turn/realm/"+b.cfg.Realm+"/user/*", b.cfg.RedisAddr)

	prevPre, prevOK := pre, preOK
	var token uint64
	var seg []segMsg
	for {
		if !sleepCtx(ctx, b.cfg.BarrierInterval) {
			return nil
		}
		token++
		tok := "relayium-barrier-" + strconv.FormatUint(token, 10)
		pre, preOK := b.readEpoch()
		sentMilli := time.Now().UnixMilli()
		if err := conn.Send("PING", tok); err != nil {
			b.quarantine(seg, "connection failed before barrier")
			return err
		}
		conn.SetReadDeadline(time.Now().Add(b.cfg.BarrierTimeout))
		for {
			f, err := conn.Read()
			if err != nil {
				b.quarantine(seg, "connection failed inside barrier")
				return err
			}
			pf, err := Classify(f)
			if err != nil {
				b.quarantine(seg, "protocol error inside barrier")
				return err
			}
			if pf.Kind == "pong" {
				if pf.Payload != tok {
					b.quarantine(seg, "out-of-order barrier reply")
					return fmt.Errorf("barrier token %q, want %q", pf.Payload, tok)
				}
				break
			}
			if pf.Kind == "pmessage" {
				if len(seg) >= b.cfg.SegmentMaxMessages {
					b.quarantine(seg, "segment overflow")
					return errors.New("segment overflow")
				}
				seg = append(seg, segMsg{Channel: pf.Channel, Payload: pf.Payload, RecvUnix: b.now()})
			}
		}
		post, postOK := b.readEpoch()
		b.closeSegment(seg, prevPre, prevOK, pre, preOK, post, postOK, sentMilli)
		seg = nil
		prevPre, prevOK = pre, preOK
	}
}

// closeSegment decides a segment's provenance. Its messages were published
// after Redis processed the previous barrier and before it processed this
// one, so they came from the process alive throughout [prevPre, post] if the
// epoch read before the previous barrier, before this one and after its reply
// are identical. Otherwise the segment is quarantined: never billed, kept as
// evidence.
func (b *Bridge) closeSegment(seg []segMsg, prevPre Epoch, prevOK bool, pre Epoch, preOK bool, post Epoch, postOK bool, sentMilli int64) {
	trusted := prevOK && preOK && postOK && prevPre == pre && pre == post
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	if !trusted {
		if len(seg) > 0 {
			b.quarantineLocked(seg, fmt.Sprintf("provider epoch not stable across the segment (%v %v %v)", prevPre, pre, post))
		}
		if postOK && b.current.Valid() && post != b.current {
			// The old process is gone: it can publish nothing more.
			b.tr.EndEpoch(post)
		} else if !postOK && b.current.Valid() {
			if al, ok := b.cfg.Epoch.(interface{ Alive(Epoch) bool }); ok && !al.Alive(b.current) {
				// The confirmed process no longer exists (not merely unreadable).
				b.tr.EndEpoch(Epoch{})
			}
		}
		return
	}
	if post != b.current {
		if b.current.Valid() {
			b.logf("coturn bridge: provider epoch changed %s -> %s", b.current, post)
		}
		b.current = post
		b.st.Epoch = post.String()
		b.tr.EndEpoch(post)
	}
	b.st.LastTrustedBarrier = now
	defer func() { b.st.LastTrustedBarrierSentMilli = sentMilli }() // after the segment is applied and flushed
	if len(seg) == 0 {
		return
	}
	events := make([]Event, 0, len(seg))
	for _, m := range seg {
		ev, err := ParseMessage(b.cfg.Realm, m.Channel, m.Payload)
		if err != nil {
			b.quarantineLocked([]segMsg{m}, "malformed message")
			continue
		}
		if ev.Kind == KindUnattributed {
			b.st.UnattributedBytes += int64(ev.Bytes)
		}
		events = append(events, ev)
	}
	if b.tr.ApplyEvents(post, events, now) {
		b.flushLocked()
		select {
		case b.kick <- struct{}{}:
		default:
		}
	}
}

func (b *Bridge) quarantine(seg []segMsg, why string) {
	if len(seg) == 0 {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.quarantineLocked(seg, why)
}

func (b *Bridge) quarantineLocked(seg []segMsg, why string) {
	b.st.QuarantinedSegments++
	b.st.QuarantinedMessages += int64(len(seg))
	b.alert("ALERT quarantined %d messages (%s): not billed", len(seg), why)
	if b.current.Valid() {
		b.tr.NoteGap(b.current)
	}
	rec := struct {
		AtUnix   int64    `json:"atUnix"`
		Reason   string   `json:"reason"`
		Messages []segMsg `json:"messages"`
	}{b.now(), why, seg}
	if err := b.spool.AppendQuarantine(rec, b.cfg.QuarantineMaxBytes); err != nil {
		b.alert("ALERT quarantine evidence not written (%v)", err)
	}
}

// listingLoop takes a complete psd listing every PSDInterval. A listing is
// used only if the epoch read before and after it is the same and is the
// epoch confirmed by the stream's barriers.
func (b *Bridge) listingLoop(ctx context.Context) {
	for sleepCtx(ctx, b.cfg.PSDInterval) {
		b.ListingOnce()
	}
}

// ListingOnce takes and applies one psd listing (exported for the harness).
func (b *Bridge) ListingOnce() {
	pre, preOK := b.readEpoch()
	b.mu.Lock()
	startGen := b.tr.gen
	b.mu.Unlock()
	sessions, err := b.dumpSessions()
	post, postOK := b.readEpoch()
	b.mu.Lock()
	defer b.mu.Unlock()
	if err != nil {
		b.st.LastError = err.Error()
		b.alert("ALERT psd listing unusable (%v): ignored", err)
		return
	}
	if !preOK || !postOK || pre != post || pre != b.current {
		b.logf("coturn bridge: psd listing discarded: epoch not stable or not yet confirmed (%v %v current %v)", pre, post, b.current)
		return
	}
	b.tr.ApplyListing(pre, sessions, startGen, b.now(), b.cfg.MissingListings)
	b.st.LastListing = b.now()
}

func (b *Bridge) dumpSessions() ([]PSDSession, error) {
	cli, err := DialCLI(b.cfg.CLIAddr, b.cfg.CLIPassword, 10*time.Second)
	if err != nil {
		return nil, err
	}
	defer cli.Close()
	return cli.DumpSessions(b.cfg.PSDPath, b.cfg.PSDMaxBytes)
}

func (b *Bridge) flushLoop(ctx context.Context) {
	for sleepCtx(ctx, b.cfg.FlushInterval) {
		b.flush()
	}
}

func (b *Bridge) flush() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.flushLocked()
}

// flushLocked seals new snapshots and persists every record whose durable
// copy is behind, including allocations held before their first snapshot.
// A record that cannot be persisted stays in memory, alerted and retried on
// the next flush; its snapshot is not delivered until it is on disk
// (Alloc.Sendable). Settled inferred ends past their upgrade window retire.
func (b *Bridge) flushLocked() {
	now := b.now()
	sealed, held := b.tr.Flush(now)
	for _, a := range sealed {
		b.unpersisted[a.Key] = true
	}
	for _, a := range held {
		b.unpersisted[a.Key] = true
	}
	for _, k := range b.tr.Retire(now) {
		if err := b.spool.Remove(k); err != nil {
			b.alert("ALERT spool remove for %s failed (%v): kept", k, err)
			continue
		}
		b.tr.Forget(k, now)
		delete(b.unpersisted, k)
		delete(b.retryAfter, k)
	}
	for k, at := range b.finals {
		if now-at > forgetSecs {
			delete(b.finals, k)
		}
	}
	for k, at := range b.gone {
		if now-at > forgetSecs {
			if err := b.spool.PruneGone(k); err != nil {
				b.alert("ALERT gone mark for %s not pruned (%v)", k, err)
				continue
			}
			delete(b.gone, k)
		}
	}
	for k := range b.unpersisted {
		a, ok := b.tr.Allocs[k]
		if !ok {
			delete(b.unpersisted, k)
			continue
		}
		if err := b.spool.Put(a); err != nil {
			b.st.LastError = err.Error()
			b.alert("ALERT spool write for %s failed (%v): kept in memory, not delivered until written, retrying", k, err)
			continue
		}
		a.MarkPersisted()
		delete(b.unpersisted, k)
	}
	b.writeStatusLocked()
}

func (b *Bridge) writeStatusLocked() {
	b.st.UpdatedUnix = b.now()
	b.st.Allocations = len(b.tr.Allocs)
	b.st.Unpersisted = len(b.unpersisted)
	n := 0
	for _, a := range b.tr.Allocs {
		if a.Snap != nil && !a.Settled() {
			n++
		}
	}
	b.st.Unsettled = n
	b.st.Held = b.tr.Held()
	b.st.RecentFinals = make([]string, 0, len(b.finals)) // fresh: Status copies share it
	for k := range b.finals {
		b.st.RecentFinals = append(b.st.RecentFinals, k)
	}
	sort.Strings(b.st.RecentFinals)
	if raw, err := json.Marshal(b.st); err == nil {
		writeAtomic(b.cfg.SpoolDir, filepath.Join(b.cfg.SpoolDir, "status.json"), raw)
	}
}

// Status returns a copy of the current status.
func (b *Bridge) Status() Status {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.st
}

func (b *Bridge) reportLoop(ctx context.Context) {
	backoff := b.cfg.ReportInterval
	t := time.NewTimer(b.cfg.ReportInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-b.kick:
		}
		sent, err := b.ReportOnce(ctx)
		switch {
		case err != nil:
			backoff = min(backoff*2, 60*time.Second)
		case sent == b.cfg.BatchSize:
			backoff = 0 // more pending: next page at once
		default:
			backoff = b.cfg.ReportInterval
		}
		if !t.Stop() {
			select {
			case <-t.C:
			default:
			}
		}
		t.Reset(max(backoff, 10*time.Millisecond))
	}
}

// ReportOnce delivers one fair page of unsettled snapshots (oldest delivery
// attempt first) and applies the ACKs. It returns how many were sent.
func (b *Bridge) ReportOnce(ctx context.Context) (int, error) {
	b.mu.Lock()
	now := b.now()
	var cand []*Alloc
	for k, a := range b.tr.Allocs {
		if !a.Sendable() || a.Settled() || b.retryAfter[k] > now {
			continue
		}
		cand = append(cand, a)
	}
	sort.Slice(cand, func(i, j int) bool {
		if cand[i].LastSentUnix != cand[j].LastSentUnix {
			return cand[i].LastSentUnix < cand[j].LastSentUnix
		}
		return cand[i].Key.String() < cand[j].Key.String()
	})
	if len(cand) > b.cfg.BatchSize {
		cand = cand[:b.cfg.BatchSize]
	}
	snaps := make([]wire.Snapshot, len(cand))
	for i, a := range cand {
		snaps[i] = *a.Snap
		a.LastSentUnix = now
	}
	b.mu.Unlock()
	if len(snaps) == 0 {
		return 0, nil
	}

	acks, err := b.reporter.Send(ctx, snaps)

	b.mu.Lock()
	defer b.mu.Unlock()
	if err != nil {
		if b.st.ReportFailingSince == 0 {
			b.st.ReportFailingSince = now
		}
		b.st.LastError = err.Error()
		b.alert("ALERT delivery of %d snapshots failed (%v): retained, retrying (failing since %d)", len(snaps), err, b.st.ReportFailingSince)
		return 0, err
	}
	b.st.ReportFailingSince = 0
	b.st.LastReportOK = b.now()
	for i, ack := range acks {
		key := cand[i].Key
		a, ok := b.tr.Allocs[key]
		if !ok || a != cand[i] {
			continue
		}
		done, dead := b.tr.ApplyAck(a, ack)
		switch {
		case dead:
			if err := b.spool.DeadLetter(a, ack.Status+": "+ack.Reason); err != nil {
				b.alert("ALERT dead-letter for %s failed (%v): kept", key, err)
				continue
			}
			b.st.DeadLettered++
			b.tr.Forget(key, b.now())
			delete(b.unpersisted, key)
			delete(b.retryAfter, key)
		case done && a.AckStatus == wire.AckGone:
			// Owner deleted: keep only an identity mark (provider key + time)
			// for drain readiness and as a restart-proof tombstone.
			if err := b.spool.MarkGone(key, b.now()); err != nil {
				b.alert("ALERT gone mark for %s failed (%v): record kept", key, err)
				b.unpersisted[key] = true
				continue
			}
			b.gone[key] = b.now()
			b.tr.Forget(key, b.now())
			delete(b.unpersisted, key)
			delete(b.retryAfter, key)
		case done:
			if err := b.spool.Remove(key); err != nil {
				b.alert("ALERT spool remove for %s failed (%v): kept", key, err)
				b.unpersisted[key] = true
				continue
			}
			b.st.Delivered++
			if a.Snap.State == wire.StateFinal {
				b.finals[key.String()] = b.now()
			}
			b.tr.Forget(key, b.now())
			delete(b.unpersisted, key)
			delete(b.retryAfter, key)
		default:
			if ack.Status == wire.AckRetry || ack.Clamp == wire.ClampRate {
				b.retryAfter[key] = b.now() + int64(b.cfg.ClampRetry/time.Second)
			}
			b.unpersisted[key] = true // persist the ACK state
		}
	}
	return len(snaps), nil
}

// LiveIn reports how many allocations of the confirmed epoch are still live
// (used by drain and tests).
func (b *Bridge) LiveIn() (Epoch, int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.current, b.tr.Live(b.current)
}

// Snapshot returns a deep copy of every tracked allocation (tests/evidence).
func (b *Bridge) Snapshot() []Alloc {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]Alloc, 0, len(b.tr.Allocs))
	for _, a := range b.tr.Allocs {
		c := *a
		if a.Snap != nil {
			s := *a.Snap
			c.Snap = &s
		}
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key.String() < out[j].Key.String() })
	return out
}
