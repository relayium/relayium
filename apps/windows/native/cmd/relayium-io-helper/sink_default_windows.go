//go:build windows && !relayiumwedgehook

package main

import (
	"github.com/relayium/relayium/apps/windows/native/internal/session"
	"github.com/relayium/relayium/apps/windows/native/internal/winio"
)

// newSink returns the real Windows sink. This is the only build that ships.
func newSink() session.Sink { return winio.NewSink() }
