package main

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/relayium/relayium/internal/cloud"
)

func upPaused(out upOutput, id string, err error) int {
	if out.json {
		out.emit(upDoc{Status: "paused", Operation: id, Error: "resumable_upload_stopped", Message: err.Error()})
	}
	fmt.Fprintln(out.stderr, "Upload stopped:", err)
	fmt.Fprintf(out.stderr, "Encrypted copy and operation %s kept; `relayium up --resume %s` checks it and continues the same session.\n", id, id)
	return exitUpUnknown
}

func upResumable(dir string, client *cloud.Client, p *cloud.PreparedUpload, op cloud.UpOperation, out upOutput) int {
	lock, err := cloud.LockUpOperation(dir, op.ID)
	if err != nil {
		return out.fail("operation_busy", err)
	}
	defer lock.Release()
	fmt.Fprintln(out.stderr, "Preparing an encrypted local copy for resumable upload.")
	if err = cloud.SpoolUpOperation(dir, &op, p); err != nil {
		return out.fail("spool_failed", err)
	}
	if err = cloud.SaveUpOperation(dir, op); err != nil {
		if _, e := cloud.LoadUpOperation(dir, op.ID); e == nil {
			return upPaused(out, op.ID, err)
		}
		_ = cloud.RemoveUpSpool(dir, op.ID)
		return out.fail("record_failed", err)
	}
	fmt.Fprintf(out.stderr, "Resumable operation: %s\n", op.ID)
	return finishResumable(dir, client, op, out)
}

func upResume(id, configDir string, out upOutput, discard bool) int {
	dir, err := resolveConfigDir(configDir)
	if err != nil {
		return out.fail("config_dir_unresolved", err)
	}
	lock, err := cloud.LockUpOperation(dir, id)
	if err != nil {
		return out.fail("operation_busy", err)
	}
	defer lock.Release()
	op, err := cloud.LoadUpOperation(dir, id)
	if err != nil {
		return out.fail("operation_unusable", err)
	}
	if op.Version != 2 {
		return out.fail("use_recover", fmt.Errorf("legacy upload: use `relayium up --recover %s`", id))
	}
	if discard {
		if err = cloud.RemoveUpOperation(dir, id); err != nil {
			return out.fail("cleanup_failed", err)
		}
		if err = cloud.RemoveUpSpool(dir, id); err != nil {
			return out.fail("cleanup_failed", err)
		}
		if out.json {
			out.emit(upDoc{Status: "discarded", Operation: id})
		} else {
			fmt.Fprintln(out.stdout, "local encrypted copy and record discarded")
		}
		return 0
	}
	creds, ok, err := cloud.Load(dir)
	if err != nil {
		return out.fail("credential_unreadable", err)
	}
	if !ok {
		return out.fail("not_logged_in", errors.New("log in to the recorded account first; encrypted copy kept"))
	}
	if !sameServer(op.Server, creds.Server) || !strings.EqualFold(op.Account, creds.AccountEmail) {
		return out.fail("different_account", errors.New("operation belongs to a different account or server; nothing sent and copy kept"))
	}
	client := cloud.NewClient(creds.Server)
	client.Token = creds.AccessToken
	return finishResumable(dir, client, op, out)
}

func finishResumable(dir string, client *cloud.Client, op cloud.UpOperation, out upOutput) int {
	bar := newProgressBar(out.stderr, "⇡", "Uploading ciphertext")
	client.Progress = bar.update
	id, expires, err := client.ResumeUpOperation(context.Background(), dir, &op)
	bar.finish()
	if err != nil {
		return upPaused(out, op.ID, err)
	}
	return out.uploaded(dir, op, client.DownloadLink(client.Server, id, op.ContentKey), id, expires, op.TTLSeconds)
}
