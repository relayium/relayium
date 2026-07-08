package xfer

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/fsnotify/fsnotify"
)

// WatchDirs watches every directory under each root and calls onChange, debounced
// by the given window, whenever a file or directory under a root changes. New
// subdirectories are watched as they appear. It blocks until ctx is cancelled.
func WatchDirs(ctx context.Context, roots []string, debounce time.Duration, onChange func()) error {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	defer w.Close()

	addTree := func(root string) {
		filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err == nil && d.IsDir() {
				_ = w.Add(p)
			}
			return nil
		})
	}
	for _, r := range roots {
		abs, err := filepath.Abs(r)
		if err != nil {
			return err
		}
		addTree(abs)
	}

	fire := make(chan struct{}, 1)
	var timer *time.Timer
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev := <-w.Events:
			// Watch newly-created subdirectories too.
			if ev.Op&fsnotify.Create != 0 {
				if fi, err := os.Stat(ev.Name); err == nil && fi.IsDir() {
					addTree(ev.Name)
				}
			}
			if timer != nil {
				timer.Stop()
			}
			timer = time.AfterFunc(debounce, func() {
				select {
				case fire <- struct{}{}:
				default:
				}
			})
		case <-fire:
			onChange()
		case <-w.Errors:
			// On a watcher error, coalesce into a change so the next sync self-heals.
			select {
			case fire <- struct{}{}:
			default:
			}
		}
	}
}
