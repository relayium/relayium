package xfer

import (
	"encoding/json"
	"fmt"
	"io"
	"time"
)

type syncCheckProgress struct {
	Done int
}

// Progress frames are emitted from the scan itself, including during a
// large file's hash. A failed write aborts the scan and releases its lock.
func syncCheckReporter(w io.Writer, total int) func(int) error {
	var next time.Time
	return func(done int) error {
		now := time.Now()
		if done != total && now.Before(next) {
			return nil
		}
		next = now.Add(5 * time.Second)
		return WriteJSON(w, MsgSyncProgress, syncCheckProgress{Done: done})
	}
}

type checkProgressReader struct {
	io.Reader
	pulse func() error
}

func (r checkProgressReader) Read(p []byte) (int, error) {
	if err := r.pulse(); err != nil {
		return 0, err
	}
	return r.Reader.Read(p)
}

func readSyncResume(r io.Reader, strict bool, total int, requested bool, progress func(int, int), rs *ResumeState) error {
	last := 0
	for {
		typ, payload, err := ReadFrame(r)
		if err != nil {
			return err
		}
		if typ != MsgSyncProgress {
			return decodeSyncResponse(typ, payload, strict, MsgResume, rs)
		}
		if !requested {
			return fmt.Errorf("receiver sent verification progress without a request")
		}
		var update syncCheckProgress
		if err := json.Unmarshal(payload, &update); err != nil {
			return err
		}
		if update.Done < last || update.Done > total {
			return fmt.Errorf("invalid receiver verification count: %d of %d", update.Done, total)
		}
		last = update.Done
		progress(update.Done, total)
	}
}
