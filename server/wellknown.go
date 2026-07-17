package main

import (
	"encoding/json"
	"net/http"
	"os"
)

// appleAppSiteAssociation serves /.well-known/apple-app-site-association, the
// JSON that ties this domain to the iOS/macOS apps for Universal Links (share
// links open the app instead of Safari) and webcredentials (Sign in with Apple
// / password autofill). It is built from the configured appIDs
// (<TeamID>.<BundleID>) so the only thing needed once the Apple developer
// account lands is setting RELAYIUM_APPLE_APP_IDS — no rebuild.
//
// Dormant until configured: with no appIDs it 404s rather than publish an empty
// or placeholder association. Served as application/json with no redirect, which
// is what Apple's fetcher requires.
func appleAppSiteAssociation(appIDs []string) http.HandlerFunc {
	// Paths that should hand off to the app. Scoped to the actionable transfer
	// links (a shared download, a realtime pairing link) — deliberately NOT the
	// marketing site, so opening relayium.com from an iOS device with the app
	// installed still shows the website.
	type detail struct {
		AppIDs     []string         `json:"appIDs"`
		Components []map[string]any `json:"components"`
	}
	body, err := json.Marshal(map[string]any{
		"applinks": map[string]any{
			"apps": []string{},
			"details": []detail{{
				AppIDs: appIDs,
				Components: []map[string]any{
					{"/": "/d/*", "comment": "shared download links open in the app"},
					{"/": "/cross-network", "comment": "realtime pairing links open in the app"},
				},
			}},
		},
		"webcredentials": map[string]any{"apps": appIDs},
	})
	return func(w http.ResponseWriter, r *http.Request) {
		if len(appIDs) == 0 || err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		// Apple caches the AASA; a modest max-age lets an appID change propagate
		// within a day without hammering the origin.
		w.Header().Set("Cache-Control", "public, max-age=3600")
		_, _ = w.Write(body)
	}
}

// appleDomainAssociation serves /.well-known/apple-developer-domain-association.txt,
// the proof Apple fetches to verify this domain owns the Services ID's return
// URLs. Read from a file on the host (never committed). Dormant → 404 when
// unconfigured or unreadable, matching the AASA handler.
func appleDomainAssociation(path string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if path == "" {
			http.NotFound(w, r)
			return
		}
		body, err := os.ReadFile(path)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		_, _ = w.Write(body)
	}
}
