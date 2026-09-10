// Whether a string is a well-formed pairing code, on the renderer side.
//
// A local check so a typo is answered instantly instead of by opening a socket
// to a room that cannot exist. It is NOT the authority: main validates the code
// again before it builds a URL, and the server is what decides whether a
// well-formed code names a real room. Three checks, none of which trusts the one
// before it.
//
// Pinned equal to `web/src/lib/pair-code`'s `isValidCode` by test, so the two
// cannot drift into disagreeing about what a user may type.

const CODE_RE = /^[0-9]{6}$/;

export function isWellFormedPairCode(code: string): boolean {
  return CODE_RE.test(code);
}
