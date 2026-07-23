package main

import "testing"

// 节点每 30 秒把 fleet bearer token 发给中心，心跳响应里回的是 TURNSecret。
// `-central-url` 少写一个 s 不会有任何症状——节点照常工作，凭据照常明文过网。
// 所以这个错误必须在启动时就拦住，而不是留给抓包的人去发现。
func TestCentralURLMustBeHTTPS(t *testing.T) {
	for _, ok := range []string{
		"https://relayium.com",
		"https://central.example:8443",
		"http://localhost:8080", // 本机开发
		"http://127.0.0.1:8080", // 同机部署
		"http://[::1]:8080",
	} {
		if err := requireSecureCentral(ok); err != nil {
			t.Errorf("requireSecureCentral(%q) = %v, want nil", ok, err)
		}
	}
	for _, bad := range []string{
		"http://relayium.com",
		"http://10.0.0.5:8080", // 内网也不行：内网同样有人能抓包
		"http://central.example",
		"ftp://relayium.com",
		"://nonsense",
	} {
		if err := requireSecureCentral(bad); err == nil {
			t.Errorf("requireSecureCentral(%q) = nil, want an error", bad)
		}
	}
}
