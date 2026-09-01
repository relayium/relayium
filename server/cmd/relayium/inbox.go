package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/relayium/relayium/internal/cloud"
	"github.com/relayium/relayium/internal/inbox"
	"github.com/relayium/relayium/internal/inboxclient"
	"github.com/relayium/relayium/internal/inboxclient/deploy"
)

// `relayium inbox` — the CLI Device Inbox surface (PRD §7.1).
//
// The six commands split cleanly along one line: `enable` and `disable` change
// what this machine has agreed to, and everything else operates within that
// agreement. That is why `enable` is the only one that takes a directory, and
// why `disable` is the only one that destroys key material.
//
//	run       the resident foreground worker; the process a service supervises
//	enable    the explicit, default-off opt-in: choose a directory, enrol, publish a key
//	disable   clear the enrolment on the server, then destroy local keys
//	status    what is actually true, locally and on the server, without secrets
//	pause     stop receiving, durably, without touching the server or the keys
//	resume    the inverse
//	service   print a ready-to-install systemd/launchd definition for THIS machine
//
// PAUSE IS NOT DISABLE, and the split is deliberate. An operator who wants to
// stop receiving for an afternoon should not have to revoke a key, terminate the
// deliveries already queued for them, and re-enrol afterwards.

const inboxUsage = `relayium inbox — receive files sent to this device

usage:
  relayium inbox enable --dir <folder>   turn on automatic receive into <folder>
  relayium inbox run                     run the receiver in the foreground
  relayium inbox status                  show local, credential and server state
  relayium inbox pause                   stop receiving (keeps the enrolment and keys)
  relayium inbox resume                  start receiving again
  relayium inbox disable                 clear the server inbox, then delete local keys
  relayium inbox service <kind>          print a service definition for this machine
                                         (systemd-user, systemd-system, launchd, container)

flags:
  --config-dir D   credential/state directory (default ~/.config/relayium)
`

func runInbox(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, inboxUsage)
		return 2
	}
	switch args[0] {
	case "run":
		return runInboxRun(args[1:], stdout, stderr)
	case "enable":
		return runInboxEnable(args[1:], stdout, stderr)
	case "disable":
		return runInboxDisable(args[1:], stdout, stderr)
	case "status":
		return runInboxStatus(args[1:], stdout, stderr)
	case "pause":
		return runInboxPauseResume(args[1:], true, stdout, stderr)
	case "resume":
		return runInboxPauseResume(args[1:], false, stdout, stderr)
	case "service":
		return runInboxService(args[1:], stdout, stderr)
	case "-h", "-help", "--help":
		fmt.Fprint(stdout, inboxUsage)
		return 0
	case "help":
		if len(args) > 1 {
			return helpForInbox(args[1:], stdout, stderr)
		}
		fmt.Fprint(stdout, inboxUsage)
		return 0
	default:
		fmt.Fprintf(stderr, "unknown inbox command %q\n\n%s", args[0], inboxUsage)
		return 2
	}
}

// inboxSession is everything a command needs to talk to central as this device.
type inboxSession struct {
	cfgDir string
	store  *inboxclient.Store
	creds  cloud.Creds
	client *inboxclient.Client
	device inboxclient.Device
}

// openInboxSession loads the credential and resolves which device this is.
//
// The device id is asked for rather than remembered: it is minted server-side
// when a login is approved, so a re-login produces a DIFFERENT device, and
// acting on a cached id after that would enrol, heartbeat and claim for a row
// this credential no longer authenticates as. Where a cached id exists it is
// compared, and a mismatch is reported rather than silently followed.
func openInboxSession(ctx context.Context, cfgDir string) (*inboxSession, error) {
	creds, ok, err := cloud.Load(cfgDir)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("not logged in — run `relayium login` first")
	}
	client := inboxclient.NewClient(creds.Server, creds.AccessToken)
	dev, err := client.CurrentDevice(ctx)
	if err != nil {
		return nil, err
	}
	client.DeviceID = dev.ID
	return &inboxSession{
		cfgDir: cfgDir,
		store:  inboxclient.NewStore(inboxclient.StoreDir(cfgDir)),
		creds:  creds, client: client, device: dev,
	}, nil
}

// inboxConfigDirFlag adds the shared --config-dir flag.
func inboxConfigDirFlag(fs *flag.FlagSet, into *string) {
	fs.StringVar(into, "config-dir", "", "credential/state directory (default ~/.config/relayium)")
}

// ---------------------------------------------------------------- enable

func runInboxEnable(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("inbox enable", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var dir, configDir string
	fs.StringVar(&dir, "dir", "", "directory to receive files into (required)")
	inboxConfigDirFlag(fs, &configDir)
	if wantsHelpFS(fs, args) {
		fmt.Fprint(stdout, inboxEnableUsage)
		return 0
	}
	if err := parseArgs(fs, args); err != nil {
		return 2
	}
	if dir == "" {
		fmt.Fprintln(stderr, "inbox enable needs --dir <folder>")
		fmt.Fprintln(stderr, "the directory is an explicit choice: automatic receive is off until you make it")
		return 2
	}
	cfgDir, err := resolveConfigDir(configDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}

	// Resolve the directory BEFORE anything is announced to the server. A
	// receive directory that does not exist, is not a directory, or cannot be
	// written must not become an enrolment that tells senders their files will
	// land.
	resolved, created, err := resolveReceiveDir(dir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if err := inboxclient.CheckReceiveDir(resolved); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	warnIfRoot(stderr)

	ctx := context.Background()
	sess, err := openInboxSession(ctx, cfgDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if err := sess.store.Ensure(); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}

	res, err := sess.client.Enrol(ctx, inboxclient.EnrolRequest{
		Platform:         inboxclient.Platform(),
		AppVersion:       version,
		ProtocolVersions: inboxclient.ProtocolVersions(),
		Capabilities:     inboxclient.Capabilities(),
		AutoAccept:       inbox.AutoAcceptAuto,
		ReceiveDirReady:  true,
	})
	if err != nil {
		fmt.Fprintln(stderr, enrolAdvice(err))
		return 1
	}
	key, err := inboxclient.EnsureUsableKey(ctx, sess.client, sess.store.Keys(), res.Inbox.Key, time.Now())
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}

	// Persisted last: the configuration is what makes the worker act, and it
	// should not claim to be enabled until the enrolment and the key really are.
	cfg := inboxclient.Config{
		DeviceID: sess.device.ID, Server: sess.creds.Server, Dir: resolved,
		Enabled: true, Paused: false, AutoAccept: inbox.AutoAcceptAuto,
		EnabledAt: time.Now().Unix(),
	}
	if err := sess.store.SaveConfig(cfg, time.Now()); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}

	fmt.Fprintf(stdout, "Device Inbox enabled on %q (%s)\n", sess.device.Name, sess.device.ID)
	fmt.Fprintf(stdout, "  receiving into: %s\n", resolved)
	if created {
		fmt.Fprintln(stdout, "  directory:      created by Relayium (mode 0700)")
	}
	fmt.Fprintf(stdout, "  account:        %s (%s)\n", sess.creds.AccountEmail, sess.creds.Server)
	fmt.Fprintf(stdout, "  protocol:       v%d, %s\n", res.ProtocolVersion, res.ReceiveCapability)
	fmt.Fprintf(stdout, "  public key:     generation %d (%s)\n", key.Generation, key.Algorithm)
	fmt.Fprintln(stderr)
	fmt.Fprintln(stderr, "Nothing is received until a worker is running.")
	fmt.Fprintln(stderr, "For a Linux server, install the always-on service (recommended):")
	fmt.Fprintln(stderr, "  https://relayium.com/inbox-server-install.sh")
	fmt.Fprintln(stderr, "For diagnostics or a container foreground process only:")
	fmt.Fprintln(stderr, "  relayium inbox run")
	fmt.Fprintln(stderr, "Manual service definitions:")
	fmt.Fprintln(stderr, "  relayium inbox service systemd-user   # or systemd-system, launchd, container")
	return 0
}

// resolveReceiveDir turns a user-supplied path into the absolute, fully
// symlink-resolved directory the enrolment will store.
//
// Resolving symlinks NOW and storing the result is what stops a later swap of an
// ancestor link from silently redirecting every future delivery: the worker
// commits into the path it was given, and re-checks on every heartbeat that the
// path is still a real directory it can write.
func resolveReceiveDir(dir string) (string, bool, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", false, err
	}
	created := false
	fi, err := os.Stat(abs)
	if errors.Is(err, os.ErrNotExist) {
		// --dir is the local operator's explicit write opt-in. Creating the named
		// directory here removes a needless first-run trap; the worker itself
		// still NEVER recreates a directory that later disappears, because that
		// could write onto an unmounted volume's underlying filesystem.
		if err := os.MkdirAll(abs, 0o700); err != nil {
			return "", false, fmt.Errorf("create receive directory %s: %w", abs, err)
		}
		created = true
		fi, err = os.Stat(abs)
	}
	if err != nil {
		return "", false, fmt.Errorf("receive directory %s: %w", abs, err)
	}
	if !fi.IsDir() {
		return "", false, fmt.Errorf("receive directory %s is not a directory", abs)
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", false, err
	}
	return resolved, created, nil
}

// warnIfRoot says what running as root will actually do. It does not refuse:
// a system-wide install under a dedicated account is a legitimate deployment,
// and `relayium inbox service systemd-system` is exactly how to set one up. What
// it must never do is acquire privileges it was not given.
func warnIfRoot(stderr io.Writer) {
	if os.Geteuid() != 0 {
		return
	}
	fmt.Fprintln(stderr, "warning: running as root. Received files will be owned by root, and this")
	fmt.Fprintln(stderr, "         worker will hold an account credential as root.")
	fmt.Fprintln(stderr, "         Prefer `relayium inbox service systemd-system`, which runs the")
	fmt.Fprintln(stderr, "         receiver under a dedicated unprivileged account.")
}

// enrolAdvice turns a negotiation rejection into an action.
func enrolAdvice(err error) error {
	switch inboxclient.ErrorCode(err) {
	case "unsupported_protocol_version", "unsupported_capability":
		return fmt.Errorf("this Relayium server does not support the Device Inbox protocol this CLI speaks — "+
			"update the CLI (`relayium update`) or the server: %w", err)
	case "device_inbox_revoked":
		return fmt.Errorf("this device's inbox was revoked. Clear it from another device or the web "+
			"(My Devices), or run `relayium login` again to enrol as a new device: %w", err)
	}
	return err
}

// ---------------------------------------------------------------- run

func runInboxRun(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("inbox run", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var configDir string
	var once bool
	inboxConfigDirFlag(fs, &configDir)
	fs.BoolVar(&once, "once", false, "drain the queue once and exit instead of staying resident")
	if wantsHelpFS(fs, args) {
		fmt.Fprint(stdout, inboxRunUsage)
		return 0
	}
	if err := parseArgs(fs, args); err != nil {
		return 2
	}
	cfgDir, err := resolveConfigDir(configDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	store := inboxclient.NewStore(inboxclient.StoreDir(cfgDir))
	cfg, found, err := store.LoadConfig()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if !found || !cfg.Enabled {
		fmt.Fprintln(stderr, inboxclient.ErrNotEnabled)
		return 1
	}

	// One worker per state directory. Two would race on the journals and the
	// receive directory, which no server-side claim token can prevent.
	lock, err := inboxclient.AcquireLock(store.LockPath())
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	defer lock.Release()

	// SIGINT and SIGTERM cancel the context. Everything below treats a cancelled
	// context as a clean stop: in-flight work is abandoned WITHOUT a report, so
	// central reclaims it on the lease rather than being told a half-truth, and
	// the process exits 0 so a supervisor does not restart-loop an intentional
	// stop.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	sess, err := openInboxSession(ctx, cfgDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if cfg.DeviceID != "" && cfg.DeviceID != sess.device.ID {
		fmt.Fprintf(stderr, "this credential now authenticates as a different device (%s, not the enabled %s).\n",
			sess.device.ID, cfg.DeviceID)
		fmt.Fprintln(stderr, "run `relayium inbox enable --dir <folder>` again to enrol this device.")
		return 1
	}
	if cfg.Server != "" && !sameServer(cfg.Server, sess.creds.Server) {
		fmt.Fprintf(stderr, "the inbox was enabled against %s but this credential is for %s.\n", cfg.Server, sess.creds.Server)
		fmt.Fprintln(stderr, "run `relayium inbox enable --dir <folder>` again against the server you want.")
		return 1
	}

	logf := func(format string, a ...any) {
		fmt.Fprintf(stderr, "%s "+format+"\n", append([]any{time.Now().Format(time.RFC3339)}, a...)...)
	}
	fmt.Fprintf(stdout, "relayium inbox: receiving for %q into %s (account %s)\n",
		sess.device.Name, cfg.Dir, sess.creds.AccountEmail)

	w := inboxclient.NewWorker(inboxclient.Options{
		Client: sess.client, Store: store, Config: cfg,
		Platform: inboxclient.Platform(), AppVersion: version,
		Clock: inboxclient.RealClock{}, Log: logf, Once: once,
	})
	if err := w.Run(ctx); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}

// ---------------------------------------------------------------- disable

func runInboxDisable(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("inbox disable", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var configDir string
	var localOnly bool
	inboxConfigDirFlag(fs, &configDir)
	fs.BoolVar(&localOnly, "local-only", false,
		"stop receiving locally without clearing the server inbox (keeps the private keys)")
	if wantsHelpFS(fs, args) {
		fmt.Fprint(stdout, inboxDisableUsage)
		return 0
	}
	if err := parseArgs(fs, args); err != nil {
		return 2
	}
	cfgDir, err := resolveConfigDir(configDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	store := inboxclient.NewStore(inboxclient.StoreDir(cfgDir))
	cfg, found, err := store.LoadConfig()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if !found {
		fmt.Fprintln(stdout, "Device Inbox is not enabled on this device; nothing to disable")
		return 0
	}

	// Step 1, always, and first: stop this machine from receiving anything else.
	// It is non-destructive and it is the part that cannot fail, so it happens
	// before anything that can.
	cfg.Enabled = false
	cfg.Paused = false
	if err := store.SaveConfig(cfg, time.Now()); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintln(stdout, "automatic receive is off on this device (a running `relayium inbox run` will stop)")

	if localOnly {
		fmt.Fprintln(stdout, "--local-only: the server inbox was NOT cleared and the private keys were kept.")
		fmt.Fprintln(stdout, "this device may still appear as a send target until you clear it from another")
		fmt.Fprintln(stdout, "device or the web (My Devices).")
		return 0
	}

	// Do not revoke the server enrolment or delete journals/keys while a worker
	// may still be inside a verified commit. The disabled configuration makes it
	// exit before taking another task; the operator can stop its supervisor (or
	// let the current task finish) and retry once the kernel lock is free.
	running, lockErr := inboxclient.WorkerRunning(store.LockPath())
	if lockErr != nil {
		fmt.Fprintf(stderr, "cannot prove the Device Inbox worker has stopped: %v\n", lockErr)
		fmt.Fprintln(stderr, "the server inbox and local private keys were kept. Stop the worker, then retry `relayium inbox disable`.")
		return 1
	}
	if running {
		fmt.Fprintln(stderr, "a Device Inbox worker is still running (or finishing its current task).")
		fmt.Fprintln(stderr, "the server inbox and local private keys were kept. Stop the service, then retry `relayium inbox disable`.")
		return 1
	}

	// Step 2: clear the enrolment on the server. This is what actually stops new
	// tasks from being sealed to this device, and it terminates the ones already
	// queued as `revoked` — so the sender is told the truth instead of watching a
	// task that will never be claimed.
	ctx := context.Background()
	sess, err := openInboxSession(ctx, cfgDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return disableRemoteFailed(stderr)
	}
	if err := sess.client.ClearInbox(ctx); err != nil {
		if inboxclient.ErrorStatus(err) == 404 {
			// Already gone (cleared from the web, or the device was deleted).
			// That is the state we were trying to reach, so continue.
			fmt.Fprintln(stdout, "the server inbox was already cleared")
		} else {
			fmt.Fprintln(stderr, err)
			return disableRemoteFailed(stderr)
		}
	} else {
		fmt.Fprintln(stdout, "server inbox cleared: the enrolment, the published keys and any queued tasks are gone")
	}

	// Step 3, and only now: destroy the private keys. Doing this before the
	// server confirmed would destroy the only thing that could ever decrypt tasks
	// still sitting in the queue.
	if err := store.Keys().Destroy(); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if err := os.RemoveAll(store.Journals().Dir()); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if err := store.ClearConfig(); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintln(stdout, "local device private keys and task receipts deleted")
	return 0
}

// disableRemoteFailed reports a half-completed disable honestly. The local half
// succeeded and is stated as such; the server half did not, and the private keys
// were therefore KEPT, because they are still the only way to open anything
// central has queued.
func disableRemoteFailed(stderr io.Writer) int {
	fmt.Fprintln(stderr, "the server inbox was NOT cleared, so this device may still appear as a send target.")
	fmt.Fprintln(stderr, "the local private keys were kept — deleting them now would make any task already")
	fmt.Fprintln(stderr, "queued for this device permanently undecryptable.")
	fmt.Fprintln(stderr, "retry `relayium inbox disable`, or clear it from another device or the web (My Devices).")
	return 1
}

// ---------------------------------------------------------------- pause/resume

func runInboxPauseResume(args []string, pause bool, stdout, stderr io.Writer) int {
	name := "resume"
	if pause {
		name = "pause"
	}
	fs := flag.NewFlagSet("inbox "+name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	var configDir string
	inboxConfigDirFlag(fs, &configDir)
	if wantsHelpFS(fs, args) {
		if pause {
			fmt.Fprint(stdout, inboxPauseUsage)
		} else {
			fmt.Fprint(stdout, inboxResumeUsage)
		}
		return 0
	}
	if err := parseArgs(fs, args); err != nil {
		return 2
	}
	cfgDir, err := resolveConfigDir(configDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	store := inboxclient.NewStore(inboxclient.StoreDir(cfgDir))
	cfg, found, err := store.LoadConfig()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if !found || !cfg.Enabled {
		fmt.Fprintln(stderr, inboxclient.ErrNotEnabled)
		return 1
	}
	cfg.Paused = pause
	if err := store.SaveConfig(cfg, time.Now()); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if pause {
		fmt.Fprintln(stdout, "Device Inbox paused. Senders will see this device as offline and their files")
		fmt.Fprintln(stdout, "will queue until you run `relayium inbox resume`. Nothing was revoked or deleted.")
	} else {
		// `resume` is also the explicit retry gesture for blockers that require a
		// person (for example, removing the file that won a destination-name race).
		// Only closed LOCAL error codes qualify; an `ask` task has no error code and
		// is never accepted by this command.
		requeued, retryErr := retryInboxLocalBlockers(context.Background(), cfgDir)
		fmt.Fprintln(stdout, "Device Inbox resumed. A running worker picks this up within a few seconds;")
		fmt.Fprintln(stdout, "otherwise start one with `relayium inbox run`.")
		if requeued > 0 {
			fmt.Fprintf(stdout, "%d locally blocked task(s) re-queued after your retry.\n", requeued)
		}
		if retryErr != nil {
			// Local resume is already durable and must not be rolled back because the
			// server is temporarily unreachable. Say exactly which half is pending.
			fmt.Fprintf(stderr, "warning: receiving resumed locally, but blocked tasks could not be re-queued yet: %v\n", retryErr)
		}
	}
	return 0
}

func retryInboxLocalBlockers(ctx context.Context, cfgDir string) (int, error) {
	sess, err := openInboxSession(ctx, cfgDir)
	if err != nil {
		return 0, err
	}
	tasks, err := sess.client.Pending(ctx, 0)
	if err != nil {
		return 0, err
	}
	requeued := 0
	for _, t := range tasks {
		if t.State != inbox.TaskAttentionRequired {
			continue
		}
		switch t.ErrorCode {
		case inbox.TaskErrDiskFull, inbox.TaskErrPermissionDenied,
			inbox.TaskErrDirectoryUnavailabl, inbox.TaskErrNameConflict:
		default:
			continue
		}
		if _, err := sess.client.Accept(ctx, t.ID, true); err != nil {
			return requeued, err
		}
		requeued++
	}
	return requeued, nil
}

// ---------------------------------------------------------------- status

func runInboxStatus(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("inbox status", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var configDir string
	inboxConfigDirFlag(fs, &configDir)
	if wantsHelpFS(fs, args) {
		fmt.Fprint(stdout, inboxStatusUsage)
		return 0
	}
	if err := parseArgs(fs, args); err != nil {
		return 2
	}
	cfgDir, err := resolveConfigDir(configDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	store := inboxclient.NewStore(inboxclient.StoreDir(cfgDir))
	cfg, found, cerr := store.LoadConfig()

	fmt.Fprintln(stdout, "Local")
	if cerr != nil {
		fmt.Fprintf(stdout, "  configuration:  unreadable (%v)\n", cerr)
	} else if !found {
		fmt.Fprintln(stdout, "  automatic receive: off (never enabled)")
		fmt.Fprintln(stdout, "  enable it with: relayium inbox enable --dir <folder>")
	} else {
		fmt.Fprintf(stdout, "  automatic receive: %s\n", enabledWord(cfg))
		fmt.Fprintf(stdout, "  receive directory: %s\n", cfg.Dir)
		if derr := inboxclient.CheckReceiveDir(cfg.Dir); derr != nil {
			fmt.Fprintf(stdout, "  directory status:  NOT USABLE — %v\n", derr)
		} else {
			fmt.Fprintln(stdout, "  directory status:  usable (verified by writing and removing a probe file)")
		}
	}

	// Worker liveness is answered by the lock, not by a pid file: the kernel
	// releases the lock when the holder dies, so this cannot report a crashed
	// worker as running.
	running, lerr := inboxclient.WorkerRunning(store.LockPath())
	switch {
	case errors.Is(lerr, inboxclient.ErrLockUnsupported):
		fmt.Fprintln(stdout, "  worker:            unknown on this platform")
	case lerr != nil:
		fmt.Fprintf(stdout, "  worker:            unknown (%v)\n", lerr)
	case running:
		fmt.Fprintln(stdout, "  worker:            running (`relayium inbox run` holds the lock)")
	default:
		fmt.Fprintln(stdout, "  worker:            not running — start it with `relayium inbox run`")
	}

	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "Credential")
	creds, hasCreds, err := cloud.Load(cfgDir)
	if err != nil {
		fmt.Fprintf(stdout, "  unreadable (%v)\n", err)
		return 1
	}
	if !hasCreds {
		fmt.Fprintln(stdout, "  not logged in — run `relayium login`")
		return 1
	}
	fmt.Fprintf(stdout, "  account: %s\n", creds.AccountEmail)
	fmt.Fprintf(stdout, "  server:  %s\n", creds.Server)

	// Local keys, counted and described — never printed. A private key has no
	// legitimate reason to reach a terminal, and a public key adds nothing a user
	// can act on.
	keys, kerr := store.Keys().Load()
	if kerr != nil {
		fmt.Fprintf(stdout, "  device keys: unreadable (%v)\n", kerr)
	} else {
		fmt.Fprintf(stdout, "  device keys: %d private key(s) held locally\n", len(keys))
	}

	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "Server")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	sess, err := openInboxSession(ctx, cfgDir)
	if err != nil {
		fmt.Fprintf(stdout, "  unreachable or not authorised: %v\n", err)
		fmt.Fprintln(stdout, "  (the local state above is still accurate)")
		return 1
	}
	fmt.Fprintf(stdout, "  device:    %s (%s)\n", sess.device.Name, sess.device.ID)
	in := sess.device.Inbox
	if in == nil {
		fmt.Fprintln(stdout, "  enrolment: none — this device is not a send target")
		fmt.Fprintln(stdout, "  enable it with: relayium inbox enable --dir <folder>")
		return 0
	}
	fmt.Fprintf(stdout, "  presence:  %s\n", in.Presence)
	fmt.Fprintf(stdout, "  policy:    auto-accept %q, receive directory reported %s\n",
		in.AutoAccept, readyWord(in.ReceiveDirReady))
	fmt.Fprintf(stdout, "  protocol:  v%d, %s\n", in.ProtocolVersion, in.ReceiveCapability)
	fmt.Fprintf(stdout, "  can receive: %t (revoked: %t)\n", in.CanReceive, in.Revoked)
	if in.Key == nil {
		fmt.Fprintln(stdout, "  active key: none published")
	} else {
		_, held, err := store.Keys().ByKeyID(in.Key.ID)
		fmt.Fprintf(stdout, "  active key: generation %d, private half held locally: %t\n",
			in.Key.Generation, held && err == nil)
		if !held {
			fmt.Fprintln(stdout, "    this device cannot decrypt tasks sealed to that key.")
			fmt.Fprintln(stdout, "    `relayium inbox run` will rotate onto a key it holds.")
		}
	}
	if in.Revoked {
		fmt.Fprintln(stdout, "  the inbox was revoked; clear it from another device or the web, then re-enable here")
	}
	return 0
}

func enabledWord(cfg inboxclient.Config) string {
	switch {
	case !cfg.Enabled:
		return "off"
	case cfg.Paused:
		return "on, but PAUSED (`relayium inbox resume` to continue)"
	default:
		return "on"
	}
}

func readyWord(ok bool) string {
	if ok {
		return "usable"
	}
	return "unusable"
}

// ---------------------------------------------------------------- service

func runInboxService(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("inbox service", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var configDir, serviceUser, receiveDir string
	inboxConfigDirFlag(fs, &configDir)
	fs.StringVar(&serviceUser, "service-user", "", "account a system-wide unit runs as (default: relayium)")
	fs.StringVar(&receiveDir, "dir", "", "receive directory to write into the unit (default: the enabled one)")
	if wantsHelpFS(fs, args) {
		fmt.Fprint(stdout, inboxServiceUsage)
		return 0
	}
	if err := parseArgs(fs, args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		fmt.Fprintln(stderr, "inbox service needs one of: systemd-user, systemd-system, launchd, container")
		return 2
	}
	cfgDir, err := resolveConfigDir(configDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	kind := fs.Arg(0)
	// A system-wide unit runs as a dedicated account, so its state lives under
	// /var/lib — NOT in the invoking operator's home, which is where
	// resolveConfigDir would land and which the service account cannot read.
	// An explicit --config-dir still wins.
	unitCfgDir := cfgDir
	if kind == string(deploy.SystemdSystem) && configDir == "" {
		unitCfgDir = systemServiceConfigDir
	}
	p, err := servicePlaceholders(cfgDir, unitCfgDir, serviceUser, receiveDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if kind == "container" {
		for _, line := range deploy.ContainerNotes(p) {
			fmt.Fprintln(stdout, line)
		}
		return 0
	}
	out, err := deploy.Render(deploy.Kind(kind), p)
	if err != nil {
		fmt.Fprintf(stderr, "%v (want systemd-user, systemd-system, launchd or container)\n", err)
		return 2
	}
	fmt.Fprint(stdout, out)
	fmt.Fprintln(stderr)
	for _, line := range deploy.Instructions(deploy.Kind(kind), p) {
		fmt.Fprintln(stderr, line)
	}
	return 0
}

// systemServiceConfigDir is where a system-wide unit's dedicated account keeps
// its credential and Device Inbox state. It matches the unit's
// StateDirectory=relayium-inbox, which systemd creates and chowns for it.
const systemServiceConfigDir = "/var/lib/relayium-inbox/config"

// servicePlaceholders collects the machine-specific values a unit needs.
//
// The binary path comes from os.Executable, so a unit generated here names the
// binary that generated it. A hardcoded /usr/local/bin would be a guess, and a
// wrong one for anybody who installed elsewhere.
//
// localCfgDir is where THIS invocation reads its own configuration from (to
// learn the receive directory); unitCfgDir is what the generated unit will use,
// which differs for a system-wide service running as another account.
func servicePlaceholders(localCfgDir, unitCfgDir, serviceUser, receiveDir string) (deploy.Params, error) {
	exe, err := os.Executable()
	if err != nil {
		return deploy.Params{}, fmt.Errorf("cannot determine this executable's path: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	if receiveDir == "" {
		cfg, found, err := inboxclient.NewStore(inboxclient.StoreDir(localCfgDir)).LoadConfig()
		if err == nil && found {
			receiveDir = cfg.Dir
		}
	}
	if receiveDir == "" {
		return deploy.Params{}, errors.New(
			"no receive directory: run `relayium inbox enable --dir <folder>` first, or pass --dir")
	}
	if serviceUser == "" {
		// A dedicated account, never the invoking user: the point of the
		// system-wide unit is that the receiver owns nothing but its own
		// directory.
		serviceUser = "relayium"
	}
	currentUser := os.Getenv("USER")
	if currentUser == "" {
		currentUser = "$USER"
	}
	return deploy.Params{
		Binary:     exe,
		ConfigDir:  unitCfgDir,
		StateDir:   inboxclient.StoreDir(unitCfgDir),
		ReceiveDir: receiveDir, ServiceUser: serviceUser,
		CurrentUser: currentUser, LogDir: filepath.Join(unitCfgDir, "logs"),
	}, nil
}
