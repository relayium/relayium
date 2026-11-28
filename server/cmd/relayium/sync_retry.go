package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"syscall"
	"time"

	"github.com/relayium/relayium/internal/xfer"
)

const syncReconnectLimit = 8

var syncReconnectInitial = time.Second

// Mark transport errors at their source so an error reading a local file
// cannot be mistaken for a dropped connection.
type syncTransport struct{ io.ReadWriteCloser }

type syncTransportError struct{ error }

func (e syncTransportError) Unwrap() error { return e.error }

func (c syncTransport) Read(p []byte) (int, error) {
	n, err := c.ReadWriteCloser.Read(p)
	if err != nil {
		return n, syncTransportError{err}
	}
	return n, nil
}

func (c syncTransport) Write(p []byte) (int, error) {
	n, err := c.ReadWriteCloser.Write(p)
	if err != nil {
		return n, syncTransportError{err}
	}
	return n, nil
}

func (c syncTransport) Close() error {
	abortRaw(c.ReadWriteCloser)
	return nil
}

func retrySyncBatch(ctx context.Context, drain time.Duration, continuing bool, dest, configDir string, m xfer.Manifest,
	paths []string, opts xfer.SendOpts, stderr io.Writer) (xfer.Report, error) {
	delay := syncReconnectInitial
	receiverResponded := continuing
	checkProgress := opts.ReceiverCheckProgress
	fmt.Fprintln(stderr, "Connecting and checking the receiver's existing files...")
	for attempt := 0; ; attempt++ {
		if ctx.Err() != nil {
			return xfer.Report{}, errTransferInterrupted
		}
		var rep xfer.Report
		tconn, err := dialDaemonContext(ctx, dest, configDir, stderr)
		dialing := err != nil
		if !dialing {
			sendProgress := syncProgress(stderr, "Sending")
			opts.TransferProgress = func(p xfer.TransferProgress) {
				receiverResponded = true
				sendProgress(p)
			}
			opts.ReceiverCheckProgress = func(done, total int) {
				receiverResponded = true
				if checkProgress != nil {
					checkProgress(done, total)
				}
			}
			rep, err = sendWithShutdown(ctx, syncTransport{tconn}, m, paths, opts, drain)
			abortRaw(tconn)
		}
		if ctx.Err() != nil && err != nil {
			return rep, errTransferInterrupted
		}
		if err == nil {
			return rep, nil
		}
		if attempt == 0 && !receiverResponded {
			if dialing && errors.Is(err, syscall.ECONNREFUSED) {
				return rep, err
			}
			if !dialing && errors.Is(err, io.EOF) {
				return rep, fmt.Errorf("receiver closed before confirming the sync; check that it authorized this host and run sync --check: %w", err)
			}
		}
		retryable := retryableSyncError(err, dialing)
		if opts.Delete || !retryable {
			if opts.Delete && retryable && !dialing {
				return rep, fmt.Errorf("sync with --delete was interrupted; check the receiver's result before rerunning: %w", err)
			}
			return rep, err
		}
		if attempt == syncReconnectLimit {
			return rep, fmt.Errorf("sync could not reconnect and finish after %d retries; check the receiver and rerun the same command to resume: %w", attempt, err)
		}
		fmt.Fprintf(stderr, "Sync interrupted (%s). Reconnecting in %s (retry %d/%d); this batch will resume when possible.\n",
			termSafe(err.Error()), delay, attempt+1, syncReconnectLimit)
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return rep, errTransferInterrupted
		case <-timer.C:
		}
		delay = min(2*delay, 30*time.Second)
	}
}

func retryableSyncError(err error, dialing bool) bool {
	var remote *xfer.RemoteError
	if errors.As(err, &remote) {
		return remote.Code == xfer.ErrCodeSyncBusy
	}
	var transport syncTransportError
	if !dialing && !errors.As(err, &transport) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return false
	}
	// DNS names that do not exist, pin/authentication errors, and protocol
	// refusals do not become valid by reconnecting.
	var ne net.Error
	return (errors.As(err, &ne) && ne.Timeout()) ||
		errors.Is(err, os.ErrDeadlineExceeded) ||
		errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.ECONNRESET) ||
		errors.Is(err, syscall.EPIPE) || (!dialing && (errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)))
}
