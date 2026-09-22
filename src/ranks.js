// =============================================================================
//  CKZ RANK LADDER  —  EDIT THIS TO YOUR SCHEME
// =============================================================================
// Each member is given the highest rank whose `minRating` is <= their
// ckz_rating (which is the CS2KZ "Player Points" total). Ranks must stay
// ordered ascending by minRating. `color` is the Discord role colour.
//
// CS2KZ only officially documents the first three tiers; the rest are
// placeholders. Replace the names / thresholds / colours with the exact
// ladder you want — this is the single source of truth for both the
// leaderboard badges and the auto-created Discord roles.
// -----------------------------------------------------------------------------
export const RANKS = [
  { name: 'Noob', minRating: 0, color: 0x95a5a6 },
  { name: 'Intermediate', minRating: 5000, color: 0x2ecc71 },
  { name: 'Elite', minRating: 10000, color: 0x3498db },
  { name: 'Master', minRating: 15000, color: 0x9b59b6 },
  { name: 'Pro', minRating: 20000, color: 0xf1c40f },
  { name: 'Legend', minRating: 25000, color: 0xe74c3c },
  { name: 'God', minRating: 30000, color: 0xe91e63 },
];

/** Highest rank a rating qualifies for, or null if rating isn't a number. */
export function rankFor(rating) {
  if (typeof rating !== 'number' || Number.isNaN(rating)) return null;
  let match = null;
  for (const rank of RANKS) {
    if (rating >= rank.minRating) match = rank;
    else break;
  }
  return match ?? RANKS[0];
}
