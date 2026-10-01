// Command relayium-coturn-bridge meters a coturn relay for Relayium (F02).
//
// It runs on the coturn host, subscribes to coturn's Redis accounting
// (redis-statsdb), polls coturn's loopback CLI (psd), keeps a durable spool of
// immutable cumulative snapshots per allocation, and delivers them to
// central's dedicated coturn metering ingest with a metering-only token.
//
//	relayium-coturn-bridge run   [flags]   # the daemon
//	relayium-coturn-bridge drain [flags]   # before a planned coturn stop
//
// Secrets are read from files (-token-file, -cli-password-file,
// -redis-password-file), never from argv. See
// artifacts/latency-optimization-release-20261001/coturn for the provider
// facts, bounded-loss statement and the ops contract.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/relayium/relayium/internal/coturnbridge"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
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
	if err := fs.Parse(args); err != nil {
		return err
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
		return fmt.Errorf("unknown command %q (want run or drain)", cmd)
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
	b, err := coturnbridge.New(coturnbridge.Config{
		RelayID: *relayID, Realm: *realm,
		RedisAddr: *redisAddr, RedisUser: *redisUser, RedisPassword: redisPass,
		CLIAddr: *cliAddr, CLIPassword: cliPass, PSDPath: *psdPath,
		SpoolDir: *spoolDir, CentralURL: *central, Token: token, Epoch: epoch,
		BarrierInterval: *barrierEvery, PSDInterval: *psdEvery, ReportInterval: *reportEvery,
		Logf: log.Printf,
	})
	if err != nil {
		return err
	}
	if err := b.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	return nil
}
