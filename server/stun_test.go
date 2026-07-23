package main

import (
	"reflect"
	"strings"
	"testing"
)

// STUN 的作用是让浏览器问「我的公网地址是什么」。默认指向第三方，就等于每一次局域网
// 传输都先向那个第三方报到一次（公网 IP + 会话时序）——而这个产品的首页写的是
// 「服务器看不到你的文件」。文件确实没经过，连接元数据经过了。
func TestDefaultSTUNNeverPointsAtAThirdPartyByDefault(t *testing.T) {
	cases := []struct {
		name       string
		stun, turn []string
		want       []string
	}{
		{"显式配置优先", []string{"stun:my.example:3478"}, []string{"turn:other:3478"}, []string{"stun:my.example:3478"}},
		{"没配 STUN 就用自己的 TURN 机器", nil, []string{"turn:relay.example:3478"}, []string{"stun:relay.example:3478"}},
		{"turns + query 参数也能推导", nil, []string{"turns:relay.example:5349?transport=tcp"}, []string{"stun:relay.example:5349"}},
		{"多个 TURN 去重", nil, []string{"turn:a:3478", "turns:a:3478", "turn:b:3478"}, []string{"stun:a:3478", "stun:b:3478"}},
		{"两个都没配就返回空，而不是回落到公共 STUN", nil, nil, nil},
		{"忽略形状不对的条目", nil, []string{"http://nope", "turn:ok:3478"}, []string{"stun:ok:3478"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := defaultSTUNFrom(c.stun, c.turn)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("defaultSTUNFrom(%v, %v) = %v, want %v", c.stun, c.turn, got, c.want)
			}
			for _, u := range got {
				if strings.Contains(u, "google") || strings.Contains(u, "cloudflare") || strings.Contains(u, "twilio") {
					t.Errorf("derived STUN %q points at a third party", u)
				}
			}
		})
	}
}
