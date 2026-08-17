// Command relayium-local-bootstrap creates the deterministic account used by
// the loopback-only engineering harness. It is deliberately an offline command,
// not an HTTP endpoint or a server flag.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/relayium/relayium/account"
)

const (
	markerContents = "relayium-local-v2-state-v1\n"
	email          = "engineering@relayium.local"
	password       = "relayium-local-v2"
)

func main() {
	stateRoot := flag.String("state-root", "", "absolute marker-guarded local state directory")
	flag.Parse()
	if *stateRoot == "" || !filepath.IsAbs(*stateRoot) {
		log.Fatal("-state-root must be absolute")
	}
	root, err := filepath.EvalSymlinks(*stateRoot)
	if err != nil {
		log.Fatal(err)
	}
	marker, err := os.ReadFile(filepath.Join(root, ".relayium-local-v2-state"))
	if err != nil || string(marker) != markerContents {
		log.Fatal("state root marker is missing or invalid")
	}
	dbPath := filepath.Join(root, "relayium.db")
	store, err := account.OpenSQLite(dbPath)
	if err != nil {
		log.Fatal(err)
	}
	defer store.Close()

	ctx := context.Background()
	svc := account.NewService(store, &account.LogMailer{Log: log.New(os.Stderr, "local bootstrap: ", 0)}, account.Config{
		BaseURL: "http://127.0.0.1:18080",
	})
	user, err := svc.Register(ctx, email, password, "Relayium Engineering")
	if errors.Is(err, account.ErrEmailTaken) {
		var ok bool
		user, ok, err = store.GetUserByIdentity(ctx, "email", email)
		if err == nil && !ok {
			err = fmt.Errorf("existing email identity has no user")
		}
	}
	if err != nil {
		log.Fatal(err)
	}
	if err := store.SetEmailVerified(ctx, user.ID); err != nil {
		log.Fatal(err)
	}
	if _, err := svc.Login(ctx, email, password); err != nil {
		log.Fatalf("deterministic account is not usable: %v", err)
	}
	fmt.Println("local account ready: " + email)
}
