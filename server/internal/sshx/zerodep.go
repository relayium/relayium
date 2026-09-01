package sshx

import (
	"archive/tar"
	"io"
	"os"
	"strings"

	"github.com/relayium/relayium/internal/xfer"
)

// WriteTarStream writes the batch as a POSIX tar to w, for the zero-dependency
// remote path (`ssh host 'tar -x -C dest'`). Member names are manifest paths.
func WriteTarStream(w io.Writer, m xfer.Manifest, srcs []string) error {
	tw := tar.NewWriter(w)
	for i, f := range m.Files {
		hdr := &tar.Header{
			Name: f.Path,
			Mode: int64(f.Mode),
			Size: f.Size,
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		in, err := os.Open(srcs[i])
		if err != nil {
			return err
		}
		if _, err := io.CopyN(tw, in, f.Size); err != nil {
			in.Close()
			return err
		}
		in.Close()
	}
	return tw.Close()
}

// RemoteUntarCmd is the remote shell command that unpacks the tar stream.
//
// The "-k" is the data-loss control, and it is why this is a short flag rather
// than the more readable --keep-old-files: -k is the spelling GNU tar, bsdtar
// and busybox tar all accept, and the remote's tar is whatever that machine
// happens to have. Without it, extraction silently overwrites files that were
// already on the receiver — which push must never do, and which the Relayium
// remote path (a receiver that skips or resumes per file) never did.
//
// What -k does NOT give us is an all-or-nothing batch. tar extracts members in
// stream order, so a collision on the tenth file happens after the first nine
// were already written, and the receiver is left holding part of this batch.
// The two tars also disagree on how loudly they say so: GNU tar reports the
// collision and exits non-zero, while bsdtar keeps the existing file and still
// exits 0, so a silent skip is a real outcome the sender cannot detect. Callers
// must describe it that way rather than claiming a verified, resumable copy.
func RemoteUntarCmd(destPath string) string {
	q := ShellQuote(destPath)
	return "mkdir -p " + q + " && tar -x -k -C " + q
}

// ShellQuote wraps s in single quotes, escaping embedded single quotes, so it
// is safe to interpolate into a remote /bin/sh command line.
func ShellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
