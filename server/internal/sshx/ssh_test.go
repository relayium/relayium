package sshx

import (
	"reflect"
	"testing"

	"github.com/relayium/relayium/internal/xfer"
)

func TestBuildArgs(t *testing.T) {
	e := xfer.Endpoint{User: "me", Host: "srv", Path: "/data"}
	got := BuildArgs(e, "relayium __recv /data", Opts{IdentityFile: "/k/id", Port: 2222})
	want := []string{"-i", "/k/id", "-p", "2222", "--", "me@srv", "relayium __recv /data"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("BuildArgs = %v, want %v", got, want)
	}
}

func TestBuildArgsMinimal(t *testing.T) {
	e := xfer.Endpoint{Host: "srv"}
	got := BuildArgs(e, "echo hi", Opts{})
	want := []string{"--", "srv", "echo hi"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("BuildArgs = %v, want %v", got, want)
	}
}
