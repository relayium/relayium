//go:build !windows

// The update helper is Windows-only: it exists to call NT APIs directly.
//
// Building it elsewhere would produce a binary that cannot do the one thing it
// is for, so this refuses at compile time rather than shipping a stub that fails
// at runtime.
package main

func main() {
	panic("relayium-update-helper is Windows-only")
}
