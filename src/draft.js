// CS2 team drafter — everything under /sgdraft (DRAFT_COMMAND_ROOT).
//
// 1. /sgdraft start posts a lobby; players click Join (and get a private
//    confirmation) and show up by name with their AURA and 🎀, read from roles.
// 2. Once everyone is in, the host clicks Draft and picks how many teams from
//    what the turnout allows (2, 3, 4, …): teams of 5 balanced by total AURA
//    (draftBalance.js). The last to join sit out if the numbers don't divide.
//    Reshuffle shows another fair lineup; Swap trades any two players by hand.
// 3. The host starts a single-elimination bracket — random pairing, or by AURA
//    (closest totals meet) — and marks each match's winner until one team is left.
//
// Lobbies are saved in data/store.json, so they survive restarts and stay open
// until the host closes it (only the host can — a deleted lobby message is just
// re-posted; only deleting the whole channel ends it). An open lobby stays at
// the bottom of its channel: when people chat, it is re-posted below.
//
// A lobby has a fixed id — `key`, the id of its first message — used for the
// store, history records and private menus. `messageId` is whichever message
// currently shows it, and changes each time it moves to the bottom. Every bracket
// is recorded forever in data/draft-history.json (see draftHistory.js).

import {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  embedLength,
} from 'discord.js';
import { config } from './config.js';
import { awardChampions } from './cases.js';
import * as store from './store.js';
import {
  draft,
  TEAM_SIZE,
  teamTotal,
  spreadOf,
  createBracket,
  firstRoundMatches,
  openMatches,
  markWinner,
  undoWinner,
  champion,
  roundName,
  MAX_TEAMS,
} from './draftBalance.js';
import {
  startRecord,
  syncRecord,
  endRecord,
  recordSub,
  getRecord,
  hasRecord,
  safeName,
  historyCommand,
  gameCommand,
  statsCommand,
  topCommand,
} from './draftHistory.js';

const PREFIX = 'sgdraft|';
const MIN_PLAYERS = TEAM_SIZE * 2;
const SHOWN_LIMIT = 200; // remembered lineups per lobby, so Reshuffle keeps finding new ones
const UNKNOWN_MESSAGE = 10008;
const LEFT_SERVER = new Set([10007, 10013]); // Unknown Member, Unknown User
const UNKNOWN_CHANNEL = 10003;
const HOST_IDLE_MS = 60 * 60 * 1000; // an admin may take over a lobby whose host has been silent this long
const NOTIFY_COOLDOWN_MS = 60 * 1000; // so a double-click can't ping everyone twice
const MENTION_CHUNK = 1900; // Discord messages are capped at 2000 characters
const EMBED_TOTAL = 6000; // Discord's limit on all embeds in one message, combined
const TEAM_EMOJI = ['🔵', '🟠', '🟢', '🟣', '🔴', '🟡', '🟤', '⚪'];
const MAX_WIN_ROWS = 4; // Discord allows 5 component rows; one is the control row
// Actions that would change the teams — refused while a bracket is running, so
// a leftover button can't wipe a tournament that's being played and recorded.
const LOCKED_DURING_BRACKET = new Set(['draft', 'draftn', 'teams', 'swap', 'swapsel', 'bracket', 'pairsel']);


// ---------------------------------------------------------------------------
// Player stats from roles
// ---------------------------------------------------------------------------

/** "AURA - 3.5" -> 3.5, "AURA - KING" -> config value; null if not an aura role. */
function auraFromRoleName(name) {
  const m = /^AURA\s*-\s*(.+)$/i.exec(name.trim());
  if (!m) return null;
  const value = m[1].trim().toUpperCase();
  if (value === 'GOD') return { aura: config.draftAuraGod, label: 'GOD' };
  if (value === 'KING') return { aura: config.draftAuraKing, label: 'KING' };
  const n = Number(value);
  return Number.isFinite(n) ? { aura: n, label: String(n) } : null;
}

/** A member's draft profile. Several AURA roles → the strongest (lowest) wins. */
function profileOf(member) {
  let best = null;
  let girl = false;
  for (const role of member.roles.cache.values()) {
    if (role.id === config.draftGirlRole || role.name === config.draftGirlRole) girl = true;
    const a = auraFromRoleName(role.name);
    if (a && (!best || a.aura < best.aura)) best = a;
  }
  return {
    id: member.id,
    name: member.displayName || member.user?.username || member.id,
    aura: best ? best.aura : config.draftDefaultAura,
    label: best ? best.label : '',
    missing: !best,
    girl,
  };
}

/** What the drafter reads from a member's roles: { label, aura, girl, missing }. For /sgprofile. */
export function auraOf(member) {
  const { label, aura, girl, missing } = profileOf(member);
  return { label, aura, girl, missing };
}

/**
 * Fresh roles for these players (the cache can be stale without the members
 * intent). Only Discord saying someone is gone drops them; any other error
 * (timeout, outage) keeps their saved profile rather than kicking them out.
 */
async function loadProfiles(guild, players) {
  const fresh = new Map();
  const gone = [];
  for (const p of players) {
    if (p.mock) continue; // test players aren't Discord members: keep them as they are
    let member;
    try {
      member = await guild.members.fetch({ user: p.id, force: true });
    } catch (err) {
      if (LEFT_SERVER.has(err?.code)) gone.push(p.id);
      continue;
    }
    fresh.set(p.id, profileOf(member));
  }
  return { fresh, gone };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const fmt = (n) => String(Math.round(n * 10) / 10);
const auraText = (p) => `${p.missing ? '❔' : ''}${p.label}${p.girl ? ' 🎀' : ''}`;
const teamName = (i) => `${TEAM_EMOJI[i % TEAM_EMOJI.length]} Team ${i + 1}`;
const fits = (lobby) => Math.min(MAX_TEAMS, Math.floor(lobby.players.length / TEAM_SIZE));

/** "AURA 3.5 · 🎀" */
function statsLine(p) {
  return `${p.missing ? '❔ no AURA' : `AURA **${p.label}**`}${p.girl ? ' · 🎀' : ''}`;
}

/**
 * A player's name as plain text. Mentions inside embeds often show up as raw
 * <@id> or "unknown user" when Discord hasn't loaded that member, names never do.
 */
const nameOf = (p) => `**${safeName(p.name, p.id)}**`;

/**
 * The player list, fitted into `budget` characters (what the other embeds in the
 * message leave over). Full stats if they fit, else names only, else as many
 * whole lines as fit plus "…and N more" — never a line cut in half.
 */
function lobbyEmbed(lobby, budget = EMBED_TOTAL) {
  const benched = new Set(lobby.result?.benched.map((p) => p.id) ?? []);
  const line = (p, i, full) =>
    `\`${String(i + 1).padStart(2)}\` ${nameOf(p)}${full ? ` · ${statsLine(p)}` : ''}${benched.has(p.id) ? ' · _sits out_' : ''}`;

  const n = lobby.players.length;
  const need = n < MIN_PLAYERS ? ` · need ${MIN_PLAYERS - n} more` : '';
  const teams = lobby.result ? `${lobby.result.teams.length} teams` : 'host picks the number of teams at Draft';
  const embed = new EmbedBuilder()
    .setColor(lobby.closed ? 0x95a5a6 : 0xe67e22)
    .setTitle(`🎮 ${lobby.title}${lobby.closed ? ' — closed' : ''}`)
    .setFooter({
      text:
        `${lobby.test ? '🧪 test lobby, results not saved · ' : ''}${lobby.locked ? '🔒 locked · ' : ''}` +
        `${n} player(s) joined${need} · ${teams} · host: ${lobby.hostName}`,
    });

  if (!n) return embed.setDescription('_Nobody yet — click **Join**._');
  const room = Math.min(4096, budget - embedLength(embed.data) - 50);
  let text = lobby.players.map((p, i) => line(p, i, true)).join('\n');
  if (text.length > room) text = lobby.players.map((p, i) => line(p, i, false)).join('\n');
  if (text.length > room) {
    const kept = [];
    let used = 0;
    for (const [i, p] of lobby.players.entries()) {
      const l = line(p, i, false);
      if (used + l.length + 1 > room - 30) break;
      kept.push(l);
      used += l.length + 1;
    }
    text = `${kept.join('\n')}\n…and ${n - kept.length} more`;
  }
  return embed.setDescription(text);
}

function teamsEmbed(lobby, compact = false) {
  const { teams, benched } = lobby.result;
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`⚔️ ${teams.length} teams`)
    .addFields(
      teams.map((team, i) => ({
        name: `${teamName(i)} — ${fmt(teamTotal(team))}`,
        value: team
          .slice()
          .sort((x, y) => x.aura - y.aura)
          .map((p) => (compact ? safeName(p.name, p.id) : `${nameOf(p)} · ${auraText(p)}`))
          .join('\n'),
        inline: true,
      })),
    )
    .setFooter({
      text:
        `Spread: ${fmt(spreadOf(teams))} (highest − lowest total)` +
        (lobby.edited ? ' · ✏️ edited by host' : '') +
        (lobby.bracket ? ' · 🔒 locked for the bracket' : ''),
    });
  // Always list who sits out here too: in huge lobbies the player list above gets cut.
  if (benched.length) {
    let value = '';
    for (const [i, p] of benched.entries()) {
      const next = `${value}${value ? ', ' : ''}${safeName(p.name, p.id)}`;
      if (next.length > 1000) {
        value += ` …and ${benched.length - i} more`;
        break;
      }
      value = next;
    }
    embed.addFields({ name: `🪑 Sits out (${benched.length})`, value });
  }
  return embed;
}

/**
 * The post that stays in the channel after a tournament: who won, who they
 * beat, the whole path, and how long it took. Everything comes from the bracket
 * and the saved record, so it reads the same later as it did on the night.
 */
function recapEmbed(lobby, guildId, winner) {
  const { bracket, result } = lobby;
  const record = lobby.historyId != null ? getRecord(guildId, lobby.historyId) : null;
  const final = bracket.rounds.at(-1)[0];
  const runnerUp = final.a === winner ? final.b : final.a;

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(`🏆 ${safeName(lobby.title)} — ${teamName(winner)} wins`)
    .setDescription(
      `**Champions:** ${result.teams[winner].map(nameOf).join(', ')}` +
        (runnerUp != null ? `\n**Runner-up:** ${teamName(runnerUp)} — ${result.teams[runnerUp].map(nameOf).join(', ')}` : ''),
    );

  bracket.rounds.forEach((round, r) => {
    const lines = round
      .filter((mt) => mt.winner != null && mt.b != null)
      .map((mt) => `${teamName(mt.winner)} beat ${teamName(mt.winner === mt.a ? mt.b : mt.a)}`);
    if (lines.length) embed.addFields({ name: roundName(r, bracket.rounds.length), value: lines.join('\n') });
  });

  const bits = [bracketModeText(bracket.mode), `${result.teams.length} teams`];
  if (record?.startedAt) {
    const mins = Math.round((Date.parse(record.endedAt || Date.now()) - Date.parse(record.startedAt)) / 60000);
    if (Number.isFinite(mins) && mins > 0) bits.push(`${mins} min`);
  }
  if (record?.subs?.length) bits.push(`${record.subs.length} sub(s)`);
  if (lobby.historyId != null) bits.push(`/${config.draftRoot} game ${lobby.historyId}`);
  else if (lobby.test) bits.push('🧪 test — not saved');
  embed.setFooter({ text: bits.join(' · ') });
  return embed;
}

/** Plain words for a pairing mode, used in replies and on the bracket. */
export const bracketModeText = (mode) =>
  mode === 'aura'
    ? 'closest AURA totals meet'
    : mode === 'seed'
      ? 'seeded: strongest meets weakest'
      : mode === 'manual'
        ? 'matchups picked by the host'
        : 'random pairing';

function bracketEmbed(lobby) {
  const { bracket } = lobby;
  const winner = champion(bracket);
  const label = (t) => (t == null ? '_TBD_' : `**${teamName(t)}**`);

  const embed = new EmbedBuilder()
    .setColor(winner != null ? 0xf1c40f : 0x9b59b6)
    .setTitle(
      `🏆 ${lobby.historyId != null ? `Tournament #${lobby.historyId}` : lobby.test ? '🧪 Test bracket (not saved)' : 'Bracket'} — ` +
        bracketModeText(bracket.mode),
    );

  bracket.rounds.forEach((round, r) => {
    const lines = round.map((m) => {
      if (r === 0 && m.b == null) return `${label(m.a)} — bye`;
      const result = m.winner != null ? ` → 🏆 ${teamName(m.winner)}` : '';
      return `${label(m.a)} 🆚 ${label(m.b)}${result}`;
    });
    embed.addFields({ name: roundName(r, bracket.rounds.length), value: lines.join('\n') });
  });

  if (winner != null) {
    const players = lobby.result.teams[winner].map(nameOf).join(', ');
    embed.setDescription(`# 🏆 ${teamName(winner)} wins!\n${players}`);
  } else {
    embed.setDescription('Host: click the team that won each match.');
  }
  return embed;
}

function button(id, label, style, { emoji, disabled } = {}) {
  const b = new ButtonBuilder().setCustomId(`${PREFIX}${id}`).setLabel(label).setStyle(style);
  if (emoji) b.setEmoji(emoji);
  if (disabled) b.setDisabled(true);
  return b;
}

/** "How many teams?" — only the counts the current turnout allows. */
function teamCountMenu(lobby, customId = `${PREFIX}teams`) {
  const n = lobby.players.length;
  const current = lobby.result?.teams.length;
  const options = [];
  for (let t = 2; t <= fits(lobby); t++) {
    const out = n - t * TEAM_SIZE;
    options.push({
      label: `${t} teams`,
      description: `${t * TEAM_SIZE} play${out ? ` · ${out} sit out` : ' · nobody sits out'}`,
      value: String(t),
      default: t === current,
    });
  }
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('Number of teams').addOptions(options),
  );
}

function components(lobby) {
  if (lobby.closed) return [];
  const rows = [];

  if (lobby.bracket) {
    rows.push(
      new ActionRowBuilder().addComponents(
        button('notify', 'Notify', ButtonStyle.Primary, { emoji: '📣' }),
        button('sub', 'Sub', ButtonStyle.Primary, { emoji: '🔁', disabled: champion(lobby.bracket) != null }),
        button('undo', 'Undo result', ButtonStyle.Secondary, { emoji: '↩️', disabled: !lobby.bracket.history.length }),
        button('unbracket', 'Cancel bracket', ButtonStyle.Secondary),
        button('close', 'Close', ButtonStyle.Danger),
      ),
    );
    // Each match on its own row while they fit; two per row beyond that.
    const open = openMatches(lobby.bracket);
    const perRow = open.length <= MAX_WIN_ROWS ? 1 : 2;
    for (let i = 0; i < open.length && rows.length <= MAX_WIN_ROWS; i += perRow) {
      rows.push(
        new ActionRowBuilder().addComponents(
          open.slice(i, i + perRow).flatMap(({ r, m, match }) =>
            [match.a, match.b].map((t) => button(`win|${r}.${m}.${t}`, `${teamName(t)} won`, ButtonStyle.Success)),
          ),
        ),
      );
    }
    return rows;
  }

  const main = new ActionRowBuilder().addComponents(
    button('join', 'Join', ButtonStyle.Success, { emoji: '✅', disabled: lobby.locked }),
    button('leave', 'Leave', ButtonStyle.Secondary, { disabled: lobby.locked }),
    button('draft', lobby.result ? 'Reshuffle' : 'Draft', ButtonStyle.Primary, {
      emoji: lobby.result ? '🔀' : '🎲',
      disabled: lobby.players.length < MIN_PLAYERS,
    }),
  );
  if (lobby.result) main.addComponents(button('swap', 'Swap', ButtonStyle.Primary, { emoji: '✏️' }));
  main.addComponents(button('close', 'Close', ButtonStyle.Danger));
  rows.push(main);

  if (lobby.result && fits(lobby) > 2) rows.push(teamCountMenu(lobby));

  const hostRow = new ActionRowBuilder().addComponents(
    button('notify', lobby.result ? 'Notify players' : 'Notify', ButtonStyle.Primary, { emoji: '📣' }),
    lobby.locked
      ? button('lock', 'Unlock', ButtonStyle.Secondary, { emoji: '🔓' })
      : button('lock', 'Lock', ButtonStyle.Secondary, { emoji: '🔒' }),
  );
  if (lobby.result) {
    hostRow.addComponents(
      button('bracket', 'Start bracket', ButtonStyle.Success, { emoji: '🏁' }),
    );
  }
  rows.push(hostRow);
  return rows;
}

/** The whole lobby message, kept under Discord's 6000-character total for all embeds. */
function view(lobby) {
  const size = (list) => list.reduce((n, e) => n + embedLength(e.data), 0);
  let extra = [];
  if (lobby.result) extra.push(teamsEmbed(lobby));
  if (lobby.bracket) extra.push(bracketEmbed(lobby));
  // Very large drafts: drop the per-player AURA from the team lists to make room.
  if (lobby.result && size(extra) > EMBED_TOTAL - 1500) {
    extra = [teamsEmbed(lobby, true), ...(lobby.bracket ? [bracketEmbed(lobby)] : [])];
  }
  return {
    embeds: [lobbyEmbed(lobby, EMBED_TOTAL - size(extra)), ...extra],
    components: components(lobby),
    allowedMentions: { parse: [] },
  };
}

// ---------------------------------------------------------------------------
// Lobby state
// ---------------------------------------------------------------------------

/**
 * Only the lobby's host runs it — not admins: on this server many players have
 * Manage Server, and one of them closing a live lobby is exactly what happened.
 * If the host disappears, an admin hands the lobby over with /sgdraft host.
 */
const canManage = (interaction, lobby) => interaction.user.id === lobby.hostId;
const isAdmin = (interaction) => Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));

const ephemeral = (interaction, content) =>
  interaction.reply({ flags: MessageFlags.Ephemeral, content, allowedMentions: { parse: [] } }).catch(() => {});

/** Lobbies saved by an older version stored drafts in another shape; drop those drafts. */
function normalize(lobby) {
  if (lobby.result && !Array.isArray(lobby.result.teams)) resetTeams(lobby);
  return lobby;
}

/**
 * Draft (or reshuffle) with everyone's current roles. Returns the ids dropped
 * for having left the server — or null if the lobby moved on while roles were
 * loading (bracket started, lobby closed), in which case nothing is touched.
 */
async function runDraft(lobby, guild, reshuffle) {
  const { fresh, gone } = await loadProfiles(guild, lobby.players);
  // The old buttons stay clickable during that fetch, which takes seconds.
  if (lobby.bracket || lobby.closed) return null;
  // Join/Leave may have happened meanwhile: keep the roster as it is *now*,
  // refreshed with the new roles, minus anyone who left the server.
  const left = new Set(gone);
  lobby.players = lobby.players.filter((p) => !left.has(p.id)).map((p) => fresh.get(p.id) || p);
  const result = draft(lobby.players, {
    teamCount: lobby.teamCount,
    reshuffle,
    avoid: new Set(lobby.shown),
    current: lobby.shown.at(-1),
    tolerance: config.draftReshuffleTolerance,
  });
  lobby.result = result.teams.length ? { teams: result.teams, benched: result.benched } : null;
  lobby.shown = [...lobby.shown, result.key].slice(-SHOWN_LIMIT);
  lobby.edited = false;
  return gone;
}

/** Tell the host what a Draft/Reshuffle couldn't do: skipped, or players who left. */
function notifyAfterDraft(interaction, gone) {
  let content = null;
  if (gone === null) content = 'The lobby changed while the teams were loading (a bracket started or it was closed) — nothing was redrafted.';
  else if (gone.length) content = `Removed ${gone.map((id) => `<@${id}>`).join(', ')} — no longer in the server.`;
  if (!content) return undefined;
  return interaction
    .followUp({ flags: MessageFlags.Ephemeral, content, allowedMentions: { parse: [] } })
    .catch(() => {});
}

/** Save live state and history together, before any await, so a restart can't split them. */
function saveAll() {
  store.persist();
  store.persistDraftHistory();
}

/**
 * Make sure a running bracket has its own history record, creating one from
 * the bracket as it stands if not — a bracket from before history existed, a
 * stale tournament number, or a crash between the two file writes. Also fills
 * in ids that lobbies saved by older versions lack. True if it created one.
 */
function ensureRecord(lobby, key, guildId) {
  lobby.guildId ??= guildId;
  lobby.key ??= key;
  lobby.messageId ??= key;
  if (!lobby.bracket || !lobby.guildId || lobby.test || hasRecord(lobby.guildId, lobby)) return false;
  startRecord(lobby.guildId, lobby, lobby.key);
  return true;
}

// ---------------------------------------------------------------------------
// Mock players (/sgdraft mock) — for trying the whole flow in Discord
// ---------------------------------------------------------------------------

// Roughly the spread of AURA roles on the server, mid-heavy, a few KING/GOD.
const MOCK_AURAS = ['GOD', 'KING', '1', '1.5', '2', '2.5', '3', '3', '3.5', '4', '4', '4.5', '5', '5', '5.5', '6', '6.5', '7', '7.5', '8', '9', '10'];

/**
 * Add `count` fake players. They're never looked up in Discord or pinged, and
 * the lobby becomes a test lobby: its brackets are not saved to history.
 */
export function addMocks(lobby, count) {
  const taken = new Set(lobby.players.map((p) => p.id));
  let n = 0;
  for (let added = 0; added < count; ) {
    n += 1;
    const id = `mock-${String(n).padStart(2, '0')}`;
    if (taken.has(id)) continue;
    const label = MOCK_AURAS[Math.floor(Math.random() * MOCK_AURAS.length)];
    const aura = auraFromRoleName(`AURA - ${label}`);
    lobby.players.push({
      id,
      name: `🧪 Mock ${String(n).padStart(2, '0')}`,
      aura: aura.aura,
      label: aura.label,
      missing: false,
      girl: Math.random() < 0.15,
      mock: true,
    });
    added += 1;
  }
  lobby.test = true;
  resetTeams(lobby);
}

/** Remove every mock player. The lobby stays a test lobby if a bracket already ran. */
export function clearMocks(lobby) {
  const before = lobby.players.length;
  lobby.players = lobby.players.filter((p) => !p.mock);
  if (lobby.players.length !== before) resetTeams(lobby);
  if (!lobby.bracket) lobby.test = false;
  return before - lobby.players.length;
}

/** The lobby message payload, for re-rendering it outside an interaction. */
export const lobbyView = (lobby) => view(lobby);

/**
 * Add someone to the lobby. After a draft they join the players sitting out,
 * so a late Join never destroys teams that are already made — the host decides
 * whether to Reshuffle them in or bring them on with Sub.
 */
function addPlayer(lobby, profile) {
  lobby.players.push(profile);
  if (lobby.result) lobby.result.benched.push(profile);
}

/**
 * Take someone out of the lobby. Returns where they were: 'team' (the drafted
 * teams are now invalid, so they're cleared), 'bench', or 'lobby'.
 */
function removePlayer(lobby, id) {
  const before = lobby.players.length;
  lobby.players = lobby.players.filter((p) => p.id !== id);
  if (lobby.players.length === before) return null;
  if (!lobby.result) return 'lobby';
  const onTeam = lobby.result.teams.some((t) => t.some((p) => p.id === id));
  if (onTeam) {
    resetTeams(lobby); // a team is a player short: those teams can't stand
    return 'team';
  }
  lobby.result.benched = lobby.result.benched.filter((p) => p.id !== id);
  return 'bench';
}

/** The roster changed, so any drafted teams are out of date. */
function resetTeams(lobby) {
  // Safety net: a bracket must never vanish with its record left open.
  const open = lobby.historyId != null && lobby.guildId;
  if (open) endRecord(lobby.guildId, lobby);
  lobby.result = null;
  lobby.bracket = null;
  lobby.edited = false;
  lobby.shown = [];
  if (open) saveAll();
}

/** Every place a drafted player can be: each team, plus the bench. */
function slots(lobby) {
  const out = lobby.result.teams.map((list, i) => ({ list, where: `Team ${i + 1}` }));
  out.push({ list: lobby.result.benched, where: 'Sits out' });
  return out;
}

function locate(lobby, id) {
  for (const slot of slots(lobby)) {
    const index = slot.list.findIndex((p) => p.id === id);
    if (index >= 0) return { ...slot, index };
  }
  return null;
}

/** Trade two players' places. Returns an error message, or null on success. */
function swapPlayers(lobby, idA, idB) {
  if (!lobby.result) return 'Draft the teams first.';
  if (lobby.bracket) return 'Teams are locked once the bracket starts — cancel the bracket to edit them.';
  if (idA === idB) return 'Pick two different players.';
  const a = locate(lobby, idA);
  const b = locate(lobby, idB);
  if (!a || !b) return `<@${a ? idB : idA}> isn't in the drafted teams.`;
  if (a.list === b.list) return `Both are already in ${a.where}.`;
  [a.list[a.index], b.list[b.index]] = [b.list[b.index], a.list[a.index]];
  lobby.edited = true;
  return null;
}

// ---------------------------------------------------------------------------
// Substitutions — a player can't continue, someone takes their spot
// ---------------------------------------------------------------------------

/** "Who can't continue?" — everyone on a team (a member picker if there are too many to list). */
function teamPlayerMenu(lobby, customId) {
  const options = lobby.result.teams.flatMap((team, i) =>
    team.map((p) => ({
      label: `Team ${i + 1} · ${p.name}`.slice(0, 100),
      description: `AURA ${p.missing ? 'none' : p.label}${p.girl ? ' · girl' : ''}`,
      value: p.id,
    })),
  );
  const menu = options.length <= 25 ? new StringSelectMenuBuilder().addOptions(options) : new UserSelectMenuBuilder();
  menu.setCustomId(customId).setPlaceholder('Player who is leaving').setMinValues(1).setMaxValues(1);
  return new ActionRowBuilder().addComponents(menu);
}

/** "Who replaces them?" — someone sitting out, or anyone in the server. */
function subInMenus(lobby, key, outId) {
  const rows = [];
  const bench = lobby.result.benched.filter((p) => p.id !== outId).slice(0, 25);
  if (bench.length) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${PREFIX}subin|${key}|${outId}`)
          .setPlaceholder('Someone sitting out…')
          .addOptions(
            bench.map((p) => ({
              label: p.name.slice(0, 100),
              description: `AURA ${p.missing ? 'none' : p.label}${p.girl ? ' · girl' : ''}`,
              value: p.id,
            })),
          ),
      ),
    );
  }
  rows.push(
    new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(`${PREFIX}subuser|${key}|${outId}`)
        .setPlaceholder(bench.length ? '…or anyone in the server' : 'Anyone in the server')
        .setMinValues(1)
        .setMaxValues(1),
    ),
  );
  return rows;
}

/**
 * Put `incoming` in the leaving player's spot on the same team; the leaving
 * player moves to "sits out". Works before or during a bracket (teams stay
 * locked otherwise — this is the one change allowed mid-tournament). Returns
 * { error } or { team, out, incoming }.
 */
function substitute(lobby, outId, incoming) {
  if (!lobby.result) return { error: 'Draft the teams first.' };
  const leaving = locate(lobby, outId);
  if (!leaving || leaving.list === lobby.result.benched) return { error: "That player isn't on a team." };
  const already = locate(lobby, incoming.id);
  if (already && already.list !== lobby.result.benched) {
    return { error: `**${safeName(incoming.name, incoming.id)}** is already on ${already.where}.` };
  }
  if (already) lobby.result.benched.splice(already.index, 1);
  const team = lobby.result.teams.indexOf(leaving.list);
  const out = leaving.list[leaving.index];
  leaving.list[leaving.index] = incoming;
  lobby.result.benched.push(out);
  // A later redraft (Reshuffle, team count) picks players by join order: the
  // replacement takes the leaver's place and the leaver goes last, so the sub
  // sticks. The team count stays as drafted.
  const order = lobby.players.filter((p) => p.id !== incoming.id && p.id !== out.id);
  const at = lobby.players.filter((p) => p.id !== incoming.id).findIndex((p) => p.id === out.id);
  order.splice(at < 0 ? order.length : at, 0, incoming);
  lobby.players = [...order, lobby.players.find((p) => p.id === out.id) || out];
  lobby.teamCount = lobby.result.teams.length;
  lobby.edited = true;
  return { team, out, incoming };
}

/** Substitute, and log it in the tournament's history when a bracket is running. */
function applySub(lobby, outId, incoming) {
  if (lobby.bracket && champion(lobby.bracket) != null) {
    return { error: 'The tournament is over — cancel the bracket to change the teams for the next one.' };
  }
  const done = substitute(lobby, outId, incoming);
  if (done.error) return done;
  if (lobby.bracket && lobby.historyId != null) recordSub(lobby.guildId, lobby, done.team, done.out, done.incoming);
  saveAll();
  return done;
}

// ---------------------------------------------------------------------------
// Manual matchups — the host picks which team faces which
// ---------------------------------------------------------------------------

/** The private "pick two teams" message: what's chosen so far, and what's left. */
function pairingView(lobby, key) {
  const { pairs } = lobby.pairing;
  const needed = firstRoundMatches(lobby.result.teams.length);
  const taken = new Set(pairs.flat());
  const free = lobby.result.teams.map((team, i) => ({ i, team })).filter(({ i }) => !taken.has(i));

  const lines = pairs.map(([a, b]) => `${teamName(a)} 🆚 ${teamName(b)}`);
  const left = needed - pairs.length;
  const byes = free.length - left * 2;
  const content =
    `✋ **Pick the matchups** — choose two teams for match ${pairs.length + 1} of ${needed}.` +
    (lines.length ? `\n\n${lines.join('\n')}` : '') +
    (byes > 0 ? `\n\n_The ${byes} team(s) you don't pair get a bye._` : '');

  return {
    content,
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${PREFIX}pairsel|${key}`)
          .setPlaceholder('Two teams to face each other')
          .setMinValues(2)
          .setMaxValues(2)
          .addOptions(
            free.slice(0, 25).map(({ i, team }) => ({
              label: `Team ${i + 1}`,
              description: `AURA ${fmt(teamTotal(team))} · ${team.map((p) => p.name).join(', ')}`.slice(0, 100),
              value: String(i),
            })),
          ),
      ),
      new ActionRowBuilder().addComponents(button(`paircancel|${key}`, 'Cancel', ButtonStyle.Secondary)),
    ],
  };
}

// ---------------------------------------------------------------------------
// Notify — the host tells the drafted players their teams are ready
// ---------------------------------------------------------------------------

/**
 * @ping the players in the channel and DM each of them a link to the lobby.
 * Before the draft: everyone who has joined ("about to start"). After it:
 * everyone on a team ("teams are ready"). The link goes to the channel: the lobby keeps moving to the bottom,
 * so a link to one copy of it would go stale. Players sitting out and mock
 * players aren't notified.
 */
async function notifyPlayers(interaction, lobby) {
  const drafted = Boolean(lobby.result);
  const players = (drafted ? lobby.result.teams.flat() : lobby.players).filter((p) => !p.mock);
  if (!players.length) return { pinged: 0, dmed: 0, dmFailed: 0 };
  const title = safeName(lobby.title);
  const link = `https://discord.com/channels/${lobby.guildId || interaction.guildId}/${lobby.channelId}`;

  // Channel ping, split so no message passes Discord's 2000-character limit.
  const head = drafted
    ? `📣 **Teams are ready for ${title}!** Check the lobby below.\n`
    : `📣 **${title}** is about to start — check the lobby below!\n`;
  const chunks = [];
  let current = head;
  let ids = [];
  for (const p of players) {
    const mention = `<@${p.id}> `;
    if (current.length + mention.length > MENTION_CHUNK) {
      chunks.push({ content: current.trimEnd(), ids });
      current = '';
      ids = [];
    }
    current += mention;
    ids.push(p.id);
  }
  if (ids.length) chunks.push({ content: current.trimEnd(), ids });
  let pinged = 0;
  for (const chunk of chunks) {
    try {
      await interaction.followUp({ content: chunk.content, allowedMentions: { users: chunk.ids } });
      pinged += chunk.ids.length;
    } catch (err) {
      console.error(`Draft notify: channel ping failed in ${lobby.channelId}:`, err.message);
    }
  }

  // DMs, one at a time (gentle on Discord's rate limits).
  const guildName = interaction.guild?.name ? ` in **${interaction.guild.name}**` : '';
  let dmed = 0;
  let dmFailed = 0;
  for (const p of players) {
    try {
      await interaction.client.users.send(p.id, {
        content: drafted
          ? `📣 The teams for **${title}**${guildName} are ready! See the lobby: ${link}`
          : `📣 **${title}**${guildName} is about to start! See the lobby: ${link}`,
      });
      dmed += 1;
    } catch {
      dmFailed += 1; // DMs closed, or not sharing a server any more
    }
  }
  return { pinged, dmed, dmFailed };
}

const subText = (done) => `${nameOf(done.out)} → ${nameOf(done.incoming)} on **${teamName(done.team)}**.`;

/** Tell the channel, and ping whoever is coming in. */
function announceSub(interaction, lobby, done) {
  const who = done.incoming.mock ? nameOf(done.incoming) : `<@${done.incoming.id}>`;
  return interaction
    .followUp({
      content: `🔁 **Substitution** in ${lobby.title}: ${nameOf(done.out)} can't continue — ${who} takes their spot on **${teamName(done.team)}**.`,
      allowedMentions: { users: done.incoming.mock ? [] : [done.incoming.id] },
    })
    .catch(() => {});
}

/** Pick-two menu: a list of drafted players when it fits, otherwise any member. */
function swapMenu(lobby, lobbyId) {
  const options = slots(lobby).flatMap(({ list, where }) =>
    list.map((p) => ({
      label: `${where} · ${p.name}`.slice(0, 100),
      description: `AURA ${p.missing ? 'none' : p.label}${p.girl ? ' · girl' : ''}`,
      value: p.id,
    })),
  );
  const menu = options.length <= 25 ? new StringSelectMenuBuilder().addOptions(options) : new UserSelectMenuBuilder();
  menu
    .setCustomId(`${PREFIX}swapsel|${lobbyId}`)
    .setPlaceholder('Pick two players to swap')
    .setMinValues(2)
    .setMaxValues(2);
  return [new ActionRowBuilder().addComponents(menu)];
}

/**
 * The lobby message is gone (deleted in Discord): forget the lobby and close
 * its history record. Called from the MessageDelete event and failed edits.
 */
function dropLobby(key, guildId) {
  const lobby = store.getDraftLobbies()[key];
  if (!lobby) return;
  ensureRecord(lobby, key, guildId); // so results already played are kept
  lobby.closed = true;
  if (lobby.historyId != null && lobby.guildId) endRecord(lobby.guildId, lobby);
  delete store.getDraftLobbies()[key];
  saveAll();
}

/** The open lobby shown on this message, as [key, lobby] — or null. */
function lobbyByMessage(messageId) {
  for (const [key, lobby] of Object.entries(store.getDraftLobbies())) {
    if ((lobby.messageId ?? key) === messageId) return [key, lobby];
  }
  return null;
}

/**
 * A message was deleted. If it was the message currently showing a lobby, the
 * lobby is NOT closed — only its host can do that — it's re-posted instead (a
 * moderator's delete or a /purge must not end a live tournament). The old copy
 * the bot deletes itself after a move is no longer current, so it's ignored.
 */
export function repostDeletedLobby(messageId, client) {
  const found = lobbyByMessage(messageId);
  if (!found || !client) return;
  const [key, lobby] = found;
  client.channels
    .fetch(lobby.channelId)
    .then((channel) => bumpLobby(channel, key, lobby, true))
    .catch((err) => console.error(`Draft lobby ${key}: couldn't re-post it:`, err.message));
}

/**
 * At startup: tidy up after a restart or downtime.
 *  - lobbies whose channel no longer exists are dropped (deleted while offline,
 *    or an archived thread discord.js never told us about);
 *  - a copy left behind by a move the restart interrupted is deleted: the old
 *    copy it never got to delete, or a new one posted but never saved.
 */
export async function reconcileLobbies(client) {
  for (const [key, lobby] of Object.entries(store.getDraftLobbies())) {
    try {
      await client.channels.fetch(lobby.channelId);
    } catch (err) {
      if (err.code === UNKNOWN_CHANNEL) dropLobby(key, lobby.guildId);
    }
  }
  const lobbies = Object.entries(store.getDraftLobbies());
  const current = new Set(lobbies.map(([k, l]) => l.messageId ?? k));
  for (const channelId of new Set(lobbies.map(([, l]) => l.channelId))) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.messages) continue;
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    for (const message of recent?.values() ?? []) {
      const stray =
        message.author?.id === client.user.id &&
        !current.has(message.id) &&
        message.components?.some((row) => row.components?.some((c) => c.customId?.startsWith(PREFIX)));
      if (stray) await message.delete().catch(() => {});
    }
  }
}

/** A channel or thread was deleted: drop every lobby that lived in it. */
export function dropLobbiesInChannel(channelId, guildId) {
  for (const [key, lobby] of Object.entries(store.getDraftLobbies())) {
    if (lobby.channelId === channelId) dropLobby(key, guildId);
  }
}

/** Re-render the lobby's current message. Returns false (after cleaning up if it was deleted) on failure. */
async function refreshLobbyMessage(channel, lobby, retried = false) {
  const target = lobby.messageId ?? lobby.key;
  try {
    const message = await channel.messages.fetch(target);
    await message.edit(view(lobby));
    return true;
  } catch (err) {
    if (err.code !== UNKNOWN_MESSAGE) {
      console.error(`Draft lobby ${lobby.key}: couldn't update the message:`, err.message);
      return false;
    }
    // It may just have moved to the bottom meanwhile: try the new message once.
    if (!retried && (lobby.messageId ?? lobby.key) !== target) return refreshLobbyMessage(channel, lobby, true);
    if (moving.has(lobby.key) || store.getDraftLobbies()[lobby.key] !== lobby) return false;
    // Someone deleted it: put it back (only the host closes a lobby).
    await bumpLobby(channel, lobby.key, lobby, true).catch(() => {});
    return (lobby.messageId ?? lobby.key) !== target;
  }
}

// ---------------------------------------------------------------------------
// Sticky: keep open lobbies at the bottom of their channel
// ---------------------------------------------------------------------------

const moving = new Set(); // keys of lobbies being re-posted right now
const pendingBumps = new Map(); // channelId -> { timer, first }

/** Any new message in the server. If a lobby lives in that channel, schedule a move. */
export function onChannelMessage(message) {
  if (!config.draftStickySeconds || !message.guildId) return;
  if (message.flags?.has(MessageFlags.Ephemeral)) return; // private replies aren't chat
  const here = Object.values(store.getDraftLobbies()).filter((l) => l.channelId === message.channelId);
  if (!here.length || here.some((l) => l.messageId === message.id)) return; // a lobby's own copy
  // A copy the bot just posted, whose event beat channel.send() (messageId not set yet).
  // Without this, two lobbies in one channel would keep re-posting each other.
  const lobbyCopy =
    message.author?.id === message.client.user?.id &&
    message.components?.some((row) => row.components?.some((c) => c.customId?.startsWith(PREFIX)));
  if (lobbyCopy) return;
  scheduleBump(message.client, message.channelId);
}

/**
 * Move the channel's lobbies once the chat has been quiet for a few seconds —
 * but never wait more than 4× that, so a busy chat can't bury them for long.
 */
function scheduleBump(client, channelId) {
  const quiet = config.draftStickySeconds * 1000;
  const now = Date.now();
  const p = pendingBumps.get(channelId) ?? { first: now };
  clearTimeout(p.timer);
  const wait = Math.max(0, Math.min(quiet, p.first + 4 * quiet - now));
  p.timer = setTimeout(() => {
    pendingBumps.delete(channelId);
    bumpChannel(client, channelId).catch((err) => console.error(`Draft sticky (${channelId}):`, err.message));
  }, wait);
  pendingBumps.set(channelId, p);
}

async function bumpChannel(client, channelId) {
  const channel = await client.channels.fetch(channelId);
  for (const [key, lobby] of Object.entries(store.getDraftLobbies())) {
    if (lobby.channelId === channelId) await bumpLobby(channel, key, lobby);
  }
}

/**
 * Re-post a lobby at the bottom: send the new copy, point the lobby at it,
 * then delete the old one — in that order, so the lobby is never without a
 * message and the old copy's deletion isn't mistaken for "lobby deleted".
 */
async function bumpLobby(channel, key, lobby, force = false) {
  // `force`: the current copy was deleted, so "already at the bottom" can't be trusted.
  if (moving.has(key) || (!force && channel.lastMessageId === lobby.messageId)) return;
  moving.add(key);
  try {
    const old = lobby.messageId ?? key;
    const payload = view(lobby);
    const sent = await channel.send(payload);
    if (store.getDraftLobbies()[key] !== lobby) {
      await sent.delete().catch(() => {}); // closed while we were posting
      return;
    }
    lobby.key ??= key;
    lobby.previousMessageId = old;
    lobby.messageId = sent.id;
    store.persist();
    await channel.messages.delete(old).catch(() => {});
    // Anything that changed while we were posting was drawn on the old copy.
    const latest = view(lobby);
    if (JSON.stringify(latest) !== JSON.stringify(payload)) await sent.edit(latest).catch(() => {});
  } finally {
    moving.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Buttons and menus
// ---------------------------------------------------------------------------

/** Every lobby action goes through here, so each change is saved to disk. */
export async function handleDraftButton(interaction) {
  const clicked = interaction.message?.id;
  const before = lobbyByMessage(clicked);
  try {
    return await handleLobbyAction(interaction);
  } catch (err) {
    // The lobby moved to the bottom while this click was being handled, so
    // its answer went to the deleted old copy. The redraw below fixes that.
    if (err.code !== UNKNOWN_MESSAGE || !before) throw err;
    return undefined;
  } finally {
    store.persist();
    const [key, lobby] = before ?? [];
    if (lobby && store.getDraftLobbies()[key] === lobby && lobby.messageId !== clicked) {
      await refreshLobbyMessage(interaction.channel, lobby).catch(() => {});
    }
  }
}

async function handleLobbyAction(interaction) {
  const [action, arg, arg2] = interaction.customId.slice(PREFIX.length).split('|');
  // Private menus (swap, "how many teams?") carry the lobby's fixed key; lobby
  // buttons are found by the message they sit on.
  const privateMenu = [
    'swapsel',
    'draftn',
    'closeok',
    'closekeep',
    'subout',
    'subin',
    'subuser',
    'pairsel',
    'paircancel',
  ].includes(action);
  // Private menus carry the lobby's fixed key; the bracket-mode menu carries it
  // in the second slot (the first is the mode).
  const key = privateMenu ? arg : action === 'bracket' && arg2 ? arg2 : null;
  const found = key ? [key, store.getDraftLobbies()[key]] : lobbyByMessage(interaction.message.id);
  const [lobbyId, lobby] = found ?? [];
  if (!lobby) {
    const moved = Object.values(store.getDraftLobbies()).some((l) => l.previousMessageId === interaction.message?.id);
    return ephemeral(
      interaction,
      moved
        ? '⬇️ This lobby just moved to the bottom of the channel — use the new one.'
        : `This lobby is closed. Start a new one with \`/${config.draftRoot} start\`.`,
    );
  }
  normalize(lobby);
  if (ensureRecord(lobby, lobbyId, interaction.guildId)) saveAll();

  if (action === 'join') {
    const at = lobby.players.findIndex((p) => p.id === interaction.user.id);
    if (at >= 0) {
      return ephemeral(
        interaction,
        `✅ You're already in **${lobby.title}** — player #${at + 1} of ${lobby.players.length}. Tap **Leave** to drop out.`,
      );
    }
    if (lobby.bracket) return ephemeral(interaction, 'The bracket has started — joining is closed.');
    if (lobby.locked) return ephemeral(interaction, '🔒 The host locked this lobby — ask them to unlock it or add you.');
    const me = profileOf(interaction.member);
    const drafted = Boolean(lobby.result);
    addPlayer(lobby, me);
    await interaction.update(view(lobby));
    // Only the shared lobby changed so far — tell the player it worked.
    return interaction
      .followUp({
        flags: MessageFlags.Ephemeral,
        content:
          `✅ You joined **${lobby.title}** as player #${lobby.players.length} · ${statsLine(me)}` +
          (drafted ? "\nThe teams are already drafted, so you're **sitting out** — the host can reshuffle or sub you in." : ''),
      })
      .catch(() => {});
  }

  if (action === 'leave') {
    if (lobby.bracket) return ephemeral(interaction, 'The bracket has started — ask the host to cancel it first.');
    if (lobby.locked) return ephemeral(interaction, '🔒 The host locked this lobby — ask them to remove you.');
    const was = removePlayer(lobby, interaction.user.id);
    if (!was) return ephemeral(interaction, "You're not in this lobby — tap **Join** to play.");
    await interaction.update(view(lobby));
    return interaction
      .followUp({
        flags: MessageFlags.Ephemeral,
        content: `👋 You left **${lobby.title}**.${was === 'team' ? ' You were on a team, so the teams were cleared.' : ''}`,
      })
      .catch(() => {});
  }

  if (!canManage(interaction, lobby)) {
    return ephemeral(interaction, `Only the host (<@${lobby.hostId}>) can do that.`);
  }
  lobby.hostSeenAt = Date.now();
  if (lobby.bracket && LOCKED_DURING_BRACKET.has(action)) {
    return ephemeral(interaction, 'A bracket is running — the teams are locked. Cancel the bracket first to change them.');
  }

  const { guildId } = lobby;

  switch (action) {
    case 'close':
      // Closing can't be undone, so ask first.
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: `Close **${lobby.title}**? Everyone is removed from it${lobby.bracket ? ' and the running bracket ends' : ''}. This can't be undone.`,
        components: [
          new ActionRowBuilder().addComponents(
            button(`closeok|${lobbyId}`, 'Yes, close it', ButtonStyle.Danger),
            button(`closekeep|${lobbyId}`, 'Keep it open', ButtonStyle.Secondary),
          ),
        ],
      });

    case 'closekeep':
      return interaction.update({ content: '👍 Kept open.', components: [] });

    case 'closeok':
      if (lobby.historyId != null) endRecord(guildId, lobby);
      lobby.closed = true;
      delete store.getDraftLobbies()[lobbyId];
      saveAll();
      await interaction.update({ content: `✅ Closed **${lobby.title}**.`, components: [] });
      await refreshLobbyMessage(interaction.channel, lobby).catch(() => {});
      return undefined;

    case 'teams': {
      const value = interaction.values[0];
      const count = value === 'auto' ? null : Number(value);
      if (!lobby.result) {
        lobby.teamCount = count;
        return interaction.update(view(lobby));
      }
      // Already drafted: redraft straight away with the new number of teams.
      await interaction.deferUpdate();
      const previous = lobby.teamCount;
      lobby.teamCount = count;
      const gone = await runDraft(lobby, interaction.guild, false);
      if (gone === null) lobby.teamCount = previous; // skipped: leave everything as it was
      await interaction.editReply(view(lobby));
      return notifyAfterDraft(interaction, gone);
    }

    case 'draft': {
      // First draft with a choice to make: ask the host how many teams, now
      // that everyone has joined. (10–14 players can only be 2 teams.)
      if (!lobby.result && fits(lobby) > 2) {
        return interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: `**${lobby.players.length} players** joined. How many teams?`,
          components: [teamCountMenu(lobby, `${PREFIX}draftn|${lobbyId}`)],
        });
      }
      await interaction.deferUpdate();
      // Pin the count: 2 on a first draft here (the only choice), the shown count on a
      // Reshuffle — so players joining meanwhile can't silently change it.
      const previous = lobby.teamCount;
      lobby.teamCount = lobby.result ? lobby.result.teams.length : 2;
      const gone = await runDraft(lobby, interaction.guild, Boolean(lobby.result));
      if (gone === null) lobby.teamCount = previous;
      await interaction.editReply(view(lobby));
      return notifyAfterDraft(interaction, gone);
    }

    case 'draftn': {
      // The host's answer to "How many teams?" (a private menu, not the lobby).
      const count = Number(interaction.values[0]);
      if (lobby.result) {
        return interaction.update({
          content: 'Already drafted — use the team menu on the lobby to change the number of teams.',
          components: [],
        });
      }
      if (count > fits(lobby)) {
        const ok = fits(lobby) >= 2;
        return interaction.update({
          content: `Only **${lobby.players.length} players** are in now — ${ok ? 'pick again.' : 'not enough for 2 teams.'}`,
          components: ok ? [teamCountMenu(lobby, `${PREFIX}draftn|${lobbyId}`)] : [],
        });
      }
      await interaction.update({ content: `🎲 Drafting **${count} teams**…`, components: [] });
      const previous = lobby.teamCount;
      lobby.teamCount = count;
      const gone = await runDraft(lobby, interaction.guild, false);
      if (gone === null) lobby.teamCount = previous;
      store.persist();
      const shown = gone !== null && (await refreshLobbyMessage(interaction.channel, lobby));
      await interaction
        .editReply({
          content:
            gone === null
              ? 'The lobby changed while the teams were loading (a bracket started or it was closed) — nothing was drafted.'
              : `✅ Drafted **${lobby.result?.teams.length ?? 0} teams**.${shown ? '' : " ⚠️ The lobby message couldn't be updated."}`,
          components: [],
        })
        .catch(() => {});
      if (gone?.length) return notifyAfterDraft(interaction, gone);
      return undefined;
    }

    case 'sub':
      if (!lobby.result) return ephemeral(interaction, 'Draft the teams first.');
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: "🔁 **Substitution** — who can't continue?",
        components: [teamPlayerMenu(lobby, `${PREFIX}subout|${lobbyId}`)],
      });

    case 'subout': {
      const leaving = lobby.result && locate(lobby, interaction.values[0]);
      if (!leaving || leaving.list === lobby.result.benched) {
        return interaction.update({ content: "That player isn't on a team any more.", components: [] });
      }
      const p = leaving.list[leaving.index];
      return interaction.update({
        content: `🔁 Who replaces ${nameOf(p)} (${leaving.where})?`,
        components: subInMenus(lobby, lobbyId, p.id),
        allowedMentions: { parse: [] },
      });
    }

    case 'subin':
    case 'subuser': {
      const outId = arg2;
      const inId = interaction.values[0];
      let incoming = lobby.result?.benched.find((p) => p.id === inId) || null;
      if (action === 'subuser') {
        // Anyone in the server — look them up for their current roles.
        await interaction.deferUpdate();
        try {
          const member = await interaction.guild.members.fetch({ user: inId, force: true });
          if (member.user?.bot) return interaction.editReply({ content: "A bot can't play.", components: [] });
          incoming = profileOf(member);
        } catch (err) {
          return interaction.editReply({ content: lookupFailed(err, `<@${inId}>`), components: [] });
        }
      }
      const answer = (payload) => (interaction.deferred ? interaction.editReply(payload) : interaction.update(payload));
      if (!incoming) return answer({ content: 'That player is no longer sitting out.', components: [] });
      // The lobby may have changed while we looked them up.
      if (store.getDraftLobbies()[lobbyId] !== lobby) return answer({ content: 'That lobby was closed.', components: [] });
      const done = applySub(lobby, outId, incoming);
      if (done.error) return answer({ content: `❌ ${done.error}`, components: [], allowedMentions: { parse: [] } });
      await answer({ content: `✅ ${subText(done)}`, components: [], allowedMentions: { parse: [] } });
      await refreshLobbyMessage(interaction.channel, lobby);
      await announceSub(interaction, lobby, done);
      return undefined;
    }

    case 'swap':
      if (!lobby.result) return ephemeral(interaction, 'Draft the teams first.');
      if (lobby.bracket) {
        return ephemeral(interaction, 'Teams are locked once the bracket starts — cancel the bracket to edit them.');
      }
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: 'Pick **two players** to swap — they trade places (team ↔ team, or with someone sitting out).',
        components: swapMenu(lobby, lobbyId),
      });

    case 'swapsel': {
      const [idA, idB] = interaction.values;
      const error = swapPlayers(lobby, idA, idB);
      const name = (id) => lobby.players.find((p) => p.id === id)?.name ?? 'player';
      // Answer first: the lobby edit below can fail, and the host must still hear
      // back. If the answer itself fails, still show the swap on the lobby.
      let answered = true;
      await interaction
        .update({
          content: error
            ? `❌ ${error}`
            : `✅ Swapped **${name(idA)}** ↔ **${name(idB)}**. Pick two more to keep editing, or dismiss this message.`,
          components: lobby.result && !lobby.bracket ? swapMenu(lobby, lobbyId) : [],
          allowedMentions: { parse: [] },
        })
        .catch((err) => {
          answered = false;
          console.error('Swap menu: could not answer:', err.message);
        });
      if (!error && !(await refreshLobbyMessage(interaction.channel, lobby)) && answered) {
        await interaction
          .followUp({ flags: MessageFlags.Ephemeral, content: "⚠️ Swapped, but the lobby message couldn't be updated." })
          .catch(() => {});
      }
      return undefined;
    }

    case 'bracket': {
      if (!lobby.result) return ephemeral(interaction, 'Draft the teams first.');
      if (!arg) {
        // Ask how the first round should be paired.
        return interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: '🏁 **Start the bracket** — how should the first round be paired?',
          components: [
            new ActionRowBuilder().addComponents(
              button(`bracket|seed|${lobbyId}`, 'Seeded', ButtonStyle.Success, { emoji: '🥇' }),
              button(`bracket|aura|${lobbyId}`, 'Closest AURA', ButtonStyle.Success, { emoji: '⚖️' }),
              button(`bracket|random|${lobbyId}`, 'Random', ButtonStyle.Success, { emoji: '🎲' }),
              button(`bracket|pick|${lobbyId}`, 'Pick matchups', ButtonStyle.Primary, { emoji: '✋' }),
            ),
          ],
        });
      }
      if (arg === 'pick') {
        // The host picks the matchups: start an empty pairing and ask for the first two.
        lobby.pairing = { teams: lobby.result.teams.length, pairs: [] };
        store.persist();
        return interaction.reply({ flags: MessageFlags.Ephemeral, ...pairingView(lobby, lobbyId) });
      }
      const mode = ['aura', 'seed', 'random'].includes(arg) ? arg : 'random';
      lobby.bracket = createBracket(lobby.result.teams.map(teamTotal), mode);
      if (!lobby.test) startRecord(guildId, lobby, lobbyId);
      saveAll();
      // From the private menu: answer it, then redraw the lobby message.
      if (arg2) {
        await interaction.update({ content: `🏁 Bracket started — ${bracketModeText(mode)}.`, components: [] });
        await refreshLobbyMessage(interaction.channel, lobby);
        return undefined;
      }
      return interaction.update(view(lobby));
    }

    case 'paircancel':
      delete lobby.pairing;
      store.persist();
      return interaction.update({ content: 'Matchup picking cancelled.', components: [] });

    case 'pairsel': {
      if (!lobby.result || !lobby.pairing) {
        return interaction.update({ content: 'That pairing is no longer open.', components: [] });
      }
      if (lobby.pairing.teams !== lobby.result.teams.length) {
        delete lobby.pairing;
        store.persist();
        return interaction.update({ content: 'The teams changed — start the bracket again.', components: [] });
      }
      const picked = interaction.values.map(Number);
      const taken = new Set(lobby.pairing.pairs.flat());
      if (picked.length !== 2 || picked[0] === picked[1] || picked.some((t) => taken.has(t))) {
        const again = pairingView(lobby, lobbyId);
        return interaction.update({ ...again, content: `❌ Pick two different teams that are still free.\n\n${again.content}` });
      }
      lobby.pairing.pairs.push(picked);

      const needed = firstRoundMatches(lobby.result.teams.length);
      if (lobby.pairing.pairs.length < needed) {
        store.persist();
        return interaction.update(pairingView(lobby, lobbyId));
      }

      // All matchups chosen: whatever is left gets a bye.
      const paired = new Set(lobby.pairing.pairs.flat());
      const byes = lobby.result.teams.map((_, i) => i).filter((i) => !paired.has(i));
      const order = [...lobby.pairing.pairs.flat(), ...byes];
      delete lobby.pairing;
      lobby.bracket = createBracket(lobby.result.teams.map(teamTotal), 'manual', Math.random, order);
      if (!lobby.test) startRecord(guildId, lobby, lobbyId);
      saveAll();
      await interaction.update({ content: '✅ Bracket started with your matchups.', components: [] });
      await refreshLobbyMessage(interaction.channel, lobby);
      return undefined;
    }

    case 'win': {
      if (!lobby.bracket) return ephemeral(interaction, 'No bracket running.');
      const [r, m, t] = arg.split('.').map(Number);
      const error = markWinner(lobby.bracket, r, m, t);
      if (error) return ephemeral(interaction, `❌ ${error}`);
      // Remember who actually played this match — subs can change a team later.
      // Re-marked after an Undo (same two teams): keep the lineup that played it.
      const played = lobby.bracket.rounds[r][m];
      if (played.lineups?.teams?.[0] !== played.a || played.lineups?.teams?.[1] !== played.b) {
        played.lineups = {
          teams: [played.a, played.b],
          a: lobby.result.teams[played.a].map((p) => p.id),
          b: lobby.result.teams[played.b].map((p) => p.id),
        };
      }
      syncRecord(guildId, lobby);
      saveAll();
      // Read everything first: a "Cancel bracket" can land during the await below.
      const winner = champion(lobby.bracket);
      const champs = winner != null ? lobby.result.teams[winner] : [];
      const ids = champs.filter((p) => !p.mock).map((p) => p.id);
      // Champions earn profile-card cases — never from a test lobby, where
      // nothing else counts either.
      const cases = winner != null && !lobby.test ? awardChampions(guildId, ids) : 0;
      const gg = champs.map((p) => (p.mock ? nameOf(p) : `<@${p.id}>`)).join(' ');
      const ref = lobby.historyId != null ? ` · tournament **#${lobby.historyId}**` : lobby.test ? ' · 🧪 test, not saved' : '';
      // Built now, not after the await: a "Cancel bracket" landing in between
      // would leave nothing to build it from.
      const recap = winner != null ? recapEmbed(lobby, guildId, winner) : null;
      await interaction.update(view(lobby));
      if (winner != null) {
        await interaction
          .followUp({
            content:
              `🏆 **${teamName(winner)}** wins **${safeName(lobby.title)}**${ref}! GG ${gg}` +
              (cases ? `\n🎁 Every champion earned **${cases}** Garden Case(s) — \`/${config.caseRoot} open\`` : ''),
            embeds: recap ? [recap] : [],
            allowedMentions: { users: ids },
          })
          .catch(() => {});
      }
      return undefined;
    }

    case 'lock':
      lobby.locked = !lobby.locked;
      store.persist();
      await interaction.update(view(lobby));
      return interaction
        .followUp({
          flags: MessageFlags.Ephemeral,
          content: lobby.locked
            ? '🔒 Locked — nobody can join or leave now. Press **Unlock** to reopen.'
            : '🔓 Unlocked — players can join and leave again.',
        })
        .catch(() => {});

    case 'notify': {
      if (!lobby.players.some((p) => !p.mock)) return ephemeral(interaction, 'Nobody has joined yet.');
      const since = Date.now() - (lobby.notifiedAt ?? 0);
      if (since < NOTIFY_COOLDOWN_MS) {
        return ephemeral(interaction, `Players were notified ${Math.round(since / 1000)}s ago — try again in a moment.`);
      }
      lobby.notifiedAt = Date.now();
      store.persist();
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      // Fill in the private reply first: otherwise the first follow-up (the
      // public ping) would replace it and stay private.
      await interaction.editReply('📣 Notifying players…');
      const { pinged, dmed, dmFailed } = await notifyPlayers(interaction, lobby);
      return interaction.editReply(
        `📣 Pinged **${pinged}** player(s) in the channel and DM'd **${dmed}**.` +
          (dmFailed ? ` ⚠️ ${dmFailed} couldn't get a DM (DMs closed).` : ''),
      );
    }

    case 'undo':
      if (!lobby.bracket || !undoWinner(lobby.bracket)) return ephemeral(interaction, 'Nothing to undo.');
      syncRecord(guildId, lobby);
      saveAll();
      return interaction.update(view(lobby));

    case 'unbracket':
      if (!lobby.bracket) return ephemeral(interaction, 'No bracket running.');
      endRecord(guildId, lobby);
      lobby.bracket = null;
      saveAll();
      return interaction.update(view(lobby));

    default:
      return undefined;
  }
}

export const isDraftButton = (interaction) => interaction.customId.startsWith(PREFIX);

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

/** The newest open lobby in this channel, for the host's slash commands. */
function lobbyInChannel(channelId, guildId, prefer = () => false) {
  let found = null;
  let preferred = null;
  for (const [key, lobby] of Object.entries(store.getDraftLobbies())) {
    if (lobby.channelId !== channelId) continue;
    found = { key, lobby };
    if (prefer(lobby)) preferred = found;
  }
  found = preferred ?? found; // two lobbies in a channel: the caller's own wins
  if (found) {
    normalize(found.lobby);
    if (ensureRecord(found.lobby, found.key, guildId)) saveAll();
  }
  return found;
}

/** This channel's lobby for a host-only command, or null after replying why not. */
function hostLobby(interaction) {
  const found = lobbyInChannel(interaction.channelId, interaction.guildId, (l) => l.hostId === interaction.user.id);
  if (!found) {
    ephemeral(interaction, `No open lobby in this channel. Start one with \`/${config.draftRoot} start\`.`);
    return null;
  }
  if (!canManage(interaction, found.lobby)) {
    ephemeral(interaction, `Only the host (<@${found.lobby.hostId}>) can do that.`);
    return null;
  }
  found.lobby.hostSeenAt = Date.now();
  return found;
}

async function start(interaction) {
  const lobby = {
    title: interaction.options.getString('title') || 'CS2 Draft',
    guildId: interaction.guildId,
    hostId: interaction.user.id,
    hostName: interaction.member?.displayName || interaction.user.username,
    hostSeenAt: Date.now(),
    channelId: interaction.channelId,
    historyId: null,
    teamCount: null, // decided at Draft, once everyone has joined
    players: [],
    shown: [],
    result: null,
    bracket: null,
    edited: false,
    closed: false,
  };
  if (interaction.options.getBoolean('join') !== false) lobby.players.push(profileOf(interaction.member));

  const message = await interaction.reply({ ...view(lobby), withResponse: true });
  lobby.key = message.resource.message.id; // fixed for the lobby's whole life
  lobby.messageId = lobby.key; // changes whenever it moves to the bottom
  store.getDraftLobbies()[lobby.key] = lobby;
}

/** Private reply for a deferred slash command. */
const say = (interaction, content) => interaction.editReply({ content, allowedMentions: { parse: [] } });

const lookupFailed = (err, user) =>
  LEFT_SERVER.has(err?.code) ? `${user} isn't in this server.` : `Couldn't reach Discord to look up ${user} — try again.`;

async function editPlayers(interaction, add) {
  const found = hostLobby(interaction);
  if (!found) return undefined;
  const { key, lobby } = found;
  if (lobby.bracket) return ephemeral(interaction, 'The bracket has started — cancel it before changing players.');
  const user = interaction.options.getUser('user', true);
  let was = null; // where a kicked player was, for the reply
  // Acknowledge first: the member lookup and the lobby edit below can be slow.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (add) {
    if (lobby.players.some((p) => p.id === user.id)) return say(interaction, `${user} is already in.`);
    let member;
    try {
      member = await interaction.guild.members.fetch({ user: user.id, force: true });
    } catch (err) {
      return say(interaction, lookupFailed(err, user));
    }
    // The lobby may have changed while we waited on Discord.
    if (store.getDraftLobbies()[key] !== lobby) return say(interaction, 'That lobby was closed.');
    if (lobby.bracket) return say(interaction, 'The bracket has started — cancel it before changing players.');
    if (lobby.players.some((p) => p.id === user.id)) return say(interaction, `${user} is already in.`);
    addPlayer(lobby, profileOf(member));
  } else {
    was = removePlayer(lobby, user.id); // 'team' | 'bench' | 'lobby'
    if (!was) return say(interaction, `${user} isn't in the lobby.`);
  }

  store.persist();
  const shown = await refreshLobbyMessage(interaction.channel, lobby);
  const done = add
    ? `✅ Added ${user}.${lobby.result ? ' They sit out until you reshuffle or sub them in.' : ''}`
    : `✅ Removed ${user}.${was === 'team' ? ' The teams were cleared.' : ''}`;
  return say(interaction, shown ? done : `${done} ⚠️ The lobby message couldn't be updated.`);
}

async function swap(interaction) {
  const found = hostLobby(interaction);
  if (!found) return undefined;
  const { lobby } = found;
  const a = interaction.options.getUser('player1', true);
  const b = interaction.options.getUser('player2', true);
  const error = swapPlayers(lobby, a.id, b.id);
  if (error) return ephemeral(interaction, `❌ ${error}`);
  store.persist();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const shown = await refreshLobbyMessage(interaction.channel, lobby);
  return say(interaction, `✅ Swapped ${a} ↔ ${b}.${shown ? '' : " ⚠️ The lobby message couldn't be updated."}`);
}

/** /sgdraft close — works even if the lobby message was deleted. */
async function closeCommand(interaction) {
  const found = hostLobby(interaction);
  if (!found) return undefined;
  const { key, lobby } = found;
  if (lobby.historyId != null) endRecord(lobby.guildId, lobby);
  lobby.closed = true;
  delete store.getDraftLobbies()[key];
  saveAll();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.channel.messages
    .fetch(lobby.messageId ?? key)
    .then((m) => m.edit(view(lobby)))
    .catch(() => {});
  return say(interaction, `✅ Closed **${lobby.title}**.`);
}

/** /sgdraft sub out:@a in:@b — replace a player who can't continue (host). */
async function subCommand(interaction) {
  const found = hostLobby(interaction);
  if (!found) return undefined;
  const { key, lobby } = found;
  if (!lobby.result) return ephemeral(interaction, 'Draft the teams first.');
  const out = interaction.options.getUser('out', true);
  const inUser = interaction.options.getUser('in', true);
  if (inUser.bot) return ephemeral(interaction, "A bot can't play.");
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  // Someone on a team may have left while we were acknowledging, which clears the teams.
  if (!lobby.result) return say(interaction, 'Draft the teams first.');
  let incoming = lobby.result.benched.find((p) => p.id === inUser.id);
  if (!incoming) {
    try {
      incoming = profileOf(await interaction.guild.members.fetch({ user: inUser.id, force: true }));
    } catch (err) {
      return say(interaction, lookupFailed(err, inUser));
    }
  }
  if (store.getDraftLobbies()[key] !== lobby) return say(interaction, 'That lobby was closed.');
  const done = applySub(lobby, out.id, incoming);
  if (done.error) return say(interaction, `❌ ${done.error}`);
  // Answer the private deferred reply first: a follow-up sent straight after a
  // deferReply would replace that private reply instead of posting publicly.
  await say(interaction, `✅ ${subText(done)}`);
  await refreshLobbyMessage(interaction.channel, lobby);
  return announceSub(interaction, lobby, done);
}

/** /sgdraft host user:@x — hand the lobby over. The host, or an admin if the host is gone. */
/**
 * Has this lobby's host gone — left the server, or not touched the lobby for an
 * hour? (A lobby from before this was tracked starts its clock now.) Throws if
 * Discord can't be reached to check.
 */
async function hostGone(interaction, lobby) {
  lobby.hostSeenAt ??= Date.now();
  if (Date.now() - lobby.hostSeenAt > HOST_IDLE_MS) return true;
  try {
    await interaction.guild.members.fetch({ user: lobby.hostId, force: true });
    return false;
  } catch (err) {
    if (LEFT_SERVER.has(err?.code)) return true;
    throw err;
  }
}

async function hostCommand(interaction) {
  const me = interaction.user.id;
  const here = Object.entries(store.getDraftLobbies())
    .filter(([, l]) => l.channelId === interaction.channelId)
    .reverse(); // newest first
  if (!here.length) return ephemeral(interaction, `No open lobby in this channel. Start one with \`/${config.draftRoot} start\`.`);
  const user = interaction.options.getUser('user', true);
  if (user.bot) return ephemeral(interaction, "A bot can't host.");

  // The host hands over their own lobby. An admin may only take over a lobby
  // whose host is gone — otherwise only the host decides.
  let target = here.find(([, l]) => l.hostId === me);
  if (!target && !isAdmin(interaction)) {
    return ephemeral(interaction, `Only the host (<@${here[0][1].hostId}>) can hand the lobby over.`);
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!target) {
    for (const entry of here) {
      try {
        if (await hostGone(interaction, entry[1])) {
          target = entry;
          break;
        }
      } catch {
        return say(interaction, "Couldn't reach Discord to check the host — try again.");
      }
    }
    if (!target) {
      store.persist(); // keep the clocks hostGone may have started
      return say(
        interaction,
        `The host (<@${here[0][1].hostId}>) is still here and active — only they can hand the lobby over. ` +
          'An admin can take over once the host has left the server or been inactive for an hour.',
      );
    }
  }
  const [key, lobby] = target;
  normalize(lobby);
  if (store.getDraftLobbies()[key] !== lobby) return say(interaction, 'That lobby was closed.');
  const oldHost = lobby.hostId;
  lobby.hostId = user.id;
  lobby.hostName = interaction.options.getMember('user')?.displayName || user.globalName || user.username;
  lobby.hostSeenAt = Date.now();
  store.persist();
  await refreshLobbyMessage(interaction.channel, lobby);
  await say(interaction, `✅ ${user} is now the host of **${lobby.title}**.`);
  // Out in the open, so a replaced host knows.
  return interaction
    .followUp({
      content: `👑 ${user} is now the host of **${lobby.title}** (was <@${oldHost}>).`,
      allowedMentions: { users: [user.id, oldHost] },
    })
    .catch(() => {});
}

/** /sgdraft mock count:<n> | clear:true — fake players for testing (host). */
async function mockCommand(interaction) {
  const found = hostLobby(interaction);
  if (!found) return undefined;
  const { lobby } = found;
  if (lobby.bracket) return ephemeral(interaction, 'A bracket is running — cancel it first.');
  const count = interaction.options.getInteger('count') || 0;
  const clear = interaction.options.getBoolean('clear');
  let text;
  if (clear) {
    const removed = clearMocks(lobby);
    text = `🧹 Removed ${removed} mock player(s).`;
  } else if (count > 0) {
    addMocks(lobby, count);
    text = `🧪 Added ${count} mock player(s) — **${lobby.players.length}** in the lobby. This is now a test lobby: its brackets are not saved to history.`;
  } else {
    return ephemeral(interaction, 'Give a `count` of mock players to add, or `clear: True` to remove them.');
  }
  store.persist();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const shown = await refreshLobbyMessage(interaction.channel, lobby);
  return say(interaction, shown ? text : `${text} ⚠️ The lobby message couldn't be updated.`);
}

async function aura(interaction) {
  const user = interaction.options.getUser('user') || interaction.user;
  let member;
  try {
    member = await interaction.guild.members.fetch({ user: user.id, force: true });
  } catch (err) {
    return ephemeral(interaction, lookupFailed(err, user));
  }
  const p = profileOf(member);
  const counts = !p.missing && p.label !== fmt(p.aura) ? ` (counts as ${fmt(p.aura)})` : '';
  const none = p.missing ? ` (drafted as ${fmt(config.draftDefaultAura)})` : '';
  return interaction.reply({ content: `${user} · ${statsLine(p)}${counts}${none}`, allowedMentions: { parse: [] } });
}

const rootBuilder = new SlashCommandBuilder()
  .setName(config.draftRoot)
  .setDescription('CS2 team drafter — balanced teams by AURA, plus a bracket.')
  .setDMPermission(false)
  .addSubcommand((s) =>
    s
      .setName('start')
      .setDescription('Open a draft lobby in this channel.')
      .addStringOption((o) => o.setName('title').setDescription('Lobby title, e.g. "Friday mix"').setMaxLength(80))
      .addBooleanOption((o) => o.setName('join').setDescription('Join the lobby yourself (default: yes)')),
  )
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('(Host) Add a player to this channel’s lobby.')
      .addUserOption((o) => o.setName('user').setDescription('Player').setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('kick')
      .setDescription('(Host) Remove a player from this channel’s lobby.')
      .addUserOption((o) => o.setName('user').setDescription('Player').setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('swap')
      .setDescription('(Host) Swap two drafted players between teams (or with someone sitting out).')
      .addUserOption((o) => o.setName('player1').setDescription('First player').setRequired(true))
      .addUserOption((o) => o.setName('player2').setDescription('Second player').setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('history')
      .setDescription('Past tournaments — newest first.')
      .addUserOption((o) => o.setName('user').setDescription('Only tournaments this player was in'))
      .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)),
  )
  .addSubcommand((s) =>
    s
      .setName('game')
      .setDescription('One tournament in full: teams, players and every result.')
      .addIntegerOption((o) => o.setName('id').setDescription('Tournament number, e.g. 12').setRequired(true).setMinValue(1)),
  )
  .addSubcommand((s) =>
    s
      .setName('stats')
      .setDescription("A player's tournaments, titles and match record.")
      .addUserOption((o) => o.setName('user').setDescription('Player (default: you)')),
  )
  .addSubcommand((s) => s.setName('top').setDescription('Players with the most tournament wins.'))
  .addSubcommand((s) =>
    s.setName('close').setDescription("(Host) Close this channel's lobby — also works if its message was deleted."),
  )
  .addSubcommand((s) =>
    s
      .setName('sub')
      .setDescription("(Host) Replace a player who can't continue — also mid-tournament.")
      .addUserOption((o) => o.setName('out').setDescription('Player who is leaving').setRequired(true))
      .addUserOption((o) => o.setName('in').setDescription('Player taking their spot').setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('host')
      .setDescription("Hand this channel's lobby to another host (the host, or an admin if the host is gone).")
      .addUserOption((o) => o.setName('user').setDescription('New host').setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('mock')
      .setDescription('(Host) Add fake players to test the draft — test lobbies are not saved to history.')
      .addIntegerOption((o) => o.setName('count').setDescription('How many mock players to add').setMinValue(1).setMaxValue(60))
      .addBooleanOption((o) => o.setName('clear').setDescription('Remove all mock players instead')),
  )
  .addSubcommand((s) =>
    s
      .setName('aura')
      .setDescription("Show a player's AURA and stats as the drafter sees them.")
      .addUserOption((o) => o.setName('user').setDescription('Player (default: you)')),
  );

const handlers = {
  start,
  add: (i) => editPlayers(i, true),
  kick: (i) => editPlayers(i, false),
  swap,
  aura,
  history: historyCommand,
  game: gameCommand,
  stats: statsCommand,
  top: topCommand,
  close: closeCommand,
  mock: mockCommand,
  host: hostCommand,
  sub: subCommand,
};

export const draftCommands = {
  [config.draftRoot]: {
    async execute(interaction) {
      try {
        return await handlers[interaction.options.getSubcommand()]?.(interaction);
      } finally {
        store.persist();
      }
    },
  },
};

export function draftCommandData() {
  return [rootBuilder.toJSON()];
}
