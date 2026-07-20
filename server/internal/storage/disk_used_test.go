package storage

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// UsedBytes 必须只统计 store 自己目录里的东西。这正是它存在的理由：节点原先
// 用整卷 statfs 冒充"relayium 存量"，盘上装了别的程序就严重虚高。目录外的文件
// 一旦被计入，这个 bug 就原样复活了。
func TestUsedBytesCountsOnlyStoreDir(t *testing.T) {
	root := t.TempDir()
	blobDir := filepath.Join(root, "blobs")
	ds, err := NewDiskStore(blobDir)
	if err != nil {
		t.Fatalf("NewDiskStore: %v", err)
	}

	// 目录外的"其它程序数据"——绝不能被计入。
	outsider := filepath.Join(root, "someone-elses-4kb-file")
	if err := os.WriteFile(outsider, bytes.Repeat([]byte("x"), 4096), 0o600); err != nil {
		t.Fatalf("write outsider: %v", err)
	}

	ctx := context.Background()
	if _, err := ds.Put(ctx, "aabbcc", strings.NewReader(strings.Repeat("a", 100))); err != nil {
		t.Fatalf("Put aabbcc: %v", err)
	}
	if _, err := ds.Put(ctx, "ddeeff", strings.NewReader(strings.Repeat("b", 250))); err != nil {
		t.Fatalf("Put ddeeff: %v", err)
	}

	got, err := ds.UsedBytes()
	if err != nil {
		t.Fatalf("UsedBytes: %v", err)
	}
	if got != 350 {
		t.Fatalf("UsedBytes = %d, want 350 (only the two blobs; the 4096-byte file outside the store dir must not count)", got)
	}
}

// 空 store 报 0 而不是报错——节点刚装好、还没存过任何东西时会走到这条路径。
func TestUsedBytesEmptyStore(t *testing.T) {
	ds, err := NewDiskStore(filepath.Join(t.TempDir(), "blobs"))
	if err != nil {
		t.Fatalf("NewDiskStore: %v", err)
	}
	got, err := ds.UsedBytes()
	if err != nil {
		t.Fatalf("UsedBytes: %v", err)
	}
	if got != 0 {
		t.Fatalf("UsedBytes = %d, want 0 for an empty store", got)
	}
}
