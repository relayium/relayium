package main

import (
	"net/http"

	"github.com/relayium/relayium/account"
)

// pairUser resolves the owner of a POST /api/pair request. Minting is
// account-attributed (the owner is billed for the transfer's relay usage), but
// the CLI authenticates with a bearer token rather than a session cookie — so
// this must accept both, which account.UserFromAuth does.
//
// Until this existed the endpoint read the session cookie only, which meant no
// CLI user could obtain a pairing code by any route: `relayium send <file>
// <code>` had no reachable happy path.
func pairUser(acct *account.Service) func(*http.Request) (string, bool) {
	return func(r *http.Request) (string, bool) {
		u, ok := acct.UserFromAuth(r)
		return u.ID, ok
	}
}
