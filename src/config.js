import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value || value.startsWith('your-')) {
    console.error(`❌ Missing required environment variable: ${name}`);
    console.error('   Copy .env.example to .env and fill in your bot credentials.');
    process.exit(1);
  }
  return value;
}

export const config = {
  token: required('DISCORD_TOKEN'),
  clientId: required('CLIENT_ID'),
  guildId: process.env.GUILD_ID?.trim() || null,
  announceChannelId: process.env.ANNOUNCE_CHANNEL_ID?.trim() || null,
  pollIntervalMs: Math.max(30, Number(process.env.POLL_INTERVAL_SECONDS) || 120) * 1000,
  minPoints: Number(process.env.ANNOUNCE_MIN_POINTS) || 0,
  defaultMode: (process.env.DEFAULT_MODE || 'ckz').toLowerCase() === 'vnl' ? 'vnl' : 'ckz',
  apiBase: (process.env.CS2KZ_API_BASE || 'https://api.cs2kz.org').replace(/\/+$/, ''),
  // Leaderboard + rank-role sync
  leaderboardIntervalMs: Math.max(60, Number(process.env.LEADERBOARD_INTERVAL_SECONDS) || 900) * 1000,
  enableRankRoles: (process.env.ENABLE_RANK_ROLES || 'true').toLowerCase() !== 'false',
  enableRankupAnnouncements: (process.env.ENABLE_RANKUP_ANNOUNCEMENTS || 'true').toLowerCase() !== 'false',
  rankRolePrefix: (process.env.RANK_ROLE_PREFIX ?? 'CKZ').trim(),
  leaderboardTitle: (process.env.LEADERBOARD_TITLE || 'CS2KZ Leaderboard — CKZ').trim(),
  // All commands live under one parent command, e.g. /sgkz register — avoids clashing with other bots.
  commandRoot: rootName(process.env.COMMAND_ROOT, 'sgkz'),
  // Birthday reminders — their own command root and channel.
  birthdayRoot: rootName(process.env.BIRTHDAY_COMMAND_ROOT, 'sghb'),
  birthdayChannelId: process.env.BIRTHDAY_CHANNEL_ID?.trim() || null,
  birthdayHour: Math.min(23, Math.max(0, Number(process.env.BIRTHDAY_HOUR ?? 9) || 0)),
  birthdayTimeZone: process.env.BIRTHDAY_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone,
  // CS2 team drafter — reads "AURA - x" roles (lower = stronger).
  draftRoot: rootName(process.env.DRAFT_COMMAND_ROOT, 'sgdraft'),
  draftGirlRole: process.env.DRAFT_GIRL_ROLE?.trim() || 'HOT GIRLS🎀', // role name or id
  draftAuraGod: numberOr(process.env.DRAFT_AURA_GOD, 0),
  draftAuraKing: numberOr(process.env.DRAFT_AURA_KING, 0.5),
  draftDefaultAura: numberOr(process.env.DRAFT_DEFAULT_AURA, 5.5), // players with no AURA role
  draftReshuffleTolerance: numberOr(process.env.DRAFT_RESHUFFLE_TOLERANCE, 1),
  // Keep open lobbies at the bottom of their channel: re-post after this many
  // seconds without new messages (0 = off). Never waits more than 4× this.
  draftStickySeconds: Math.max(0, numberOr(process.env.DRAFT_STICKY_SECONDS, 5)),
  // Contacts — Instagram handles (public) and phone numbers (host/admin only).
  igRoot: rootName(process.env.IG_COMMAND_ROOT, 'sgig'),
  phoneRoot: rootName(process.env.PHONE_COMMAND_ROOT, 'sgphone'),
  steamRoot: rootName(process.env.STEAM_COMMAND_ROOT, 'sgsteam'),
  profileRoot: rootName(process.env.PROFILE_COMMAND_ROOT, 'sgprofile'),
  phoneCountry: (process.env.PHONE_COUNTRY_CODE || '+976').trim(), // local numbers get this prefix
  phoneLocalDigits: Math.max(4, numberOr(process.env.PHONE_LOCAL_DIGITS, 8)),
  // Profile-card backgrounds, unboxed from cases like CS2 skins.
  caseRoot: rootName(process.env.CASE_COMMAND_ROOT, 'sgcase'),
  caseDailySeeds: Math.max(0, numberOr(process.env.CASE_DAILY_SEEDS, 25)), // free seeds with the daily case
  caseStreakSeeds: Math.max(0, numberOr(process.env.CASE_STREAK_SEEDS, 5)), // extra per consecutive day
  caseStreakMax: Math.max(0, numberOr(process.env.CASE_STREAK_MAX, 100)), // cap on the streak bonus
  casePrice: Math.max(1, numberOr(process.env.CASE_PRICE, 400)), // seeds per bought case
  caseDropChance: Math.min(1, Math.max(0, numberOr(process.env.CASE_DROP_CHANCE, 0.2))), // per announced KZ record
  caseDropDailyCap: Math.max(0, numberOr(process.env.CASE_DROP_DAILY_CAP, 3)), // playing drops per member per day
  caseChampionCases: Math.max(0, numberOr(process.env.CASE_CHAMPION_CASES, 1)), // to each player on the winning team
  caseRevealMs: Math.max(0, numberOr(process.env.CASE_REVEAL_MS, 900)), // pause between unboxing frames
  // Who may hand out cases and seeds. When set, ONLY this member can — not even
  // other admins. Unset falls back to anyone with Manage Server.
  caseAdminId: process.env.CASE_ADMIN_ID?.trim() || null,
  // Casino — seeds are wagered at true odds, so the house takes nothing and the
  // seed pool neither grows nor shrinks in the long run. Limits are the only
  // brake, and they protect members from themselves.
  casinoRoot: rootName(process.env.CASINO_COMMAND_ROOT, 'sgcasino'),
  casinoMinBet: Math.max(1, numberOr(process.env.CASINO_MIN_BET, 10)),
  casinoMaxBet: Math.max(1, numberOr(process.env.CASINO_MAX_BET, 5000)),
  casinoDailyLossCap: Math.max(0, numberOr(process.env.CASINO_DAILY_LOSS_CAP, 20000)), // 0 = no cap
  casinoDuelMinutes: Math.max(1, numberOr(process.env.CASINO_DUEL_MINUTES, 5)), // a challenge expires after this
  casinoSpinMs: Math.max(0, numberOr(process.env.CASINO_SPIN_MS, 800)), // pause before a slots result
  // The day boundary for daily claims and drop caps — the server's own day.
  caseTimeZone: process.env.CASE_TIMEZONE?.trim() || process.env.BIRTHDAY_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone,
};

function numberOr(value, fallback) {
  const n = Number(value);
  return value != null && value !== '' && Number.isFinite(n) ? n : fallback;
}

function rootName(value, fallback) {
  return (value || fallback).toLowerCase().replace(/[^a-z0-9_-]/g, '') || fallback;
}
