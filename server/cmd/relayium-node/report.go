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
	NodeID       string   `json:"nodeID"`
	TURNSecret   string   `json:"turnSecret"`
	URLs         []string `json:"urls"`
	Region       string   `json:"region"`
	Version      string   `json:"version"`
	Capabilities []string `json:"capabilities"`
}

type registerResp struct {
	NodeID            string `json:"nodeID"`
	HeartbeatInterval int    `json:"heartbeatInterval"`
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

func (rp *reporter) register(body registerBody) (nodeID string, heartbeatInterval int, err error) {
	var r registerResp
	if err = rp.post("/api/nodes/register", body, &r); err != nil {
		return "", 0, err
	}
	return r.NodeID, r.HeartbeatInterval, nil
}

func (rp *reporter) heartbeat(body heartbeatBody) error {
	return rp.post("/api/nodes/heartbeat", body, nil)
}
