package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/relayium/relayium/internal/cloud"
)

// exitUpUnknown is `up`'s exit status when the server may or may not have
// stored the upload. The operation is kept on this machine; `up --recover <id>`
// asks the server for the outcome without uploading again.
const exitUpUnknown = 3

// upDoc is `up --json`'s one document. Only an "uploaded" document carries the
// link (and with it the key); no other outcome carries anything secret.
type upDoc struct {
	Status    string                     `json:"status"` // uploaded | unknown | gone | conflict | failed | pending
	Link      string                     `json:"link,omitempty"`
	ID        string                     `json:"id,omitempty"`
	ExpiresAt int64                      `json:"expiresAt,omitempty"`
	Operation string                     `json:"operation,omitempty"`
	Error     string                     `json:"error,omitempty"`
	Message   string                     `json:"message,omitempty"`
	Pending   []cloud.UpOperationSummary `json:"pending,omitempty"`
}

type upOutput struct {
	stdout, stderr io.Writer
	json           bool
}

func (o upOutput) emit(d upDoc) {
	enc := json.NewEncoder(o.stdout)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(d)
}

func (o upOutput) fail(code string, err error) int {
	if o.json {
		o.emit(upDoc{Status: "failed", Error: code, Message: err.Error()})
	}
	fmt.Fprintln(o.stderr, err)
	return 1
}

func (o upOutput) unknown(opID string, err error) int {
	if o.json {
		o.emit(upDoc{Status: "unknown", Operation: opID, Error: "outcome_unknown", Message: err.Error()})
	}
	fmt.Fprintln(o.stderr, err)
	fmt.Fprintf(o.stderr, "This upload was recorded on this machine as operation %s.\n", opID)
	fmt.Fprintf(o.stderr, "  `relayium up --recover %s` asks the server whether it arrived -- without uploading or counting it again --\n", opID)
	fmt.Fprintln(o.stderr, "  and prints the link if it did. Run it later if the server cannot answer yet.")
	return exitUpUnknown
}

// uploaded prints the link and only then forgets the operation: if the link
// cannot be written, the record (and the only copy of its key) stays.
func (o upOutput) uploaded(cfgDir string, op cloud.UpOperation, link, id string, expiresAt, ttl int64) int {
	var err error
	if o.json {
		enc := json.NewEncoder(o.stdout)
		enc.SetEscapeHTML(false)
		err = enc.Encode(upDoc{Status: "uploaded", Link: link, ID: id, ExpiresAt: expiresAt, Operation: op.ID})
	} else {
		_, err = fmt.Fprintln(o.stdout, link)
	}
	if err != nil {
		fmt.Fprintf(o.stderr, "the upload is stored, but its link could not be written (%v).\n", err)
		fmt.Fprintf(o.stderr, "  It is kept as operation %s: `relayium up --recover %s` prints it again.\n", op.ID, op.ID)
		return 1
	}
	if rerr := cloud.RemoveUpOperation(cfgDir, op.ID); rerr != nil {
		fmt.Fprintf(o.stderr, "note: could not remove the finished operation record %s: %v\n", op.ID, rerr)
	}
	if !o.json {
		// Keep stdout machine-composable: `relayium up ... | pbcopy` must copy
		// only the link, and stdout is the ONE place the key is printed. The
		// human hint on stderr deliberately does not repeat it: stderr is what
		// ends up in logs, CI output and pasted bug reports, and a ready-made
		// `down '<link>'` command would also put the key into the next
		// process's argument list. `down -` reads the link from standard input.
		fmt.Fprintln(o.stderr, "opens in a browser, or fetch it with `relayium down -`, piping the link in (for example: pbpaste | relayium down -)")
	}
	if notice := truncatedTTLNotice(ttl, expiresAt, time.Now().Unix()); notice != "" {
		fmt.Fprintln(o.stderr, notice)
	}
	return 0
}

// upRecover asks the server for the outcome of a recorded operation. It never
// uploads: a server that wants the body gets none, and the outcome stays
// unknown with the record kept.
func upRecover(id, configDir string, out upOutput) int {
	cfgDir, err := resolveConfigDir(configDir)
	if err != nil {
		return out.fail("config_dir_unresolved", err)
	}
	if !cloud.ValidUpOperationID(id) {
		return out.fail("no_such_operation", cloud.ErrUpOperationNotFound)
	}
	lock, err := cloud.LockUpOperation(cfgDir, id)
	if err != nil {
		if errors.Is(err, cloud.ErrUpOperationBusy) {
			return out.fail("operation_busy", err)
		}
		return out.fail("operation_unusable", err)
	}
	defer lock.Release()
	op, err := cloud.LoadUpOperation(cfgDir, id)
	switch {
	case errors.Is(err, cloud.ErrUpOperationNotFound):
		_ = cloud.RemoveUpOperation(cfgDir, id) // only the lock file just created
		return out.fail("no_such_operation", err)
	case err != nil:
		return out.fail("operation_unusable", err)
	}
	creds, ok, err := cloud.Load(cfgDir)
	if err != nil {
		return out.fail("credential_unreadable", err)
	}
	if !ok {
		return out.fail("not_logged_in", fmt.Errorf("run `relayium login` to the same account (%s) and server (%s) first; the operation is kept", op.Account, op.Server))
	}
	// The key the server knows the operation by is per account; the token is
	// sent only to the server that issued it. Anything else is refused before
	// a request, and the record is kept.
	if !sameServer(op.Server, creds.Server) || !strings.EqualFold(op.Account, creds.AccountEmail) {
		return out.fail("different_account", fmt.Errorf("operation %s belongs to %s on %s, but this machine is logged in as %s on %s; nothing was sent and the operation is kept",
			id, op.Account, op.Server, creds.AccountEmail, creds.Server))
	}
	client := cloud.NewClient(op.Server)
	client.Token = creds.AccessToken
	res, err := client.RecoverUpload(context.Background(), op.OpKey, op.Opts(), op.BodyLength)
	if err != nil {
		var unk *cloud.UploadRecoveryUnknownError
		if errors.As(err, &unk) {
			return out.unknown(id, err)
		}
		return out.fail("recover_failed", err)
	}
	switch res.State {
	case cloud.RecoveredCommitted:
		return out.uploaded(cfgDir, op, client.DownloadLink(op.Server, res.ID, op.ContentKey), res.ID, res.ExpiresAt, op.TTLSeconds)
	case cloud.RecoveredGone:
		// Proven: it was stored and no longer exists. Nothing to recover.
		_ = cloud.RemoveUpOperation(cfgDir, id)
		msg := "the upload did arrive, but it no longer exists (it expired, was deleted, or its download limit was used); it is not uploaded again"
		if out.json {
			out.emit(upDoc{Status: "gone", Operation: id, Error: "gone", Message: msg})
		}
		fmt.Fprintln(out.stderr, msg)
		return 1
	default:
		msg := "the server knows this operation's key for a different request, so this record does not describe what was sent; it is kept for inspection and nothing was uploaded"
		if out.json {
			out.emit(upDoc{Status: "conflict", Operation: id, Error: "conflict", Message: msg})
		}
		fmt.Fprintln(out.stderr, msg)
		return 1
	}
}

// upPending lists recorded operations, without their keys.
func upPending(configDir string, out upOutput) int {
	cfgDir, err := resolveConfigDir(configDir)
	if err != nil {
		return out.fail("config_dir_unresolved", err)
	}
	list, err := cloud.ListUpOperations(cfgDir)
	if err != nil {
		return out.fail("list_failed", err)
	}
	if out.json {
		if list == nil {
			list = []cloud.UpOperationSummary{}
		}
		out.emit(upDoc{Status: "pending", Pending: list})
		return 0
	}
	if len(list) == 0 {
		fmt.Fprintln(out.stdout, "no uploads with an unknown outcome")
		return 0
	}
	for _, s := range list {
		if s.Problem != "" {
			fmt.Fprintf(out.stdout, "%s  unusable: %s\n", s.ID, s.Problem)
			continue
		}
		fmt.Fprintf(out.stdout, "%s  %s  %d file(s), %d bytes  %s  %s\n", s.ID,
			time.Unix(s.CreatedAt, 0).UTC().Format(time.RFC3339), s.Files, s.Bytes, s.Account, s.Server)
	}
	return 0
}
