import { formatSize } from "./format";

// maxSizeHint returns a human-readable maximum upload size, or "" when unknown.
export function maxSizeHint(maxFileSize: number): string {
  return maxFileSize > 0 ? formatSize(maxFileSize) : "";
}
