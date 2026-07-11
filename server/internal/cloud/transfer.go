package cloud

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"

	"github.com/relayium/relayium/internal/storecrypto"
)

// UploadOpts controls the retention parameters attached to an upload. A zero
// value asks for none of them, so the server applies its own admin-configured
// default retention policy — see resolveRetention on the server side.
type UploadOpts struct {
	Burn         bool
	TTLSeconds   int64
	MaxDownloads int64
}

// uploadStatusError maps an upload's HTTP status to an actionable message,
// distinct from a bare "unexpected status N" so the CLI can tell the user
// what to actually do (re-login, shrink the file, wait for quota reset).
func uploadStatusError(status int) error {
	switch status {
	case http.StatusUnauthorized:
		return errors.New("session expired, run `relayium login` again")
	case http.StatusRequestEntityTooLarge:
		return errors.New("file exceeds server max size")
	case http.StatusTooManyRequests:
		return errors.New("daily quota exceeded")
	default:
		return fmt.Errorf("upload failed: unexpected status %d", status)
	}
}

// uploadFile pairs a manifest entry with the absolute path to read it from.
type uploadFile struct {
	name string // relative, forward-slash path as recorded in the manifest
	path string // absolute source path on disk
}

// walkUploadPaths expands paths (files and/or directory trees) into the flat
// list of files an upload will send, using relative forward-slash names —
// matching web's manifest `name` (a bare file's own basename; a directory's
// contents prefixed by the directory name), mirroring xfer.BuildManifest's
// convention of walking relative to the parent of each root.
func walkUploadPaths(paths []string) ([]uploadFile, error) {
	var files []uploadFile
	for _, root := range paths {
		absRoot, err := filepath.Abs(root)
		if err != nil {
			return nil, err
		}
		parent := filepath.Dir(absRoot)
		err = filepath.WalkDir(absRoot, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !d.Type().IsRegular() {
				return nil
			}
			rel, err := filepath.Rel(parent, p)
			if err != nil {
				return err
			}
			files = append(files, uploadFile{name: filepath.ToSlash(rel), path: p})
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return files, nil
}

// uploadQuery builds the /api/files query string from opt, omitting any
// zero/false parameter so the server falls back to its admin-configured
// default retention policy for that field.
func uploadQuery(opt UploadOpts) string {
	q := url.Values{}
	if opt.Burn {
		q.Set("burnAfterRead", "1")
	}
	if opt.TTLSeconds > 0 {
		q.Set("ttl", fmt.Sprintf("%d", opt.TTLSeconds))
	}
	if opt.MaxDownloads > 0 {
		q.Set("maxDownloads", fmt.Sprintf("%d", opt.MaxDownloads))
	}
	return q.Encode()
}

// Upload encrypts paths (files and/or directory trees) client-side and
// streams the ciphertext to the account-bound cloud store. It never buffers
// the full payload in memory: the request body is produced on the fly by a
// goroutine writing into an io.Pipe, which http.NewRequestWithContext reads
// from directly.
//
// Wire format (frozen, must match the server's handleUploadFile exactly):
//
//	uint32BE(len(encManifest)) || encManifest || framedCiphertext
//
// where framedCiphertext is each file's storecrypto.ChunkSize chunks, each
// encoded via storecrypto.FrameChunk(key, seq, chunk) using one GLOBAL seq
// counter across all files, starting at 1 (the manifest itself occupies
// seq 0, per EncryptManifest).
func (c *Client) Upload(ctx context.Context, paths []string, opt UploadOpts) (id, keyB64Url string, err error) {
	files, err := walkUploadPaths(paths)
	if err != nil {
		return "", "", err
	}

	key, err := storecrypto.GenerateKey()
	if err != nil {
		return "", "", err
	}

	manifest := storecrypto.Manifest{Files: make([]storecrypto.FileEntry, len(files))}
	for i, f := range files {
		info, err := os.Stat(f.path)
		if err != nil {
			return "", "", err
		}
		manifest.Files[i] = storecrypto.FileEntry{Name: f.name, Size: info.Size()}
	}

	encManifest, err := storecrypto.EncryptManifest(key, manifest)
	if err != nil {
		return "", "", err
	}

	pr, pw := io.Pipe()
	go func() {
		pw.CloseWithError(writeUploadBody(pw, encManifest, files, key))
	}()

	q := uploadQuery(opt)
	reqURL := c.Server + "/api/files"
	if q != "" {
		reqURL += "?" + q
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, pr)
	if err != nil {
		pr.Close()
		return "", "", err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/octet-stream")

	httpc := c.HTTP
	if httpc == nil {
		httpc = http.DefaultClient
	}
	resp, err := httpc.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", "", uploadStatusError(resp.StatusCode)
	}

	var out struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", "", err
	}
	return out.ID, storecrypto.EncodeKey(key), nil
}

// writeUploadBody writes the framed request body (manifest header + each
// file's encrypted chunks) into w, using one global seq counter starting at
// 1 across all files (seq 0 is the manifest, per EncryptManifest/nonce(0)).
func writeUploadBody(w io.Writer, encManifest []byte, files []uploadFile, key []byte) error {
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(encManifest)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	if _, err := w.Write(encManifest); err != nil {
		return err
	}

	seq := uint64(1)
	buf := make([]byte, storecrypto.ChunkSize)
	for _, f := range files {
		fh, err := os.Open(f.path)
		if err != nil {
			return err
		}
		err = func() error {
			defer fh.Close()
			for {
				n, rerr := io.ReadFull(fh, buf)
				if n > 0 {
					frame, ferr := storecrypto.FrameChunk(key, seq, buf[:n])
					if ferr != nil {
						return ferr
					}
					seq++
					if _, werr := w.Write(frame); werr != nil {
						return werr
					}
				}
				if rerr == io.EOF || rerr == io.ErrUnexpectedEOF {
					return nil
				}
				if rerr != nil {
					return rerr
				}
			}
		}()
		if err != nil {
			return err
		}
	}
	return nil
}

// DownloadLink builds the shareable claim link for id: the key travels only
// in the URL fragment, so it is never sent to the server on a normal page
// load.
func (c *Client) DownloadLink(origin, id, keyB64Url string) string {
	return origin + "/d/" + id + "#k=" + keyB64Url
}
