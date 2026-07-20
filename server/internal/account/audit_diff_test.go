package account

import (
	"encoding/json"
	"testing"
)

// 只记录真正变了的字段。表单每次提交全部 10 个设置项，若不过滤，
// 改一个值会产生 10 行"变更"，日志立刻失去可读性。
func TestDiffFieldsSkipsUnchanged(t *testing.T) {
	before := map[string]any{"a": int64(1), "b": int64(2)}
	after := map[string]any{"a": int64(1), "b": int64(99)}
	got := diffFields(before, after)
	if len(got) != 1 {
		t.Fatalf("want 1 changed field, got %d: %+v", len(got), got)
	}
	if got[0].Field != "b" || got[0].Old != int64(2) || got[0].New != int64(99) {
		t.Fatalf("unexpected change: %+v", got[0])
	}
}

// 字段顺序必须稳定，否则同样的改动在日志里每次长得不一样，没法比对。
func TestDiffFieldsIsSorted(t *testing.T) {
	before := map[string]any{"z": int64(1), "a": int64(1), "m": int64(1)}
	after := map[string]any{"z": int64(2), "a": int64(2), "m": int64(2)}
	got := diffFields(before, after)
	if len(got) != 3 || got[0].Field != "a" || got[1].Field != "m" || got[2].Field != "z" {
		t.Fatalf("want a,m,z order, got %+v", got)
	}
}

// 新增字段（before 里没有）记为 old=nil，用于节点删除这种没有前值的场景反向使用。
func TestDiffFieldsHandlesMissingBefore(t *testing.T) {
	got := diffFields(map[string]any{}, map[string]any{"x": int64(5)})
	if len(got) != 1 || got[0].Old != nil || got[0].New != int64(5) {
		t.Fatalf("want old=nil new=5, got %+v", got)
	}
}

func TestEncodeChangesIsValidJSON(t *testing.T) {
	s := encodeChanges([]ChangeField{{Field: "a", Old: int64(1), New: int64(2)}})
	var back []ChangeField
	if err := json.Unmarshal([]byte(s), &back); err != nil {
		t.Fatalf("encodeChanges produced invalid JSON %q: %v", s, err)
	}
	if len(back) != 1 || back[0].Field != "a" {
		t.Fatalf("round-trip mismatch: %+v", back)
	}
}

// 空变更必须编码成 "[]" 而不是 "null" —— 列是 NOT NULL，且 "null" 在
// 审计页上会渲染成字面量 null。
func TestEncodeChangesEmptyIsEmptyArray(t *testing.T) {
	if got := encodeChanges(nil); got != "[]" {
		t.Fatalf("want [], got %q", got)
	}
}
