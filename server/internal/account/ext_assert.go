package account

import "github.com/relayium/relayium/ext"

// *Service must keep satisfying ext.AdminHost: that's the whole point of the
// interface (see ext's doc comment) — it's the seam the commercial
// admin/billing layer will depend on once it moves to a private repo, instead
// of importing account directly. If a change to any AdminHost
// method's signature breaks this line, update ext.AdminHost deliberately
// rather than "fixing" the assertion by working around it.
var _ ext.AdminHost = (*Service)(nil)
