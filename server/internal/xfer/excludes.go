package xfer

import (
	"fmt"
	"path"
	"strings"
)

// Excludes contains only caller-supplied glob patterns.
type Excludes []string

// Add validates a slash-separated pattern before a walk or watcher starts.
// Patterns without a slash match a basename at any depth.
func (e *Excludes) Add(pattern string) error {
	for _, segment := range strings.Split(pattern, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return fmt.Errorf("invalid exclude pattern %q: use a relative path", pattern)
		}
	}
	if _, err := path.Match(pattern, ""); err != nil {
		return fmt.Errorf("invalid exclude pattern %q: %w", pattern, err)
	}
	*e = append(*e, pattern)
	return nil
}

func (e Excludes) matches(relative string) bool {
	for _, pattern := range e {
		name := relative
		if !strings.Contains(pattern, "/") {
			name = path.Base(relative)
		}
		if matched, _ := path.Match(pattern, name); matched {
			return true
		}
	}
	return false
}

// excludesPath also checks ancestors so a watcher event inside an excluded
// subtree has the same answer as the manifest walk that pruned that subtree.
func (e Excludes) excludesPath(relative string) bool {
	for relative != "." {
		if e.matches(relative) {
			return true
		}
		relative = path.Dir(relative)
	}
	return false
}

// Excluded counts entries skipped by explicit rules. An excluded subtree is
// counted once and its descendants are never enumerated.
type Excluded struct {
	Files       int
	Directories int
}
