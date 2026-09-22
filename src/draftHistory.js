// /sgdraft tournament history — kept forever in data/draft-history.json.
//
// A tournament is recorded the moment the host starts a bracket, updated on
// every result or undo, and marked finished when a champion is decided. Each
// record keeps the teams exactly as they were (name, AURA and girl flag at the
// time — later role changes don't rewrite history), who sat out, and every match.
//
// A bracket that is cancelled or closed before any result is dropped; one with
// at least one result is kept, marked cancelled, since those matches were played.

import { EmbedBuilder, MessageFlags, escapeMarkdown, embedLength } from 'discord.js';
import * as store from './store.js';
import { teamTotal, champion, roundName } from './draftBalance.js';

const PAGE_SIZE = 10;
const EMBED_TOTAL = 6000; // Discord's limit on all embeds in one message, combined
const TOP_SIZE = 15;
const TEAM_EMOJI = ['🔵', '🟠', '🟢', '🟣', '🔴', '🟡', '🟤', '⚪'];

const fmt = (n) => String(Math.round(n * 10) / 10);
const teamName = (n) => `${TEAM_EMOJI[(n - 1) % TEAM_EMOJI.length]} Team ${n}`;
const unix = (iso) => Math.floor(new Date(iso).getTime() / 1000);

const snapshot = (p) => ({ id: p.id, name: p.name, aura: p.aura, label: p.label, girl: Boolean(p.girl) });

/** A saved display name made safe to print: no markdown, links or fake mentions. */
export const safeName = (name, id) => escapeMarkdown(String(name ?? id).replace(/[<>]/g, ''), { maskedLink: true });

/** Mention plus the name saved at the time, so players who left the server stay identifiable. */
const who = (p) => `<@${p.id}> (${safeName(p.name, p.id)})`;

function findRecord(guildId, id) {
  return store.getDraftHistory(guildId).tournaments.find((t) => t.id === id) || null;
}

/**
 * The lobby's own record — the id must match AND the record must have been made
 * by this lobby's message, so a stale id can never touch another tournament.
 */
function ownRecord(guildId, lobby) {
  if (lobby.historyId == null) return null;
  const record = findRecord(guildId, lobby.historyId);
  const key = lobby.key ?? lobby.messageId; // the lobby's fixed id (its first message)
  if (!record || (key && record.lobbyMessageId !== key)) return null;
  return record;
}

// ---------------------------------------------------------------------------
// Recording (called from draft.js)
// ---------------------------------------------------------------------------

/** Does this lobby point at a record that is really its own? */
export function hasRecord(guildId, lobby) {
  return Boolean(ownRecord(guildId, lobby));
}

/** A bracket just started: open a record for it and remember its id on the lobby. */
export function startRecord(guildId, lobby, lobbyMessageId) {
  const h = store.getDraftHistory(guildId);
  const record = {
    id: h.nextId++,
    status: 'in_progress',
    title: lobby.title,
    hostId: lobby.hostId,
    hostName: lobby.hostName,
    channelId: lobby.channelId,
    lobbyMessageId,
    mode: lobby.bracket.mode,
    edited: Boolean(lobby.edited),
    startedAt: new Date().toISOString(),
    endedAt: null,
    teams: lobby.result.teams.map((team, i) => ({
      team: i + 1,
      total: teamTotal(team),
      players: team.map(snapshot),
    })),
    benched: lobby.result.benched.map(snapshot),
    byes: [],
    matches: [],
    champion: null,
  };
  h.tournaments.push(record);
  lobby.historyId = record.id;
  lobby.key ??= lobbyMessageId;
  syncRecord(guildId, lobby);
  return record;
}

/** Copy the bracket's current results into the record (after every result or undo). */
export function syncRecord(guildId, lobby) {
  const record = ownRecord(guildId, lobby);
  if (!record) lobby.historyId = null; // stale id: stop showing "Tournament #N"
  if (!record || !lobby.bracket) return null;
  const { rounds } = lobby.bracket;

  record.byes = rounds[0].filter((m) => m.b == null).map((m) => m.a + 1);
  record.matches = [];
  rounds.forEach((round, r) =>
    round.forEach((m) => {
      if (m.a == null || m.b == null || m.winner == null) return; // byes and unplayed
      record.matches.push({
        round: r + 1,
        roundName: roundName(r, rounds.length),
        a: m.a + 1,
        b: m.b + 1,
        winner: m.winner + 1,
        // Who actually played it — rosters can change mid-tournament (subs).
        ...(m.lineups && { lineups: { a: m.lineups.a, b: m.lineups.b } }),
      });
    }),
  );

  const winner = champion(lobby.bracket);
  record.champion = winner == null ? null : winner + 1;
  record.status = winner == null ? 'in_progress' : 'finished';
  record.endedAt = winner == null ? null : record.endedAt || new Date().toISOString();
  return record;
}

/**
 * A player couldn't continue and was replaced. Log it, and update the team's
 * roster (and the bench) to what they are now; each match keeps the lineup
 * that actually played it.
 */
export function recordSub(guildId, lobby, teamIndex, out, incoming) {
  const record = ownRecord(guildId, lobby);
  if (!record) return null;
  (record.subs ??= []).push({
    team: teamIndex + 1,
    out: snapshot(out),
    in: snapshot(incoming),
    afterMatches: record.matches.length,
    at: new Date().toISOString(),
  });
  const team = record.teams[teamIndex];
  team.players = lobby.result.teams[teamIndex].map(snapshot);
  team.total = teamTotal(lobby.result.teams[teamIndex]);
  record.benched = lobby.result.benched.map(snapshot);
  return record;
}

/**
 * The bracket is going away before it finished (Cancel bracket / Close / message
 * deleted). Keep it as cancelled if anything was played, otherwise drop it.
 * A finished tournament is left exactly as it is.
 */
export function endRecord(guildId, lobby) {
  const record = ownRecord(guildId, lobby);
  lobby.historyId = null;
  if (!record || record.status === 'finished') return;
  if (!record.matches.length) {
    const h = store.getDraftHistory(guildId);
    h.tournaments = h.tournaments.filter((t) => t !== record);
    return;
  }
  record.status = 'cancelled';
  record.endedAt = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The team a player was on — including one they were subbed out of. */
const teamOf = (record, userId) =>
  record.teams.find((t) => t.players.some((p) => p.id === userId)) ||
  record.teams.find((t) => (record.subs || []).some((s) => s.team === t.team && s.out.id === userId)) ||
  null;

/** How far a team got: 'champion', 'final', 'semifinals', … or null if unplayed. */
function finish(record, team) {
  if (record.champion === team) return '🏆 Champion';
  const lost = record.matches.find((m) => (m.a === team || m.b === team) && m.winner !== team);
  if (lost) return `❌ out in the ${lost.roundName}`;
  if (record.status === 'cancelled') return '⏹ cancelled';
  return '⏳ still in';
}

/** One player's finish — a title only for whoever played the final (the same rule as the stats). */
function finishOf(record, userId) {
  const { team } = teamOf(record, userId);
  if (record.champion === team) {
    const final = record.matches.reduce((last, m) => (!last || m.round > last.round ? m : last), null);
    const lineup = final?.lineups?.[final.a === team ? 'a' : 'b'];
    if (lineup && !lineup.includes(userId)) return `🔁 subbed out before the ${final.roundName}`;
  }
  return finish(record, team);
}

/** How the first round was paired, for the tournament card. */
const modeLabel = (mode) =>
  mode === 'aura' ? '⚖️ paired by AURA' : mode === 'manual' ? '✋ matchups picked by the host' : '🎲 random pairing';

function statusText(record) {
  if (record.status === 'finished') {
    const team = record.teams[record.champion - 1];
    const names = team.players.map((p) => safeName(p.name, p.id)).join(', ');
    return `🏆 ${teamName(record.champion)}: ${names}`;
  }
  if (record.status === 'cancelled') return `⏹ cancelled after ${record.matches.length} match(es)`;
  return `⏳ in progress · ${record.matches.length} match(es) played`;
}

/**
 * Every player who ever played, with titles and match record. Wins and losses
 * go to whoever actually played each match (its saved lineup); a title goes to
 * whoever played the final for the champion. Records from before lineups were
 * saved fall back to the team roster.
 */
function aggregate(tournaments) {
  const players = new Map(); // id -> stats
  const get = (p) => {
    if (!players.has(p.id)) {
      players.set(p.id, { id: p.id, name: p.name, played: 0, titles: 0, wins: 0, losses: 0, mates: new Map() });
    }
    const s = players.get(p.id);
    if (p.name) s.name = p.name; // latest name seen
    return s;
  };

  for (const t of tournaments) {
    // Everyone who was on each team at some point: the roster now plus anyone subbed out.
    const members = new Map(t.teams.map((team) => [team.team, new Map(team.players.map((p) => [p.id, p]))]));
    for (const sub of t.subs || []) members.get(sub.team)?.set(sub.out.id, sub.out);
    const known = new Map([...members.values()].flatMap((m) => [...m.entries()]));
    const who = (id) => known.get(id) || { id };
    const lineup = (m, teamNo) =>
      m.lineups?.[m.a === teamNo ? 'a' : 'b'] ?? t.teams[teamNo - 1].players.map((p) => p.id);

    // Teammates: whoever shared a match lineup. Someone who never played a match
    // falls back to the team(s) they were on. Each tournament counts once per player.
    const matesOf = new Map();
    const group = (ids) => {
      for (const id of ids) {
        if (!matesOf.has(id)) matesOf.set(id, new Set());
        for (const other of ids) if (other !== id) matesOf.get(id).add(other);
      }
    };
    for (const m of t.matches) for (const teamNo of [m.a, m.b]) group(lineup(m, teamNo));
    for (const team of members.values()) {
      const unplayed = [...team.keys()].filter((id) => !matesOf.has(id));
      for (const id of unplayed) matesOf.set(id, new Set([...team.keys()].filter((o) => o !== id)));
    }
    for (const [id, mates] of matesOf) {
      const s = get(who(id));
      s.played += 1;
      for (const mate of mates) s.mates.set(mate, (s.mates.get(mate) || 0) + 1);
    }

    for (const m of t.matches) {
      for (const teamNo of [m.a, m.b]) {
        for (const id of lineup(m, teamNo)) {
          const s = get(who(id));
          if (m.winner === teamNo) s.wins += 1;
          else s.losses += 1;
        }
      }
    }

    if (t.status === 'finished') {
      const final = t.matches.reduce((last, m) => (!last || m.round > last.round ? m : last), null);
      const champs = final ? lineup(final, t.champion) : t.teams[t.champion - 1].players.map((p) => p.id);
      for (const id of champs) get(who(id)).titles += 1;
    }
  }
  return players;
}

const winRate = (s) => (s.wins + s.losses ? `${Math.round((100 * s.wins) / (s.wins + s.losses))}%` : '—');

// ---------------------------------------------------------------------------
// Commands (wired into /sgdraft in draft.js)
// ---------------------------------------------------------------------------

const ephemeral = (interaction, content) =>
  interaction.reply({ flags: MessageFlags.Ephemeral, content, allowedMentions: { parse: [] } });

/** /sgdraft history [user] [page] — newest first. */
export async function historyCommand(interaction) {
  const user = interaction.options.getUser('user');
  const page = Math.max(1, interaction.options.getInteger('page') || 1);
  let list = store.getDraftHistory(interaction.guildId).tournaments.slice().reverse();
  if (user) list = list.filter((t) => teamOf(t, user.id));

  if (!list.length) {
    return ephemeral(
      interaction,
      user ? `${user} hasn't played in any recorded tournament yet.` : 'No tournaments recorded yet.',
    );
  }

  const pages = Math.ceil(list.length / PAGE_SIZE);
  const shown = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  if (!shown.length) return ephemeral(interaction, `There are only ${pages} page(s).`);

  const entries = shown.map((t) => {
    const head = `**#${t.id}** · <t:${unix(t.startedAt)}:d> · **${escapeMarkdown(t.title)}** · ${t.teams.length} teams`;
    const mine = user ? ` · ${finishOf(t, user.id)}` : '';
    return `${head}${mine}\n${statusText(t)}`;
  });
  // Whole entries only — never cut one in half.
  let description = '';
  for (const entry of entries) {
    const next = description ? `${description}\n\n${entry}` : entry;
    if (next.length > 4000) break;
    description = next;
  }

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle(user ? `📜 Tournament history — ${user.displayName ?? user.username}` : '📜 Tournament history')
    .setDescription(description)
    .setFooter({ text: `Page ${Math.min(page, pages)}/${pages} · ${list.length} tournament(s) · /sgdraft game <id> for details` });
  return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

/** One tournament as an embed; `name` prints a player (with or without their saved name). */
function gameEmbed(t, name) {
  const embed = new EmbedBuilder()
    .setColor(t.status === 'finished' ? 0xf1c40f : 0x95a5a6)
    .setTitle(`#${t.id} · ${t.title}`.slice(0, 256));

  const lines = [];
  if (t.status === 'finished') lines.push(`# 🏆 ${teamName(t.champion)} won`);
  else if (t.status === 'cancelled') lines.push('⏹ **Cancelled** before a winner was decided.');
  else lines.push('⏳ **In progress.**');

  const rounds = [...new Set(t.matches.map((m) => m.roundName))];
  for (const round of rounds) {
    lines.push(`\n**${round}**`);
    for (const m of t.matches.filter((x) => x.roundName === round)) {
      const loser = m.winner === m.a ? m.b : m.a;
      lines.push(`${teamName(m.winner)} beat ${teamName(loser)}`);
    }
  }
  if (t.subs?.length) {
    lines.push('\n**🔁 Substitutions**');
    for (const sub of t.subs) {
      const when = sub.afterMatches ? `after ${sub.afterMatches} match(es)` : 'before the first match';
      lines.push(`${teamName(sub.team)}: ${name(sub.out)} → ${name(sub.in)} (${when})`);
    }
  }
  if (t.byes.length) lines.push(`\nByes: ${t.byes.map(teamName).join(', ')}`);
  if (t.benched.length) lines.push(`Sat out: ${t.benched.map(name).join(', ')}`);
  let description = lines.join('\n');
  if (description.length > 4096) description = `${description.slice(0, 4090)}\n…`;
  embed.setDescription(description);

  embed.addFields(
    t.teams.slice(0, 24).map((team) => ({
      name: `${team.team === t.champion ? '🏆 ' : ''}${teamName(team.team)} — ${fmt(team.total)}`,
      value: team.players
        .map((p) => `${name(p)} · ${p.label || '❔'}${p.girl ? ' 🎀' : ''}`)
        .join('\n')
        .slice(0, 1024),
      inline: true,
    })),
  );

  const when = t.endedAt ? `<t:${unix(t.startedAt)}:f> → <t:${unix(t.endedAt)}:t>` : `<t:${unix(t.startedAt)}:f>`;
  embed.addFields({
    name: 'Details',
    value:
      `Host: ${name({ id: t.hostId, name: t.hostName })} · ${modeLabel(t.mode)}` +
      `${t.edited ? ' · ✏️ teams edited by host' : ''}\n${when}`,
  });
  return embed;
}

/** /sgdraft game <id> — one tournament in full. */
export async function gameCommand(interaction) {
  const id = interaction.options.getInteger('id', true);
  const t = findRecord(interaction.guildId, id);
  if (!t) return ephemeral(interaction, `No tournament #${id}.`);

  // Saved names make big tournaments overflow Discord's 6000-character total;
  // fall back to mentions only when they would.
  let embed = gameEmbed(t, who);
  if (embedLength(embed.data) > EMBED_TOTAL) embed = gameEmbed(t, (p) => `<@${p.id}>`);
  return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

/** One player's tournament record, or null if they never played. For /sgprofile. */
export function playerStats(guildId, userId) {
  const s = aggregate(store.getDraftHistory(guildId).tournaments).get(userId);
  return s ? { played: s.played, titles: s.titles, wins: s.wins, losses: s.losses } : null;
}

/** /sgdraft stats [user] — one player's record. */
export async function statsCommand(interaction) {
  const user = interaction.options.getUser('user') || interaction.user;
  const tournaments = store.getDraftHistory(interaction.guildId).tournaments;
  const everyone = aggregate(tournaments);
  const s = everyone.get(user.id);
  if (!s) return ephemeral(interaction, `${user} hasn't played in any recorded tournament yet.`);

  const mates = [...s.mates.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, n]) => `${who({ id, name: everyone.get(id)?.name })} ×${n}`)
    .join(', ');

  const recent = tournaments
    .filter((t) => teamOf(t, user.id))
    .slice(-5)
    .reverse()
    .map((t) => `**#${t.id}** ${t.title} · ${finishOf(t, user.id)}`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`📊 ${user.displayName ?? user.username} — draft stats`)
    .addFields(
      { name: 'Tournaments', value: String(s.played), inline: true },
      { name: 'Titles 🏆', value: String(s.titles), inline: true },
      { name: 'Matches', value: `${s.wins}W – ${s.losses}L (${winRate(s)})`, inline: true },
    );
  if (mates) embed.addFields({ name: 'Most played with', value: mates });
  if (recent) embed.addFields({ name: 'Recent', value: recent });
  return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

/** /sgdraft top — most titles, then most match wins. */
export async function topCommand(interaction) {
  const players = [...aggregate(store.getDraftHistory(interaction.guildId).tournaments).values()];
  if (!players.length) return ephemeral(interaction, 'No tournaments recorded yet.');

  players.sort((a, b) => b.titles - a.titles || b.wins - a.wins || a.losses - b.losses);
  const medals = ['🥇', '🥈', '🥉'];
  const lines = players.slice(0, TOP_SIZE).map((s, i) => {
    const pos = medals[i] || `\`#${String(i + 1).padStart(2)}\``;
    return `${pos} ${who(s)} · 🏆 **${s.titles}** · ${s.wins}W–${s.losses}L (${winRate(s)}) · ${s.played} played`;
  });

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('🏆 Draft leaderboard')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${players.length} player(s) · ranked by titles, then match wins` });
  return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}
