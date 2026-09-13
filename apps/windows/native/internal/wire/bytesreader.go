package wire

import "bytes"

// Named so the reason survives: json.Decoder is used instead of json.Unmarshal
// purely for DisallowUnknownFields, which turns a host that invents a field into
// an explicit protocol error rather than a silently ignored one.
func newBytesReader(b []byte) *bytes.Reader { return bytes.NewReader(b) }
