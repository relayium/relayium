export const MAX_FILES = 1000;
export const MAX_FILE_NAME_LENGTH = 1024;

export interface ManifestFileLike {
  name: string;
  size: number;
  path?: string;
}

const utf8 = new TextEncoder();

/**
 * Validate the attacker-controlled part of an encrypted file manifest.
 * Encryption authenticates the sender, not the sender's numbers, so every
 * receive path must cross this boundary before it displays or writes a file.
 */
export function validateManifestFiles<T extends ManifestFileLike>(value: unknown): T[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILES) {
    throw new Error("relayium: invalid manifest file count");
  }
  let total = 0;
  for (const raw of value) {
    if (!raw || typeof raw !== "object") throw new Error("relayium: invalid manifest entry");
    const file = raw as Partial<ManifestFileLike>;
    if (typeof file.name !== "string" || file.name.length === 0 || utf8.encode(file.name).length > MAX_FILE_NAME_LENGTH) {
      throw new Error("relayium: invalid manifest file name");
    }
    if (!Number.isSafeInteger(file.size) || file.size! < 0) {
      throw new Error("relayium: invalid manifest file size");
    }
    if (file.path !== undefined && (typeof file.path !== "string" || utf8.encode(file.path).length > MAX_FILE_NAME_LENGTH)) {
      throw new Error("relayium: invalid manifest file path");
    }
    total += file.size!;
    if (!Number.isSafeInteger(total) || total < 0) {
      throw new Error("relayium: invalid manifest total size");
    }
  }
  return value as T[];
}

export function manifestTotal(files: ManifestFileLike[]): number {
  validateManifestFiles(files);
  return files.reduce((sum, file) => sum + file.size, 0);
}
