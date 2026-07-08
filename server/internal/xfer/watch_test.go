package xfer

import (
	"context"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestWatchDirsDebouncesAndFires(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var fires int32
	go WatchDirs(ctx, []string{dir}, 100*time.Millisecond, func() { atomic.AddInt32(&fires, 1) })
	time.Sleep(50 * time.Millisecond) // let the watcher start

	// A burst of writes should coalesce into (about) one fire.
	for i := 0; i < 5; i++ {
		os.WriteFile(filepath.Join(dir, "f.txt"), []byte{byte(i)}, 0o644)
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(300 * time.Millisecond)
	if n := atomic.LoadInt32(&fires); n < 1 {
		t.Fatalf("expected at least one fire, got %d", n)
	}
	if n := atomic.LoadInt32(&fires); n > 3 {
		t.Fatalf("burst of writes should debounce, got %d fires", n)
	}
}
