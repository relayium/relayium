// Small, dependency-free formatting helpers shared across components.

export interface DurUnits {
  d: string; // day suffix, e.g. "天" / "d"
  h: string; // hour suffix, e.g. "小时" / "h"
  m: string; // minute suffix, e.g. "分钟" / "m"
}

/**
 * Human-readable "time left" at minute resolution. Shows the two most
 * significant non-zero units (days+hours, or hours+minutes), matching how
 * receivers reason about an expiry. Never negative — a past deadline reads as 0.
 */
/** Human-readable byte size, binary units, one decimal below 10 (e.g. "3.7 MB"). */
export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

export function formatRemaining(secLeft: number, u: DurUnits): string {
  const totalMin = Math.max(0, Math.floor(secLeft / 60));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}${u.d} ${h}${u.h}`;
  if (h > 0) return `${h}${u.h} ${m}${u.m}`;
  return `${m}${u.m}`;
}
