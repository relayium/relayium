// The host environment Electron would provide, and nothing else.
//
// `src/main/build-mode.ts` imports `app` from `electron` at module scope to ask
// one question — is this build packaged — and `origin.ts` imports it, so every
// module under `src/main/stored/**` needs an `electron` specifier to resolve
// before it will load at all. This harness is a Node script by design: it
// stands up a real Go server and drives compiled product modules, and it cannot
// be an Electron app without giving up the server it exists to talk to.
//
// So this resolves the specifier and answers the two things `build-mode` reads.
// It is NOT a stand-in for anything under test: no product code is replaced, no
// behaviour is simulated, and the modules that load because of it are the
// shipped ones. `isPackaged: false` is also the truthful answer here — this is
// an unpackaged checkout, which is exactly what the flag means.
export const app = {
  isPackaged: false,
  getAppPath: () => process.cwd(),
  getPath: (name) => process.env.RELAYIUM_STUB_PATHS === undefined ? process.cwd() : `${process.cwd()}/${name}`,
};
export default { app };
