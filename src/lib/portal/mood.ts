/**
 * Shift mood check-in scheduling (legacy portal Home pop-out, portal/index.html
 * ~1454-1486): START within 2h after shift start, END within 2h after shift end,
 * de-duped against the kinds already recorded in the caller's 16h DB lookback
 * (handles overnight US-hours shifts where start/end straddle midnight PHT).
 * No shift configured → one generic START check-in per lookback window.
 */

/** Parse "HH:MM" / "HH:MM:SS" into minutes-since-midnight; null when unset. */
export const parseShiftHM = (t: string | null): number | null => {
  if (!t) return null;
  const [a = 0, b = 0] = String(t).split(':').map(Number);
  return a * 60 + b;
};

export const moodPromptFor = (
  nowMin: number,
  shiftStart: number | null,
  shiftEnd: number | null,
  recentKinds: string[],
): 'start' | 'end' | null => {
  if (shiftStart != null && shiftEnd != null) {
    if ((nowMin - shiftStart + 1440) % 1440 <= 120 && !recentKinds.includes('start'))
      return 'start';
    if ((nowMin - shiftEnd + 1440) % 1440 <= 120 && !recentKinds.includes('end')) return 'end';
    return null;
  }
  return recentKinds.length === 0 ? 'start' : null;
};
