package signal

// RoomFor decides the signaling room for a /ws request from its query params.
// Precedence: pairing code > transfer token > LAN. When lan is true the caller
// derives the room from the client IP (RoomKey) with unlimited peers. When ok is
// false the request must be rejected (HTTP 403). nil validators reject.
func RoomFor(code, token string, validatePair, validateToken func(string) bool) (room string, maxPeers int, lan bool, ok bool) {
	if code != "" {
		if validatePair == nil || !validatePair(code) {
			return "", 0, false, false
		}
		return "c:" + code, 2, false, true
	}
	if token != "" {
		if validateToken == nil || !validateToken(token) {
			return "", 0, false, false
		}
		return "t:" + token, 2, false, true
	}
	return "", 0, true, true
}
