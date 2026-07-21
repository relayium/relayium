package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// JSON bodies — tags MUST match the central handlers (internal/account/nodes.go).
type registerBody struct {
	NodeID        string   `json:"nodeID"`
	TURNSecret    string   `json:"turnSecret"`
	URLs          []string `json:"urls"`
	Region        string   `json:"region"`
	Version       string   `json:"version"`
	Capabilities  []string `json:"capabilities"`
	StorageURL    string   `json:"storageURL"`
	StorageSecret string   `json:"storageSecret"`
	StorageFP     string   `json:"storageFP"` // SHA-256 (hex) of the blob server's self-signed TLS cert, for central to pin
	StorageTotal  int64    `json:"storageTotal"`
	StorageFree   int64    `json:"storageFree"`
	// DownloadURL is this node's PUBLIC https base URL for direct client downloads
	// (e.g. https://node7.relayium.com), where GET /dl/{key}?t=<token> is served.
	// Empty leaves central proxying. Central honors it only for fleet nodes.
	DownloadURL string `json:"downloadURL"`
}

// nodeLimits mirrors central's response (internal/account/nodes.go): the node's
// hard caps plus central's authoritative month-to-date relayed total, which the
// node enforces locally in real time.
type nodeLimits struct {
	TrafficLimitBytes int64 `json:"trafficLimitBytes"`
	DiskLimitBytes    int64 `json:"diskLimitBytes"`
	RelayedThisMonth  int64 `json:"relayedThisMonth"`
}

type registerResp struct {
	NodeID            string `json:"nodeID"`
	HeartbeatInterval int    `json:"heartbeatInterval"`
	nodeLimits
}

type heartbeatResp struct {
	OK                bool `json:"ok"`
	HeartbeatInterval int  `json:"heartbeatInterval"`
	nodeLimits
}

type usageItem struct {
	AllocID      string `json:"allocID"`
	Username     string `json:"username"`
	RelayedBytes int64  `json:"relayedBytes"`
}

type heartbeatBody struct {
	NodeID       string      `json:"nodeID"`
	Status       string      `json:"status"`
	Usage        []usageItem `json:"usage"`
	RelayedTotal int64       `json:"relayedTotal"`
	StoredBytes  int64       `json:"storedBytes"`
	StorageTotal int64       `json:"storageTotal"`
	StorageFree  int64       `json:"storageFree"`
}

// receiptBody reports a served direct download so central can reconcile the
// traffic it pre-metered when it issued the 302.
type receiptBody struct {
	BlobKey     string `json:"blobKey"`
	Nonce       string `json:"nonce"`
	ServedBytes int64  `json:"servedBytes"`
}

type reporter struct {
	central string
	token   string
	hc      *http.Client
}

func newReporter(central, token string) *reporter {
	return &reporter{central: central, token: token, hc: &http.Client{Timeout: 15 * time.Second}}
}

func (rp *reporter) post(path string, in any, out any) error {
	b, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequest("POST", rp.central+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+rp.token)
	resp, err := rp.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("%s: status %d: %s", path, resp.StatusCode, string(body))
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

func (rp *reporter) register(body registerBody) (registerResp, error) {
	var r registerResp
	err := rp.post("/api/nodes/register", body, &r)
	return r, err
}

func (rp *reporter) heartbeat(body heartbeatBody) (heartbeatResp, error) {
	var r heartbeatResp
	err := rp.post("/api/nodes/heartbeat", body, &r)
	return r, err
}
