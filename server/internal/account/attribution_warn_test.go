package account

import (
	"bytes"
	"log"
	"strings"
	"testing"
)

// 跨用户伪造的既有防线对**过期/未知**的码是"无法反驳即接受"，所以持有节点凭据的人
// 仍然能给别人记账，而且整个过程完全无声。真正的修复要动计费链路（报告 M1）；在那
// 之前，这条告警是"被记了 20 TB"和"有人在记 20 TB"之间的唯一区别。
func TestWarnImplausibleAttribution(t *testing.T) {
	capture := func(fn func()) string {
		var buf bytes.Buffer
		old := log.Writer()
		log.SetOutput(&buf)
		defer log.SetOutput(old)
		fn()
		return buf.String()
	}

	t.Run("正常量级不喊", func(t *testing.T) {
		out := capture(func() {
			// 30 秒里给一个用户记 2 GiB —— 一次很大但完全真实的传输。
			warnImplausibleAttribution("n1", 3, map[string]int64{"u1": 2 << 30})
		})
		if out != "" {
			t.Fatalf("正常心跳不该告警，却输出了 %q", out)
		}
	})

	t.Run("单用户量级离谱要喊，并且点名是谁", func(t *testing.T) {
		out := capture(func() {
			warnImplausibleAttribution("n1", 2, map[string]int64{"victim": 20 << 40}) // 20 TiB
		})
		if !strings.Contains(out, "WARNING") || !strings.Contains(out, "victim") || !strings.Contains(out, "n1") {
			t.Fatalf("告警里必须同时有节点和被记账的用户，得到 %q", out)
		}
	})

	t.Run("条数离谱也要喊 —— 它比字节数更早暴露", func(t *testing.T) {
		out := capture(func() {
			warnImplausibleAttribution("n1", 7000, map[string]int64{"u1": 1})
		})
		if !strings.Contains(out, "7000") {
			t.Fatalf("条数异常没有被报出来：%q", out)
		}
	})

	t.Run("多个受害者各喊一条", func(t *testing.T) {
		out := capture(func() {
			warnImplausibleAttribution("n1", 4, map[string]int64{"a": 200 << 30, "b": 200 << 30})
		})
		if strings.Count(out, "WARNING") != 2 {
			t.Fatalf("每个被超额记账的用户都该有一条，得到 %q", out)
		}
	})
}
