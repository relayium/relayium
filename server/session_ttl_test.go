package main

import (
	"testing"
	"time"
)

// 会话没有空闲超时也没有滑动续期，所以这个绝对有效期就是"一枚泄漏的 cookie 能用多久"
// 的上限，同时也是共用设备上"忘了登出"的窗口。这条用例把它钉住，免得日后被顺手调回
// 一个更长的值而没人注意到那意味着什么。
func TestSessionTTLStaysShort(t *testing.T) {
	const want = 14 * 24 * time.Hour
	if sessionTTL != want {
		t.Fatalf("sessionTTL = %v, want %v — 拉长它等于拉长泄漏窗口，改之前先想清楚", sessionTTL, want)
	}
	if sessionTTL > 30*24*time.Hour {
		t.Error("session TTL 超过一个月：没有滑动续期的前提下，这是一枚 cookie 的完整寿命")
	}
}
