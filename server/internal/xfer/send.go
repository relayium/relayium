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
}

type Report struct {
	Files  int
	Bytes  int64
	Failed []string
}

// Send transmits the manifest's files over rw (a duplex stream, typically the
// SSH stdio pipe). srcs[i] is the local path for m.Files[i].
func Send(rw io.ReadWriter, m Manifest, srcs []string, opts SendOpts) (Report, error) {
	if err := WriteJSON(rw, MsgHello, Hello{Version: WireVersion, Mode: "push"}); err != nil {
		return Report{}, err
	}
	if err := WriteJSON(rw, MsgManifest, m); err != nil {
		return Report{}, err
	}

	// Read the receiver's resume state (empty in this task; used in Task 5).
	var rs ResumeState
	if _, err := ReadJSON(rw, &rs); err != nil {
		return Report{}, err
	}
	offsets := make([]int64, len(m.Files))
	for _, e := range rs.Entries {
		if e.Index >= 0 && e.Index < len(offsets) {
			offsets[e.Index] = e.Have
		}
	}

	var rep Report
	for i, f := range m.Files {
		if err := sendFile(rw, i, f, srcs[i], offsets[i], opts); err != nil {
			return rep, err
		}
		rep.Files++
		rep.Bytes += f.Size
	}

	// Read the final result.
	var res Result
	if _, err := ReadJSON(rw, &res); err != nil {
		return rep, err
	}
	rep.Failed = res.Failed
	return rep, nil
}

func sendFile(rw io.ReadWriter, i int, f FileEntry, src string, offset int64, opts SendOpts) error {
	file, err := os.Open(src)
	if err != nil {
		return err
	}
	defer file.Close()

	if err := WriteJSON(rw, MsgFileStart, FileStart{Index: i, Offset: offset}); err != nil {
		return err
	}
	if offset > 0 {
		if _, err := file.Seek(offset, io.SeekStart); err != nil {
			return err
		}
	}

	// Hash the whole file (from 0) while streaming the tail [offset, Size).
	h := sha256.New()
	if offset > 0 {
		head := io.NewSectionReader(file, 0, offset)
		if _, err := io.Copy(h, head); err != nil {
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
