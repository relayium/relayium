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
	// TransferProgress reports file-body bytes and completed or skipped files.
	// The receiver's final result still determines whether the sync succeeded.
	TransferProgress func(TransferProgress)
	Sync             bool // sync mode: set Hello.Sync and honor the receiver's Skip
	Delete           bool // mirror: set Hello.Delete
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

	// A probe must receive the actual empty transaction's confirmation.
	checkResult bool
}

// TransferProgress is a snapshot of the current scan or send.
type TransferProgress struct {
	Path           string
	FilesDone      int
	FilesTotal     int
	BytesDone      int64
	BytesTotal     int64
	AwaitingResult bool
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
	paged := opts.Sync && NeedsPagedSync(len(m.Files))
	if paged && len(m.Files) > MaxSyncFiles {
		return Report{}, fmt.Errorf("sync contains %d files; the maximum is %d per run", len(m.Files), MaxSyncFiles)
	}
	contentCheck := opts.Sync && (paged || opts.ContentCheck || opts.RequireContentCheck || (opts.Delete && opts.RequireDeleteReport))
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
	strict := opts.Sync && (paged || opts.RequireContentCheck || (opts.Delete && opts.RequireDeleteReport))
	if strict {
		if err := preflight(rw, opts, paged); err != nil {
			return Report{}, err
		}
	}
	hello := Hello{Version: WireVersion, Mode: "push", Sync: opts.Sync, Delete: opts.Delete, ResumeProof: true, ContentCheck: contentCheck}
	if paged {
		hello.ManifestFiles = len(m.Files)
	}
	if err := WriteJSON(rw, MsgHello, hello); err != nil {
		return Report{}, err
	}
	if paged {
		if err := writeManifestPages(rw, m); err != nil {
			return Report{}, err
		}
	} else if err := WriteJSON(rw, MsgManifest, m); err != nil {
		return Report{}, err
	}

	// The receiver may refuse here (manifest cap, one-shot collision) with a
	// MsgError frame instead of the resume state, so check the frame type before
	// decoding rather than mistaking a refusal for an empty resume.
	var rs ResumeState
	if err := readSyncResponse(rw, paged || opts.checkResult, MsgResume, &rs); err != nil {
		return Report{}, err
	}
	offsets := make([]int64, len(m.Files))
	for _, e := range rs.Entries {
		if e.Index >= 0 && e.Index < len(offsets) {
			if e.Have < 0 || e.Have > m.Files[e.Index].Size {
				return Report{}, fmt.Errorf("receiver returned an invalid resume offset for file %d", e.Index)
			}
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
			if paged || opts.RequireContentCheck {
				return Report{}, ErrContentCheckUnsupported
			}
			if opts.Delete && opts.RequireDeleteReport {
				return Report{}, ErrDeleteReportUnsupported
			}
			rep.ContentCheckUnconfirmed = true
		}
	}
	progress := TransferProgress{FilesTotal: len(m.Files)}
	if opts.TransferProgress != nil {
		for i, file := range m.Files {
			if !skip[i] {
				progress.BytesTotal += file.Size - offsets[i]
			}
		}
		opts.TransferProgress(progress)
	}
	var buf []byte
	for i, f := range m.Files {
		if skip[i] {
			rep.Skipped++
		} else {
			if buf == nil {
				buf = make([]byte, 192<<10)
			}
			progress.Path = f.Path
			if err := sendFile(rw, i, f, srcs[i], offsets[i], rs.ResumeProof, opts, buf, &progress); err != nil {
				return rep, err
			}
			rep.Files++
			rep.Bytes += f.Size
		}
		if opts.TransferProgress != nil {
			progress.Path = ""
			progress.FilesDone = i + 1
			opts.TransferProgress(progress)
		}
	}
	if opts.TransferProgress != nil {
		progress.AwaitingResult = true
		opts.TransferProgress(progress)
	}

	// Read the final result (a late refusal still arrives as MsgError).
	var res Result
	if err := readSyncResponse(rw, paged || opts.checkResult, MsgResult, &res); err != nil {
		return rep, err
	}
	rep.Failed = res.Failed
	if opts.checkResult && (!res.OK || len(res.Failed) != 0) {
		return rep, fmt.Errorf("receiver did not confirm the sync check")
	}
	if paged {
		last := -1
		for _, index := range res.FailedIndices {
			if index <= last || index >= len(m.Files) || skip[index] {
				return rep, fmt.Errorf("receiver returned an invalid failed file index: %d", index)
			}
			rep.Failed = append(rep.Failed, m.Files[index].Path)
			last = index
		}
		if res.OK != (len(rep.Failed) == 0) {
			return rep, fmt.Errorf("receiver did not confirm the large sync")
		}
	}
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
func sendFile(rw io.ReadWriter, i int, f FileEntry, src string, offset int64, proof bool, opts SendOpts, buf []byte, progress *TransferProgress) error {
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
			progress.BytesTotal += offset
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
			if opts.TransferProgress != nil {
				progress.BytesDone += int64(n)
				opts.TransferProgress(*progress)
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
func preflight(rw io.ReadWriter, opts SendOpts, paged bool) error {
	if err := WriteJSON(rw, MsgHello, Hello{Version: WireVersion, Mode: "push", Sync: true, ResumeProof: true, ContentCheck: true, Preflight: true, PagedManifest: paged}); err != nil {
		return err
	}
	if err := WriteJSON(rw, MsgManifest, Manifest{}); err != nil {
		return err
	}
	var rs ResumeState
	if err := readSyncResponse(rw, paged, MsgResume, &rs); err != nil {
		return err
	}
	if paged && !rs.PagedManifest {
		return ErrLargeSyncUnsupported
	}
	if rs.Preflight && rs.ContentCheck && (rs.DeleteReport || !(opts.Delete && opts.RequireDeleteReport)) {
		return nil
	}
	if opts.RequireContentCheck && !rs.ContentCheck {
		return ErrContentCheckUnsupported
	}
	return ErrDeleteReportUnsupported
}

// CheckSync verifies sync capability on an authorized connection without
// transmitting a source manifest, replacing a file or requesting deletion.
func CheckSync(rw io.ReadWriter, fileCount int, opts SendOpts) (Report, error) {
	paged := NeedsPagedSync(fileCount)
	if paged || opts.RequireContentCheck || (opts.Delete && opts.RequireDeleteReport) {
		if err := preflight(rw, opts, paged); err != nil {
			return Report{}, err
		}
	}
	// Complete the empty transaction to release the listener cleanly. This
	// also works on receivers which predate capability questions.
	return Send(rw, Manifest{}, nil, SendOpts{Sync: true, ContentCheck: true, checkResult: true})
}
