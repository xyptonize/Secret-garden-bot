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
  // Whoever holds one of these roles sits out first when the numbers don't
  // divide evenly — before anyone else, however late they joined. Names or ids,
  // comma separated; a name also matches roles that start with it, so
  // "Сануулга" covers Сануулга 1, 2 and 3. A trailing number is read as a
  // level: a higher one sits out before a lower one.
  // Joining a draft requires a saved phone number (/sgphone set), so the host
  // can reach everybody about the game they signed up for.
  draftRequirePhone: (process.env.DRAFT_REQUIRE_PHONE || 'true').toLowerCase() !== 'false',
  draftSitOutRoles: (process.env.DRAFT_SITOUT_ROLES || process.env.DRAFT_SITOUT_ROLE || 'Сануулга,sanuulga')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean),
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
  // Who may see someone else's phone number. Role names or ids, comma separated.
  // The server owner always can. Unset falls back to anyone with Manage Server,
  // which in a busy server is a much wider net than it sounds.
  phoneRoles: (process.env.PHONE_ROLES || '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean),
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
  // Reminders — /sgalarm. Times are read in this timezone, and every alarm is
  // delivered both in the channel it was set in and by DM.
  alarmRoot: rootName(process.env.ALARM_COMMAND_ROOT, 'sgalarm'),
  alarmTimeZone: process.env.ALARM_TIMEZONE?.trim() || process.env.BIRTHDAY_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone,
  alarmMaxPer: Math.max(1, numberOr(process.env.ALARM_MAX_PER_MEMBER, 25)), // alarms one member may have waiting
  alarmMinSeconds: Math.max(10, numberOr(process.env.ALARM_MIN_SECONDS, 60)), // the soonest an alarm may be set for
  alarmCheckSeconds: Math.max(5, numberOr(process.env.ALARM_CHECK_SECONDS, 20)),
  // Owners and developers: the few who can override the ordinary rules, such as
  // taking over a draft lobby from its host. Role names or ids, comma separated.
  // Unset falls back to anyone with Manage Server.
  staffRoles: (process.env.STAFF_ROLES || '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean),
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
  // Counting draw — members count up in order in a channel; when the range is
  // full, three of them win. Reading typed numbers needs the Message Content
  // privilege (Developer Portal → Bot → Privileged Gateway Intents).
  countRoot: rootName(process.env.COUNT_COMMAND_ROOT, 'sgcount'),
  countDailyLimit: Math.max(1, numberOr(process.env.COUNT_DAILY_LIMIT, 5)), // numbers per member per day
  countNoDouble: (process.env.COUNT_NO_DOUBLE || 'false').toLowerCase() === 'true', // ban counting twice in a row
  countStrikes: Math.max(0, numberOr(process.env.COUNT_STRIKES, 3)), // wrong numbers before you can't win (0 = off)
  countChatStrikes: (process.env.COUNT_CHAT_STRIKES || 'true').toLowerCase() !== 'false', // chat costs a strike too
  countNumbersOnly: (process.env.COUNT_NUMBERS_ONLY || 'true').toLowerCase() !== 'false', // delete chat in the counting channel
  countDeleteWrong: (process.env.COUNT_DELETE_WRONG || 'false').toLowerCase() === 'true', // also delete wrong numbers
  countWeighted: (process.env.COUNT_WEIGHTED || 'true').toLowerCase() !== 'false', // each number is a ticket
  // How long the bot's own notes (strikes, refusals) stay before it tidies them
  // away. 0 keeps them: a "strike 2/3" that vanishes in eight seconds is one the
  // member never read.
  countNoticeSeconds: Math.max(0, numberOr(process.env.COUNT_NOTICE_SECONDS, 0)),
  countLockChannel: (process.env.COUNT_LOCK_CHANNEL || 'true').toLowerCase() !== 'false', // close the channel between rounds
  countRevealMs: Math.max(0, numberOr(process.env.COUNT_REVEAL_MS, 2500)), // pause between the three winners
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
