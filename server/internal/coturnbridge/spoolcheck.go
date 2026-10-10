package coturnbridge

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// SpoolReport is a read-only inventory of a spool directory for operators:
// what is held, what the last status said, and why an older bridge binary
// must not be installed on it.
type SpoolReport struct {
	Dir             string   `json:"dir"`
	PrimaryRecords  int      `json:"primaryRecords"`
	OverflowRecords int      `json:"overflowRecords"`
	DeadFiles       int      `json:"deadFiles"`
	CorruptFiles    int      `json:"corruptFiles"`
	GoneMarks       int      `json:"goneMarks"`
	TempFiles       int      `json:"tempFiles"`
	QuarantineBytes int64    `json:"quarantineBytes"`
	StatusFound     bool     `json:"statusFound"`
	Status          *Status  `json:"status,omitempty"`
	Blockers        []string `json:"downgradeBlockers"`
}

// CheckSpool inventories dir without taking the lock and without changing
// anything. Downgrade blockers: records in overflow/ (an older binary does
// not read that tier), the last status's own blockers (refusal or loss
// counters, at-risk, records awaiting an operator), or no readable status.
func CheckSpool(dir string) (SpoolReport, error) {
	r := SpoolReport{Dir: dir, Blockers: []string{}}
	count := func(sub string, rec bool) (int, error) {
		ents, err := os.ReadDir(filepath.Join(dir, sub))
		if os.IsNotExist(err) {
			return 0, nil
		}
		if err != nil {
			return 0, err
		}
		n := 0
		for _, e := range ents {
			if e.IsDir() {
				continue
			}
			if strings.HasPrefix(e.Name(), tmpPrefix) {
				r.TempFiles++
				continue
			}
			if !rec || strings.HasSuffix(e.Name(), spoolExt) {
				n++
			}
		}
		return n, nil
	}
	var err error
	if r.PrimaryRecords, err = count("", true); err != nil {
		return r, err
	}
	if r.OverflowRecords, err = count(overflowSD, true); err != nil {
		return r, err
	}
	if r.DeadFiles, err = count("dead", false); err != nil {
		return r, err
	}
	if r.CorruptFiles, err = count("corrupt", false); err != nil {
		return r, err
	}
	if r.GoneMarks, err = count("gone", true); err != nil {
		return r, err
	}
	if fi, err := os.Stat(filepath.Join(dir, "quarantine.jsonl")); err == nil {
		r.QuarantineBytes = fi.Size()
	}
	if raw, err := readBounded(filepath.Join(dir, "status.json"), 64<<20); err == nil {
		var st Status
		if json.Unmarshal(raw, &st) == nil {
			r.StatusFound, r.Status = true, &st
			r.Blockers = append(r.Blockers, st.DowngradeBlockers...)
		}
	}
	if !r.StatusFound {
		r.Blockers = append(r.Blockers, "no readable status.json: refusal/loss state unknown")
	}
	if r.OverflowRecords > 0 {
		r.Blockers = append(r.Blockers, fmt.Sprintf("overflow/ holds %d records on disk", r.OverflowRecords))
	}
	return r, nil
}
