package cloud

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/http2/hpack"
)

// The standard-library TLS HTTP/2 client must rewind after REFUSED_STREAM.
// Flow control makes the retry progress continuously for longer than one idle
// interval, so a GetBody reader without the progress hook cannot pass.
func TestResumableHTTP2RefusedStreamRetainsBodyProgress(t *testing.T) {
	for _, refuse := range []bool{false, true} {
		name := "direct-control"
		if refuse {
			name = "refused-stream-replay"
		}
		t.Run(name, func(t *testing.T) {
			certificates := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
			cert, pair := certificates.Certificate(), certificates.TLS.Certificates[0]
			certificates.Close()
			tcp, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			listener := tls.NewListener(tcp, &tls.Config{Certificates: []tls.Certificate{pair}, NextProtos: []string{"h2"}})
			var mu sync.Mutex
			var connection net.Conn
			var streams atomic.Int32
			serverDone := make(chan error, 1)
			go func() {
				conn, err := listener.Accept()
				if err != nil {
					serverDone <- err
					return
				}
				mu.Lock()
				connection = conn
				mu.Unlock()
				defer conn.Close()
				preface := make([]byte, len(reviewH2Preface))
				if _, err = io.ReadFull(conn, preface); err != nil {
					serverDone <- err
					return
				}
				if string(preface) != reviewH2Preface {
					serverDone <- fmt.Errorf("not HTTP/2")
					return
				}
				framer := reviewH2Framer{conn: conn}
				if err = framer.write(4, 0, 0, []byte{0, 4, 0, 0, 64, 0}); err != nil {
					serverDone <- err
					return
				} // 16KiB stream window
				received := 0
				var active uint32
				for {
					f, err := framer.read()
					if err != nil {
						serverDone <- err
						return
					}
					switch f.kind {
					case 4: // SETTINGS
						if f.flags&1 == 0 {
							if err = framer.write(4, 1, 0, nil); err != nil {
								serverDone <- err
								return
							}
						}
					case 1: // HEADERS
						if n := streams.Add(1); refuse && n == 1 {
							if err = framer.write(3, 0, f.stream, []byte{0, 0, 0, 7}); err != nil {
								serverDone <- err
								return
							}
							continue
						}
						active = f.stream
					case 0: // DATA
						n := len(f.payload)
						window := func(stream uint32) error {
							var p [4]byte
							binary.BigEndian.PutUint32(p[:], uint32(n))
							return framer.write(8, 0, stream, p[:])
						}
						if f.stream != active {
							if n > 0 {
								_ = window(0)
							}
							continue
						}
						received += n
						if f.flags&1 != 0 {
							var encoded bytes.Buffer
							encoder := hpack.NewEncoder(&encoded)
							_ = encoder.WriteField(hpack.HeaderField{Name: ":status", Value: "200"})
							_ = encoder.WriteField(hpack.HeaderField{Name: "content-type", Value: "application/json"})
							if err = framer.write(1, 4, active, encoded.Bytes()); err != nil {
								serverDone <- err
								return
							}
							body, _ := json.Marshal(map[string]int{"received": received})
							serverDone <- framer.write(0, 1, active, body)
							return
						}
						time.Sleep(15 * time.Millisecond)
						if n > 0 {
							if err = window(0); err != nil {
								serverDone <- err
								return
							}
							if err = window(active); err != nil {
								serverDone <- err
								return
							}
						}
					case 6: // PING
						if f.flags&1 == 0 {
							_ = framer.write(6, 1, 0, f.payload)
						}
					}
				}
			}()
			roots := x509.NewCertPool()
			roots.AddCert(cert)
			transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots}, ForceAttemptHTTP2: true}
			t.Cleanup(func() {
				transport.CloseIdleConnections()
				listener.Close()
				mu.Lock()
				if connection != nil {
					connection.Close()
				}
				mu.Unlock()
			})
			client := NewClient("https://" + listener.Addr().String())
			client.HTTP = &http.Client{Transport: transport}
			client.idleTimeout = 150 * time.Millisecond
			client.confirmBase = time.Second
			body := bytes.Repeat([]byte("ciphertext"), 60000)
			var answer struct {
				Received int `json:"received"`
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			err = client.resumeJSON(ctx, http.MethodPatch, "/api/uploads/replay", body, fmt.Sprintf("bytes 0-%d/%d", len(body)-1, len(body)), &answer)
			if err != nil {
				t.Fatalf("progressing real HTTP/2 body failed (refused=%v streams=%d): %v", refuse, streams.Load(), err)
			}
			if answer.Received != len(body) {
				t.Fatalf("received %d want %d", answer.Received, len(body))
			}
			want := int32(1)
			if refuse {
				want = 2
			}
			if streams.Load() != want {
				t.Fatalf("streams=%d want %d", streams.Load(), want)
			}
			if err = <-serverDone; err != nil {
				t.Fatal(err)
			}
		})
	}
}

// Minimal server-side framing for this controlled peer; the client uses the
// real standard transport. Bounds are independent of any external input.
const reviewH2Preface = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"

type reviewH2Frame struct {
	kind, flags byte
	stream      uint32
	payload     []byte
}
type reviewH2Framer struct{ conn net.Conn }

func (f reviewH2Framer) write(kind, flags byte, stream uint32, payload []byte) error {
	n := len(payload)
	header := []byte{byte(n >> 16), byte(n >> 8), byte(n), kind, flags, 0, 0, 0, 0}
	binary.BigEndian.PutUint32(header[5:], stream)
	packet := append(header, payload...)
	written, err := f.conn.Write(packet)
	if err == nil && written != len(packet) {
		err = io.ErrShortWrite
	}
	return err
}
func (f reviewH2Framer) read() (reviewH2Frame, error) {
	var h [9]byte
	if _, err := io.ReadFull(f.conn, h[:]); err != nil {
		return reviewH2Frame{}, err
	}
	n := int(h[0])<<16 | int(h[1])<<8 | int(h[2])
	if n > 1<<20 {
		return reviewH2Frame{}, fmt.Errorf("unexpected oversized frame")
	}
	f1 := reviewH2Frame{kind: h[3], flags: h[4], stream: binary.BigEndian.Uint32(h[5:]) & 0x7fffffff, payload: make([]byte, n)}
	_, err := io.ReadFull(f.conn, f1.payload)
	return f1, err
}
