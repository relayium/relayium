package updio

import "bytes"

func newBytesReader(payload []byte) *bytes.Reader { return bytes.NewReader(payload) }
