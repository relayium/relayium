package main

import "testing"

// 服务端对超出档位留存上限的 TTL 是静默截断的（files.go / uploads_resumable.go
// 直接 ttl = capSecs，不报错也不在响应里说明）。网页端已经改成按档位过滤有效期
// 选项，但 CLI 没有那层 UI —— `relayium up --ttl 7d` 在免费档上照样只留 1 天，
// 而用户拿到的输出里没有任何迹象。唯一的线索是响应里的 expiresAt 就是截断后的
// 真实值，所以 CLI 必须拿它跟请求值对一次。
func TestTruncatedTTLNotice(t *testing.T) {
	const now = int64(1_000_000)

	t.Run("silent when the server honored the request", func(t *testing.T) {
		// 要 7 天，给 7 天：不该打扰用户。
		if got := truncatedTTLNotice(7*86400, now+7*86400, now); got != "" {
			t.Fatalf("want no notice, got %q", got)
		}
	})

	t.Run("warns when the plan cap cut the request down", func(t *testing.T) {
		// 免费档：要 7 天，实际只给 1 天。
		got := truncatedTTLNotice(7*86400, now+86400, now)
		if got == "" {
			t.Fatal("want a notice when the granted TTL is shorter than requested")
		}
		// 提示必须同时说明"要了多久"和"实际多久"，否则用户无从判断差多少。
		for _, want := range []string{"7d", "1d"} {
			if !contains(got, want) {
				t.Fatalf("notice %q must mention %q", got, want)
			}
		}
	})

	t.Run("silent when no TTL was requested", func(t *testing.T) {
		// 没传 --ttl 时服务端用自己的默认值，那不算截断，不该报警。
		if got := truncatedTTLNotice(0, now+3600, now); got != "" {
			t.Fatalf("want no notice without an explicit --ttl, got %q", got)
		}
	})

	t.Run("silent when the server did not report an expiry", func(t *testing.T) {
		// 老服务端不返回 expiresAt：无从比较，保持安静而不是瞎报。
		if got := truncatedTTLNotice(7*86400, 0, now); got != "" {
			t.Fatalf("want no notice without expiresAt, got %q", got)
		}
	})

	t.Run("tolerates small clock skew", func(t *testing.T) {
		// 客户端与服务端时钟差几秒是常态；用秒级严格小于会让每一次上传都报警。
		if got := truncatedTTLNotice(86400, now+86400-5, now); got != "" {
			t.Fatalf("5s of skew must not trigger a notice, got %q", got)
		}
	})
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}
