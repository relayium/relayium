package main

import (
	"log"
	"net"
	"strings"
)

// warnInsecureCookieConfig 在会话 cookie 会**静默**丢掉 Secure 标志时喊一声。
//
// cookieSecure() 是从 BaseURL 的 scheme 推出来的（handlers.go）。在 TLS 终止型反代
// 后面部署时，服务器自己监听的是明文，`RELAYIUM_BASE_URL` 写成 http:// 是个很自然的
// 手误——而它的后果是所有 cookie 都不带 Secure，浏览器于是愿意把会话 cookie 发到
// 明文连接上。这个故障**没有任何症状**：登录照常、传输照常，只是防降级那一层没了。
//
// 只在"BaseURL 非 https 且监听地址不是 loopback"时告警：纯本地开发（listen 在
// 127.0.0.1）是合法的 http 场景，不该每次启动都刷一条噪音。
func warnInsecureCookieConfig(baseURL, addr string) {
	if strings.HasPrefix(baseURL, "https://") || loopbackListen(addr) {
		return
	}
	log.Printf("WARNING: RELAYIUM_BASE_URL is %q (not https) while listening on %q — "+
		"session cookies will be issued WITHOUT the Secure flag. Behind a TLS-terminating "+
		"proxy this is almost always a typo: set the public https URL.", baseURL, addr)
}

// loopbackListen 判断监听地址是否只对本机可见。":8080" / "0.0.0.0:8080" 这类
// 通配地址不算——它们对外可达。
func loopbackListen(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
