import {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ChannelType,
} from 'discord.js';
import { config } from './config.js';
import * as store from './store.js';
import * as kz from './kzApi.js';
import { parseSteamId, steamIdTo64 } from './steamid.js';
import { formatTime, modeLabel, formatNumber } from './format.js';
import { TIERS, tierLabel, tierNumber, prettyTier } from './tiers.js';
import { RANKS, rankFor } from './ranks.js';
import { getRankedMembers } from './ranking.js';
import { buildLeaderboardEmbed, updateGuild } from './leaderboard.js';
import { ensureRankRoles, syncMemberRoles, removeRankRoles } from './roles.js';
import { bountyTarget, newBountyId } from './bounty.js';

const MEDALS = ['🥇', '🥈', '🥉'];

// Admin gate — used by handlers that used to rely on setDefaultMemberPermissions,
// which can't be applied per-subcommand now that everything is under one command.
function requireAdmin(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  interaction.reply({ flags: MessageFlags.Ephemeral, content: '❌ You need the **Manage Server** permission for this.' });
  return false;
}

/** Permissions the bot is missing to post embeds in a channel (thread-aware). */
function missingPostPerms(channel, me) {
  const perms = channel?.permissionsFor?.(me);
  const inThread = channel?.isThread?.();
  const needed = {
    'View Channel': PermissionFlagsBits.ViewChannel,
    [inThread ? 'Send Messages in Threads' : 'Send Messages']: inThread
      ? PermissionFlagsBits.SendMessagesInThreads
      : PermissionFlagsBits.SendMessages,
    'Embed Links': PermissionFlagsBits.EmbedLinks,
  };
  return Object.entries(needed)
    .filter(([, bit]) => !perms?.has(bit))
    .map(([name]) => name);
}

/** Keep only the lines that fit an embed description, noting how many were cut. */
function fitLines(lines, keepIndex = -1, max = 4096) {
  const out = [];
  let len = 0;
  const reserve = 80 + (keepIndex >= 0 ? lines[keepIndex].length + 1 : 0);
  for (const line of lines) {
    const add = line.length + (out.length ? 1 : 0);
    if (len + add > max - reserve) break;
    out.push(line);
    len += add;
  }
  if (out.length === lines.length) return out.join('\n');
  const tail = [`…and ${lines.length - out.length} more`];
  if (keepIndex >= out.length) tail.push(lines[keepIndex]); // the caller's own line
  return [...out, ...tail].join('\n');
}

const courseKey = (map, course) => `${map}`.toLowerCase() + '\0' + `${course}`.toLowerCase();

// ---------------------------------------------------------------------------
// /register
// ---------------------------------------------------------------------------
const register = {
  async execute(interaction) {
    const raw = interaction.options.getString('steamid', true);
    const steamId = parseSteamId(raw);
    if (!steamId) {
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        content:
          "❌ I couldn't read that SteamID.\nUse a **SteamID64** (`7656…`), **STEAM_1:0:…**, **[U:1:…]**, or your `steamcommunity.com/profiles/…` link.\n(Custom vanity `/id/name` URLs aren't supported — open your profile and copy the numeric one.)",
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (store.isSteamTaken(interaction.guildId, steamId, interaction.user.id)) {
      return interaction.editReply('❌ That SteamID is already registered by another member in this server.');
    }

    // Look the player up (nice confirmation + name cache) and capture their current
    // record history so we never spam the channel with runs they set before registering.
    let player = null;
    let seed = [];
    let lookupFailed = false;
    let historyCaptured = true;
    try {
      player = await kz.getPlayer(steamId);
    } catch (err) {
      console.error('getPlayer failed during /register:', err.message);
      lookupFailed = true;
    }
    try {
      seed = (await kz.getRecords({ player: steamId, limit: 30 })).map((r) => r.id);
    } catch (err) {
      // Registering as "primed" with an empty history would make the announcer
      // treat every existing run as brand new. Leave it unprimed so the next
      // tick captures their history silently instead.
      console.error('getRecords failed during /register:', err.message);
      historyCaptured = false;
    }

    store.register(interaction.guildId, interaction.user.id, steamId, player?.name, seed, historyCaptured);

    const lines = [
      `✅ Registered <@${interaction.user.id}> as **${player?.name ?? 'Unknown player'}**.`,
      `SteamID: \`${steamId}\``,
    ];
    if (player) {
      lines.push('\nNew runs you set from now on will be announced. 🏁');
    } else if (lookupFailed) {
      lines.push(
        "\n_⚠️ I couldn't reach the CS2KZ API just now, so I can't confirm your profile — this says nothing about you. You're registered either way, and tracking starts automatically._",
      );
    } else {
      lines.push(
        "\n_You're not in the CS2KZ database yet — that's fine. You'll be tracked automatically once you set your first time._",
      );
    }
    return interaction.editReply(lines.join('\n'));
  },
};

// ---------------------------------------------------------------------------
// /unregister
// ---------------------------------------------------------------------------
const unregister = {
  async execute(interaction) {
    // Admins can remove someone else — e.g. members who left the server, whose
    // registrations otherwise stay on the boards forever.
    const target = interaction.options.getUser('user') ?? interaction.user;
    const self = target.id === interaction.user.id;
    if (!self && !requireAdmin(interaction)) return undefined;
    const existed = store.unregister(interaction.guildId, target.id);
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
      content: existed
        ? self
          ? '✅ You have been unregistered.'
          : `✅ Unregistered <@${target.id}>.`
        : self
          ? "ℹ️ You weren't registered."
          : `ℹ️ <@${target.id}> wasn't registered.`,
    });
    // Nothing syncs roles for unregistered members, so take the rank role off now.
    if (existed && config.enableRankRoles && interaction.guild) await removeRankRoles(interaction.guild, target.id);
    return undefined;
  },
};

// ---------------------------------------------------------------------------
// /rankings
// ---------------------------------------------------------------------------
const rankings = {
  async execute(interaction) {
    await interaction.deferReply();
    const mode = interaction.options.getString('mode') || config.defaultMode;

    const registered = Object.keys(store.getPlayers(interaction.guildId)).length;
    if (registered === 0) {
      return interaction.editReply(
        `No one has registered yet. Use \`/${config.commandRoot} register <steamid>\` to get on the board!`,
      );
    }

    const { members: ranked, failed } = await getRankedMembers(interaction.guildId, mode);
    if (ranked.length === 0) {
      return interaction.editReply(
        failed.length
          ? `⚠️ Couldn't reach the CS2KZ API for ${failed.length} member(s), so I can't build the ranking right now. Try again shortly.`
          : 'None of the registered members have a rating in that mode yet.',
      );
    }

    const medals = ['🥇', '🥈', '🥉'];
    const lines = ranked.map((r, i) => {
      const pos = medals[i] || `\`#${i + 1}\``;
      const rank = mode === 'ckz' ? ` · ${rankFor(r.rating)?.name ?? ''}` : '';
      return `${pos} **${r.name}** — \`${formatNumber(r.rating)}\`${rank} · <@${r.discordId}>`;
    });

    const embed = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle(`🏆 CS2KZ Rankings — ${mode.toUpperCase()}`)
      .setDescription(fitLines(lines, ranked.findIndex((r) => r.discordId === interaction.user.id)))
      .setFooter({
        text:
          `${ranked.length} ranked member(s) · ${modeLabel(mode === 'vnl' ? 'vanilla' : 'classic')} rating` +
          (failed.length ? ` · ⚠️ ${failed.length} couldn't be loaded` : ''),
      });

    return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};

// ---------------------------------------------------------------------------
// /profile
// ---------------------------------------------------------------------------
const profile = {
  async execute(interaction) {
    await interaction.deferReply();
    const target = interaction.options.getUser('user') || interaction.user;
    const entry = store.findByDiscord(interaction.guildId, target.id);
    if (!entry) {
      return interaction.editReply(
        target.id === interaction.user.id
          ? `You haven't registered yet. Use \`/${config.commandRoot} register <steamid>\`.`
          : `${target} hasn't registered.`,
      );
    }

    const modeShort = interaction.options.getString('mode') || config.defaultMode;
    const apiMode = modeShort === 'vnl' ? 'vanilla' : 'classic';

    // allSettled, not catch(() => null): a failed request and a player who
    // genuinely isn't in the database look identical once both become null, and
    // reporting an API timeout as "not in the CS2KZ database" states something
    // false about a real person.
    const settled = await Promise.allSettled([
      kz.getPlayer(entry.steamId),
      kz.getRecords({ player: entry.steamId, limit: 1 }),
      kz.getAllMaps(),
      kz.getPersonalBests({ player: entry.steamId, mode: apiMode, limit: 1000 }),
      kz.getPersonalBests({ player: entry.steamId, mode: apiMode, hasTeleports: false, limit: 1000 }),
    ]);
    const valueOr = (result, fallback) => (result.status === 'fulfilled' ? result.value : fallback);

    const [playerResult, recentResult, mapsResult, tpResult, proResult] = settled;
    const data = valueOr(playerResult, null);
    const recent = valueOr(recentResult, []);
    const maps = valueOr(mapsResult, []);
    const tpPbs = valueOr(tpResult, []);
    const proPbs = valueOr(proResult, []);

    const lookupFailed = playerResult.status === 'rejected';
    const anyFailed = settled.some((r) => r.status === 'rejected');
    if (anyFailed) {
      console.error(
        '/profile: CS2KZ API calls failed:',
        settled.filter((r) => r.status === 'rejected').map((r) => r.reason?.message).join('; '),
      );
    }

    const steam64 = steamIdTo64(entry.steamId);
    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle(`${data?.name ?? entry.name ?? 'CS2KZ Player'}`)
      .setDescription(`Discord: ${target}\nSteamID: \`${entry.steamId}\``);

    if (steam64) embed.setURL(`https://steamcommunity.com/profiles/${steam64}`);

    if (data) {
      embed.addFields(
        { name: 'CKZ rating', value: (data.ckz_rating ?? 0).toFixed(1), inline: true },
        { name: 'VNL rating', value: (data.vnl_rating ?? 0).toFixed(1), inline: true },
      );
      if (data.first_joined_at) {
        const ts = Math.floor(new Date(data.first_joined_at).getTime() / 1000);
        embed.addFields({ name: 'First seen', value: `<t:${ts}:D>`, inline: true });
      }
    } else if (lookupFailed) {
      embed.addFields({
        name: 'Status',
        value:
          "⚠️ Couldn't reach the CS2KZ API just now, so their stats are unavailable. " +
          'This says nothing about the player — try again in a moment.',
        inline: false,
      });
    } else {
      embed.addFields({ name: 'Status', value: 'Not in the CS2KZ database yet.', inline: false });
    }

    const r = recent[0];
    if (r) {
      embed.addFields({
        name: 'Latest run',
        value: `${r.map?.name ?? 'map'} — ${r.course?.name ?? 'main'} · \`${formatTime(r.time)}\` (${(r.teleports ?? 0) === 0 ? 'PRO' : `${r.teleports} TP`})`,
      });
    }

    if (maps.length) {
      const tpFinished = new Set(tpPbs.map((x) => courseKey(x.map?.name, x.course?.name)));
      const proFinished = new Set(proPbs.map((x) => courseKey(x.map?.name, x.course?.name)));
      const rows = tierBreakdown({ maps, apiMode, tpFinished, proFinished });
      if (rows.length) {
        embed.addFields({
          name: `Completion by tier — ${modeLabel(apiMode)}`,
          value: renderCompletionTable(rows),
        });
      }
    }

    // A partial failure would otherwise show up as an empty completion table,
    // which reads as "finished nothing" rather than "couldn't load".
    if (anyFailed && !lookupFailed) {
      embed.setFooter({ text: '⚠️ Some CS2KZ data failed to load, so this profile may be incomplete.' });
    }

    return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};

// ---------------------------------------------------------------------------
// /setchannel  (admins only)
// ---------------------------------------------------------------------------
const setchannel = {
  async execute(interaction) {
    if (!requireAdmin(interaction)) return;
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const missing = missingPostPerms(channel, interaction.guild.members.me);
    if (missing.length) {
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: `❌ I can't post in ${channel}: missing **${missing.join(', ')}**. Nothing was changed.`,
      });
    }
    store.setAnnounceChannel(interaction.guildId, channel.id);
    return interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: `✅ New-record announcements will be posted in ${channel}.`,
    });
  },
};

// ---------------------------------------------------------------------------
// /unfinished  — maps of a given tier the member hasn't completed yet
// ---------------------------------------------------------------------------
// Per-tier PRO/TP completion counts for a mode. Skips tiers with no courses.
function tierBreakdown({ maps, apiMode, tpFinished, proFinished }) {
  return TIERS.map((t) => {
    let proTotal = 0, proDone = 0, tpTotal = 0, tpDone = 0;
    for (const m of maps) {
      for (const c of m.courses || []) {
        const filter = c.filters?.[apiMode];
        if (!filter) continue;
        const key = courseKey(m.name, c.name);
        if (filter.pro_tier === t) { proTotal++; if (proFinished.has(key)) proDone++; }
        if (filter.nub_tier === t) { tpTotal++; if (tpFinished.has(key)) tpDone++; }
      }
    }
    return { tier: t, proTotal, proDone, tpTotal, tpDone };
  }).filter((r) => r.proTotal > 0 || r.tpTotal > 0);
}

// Render the breakdown as an aligned monospace table for an embed field.
function renderCompletionTable(rows) {
  const W = 11;
  const head = 'Tier'.padEnd(W) + 'PRO'.padStart(9) + 'TP'.padStart(9);
  const body = rows.map(
    (r) =>
      prettyTier(r.tier).padEnd(W) +
      `${r.proDone}/${r.proTotal}`.padStart(9) +
      `${r.tpDone}/${r.tpTotal}`.padStart(9),
  );
  const t = rows.reduce(
    (a, r) => ({ pd: a.pd + r.proDone, pt: a.pt + r.proTotal, td: a.td + r.tpDone, tt: a.tt + r.tpTotal }),
    { pd: 0, pt: 0, td: 0, tt: 0 },
  );
  const total = 'Total'.padEnd(W) + `${t.pd}/${t.pt}`.padStart(9) + `${t.td}/${t.tt}`.padStart(9);
  return '```\n' + [head, ...body, total].join('\n') + '\n```';
}

// Build one PRO or TP section for the embed. tierField is 'nub_tier' (TP) or 'pro_tier' (PRO).
const COMPLETION_PAGE_SIZE = 15;

/** 'all' isn't a real tier, so it needs its own label. */
const tierTitle = (tier) => (tier === 'all' ? 'All tiers' : tierLabel(tier));

/**
 * Every course at the requested tier for one ladder, split into finished and
 * not. Both full lists come back; paging happens at render time so the counts
 * in the header stay honest whichever list is being shown.
 *
 * `finished` maps courseKey -> the player's PB record, so finished entries can
 * show the time without another request.
 */
function collectSection({ emoji, label, tierField, maps, apiMode, tier, finished }) {
  const byTier = (a, b) =>
    TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) ||
    a.map.localeCompare(b.map) ||
    a.course.localeCompare(b.course);

  const todo = [];
  const done = [];

  for (const m of maps) {
    for (const c of m.courses || []) {
      const courseTier = c.filters?.[apiMode]?.[tierField];
      if (!courseTier) continue;
      if (tier !== 'all' && courseTier !== tier) continue;

      const entry = { map: m.name, course: c.name, tier: courseTier };
      const pb = finished.get(courseKey(m.name, c.name));
      if (pb) done.push({ ...entry, time: pb.time, teleports: pb.teleports ?? 0 });
      else todo.push(entry);
    }
  }

  todo.sort(byTier);
  // Finished list reads best-first by difficulty too, so progress is obvious.
  done.sort(byTier);

  return { emoji, label, wanted: todo.length + done.length, todo, done };
}

function renderSection(section, { page, showTier, showDone }) {
  const list = showDone ? section.done : section.todo;
  const slice = list.slice(page * COMPLETION_PAGE_SIZE, (page + 1) * COMPLETION_PAGE_SIZE);

  let body;
  if (section.wanted === 0) body = '_No courses at this tier._';
  else if (list.length === 0) {
    body = showDone ? '_Nothing finished here yet._' : `🎉 All ${section.wanted} done!`;
  } else if (slice.length === 0) body = '_Nothing on this page._';
  else {
    body = slice
      .map((w) => {
        let line = /^main$/i.test(w.course) ? `\`${w.map}\`` : `\`${w.map}\` — ${w.course}`;
        if (showTier) line += ` · T${tierNumber(w.tier)}`;
        if (showDone && w.time != null) {
          line += ` · \`${formatTime(w.time)}\`${w.teleports ? ` (${w.teleports}TP)` : ''}`;
        }
        return line;
      })
      .join('\n');
  }
  if (body.length > 1024) body = body.slice(0, 1010) + '\n…';

  return {
    name: `${section.emoji} ${section.label} · ${section.done.length}/${section.wanted} done`,
    value: body,
  };
}

/**
 * Build a /finished or /unfinished reply for a given page.
 * All the state a page flip needs is encoded in the button ids, so this works
 * just as well after a restart as it does in the original interaction.
 */
async function buildCompletionView({ guildId, targetId, tier, type, modeShort, page, showDone, force = false }) {
  const apiMode = modeShort === 'vnl' ? 'vanilla' : 'classic';
  const entry = store.findByDiscord(guildId, targetId);
  if (!entry) return { error: `<@${targetId}> hasn't registered.` };

  const needTp = type === 'tp' || type === 'both';
  const needPro = type === 'pro' || type === 'both';

  const [maps, tpPbs, proPbs] = await Promise.all([
    kz.getAllMaps(),
    needTp
      ? kz.getPersonalBests({ player: entry.steamId, mode: apiMode, limit: 1000, force })
      : Promise.resolve([]),
    needPro
      ? kz.getPersonalBests({ player: entry.steamId, mode: apiMode, hasTeleports: false, limit: 1000, force })
      : Promise.resolve([]),
  ]);

  // When the cached personal bests were fetched, for an honest "as of" line.
  const fetchedAt = kz.personalBestsFetchedAt({
    player: entry.steamId,
    mode: apiMode,
    hasTeleports: needPro && !needTp ? false : undefined,
    limit: 1000,
  });
  const asMap = (pbs) => new Map(pbs.map((r) => [courseKey(r.map?.name, r.course?.name), r]));
  const tpFinished = asMap(tpPbs);
  const proFinished = asMap(proPbs);

  const sections = [];
  if (needPro) {
    sections.push(
      collectSection({ emoji: '🟢', label: 'PRO', tierField: 'pro_tier', maps, apiMode, tier, finished: proFinished }),
    );
  }
  if (needTp) {
    sections.push(
      collectSection({ emoji: '🔵', label: 'TP', tierField: 'nub_tier', maps, apiMode, tier, finished: tpFinished }),
    );
  }

  if (sections.every((s) => s.wanted === 0)) {
    return { error: `There are no **${tierTitle(tier)}** courses in ${modeLabel(apiMode)} right now.` };
  }

  const listOf = (s) => (showDone ? s.done : s.todo);
  const totalPages = Math.max(1, ...sections.map((s) => Math.ceil(listOf(s).length / COMPLETION_PAGE_SIZE)));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const count = sections.reduce((sum, s) => sum + listOf(s).length, 0);

  const embed = new EmbedBuilder()
    .setColor(showDone ? 0x2ecc71 : 0xe67e22)
    .setTitle(`🗺️ ${showDone ? 'Finished' : 'Unfinished'} ${tierTitle(tier)} — ${modeShort.toUpperCase()}`)
    .setDescription(
      `Completions for <@${targetId}> · **${count}** course(s) ${showDone ? 'finished' : 'left'}`,
    )
    .addFields(sections.map((s) => renderSection(s, { page: safePage, showTier: tier === 'all', showDone })))
    .setFooter({
      text:
        `${modeLabel(apiMode)} · 🟢 PRO = 0 teleports · 🔵 TP = teleports allowed` +
        (totalPages > 1 ? ` · page ${safePage + 1}/${totalPages}` : '') +
        (fetchedAt ? ` · as of ${Math.max(0, Math.round((Date.now() - fetchedAt) / 60000))} min ago — 🔄 after a new PB` : ''),
    });

  const components = [];
  const state = [showDone ? 'fin' : 'unf', tier, type, modeShort, targetId].join('|');
  if (totalPages > 1) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${state}|${safePage - 1}`)
          .setLabel('◀ Prev')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safePage === 0),
        new ButtonBuilder()
          .setCustomId('unf|page')
          .setLabel(`${safePage + 1} / ${totalPages}`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`${state}|${safePage + 1}`)
          .setLabel('Next ▶')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safePage >= totalPages - 1),
        new ButtonBuilder()
          .setCustomId(`${state}|${safePage}|refresh`)
          .setLabel('Refresh')
          .setEmoji('🔄')
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  } else {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${state}|0|refresh`)
          .setLabel('Refresh')
          .setEmoji('🔄')
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }

  return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

/** Shared by /finished and /unfinished — they differ only in which list is shown. */
function completionCommand(showDone) {
  return {
    async execute(interaction) {
      await interaction.deferReply();

      const tier = interaction.options.getString('tier', true);
      const type = interaction.options.getString('type') || 'both';
      const modeShort = interaction.options.getString('mode') || config.defaultMode;
      const target = interaction.options.getUser('user') || interaction.user;

      if (!store.findByDiscord(interaction.guildId, target.id)) {
        return interaction.editReply(
          target.id === interaction.user.id
            ? `You haven't registered yet. Use \`/${config.commandRoot} register <steamid>\` first.`
            : `${target} hasn't registered.`,
        );
      }

      const view = await buildCompletionView({
        guildId: interaction.guildId,
        targetId: target.id,
        tier,
        type,
        modeShort,
        page: 0,
        showDone,
      });
      if (view.error) return interaction.editReply(view.error);
      return interaction.editReply(view);
    },
  };
}

const unfinished = completionCommand(false);
const finished = completionCommand(true);

/** Page buttons on a /finished or /unfinished reply. State lives in the custom id. */
export async function handleComponent(interaction) {
  if (!interaction.isButton()) return;
  const [kind, ...rest] = interaction.customId.split('|');
  if ((kind !== 'unf' && kind !== 'fin') || rest[0] === 'page') return;

  const [tier, type, modeShort, targetId, page, action] = rest;
  await interaction.deferUpdate();

  try {
    const view = await buildCompletionView({
      guildId: interaction.guildId,
      targetId,
      tier,
      type,
      modeShort,
      page: Number(page) || 0,
      showDone: kind === 'fin',
      force: action === 'refresh', // 🔄 asks the API again instead of reusing the cached copy
    });
    if (view.error) return interaction.editReply({ content: view.error, embeds: [], components: [] });
    return interaction.editReply(view);
  } catch (err) {
    // Without this the page just silently doesn't turn, which looks like a dead
    // button. Leave the existing embed in place and say what happened.
    console.error('Failed to build completion page:', err.message);
    return interaction
      .followUp({ flags: MessageFlags.Ephemeral, content: "⚠️ The CS2KZ API didn't respond in time. Try that page again." })
      .catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// /maplists — the full CS2KZ map catalogue
// ---------------------------------------------------------------------------

/**
 * `maplists` prints multi-course maps as "kz_avalon (Bonus 1)", so people paste
 * that straight back in. Split it into map + course.
 *
 * The inner group is greedy and anchored to the final ")" because course names
 * can contain brackets themselves — "kz_grotto (Old grotto (hard))".
 */
function splitMapAndCourse(input) {
  const text = String(input).trim();
  const m = text.match(/^(.*?)\s*\((.+)\)$/);
  return m ? { map: m[1].trim(), course: m[2].trim() } : { map: text, course: null };
}

/** Resolve whatever the user typed to a real map, tolerating case and partials. */
async function resolveMap(input) {
  const maps = await kz.getAllMaps();
  const wanted = String(input).trim().toLowerCase();

  const exact = maps.find((m) => m.name.toLowerCase() === wanted);
  if (exact) return { map: exact };

  // "grotto" should find kz_grotto, but only when it's unambiguous.
  const partial = maps.filter((m) => m.name.toLowerCase().includes(wanted));
  if (partial.length === 1) return { map: partial[0] };
  if (partial.length > 1) return { map: null, suggestions: partial.slice(0, 10).map((m) => m.name) };
  return { map: null, suggestions: [] };
}

const maplists = {
  async execute(interaction) {
    await interaction.deferReply();

    const modeShort = interaction.options.getString('mode') || config.defaultMode;
    const apiMode = modeShort === 'vnl' ? 'vanilla' : 'classic';
    const type = interaction.options.getString('type') || 'tp';
    const tierField = type === 'pro' ? 'pro_tier' : 'nub_tier';
    const onlyTier = interaction.options.getString('tier');

    const maps = await kz.getAllMaps();

    // Group every ranked course by its tier for this mode.
    const byTier = new Map();
    let courseCount = 0;
    for (const m of maps) {
      for (const c of m.courses || []) {
        const filter = c.filters?.[apiMode];
        const tier = filter?.[tierField];
        if (!tier) continue;
        if (onlyTier && tier !== onlyTier) continue;
        courseCount++;
        const label = /^main$/i.test(c.name) ? m.name : `${m.name} (${c.name})`;
        if (!byTier.has(tier)) byTier.set(tier, []);
        byTier.get(tier).push(label);
      }
    }

    if (courseCount === 0) {
      return interaction.editReply(
        onlyTier
          ? `No **${tierLabel(onlyTier)}** courses in ${modeLabel(apiMode)}.`
          : `No maps found for ${modeLabel(apiMode)}.`,
      );
    }

    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle('🗺️ CS2KZ map list')
      .setDescription(
        `**${maps.length}** approved maps · **${courseCount}** courses` +
          (onlyTier ? ` at ${tierLabel(onlyTier)}` : '') +
          `\n${modeLabel(apiMode)} · ${type === 'pro' ? '🟢 PRO tiers' : '🔵 TP tiers'}`,
      );

    // Ordered easiest-first; each tier is one field, trimmed to Discord's limit.
    for (const tier of TIERS) {
      const list = byTier.get(tier);
      if (!list?.length) continue;
      let body = list.sort((a, b) => a.localeCompare(b)).map((n) => `\`${n}\``).join(', ');
      if (body.length > 1024) body = body.slice(0, 1010) + '… ';
      embed.addFields({ name: `${tierLabel(tier)} — ${list.length}`, value: body });
    }

    embed.setFooter({ text: `Use /${config.commandRoot} maptop <map> for a map's ranking.` });
    return interaction.editReply({ embeds: [embed] });
  },
};

// ---------------------------------------------------------------------------
// /maptop — Secret Garden ranking on one map, with each run's global rank
// ---------------------------------------------------------------------------
const maptop = {
  async execute(interaction) {
    await interaction.deferReply();

    const rawMap = interaction.options.getString('map', true);
    const modeShort = interaction.options.getString('mode') || config.defaultMode;
    const apiMode = modeShort === 'vnl' ? 'vanilla' : 'classic';
    const pro = interaction.options.getString('type') === 'pro';

    const parsed = splitMapAndCourse(rawMap);
    const { map, suggestions } = await resolveMap(parsed.map);
    if (!map) {
      return interaction.editReply(
        suggestions?.length
          ? `❌ **${parsed.map}** is ambiguous. Did you mean:\n${suggestions.map((s) => `• \`${s}\``).join('\n')}`
          : `❌ No CS2KZ map matching **${parsed.map}**. Try \`/${config.commandRoot} maplists\`.`,
      );
    }

    // Default to the main course, or the only one the map has. An explicit
    // `course` option wins over one parsed out of the map name.
    const requested = interaction.options.getString('course') || parsed.course;
    const courses = map.courses || [];
    const course = requested
      ? courses.find((c) => c.name.toLowerCase() === requested.trim().toLowerCase())
      : courses.find((c) => /^main$/i.test(c.name)) || courses[0];

    if (!course) {
      return interaction.editReply(
        `❌ \`${map.name}\` has no course called **${requested}**. Courses: ` +
          courses.map((c) => `\`${c.name}\``).join(', '),
      );
    }

    const board = await kz.getCourseLeaderboard({
      map: map.name,
      course: course.name,
      mode: apiMode,
      pro,
    });

    if (!board.length) {
      // Nobody worldwide has finished it on this ladder. Say where times *do*
      // exist, so an empty board doesn't just look like the command failing.
      const otherMode = apiMode === 'classic' ? 'vanilla' : 'classic';
      const [anyLadder, otherModeBoard] = await Promise.all([
        pro
          ? kz.getCourseLeaderboard({ map: map.name, course: course.name, mode: apiMode }).catch(() => [])
          : Promise.resolve([]),
        kz.getCourseLeaderboard({ map: map.name, course: course.name, mode: otherMode, pro }).catch(() => []),
      ]);

      const tier = course.filters?.[apiMode]?.[pro ? 'pro_tier' : 'nub_tier'];
      const state = course.filters?.[apiMode]?.state;
      const where = course.name && !/^main$/i.test(course.name) ? `\`${map.name}\` — ${course.name}` : `\`${map.name}\``;

      const lines = [
        `📭 Nobody has finished ${where} on the ` +
          `${pro ? '🟢 PRO' : '🔵 Any'} board in ${modeLabel(apiMode)} yet — **0** times worldwide.`,
      ];
      if (tier) lines.push(`Tier: **${tierLabel(tier)}**${state && state !== 'ranked' ? ` · _${state}_` : ''}`);
      if (anyLadder.length) {
        lines.push(`There are **${anyLadder.length}** times on the 🔵 Any board — try \`type: Any\`.`);
      }
      if (otherModeBoard.length) {
        lines.push(`There are **${otherModeBoard.length}** in ${modeLabel(otherMode)} — try \`mode: ${otherMode === 'vanilla' ? 'VNL' : 'CKZ'}\`.`);
      }
      return interaction.editReply(lines.join('\n'));
    }

    // Registered members, mapped back to their Discord accounts.
    const players = store.getPlayers(interaction.guildId);
    const discordBySteam = new Map(
      Object.entries(players).map(([discordId, p]) => [p.steamId, discordId]),
    );

    const ours = [];
    board.forEach((run, index) => {
      const discordId = discordBySteam.get(run.player?.id);
      if (discordId) ours.push({ run, discordId, globalRank: index + 1 });
    });

    if (!ours.length) {
      return interaction.editReply(
        `Nobody registered here has a ${pro ? 'PRO ' : ''}time on \`${map.name}\` — ${course.name} ` +
          `(${modeLabel(apiMode)}) yet. **${board.length}** players worldwide do.`,
      );
    }

    const ladder = pro ? 'PRO' : 'Any';
    const lines = ours.slice(0, 25).map((e, i) => {
      const pos = MEDALS[i] || `\`#${String(i + 1).padStart(2, '0')}\``;
      const tp = (e.run.teleports ?? 0) === 0 ? '🟢' : `🔵 ${e.run.teleports}TP`;
      return (
        `${pos} <@${e.discordId}> · \`${formatTime(e.run.time)}\` · ${tp}\n` +
        `　　🌍 ${ladder} global **#${e.globalRank}** / ${board.length}`
      );
    });

    const tier = course.filters?.[apiMode]?.[pro ? 'pro_tier' : 'nub_tier'];
    const embed = new EmbedBuilder()
      .setColor(0x1abc9c)
      .setTitle(`🏁 ${map.name}${/^main$/i.test(course.name) ? '' : ` — ${course.name}`}`)
      .setDescription(lines.join('\n'))
      .addFields(
        { name: 'Mode', value: modeLabel(apiMode), inline: true },
        {
          name: 'Ranked on',
          value: pro ? '🟢 PRO board — 0 teleports' : '🔵 Any board — teleports allowed',
          inline: true,
        },
        { name: 'Tier', value: tier ? tierLabel(tier) : '—', inline: true },
      )
      .setFooter({
        text: `${ours.length} of ${Object.keys(players).length} registered members · ${board.length} worldwide`,
      });

    return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};

// ---------------------------------------------------------------------------
// /leaderboard setup | refresh  (admins only)
// ---------------------------------------------------------------------------
const leaderboard = {
  async execute(interaction) {
    if (!requireAdmin(interaction)) return;
    if (interaction.options.getSubcommand() === 'refresh') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const s = (await updateGuild(interaction.client, interaction.guildId)) || {};
      const lines = [];
      if (s.board === 'ok') lines.push('✅ Leaderboard refreshed.');
      else if (s.board === 'api-down') lines.push("⚠️ The CS2KZ API isn't answering — the board was left as it was.");
      else if (s.board === 'deleted') lines.push(`⚠️ The leaderboard message was deleted. Run \`/${config.commandRoot} leaderboard setup\` to post a new one.`);
      else if (s.board === 'error') lines.push(`⚠️ Couldn't update the leaderboard message: ${s.error}`);
      else lines.push(`ℹ️ No leaderboard is set up. Run \`/${config.commandRoot} leaderboard setup\`.`);
      if (s.failed) lines.push(`⚠️ ${s.failed} player lookup(s) failed.`);
      if (config.enableRankRoles) {
        lines.push(s.roleErrors ? `⚠️ Rank roles: ${s.roleErrors} problem(s)${s.roleError ? ` — ${s.roleError}` : ''}.` : '✅ Rank roles synced.');
      }
      return interaction.editReply(lines.join('\n'));
    }

    // setup
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = interaction.options.getChannel('channel') || interaction.channel;

    const me = interaction.guild.members.me;
    const missing = missingPostPerms(channel, me);
    if (missing.length) {
      return interaction.editReply(
        `❌ I can't post in ${channel} — missing **${missing.join(', ')}**.\n` +
          `Open that channel's settings → **Permissions** → add the **${me.user.username}** role and allow those, then run this again.`,
      );
    }

    const { members: entries, failed: lookupsFailed } = await getRankedMembers(interaction.guildId, 'ckz');
    if (!entries.length && lookupsFailed.length) {
      return interaction.editReply(
        `❌ The CS2KZ API isn't answering (${lookupsFailed.length} lookup(s) failed), so I'd post an empty board. Try again in a few minutes.`,
      );
    }
    const previous = store.getGuild(interaction.guildId)?.leaderboard;
    let message;
    try {
      message = await channel.send({
        embeds: [buildLeaderboardEmbed(entries, lookupsFailed)],
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      return interaction.editReply(
        `❌ Couldn't post in ${channel} (${err.message}). Give me **View Channel + Send Messages + Embed Links** in that channel.`,
      );
    }

    let pinNote = '';
    try {
      await message.pin();
    } catch {
      pinNote = '\n⚠️ I couldn\'t pin it — grant **Manage Messages** if you want it pinned.';
    }
    store.setLeaderboard(interaction.guildId, channel.id, message.id);
    // Remove the old board, or it stays pinned and frozen next to the new one.
    if (previous?.messageId && previous.messageId !== message.id) {
      await interaction.client.channels
        .fetch(previous.channelId)
        .then((old) => old.messages.delete(previous.messageId))
        .catch(() => {}); // already gone, or no access
    }

    let roleNote = '';
    if (config.enableRankRoles) {
      try {
        const rolesByName = await ensureRankRoles(interaction.guild);
        let assigned = 0;
        let failed = 0;
        for (const e of entries) {
          const applied = await syncMemberRoles(interaction.guild, e.discordId, e.rating, rolesByName).catch(
            () => {
              failed += 1;
              return null;
            },
          );
          if (applied) assigned += 1;
        }
        roleNote = `\n✅ Rank roles ready — assigned to ${assigned} member(s).`;
        if (failed) {
          roleNote += ` ⚠️ ${failed} failed — drag my bot role **above** the \`${config.rankRolePrefix} …\` roles (Server Settings → Roles).`;
        }
      } catch (err) {
        roleNote = `\n⚠️ Couldn't create rank roles: ${err.message} — give me the **Manage Roles** permission.`;
      }
    }

    const mins = Math.round(config.leaderboardIntervalMs / 60000);
    return interaction.editReply(
      `✅ Live leaderboard posted in ${channel}${pinNote ? '' : ' and pinned'}. It refreshes every ${mins} min.${pinNote}${roleNote}`,
    );
  },
};

// ---------------------------------------------------------------------------
// /ranks  — show the CKZ rank ladder and your current rank
// ---------------------------------------------------------------------------
const ranks = {
  async execute(interaction) {
    await interaction.deferReply();

    let mine = null;
    let lookupFailed = false;
    const entry = store.findByDiscord(interaction.guildId, interaction.user.id);
    if (entry) {
      try {
        const data = await kz.getPlayer(entry.steamId);
        if (data && typeof data.ckz_rating === 'number') {
          mine = { rating: data.ckz_rating, rank: rankFor(data.ckz_rating) };
        }
      } catch (err) {
        // Silently omitting the marker reads as "you have no rank".
        console.error('/ranks: getPlayer failed:', err.message);
        lookupFailed = true;
      }
    }

    const lines = RANKS.map((r) => {
      const here = mine && mine.rank?.name === r.name ? '  ⬅️ **you**' : '';
      return `\`${formatNumber(r.minRating).padStart(7)}+\`  ${r.name}${here}`;
    });

    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle('CS2KZ Rank Ladder — CKZ')
      .setDescription(lines.join('\n'));
    if (mine) {
      embed.setFooter({ text: `Your CKZ rating: ${formatNumber(mine.rating)} — ${mine.rank?.name}` });
    } else if (lookupFailed) {
      embed.setFooter({ text: "⚠️ Couldn't reach the CS2KZ API, so your own rank isn't marked." });
    }
    return interaction.editReply({ embeds: [embed] });
  },
};

// ---------------------------------------------------------------------------
// /bounty add | list | remove
// ---------------------------------------------------------------------------
async function bountyAdd(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: '❌ You need the **Manage Server** permission to create bounties.',
    });
  }
  await interaction.deferReply();

  const mapInput = interaction.options.getString('map', true);
  const reward = interaction.options.getString('reward', true);
  const courseInput = interaction.options.getString('course');
  const mode = interaction.options.getString('mode');
  const type = interaction.options.getString('type');
  const note = interaction.options.getString('note');

  // Validate the map (and course) exist so the bounty can actually be claimed.
  let maps = [];
  try {
    maps = await kz.getAllMaps();
  } catch {
    /* if the API is down, fall through and trust the input */
  }
  const map = maps.length
    ? maps.find((m) => m.name.toLowerCase() === mapInput.toLowerCase())
    : { name: mapInput, courses: [] };
  if (!map) {
    return interaction.editReply(
      `❌ I don't see a map named \`${mapInput}\`. Use the exact CS2KZ map name, e.g. \`kz_grotto\`.`,
    );
  }
  let courseName = null;
  if (courseInput) {
    const course = (map.courses || []).find((c) => c.name.toLowerCase() === courseInput.toLowerCase());
    if (!course && map.courses?.length) {
      return interaction.editReply(
        `❌ \`${map.name}\` has no course \`${courseInput}\`. Courses: ${map.courses.map((c) => c.name).join(', ')}.`,
      );
    }
    courseName = course ? course.name : courseInput;
  } else if (map.courses?.length > 1) {
    // "Beat the map" means its main course, not an easier bonus.
    courseName = (map.courses.find((c) => /^main$/i.test(c.name)) || map.courses[0]).name;
  }

  const bounties = store.getBounties(interaction.guildId);
  const bounty = {
    id: newBountyId(bounties),
    map: map.name,
    course: courseName,
    mode: mode || null,
    type: type || null,
    reward,
    note: note || null,
    createdBy: interaction.user.id,
    createdAt: new Date().toISOString(),
    active: true,
    claimedBy: null,
    claimedRecordId: null,
    claimedAt: null,
  };
  store.addBounty(interaction.guildId, bounty);

  const embed = new EmbedBuilder()
    .setColor(0xffd700)
    .setTitle('💰 New bounty!')
    .setDescription(`First registered member to beat ${bountyTarget(bounty)} wins **${reward}**!`)
    .setFooter({ text: `Bounty #${bounty.id} · set by ${interaction.user.username}` });
  if (note) embed.addFields({ name: 'Note', value: note });
  return interaction.editReply({ embeds: [embed] });
}

async function bountyList(interaction) {
  await interaction.deferReply();
  const bounties = store.getBounties(interaction.guildId);
  const active = bounties.filter((b) => b.active && !b.claimedBy);
  const claimed = bounties.filter((b) => b.claimedBy).slice(-5).reverse();

  const embed = new EmbedBuilder().setColor(0xffd700).setTitle('💰 Bounties');
  if (active.length) {
    embed.addFields({
      name: `🎯 Active (${active.length})`,
      value: active
        .map((b) => `\`#${b.id}\` ${bountyTarget(b)} → **${b.reward}**`)
        .join('\n')
        .slice(0, 1024),
    });
  } else {
    embed.setDescription(`No active bounties right now. Admins can create one with \`/${config.commandRoot} bounty add\`.`);
  }
  if (claimed.length) {
    embed.addFields({
      name: '✅ Recently claimed',
      value: claimed
        .map((b) => `\`#${b.id}\` ${bountyTarget(b)} → **${b.reward}** — <@${b.claimedBy}>`)
        .join('\n')
        .slice(0, 1024),
    });
  }
  return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function bountyRemove(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: '❌ You need the **Manage Server** permission to remove bounties.',
    });
  }
  const id = interaction.options.getString('id', true).replace(/^#/, '');
  const ok = store.removeBounty(interaction.guildId, id);
  return interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: ok ? `✅ Removed bounty \`#${id}\`.` : `❌ No bounty with id \`#${id}\`.`,
  });
}

const bounty = {
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') return bountyList(interaction);
    if (sub === 'add') return bountyAdd(interaction);
    return bountyRemove(interaction);
  },
};

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------
// Which section each command belongs under. Anything missing from here still
// gets listed (under "Other"), so a new command can never go undocumented.
const HELP_SECTIONS = [
  { title: '🚀 Getting started', names: ['register', 'unregister', 'help'] },
  { title: '🏆 Rankings & profile', names: ['rankings', 'profile', 'ranks'] },
  { title: '🗺️ Maps', names: ['maplists', 'maptop', 'unfinished', 'finished'] },
  { title: '🎯 Bounties', names: ['bounty'] },
  { title: '🔧 Admin — needs Manage Server', names: ['setchannel', 'leaderboard'] },
];

const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;

/** "<map> [course]" — required args in angle brackets, optional in square. */
function argSignature(options = []) {
  return options
    .filter((o) => o.type !== SUB_COMMAND && o.type !== SUB_COMMAND_GROUP)
    .map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`))
    .join(' ');
}

/**
 * Flatten the registered command tree into one printable line per subcommand.
 * Reading it from the builder means /help can't drift out of step with what
 * Discord actually has.
 */
function helpEntries() {
  const root = `/${config.commandRoot}`;
  const json = rootBuilder.toJSON();
  const entries = [];

  for (const option of json.options || []) {
    if (option.type === SUB_COMMAND) {
      const args = argSignature(option.options);
      entries.push({
        key: option.name,
        line: `\`${root} ${option.name}${args ? ` ${args}` : ''}\` — ${option.description}`,
      });
    } else if (option.type === SUB_COMMAND_GROUP) {
      for (const sub of option.options || []) {
        const args = argSignature(sub.options);
        entries.push({
          key: option.name,
          line: `\`${root} ${option.name} ${sub.name}${args ? ` ${args}` : ''}\` — ${sub.description}`,
        });
      }
    }
  }
  return entries;
}

const help = {
  async execute(interaction) {
    const entries = helpEntries();
    const used = new Set();

    const embed = new EmbedBuilder()
      .setColor(0x1abc9c)
      .setTitle(`${config.commandRoot.toUpperCase()} Bot — Commands`)
      .setDescription(
        `Every command lives under \`/${config.commandRoot}\`. ` +
          `Arguments in \`<>\` are required, \`[]\` are optional.`,
      );

    for (const section of HELP_SECTIONS) {
      const lines = [];
      for (const name of section.names) {
        for (const entry of entries) {
          if (entry.key !== name || used.has(entry.line)) continue;
          used.add(entry.line);
          lines.push(entry.line);
        }
      }
      if (!lines.length) continue;
      let body = lines.join('\n');
      if (body.length > 1024) body = body.slice(0, 1010) + '\n…';
      embed.addFields({ name: section.title, value: body });
    }

    // Safety net: anything not placed in a section above still gets shown.
    const leftovers = entries.filter((e) => !used.has(e.line)).map((e) => e.line);
    if (leftovers.length) {
      embed.addFields({ name: '📦 Other', value: leftovers.join('\n').slice(0, 1024) });
    }

    embed.setFooter({
      text: `${entries.length} commands · new runs by registered members are announced automatically`,
    });
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

// ---------------------------------------------------------------------------
// Everything lives under one parent command (e.g. /sgkz register) so it doesn't
// clash with other bots. Per-subcommand admin gating is done in the handlers
// (requireAdmin), since Discord only supports permissions at the command level.
// ---------------------------------------------------------------------------
// Channels the bot can actually post embeds in.
const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

const modeChoices = (o) =>
  o.addChoices({ name: 'Classic (CKZ)', value: 'ckz' }, { name: 'Vanilla (VNL)', value: 'vnl' });

const rootBuilder = new SlashCommandBuilder()
  .setName(config.commandRoot)
  .setDescription('CS2KZ tracker — records, rankings, ranks, maps & bounties.')
  .setDMPermission(false)
  .addSubcommand((s) =>
    s
      .setName('register')
      .setDescription('Link your SteamID so the bot tracks your CS2KZ records.')
      .addStringOption((o) =>
        o
          .setName('steamid')
          .setDescription('SteamID64, STEAM_1:0:…, [U:1:…], or steamcommunity.com/profiles/… link')
          .setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('unregister')
      .setDescription('Stop tracking your records and leave the leaderboard.')
      .addUserOption((o) => o.setName('user').setDescription("(Admin) Remove another member's registration")),
  )
  .addSubcommand((s) =>
    s
      .setName('rankings')
      .setDescription('Leaderboard of registered members (CKZ or VNL).')
      .addStringOption((o) => modeChoices(o.setName('mode').setDescription('Which rating to rank by'))),
  )
  .addSubcommand((s) =>
    s
      .setName('unfinished')
      .setDescription("Maps of a tier you haven't finished yet (PRO/TP).")
      .addStringOption((o) =>
        o
          .setName('tier')
          .setDescription('Difficulty tier, or All')
          .setRequired(true)
          .addChoices(
            { name: 'All tiers', value: 'all' },
            ...TIERS.map((t) => ({ name: tierLabel(t), value: t })),
          ),
      )
      .addStringOption((o) =>
        o
          .setName('type')
          .setDescription('PRO (no teleports), TP (teleports allowed), or both (default)')
          .addChoices(
            { name: 'Both', value: 'both' },
            { name: 'PRO · no teleports', value: 'pro' },
            { name: 'TP · teleports allowed', value: 'tp' },
          ),
      )
      .addStringOption((o) => modeChoices(o.setName('mode').setDescription('Mode (default: server default)')))
      .addUserOption((o) => o.setName('user').setDescription('Whose completions to check (default: you)')),
  )
  .addSubcommand((s) =>
    s
      .setName('profile')
      .setDescription("A member's CS2KZ profile and tier completion.")
      .addUserOption((o) => o.setName('user').setDescription('Whose profile (defaults to you)'))
      .addStringOption((o) => modeChoices(o.setName('mode').setDescription('Mode for the completion table'))),
  )
  .addSubcommand((s) =>
    s
      .setName('finished')
      .setDescription('Maps of a tier you HAVE finished, with your times (PRO/TP).')
      .addStringOption((o) =>
        o
          .setName('tier')
          .setDescription('Difficulty tier, or All')
          .setRequired(true)
          .addChoices(
            { name: 'All tiers', value: 'all' },
            ...TIERS.map((t) => ({ name: tierLabel(t), value: t })),
          ),
      )
      .addStringOption((o) =>
        o
          .setName('type')
          .setDescription('PRO (no teleports), TP (teleports allowed), or both (default)')
          .addChoices(
            { name: 'Both', value: 'both' },
            { name: 'PRO · no teleports', value: 'pro' },
            { name: 'TP · teleports allowed', value: 'tp' },
          ),
      )
      .addStringOption((o) => modeChoices(o.setName('mode').setDescription('Mode (default: server default)')))
      .addUserOption((o) => o.setName('user').setDescription('Whose completions to show (default: you)')),
  )
  .addSubcommand((s) =>
    s
      .setName('maplists')
      .setDescription('Every CS2KZ map, grouped by tier.')
      .addStringOption((o) =>
        o
          .setName('tier')
          .setDescription('Show only one tier')
          .addChoices(...TIERS.map((t) => ({ name: tierLabel(t), value: t }))),
      )
      .addStringOption((o) =>
        o
          .setName('type')
          .setDescription('Which tier rating to group by (default: TP)')
          .addChoices(
            { name: 'TP · teleports allowed', value: 'tp' },
            { name: 'PRO · no teleports', value: 'pro' },
          ),
      )
      .addStringOption((o) => modeChoices(o.setName('mode').setDescription('Mode (default: server default)'))),
  )
  .addSubcommand((s) =>
    s
      .setName('maptop')
      .setDescription("This server's ranking on a map, with each run's global rank.")
      .addStringOption((o) =>
        o.setName('map').setDescription('Map name, e.g. kz_grotto').setRequired(true),
      )
      .addStringOption((o) =>
        o.setName('course').setDescription('Course name (default: Main)'),
      )
      .addStringOption((o) =>
        o
          .setName('type')
          .setDescription('PRO only, or any completion (default: any)')
          .addChoices(
            { name: 'Any · teleports allowed', value: 'tp' },
            { name: 'PRO · no teleports', value: 'pro' },
          ),
      )
      .addStringOption((o) => modeChoices(o.setName('mode').setDescription('Mode (default: server default)'))),
  )
  .addSubcommand((s) => s.setName('ranks').setDescription('Show the CKZ rank ladder and your current rank.'))
  .addSubcommand((s) => s.setName('help').setDescription('How to use the CS2KZ bot.'))
  .addSubcommand((s) =>
    s
      .setName('setchannel')
      .setDescription('(Admin) Set where new-record & rank-up announcements are posted.')
      .addChannelOption((o) => o.setName('channel').setDescription('Announcement channel (defaults to this one)').addChannelTypes(...TEXT_CHANNELS)),
  )
  .addSubcommandGroup((g) =>
    g
      .setName('leaderboard')
      .setDescription('(Admin) Live pinned leaderboard + rank roles.')
      .addSubcommand((s) =>
        s
          .setName('setup')
          .setDescription('Post & pin the live leaderboard, and create rank roles.')
          .addChannelOption((o) => o.setName('channel').setDescription('Where to post it (default: this channel)').addChannelTypes(...TEXT_CHANNELS)),
      )
      .addSubcommand((s) =>
        s.setName('refresh').setDescription('Update the leaderboard and rank roles right now.'),
      ),
  )
  .addSubcommandGroup((g) =>
    g
      .setName('bounty')
      .setDescription('Map bounties — first registered member to beat the map wins.')
      .addSubcommand((s) =>
        s
          .setName('add')
          .setDescription('(Admin) Create a bounty.')
          .addStringOption((o) => o.setName('map').setDescription('Map name, e.g. kz_grotto').setRequired(true))
          .addStringOption((o) => o.setName('reward').setDescription('The reward, e.g. $10').setRequired(true))
          .addStringOption((o) => o.setName('course').setDescription('Specific course (default: Main)'))
          .addStringOption((o) => modeChoices(o.setName('mode').setDescription('Require a mode (optional)')))
          .addStringOption((o) =>
            o
              .setName('type')
              .setDescription('Require PRO (0 teleports) or allow TP')
              .addChoices(
                { name: 'PRO — 0 teleports', value: 'pro' },
                { name: 'TP — teleports allowed', value: 'tp' },
              ),
          )
          .addStringOption((o) => o.setName('note').setDescription('Extra note (optional)')),
      )
      .addSubcommand((s) => s.setName('list').setDescription('Show active and recently claimed bounties.'))
      .addSubcommand((s) =>
        s
          .setName('remove')
          .setDescription('(Admin) Cancel a bounty.')
          .addStringOption((o) => o.setName('id').setDescription('Bounty id from the list').setRequired(true)),
      ),
  );

const subHandlers = { register, unregister, rankings, unfinished, finished, profile, ranks, help, setchannel, maplists, maptop };

async function rootExecute(interaction) {
  const group = interaction.options.getSubcommandGroup(false);
  if (group === 'leaderboard') return leaderboard.execute(interaction);
  if (group === 'bounty') return bounty.execute(interaction);
  const handler = subHandlers[interaction.options.getSubcommand()];
  if (handler) return handler.execute(interaction);
  return undefined;
}

/** Router keyed by the parent command name, used by the interaction handler. */
export const commands = { [config.commandRoot]: { execute: rootExecute } };

/** Array of command JSON, used by the deploy script. */
export function commandData() {
  return [rootBuilder.toJSON()];
}
