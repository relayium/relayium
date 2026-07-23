package signal

import (
	"strings"
	"testing"
)

func TestPairRegistryMintValidate(t *testing.T) {
	clock := int64(1000)
	now := func() int64 { return clock }
	r := NewPairRegistry(300, now)

	code, exp := r.MintFor("u")
	if len(code) != CodeLen {
		t.Fatalf("code = %q, want %d characters", code, CodeLen)
	}
	if !ValidCodeFormat(code) {
		t.Fatalf("minted code %q is outside the alphabet", code)
	}
	if exp != 1300 {
		t.Fatalf("exp = %d, want 1300", exp)
	}
	if !r.Validate(code) {
		t.Fatal("freshly minted code should validate")
	}
	if r.Validate("ACDEFH-bogus") || r.Validate("999999") {
		t.Fatal("unknown code must not validate")
	}

	// Expire it.
	clock = 1300
	if r.Validate(code) {
		t.Fatal("code at exact expiry must be invalid")
	}
}

func TestPairRegistryMintUnique(t *testing.T) {
	clock := int64(1)
	r := NewPairRegistry(300, func() int64 { return clock })
	seen := map[string]bool{}
	for i := 0; i < 500; i++ {
		c, _ := r.MintFor("u")
		if seen[c] {
			t.Fatalf("Mint returned a live duplicate: %s", c)
		}
		seen[c] = true
	}
}

func TestPairRegistryReapDropsExpired(t *testing.T) {
	clock := int64(1000)
	r := NewPairRegistry(300, func() int64 { return clock })
	code, _ := r.MintFor("u")
	clock = 2000
	r.reap()
	r.mu.Lock()
	_, present := r.codes[code]
	r.mu.Unlock()
	if present {
		t.Fatal("reap should delete an expired code")
	}
}

func TestPairRegistryOwner(t *testing.T) {
	var clock int64 = 1000
	r := NewPairRegistry(60, func() int64 { return clock })

	code, exp := r.MintFor("user-abc")
	if exp != 1060 {
		t.Fatalf("exp = %d, want 1060", exp)
	}
	owner, ok := r.OwnerOf(code)
	if !ok || owner != "user-abc" {
		t.Fatalf("OwnerOf = (%q,%v), want (user-abc,true)", owner, ok)
	}
	if !r.Validate(code) {
		t.Fatalf("Validate should be true for a live code")
	}
	// After expiry: no owner, not valid.
	clock = 1060
	if owner, ok := r.OwnerOf(code); ok || owner != "" {
		t.Fatalf("expired OwnerOf = (%q,%v), want ('',false)", owner, ok)
	}
	if r.Validate(code) {
		t.Fatalf("Validate should be false after expiry")
	}
	// Unknown code.
	if _, ok := r.OwnerOf("A2C4E6"); ok {
		t.Fatalf("OwnerOf unknown code should be false")
	}
}

// 字母表本身是一个安全决定，钉住它。被剔掉的字符只要有人加回来，就重新引入一次
// 「看错一位 → 加入失败」；而放宽字母表是最容易在后续改动里悄悄发生的事。
func TestCodeAlphabet(t *testing.T) {
	if CodeAlphabet != "ACDEFHJKMNPRTWXY23456789" {
		t.Fatalf("alphabet changed: %q — read the reasoning above CodeAlphabet first", CodeAlphabet)
	}
	// 每一对易混字符至少有一个不在集合里。两边都在，用户抄错的那一位就无从分辨。
	for _, pair := range []string{"B8", "G6", "S5", "Z2", "QO", "UV", "I1", "L1", "O0"} {
		a, b := rune(pair[0]), rune(pair[1])
		if strings.ContainsRune(CodeAlphabet, a) && strings.ContainsRune(CodeAlphabet, b) {
			t.Errorf("alphabet contains both %q and %q — they are confusable", a, b)
		}
	}
	// 只允许大写：输入侧统一转大写，集合里混进小写会让同一个码有两种合法写法。
	if strings.ToUpper(CodeAlphabet) != CodeAlphabet {
		t.Error("alphabet must be uppercase only")
	}
}

func TestValidCodeFormat(t *testing.T) {
	if !ValidCodeFormat("K7M3X9") {
		t.Error("a well-formed code must pass")
	}
	for _, bad := range []string{
		"",          // 空
		"K7M3X",     // 短一位
		"K7M3X92",   // 长一位
		"K7M3X0",    // 0 不在字母表（防它和 O 混）
		"K7M3X1",    // 1 同理
		"k7m3x9",    // 小写：由输入侧归一化，服务端不接受
		"K7M3XB",    // B 被剔（和 8 混）
		"K7M3X!",    // 标点
		"../../etc", // 路径形状的垃圾
	} {
		if ValidCodeFormat(bad) {
			t.Errorf("ValidCodeFormat(%q) = true, want false", bad)
		}
	}
}

// 分布抽查：逐字符 rand.Int 取样是无偏的，但写成 `randomByte % 24` 会让前 8 个
// 字符偏多——那种偏差在功能测试里完全看不出来，只能这样抽。
func TestRandCodeUsesWholeAlphabet(t *testing.T) {
	seen := map[rune]int{}
	r := NewPairRegistry(300, func() int64 { return 1 })
	for i := 0; i < 4000; i++ {
		code, _ := r.MintFor("u")
		for _, c := range code {
			seen[c]++
		}
	}
	for _, c := range CodeAlphabet {
		if seen[c] == 0 {
			t.Errorf("character %q never appeared in 4000 codes", c)
		}
	}
	if len(seen) != len(CodeAlphabet) {
		t.Errorf("codes used %d distinct characters, want %d", len(seen), len(CodeAlphabet))
	}
}
