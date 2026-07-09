package account

import "sync"

// maxConcurrentUploadsPerUser caps in-flight POST /api/files per account (M1).
// 500 parallel uploads each writing up to MaxFileSize before the quota refuses
// them is tens of GB of instantaneous disk pressure; 5 is ample for a real user.
const maxConcurrentUploadsPerUser = 5

// uploadSem is a per-userID in-flight counter. Entries are pruned at zero so the
// map is bounded by the set of currently-uploading accounts.
type uploadSem struct {
	mu       sync.Mutex
	inflight map[string]int
	max      int
}

func newUploadSem(max int) *uploadSem {
	return &uploadSem{inflight: map[string]int{}, max: max}
}

// acquire reserves an upload slot for userID, returning false if already at max.
func (s *uploadSem) acquire(userID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inflight[userID] >= s.max {
		return false
	}
	s.inflight[userID]++
	return true
}

// release frees a slot; the map entry is deleted once it hits zero.
func (s *uploadSem) release(userID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inflight[userID] <= 1 {
		delete(s.inflight, userID)
		return
	}
	s.inflight[userID]--
}
