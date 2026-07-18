// Deterministic on-radar position for a peer, derived only from its id so a
// device keeps the same spot across re-renders/renames within a session. No
// Math.random / Date.now — placement must be stable and reproducible.

const INNER = 0.42; // nearest fraction of the radius a blip may sit to center
const OUTER = 0.82; // farthest fraction of the radius a blip may sit from center

// FNV-1a 32-bit — tiny, stable, dependency-free.
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface BlipPos {
  xPct: number;
  yPct: number;
}

// crowded (>=4 peers) snaps the radius to one of two rings so labels are less
// likely to overlap; otherwise the radius spreads smoothly across the band.
export function blipPos(id: string, crowded = false): BlipPos {
  const h = hashId(id);
  const angle = (h % 360) * (Math.PI / 180);
  let frac: number;
  if (crowded) {
    frac = (h >>> 19) % 2 === 0
      ? INNER + (OUTER - INNER) * 0.3
      : INNER + (OUTER - INNER) * 0.8;
  } else {
    const t = ((h >>> 9) % 1000) / 1000; // independent slice, 0..1
    frac = INNER + (OUTER - INNER) * t;
  }
  return {
    xPct: 50 + Math.cos(angle) * frac * 50,
    yPct: 50 + Math.sin(angle) * frac * 50,
  };
}
