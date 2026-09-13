package wire

import "errors"

// Isolated so the unwrapping rule is stated once. `errors.As` walks the chain,
// which matters because the Windows sink wraps NTSTATUS values.
func asError(err error, target **Error) bool { return errors.As(err, target) }
