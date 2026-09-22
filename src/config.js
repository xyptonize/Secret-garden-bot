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
};

function numberOr(value, fallback) {
  const n = Number(value);
  return value != null && value !== '' && Number.isFinite(n) ? n : fallback;
}

function rootName(value, fallback) {
  return (value || fallback).toLowerCase().replace(/[^a-z0-9_-]/g, '') || fallback;
}
