package account

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/relayium/relayium/internal/storecrypto"
)

func TestUploadChunkNegotiation(t *testing.T) {
	for _, tc := range []struct {
		name, purpose, cap string
		size, want         int64
	}{
		{"legacy", StoredPurposeShare, "", 70_000_000, 8 << 20},
		{"unknown", StoredPurposeShare, "large-v2", 70_000_000, 8 << 20},
		{"below-threshold", StoredPurposeShare, "large-v1", (64 << 20) - 1, 8 << 20},
		{"missing-size", StoredPurposeShare, "large-v1", 0, 8 << 20},
		{"negative-size", StoredPurposeShare, "large-v1", -1, 8 << 20},
		{"device", StoredPurposeDeviceTask, "large-v1", 70_000_000, 8 << 20},
		{"pair-room", StoredPurposePairRoom, "large-v1", 70_000_000, 1 << 20},
		{"large", StoredPurposeShare, "large-v1", 70_000_000, (16 << 20) - (192*1024 + 16 + 256 + 4)},
		{"exact-threshold", StoredPurposeShare, "large-v1", 64 << 20, (16 << 20) - (192*1024 + 16 + 256 + 4)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := negotiatedUploadChunkSize(tc.purpose, tc.size, tc.cap); got != tc.want {
				t.Fatalf("chunk=%d want=%d", got, tc.want)
			}
		})
	}
}

func TestNegotiatedChunkWholeFramePackingRetainsOriginalAppendCeiling(t *testing.T) {
	target := negotiatedUploadChunkSize(StoredPurposeShare, 70_000_000, "large-v1")
	frame := int64(storecrypto.ChunkSize + 4 + 16)
	actual := ((target + frame - 1) / frame) * frame
	if actual > 16<<20 || maxAppendBytes != 16<<20 {
		t.Fatalf("packing %d (target %d) widened original cap %d", actual, target, maxAppendBytes)
	}
	if target <= 8<<20 {
		t.Fatal("large share did not increase packing target")
	}
	unadjusted := ((int64(16<<20) + frame - 1) / frame) * frame
	if unadjusted <= 16<<20 {
		t.Fatal("negative packing control did not cross the original cap")
	}
}

func TestUploadInitAdvertisesLargeHintOnlyForOptedInShare(t *testing.T) {
	for _, cap := range []string{"", "large-v1", "unknown"} {
		t.Run(cap, func(t *testing.T) {
			ts, svc, _, mail := newFileServer(t)
			svc.cfg.MaxFileSize = 128 << 20
			svc.cfg.DailyQuota = 256 << 20
			cookie := loginCookie(t, ts, mail, "hint@example.test")
			var body bytes.Buffer
			_ = binary.Write(&body, binary.BigEndian, uint32(16))
			body.Write(bytes.Repeat([]byte{'m'}, 16))
			req, _ := http.NewRequest("POST", ts.URL+"/api/uploads?purpose=share&ttl=3600&size=70000000", &body)
			req.AddCookie(cookie)
			if cap != "" {
				req.Header.Set("X-Relayium-Upload-Chunk", cap)
			}
			resp, e := ts.Client().Do(req)
			if e != nil {
				t.Fatal(e)
			}
			defer resp.Body.Close()
			if resp.StatusCode != 200 {
				b, _ := io.ReadAll(resp.Body)
				t.Fatalf("init %d %s", resp.StatusCode, b)
			}
			var out struct {
				ChunkSize int64  `json:"chunkSize"`
				Pipeline  string `json:"uploadPipeline"`
			}
			if e := json.NewDecoder(resp.Body).Decode(&out); e != nil {
				t.Fatal(e)
			}
			want := int64(8 << 20)
			if cap == "large-v1" {
				want = (16 << 20) - (192*1024 + 16 + 256 + 4)
			}
			if out.ChunkSize != want || out.Pipeline != "ordered-v1" {
				t.Fatalf("response %+v want chunk %d", out, want)
			}
		})
	}
}
