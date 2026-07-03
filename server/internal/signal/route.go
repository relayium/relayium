package signal

// RoomFor decides the signaling room for a /ws request from its query params.
// A pairing code names a 2-peer room "c:<code>"; without one the caller derives
// the LAN room from the client IP (RoomKey) with unlimited peers. When ok is
// false the request must be rejected (HTTP 403). A nil validator rejects.
func RoomFor(code string, validatePair func(string) bool) (room string, maxPeers int, lan bool, ok bool) {
	if code != "" {
		if validatePair == nil || !validatePair(code) {
			return "", 0, false, false
		}
		return "c:" + code, 2, false, true
	}
	return "", 0, true, true
}
