// Package cfdns is a tiny Cloudflare DNS client: enough to auto-manage a fleet
// node's own A record (nodeN.relayium.com -> node public IP) at startup, so
// bringing up a node needs no manual Cloudflare dashboard step. It uses a scoped
// API token (Zone:DNS:Edit) supplied via the environment.
package cfdns

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// apiBase is Cloudflare's v4 API root.
const apiBase = "https://api.cloudflare.com/client/v4"

// Client talks to the Cloudflare v4 API for one zone.
type Client struct {
	Token  string
	ZoneID string
	HTTP   *http.Client
	// Base is the API root; defaults to Cloudflare's when empty (overridable in tests).
	Base string
}

func (c *Client) base() string {
	if c.Base != "" {
		return c.Base
	}
	return apiBase
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 15 * time.Second}
}

// cfResp is the common Cloudflare envelope. result is decoded per-call.
type cfResp struct {
	Success bool              `json:"success"`
	Errors  []json.RawMessage `json:"errors"`
	Result  json.RawMessage   `json:"result"`
}

func (c *Client) do(method, path string, body any) (cfResp, error) {
	var rdr *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return cfResp{}, err
		}
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, c.base()+path, rdr)
	if err != nil {
		return cfResp{}, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return cfResp{}, err
	}
	defer resp.Body.Close()
	var out cfResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return cfResp{}, fmt.Errorf("cloudflare %s %s: decode: %w", method, path, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || !out.Success {
		return out, fmt.Errorf("cloudflare %s %s: status %d, errors %s", method, path, resp.StatusCode, out.Errors)
	}
	return out, nil
}

// aRecord is the A-record body we send; TTL 1 = "automatic". proxied=true routes
// clients through Cloudflare (edge TLS + free bandwidth + the node IP stays
// hidden behind CF) — the fleet default; proxied=false is DNS-only, resolving
// straight to the node.
type aRecord struct {
	Type    string `json:"type"`
	Name    string `json:"name"`
	Content string `json:"content"`
	TTL     int    `json:"ttl"`
	Proxied bool   `json:"proxied"`
}

// UpsertA creates or updates an A record name -> ip in the client's zone.
// proxied=true (the fleet default) sends client traffic through Cloudflare so
// the edge terminates TLS, bandwidth is free, and the node's real IP never
// reaches the client.
func (c *Client) UpsertA(name, ip string, proxied bool) error {
	// Find an existing A record for this exact name.
	list, err := c.do(http.MethodGet, "/zones/"+c.ZoneID+"/dns_records?type=A&name="+name, nil)
	if err != nil {
		return err
	}
	var existing []struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(list.Result, &existing)

	rec := aRecord{Type: "A", Name: name, Content: ip, TTL: 1, Proxied: proxied}
	if len(existing) > 0 {
		_, err = c.do(http.MethodPut, "/zones/"+c.ZoneID+"/dns_records/"+existing[0].ID, rec)
		return err
	}
	_, err = c.do(http.MethodPost, "/zones/"+c.ZoneID+"/dns_records", rec)
	return err
}
