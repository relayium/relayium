package coturnbridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
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

	// Finite holding (see Spool). Zero selects the default; for
	// SpoolOverflowMaxEntries a negative value means no overflow tier.
	SpoolOverflowMaxEntries int   // default 2048 (records past SpoolMaxEntries)
	SpoolAtRiskMax          int   // default 1024 new keys not yet durable after write errors
	SpoolDeadMaxEntries     int   // default 10000
	SpoolCorruptMaxEntries  int   // default 1000
	SpoolCorruptMaxBytes    int64 // default 64 MiB
	SpoolGoneMaxEntries     int   // default SpoolMaxEntries + overflow
	TombstonesMax           int   // default SpoolMaxEntries + overflow (delivered and refused keys, each)
	RecentFinalsMax         int   // default 20000
	SegmentMaxBytes         int64 // default 64 MiB (channel + payload bytes buffered per barrier segment)
	PressurePercent         int   // default 90 (primary use at which pressure is signalled)
	// AdmissionControl: "signal" (default) requests closure of coturn relay
	// admission in the status and the log while the spool is not ok; "off"
	// does not. Neither toggles coturn admission. State, counters and risks
	// are reported the same in both.
	AdmissionControl string

	Now  func() time.Time
	Logf func(format string, args ...any)

	// fs replaces the spool's filesystem writes (tests inject faults).
	fs spoolFS
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
	switch {
	case c.SpoolOverflowMaxEntries == 0:
		c.SpoolOverflowMaxEntries = 2048
	case c.SpoolOverflowMaxEntries < 0:
		c.SpoolOverflowMaxEntries = 0
	}
	if c.SpoolAtRiskMax <= 0 {
		c.SpoolAtRiskMax = 1024
	}
	if c.SpoolDeadMaxEntries <= 0 {
		c.SpoolDeadMaxEntries = defaultDeadMax
	}
	if c.SpoolCorruptMaxEntries <= 0 {
		c.SpoolCorruptMaxEntries = defaultCorruptMax
	}
	if c.SpoolCorruptMaxBytes <= 0 {
		c.SpoolCorruptMaxBytes = defaultCorruptMaxBytes
	}
	if c.SpoolGoneMaxEntries <= 0 {
		c.SpoolGoneMaxEntries = c.SpoolMaxEntries + c.SpoolOverflowMaxEntries
	}
	if c.TombstonesMax <= 0 {
		c.TombstonesMax = c.SpoolMaxEntries + c.SpoolOverflowMaxEntries
	}
	if c.RecentFinalsMax <= 0 {
		c.RecentFinalsMax = 20000
	}
	if c.SegmentMaxBytes <= 0 {
		c.SegmentMaxBytes = 64 << 20
	}
	if c.PressurePercent <= 0 || c.PressurePercent > 100 {
		c.PressurePercent = 90
	}
	switch c.AdmissionControl {
	case "":
		c.AdmissionControl = "signal"
	case "signal", "off":
	default:
		return fmt.Errorf("coturnbridge: admission control %q: want signal or off (enforce is not implemented)", c.AdmissionControl)
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

	// Finite holding. All fields below are additive to the original status.
	//
	// SpoolState is "ok", "pressure" (see AdmissionReason) or "full" (neither
	// tier can take a new allocation: new evidence is being refused).
	SpoolState string `json:"spoolState"`
	// AdmissionControl is the configured mode; with "off" AdmissionRequested
	// stays false (AdmissionReason still names why the spool is not ok).
	AdmissionControl   string   `json:"admissionControl"`
	AdmissionRequested bool     `json:"admissionRequested"`
	AdmissionReason    string   `json:"admissionReason,omitempty"`
	Limits             Limits   `json:"limits"`
	Primary            TierUse  `json:"primary"`
	Overflow           TierUse  `json:"overflow"`
	Dead               ClassUse `json:"dead"`
	Corrupt            ClassUse `json:"corrupt"`
	Gone               ClassUse `json:"gone"`
	QuarantineBytes    int64    `json:"quarantineBytes"`
	// AtRisk: allocations whose latest state is in memory only because a
	// spool write failed (not sendable; lost if the process dies now).
	AtRisk int `json:"atRisk"`
	// DeadHeld: refused by central but dead/ is full; kept live, not resent.
	DeadHeld        int `json:"deadHeld"`
	DuplicateKeys   int `json:"duplicateKeys"`
	UnloadedRecords int `json:"unloadedRecords"`
	TmpRemoved      int `json:"tmpRemoved"`
	TmpPreserved    int `json:"tmpPreserved"`
	MetaTmpRemoved  int `json:"metaTmpRemoved"`
	// TempsHeld: non-empty temp files of earlier runs left in place (possibly
	// unique evidence); TempsStuck: this run's temp files that could not be
	// removed. Either at its limit (stuck > 0, held ≥ tempsHoldMax) makes
	// every new write fail closed — this status itself may then be stale.
	TempsHeld  int `json:"tempsHeld"`
	TempsStuck int `json:"tempsStuck"`
	// Refusal counters, carried across restarts. RefusedEventBytes sums the
	// byte fields of refused stream events (deltas and finals alike): an
	// event sum, not a cumulative. RefusedListingSessions counts listing
	// occurrences, not distinct allocations.
	RefusedNewKeys            int64  `json:"refusedNewKeys"`
	RefusedEvents             int64  `json:"refusedEvents"`
	RefusedEventBytes         uint64 `json:"refusedEventBytes"`
	RefusedListingSessions    int64  `json:"refusedListingSessions"`
	QuarantineRefusedMessages int64  `json:"quarantineRefusedMessages"`
	// PossiblyLostAtRisk: allocations whose state was not durable when an
	// earlier run ended (its last status said so and the run did not end
	// clean). An upper bound on lost allocations; identities are not known.
	PossiblyLostAtRisk    int64 `json:"possiblyLostAtRisk"`
	TombstonesEvicted     int64 `json:"tombstonesEvicted"`
	RecentFinalsTruncated bool  `json:"recentFinalsTruncated"`
	StatusWriteFailures   int64 `json:"statusWriteFailures"`
	// CleanShutdown is true only in the last status of a run that stopped
	// with nothing unpersisted or at risk; every running status says false.
	CleanShutdown bool `json:"cleanShutdown"`
	// DowngradeBlockers: reasons an older bridge binary must not be
	// installed on this spool (it ignores overflow/ and these counters).
	DowngradeBlockers []string `json:"downgradeBlockers,omitempty"`
}

// Limits are the effective finite-holding limits.
type Limits struct {
	PrimaryEntries     int   `json:"primaryEntries"`
	OverflowEntries    int   `json:"overflowEntries"`
	RecordMaxBytes     int64 `json:"recordMaxBytes"`
	AtRiskMax          int   `json:"atRiskMax"`
	DeadEntries        int   `json:"deadEntries"`
	CorruptEntries     int   `json:"corruptEntries"`
	CorruptMaxBytes    int64 `json:"corruptMaxBytes"`
	GoneEntries        int   `json:"goneEntries"`
	QuarantineMaxBytes int64 `json:"quarantineMaxBytes"`
	TombstonesMax      int   `json:"tombstonesMax"`
	RecentFinalsMax    int   `json:"recentFinalsMax"`
	SegmentMaxMessages int   `json:"segmentMaxMessages"`
	SegmentMaxBytes    int64 `json:"segmentMaxBytes"`
	PSDMaxBytes        int64 `json:"psdMaxBytes"`
	PressurePercent    int   `json:"pressurePercent"`
	// TempsHoldMax: earlier-run temp files held in place before new temp
	// creation (every write) is refused.
	TempsHoldMax int `json:"tempsHoldMax"`
	// WrittenMaxBytes bounds the file content written by this bridge binary
	// under its spool directory with every class at its cap:
	//   records      (primary+overflow) × RecordMaxBytes
	//   dead/        dead × (RecordMaxBytes + 6×1024 reason bytes as JSON-escaped + 64)
	//   corrupt/     CorruptMaxBytes (links to files found in place count here too)
	//   gone/        gone × 4096
	//   quarantine   QuarantineMaxBytes
	//   status.json  64 KiB + recentFinals × 128
	//   temps        (TempsHoldMax earlier-run held + 1 this-run stuck + 1 in flight)
	//                × the largest of a record, a dead letter, status, a gone mark
	// It is NOT a disk bound: it excludes files found in place that this
	// binary did not write (older binaries, operators), directories, the lock
	// file and all filesystem metadata/block rounding; hard links to the same
	// file are counted once per name.
	WrittenMaxBytes int64 `json:"writtenMaxBytes"`
}

// goneMarkMaxBytes bounds a gone mark (LoadGone refuses larger ones).
const goneMarkMaxBytes = 4096

// statusFixedMaxBytes bounds status.json apart from its recent finals.
const statusFixedMaxBytes = 64 << 10

// recentFinalMaxBytes bounds one recent-final entry in status.json: the
// allocation key (boot id ≤ 64, pid, start ticks ≤ 20 digits, session 18)
// quoted with a comma.
const recentFinalMaxBytes = 64 + 1 + 20 + 1 + 20 + 1 + 18 + 3

// LimitsOf returns the effective limits of cfg (after defaults).
func LimitsOf(cfg Config) Limits {
	return Limits{
		PrimaryEntries: cfg.SpoolMaxEntries, OverflowEntries: cfg.SpoolOverflowMaxEntries, RecordMaxBytes: cfg.SpoolMaxBytes,
		AtRiskMax: cfg.SpoolAtRiskMax, DeadEntries: cfg.SpoolDeadMaxEntries, CorruptEntries: cfg.SpoolCorruptMaxEntries,
		CorruptMaxBytes: cfg.SpoolCorruptMaxBytes, GoneEntries: cfg.SpoolGoneMaxEntries, QuarantineMaxBytes: cfg.QuarantineMaxBytes,
		TombstonesMax: cfg.TombstonesMax, RecentFinalsMax: cfg.RecentFinalsMax, SegmentMaxMessages: cfg.SegmentMaxMessages,
		SegmentMaxBytes: cfg.SegmentMaxBytes, PSDMaxBytes: cfg.PSDMaxBytes, PressurePercent: cfg.PressurePercent,
		TempsHoldMax:    tempHoldMax,
		WrittenMaxBytes: writtenMaxBytes(cfg),
	}
}

// deadLetterMaxBytes bounds one dead letter: the record plus a reason of at
// most deadReasonMax raw bytes, each JSON-encoded as at most 6 bytes.
func deadLetterMaxBytes(recordMax int64) int64 {
	return recordMax + 6*deadReasonMax + deadLetterOverhead
}

func statusMaxBytes(cfg Config) int64 {
	return statusFixedMaxBytes + int64(cfg.RecentFinalsMax)*recentFinalMaxBytes
}

func writtenMaxBytes(cfg Config) int64 {
	dead := deadLetterMaxBytes(cfg.SpoolMaxBytes)
	status := statusMaxBytes(cfg)
	temp := max(cfg.SpoolMaxBytes, dead, status, goneMarkMaxBytes)
	return int64(cfg.SpoolMaxEntries+cfg.SpoolOverflowMaxEntries)*cfg.SpoolMaxBytes +
		int64(cfg.SpoolDeadMaxEntries)*dead + cfg.SpoolCorruptMaxBytes +
		int64(cfg.SpoolGoneMaxEntries)*goneMarkMaxBytes + cfg.QuarantineMaxBytes +
		status + int64(tempHoldMax+2)*temp
}

// EffectiveLimits applies cfg's defaults and returns its limits (for the
// CLI's limits command). It validates like New.
func EffectiveLimits(cfg Config) (Limits, error) {
	if err := cfg.defaults(); err != nil {
		return Limits{}, err
	}
	return LimitsOf(cfg), nil
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
	finals      *fifoSet[string]   // recently delivered finals (bridge time), bounded
	gone        map[AllocKey]int64 // gone marks on disk (bridge time), ≤ gone/ cap
	// truncatedUntil: recent finals were evicted early; until this time the
	// list is incomplete and drain refuses.
	truncatedUntil int64
	// atRisk: latest state not durable because a spool write failed (value:
	// the key has no record on disk at all). ⊆ tracked allocations.
	atRisk    map[AllocKey]bool
	atRiskNew int
	// deadHeld: refused by central with dead/ full; kept live, not resent.
	deadHeld map[AllocKey]bool
	// refused: keys whose evidence was refused for capacity (bounded).
	refused                                             *fifoSet[AllocKey]
	refusedBuf                                          []refusedEvent
	lastAdmissionAlert, lastStatusAlert, lastStatusFail int64
	// Aggregated refusal alerting (at most one line a minute).
	lastRefusalAlert                  int64
	refusalsPending                   int64
	refusalFirst, refusalLast, refWhy string
	statusErr                         error // last status write error (nil: written)
	// Recent-finals eviction alerting: the first eviction is logged at once,
	// later ones are counted and logged together at most once a minute
	// (also from idle flushes). Fixed-size state.
	finalEvictPending   int64
	finalEvictAlerted   bool
	lastFinalEvictAlert int64
	closed              bool
}

// refusedEvent is quarantine evidence of a stream event the spool could not
// take (never billed).
type refusedEvent struct {
	Key   string `json:"key"`
	Kind  string `json:"kind"`
	Bytes uint64 `json:"bytes"`
}

// New builds a bridge and loads its spool.
func New(cfg Config) (*Bridge, error) {
	if err := cfg.defaults(); err != nil {
		return nil, err
	}
	b := &Bridge{
		cfg: cfg,
		spool: &Spool{Dir: cfg.SpoolDir, MaxEntries: cfg.SpoolMaxEntries, MaxBytes: cfg.SpoolMaxBytes,
			OverflowMaxEntries: cfg.SpoolOverflowMaxEntries, DeadMaxEntries: cfg.SpoolDeadMaxEntries,
			CorruptMaxEntries: cfg.SpoolCorruptMaxEntries, CorruptMaxBytes: cfg.SpoolCorruptMaxBytes,
			GoneMaxEntries: cfg.SpoolGoneMaxEntries, QuarantineMaxBytes: cfg.QuarantineMaxBytes, fs: cfg.fs},
		reporter:    &Reporter{BaseURL: cfg.CentralURL, Token: cfg.Token, RelayID: cfg.RelayID, Client: cfg.HTTPClient},
		unpersisted: map[AllocKey]bool{},
		retryAfter:  map[AllocKey]int64{},
		kick:        make(chan struct{}, 1),
		finals:      newFifoSet[string](cfg.RecentFinalsMax),
		gone:        map[AllocKey]int64{},
		atRisk:      map[AllocKey]bool{},
		deadHeld:    map[AllocKey]bool{},
		refused:     newFifoSet[AllocKey](cfg.TombstonesMax),
	}
	b.st.Limits = LimitsOf(cfg)
	b.tr = NewTracker(cfg.RelayID, b.alert)
	b.tr.forgotten = newFifoSet[AllocKey](cfg.TombstonesMax)
	b.tr.Admit = b.admit
	if cfg.PSDInterval > 0 {
		b.tr.HoldUnknownSecs = int64((2*cfg.PSDInterval + 5*time.Second) / time.Second)
	}
	// The previous status carries refusal and loss counters. It is read only
	// once this process holds the spool lock — so the previous writer has
	// finished and its last status (clean or not) is the one carried — and
	// before anything in the spool is changed. An existing status that
	// cannot be read is refused: starting would silently reset its counters.
	if testBeforeSpoolOpen != nil {
		testBeforeSpoolOpen()
	}
	var prev *Status
	if err := b.spool.open(func() error {
		var err error
		prev, err = readPrevStatus(filepath.Join(cfg.SpoolDir, "status.json"))
		return err
	}); err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			b.spool.Close()
		}
	}()
	b.carryForward(prev)
	loaded, err := b.spool.Load(b.alert)
	if err != nil {
		return nil, err
	}
	for _, k := range b.spool.Duplicates() {
		b.tr.blocked[k] = true
	}
	gone, err := b.spool.LoadGone(b.alert)
	if err != nil {
		return nil, err
	}
	for k, at := range gone {
		b.gone[k] = at
		b.tr.forgotten.Add(k, at)
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
		if a.Done() {
			// Settled terminal record whose removal failed in an earlier run:
			// central holds it (accepted covering it), so it is not unsent
			// evidence. Remove it now instead of holding it forever.
			if err := b.spool.Remove(a.Key); err != nil {
				return nil, err
			}
			b.tr.forgotten.Add(a.Key, b.now())
			b.logf("coturn bridge: removed settled record %s left by an earlier run", a.Key)
			continue
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
	unloaded, tmpGone, tmpKept, metaGone := b.spool.Unloaded()
	b.st.DuplicateKeys, b.st.UnloadedRecords, b.st.TmpRemoved, b.st.TmpPreserved, b.st.MetaTmpRemoved =
		len(b.spool.Duplicates()), unloaded, tmpGone, tmpKept, metaGone
	if tmpKept > 0 {
		b.alert("ALERT %d non-empty temporary record files preserved (moved to corrupt/ or left in place): operator", tmpKept)
	}
	// The first status of this run, before any loop: it records the carried
	// loss counters and clears cleanShutdown, so a later crash is never
	// mistaken for a clean stop and a carried at-risk count is never added
	// twice. If it cannot be written the bridge refuses to start; the
	// previous status stays exactly as it was.
	b.mu.Lock()
	b.writeStatusLocked()
	serr := b.statusErr
	b.mu.Unlock()
	if serr != nil {
		// A failure before the rename leaves the previous status as it was;
		// a failure after it (directory fsync) may already have replaced it
		// with this run's first status, which carries the counters forward
		// (a later start adds nothing twice: it says not at risk).
		return nil, fmt.Errorf("coturnbridge: status.json cannot be written (%v): refusing to start; the previous status is unchanged "+
			"unless the failure came after its replacement was renamed into place (then it already holds this run's carried counters)", serr)
	}
	b.logf("coturn bridge: loaded %d allocations from %s", len(loaded), cfg.SpoolDir)
	ok = true
	return b, nil
}

// testBeforeSpoolOpen, when set (tests only), runs in New just before the
// spool lock is requested: a test can let a previous writer finish there.
var testBeforeSpoolOpen func()

// statusReadMaxBytes bounds the previous status.json read at start (and by
// drain): far above any status this bridge writes (recent finals bounded).
const statusReadMaxBytes = 64 << 20

// readPrevStatus reads the previous run's status. No file (first start, or a
// spool from before status existed) is fine: nil. An existing file that
// cannot be read, is oversized, or is not a bridge status is an error, and
// the file is left as it is.
func readPrevStatus(p string) (*Status, error) {
	fi, err := os.Lstat(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	var raw []byte
	switch {
	case err != nil:
	case !fi.Mode().IsRegular():
		// A FIFO could block the open, a symlink could point outside the
		// private spool: neither is read.
		err = fmt.Errorf("not a regular file (%v)", fi.Mode().Type())
	default:
		raw, err = readBounded(p, statusReadMaxBytes)
	}
	if err == nil {
		var st Status
		if err = json.Unmarshal(raw, &st); err == nil && st.UpdatedUnix <= 0 {
			err = errors.New("no updatedUnix: not a bridge status")
		}
		if err == nil {
			return &st, nil
		}
	}
	return nil, fmt.Errorf("coturnbridge: existing %s cannot be used (%v): refusing to start, because starting would reset the "+
		"refusal and loss counters it may hold; it was left unchanged. Keep a copy, then repair it or move it aside deliberately "+
		"(moving it aside restarts those counters from zero)", p, err)
}

// carryForward applies the previous run's status (nil: none): refusal and
// loss counters survive restarts, and allocations not durable when a run
// ended without a clean shutdown are counted as possibly lost.
func (b *Bridge) carryForward(prev *Status) {
	if prev == nil {
		return
	}
	b.st.RefusedNewKeys, b.st.RefusedEvents, b.st.RefusedEventBytes = prev.RefusedNewKeys, prev.RefusedEvents, prev.RefusedEventBytes
	b.st.RefusedListingSessions, b.st.QuarantineRefusedMessages = prev.RefusedListingSessions, prev.QuarantineRefusedMessages
	b.st.PossiblyLostAtRisk, b.st.TombstonesEvicted = prev.PossiblyLostAtRisk, prev.TombstonesEvicted
	if n := max(prev.AtRisk, prev.Unpersisted); !prev.CleanShutdown && n > 0 {
		b.st.PossiblyLostAtRisk += int64(n)
		b.alert("ALERT previous run ended with %d allocations not durable: possibly lost (upper bound, identities unknown)", n)
	}
}

func readBounded(p string, max int64) ([]byte, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, fmt.Errorf("%s exceeds %d bytes", p, max)
	}
	return b, nil
}

// Close ends the bridge after Run has returned: it records a clean shutdown
// (at-risk allocations still in memory are counted as possibly lost), writes
// the status and releases the spool lock. Idempotent.
func (b *Bridge) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return nil
	}
	b.closed = true
	// Clean only if nothing is held in memory alone. Otherwise the status
	// keeps cleanShutdown false with its at-risk count, and the next start
	// counts them as possibly lost (once).
	b.st.CleanShutdown = len(b.unpersisted) == 0 && len(b.atRisk) == 0
	if !b.st.CleanShutdown {
		b.alert("ALERT stopping with %d allocations not durable (%d at risk): they are lost with this process", len(b.unpersisted), len(b.atRisk))
	}
	b.writeStatusLocked()
	return b.spool.Close()
}

// admit is the tracker's admission hook (called under b.mu): a new key is
// given a spool tier, or refused — counted, alerted and kept as quarantine
// evidence — when neither tier has room or too many new keys already failed
// to persist.
func (b *Bridge) admit(k AllocKey, bytes uint64, kind string) (bool, bool) {
	prior := b.refused.Has(k)
	why := "spool capacity exhausted (primary and overflow full)"
	if b.atRiskNew >= b.cfg.SpoolAtRiskMax {
		why = fmt.Sprintf("%d new allocations already failed to persist", b.atRiskNew)
	} else if _, err := b.spool.Reserve(k); err == nil {
		if prior {
			b.refused.Delete(k)
		}
		return true, prior
	} else if errors.Is(err, ErrKeyBlocked) {
		why = "a record with this key's file name was left in place unloaded (operator)"
	}
	b.refused.Add(k, b.now()) // evictions are counted once, at status time
	if kind == "psd" {
		b.st.RefusedListingSessions++
	} else {
		b.st.RefusedEvents++
		b.st.RefusedEventBytes += bytes
		b.refusedBuf = append(b.refusedBuf, refusedEvent{Key: k.String(), Kind: kind, Bytes: bytes})
	}
	if !prior {
		b.st.RefusedNewKeys++
	}
	b.refusalsPending++
	if b.refusalFirst == "" {
		b.refusalFirst = k.String()
	}
	b.refusalLast, b.refWhy = k.String(), why
	b.refusalAlertLocked()
	return false, false
}

// finalEvictAlertLocked logs the recent finals evicted since the last such
// line, at most once a minute: at once the first time (whatever the clock
// reads, 0 included), then when 60 s have passed since the last line. A clock
// that moved back restarts the 60 s window from the new time instead of
// emitting per eviction.
func (b *Bridge) finalEvictAlertLocked() {
	if b.finalEvictPending == 0 {
		return
	}
	now := b.now()
	if b.finalEvictAlerted {
		if now < b.lastFinalEvictAlert {
			b.lastFinalEvictAlert = now
		}
		if now-b.lastFinalEvictAlert < 60 {
			return
		}
	}
	b.finalEvictAlerted, b.lastFinalEvictAlert = true, now
	b.alert("ALERT %d recent finals dropped from the drain list (cap %d) since the last such alert: drain refuses until %d",
		b.finalEvictPending, b.cfg.RecentFinalsMax, b.truncatedUntil)
	b.finalEvictPending = 0
}

// refusalAlertLocked logs pending refusals as one aggregated line, at most
// once a minute; the counters themselves are always current in the status.
func (b *Bridge) refusalAlertLocked() {
	now := b.now()
	if b.refusalsPending == 0 || now-b.lastRefusalAlert < 60 {
		return
	}
	b.lastRefusalAlert = now
	b.alert("ALERT %d observations of new allocations refused (%s; first %s, last %s): not tracked, not billed; totals: %d keys, %d events, %d event bytes, %d listing sessions",
		b.refusalsPending, b.refWhy, b.refusalFirst, b.refusalLast, b.st.RefusedNewKeys, b.st.RefusedEvents, b.st.RefusedEventBytes, b.st.RefusedListingSessions)
	b.refusalsPending, b.refusalFirst, b.refusalLast = 0, "", ""
}

// flushRefusedLocked writes the refused events of one segment as one
// quarantine line.
func (b *Bridge) flushRefusedLocked() {
	if len(b.refusedBuf) == 0 {
		return
	}
	rec := struct {
		AtUnix int64          `json:"atUnix"`
		Reason string         `json:"reason"`
		Events []refusedEvent `json:"events"`
	}{b.now(), "spool capacity exhausted: not billed", b.refusedBuf}
	if err := b.spool.AppendQuarantine(rec, b.cfg.QuarantineMaxBytes); err != nil {
		b.st.QuarantineRefusedMessages += int64(len(b.refusedBuf))
		b.alert("ALERT refused-event evidence not written (%v)", err)
	}
	b.refusedBuf = nil
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
	var segBytes int64
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
				segBytes += int64(len(pf.Channel) + len(pf.Payload))
				if len(seg) >= b.cfg.SegmentMaxMessages || segBytes > b.cfg.SegmentMaxBytes {
					b.quarantine(seg, "segment overflow")
					return errors.New("segment overflow")
				}
				seg = append(seg, segMsg{Channel: pf.Channel, Payload: pf.Payload, RecvUnix: b.now()})
			}
		}
		post, postOK := b.readEpoch()
		b.closeSegment(seg, prevPre, prevOK, pre, preOK, post, postOK, sentMilli)
		seg, segBytes = nil, 0
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
	finals := b.tr.ApplyEvents(post, events, now)
	b.flushRefusedLocked()
	if finals {
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
		b.st.QuarantineRefusedMessages += int64(len(seg))
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
	b.refusedBuf = nil // listing refusals are counted, not quarantined (repeated each listing)
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
		b.forgetLocked(k, now)
	}
	b.finals.Expire(now, forgetSecs)
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
			b.markAtRiskLocked(k)
			continue
		}
		a.MarkPersisted()
		delete(b.unpersisted, k)
		b.clearAtRiskLocked(k)
	}
	b.writeStatusLocked()
}

// forgetLocked drops every trace of a delivered, dead-lettered or gone key
// from memory and tombstones it.
func (b *Bridge) forgetLocked(k AllocKey, now int64) {
	b.tr.Forget(k, now)
	b.st.TombstonesEvicted += b.tr.forgotten.evicted
	b.tr.forgotten.evicted = 0
	delete(b.unpersisted, k)
	delete(b.retryAfter, k)
	delete(b.deadHeld, k)
	b.clearAtRiskLocked(k)
}

func (b *Bridge) markAtRiskLocked(k AllocKey) {
	if _, ok := b.atRisk[k]; ok {
		return
	}
	_, onDisk, _ := b.spool.TierOf(k)
	b.atRisk[k] = !onDisk
	if !onDisk {
		b.atRiskNew++
	}
}

func (b *Bridge) clearAtRiskLocked(k AllocKey) {
	if isNew, ok := b.atRisk[k]; ok {
		delete(b.atRisk, k)
		if isNew {
			b.atRiskNew--
		}
	}
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
	b.st.RecentFinals = b.finals.Keys() // fresh: Status copies share it
	sort.Strings(b.st.RecentFinals)
	b.st.RecentFinalsTruncated = b.st.UpdatedUnix < b.truncatedUntil
	tiers, dead, corrupt, gone, qb := b.spool.Use()
	b.st.Primary, b.st.Overflow, b.st.Dead, b.st.Corrupt, b.st.Gone, b.st.QuarantineBytes = tiers[TierPrimary], tiers[TierOverflow], dead, corrupt, gone, qb
	b.st.AtRisk, b.st.DeadHeld = len(b.atRisk), len(b.deadHeld)
	b.st.TempsHeld, b.st.TempsStuck = b.spool.Temps()
	b.st.TombstonesEvicted += b.refused.evicted + b.tr.forgotten.evicted
	b.refused.evicted, b.tr.forgotten.evicted = 0, 0
	b.refusalAlertLocked()
	b.finalEvictAlertLocked()
	b.assessLocked()
	if len(b.st.LastError) > 1024 {
		b.st.LastError = b.st.LastError[:1024]
	}
	raw, err := json.Marshal(b.st)
	if err == nil {
		err = b.spool.writeMeta(filepath.Join(b.cfg.SpoolDir, "status.json"), raw)
	}
	b.statusErr = err
	if err != nil {
		b.st.StatusWriteFailures++
		b.lastStatusFail = b.st.UpdatedUnix
		b.st.LastError = "status.json not written: " + err.Error()
		if b.st.UpdatedUnix-b.lastStatusAlert >= 60 {
			b.lastStatusAlert = b.st.UpdatedUnix
			b.alert("ALERT status.json not written (%v): monitoring sees it stale", err)
		}
	}
}

// assessLocked derives the spool state, the admission request and the
// downgrade blockers from the exact use.
func (b *Bridge) assessLocked() {
	st := &b.st
	l := st.Limits
	var why []string
	full := !b.spool.room(TierPrimary) && !b.spool.room(TierOverflow)
	if st.Primary.Keys+st.UnloadedRecords >= (l.PrimaryEntries*l.PressurePercent+99)/100 {
		why = append(why, fmt.Sprintf("primary %d/%d", st.Primary.Keys, l.PrimaryEntries))
	}
	if st.Overflow.Keys > 0 || st.Overflow.Files > 0 {
		why = append(why, fmt.Sprintf("overflow in use %d/%d", st.Overflow.Keys, l.OverflowEntries))
	}
	if st.Dead.Files >= l.DeadEntries {
		why = append(why, "dead/ full")
	}
	if st.Corrupt.Files >= l.CorruptEntries || st.Corrupt.Bytes >= l.CorruptMaxBytes {
		why = append(why, "corrupt/ full")
	}
	if st.Gone.Files >= l.GoneEntries {
		why = append(why, "gone/ full")
	}
	if st.QuarantineBytes*100 >= l.QuarantineMaxBytes*int64(l.PressurePercent) {
		why = append(why, "quarantine near its cap")
	}
	for _, c := range []struct {
		n    int
		what string
	}{{st.AtRisk, "at-risk allocations"}, {st.DeadHeld, "dead letters held live"}, {st.DuplicateKeys, "keys in both tiers"}, {st.UnloadedRecords, "unreadable records left in place"},
		{st.TempsHeld, "earlier-run temporary files held in place"}, {st.TempsStuck, "temporary files that could not be removed (writes fail closed)"}} {
		if c.n > 0 {
			why = append(why, fmt.Sprintf("%d %s", c.n, c.what))
		}
	}
	if b.lastStatusFail > 0 && st.UpdatedUnix-b.lastStatusFail < 60 {
		why = append(why, "status writes failing")
	}
	switch {
	case full:
		st.SpoolState = "full"
		why = append([]string{"no free spool entry: new allocations refused"}, why...)
	case len(why) > 0:
		st.SpoolState = "pressure"
	default:
		st.SpoolState = "ok"
	}
	st.AdmissionControl = b.cfg.AdmissionControl
	st.AdmissionRequested = st.SpoolState != "ok" && b.cfg.AdmissionControl == "signal"
	st.AdmissionReason = strings.Join(why, "; ")
	if st.AdmissionRequested && st.UpdatedUnix-b.lastAdmissionAlert >= 60 {
		b.lastAdmissionAlert = st.UpdatedUnix
		b.alert("ALERT spool %s (%s): closing coturn relay admission is requested (operator; this bridge does not toggle it)", st.SpoolState, st.AdmissionReason)
	}
	var blk []string
	if st.Overflow.Files > 0 {
		blk = append(blk, fmt.Sprintf("overflow/ holds %d records", st.Overflow.Files))
	}
	if st.RefusedNewKeys > 0 || st.RefusedEvents > 0 || st.RefusedListingSessions > 0 || st.QuarantineRefusedMessages > 0 {
		blk = append(blk, "refused evidence counters are not zero")
	}
	if st.PossiblyLostAtRisk > 0 || st.AtRisk > 0 {
		blk = append(blk, "at-risk or possibly lost allocations")
	}
	if st.DuplicateKeys > 0 || st.UnloadedRecords > 0 || st.DeadHeld > 0 || st.TempsHeld > 0 || st.TempsStuck > 0 {
		blk = append(blk, "records awaiting an operator (duplicates, unreadable, dead held, temporary files held)")
	}
	st.DowngradeBlockers = blk
}

// selectOldest returns up to n allocations accepted by ok, ordered by
// (LastSentUnix, key) — exactly the first n of a full sort — using a bounded
// max-heap: O(N log n) instead of O(N log N).
func selectOldest(all map[AllocKey]*Alloc, n int, ok func(AllocKey, *Alloc) bool) []*Alloc {
	less := func(x, y *Alloc) bool {
		if x.LastSentUnix != y.LastSentUnix {
			return x.LastSentUnix < y.LastSentUnix
		}
		return x.keyString() < y.keyString()
	}
	h := make([]*Alloc, 0, n) // max-heap by less: h[0] is the newest kept
	down := func(i int) {
		for {
			l, m := 2*i+1, i
			if l < len(h) && less(h[m], h[l]) {
				m = l
			}
			if r := l + 1; r < len(h) && less(h[m], h[r]) {
				m = r
			}
			if m == i {
				return
			}
			h[i], h[m] = h[m], h[i]
			i = m
		}
	}
	for k, a := range all {
		if !ok(k, a) {
			continue
		}
		switch {
		case len(h) < n:
			h = append(h, a)
			for i := len(h) - 1; i > 0; {
				p := (i - 1) / 2
				if !less(h[p], h[i]) {
					break
				}
				h[p], h[i] = h[i], h[p]
				i = p
			}
		case n > 0 && less(a, h[0]):
			h[0] = a
			down(0)
		}
	}
	sort.Slice(h, func(i, j int) bool { return less(h[i], h[j]) })
	return h
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
	cand := selectOldest(b.tr.Allocs, b.cfg.BatchSize, func(k AllocKey, a *Alloc) bool {
		return a.Sendable() && !a.Settled() && b.retryAfter[k] <= now && !b.deadHeld[k]
	})
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
				if errors.Is(err, ErrArchiveFull) {
					// Preserved live; not resent this run (central would refuse
					// it again). A restart resends it once: refused again,
					// keep-max, nothing billed twice.
					b.deadHeld[key] = true
				}
				b.alert("ALERT dead-letter for %s failed (%v): kept", key, err)
				continue
			}
			b.st.DeadLettered++
			b.forgetLocked(key, b.now())
		case done && a.AckStatus == wire.AckGone:
			// Owner deleted: keep only an identity mark (provider key + time)
			// for drain readiness and as a restart-proof tombstone.
			if err := b.spool.MarkGone(key, b.now()); err != nil {
				b.alert("ALERT gone mark for %s failed (%v): record kept", key, err)
				b.unpersisted[key] = true
				// Do not resend every page while the mark cannot be written.
				b.retryAfter[key] = b.now() + int64(b.cfg.ClampRetry/time.Second)
				continue
			}
			b.gone[key] = b.now()
			b.forgetLocked(key, b.now())
		case done:
			if err := b.spool.Remove(key); err != nil {
				b.alert("ALERT spool remove for %s failed (%v): kept", key, err)
				b.unpersisted[key] = true
				continue
			}
			b.st.Delivered++
			if a.Snap.State == wire.StateFinal {
				if n := b.finals.Add(key.String(), b.now()); n > 0 {
					b.truncatedUntil = b.now() + forgetSecs
					b.finalEvictPending += int64(n)
					b.finalEvictAlertLocked()
				}
			}
			b.forgetLocked(key, b.now())
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
