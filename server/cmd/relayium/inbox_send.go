package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/relayium/relayium/internal/inboxsend"
	"github.com/relayium/relayium/internal/termtext"
)

// `relayium inbox devices|send|sent|cancel|retry` — the CLI Device Inbox SENDER.
//
// The sender needs a login and nothing else: it never enrols this machine to
// receive, never creates receiver state, and never reads the receiver keystore.
// Everything it transmits is ciphertext plus the seven opaque create fields;
// names, paths, sizes-per-file and keys stay on this machine.
//
// Scripting contract: the one result goes to stdout (one JSON document with
// --json), people read stderr. Exit codes:
//
//	0   success (send: the delivery is queued — or, with --wait, saved)
//	1   definitive failure
//	2   usage error or a local refusal before any network write
//	3   outcome unknown; the local record is kept for `inbox retry`
//	4   --wait ended without "saved" (another final state, or it timed out)
//	130 interrupted

const (
	exitSendFailed      = 1
	exitSendUsage       = 2
	exitSendUnknown     = 3
	exitSendNotSaved    = 4
	exitSendInterrupted = 130
)

const inboxDevicesUsage = `relayium inbox devices — list this account's devices and whether you can send to them

usage:
  relayium inbox devices [--json] [--config-dir D]

One row per device in the account: its id, name and kind, whether it is THIS
machine (*), its presence, its receive policy, and whether a delivery can be
sent to it — or the first reason it cannot. Uses the same rules as the Web.

Requires "relayium login" and network access. It enrols nothing: this machine
does not need Device Inbox receiving turned on to send.

flags:
  --json           print one JSON document instead of the table
  --config-dir D   credential/state directory (default ~/.config/relayium)
`

const inboxSendUsage = `relayium inbox send — send files or folders to one of your devices

usage:
  relayium inbox send --to <device> [--ttl D] [--wait[=D]] [--json] [--config-dir D] <path...>

Encrypts the files on this machine under a new key, uploads only the
ciphertext, and queues it for the device you name. The key travels sealed to
that device's receiving key, so only it can open the delivery. The device does
not have to be online; it saves the delivery when it next runs its receiver.

QUEUED IS NOT SAVED. By default this returns once the delivery is queued, and
says so. Check later with "relayium inbox sent <task-id>", or pass --wait to
stay until the device reports it saved.

Requires "relayium login" and network access. This machine does not need Device
Inbox receiving turned on. The upload counts against your account's storage,
traffic, daily quota and retention limits exactly like a stored link.

positional arguments:
  <path...>   files or folders. A folder is sent with its structure; a symbolic
              link or special file inside it, or a name a receiving device would
              refuse, stops the send before anything is uploaded. Empty folders
              cannot be sent and are listed on stderr; a delivery made only of
              empty files is refused.

flags:
  --to <device>    the receiving device: its id, or its exact name if no other
                   device in the account has that name (see "relayium inbox
                   devices"). Your own current device is a valid target.
  --ttl D          retention: 7d, 2w, 2h, 90m, or a number of seconds. The plan's
                   cap still applies.
  --wait[=D]       after queueing, wait until the device reports the delivery
                   saved or it ends otherwise (default 10m; e.g. --wait=1h)
  --json           print one JSON document with the outcome
  --config-dir D   credential/state directory (default ~/.config/relayium)

What happens when things go wrong:
  - A network drop while the command runs is resumed automatically.
  - If the answer to "complete the upload" or "queue the delivery" is lost, the
    outcome is unknown (exit 3). Nothing is uploaded again automatically; run
    "relayium inbox retry <id>" later.
  - If the command is stopped after every byte was uploaded, "relayium inbox
    retry <id>" finishes it if the server can confirm the upload; otherwise the
    outcome stays unknown.
  - If the command is stopped part-way through the upload, it cannot be
    resumed: run "relayium inbox send" again, which is a new upload and is
    counted again. The partial upload becomes eligible for cleanup after about
    an hour; cleanup runs periodically and can be delayed.
  - If the device's receiving key changes while the command runs, the delivery
    is sealed to the new key. After a restart it cannot be, and the send fails
    — or, if an earlier attempt may already have queued it, the outcome is
    reported as unknown.
`

const inboxSentUsage = `relayium inbox sent — show deliveries you sent and their state

usage:
  relayium inbox sent [<task-id>] [--to <device>] [--all] [--limit N] [--json] [--config-dir D]

Without a task id: the most recent deliveries this machine sent, newest first,
one per line ("<task-id> <device-id> <state> [<error>]"), followed by any
unfinished local sends ("local <id> <phase>") that "relayium inbox retry" can
act on. With a task id: that delivery's current state.

"saved" means the receiving device committed every file to disk. "queued" and
"notified" mean it is waiting for that device.

Requires "relayium login" and network access.

flags:
  --to <device>    only deliveries to this device (id or unique name)
  --all            include deliveries other devices of this account sent
  --limit N        at most N deliveries per device (default 50, max 500)
  --json           print one JSON document
  --config-dir D   credential/state directory (default ~/.config/relayium)
`

const inboxCancelUsage = `relayium inbox cancel — cancel a queued delivery

usage:
  relayium inbox cancel <task-id> [--to <device>] [--json] [--config-dir D]

Cancels a delivery that is still waiting (queued, notified, waiting for
approval, or waiting to be retried). The delivery is removed at once; its
ciphertext is then released for deletion from storage, which can happen later
(cleanup can be delayed). A delivery the device is receiving right now is not
cancelled, and a finished one has nothing to cancel.

Requires "relayium login" and network access.

flags:
  --to <device>    the receiving device (id or unique name); without it the
                   account's devices are searched
  --json           print one JSON document
  --config-dir D   credential/state directory (default ~/.config/relayium)
`

const inboxRetryUsage = `relayium inbox retry — finish a send that was interrupted

usage:
  relayium inbox retry <id> [--wait[=D]] [--json] [--config-dir D]

<id> is the local send id "relayium inbox send" printed when it could not
finish (also listed by "relayium inbox sent"). Retry never encrypts and never
uploads: it completes the send from what is already on the server, or says
that it cannot. An upload stopped part-way cannot be resumed — run "relayium
inbox send" again, which is a new upload and is counted again.

It must run with the same login that started the send; logging in again
creates a new device, which cannot finish another device's send.

Requires "relayium login" and network access.

flags:
  --wait[=D]       after queueing, wait until the device reports it saved
  --json           print one JSON document with the outcome
  --config-dir D   credential/state directory (default ~/.config/relayium)
`

const defaultSendWait = 10 * time.Minute

// waitFlag is --wait / --wait=D.
type waitFlag struct {
	on bool
	d  time.Duration
}

func (w *waitFlag) String() string {
	if !w.on {
		return ""
	}
	return w.d.String()
}

func (w *waitFlag) Set(s string) error {
	switch s {
	case "true":
		w.on, w.d = true, defaultSendWait
		return nil
	case "false":
		w.on = false
		return nil
	}
	d, err := time.ParseDuration(s)
	if err != nil || d <= 0 {
		return fmt.Errorf("--wait takes a duration such as 30s, 10m or 1h")
	}
	w.on, w.d = true, d
	return nil
}

func (w *waitFlag) IsBoolFlag() bool { return true }

// openSender resolves --config-dir and loads the credential. A failure is
// reported through failure, so --json still gets its one document.
func openSender(configDir string, asJSON bool, stdout, stderr io.Writer) (*inboxsend.Session, int) {
	cfgDir, err := resolveConfigDir(configDir)
	if err != nil {
		e := &inboxsend.Error{Class: inboxsend.ClassFailed, Code: inboxsend.CodeLocalState,
			Msg: "cannot find the configuration directory: " + termtext.Safe(err.Error())}
		return nil, failure(e, asJSON, stdout, stderr)
	}
	s, err := inboxsend.Open(cfgDir, nil)
	if err != nil {
		return nil, failure(err, asJSON, stdout, stderr)
	}
	s.Notice = stderr
	return s, 0
}

// usageFailure ends a command line that could not be accepted: the reason on
// stderr (flag's own parse errors are already there), exit 2, and with --json
// the one document {"error":"usage","outcome":"refused"}.
func usageFailure(asJSON bool, stdout, stderr io.Writer, format string, a ...any) int {
	fmt.Fprintf(stderr, format, a...)
	if asJSON {
		writeJSON(stdout, map[string]string{"error": inboxsend.CodeUsage, "outcome": "refused"})
	}
	return exitSendUsage
}

// parseSendArgs is parseArgs for the sender commands. When the command line
// cannot be parsed the FlagSet's --json cannot be trusted (Parse stops at the
// first error), so whether JSON was asked for is read by jsonRequested.
func parseSendArgs(fs *flag.FlagSet, args []string, asJSON *bool, stdout, stderr io.Writer) (int, bool) {
	if err := parseArgs(fs, args); err != nil {
		*asJSON = jsonRequested(fs, args)
		return usageFailure(*asJSON, stdout, stderr, ""), false
	}
	return 0, true
}

// jsonRequested reports whether args ask for --json, reading them with the
// same token rules as permuteFlags and the flag package rather than looking for
// a substring: "--" ends the flags (a file may be named --json), a value flag
// claims the token after it (--to --json names a device), -json and --json are
// the same flag, --json=V takes V as flag would, and the last spelling wins. A
// --json=V whose V is not a boolean is not a request.
func jsonRequested(fs *flag.FlagSet, args []string) bool {
	on := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			break
		}
		if len(a) < 2 || a[0] != '-' {
			continue
		}
		name := a[1:]
		if name[0] == '-' {
			name = name[1:]
		}
		value, hasValue := "", false
		if k := strings.IndexByte(name, '='); k >= 0 {
			name, value, hasValue = name[:k], name[k+1:], true
		}
		if name == "json" {
			on = true
			if hasValue {
				b, err := strconv.ParseBool(value)
				on = err == nil && b
			}
			continue
		}
		if hasValue {
			continue
		}
		if f := fs.Lookup(name); f != nil {
			if bf, ok := f.Value.(boolFlag); !ok || !bf.IsBoolFlag() {
				i++ // this flag's value, whatever it looks like
			}
		}
	}
	return on
}

// writeJSON prints one JSON document with every control character escaped,
// including the DEL and C1 characters encoding/json leaves raw: a device name
// is account-controlled text, and a JSON document is still printed on a
// terminal.
func writeJSON(w io.Writer, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	var out bytes.Buffer
	for i := 0; i < len(b); {
		r, n := utf8.DecodeRune(b[i:])
		if unicode.IsControl(r) || r == ' ' || r == ' ' {
			fmt.Fprintf(&out, `\u%04x`, r)
		} else {
			out.Write(b[i : i+n])
		}
		i += n
	}
	out.WriteByte('\n')
	_, _ = w.Write(out.Bytes())
}

// failure reports err and returns its exit code. With --json the stdout
// document is {"error","outcome"[,"localSendId"]}.
func failure(err error, asJSON bool, stdout, stderr io.Writer) int {
	e := inboxsend.AsError(err)
	if e == nil {
		fmt.Fprintln(stderr, "relayium inbox:", termtext.Safe(err.Error()))
		if asJSON {
			writeJSON(stdout, map[string]string{"error": inboxsend.CodeUnknown, "outcome": "failed"})
		}
		return exitSendFailed
	}
	code, outcome := exitSendFailed, "failed"
	switch e.Class {
	case inboxsend.ClassLocal:
		code, outcome = exitSendUsage, "refused"
	case inboxsend.ClassUnknown:
		code, outcome = exitSendUnknown, "unknown"
	case inboxsend.ClassInterrupted:
		code, outcome = exitSendInterrupted, "interrupted"
	}
	fmt.Fprintln(stderr, "relayium inbox:", e.Msg)
	if e.LocalSendID != "" {
		fmt.Fprintf(stderr, "local send id: %s\n", e.LocalSendID)
	}
	if asJSON {
		doc := map[string]string{"error": e.Code, "outcome": outcome}
		if e.LocalSendID != "" {
			doc["localSendId"] = e.LocalSendID
		}
		writeJSON(stdout, doc)
	}
	return code
}

func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}

// ---------------------------------------------------------------- devices

func runInboxDevices(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("inbox devices", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var configDir string
	var asJSON bool
	fs.BoolVar(&asJSON, "json", false, "print one JSON document")
	inboxConfigDirFlag(fs, &configDir)
	if wantsHelpFS(fs, args) {
		fmt.Fprint(stdout, inboxDevicesUsage)
		return 0
	}
	if rc, ok := parseSendArgs(fs, args, &asJSON, stdout, stderr); !ok {
		return rc
	}
	if fs.NArg() != 0 {
		return usageFailure(asJSON, stdout, stderr, "inbox devices takes no arguments\n\n%s", inboxDevicesUsage)
	}
	s, rc := openSender(configDir, asJSON, stdout, stderr)
	if s == nil {
		return rc
	}
	ctx, cancel := signalContext()
	defer cancel()
	rows, err := s.Devices(ctx)
	if err != nil {
		return failure(err, asJSON, stdout, stderr)
	}
	if asJSON {
		type row struct {
			ID       string   `json:"id"`
			Name     string   `json:"name"`
			Kind     string   `json:"kind"`
			Current  bool     `json:"current"`
			Presence string   `json:"presence"`
			Policy   string   `json:"policy"`
			Sendable bool     `json:"sendable"`
			Block    string   `json:"block"`
			Caveats  []string `json:"caveats"`
		}
		out := make([]row, 0, len(rows))
		for _, r := range rows {
			out = append(out, row{r.ID, r.Name, r.Kind, r.Current, r.Presence, r.Policy, r.Sendable, r.Block, r.Caveats})
		}
		writeJSON(stdout, map[string]any{"devices": out})
		return 0
	}
	fmt.Fprintf(stdout, "  %-32s  %-7s  %-8s  %-24s  %s\n", "ID", "SEND", "PRESENCE", "NAME", "NOTES")
	for _, r := range rows {
		mark := " "
		if r.Current {
			mark = "*"
		}
		send := "yes"
		notes := strings.Join(r.Caveats, ",")
		if !r.Sendable {
			send, notes = "no", r.Block
		}
		presence := r.Presence
		if presence == "" {
			presence = "-"
		}
		fmt.Fprintf(stdout, "%s %-32s  %-7s  %-8s  %-24s  %s\n", mark, termtext.Safe(r.ID), send,
			termtext.Safe(presence), termtext.Safe(r.Name), notes)
	}
	return 0
}

// ---------------------------------------------------------------- send / retry

func sendResultJSON(r inboxsend.Result) map[string]any {
	return map[string]any{
		"localSendId": r.LocalSendID, "taskId": r.TaskID, "targetDeviceId": r.TargetDeviceID,
		"state": r.State, "errorCode": r.ErrorCode, "created": r.Created,
		"ciphertextBytes": r.CiphertextBytes, "expiresAt": r.ExpiresAt, "savedAt": r.SavedAt,
	}
}

// reportQueued prints a successful send/retry, waiting first when asked.
func reportQueued(ctx context.Context, s *inboxsend.Session, r inboxsend.Result, wait waitFlag, asJSON bool, stdout, stderr io.Writer) int {
	who := termtext.Safe(r.TargetName)
	if who == "" {
		who = termtext.Safe(r.TargetDeviceID)
	}
	rc := 0
	if wait.on && r.State != "saved" {
		fmt.Fprintf(stderr, "Queued for %s. Waiting for the device to save it…\n", who)
		t, err := s.Wait(ctx, r.TargetDeviceID, r.TaskID, wait.d, r.State)
		switch {
		case err == nil:
			r.State, r.ErrorCode, r.SavedAt = t.State, t.ErrorCode, t.SavedAt
			if t.State != "saved" {
				rc = exitSendNotSaved
			}
		case errors.Is(err, inboxsend.ErrWaitTimeout):
			r.State = t.State
			fmt.Fprintf(stderr, "Stopped waiting after %s; the delivery is still %s.\n", wait.d, termtext.Safe(t.State))
			rc = exitSendNotSaved
		case errors.Is(err, inboxsend.ErrTaskGone):
			r.State = "gone"
			fmt.Fprintln(stderr, "The delivery no longer exists on the server (it was cancelled or cleaned up).")
			rc = exitSendNotSaved
		default:
			fmt.Fprintln(stderr, "Stopped waiting; the delivery was queued.")
			rc = exitSendInterrupted
		}
	}
	switch {
	case r.State == "saved":
		fmt.Fprintf(stderr, "Saved on %s.\n", who)
	case rc == 0:
		fmt.Fprintf(stderr, "Queued for %s. It is not saved yet — the device saves it when it is online and accepts it. "+
			"Check with: relayium inbox sent %s\n", who, r.TaskID)
		if r.State == "attention_required" {
			fmt.Fprintln(stderr, "It is waiting for someone at that device to accept it.")
		}
	case r.State != "" && r.State != "gone":
		fmt.Fprintf(stderr, "The delivery ended as %s", termtext.Safe(r.State))
		if r.ErrorCode != "" {
			fmt.Fprintf(stderr, " (%s)", termtext.Safe(r.ErrorCode))
		}
		fmt.Fprintln(stderr, ".")
	}
	if asJSON {
		writeJSON(stdout, sendResultJSON(r))
	} else {
		fmt.Fprintf(stdout, "%s %s\n", r.TaskID, termtext.Safe(r.State))
	}
	return rc
}

func runInboxSend(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("inbox send", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var configDir, to, ttlArg string
	var asJSON bool
	var wait waitFlag
	fs.StringVar(&to, "to", "", "receiving device: id or unique name (required)")
	fs.StringVar(&ttlArg, "ttl", "", "retention, as a duration (7d, 2h, 90m) or seconds")
	fs.Var(&wait, "wait", "wait until the device saves the delivery (default 10m; --wait=D)")
	fs.BoolVar(&asJSON, "json", false, "print one JSON document")
	inboxConfigDirFlag(fs, &configDir)
	if wantsHelpFS(fs, args) {
		fmt.Fprint(stdout, inboxSendUsage)
		return 0
	}
	if rc, ok := parseSendArgs(fs, args, &asJSON, stdout, stderr); !ok {
		return rc
	}
	if to == "" {
		return usageFailure(asJSON, stdout, stderr, "inbox send needs --to <device> (see \"relayium inbox devices\")\n\n%s", inboxSendUsage)
	}
	if fs.NArg() == 0 {
		return usageFailure(asJSON, stdout, stderr, "inbox send needs at least one file or folder\n\n%s", inboxSendUsage)
	}
	var ttl int64
	if ttlArg != "" {
		v, err := parseTTL(ttlArg)
		if err != nil {
			return usageFailure(asJSON, stdout, stderr, "%s\n", termtext.Safe(err.Error()))
		}
		ttl = v
	}
	s, rc := openSender(configDir, asJSON, stdout, stderr)
	if s == nil {
		return rc
	}
	ctx, cancel := signalContext()
	defer cancel()
	res, err := s.Send(ctx, inboxsend.SendRequest{To: to, Paths: fs.Args(), TTL: ttl})
	if err != nil {
		return failure(err, asJSON, stdout, stderr)
	}
	if ttl > 0 {
		if notice := truncatedTTLNotice(ttl, res.ExpiresAt, time.Now().Unix()); notice != "" {
			fmt.Fprintln(stderr, notice)
		}
	}
	return reportQueued(ctx, s, res, wait, asJSON, stdout, stderr)
}

func runInboxRetry(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("inbox retry", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var configDir string
	var asJSON bool
	var wait waitFlag
	fs.Var(&wait, "wait", "wait until the device saves the delivery (default 10m; --wait=D)")
	fs.BoolVar(&asJSON, "json", false, "print one JSON document")
	inboxConfigDirFlag(fs, &configDir)
	if wantsHelpFS(fs, args) {
		fmt.Fprint(stdout, inboxRetryUsage)
		return 0
	}
	if rc, ok := parseSendArgs(fs, args, &asJSON, stdout, stderr); !ok {
		return rc
	}
	if fs.NArg() != 1 {
		return usageFailure(asJSON, stdout, stderr, "inbox retry needs exactly one local send id\n\n%s", inboxRetryUsage)
	}
	s, rc := openSender(configDir, asJSON, stdout, stderr)
	if s == nil {
		return rc
	}
	ctx, cancel := signalContext()
	defer cancel()
	res, err := s.Retry(ctx, fs.Arg(0))
	if err != nil {
		return failure(err, asJSON, stdout, stderr)
	}
	return reportQueued(ctx, s, res, wait, asJSON, stdout, stderr)
}

// ---------------------------------------------------------------- sent

func sentJSON(t inboxsend.SentTask) map[string]any {
	return map[string]any{
		"taskId": t.TaskID, "targetDeviceId": t.TargetDeviceID, "sourceDeviceId": t.SourceDeviceID,
		"state": t.State, "errorCode": t.ErrorCode, "fromThisDevice": t.FromThisDevice,
		"createdAt": t.CreatedAt, "savedAt": t.SavedAt, "expiresAt": t.ExpiresAt, "terminal": t.Terminal,
	}
}

func sentLine(t inboxsend.SentTask) string {
	line := termtext.Safe(t.TaskID) + " " + termtext.Safe(t.TargetDeviceID) + " " + termtext.Safe(t.State)
	if t.ErrorCode != "" {
		line += " " + termtext.Safe(t.ErrorCode)
	}
	return line
}

func runInboxSent(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("inbox sent", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var configDir, to string
	var asJSON, all bool
	var limit int
	fs.StringVar(&to, "to", "", "only deliveries to this device")
	fs.BoolVar(&all, "all", false, "include deliveries other devices of this account sent")
	fs.IntVar(&limit, "limit", 50, "deliveries per device (max 500)")
	fs.BoolVar(&asJSON, "json", false, "print one JSON document")
	inboxConfigDirFlag(fs, &configDir)
	if wantsHelpFS(fs, args) {
		fmt.Fprint(stdout, inboxSentUsage)
		return 0
	}
	if rc, ok := parseSendArgs(fs, args, &asJSON, stdout, stderr); !ok {
		return rc
	}
	if fs.NArg() > 1 {
		return usageFailure(asJSON, stdout, stderr, "inbox sent takes at most one task id\n\n%s", inboxSentUsage)
	}
	if limit < 1 || limit > inboxsend.MaxSentLimit {
		return usageFailure(asJSON, stdout, stderr, "--limit must be between 1 and %d\n", inboxsend.MaxSentLimit)
	}
	s, rc := openSender(configDir, asJSON, stdout, stderr)
	if s == nil {
		return rc
	}
	ctx, cancel := signalContext()
	defer cancel()
	if fs.NArg() == 1 {
		t, err := s.Status(ctx, fs.Arg(0), to)
		if err != nil {
			return failure(err, asJSON, stdout, stderr)
		}
		if asJSON {
			writeJSON(stdout, map[string]any{"task": sentJSON(t)})
		} else {
			fmt.Fprintln(stdout, sentLine(t))
		}
		return 0
	}
	tasks, err := s.Sent(ctx, to, all, limit)
	if err != nil {
		return failure(err, asJSON, stdout, stderr)
	}
	locals := s.LocalSends()
	if asJSON {
		ts := make([]map[string]any, 0, len(tasks))
		for _, t := range tasks {
			ts = append(ts, sentJSON(t))
		}
		ls := make([]map[string]any, 0, len(locals))
		for _, l := range locals {
			ls = append(ls, map[string]any{"localSendId": l.LocalSendID, "phase": l.Phase,
				"targetDeviceId": l.TargetDeviceID, "createdAt": l.CreatedAt})
		}
		writeJSON(stdout, map[string]any{"tasks": ts, "localSends": ls})
		return 0
	}
	for _, t := range tasks {
		fmt.Fprintln(stdout, sentLine(t))
	}
	for _, l := range locals {
		fmt.Fprintf(stdout, "local %s %s\n", l.LocalSendID, l.Phase)
	}
	if len(tasks) == 0 && len(locals) == 0 {
		fmt.Fprintln(stderr, "no deliveries found")
	}
	return 0
}

// ---------------------------------------------------------------- cancel

func runInboxCancel(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("inbox cancel", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var configDir, to string
	var asJSON bool
	fs.StringVar(&to, "to", "", "the receiving device (id or unique name)")
	fs.BoolVar(&asJSON, "json", false, "print one JSON document")
	inboxConfigDirFlag(fs, &configDir)
	if wantsHelpFS(fs, args) {
		fmt.Fprint(stdout, inboxCancelUsage)
		return 0
	}
	if rc, ok := parseSendArgs(fs, args, &asJSON, stdout, stderr); !ok {
		return rc
	}
	if fs.NArg() != 1 {
		return usageFailure(asJSON, stdout, stderr, "inbox cancel needs exactly one task id\n\n%s", inboxCancelUsage)
	}
	s, rc := openSender(configDir, asJSON, stdout, stderr)
	if s == nil {
		return rc
	}
	ctx, cancel := signalContext()
	defer cancel()
	result, err := s.Cancel(ctx, fs.Arg(0), to)
	if err != nil {
		return failure(err, asJSON, stdout, stderr)
	}
	if asJSON {
		writeJSON(stdout, map[string]string{"taskId": fs.Arg(0), "result": result})
	} else {
		fmt.Fprintf(stdout, "%s %s\n", termtext.Safe(fs.Arg(0)), result)
	}
	return 0
}
