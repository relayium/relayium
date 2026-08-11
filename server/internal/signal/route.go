package signal

// PairRoomPrefix is what a pairing code's signaling room name starts with.
//
// Exported because the room name is now read back as well as written: the join
// observer has to recover "which code" from "which room" to tell the pre-upload
// lifecycle a code was claimed. Two hand-written "c:"s, one building the name and
// one parsing it, is a rename away from a lifecycle that silently stops firing.
const PairRoomPrefix = "c:"

// PairRoomFor returns the signaling room name for a pairing code.
func PairRoomFor(code string) string { return PairRoomPrefix + code }

// RoomFor decides the signaling room for a /ws request from its query params.
// A pairing code names a 2-peer room "c:<code>"; without one the caller derives
// the LAN room from the client IP (RoomKey) with unlimited peers. When ok is
// false the request must be rejected (HTTP 403). A nil validator rejects.
func RoomFor(code string, validatePair func(string) bool) (room string, maxPeers int, lan bool, ok bool) {
	if code != "" {
		if validatePair == nil || !validatePair(code) {
			return "", 0, false, false
		}
		return PairRoomFor(code), 2, false, true
	}
	return "", 0, true, true
}
