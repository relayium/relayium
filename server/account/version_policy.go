package account

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/relayium/relayium/selfupdate"
)

// OperationalVersionPolicy is the remotely adjustable support boundary. It is
// deliberately separate from selfupdate's compiled rollback floor: an operator
// may tighten this policy, but cannot use it to weaken what a node binary trusts.
type OperationalVersionPolicy struct {
	Revision              int64
	FleetMinimumVersion   string
	MacMinimumVersion     string
	MacMinimumBuild       int
	MacRecommendedVersion string
	MacLatestVersion      string
	UpdatedAt             int64
}

type VerifiedMacRelease struct {
	Version string `json:"version"`
	Build   int    `json:"build"`
	Tag     string `json:"tag"`
}

//go:embed macos_release_catalog.json
var macReleaseCatalogJSON []byte

func verifiedMacReleases() ([]VerifiedMacRelease, error) {
	var catalog struct {
		Releases []VerifiedMacRelease `json:"releases"`
	}
	if err := json.Unmarshal(macReleaseCatalogJSON, &catalog); err != nil {
		return nil, fmt.Errorf("decode macOS release catalog: %w", err)
	}
	seen := map[string]bool{}
	for _, release := range catalog.Releases {
		key := release.Version + ":" + strconv.Itoa(release.Build)
		if !validAppVersion(release.Version) || release.Build < 1 ||
			release.Tag != "macos-v"+release.Version || seen[key] {
			return nil, fmt.Errorf("invalid macOS release catalog entry %q", key)
		}
		seen[key] = true
	}
	sort.Slice(catalog.Releases, func(i, j int) bool {
		return compareAppVersions(catalog.Releases[i].Version,
			catalog.Releases[j].Version) < 0
	})
	return catalog.Releases, nil
}

func validAppVersion(value string) bool {
	parts := strings.Split(value, ".")
	if len(parts) < 1 || len(parts) > 4 {
		return false
	}
	for _, part := range parts {
		if part == "" || (len(part) > 1 && part[0] == '0') {
			return false
		}
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 {
			return false
		}
	}
	return true
}

func compareAppVersions(left, right string) int {
	a, b := strings.Split(left, "."), strings.Split(right, ".")
	for i := 0; i < len(a) || i < len(b); i++ {
		av, bv := 0, 0
		if i < len(a) {
			av, _ = strconv.Atoi(a[i])
		}
		if i < len(b) {
			bv, _ = strconv.Atoi(b[i])
		}
		if av < bv {
			return -1
		}
		if av > bv {
			return 1
		}
	}
	return 0
}

type operationalVersionStore interface {
	GetOperationalVersionPolicy(context.Context) (OperationalVersionPolicy, error)
	UpdateOperationalVersionPolicy(context.Context, int64, OperationalVersionPolicy) (bool, error)
}

func (s *SQLiteStore) GetOperationalVersionPolicy(ctx context.Context) (OperationalVersionPolicy, error) {
	var policy OperationalVersionPolicy
	err := s.reader().QueryRowContext(ctx, `SELECT revision, fleet_min_version,
		mac_min_version, mac_min_build, mac_recommended_version, mac_latest_version,
		updated_at FROM operational_version_policy WHERE id=1`).Scan(
		&policy.Revision, &policy.FleetMinimumVersion, &policy.MacMinimumVersion,
		&policy.MacMinimumBuild, &policy.MacRecommendedVersion,
		&policy.MacLatestVersion, &policy.UpdatedAt)
	return policy, err
}

func (s *SQLiteStore) UpdateOperationalVersionPolicy(ctx context.Context, expected int64,
	policy OperationalVersionPolicy) (bool, error) {
	result, err := s.db.ExecContext(ctx, `UPDATE operational_version_policy SET
		revision=revision+1, fleet_min_version=?, mac_min_version=?, mac_min_build=?,
		mac_recommended_version=?, mac_latest_version=?, updated_at=?
		WHERE id=1 AND revision=?`, policy.FleetMinimumVersion, policy.MacMinimumVersion,
		policy.MacMinimumBuild, policy.MacRecommendedVersion, policy.MacLatestVersion,
		policy.UpdatedAt, expected)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n == 1, err
}

func (s *Service) operationalVersionPolicy(ctx context.Context) (OperationalVersionPolicy, error) {
	store, ok := s.store.(operationalVersionStore)
	if !ok {
		// Small unit fakes predate this optional operational surface. They retain
		// their old behaviour; every production SQLite store implements it.
		return OperationalVersionPolicy{}, nil
	}
	return store.GetOperationalVersionPolicy(ctx)
}

func (s *Service) enforceFleetMinimum(ctx context.Context, version string) error {
	policy, err := s.operationalVersionPolicy(ctx)
	if err != nil {
		return fmt.Errorf("read operational version policy: %w", err)
	}
	if policy.FleetMinimumVersion == "" {
		return nil
	}
	comparison, ok := selfupdate.CompareVersions(version, policy.FleetMinimumVersion)
	if !ok || comparison < 0 {
		return fmt.Errorf("target %s is below the operational fleet minimum %s",
			version, policy.FleetMinimumVersion)
	}
	return nil
}

func parseOperationalVersionPolicyForm(form url.Values,
	current OperationalVersionPolicy) (OperationalVersionPolicy, error) {
	fleet := strings.TrimSpace(form.Get("fleet_min_version"))
	if !selfupdate.IsPlainVersion(fleet) {
		return OperationalVersionPolicy{}, errors.New("fleet minimum must be a plain vMAJOR.MINOR.PATCH release")
	}
	pair := strings.Split(strings.TrimSpace(form.Get("mac_min_release")), ":")
	if len(pair) != 2 {
		return OperationalVersionPolicy{}, errors.New("invalid macOS release selection")
	}
	build, err := strconv.Atoi(pair[1])
	if err != nil {
		return OperationalVersionPolicy{}, errors.New("invalid macOS build")
	}
	releases, err := verifiedMacReleases()
	if err != nil {
		return OperationalVersionPolicy{}, err
	}
	verified := false
	for _, release := range releases {
		if release.Version == pair[0] && release.Build == build {
			verified = true
			break
		}
	}
	if !verified {
		return OperationalVersionPolicy{}, errors.New("macOS version/build is not in verified release metadata")
	}
	if compareAppVersions(pair[0], "1.2.4") < 0 || build < 11 {
		return OperationalVersionPolicy{}, errors.New("macOS minimum is below the client embedded floor")
	}
	recommended := strings.TrimSpace(form.Get("mac_recommended_version"))
	latest := strings.TrimSpace(form.Get("mac_latest_version"))
	recommendedVerified, latestVerified := false, false
	for _, release := range releases {
		recommendedVerified = recommendedVerified || release.Version == recommended
		latestVerified = latestVerified || release.Version == latest
	}
	if !recommendedVerified || !latestVerified {
		return OperationalVersionPolicy{}, errors.New("recommended and latest macOS versions must be verified releases")
	}
	if compareAppVersions(pair[0], recommended) > 0 || compareAppVersions(recommended, latest) > 0 {
		return OperationalVersionPolicy{}, errors.New("macOS versions must satisfy minimum <= recommended <= latest")
	}
	current.FleetMinimumVersion = fleet
	current.MacMinimumVersion = pair[0]
	current.MacMinimumBuild = build
	current.MacRecommendedVersion = recommended
	current.MacLatestVersion = latest
	return current, nil
}

func versionPolicyImage(policy OperationalVersionPolicy) map[string]any {
	return map[string]any{
		"revision": policy.Revision, "fleet_min_version": policy.FleetMinimumVersion,
		"mac_min_version": policy.MacMinimumVersion, "mac_min_build": policy.MacMinimumBuild,
		"mac_recommended_version": policy.MacRecommendedVersion,
		"mac_latest_version":      policy.MacLatestVersion,
	}
}

func (s *Service) fleetNodesBelow(ctx context.Context, floor string) (int, error) {
	nodes, err := s.store.NodesByOwnerType(ctx, "fleet")
	if err != nil {
		return 0, err
	}
	below := 0
	for _, node := range nodes {
		if n, ok := selfupdate.CompareVersions(node.Version, floor); !ok || n < 0 {
			below++
		}
	}
	return below, nil
}

func (s *Service) handleMacVersionPolicy(w http.ResponseWriter, r *http.Request) {
	policy, err := s.operationalVersionPolicy(r.Context())
	if err != nil {
		http.Error(w, "policy unavailable", http.StatusServiceUnavailable)
		return
	}
	if policy.Revision == 0 {
		policy = OperationalVersionPolicy{Revision: 6, MacMinimumVersion: "1.2.11",
			MacMinimumBuild: 17, MacRecommendedVersion: "1.3.0", MacLatestVersion: "1.3.2"}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"schema": 1,
		"macos": map[string]any{
			"policyRevision":          policy.Revision,
			"minimumSupportedVersion": policy.MacMinimumVersion,
			"minimumSupportedBuild":   policy.MacMinimumBuild,
			"recommendedVersion":      policy.MacRecommendedVersion,
			"latestVersion":           policy.MacLatestVersion,
		},
	})
}

type adminVersionPolicyData struct {
	Lang       string
	Policy     OperationalVersionPolicy
	Releases   []VerifiedMacRelease
	FleetBelow int
	Error      string
}

func (s *Service) handleAdminVersionPolicy(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Redirect(w, r, "/admin", http.StatusFound)
		return
	}
	policy, err := s.operationalVersionPolicy(r.Context())
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	releases, err := verifiedMacReleases()
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	below, err := s.fleetNodesBelow(r.Context(), policy.FleetMinimumVersion)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	_ = adminVersionPolicyTmpl.Execute(w, adminVersionPolicyData{
		Lang: adminLangFrom(r), Policy: policy, Releases: releases, FleetBelow: below,
	})
}

func (s *Service) handleAdminUpdateVersionPolicy(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	current, err := s.operationalVersionPolicy(r.Context())
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	expected, err := strconv.ParseInt(r.FormValue("revision"), 10, 64)
	if err != nil || expected != current.Revision {
		http.Error(w, "policy changed; reload and confirm again", http.StatusConflict)
		return
	}
	next, err := parseOperationalVersionPolicyForm(r.PostForm, current)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	next.UpdatedAt = s.now().Unix()
	store, ok := s.store.(operationalVersionStore)
	if !ok {
		http.Error(w, "policy store unavailable", http.StatusServiceUnavailable)
		return
	}
	updated, err := store.UpdateOperationalVersionPolicy(r.Context(), expected, next)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !updated {
		http.Error(w, "policy changed; reload and confirm again", http.StatusConflict)
		return
	}
	http.Redirect(w, r, "/admin/version-policy", http.StatusFound)
}

var adminVersionPolicyTmpl = template.Must(template.New("version-policy").Parse(`<!doctype html>
<html lang="{{.Lang}}"><head><meta charset="utf-8"><title>Relayium Version Policy</title>
<style>body{font:15px system-ui;max-width:760px;margin:40px auto;padding:0 20px}label{display:block;margin:16px 0}select,input,button{font:inherit;padding:8px}small{display:block;color:#666;margin-top:5px}.warn{color:#a33}</style></head><body>
<p><a href="/admin">← {{if eq .Lang "en"}}Admin{{else}}后台{{end}}</a></p><h1>{{if eq .Lang "en"}}Operational version policy{{else}}运行版本策略{{end}}</h1>
<p>{{if eq .Lang "en"}}Revision {{.Policy.Revision}}. Changes require step-up confirmation and are audited.{{else}}修订号 {{.Policy.Revision}}。变更需要二次确认并写入审计日志。{{end}}</p>
<form method="post" action="/admin/version-policy">
<input type="hidden" name="revision" value="{{.Policy.Revision}}">
<label>{{if eq .Lang "en"}}Minimum fleet version{{else}}机队最低版本{{end}}
<input name="fleet_min_version" value="{{.Policy.FleetMinimumVersion}}" required pattern="v[0-9]+\.[0-9]+\.[0-9]+">
<small>{{if eq .Lang "en"}}Operational rollout floor only. It cannot weaken the binary's compiled update trust floor.{{else}}这里只调整运行时发布下限，不能削弱二进制内置的更新信任下限。{{end}}</small></label>
{{if .FleetBelow}}<p class="warn">{{if eq .Lang "en"}}Impact preview: {{.FleetBelow}} fleet node(s) currently report a version below this floor.{{else}}影响预览：当前有 {{.FleetBelow}} 个机队节点低于此下限。{{end}}</p>{{end}}
<label>{{if eq .Lang "en"}}Minimum macOS release{{else}}macOS 最低版本{{end}}
<select name="mac_min_release">{{range .Releases}}<option value="{{.Version}}:{{.Build}}"{{if and (eq .Version $.Policy.MacMinimumVersion) (eq .Build $.Policy.MacMinimumBuild)}} selected{{end}}>{{.Version}} (build {{.Build}})</option>{{end}}</select>
<small>{{if eq .Lang "en"}}Only version/build pairs verified by the signed macOS release pipeline are selectable. Apps below this pair are blocked on their next policy refresh.{{else}}只能选择经签名 macOS 发布流程验证的版本与构建号；低于该值的应用会在下次刷新策略时被拦截。{{end}}</small></label>
<label>{{if eq .Lang "en"}}Recommended macOS version{{else}}macOS 推荐版本{{end}}
<select name="mac_recommended_version">{{range .Releases}}<option value="{{.Version}}"{{if eq .Version $.Policy.MacRecommendedVersion}} selected{{end}}>{{.Version}}</option>{{end}}</select></label>
<label>{{if eq .Lang "en"}}Latest macOS version{{else}}macOS 最新版本{{end}}
<select name="mac_latest_version">{{range .Releases}}<option value="{{.Version}}"{{if eq .Version $.Policy.MacLatestVersion}} selected{{end}}>{{.Version}}</option>{{end}}</select>
<small>{{if eq .Lang "en"}}The order must remain minimum <= recommended <= latest. Only verified releases are offered.{{else}}必须满足最低版本 ≤ 推荐版本 ≤ 最新版本；这里只提供已验证发布。{{end}}</small></label>
<button type="submit">{{if eq .Lang "en"}}Review and save{{else}}检查并保存{{end}}</button></form></body></html>`))
