package main

import (
	"bytes"
	"log"
	"strings"
	"testing"
)

// 这个配置错误没有任何症状：登录照常、传输照常，只是 cookie 不再带 Secure。
// 所以它只能靠启动时喊一声被发现——这几条用例守的就是"该喊的时候喊、不该喊的时候闭嘴"。
func TestWarnInsecureCookieConfig(t *testing.T) {
	cases := []struct {
		name, baseURL, addr string
		wantWarn            bool
	}{
		{"生产配置", "https://relayium.com", ":8080", false},
		{"TLS 反代后面写错成 http —— 就是要抓这个", "http://relayium.com", ":8080", true},
		{"http 但只监听 loopback：本地开发，别刷噪音", "http://localhost:8080", "127.0.0.1:8080", false},
		{"http + localhost 主机名监听", "http://localhost:8080", "localhost:8080", false},
		{"http 且监听通配地址：对外可达，要喊", "http://localhost:8080", "0.0.0.0:8080", true},
		{"http 且监听具体外网地址", "http://10.0.0.5:8080", "10.0.0.5:8080", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var buf bytes.Buffer
			old := log.Writer()
			log.SetOutput(&buf)
			defer log.SetOutput(old)

			warnInsecureCookieConfig(c.baseURL, c.addr)

			warned := strings.Contains(buf.String(), "WARNING")
			if warned != c.wantWarn {
				t.Fatalf("warned=%v want=%v (log=%q)", warned, c.wantWarn, buf.String())
			}
			if warned && !strings.Contains(buf.String(), "Secure") {
				t.Error("告警里没提到 Secure —— 读日志的人得能立刻知道丢的是什么")
			}
		})
	}
}
