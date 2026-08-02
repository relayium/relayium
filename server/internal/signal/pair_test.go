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
	// A never-minted code must not validate. Picked to differ from the one code
	// this registry actually holds, because the digit space is small enough that
	// a fixed literal could otherwise collide once in a million runs.
	unknown := "999999"
	if unknown == code {
		unknown = "111111"
	}
	if r.Validate("12345-bogus") || r.Validate(unknown) {
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
	// Unknown code (letters can no longer be a code at all).
	if _, ok := r.OwnerOf("A2C4E6"); ok {
		t.Fatalf("OwnerOf unknown code should be false")
	}
}

// 字母表本身是一个安全决定，钉住它。现在是十个十进制数字，一个都不能少：少一个
// 数字就意味着某些服务端签发的码在别的客户端上输不进去，而多出任何非数字字符会
// 让「六位数字」这个对外承诺变成假话，并且立刻打破数字键盘输入。
func TestCodeAlphabet(t *testing.T) {
	if CodeAlphabet != "0123456789" {
		t.Fatalf("alphabet changed: %q — read the reasoning above CodeAlphabet first", CodeAlphabet)
	}
	// 逐个钉住 0 和 1：它们是这次格式变更里唯一新加入的字符，也是最容易被
	// 「防止和 O/I 混淆」的旧理由重新剔掉的两个。
	for _, d := range "0123456789" {
		if !strings.ContainsRune(CodeAlphabet, d) {
			t.Errorf("digit %q missing from the alphabet — the code is decimal 0-9, exactly", d)
		}
	}
	for _, c := range CodeAlphabet {
		if c < '0' || c > '9' {
			t.Errorf("alphabet contains %q — a pairing code is digits only", c)
		}
	}
}

func TestValidCodeFormat(t *testing.T) {
	for _, good := range []string{
		"472839", // 普通的六位
		"000000", // 全零：合法，而且是最容易被「非空/非零」检查误杀的一个
		"012345", // 前导零必须保留：它是一个字符串，不是一个整数
		"111111",
		"999999",
	} {
		if !ValidCodeFormat(good) {
			t.Errorf("ValidCodeFormat(%q) = false, want true", good)
		}
	}
	for _, bad := range []string{
		"",        // 空
		"12345",   // 短一位
		"1234567", // 长一位
		"K7M3X9",  // 旧字母表的码：格式变更之后必须整个失效
		"A12345",  // 任何字母
		"12345a",
		"12 345",    // 空格（输入侧归一化会丢掉，服务端不接受）
		"12345!",    // 标点
		"+12345",    // strconv 意义上的「数字」，字符意义上不是
		"１２３４５６",    // 全角数字
		"../../etc", // 路径形状的垃圾
	} {
		if ValidCodeFormat(bad) {
			t.Errorf("ValidCodeFormat(%q) = true, want false", bad)
		}
	}
}

// 分布抽查：逐字符 rand.Int 取样是无偏的，但写成 `randomByte % 10` 会让 0-5
// 偏多（256 不被 10 整除）——那种偏差在功能测试里完全看不出来，只能这样抽。
// 同时这也是「0 和 1 真的会被签发出来」的证据，而不只是「格式校验接受它们」。
func TestRandCodeUsesWholeAlphabet(t *testing.T) {
	seen := map[rune]int{}
	leadingZero := false
	r := NewPairRegistry(300, func() int64 { return 1 })
	for i := 0; i < 4000; i++ {
		code, _ := r.MintFor("u")
		if code[0] == '0' {
			leadingZero = true
		}
		for _, c := range code {
			seen[c]++
		}
	}
	for _, c := range CodeAlphabet {
		if seen[c] == 0 {
			t.Errorf("digit %q never appeared in 4000 codes", c)
		}
	}
	if len(seen) != len(CodeAlphabet) {
		t.Errorf("codes used %d distinct characters, want %d", len(seen), len(CodeAlphabet))
	}
	// ~4000 次抽样里没有一个前导零，意味着某处偷偷把码当成了数字。
	if !leadingZero {
		t.Error("no minted code started with 0 in 4000 samples — a leading zero is being dropped somewhere")
	}
}
