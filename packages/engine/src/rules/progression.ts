/**
 * XP-driven leveling. Cumulative XP required to REACH a level follows a smooth
 * quadratic: threshold(L) = 50 * (L-1) * L
 *   L1=0, L2=100, L3=300, L4=600, L5=1000, L6=1500, L7=2100, L8=2800, ...
 * Tunable. XP is awarded (earned, scaled small->large) by the award_xp intent,
 * which auto-levels the character whenever the running total crosses a threshold.
 */
export function xpThreshold(level: number): number {
  const L = Math.max(1, Math.floor(level));
  return 50 * (L - 1) * L;
}

/** The level a given cumulative XP total grants (capped at 20). */
export function levelForXp(xp: number): number {
  let L = 1;
  while (L < 20 && xp >= xpThreshold(L + 1)) L++;
  return L;
}

/** XP remaining until the next level (0 at level 20). */
export function xpToNext(xp: number): number {
  const L = levelForXp(xp);
  return L >= 20 ? 0 : xpThreshold(L + 1) - xp;
}
