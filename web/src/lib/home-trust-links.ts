/**
 * Where the home page's trust block sends a visitor to check a claim.
 *
 * Kept out of the message catalogue because a URL is not copy: it is the same
 * in every language, and a translator must not be able to change where "read
 * the code" lands. Kept out of the component so that
 * `scripts/test/home-trust-claims-test.mjs` can pin each target against the
 * repository — the protocol directory still exists, the README still has the
 * section the install row promises.
 *
 * The on-site security page is not here: it is language-dependent and comes
 * from `legalUrl("security", lang())`, as it does for FeatureStrip.
 */
export const HOME_TRUST_LINKS = {
  source: "https://github.com/relayium/relayium",
  protocol: "https://github.com/relayium/relayium/tree/main/docs/protocol",
  verify: "https://github.com/relayium/relayium#verify-a-download",
} as const;
