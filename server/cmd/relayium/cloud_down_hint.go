package main

import (
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/relayium/relayium/internal/cloud"
	"github.com/relayium/relayium/internal/termtext"
)

// No claim is accepted here: recovery guidance must never echo its secret key.
func printDownCollisionHint(w io.Writer, err error, destDir string, serverOverride bool) {
	var collision *cloud.DestinationExistsError
	if !errors.As(err, &collision) {
		return
	}
	fmt.Fprintln(w, "No files were downloaded or replaced.")
	fmt.Fprintln(w, "Back up or rename the existing path, then retry (choose an unused backup name):")
	// Escaped terminal text is not the original filesystem path. Do not offer a
	// copyable command that would act on a different name or forge output lines.
	if termtext.Safe(collision.Path) == collision.Path {
		if runtime.GOOS == "windows" {
			fmt.Fprintf(w, "  PowerShell: Move-Item -LiteralPath %s -Destination %s -Confirm\n", downHintQuote(collision.Path), downHintQuote(collision.Path+".bak"))
		} else {
			fmt.Fprintf(w, "  mv -i %s %s\n", downHintQuote(collision.Path), downHintQuote(collision.Path+".bak"))
		}
	}
	fmt.Fprintln(w, "Or download into a different, empty directory:")
	// An absolute path cannot be parsed as an option, even if destDir starts
	// with a dash. Keep the new directory under the selected destination.
	alternative, absErr := filepath.Abs(filepath.Join(destDir, "download-new"))
	if absErr == nil && termtext.Safe(alternative) == alternative {
		command := "relayium down"
		if serverOverride {
			command += " --server '<server-url>'"
		}
		fmt.Fprintf(w, "  %s '<link-or-code>' %s\n", command, downHintQuote(alternative))
	}
	fmt.Fprintln(w, "Replace <link-or-code> with the original link or code; keep your --server URL if supplied.")
}

// Commands use POSIX shell syntax on Unix and PowerShell syntax on Windows.
func downHintQuote(s string) string {
	if runtime.GOOS == "windows" {
		return "'" + strings.ReplaceAll(s, "'", "''") + "'"
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
