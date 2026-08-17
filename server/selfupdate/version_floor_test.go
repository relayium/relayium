package selfupdate

import (
	"context"
	"io"
	"runtime"
	"strings"
	"testing"
)

// 节点本来就拒绝装比自己旧的版本，但那道防线有两个逃生口：本地 --force，以及
// **中心下发的** AllowDowngrade。所以一个被攻破的中心可以把车队降到任意一个
// 「签名合法但已知有洞」的旧发布——验签拦不住，因为那确实是我们签过的版本。
//
// 地板是中心够不着的那一半。这几条用例钉的就是「中心够不着」这件事本身。
func TestVersionFloor(t *testing.T) {
	if minSupportedVersion != "v0.21.0" {
		t.Fatalf("production rollback floor = %q, want v0.21.0", minSupportedVersion)
	}

	withFloor := func(t *testing.T, floor string) {
		t.Helper()
		old := minSupportedVersion
		minSupportedVersion = floor
		t.Cleanup(func() { minSupportedVersion = old })
	}

	run := func(t *testing.T, tag string, tweak func(*Options)) (string, error) {
		t.Helper()
		fr := &fakeRelease{tag: tag, asset: AssetName(runtime.GOOS, runtime.GOARCH), archive: tarGzWith(t, "BIN-"+tag)}
		srv := fr.server(t)
		defer srv.Close()
		target := writeTarget(t, "OLD")
		o := baseOpts(srv, target)
		o.CurrentVersion = "v1.0.0"
		if tweak != nil {
			tweak(&o)
		}
		_, to, _, err := Update(context.Background(), o, io.Discard)
		return to, err
	}

	t.Run("中心说可以降级也没用：低于地板一律拒绝", func(t *testing.T) {
		withFloor(t, "v0.9.0")
		_, err := run(t, "v0.5.0", func(o *Options) { o.AllowDowngrade = true })
		if err == nil {
			t.Fatal("低于地板的版本被装上了 —— 被攻破的中心照样能把车队降到有洞的版本")
		}
		if !strings.Contains(err.Error(), "below the minimum version") {
			t.Fatalf("拒绝理由不对：%v", err)
		}
	})

	t.Run("地板之上的回滚仍然允许 —— 别把正常运维也堵死", func(t *testing.T) {
		withFloor(t, "v0.9.0")
		to, err := run(t, "v0.9.5", func(o *Options) { o.AllowDowngrade = true })
		if err != nil {
			t.Fatalf("地板之上的回滚被拒了：%v", err)
		}
		if to != "v0.9.5" {
			t.Fatalf("to=%q", to)
		}
	})

	t.Run("正好等于地板：放行（地板是「最低可接受」不是「必须高于」）", func(t *testing.T) {
		withFloor(t, "v0.9.0")
		if _, err := run(t, "v0.9.0", func(o *Options) { o.AllowDowngrade = true }); err != nil {
			t.Fatalf("等于地板被拒了：%v", err)
		}
	})

	t.Run("本地 --force 能越过 —— 人到机器跟前是唯一的出口", func(t *testing.T) {
		withFloor(t, "v0.9.0")
		if _, err := run(t, "v0.5.0", func(o *Options) { o.Force = true }); err != nil {
			t.Fatalf("--force 也被挡住了，那就没法应急了：%v", err)
		}
	})

	t.Run("未设置地板时行为与改动前完全一致", func(t *testing.T) {
		withFloor(t, "")
		if _, err := run(t, "v0.5.0", func(o *Options) { o.AllowDowngrade = true }); err != nil {
			t.Fatalf("没有地板却拦了：%v", err)
		}
	})

	t.Run("版本号按数值比，不按字符串", func(t *testing.T) {
		withFloor(t, "v0.9.0")
		// 字符串比较里 "v0.10.0" < "v0.9.0"，数值比较里则相反。
		if _, err := run(t, "v0.10.0", func(o *Options) { o.AllowDowngrade = true }); err != nil {
			t.Fatalf("v0.10.0 高于地板 v0.9.0，却被拒了：%v", err)
		}
	})
}
