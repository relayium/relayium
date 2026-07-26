package account

import (
	"encoding/json"
	"sort"

	"github.com/relayium/relayium/ext"
)

// ChangeField 是一个字段的前后值。Old/New 用 any 是因为审计要覆盖 int64
// （配额、价格）和 string（标签、price id）两类；具体动作各自决定放什么。
//
// This is a type alias, not a new type: the real definition lives in
// ext (see that package's doc comment for why), so that
// ext.AdminHost.WriteAudit's []ChangeField parameter and *Service.WriteAudit's
// []ChangeField parameter are the identical type, letting *Service satisfy
// ext.AdminHost without account importing anything back from ext for this
// type. Every existing use of ChangeField in this package (construction,
// field access, JSON marshaling) is unaffected by the alias.
type ChangeField = ext.ChangeField

// diffFields 返回 after 相对 before 真正发生变化的字段，按字段名排序。
//
// 只保留变化项是刻意的：设置表单每次提交全部 10 个字段，全记会让"改了一个值"
// 淹没在 9 条无变化的记录里。排序则保证同样的改动在日志中呈现一致，便于比对。
func diffFields(before, after map[string]any) []ChangeField {
	keys := make([]string, 0, len(after))
	for k := range after {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var out []ChangeField
	for _, k := range keys {
		old, had := before[k]
		if had && old == after[k] {
			continue
		}
		if !had {
			old = nil
		}
		out = append(out, ChangeField{Field: k, Old: old, New: after[k]})
	}
	return out
}

// encodeChanges 序列化为审计表的 changes 列。永远返回合法 JSON 数组：
// 空切片必须是 "[]" 而不是 "null"，列是 NOT NULL，且审计页会把 null 原样渲染。
func encodeChanges(fields []ChangeField) string {
	if len(fields) == 0 {
		return "[]"
	}
	b, err := json.Marshal(fields)
	if err != nil {
		// 只可能在放入不可序列化值时发生，属于编程错误；返回合法空数组，
		// 绝不让审计写入因此失败而拖垮业务操作。
		return "[]"
	}
	return string(b)
}
