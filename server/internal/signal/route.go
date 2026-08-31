package signal

import "strings"

// PairRoomPrefix is what a pairing code's signaling room name starts with.
//
// Exported because the room name is now read back as well as written: the join
// observer has to recover "which code" from "which room" to tell the pre-upload
// lifecycle a code was claimed. Two hand-written "c:"s, one building the name and
// one parsing it, is a rename away from a lifecycle that silently stops firing.
const PairRoomPrefix = "c:"

const pairRoomGenerationSeparator = ":"

// PairRoomFor returns the signaling room name for a pairing code.
func PairRoomFor(code string) string { return PairRoomPrefix + code }

func pairRoomForGeneration(code, generation string) string {
	return PairRoomPrefix + code + pairRoomGenerationSeparator + generation
}

func codeFromGeneratedPairRoom(room string) (string, bool) {
	rest, ok := strings.CutPrefix(room, PairRoomPrefix)
	if !ok {
		return "", false
	}
	code, generation, ok := strings.Cut(rest, pairRoomGenerationSeparator)
	return code, ok && ValidCodeFormat(code) && generation != ""
}

// RoomFor is the legacy room-shaping helper used by isolated callers and tests.
// Production uses RoomForResolved so every mint has an opaque generation.
// Without a code the caller derives the LAN room from the client IP (RoomKey)
// with unlimited peers. When ok is false the request must be rejected (HTTP
// 403). A nil validator rejects.
func RoomFor(code string, validatePair func(string) bool) (room string, maxPeers int, lan bool, ok bool) {
	if code != "" {
		if validatePair == nil || !validatePair(code) {
			return "", 0, false, false
		}
		return PairRoomFor(code), 2, false, true
	}
	return "", 0, true, true
}

// RoomForResolved is RoomFor with an optional authoritative room resolver.
// Production supplies PairRegistry.RoomFor so each mint gets a distinct opaque
// room generation. A nil resolver preserves the legacy helper for isolated
// callers and tests; it never weakens the production wsRoute wiring.
func RoomForResolved(code string, validatePair func(string) bool, resolvePair func(string) (string, bool)) (room string, maxPeers int, lan bool, ok bool) {
	if code == "" {
		return "", 0, true, true
	}
	if resolvePair != nil {
		room, ok := resolvePair(code)
		if !ok {
			return "", 0, false, false
		}
		return room, 2, false, true
	}
	return RoomFor(code, validatePair)
}
