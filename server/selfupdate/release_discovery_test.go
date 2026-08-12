package selfupdate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// These tests own LatestTag's one job: pick the highest published canonical
// server release out of a repository that releases more than one thing.
//
// The bug they exist for shipped: on 2026-08-12 the central release check
// cached `macos-v1.1.3` as the newest relayium release, because
// /releases/latest is repository-wide and the macOS app had been released more
// recently than the server. The fleet was on v0.18.0 the whole time. Nothing
// about that is specific to that one macOS release — it returns on the next one.

// fakeGHRelease is one entry of the GitHub release list, in the shape LatestTag
// decodes. Its JSON tags must match githubRelease's or these tests would pass
// against a decoder that reads nothing.
type fakeGHRelease struct {
	TagName    string `json:"tag_name"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
}

// published/draftRel/prerelease build list entries, so each test reads as the
// repository state it describes.
func published(tags ...string) []fakeGHRelease {
	out := make([]fakeGHRelease, 0, len(tags))
	for _, t := range tags {
		out = append(out, fakeGHRelease{TagName: t})
	}
	return out
}

func draftRel(tag string) fakeGHRelease {
	return fakeGHRelease{TagName: tag, Draft: true}
}

func prerelease(tag string) fakeGHRelease {
	return fakeGHRelease{TagName: tag, Prerelease: true}
}

// releaseAPI stands in for GitHub's release-list endpoint. pages[N-1] is what
// page N serves; a page past the end serves an empty list. failPage/badJSONPage
// break one specific page, which is how the later-page failures are exercised.
// requested records the page numbers asked for, in order — the assertion that
// the scan stays bounded, and that it does not stop early.
type releaseAPI struct {
	pages       [][]fakeGHRelease
	failPage    int
	badJSONPage int
	// alwaysFull makes every page a full page forever, so the scan can only be
	// stopped by its own cap.
	alwaysFull []fakeGHRelease

	mu        sync.Mutex
	requested []int
}

func (a *releaseAPI) server(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/relayium/relayium/releases", func(w http.ResponseWriter, r *http.Request) {
		// Asserted, not assumed: at per_page < 100 the caller would need more
		// requests for the same coverage, and a page size the fake and the
		// implementation disagree on would make "short page = last page" mean
		// two different things in the test and in production.
		if got := r.URL.Query().Get("per_page"); got != strconv.Itoa(releasesPerPage) {
			t.Errorf("per_page = %q, want %d", got, releasesPerPage)
		}
		page, err := strconv.Atoi(r.URL.Query().Get("page"))
		if err != nil {
			t.Errorf("page = %q, want a number", r.URL.Query().Get("page"))
			http.Error(w, "bad page", http.StatusBadRequest)
			return
		}
		a.mu.Lock()
		a.requested = append(a.requested, page)
		a.mu.Unlock()

		if page == a.failPage {
			http.Error(w, "rate limited", http.StatusForbidden)
			return
		}
		if page == a.badJSONPage {
			io.WriteString(w, `[{"tag_name": `) // truncated mid-object
			return
		}
		out := []fakeGHRelease{}
		switch {
		case a.alwaysFull != nil:
			out = a.alwaysFull
		case page-1 < len(a.pages):
			out = a.pages[page-1]
		}
		if err := json.NewEncoder(w).Encode(out); err != nil {
			t.Errorf("encode page %d: %v", page, err)
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func (a *releaseAPI) pagesRequested() []int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]int(nil), a.requested...)
}

func (a *releaseAPI) opts(srv *httptest.Server) Options {
	return Options{Repo: "relayium/relayium", APIBase: srv.URL, HTTP: srv.Client()}
}

// latestFrom runs a scan over one page of releases — the common shape.
func latestFrom(t *testing.T, rels []fakeGHRelease) (string, error) {
	t.Helper()
	api := &releaseAPI{pages: [][]fakeGHRelease{rels}}
	return LatestTag(context.Background(), api.opts(api.server(t)))
}

// The production incident, as a test: a macOS release newer than every server
// release must not become the answer.
func TestLatestTagIgnoresNewerForeignFamilyRelease(t *testing.T) {
	// Newest first, as the API actually orders it — so the foreign tag is the
	// one /releases/latest returned, and the one a scan that trusted ordering
	// would still return.
	got, err := latestFrom(t, published("macos-v1.1.4", "v0.19.0", "macos-v1.1.3", "v0.18.0"))
	if err != nil {
		t.Fatalf("LatestTag: %v", err)
	}
	if got != "v0.19.0" {
		t.Fatalf("LatestTag = %q, want v0.19.0 — a macOS release is not a server release", got)
	}
}

// Tags that merely start with "v" are not server tags. `vmacos-v1.2.0` is not
// hypothetical: auto-release.yml created exactly that tag on 2026-08-12 by
// doing version arithmetic on `macos-v1.1.3`. Had that release published, a
// matcher loose enough to accept it would install it.
func TestLatestTagIgnoresMalformedVPrefixedTags(t *testing.T) {
	got, err := latestFrom(t, published(
		"vmacos-v1.2.0", // the tag the release incident produced
		"v1.2",          // too few components
		"v1.2.3.4",      // too many
		"v0.19.0-rc.1",  // pre-release suffix
		"v0.19.0+build", // build metadata
		"V0.20.0",       // capital V is a different tag
		"0.21.0",        // no "v": not the shape this repo tags servers with
		"v0.19.0",
	))
	if err != nil {
		t.Fatalf("LatestTag: %v", err)
	}
	if got != "v0.19.0" {
		t.Fatalf("LatestTag = %q, want v0.19.0", got)
	}
}

// A repository whose only "v" tags are malformed has no server release, and
// must say so rather than return one of them.
func TestLatestTagRejectsAMalformedOnlyRepo(t *testing.T) {
	got, err := latestFrom(t, published("vmacos-v1.2.0", "v1.2", "macos-v1.1.4"))
	if !errors.Is(err, ErrNoRelease) {
		t.Fatalf("err = %v, want ErrNoRelease", err)
	}
	if got != "" {
		t.Fatalf("LatestTag = %q, want the empty string alongside an error", got)
	}
}

// /releases/latest excluded drafts and pre-releases; the list endpoint does
// not. Skipping them is what keeps the old behaviour, and it is load-bearing in
// both directions: a draft is not published (its assets do not exist at the
// download URL, so a rollout to it would fail on every node), and a
// pre-release is published deliberately for people who opt in.
func TestLatestTagSkipsDraftsAndPrereleases(t *testing.T) {
	got, err := latestFrom(t, append(
		[]fakeGHRelease{draftRel("v9.9.9"), prerelease("v9.9.8")},
		published("v0.19.0", "v0.18.0")...,
	))
	if err != nil {
		t.Fatalf("LatestTag: %v", err)
	}
	if got != "v0.19.0" {
		t.Fatalf("LatestTag = %q, want v0.19.0 — a draft or pre-release is not a published release", got)
	}
}

func TestLatestTagRejectsADraftAndPrereleaseOnlyRepo(t *testing.T) {
	_, err := latestFrom(t, []fakeGHRelease{draftRel("v1.0.0"), prerelease("v0.9.0")})
	if !errors.Is(err, ErrNoRelease) {
		t.Fatalf("err = %v, want ErrNoRelease", err)
	}
}

// v0.10.0 > v0.9.0 numerically and < it as text, in either list order. The text
// answer is the plausible-looking wrong one: it would pin the fleet to a
// version that is actually older, and the downgrade guard would then refuse
// every node's update with a confusing error.
func TestLatestTagComparesVersionsNumericallyInAnyOrder(t *testing.T) {
	for _, order := range [][]string{
		{"v0.9.0", "v0.10.0"},
		{"v0.10.0", "v0.9.0"},
	} {
		got, err := latestFrom(t, published(order...))
		if err != nil {
			t.Fatalf("LatestTag(%v): %v", order, err)
		}
		if got != "v0.10.0" {
			t.Fatalf("LatestTag(%v) = %q, want v0.10.0", order, got)
		}
	}
}

// manyForeign builds n foreign-family releases, enough to fill a page.
func manyForeign(n int) []fakeGHRelease {
	out := make([]fakeGHRelease, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, fakeGHRelease{TagName: fmt.Sprintf("macos-v2.0.%d", i)})
	}
	return out
}

// A full page of foreign releases must not hide the server release behind it.
// This is the case a single-page scan gets wrong, and it is reachable: the
// macOS app releases on its own cadence.
func TestLatestTagFindsAServerReleaseOnALaterPage(t *testing.T) {
	api := &releaseAPI{pages: [][]fakeGHRelease{
		manyForeign(releasesPerPage), // exactly one full page, no server tag
		published("v0.19.0", "v0.18.0"),
	}}
	got, err := LatestTag(context.Background(), api.opts(api.server(t)))
	if err != nil {
		t.Fatalf("LatestTag: %v", err)
	}
	if got != "v0.19.0" {
		t.Fatalf("LatestTag = %q, want v0.19.0 from page 2", got)
	}
	if pages := api.pagesRequested(); len(pages) != 2 || pages[0] != 1 || pages[1] != 2 {
		t.Fatalf("pages requested = %v, want [1 2]", pages)
	}
}

// A page that does not answer aborts the scan, even though page 1 already held
// a perfectly good tag. Returning v0.18.0 here would be a statement about what
// the newest release is, drawn from evidence known to be incomplete — and it is
// exactly the shape that would report the fleet as current while a newer
// release sat on the page that failed.
func TestLatestTagFailsClosedWhenALaterPageFails(t *testing.T) {
	page1 := append(manyForeign(releasesPerPage-1), published("v0.18.0")...)
	for _, tc := range []struct {
		name string
		api  *releaseAPI
	}{
		{"http error", &releaseAPI{pages: [][]fakeGHRelease{page1}, failPage: 2}},
		{"truncated body", &releaseAPI{pages: [][]fakeGHRelease{page1}, badJSONPage: 2}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := LatestTag(context.Background(), tc.api.opts(tc.api.server(t)))
			if err == nil {
				t.Fatalf("LatestTag = %q, nil — an incomplete scan must not answer", got)
			}
			if got != "" {
				t.Fatalf("LatestTag = %q, want the empty string on failure", got)
			}
			// The distinction the caller acts on: this is "could not look",
			// not "looked and there is nothing". ReleaseChecker keeps its last
			// known value for the first and would be right to record the
			// second.
			if errors.Is(err, ErrNoRelease) {
				t.Fatalf("a fetch failure must not read as ErrNoRelease: %v", err)
			}
		})
	}
}

// The first page failing is the same answer, and it is the ordinary outage:
// rate limit, DNS, a proxy. ReleaseChecker.CheckOnce writes nothing on an
// error, so the panel keeps its last known release rather than claiming to be
// current.
func TestLatestTagFailsClosedWhenTheFirstPageFails(t *testing.T) {
	api := &releaseAPI{failPage: 1}
	if got, err := LatestTag(context.Background(), api.opts(api.server(t))); err == nil || got != "" {
		t.Fatalf("LatestTag = %q, %v; want an error and no tag", got, err)
	}
}

// A repository with no server release at all — every release belongs to another
// family — is a distinct, non-error-ish outcome that still must not produce a
// tag. ErrNoRelease names it so a caller can tell it from an outage.
func TestLatestTagErrorsWhenNoServerReleaseExists(t *testing.T) {
	api := &releaseAPI{pages: [][]fakeGHRelease{manyForeign(3)}}
	got, err := LatestTag(context.Background(), api.opts(api.server(t)))
	if !errors.Is(err, ErrNoRelease) {
		t.Fatalf("err = %v, want ErrNoRelease", err)
	}
	if got != "" {
		t.Fatalf("LatestTag = %q, want no tag", got)
	}
	// This line lands in a self-hoster's log every hour, so it has to say which
	// repository was scanned — "no release found" alone would send someone
	// looking at the wrong one.
	if !strings.Contains(err.Error(), "relayium/relayium") {
		t.Errorf("error %q does not name the repository it scanned", err)
	}
}

// A short page ends the scan. Without this the hourly check on every
// self-hosted instance would spend maxReleasePages requests against an
// unauthenticated API allowing 60 an hour, for a repo that fits in one page.
func TestLatestTagStopsAtAShortPage(t *testing.T) {
	api := &releaseAPI{pages: [][]fakeGHRelease{published("v0.19.0", "v0.18.0")}}
	if _, err := LatestTag(context.Background(), api.opts(api.server(t))); err != nil {
		t.Fatal(err)
	}
	if pages := api.pagesRequested(); len(pages) != 1 {
		t.Fatalf("pages requested = %v, want exactly one — a short page is the last page", pages)
	}
}

// wantPagesUpTo asserts the scan asked for pages 1..n and stopped: the bound in
// both directions, since reading fewer would be a silent truncation and reading
// more would be the unbounded walk the cap exists to prevent.
func wantPagesUpTo(t *testing.T, api *releaseAPI, n int) {
	t.Helper()
	pages := api.pagesRequested()
	if len(pages) != n {
		t.Fatalf("pages requested = %v, want exactly %d", pages, n)
	}
	for i, p := range pages {
		if p != i+1 {
			t.Fatalf("pages requested = %v, want 1..%d in order", pages, n)
		}
	}
}

// A server that never runs out of pages must not be walked forever, and — the
// part that matters — must not answer from the window it did manage to read.
//
// Both subtests run against a list that is still full at the cap, so page
// maxReleasePages+1 exists and was never requested. What is on it is unknown and
// unknowable to this scan, which is the whole argument: it may hold v0.20.0, or
// it may hold the repository's only server release. Answering "v0.19.0" in the
// first case parks the fleet on a stale version while reporting itself current;
// answering ErrNoRelease in the second tells a self-hoster the release channel
// is empty when it is not. The scan does not get to guess between them.
func TestLatestTagFailsClosedAtThePageCap(t *testing.T) {
	for _, tc := range []struct {
		name string
		// full is served for every page, forever.
		full []fakeGHRelease
	}{
		// A candidate sits inside the scanned window — the case where returning
		// best-so-far is most tempting, and most wrong.
		{"a candidate inside the window", append(manyForeign(releasesPerPage-1), published("v0.19.0")...)},
		// Nothing in the window is a server release. This must NOT collapse into
		// ErrNoRelease: "I did not finish looking" and "there is nothing" are
		// different facts, and only the second is safe to act on.
		{"nothing but foreign releases", manyForeign(releasesPerPage)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			api := &releaseAPI{alwaysFull: tc.full}
			got, err := LatestTag(context.Background(), api.opts(api.server(t)))
			if err == nil {
				t.Fatalf("LatestTag = %q, nil — a scan that never reached the end of the list must not answer", got)
			}
			if got != "" {
				t.Fatalf("LatestTag = %q, want the empty string — never a partial best at the cap", got)
			}
			if errors.Is(err, ErrNoRelease) {
				t.Fatalf("a truncated scan must not read as ErrNoRelease: %v", err)
			}
			if !errors.Is(err, ErrScanTruncated) {
				t.Fatalf("err = %v, want ErrScanTruncated", err)
			}
			// The line a self-hoster gets hourly: it has to name the repository
			// and point at the knob, or the only available action is invisible.
			if !strings.Contains(err.Error(), "relayium/relayium") {
				t.Errorf("error %q does not name the repository it scanned", err)
			}
			if !strings.Contains(err.Error(), "maxReleasePages") {
				t.Errorf("error %q does not say what to raise", err)
			}
			wantPagesUpTo(t, api, maxReleasePages)
		})
	}
}

// The boundary the cap check must not swallow: a list that ENDS exactly on the
// last page the budget allows is a complete scan, not a truncated one. Off by
// one here would turn every fully-scanned repository near the limit into a
// permanent error.
func TestLatestTagSucceedsWhenTheLastAllowedPageIsShort(t *testing.T) {
	pages := make([][]fakeGHRelease, maxReleasePages)
	for i := 0; i < maxReleasePages-1; i++ {
		pages[i] = manyForeign(releasesPerPage)
	}
	pages[maxReleasePages-1] = published("v0.19.0", "v0.18.0") // short: end of list
	api := &releaseAPI{pages: pages}
	got, err := LatestTag(context.Background(), api.opts(api.server(t)))
	if err != nil {
		t.Fatalf("LatestTag: %v", err)
	}
	if got != "v0.19.0" {
		t.Fatalf("LatestTag = %q, want v0.19.0 — the list ended inside the budget", got)
	}
	wantPagesUpTo(t, api, maxReleasePages)
}

// The context passed in must actually govern the requests; the release check
// wraps this call in a 30s deadline precisely so a stalled poll cannot wedge
// the hourly poller forever.
func TestLatestTagHonoursContextCancellation(t *testing.T) {
	api := &releaseAPI{pages: [][]fakeGHRelease{published("v0.19.0")}}
	srv := api.server(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := LatestTag(ctx, api.opts(srv)); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

// isCanonicalServerTag is the matcher every rule above rests on, and it is
// deliberately stricter than IsPlainVersion — which must keep accepting a bare
// "0.19.0" because that is what goreleaser burns into main.version.
func TestIsCanonicalServerTag(t *testing.T) {
	for _, tag := range []string{"v0.0.0", "v0.19.0", "v1.2.3", "v10.20.30"} {
		if !isCanonicalServerTag(tag) {
			t.Errorf("isCanonicalServerTag(%q) = false, want true", tag)
		}
	}
	for _, tag := range []string{
		"", "v", "v1", "v1.2", "v1.2.3.4", "v1.2.3-rc1", "v1.2.3+meta",
		"macos-v1.1.3", "vmacos-v1.2.0", "V1.2.3", "1.2.3", " v1.2.3", "v1.2.3 ",
		"latest", "dev", "v-1.2.3", "vx.y.z",
	} {
		if isCanonicalServerTag(tag) {
			t.Errorf("isCanonicalServerTag(%q) = true, want false", tag)
		}
	}
	// The looser matcher stays loose: main.version has no "v".
	if !IsPlainVersion("0.19.0") {
		t.Error("IsPlainVersion must still accept a bare version — it reads main.version")
	}
}
