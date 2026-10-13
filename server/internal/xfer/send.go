package xfer

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
)

type SendOpts struct {
	Progress func(path string, sent, total int64)
	Sync     bool // sync mode: set Hello.Sync and honor the receiver's Skip
	Delete   bool // mirror: set Hello.Delete
	// ContentCheck (sync only) puts each source file's SHA-256 in the manifest
	// and asks the receiver to skip and install by content (see content_check.go).
	// It costs one extra read of every source file before anything is sent.
	ContentCheck bool
	// RequireContentCheck makes a receiver that does not confirm content
	// checking a failure (ErrContentCheckUnsupported) before any file body is
	// sent, instead of a Report.ContentCheckUnconfirmed warning.
	RequireContentCheck bool
	// RequireDeleteReport (with Delete) makes a receiver that cannot report a
	// refused or partial delete a failure (ErrDeleteReportUnsupported) before
	// any file body is sent. Only a content-checking receiver reports it.
	RequireDeleteReport bool
}

type Report struct {
	Files        int
	Bytes        int64
	Skipped      int // sync mode: files the receiver already had, not sent
	Failed       []string
	DeleteDenied bool // sender asked for --delete but this listener isn't --allow-delete
	// DeleteRefusedReason explains a mirror-delete the receiver was permitted to
	// run but refused anyway (empty manifest, or no derivable top-level scope);
	// nothing was deleted. DeletePartial is the opposite outcome: deletion began
	// and then failed. Both are receiver-local and not carried on the wire.
	DeleteRefusedReason string
	DeletePartial       string
	// ContentChecked is set on the sending side when the receiver confirmed a
	// content-checked sync: its skips compared digests, and every installed file
	// matched the manifest digest. ContentCheckUnconfirmed is set when content
	// checking was requested and the receiver (an older relayium) did not
	// confirm it: its skips used size and modification time only.
	ContentChecked          bool
	ContentCheckUnconfirmed bool
	// DeleteRefused / DeletePartialRemote are what a content-checking receiver
	// reported about a permitted delete (sending side). DeleteOutcomeUnknown is
	// set when --delete was requested and the receiver cannot report refused or
	// partial deletes (it predates that report).
	DeleteRefused        bool
	DeletePartialRemote  bool
	DeleteOutcomeUnknown bool
}

// Send transmits the manifest's files over rw (a duplex stream, typically the
// SSH stdio pipe). srcs[i] is the local path for m.Files[i].
func Send(rw io.ReadWriter, m Manifest, srcs []string, opts SendOpts) (Report, error) {
	contentCheck := opts.Sync && (opts.ContentCheck || opts.RequireContentCheck || (opts.Delete && opts.RequireDeleteReport))
	if contentCheck && !hasAllDigests(m) {
		// Digests are computed before the first frame, so a source that cannot
		// be read fails here with nothing sent.
		dm, err := withContentDigests(m, srcs)
		if err != nil {
			return Report{}, err
		}
		m = dm
	}
	// A strict request must not reach a receiver that cannot honour it: an
	// older receiver that needs no file at all runs its delete step before the
	// sender could refuse. So the capability is asked first, with a question
	// that deletes and writes nothing (see Hello.Preflight), and the real
	// request -- with its Delete -- is sent only after the answer.
	strict := opts.Sync && (opts.RequireContentCheck || (opts.Delete && opts.RequireDeleteReport))
	if strict {
		if err := preflight(rw, opts); err != nil {
			return Report{}, err
		}
	}
	if err := WriteJSON(rw, MsgHello, Hello{Version: WireVersion, Mode: "push", Sync: opts.Sync, Delete: opts.Delete, ResumeProof: true, ContentCheck: contentCheck}); err != nil {
		return Report{}, err
	}
	if err := WriteJSON(rw, MsgManifest, m); err != nil {
		return Report{}, err
	}

	// The receiver may refuse here (manifest cap, one-shot collision) with a
	// MsgError frame instead of the resume state, so check the frame type before
	// decoding rather than mistaking a refusal for an empty resume.
	var rs ResumeState
	if err := readExpect(rw, &rs); err != nil {
		return Report{}, err
	}
	offsets := make([]int64, len(m.Files))
	for _, e := range rs.Entries {
		if e.Index >= 0 && e.Index < len(offsets) {
			offsets[e.Index] = e.Have
		}
	}
	skip := make(map[int]bool, len(rs.Skip))
	for _, i := range rs.Skip {
		skip[i] = true
	}

	var rep Report
	if contentCheck {
		if rs.ContentCheck {
			rep.ContentChecked = true
		} else {
			// The receiver ignored the request: it is older, and its Skip list was
			// decided by size and mtime. Never treat the missing echo as support.
			if opts.RequireContentCheck {
				return Report{}, ErrContentCheckUnsupported
			}
			if opts.Delete && opts.RequireDeleteReport {
				return Report{}, ErrDeleteReportUnsupported
			}
			rep.ContentCheckUnconfirmed = true
		}
	}
	for i, f := range m.Files {
		if skip[i] {
			rep.Skipped++
			continue
		}
		if err := sendFile(rw, i, f, srcs[i], offsets[i], rs.ResumeProof, opts); err != nil {
			return rep, err
		}
		rep.Files++
		rep.Bytes += f.Size
	}

	// Read the final result (a late refusal still arrives as MsgError).
	var res Result
	if err := readExpect(rw, &res); err != nil {
		return rep, err
	}
	rep.Failed = res.Failed
	rep.DeleteDenied = res.DeleteDenied
	if opts.Delete {
		if contentCheck && rs.ContentCheck {
			rep.DeleteRefused = res.DeleteRefused
			rep.DeletePartialRemote = res.DeletePartial
		} else if !res.DeleteDenied {
			rep.DeleteOutcomeUnknown = true
		}
	}
	return rep, nil
}

// sendFile streams one file. proof is the receiver's announced ability to check
// a prefix proof and answer it (ResumeState.ResumeProof); without it this sends
// exactly what it always did, because an older receiver would reject any offset
// other than the one it negotiated.
func sendFile(rw io.ReadWriter, i int, f FileEntry, src string, offset int64, proof bool, opts SendOpts) error {
	file, err := os.Open(src)
	if err != nil {
		return err
	}
	defer file.Close()

	// Hash the whole file (from 0) while streaming the tail [offset, Size). The
	// head is hashed before MsgFileStart because its digest is the prefix proof;
	// the same running hash continues over the tail, so nothing is read twice.
	h := sha256.New()
	start := FileStart{Index: i, Offset: offset}
	if offset > 0 {
		head := io.NewSectionReader(file, 0, offset)
		if _, err := io.Copy(h, head); err != nil {
			return err
		}
		if proof {
			start.PrefixSHA256 = hex.EncodeToString(h.Sum(nil)) // Sum does not consume h
		}
	}
	if err := WriteJSON(rw, MsgFileStart, start); err != nil {
		return err
	}
	if proof && offset > 0 {
		// Only the receiver can tell whether its own bytes match, and only the
		// receiver may redefine the offset it negotiated. Wait for its verdict
		// before sending anything.
		var v ResumeVerdict
		if err := readExpect(rw, &v); err != nil {
			return err
		}
		if v.Index != i {
			return fmt.Errorf("%s: resume verdict for file %d arrived while sending file %d", f.Path, v.Index, i)
		}
		if !v.Resume {
			// Not a prefix of this file: send it whole. Bounded to this one
			// restart — at offset 0 there is nothing left to disagree about.
			offset = 0
			h.Reset()
		}
	}
	if offset > 0 {
		if _, err := file.Seek(offset, io.SeekStart); err != nil {
			return err
		}
	}
	sent := offset
	buf := make([]byte, 192<<10) // 192 KiB, matching the web client's chunk size
	for {
		n, rerr := file.Read(buf)
		if n > 0 {
			if _, err := rw.Write(buf[:n]); err != nil {
				return err
			}
			h.Write(buf[:n])
			sent += int64(n)
			if opts.Progress != nil {
				opts.Progress(f.Path, sent, f.Size)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return rerr
		}
	}
	if sent != f.Size {
		return fmt.Errorf("%s: size changed during send (%d != %d)", f.Path, sent, f.Size)
	}
	return WriteJSON(rw, MsgFileHash, FileHash{Index: i, SHA256: hex.EncodeToString(h.Sum(nil))})
}

// preflight asks the receiver whether it supports content checking and delete
// reporting, without asking it to do anything. Only an explicit echo counts.
func preflight(rw io.ReadWriter, opts SendOpts) error {
	if err := WriteJSON(rw, MsgHello, Hello{Version: WireVersion, Mode: "push", Sync: true, ResumeProof: true, ContentCheck: true, Preflight: true}); err != nil {
		return err
	}
	if err := WriteJSON(rw, MsgManifest, Manifest{}); err != nil {
		return err
	}
	var rs ResumeState
	if err := readExpect(rw, &rs); err != nil {
		return err
	}
	if rs.Preflight && rs.ContentCheck && (rs.DeleteReport || !(opts.Delete && opts.RequireDeleteReport)) {
		return nil
	}
	if opts.RequireContentCheck && !rs.ContentCheck {
		return ErrContentCheckUnsupported
	}
	return ErrDeleteReportUnsupported
}
