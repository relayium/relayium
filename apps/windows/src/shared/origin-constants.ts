// The product site's address, as a plain constant both processes may import.
//
// `main/origin.ts` owns which API origin a build DIALS, and that answer can be
// loopback in an engineering build. This is a different question: where the
// public site and its documentation are published. That never varies by build,
// and it lives in `shared/` because the help table needs it without importing
// anything from the main process.

/** Where the public site and every maintained guide are published. */
export const PRODUCTION_SITE_ORIGIN = "https://relayium.com";
