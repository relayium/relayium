// Reading what `safeStorage.encryptString` wrote, and nothing else.
//
// This type has NO encrypt member, deliberately. The old format depends on a
// Chromium master key that is only committed to `Local State` at a clean
// shutdown — Windows run 34466025680 showed a forced termination before that
// commit leaves the sealed bytes intact and permanently undecryptable. Writing
// it again would keep manufacturing that failure, so "we accidentally kept
// writing the broken format" is made unrepresentable rather than forbidden by a
// comment.

export interface LegacyReader {
  isAvailable(): boolean;
  decrypt(sealed: Buffer): string;
}

/** The real one, over Electron's synchronous `safeStorage`. */
export async function electronLegacyReader(): Promise<LegacyReader> {
  const { safeStorage } = await import("electron");
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    decrypt: (sealed) => safeStorage.decryptString(sealed),
  };
}
