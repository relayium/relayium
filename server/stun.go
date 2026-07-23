package main

import "strings"

// defaultSTUNFrom 决定 /api/ice 下发给每个浏览器的 STUN 列表。
//
// 以前这里的默认值是 stun.l.google.com。STUN 的作用是让浏览器问"我的公网地址是
// 什么"，所以那个默认值意味着：**每一次局域网传输，用户的浏览器都要先向 Google 报
// 一次到，带着公网 IP 和会话时序**。对一个把"服务器看不到你的文件"写在首页上的产品，
// 这是最容易被指出来的自相矛盾——文件确实没经过我们，但连接元数据经过了第三方。
//
// 现在的规则：
//   - 显式配了 -stun-urls，就用它（想继续用公共 STUN 也可以，是个明确的选择）；
//   - 没配但配了 TURN，就用 TURN 那台机器：coturn 在同一个 host:port 上本来就应答
//     STUN Binding，不需要多跑一个服务，也不需要多开一个端口；
//   - 两个都没配，就返回空。空列表不是故障：局域网靠 host 候选就能连，跨网络本来
//     就需要 TURN 才成立。宁可少一条 srflx 候选，也不默认把用户介绍给第三方。
func defaultSTUNFrom(stun, turn []string) []string {
	if len(stun) > 0 {
		return stun
	}
	var out []string
	seen := map[string]bool{}
	for _, u := range turn {
		// turn:host:3478 / turns:host:5349?transport=tcp → stun:host:3478
		hostport := u
		if i := strings.Index(hostport, ":"); i >= 0 {
			scheme := hostport[:i]
			if scheme != "turn" && scheme != "turns" {
				continue
			}
			hostport = hostport[i+1:]
		}
		if i := strings.IndexAny(hostport, "?"); i >= 0 {
			hostport = hostport[:i]
		}
		if hostport == "" {
			continue
		}
		s := "stun:" + hostport
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
