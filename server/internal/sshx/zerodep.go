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
func RemoteUntarCmd(destPath string) string {
	q := ShellQuote(destPath)
	return "mkdir -p " + q + " && tar -x -C " + q
}

// ShellQuote wraps s in single quotes, escaping embedded single quotes, so it
// is safe to interpolate into a remote /bin/sh command line.
func ShellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
