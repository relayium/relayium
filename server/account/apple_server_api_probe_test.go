package account

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func testProbeClient(t *testing.T, handler http.Handler, timeout time.Duration) (*AppleServerAPIClient, AppleAppConfig, string) {
	t.Helper()
	chain := newAppleTestChain(t)
	app := AppleAppConfig{BundleID: testBundleIOS, AppAppleID: 6791918822}
	verifier, err := NewAppleTransactionVerifier(AppleStoreConfig{Environments: []string{appleEnvProduction, appleEnvSandbox}, Apps: []AppleAppConfig{app}, RootCertsPEM: chain.rootPEM})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	client, err := NewAppleServerAPIClient(AppleServerAPIConfig{IssuerID: "issuer", KeyID: "key", PrivateKey: key, HTTP: server.Client(), ProductionURL: server.URL, SandboxURL: server.URL, ProbeInterval: time.Millisecond, ProbeTimeout: timeout}, verifier)
	if err != nil {
		t.Fatal(err)
	}
	testPayload := chain.notify(t, "", func(p map[string]any) { p["notificationType"] = "TEST"; p["subtype"] = "" }, withAppleNotificationData(func(d map[string]any) {
		d["environment"] = appleEnvProduction
		d["appAppleId"] = app.AppAppleID
		d["signedTransactionInfo"] = ""
	}))
	return client, app, testPayload
}

func TestAppleServerAPIProbeUsesSharedJWTAndVerifiesSuccessfulTest(t *testing.T) {
	var mu sync.Mutex
	gets := 0
	token := "9f0b2e3a-1c4d-4e5f-8a9b-000000000111"
	var payload string
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			if r.URL.Path != "/inApps/v1/notifications/test" {
				t.Errorf("POST path %q", r.URL.Path)
			}
			parts := strings.Split(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), ".")
			if len(parts) != 3 {
				t.Errorf("missing JWT")
				http.Error(w, "", 401)
				return
			}
			parsed, _, err := new(jwt.Parser).ParseUnverified(strings.Join(parts, "."), jwt.MapClaims{})
			if err != nil {
				t.Errorf("JWT: %v", err)
			} else {
				claims := parsed.Claims.(jwt.MapClaims)
				if parsed.Method.Alg() != "ES256" || parsed.Header["typ"] != "JWT" || parsed.Header["kid"] != "key" || claims["iss"] != "issuer" || claims["aud"] != "appstoreconnect-v1" || claims["bid"] != testBundleIOS {
					t.Errorf("JWT mismatch: header=%v claims=%v", parsed.Header, claims)
				}
				if int64(claims["exp"].(float64)-claims["iat"].(float64)) != 300 {
					t.Errorf("JWT lifetime")
				}
			}
			json.NewEncoder(w).Encode(map[string]string{"testNotificationToken": token})
			return
		}
		if r.URL.Path != "/inApps/v1/notifications/test/"+token {
			t.Errorf("GET path %q", r.URL.Path)
		}
		mu.Lock()
		gets++
		n := gets
		mu.Unlock()
		switch n {
		case 1:
			http.NotFound(w, r)
		case 2:
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusTooManyRequests)
		case 3:
			json.NewEncoder(w).Encode(map[string]any{"sendAttempts": []any{}})
		default:
			json.NewEncoder(w).Encode(map[string]any{"signedPayload": payload, "sendAttempts": []any{map[string]string{"sendAttemptResult": "SUCCESS"}}})
		}
	})
	client, app, signed := testProbeClient(t, h, 200*time.Millisecond)
	payload = signed
	var out bytes.Buffer
	if err := client.probeTestNotification(context.Background(), appleEnvProduction, client.cfg.ProductionURL, app, &out); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), token) || strings.Contains(out.String(), "issuer") || !strings.Contains(out.String(), "stage A ok") || !strings.Contains(out.String(), "stage B ok") {
		t.Fatalf("unsafe or incomplete output: %q", out.String())
	}
}

func TestAppleServerAPIProbeFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name    string
		env     string
		handler http.Handler
		want    string
	}{
		{"stage A terminal", appleEnvProduction, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "secret", http.StatusForbidden) }), "stage A"},
		{"sandbox post missing is delivery", appleEnvSandbox, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) }), "stage B"},
		{"stage A malformed token", appleEnvProduction, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			json.NewEncoder(w).Encode(map[string]string{"testNotificationToken": "not-a-uuid"})
		}), "invalid token"},
		{"stage B terminal", appleEnvProduction, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost {
				json.NewEncoder(w).Encode(map[string]string{"testNotificationToken": "9f0b2e3a-1c4d-4e5f-8a9b-000000000112"})
			} else {
				http.Error(w, "secret", http.StatusBadRequest)
			}
		}), "stage B"},
		{"timeout", appleEnvProduction, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost {
				json.NewEncoder(w).Encode(map[string]string{"testNotificationToken": "9f0b2e3a-1c4d-4e5f-8a9b-000000000113"})
			} else {
				http.NotFound(w, r)
			}
		}), "timed out"},
		{"second rate limit", appleEnvProduction, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost {
				json.NewEncoder(w).Encode(map[string]string{"testNotificationToken": "9f0b2e3a-1c4d-4e5f-8a9b-000000000115"})
				return
			}
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusTooManyRequests)
		}), "rate limited"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client, app, _ := testProbeClient(t, tc.handler, 5*time.Millisecond)
			var out bytes.Buffer
			err := client.probeTestNotification(context.Background(), tc.env, client.cfg.ProductionURL, app, &out)
			if err == nil || !strings.Contains(err.Error(), tc.want) || strings.Contains(err.Error(), "secret") || strings.Contains(out.String(), "hidden") {
				t.Fatalf("err=%v out=%q", err, out.String())
			}
		})
	}
}

func TestAppleServerAPIProbeRequiresEveryAppAndEnvironment(t *testing.T) {
	var posts int
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			posts++
			json.NewEncoder(w).Encode(map[string]string{"testNotificationToken": "9f0b2e3a-1c4d-4e5f-8a9b-000000000114"})
			return
		}
		http.Error(w, "", http.StatusBadRequest)
	})
	client, app, _ := testProbeClient(t, h, 20*time.Millisecond)
	err := client.ProbeTestNotifications(context.Background(), []AppleAppConfig{app, {BundleID: testBundleMac, AppAppleID: 6801142976}}, &bytes.Buffer{})
	if err == nil || posts != 1 {
		t.Fatalf("partial success accepted or enumeration continued unsafely: posts=%d err=%v", posts, err)
	}
	if err := client.ProbeTestNotifications(context.Background(), nil, &bytes.Buffer{}); err == nil {
		t.Fatal("zero apps accepted")
	}
}

func TestAppleServerAPIProbeEnumeratesAllAppsOnBothHosts(t *testing.T) {
	chain := newAppleTestChain(t)
	apps := []AppleAppConfig{{BundleID: testBundleIOS, AppAppleID: 6791918822}, {BundleID: testBundleMac, AppAppleID: 6801142976}}
	verifier, err := NewAppleTransactionVerifier(AppleStoreConfig{Environments: []string{appleEnvProduction, appleEnvSandbox}, Apps: apps, RootCertsPEM: chain.rootPEM})
	if err != nil {
		t.Fatal(err)
	}
	payloads := map[string]string{}
	for _, app := range apps {
		for _, env := range []string{appleEnvProduction, appleEnvSandbox} {
			app, env := app, env
			payloads[env+"/"+app.BundleID] = chain.notify(t, "", func(p map[string]any) { p["notificationType"] = "TEST" }, withAppleNotificationData(func(d map[string]any) {
				d["bundleId"] = app.BundleID
				d["environment"] = env
				d["signedTransactionInfo"] = ""
				if env == appleEnvProduction {
					d["appAppleId"] = app.AppAppleID
				} else {
					delete(d, "appAppleId")
				}
			}))
		}
	}
	seen := map[string]int{}
	tokens := map[string]string{}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		env := appleEnvProduction
		if strings.HasPrefix(r.URL.Path, "/sandbox/") {
			env = appleEnvSandbox
		}
		if r.Method == http.MethodPost {
			parsed, _, _ := new(jwt.Parser).ParseUnverified(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), jwt.MapClaims{})
			bundle, _ := parsed.Claims.(jwt.MapClaims)["bid"].(string)
			key := env + "/" + bundle
			seen[key]++
			token := "9f0b2e3a-1c4d-4e5f-8a9b-" + map[string]string{
				appleEnvProduction + "/" + testBundleIOS: "000000000121", appleEnvSandbox + "/" + testBundleIOS: "000000000122",
				appleEnvProduction + "/" + testBundleMac: "000000000123", appleEnvSandbox + "/" + testBundleMac: "000000000124",
			}[key]
			tokens[token] = key
			json.NewEncoder(w).Encode(map[string]string{"testNotificationToken": token})
			return
		}
		parts := strings.Split(r.URL.Path, "/")
		token := parts[len(parts)-1]
		key := tokens[token]
		json.NewEncoder(w).Encode(map[string]any{"signedPayload": payloads[key], "sendAttempts": []any{map[string]string{"sendAttemptResult": "SUCCESS"}}})
	}))
	defer server.Close()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	client, err := NewAppleServerAPIClient(AppleServerAPIConfig{IssuerID: "issuer", KeyID: "key", PrivateKey: key, HTTP: server.Client(), ProductionURL: server.URL + "/production", SandboxURL: server.URL + "/sandbox", ProbeInterval: time.Millisecond, ProbeTimeout: 100 * time.Millisecond}, verifier)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.ProbeTestNotifications(context.Background(), apps, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if len(seen) != 4 {
		t.Fatalf("targets=%v", seen)
	}
	for target, count := range seen {
		if count != 1 {
			t.Fatalf("%s posted %d times", target, count)
		}
	}
}
