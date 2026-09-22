// CS2KZ course tiers, in ascending difficulty (index 0 => "Tier 1").
export const TIERS = [
  'very-easy',
  'easy',
  'medium',
  'advanced',
  'hard',
  'very-hard',
  'extreme',
  'death',
  'unfeasible',
  'impossible',
];

/** 'very-hard' -> 'Very Hard' */
export function prettyTier(tier) {
  return String(tier)
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** 'advanced' -> 4 (1-based), or 0 if unknown. */
export function tierNumber(tier) {
  return TIERS.indexOf(tier) + 1;
}

/** 'advanced' -> 'Tier 4 · Advanced' */
export function tierLabel(tier) {
  return `Tier ${tierNumber(tier)} · ${prettyTier(tier)}`;
}
