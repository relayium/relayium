//go:build !linux && !darwin

package coturnbridge

import "errors"

var errUnsupported = errors.New("coturnbridge: provider epoch is only readable on linux (and darwin for the local harness)")

func bootID() (string, error) { return "", errUnsupported }

func processStart(int) (string, uint64, error) { return "", 0, errUnsupported }
