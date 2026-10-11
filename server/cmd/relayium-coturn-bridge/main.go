// Command relayium-coturn-bridge meters a coturn relay for Relayium (F02).
//
// It runs on the coturn host, subscribes to coturn's Redis accounting
// (redis-statsdb), polls coturn's loopback CLI (psd), keeps a durable spool of
// immutable cumulative snapshots per allocation, and delivers them to
// central's dedicated coturn metering ingest with a metering-only token.
//
//	relayium-coturn-bridge run         [flags]   # the daemon
//	relayium-coturn-bridge drain       [flags]   # before a planned coturn stop
//	relayium-coturn-bridge limits      [flags]   # effective finite-holding limits (JSON)
//	relayium-coturn-bridge spool-check [flags]   # read-only spool inventory (JSON); exit 3: downgrade blockers
//
// Finite holding: the spool holds at most -spool-max-entries primary and
// -spool-overflow-max-entries overflow allocation records; past both, new
// allocations are refused (counted, quarantined as evidence, alerted, and a
// closure of coturn relay admission is requested in status.json — this
// binary does not toggle coturn admission itself). See `limits`.
//
// Secrets are read from files (-token-file, -cli-password-file,
// -redis-password-file), never from argv. See
// artifacts/latency-optimization-release-20261001/coturn for the provider
// facts, bounded-loss statement and the ops contract.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"runtime/debug"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/relayium/relayium/internal/coturnbridge"
)

// exitError carries a specific exit status (spool-check: 3).
type exitError struct {
	code int
	msg  string
}

func (e *exitError) Error() string { return e.msg }

var stdout io.Writer = os.Stdout

func main() {
	if err := run(os.Args[1:]); err != nil {
		var ee *exitError
		if errors.As(err, &ee) {
			if ee.msg != "" {
				log.Printf("relayium-coturn-bridge: %s", ee.msg)
			}
			os.Exit(ee.code)
		}
		log.Printf("relayium-coturn-bridge: %v", err)
		os.Exit(1)
	}
}

func readSecret(path string) (string, error) {
	if path == "" {
		return "", nil
	}
	fi, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if fi.Mode().Perm()&0o077 != 0 {
		return "", fmt.Errorf("%s is readable by group/other (%v): chmod 600", path, fi.Mode().Perm())
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	s := strings.TrimSpace(string(b))
	if s == "" {
		return "", fmt.Errorf("%s is empty", path)
	}
	return s, nil
}

func env(k, def string) string {
	if v, ok := os.LookupEnv(k); ok {
		return v
	}
	return def
}

// intFlags collects integer flags whose defaults may come from the
// environment; a malformed environment value is an error, never ignored.
type intFlags struct {
	fs   *flag.FlagSet
	errs []string
}

func (f *intFlags) int64(name, key string, def int64, usage string) *int64 {
	if v, ok := os.LookupEnv(key); ok {
		n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
		if err != nil {
			f.errs = append(f.errs, fmt.Sprintf("%s=%q is not an integer", key, v))
		} else {
			def = n
		}
	}
	return f.fs.Int64(name, def, usage+" (env "+key+")")
}

func run(args []string) error {
	cmd := "run"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	fs := flag.NewFlagSet("relayium-coturn-bridge "+cmd, flag.ContinueOnError)
	relayID := fs.String("relay-id", env("RELAYIUM_COTURN_RELAY_ID", ""), "metering identity central knows this relay by")
	realm := fs.String("realm", env("RELAYIUM_COTURN_REALM", "relayium.com"), "coturn realm (exact)")
	redisAddr := fs.String("redis-addr", env("RELAYIUM_COTURN_REDIS_ADDR", "127.0.0.1:6379"), "coturn redis-statsdb address (loopback)")
	redisUser := fs.String("redis-user", env("RELAYIUM_COTURN_REDIS_USER", ""), "Redis ACL user (optional)")
	redisPassFile := fs.String("redis-password-file", env("RELAYIUM_COTURN_REDIS_PASSWORD_FILE", ""), "file holding the Redis password (optional)")
	cliAddr := fs.String("cli-addr", env("RELAYIUM_COTURN_CLI_ADDR", "127.0.0.1:5766"), "coturn CLI address (loopback)")
	cliPassFile := fs.String("cli-password-file", env("RELAYIUM_COTURN_CLI_PASSWORD_FILE", ""), "file holding coturn's cli-password")
	psdPath := fs.String("psd-path", env("RELAYIUM_COTURN_PSD_PATH", "/run/relayium-coturn/psd.txt"), "file coturn's psd writes (private directory)")
	spoolDir := fs.String("spool-dir", env("RELAYIUM_COTURN_SPOOL_DIR", "/var/lib/relayium-coturn-bridge"), "durable spool directory")
	central := fs.String("central-url", env("RELAYIUM_COTURN_CENTRAL_URL", "https://relayium.com"), "central base URL")
	tokenFile := fs.String("token-file", env("RELAYIUM_COTURN_TOKEN_FILE", ""), "file holding this relay's metering token")
	pidFile := fs.String("coturn-pidfile", env("RELAYIUM_COTURN_PIDFILE", ""), "coturn pidfile (preferred)")
	unit := fs.String("coturn-unit", env("RELAYIUM_COTURN_UNIT", "coturn"), "systemd unit, when no pidfile is set")
	psdEvery := fs.Duration("psd-interval", 30*time.Second, "psd listing interval (0 disables)")
	reportEvery := fs.Duration("report-interval", 10*time.Second, "delivery interval")
	barrierEvery := fs.Duration("barrier-interval", time.Second, "epoch barrier interval")
	drainTimeout := fs.Duration("drain-timeout", 2*time.Minute, "drain: give up after")
	admission := fs.String("admission-control", env("RELAYIUM_COTURN_ADMISSION_CONTROL", "signal"),
		"off or signal: signal requests closure of coturn relay admission in status.json and alerts while the spool is not ok; this binary never toggles coturn admission")

	ints := &intFlags{fs: fs}
	maxEntries := ints.int64("spool-max-entries", "RELAYIUM_COTURN_SPOOL_MAX_ENTRIES", 100000, "primary allocation records")
	overflow := ints.int64("spool-overflow-max-entries", "RELAYIUM_COTURN_SPOOL_OVERFLOW_MAX_ENTRIES", 2048, "overflow allocation records past the primary (0: no overflow tier)")
	recordMax := ints.int64("spool-max-record-bytes", "RELAYIUM_COTURN_SPOOL_MAX_RECORD_BYTES", 64<<10, "largest allocation record accepted")
	atRiskMax := ints.int64("spool-at-risk-max", "RELAYIUM_COTURN_SPOOL_AT_RISK_MAX", 1024, "new allocations not yet durable after write errors before further new ones are refused")
	deadMax := ints.int64("spool-dead-max-entries", "RELAYIUM_COTURN_SPOOL_DEAD_MAX_ENTRIES", 10000, "dead letters kept (full: refused records stay live)")
	corruptMax := ints.int64("spool-corrupt-max-entries", "RELAYIUM_COTURN_SPOOL_CORRUPT_MAX_ENTRIES", 1000, "unreadable files archived in corrupt/")
	corruptBytes := ints.int64("spool-corrupt-max-bytes", "RELAYIUM_COTURN_SPOOL_CORRUPT_MAX_BYTES", 64<<20, "bytes archived in corrupt/")
	goneMax := ints.int64("spool-gone-max-entries", "RELAYIUM_COTURN_SPOOL_GONE_MAX_ENTRIES", 0, "gone marks (0: primary + overflow)")
	quarMax := ints.int64("quarantine-max-bytes", "RELAYIUM_COTURN_QUARANTINE_MAX_BYTES", 256<<20, "quarantine.jsonl bytes (exact cap)")
	tombMax := ints.int64("tombstones-max", "RELAYIUM_COTURN_TOMBSTONES_MAX", 0, "delivered and refused key histories, each (0: primary + overflow)")
	finalsMax := ints.int64("recent-finals-max", "RELAYIUM_COTURN_RECENT_FINALS_MAX", 20000, "recent finals listed in status.json for drain")
	segMsgs := ints.int64("segment-max-messages", "RELAYIUM_COTURN_SEGMENT_MAX_MESSAGES", 200000, "messages buffered per barrier segment")
	segBytes := ints.int64("segment-max-bytes", "RELAYIUM_COTURN_SEGMENT_MAX_BYTES", 64<<20, "channel+payload bytes buffered per barrier segment")
	psdMax := ints.int64("psd-max-bytes", "RELAYIUM_COTURN_PSD_MAX_BYTES", 64<<20, "largest psd listing read")
	pressure := ints.int64("spool-pressure-percent", "RELAYIUM_COTURN_SPOOL_PRESSURE_PERCENT", 90, "primary use (percent) that signals pressure")
	memLimit := ints.int64("memory-limit-bytes", "RELAYIUM_COTURN_MEMORY_LIMIT_BYTES", 192<<20,
		"Go runtime soft memory target (GC aim, NOT an RSS guarantee; 0 leaves the runtime default)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if len(ints.errs) > 0 {
		return errors.New(strings.Join(ints.errs, "; "))
	}
	for _, c := range []struct {
		name string
		v    int64
		min  int64
	}{
		{"spool-max-entries", *maxEntries, 1}, {"spool-overflow-max-entries", *overflow, 0}, {"spool-max-record-bytes", *recordMax, 4096},
		{"spool-at-risk-max", *atRiskMax, 1}, {"spool-dead-max-entries", *deadMax, 1}, {"spool-corrupt-max-entries", *corruptMax, 1},
		{"spool-corrupt-max-bytes", *corruptBytes, 1}, {"spool-gone-max-entries", *goneMax, 0}, {"quarantine-max-bytes", *quarMax, 1},
		{"tombstones-max", *tombMax, 0}, {"recent-finals-max", *finalsMax, 1}, {"segment-max-messages", *segMsgs, 1},
		{"segment-max-bytes", *segBytes, 1}, {"psd-max-bytes", *psdMax, 1}, {"spool-pressure-percent", *pressure, 1}, {"memory-limit-bytes", *memLimit, 0},
	} {
		if c.v < c.min || c.v > 1<<40 {
			return fmt.Errorf("-%s %d out of range (minimum %d)", c.name, c.v, c.min)
		}
	}
	if *pressure > 100 {
		return fmt.Errorf("-spool-pressure-percent %d out of range (1..100)", *pressure)
	}
	switch *admission {
	case "off", "signal":
	case "enforce":
		return errors.New("-admission-control enforce is not implemented: use signal and the ops admission procedure")
	default:
		return fmt.Errorf("-admission-control %q: want off or signal", *admission)
	}
	ovf := int(*overflow)
	if ovf == 0 {
		ovf = -1 // Config: negative = no overflow tier
	}
	limits := coturnbridge.Config{
		SpoolMaxEntries: int(*maxEntries), SpoolMaxBytes: *recordMax, SpoolOverflowMaxEntries: ovf,
		SpoolAtRiskMax: int(*atRiskMax), SpoolDeadMaxEntries: int(*deadMax), SpoolCorruptMaxEntries: int(*corruptMax),
		SpoolCorruptMaxBytes: *corruptBytes, SpoolGoneMaxEntries: int(*goneMax), QuarantineMaxBytes: *quarMax,
		TombstonesMax: int(*tombMax), RecentFinalsMax: int(*finalsMax), SegmentMaxMessages: int(*segMsgs),
		SegmentMaxBytes: *segBytes, PSDMaxBytes: *psdMax, PressurePercent: int(*pressure),
		AdmissionControl: *admission,
	}

	switch cmd {
	case "spool-check":
		r, err := coturnbridge.CheckSpool(*spoolDir)
		if err != nil {
			return err
		}
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(r); err != nil {
			return err
		}
		if len(r.Blockers) > 0 {
			return &exitError{code: 3, msg: "downgrade blockers present: " + strings.Join(r.Blockers, "; ")}
		}
		return nil
	case "limits":
		cfg := limits
		cfg.RelayID, cfg.Realm, cfg.SpoolDir, cfg.RedisAddr, cfg.CentralURL, cfg.Token = "limits", *realm, *spoolDir, "-", "-", "-"
		cfg.Epoch = &coturnbridge.ProcessEpochSource{PIDFile: "-"}
		cfg.PSDInterval = -1
		l, err := coturnbridge.EffectiveLimits(cfg)
		if err != nil {
			return err
		}
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(struct {
			coturnbridge.Limits
			AdmissionControl string `json:"admissionControl"`
			MemoryLimitBytes int64  `json:"memoryLimitBytes"`
		}{l, *admission, *memLimit})
	}

	epoch := &coturnbridge.ProcessEpochSource{PIDFile: *pidFile}
	if *pidFile == "" {
		epoch.SystemdUnit = *unit
	}
	cliPass, err := readSecret(*cliPassFile)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	switch cmd {
	case "drain":
		// Its own dump file: the running daemon removes and rewrites psd-path.
		return coturnbridge.Drain(ctx, coturnbridge.DrainConfig{
			CLIAddr: *cliAddr, CLIPassword: cliPass, PSDPath: *psdPath + ".drain",
			SpoolDir: *spoolDir, Epoch: epoch, Timeout: *drainTimeout, Logf: log.Printf,
		})
	case "run":
	default:
		return fmt.Errorf("unknown command %q (want run, drain, limits or spool-check)", cmd)
	}
	token, err := readSecret(*tokenFile)
	if err != nil {
		return err
	}
	if token == "" {
		return errors.New("-token-file is required")
	}
	redisPass, err := readSecret(*redisPassFile)
	if err != nil {
		return err
	}
	if *memLimit > 0 {
		debug.SetMemoryLimit(*memLimit)
	}
	cfg := limits
	cfg.RelayID, cfg.Realm = *relayID, *realm
	cfg.RedisAddr, cfg.RedisUser, cfg.RedisPassword = *redisAddr, *redisUser, redisPass
	cfg.CLIAddr, cfg.CLIPassword, cfg.PSDPath = *cliAddr, cliPass, *psdPath
	cfg.SpoolDir, cfg.CentralURL, cfg.Token, cfg.Epoch = *spoolDir, *central, token, epoch
	cfg.BarrierInterval, cfg.PSDInterval, cfg.ReportInterval = *barrierEvery, *psdEvery, *reportEvery
	cfg.Logf = log.Printf
	b, err := coturnbridge.New(cfg)
	if err != nil {
		return err
	}
	runErr := b.Run(ctx)
	// Close owns the lock release and the final (clean or not) status.
	if err := b.Close(); err != nil && runErr == nil {
		runErr = err
	}
	if runErr != nil && !errors.Is(runErr, context.Canceled) {
		return runErr
	}
	return nil
}
