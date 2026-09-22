// /sgcase — profile-card backgrounds, unboxed like CS2 skins.
//
// Cases come from four places: a free one every day, drops for playing (KZ
// records and tournament wins), admin grants, and buying with 🌱 seeds. Opening
// one rolls a background on CS2's own odds; a duplicate converts to seeds, which
// buy more cases.
//
// The roll is decided and saved BEFORE the reveal is animated — a crash or a
// Discord hiccup mid-reveal must never cost someone their unboxing.

import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  AttachmentBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import { randomInt } from 'node:crypto';
import { config } from './config.js';
import * as store from './store.js';
import {
  BACKGROUNDS,
  RARITIES,
  rarityOf,
  rarityRank,
  backgroundById,
  backgroundsOf,
  DEFAULT_BACKGROUND,
} from './cardArt.js';
import { renderBackground, renderCollection } from './cards.js';

const PREFIX = 'sgc|';
const SEED = '🌱';
const BOX = '🎁';
const CASE_NAME = 'Garden Case';
// Rarer than this and the whole channel hears about it, CS2-style.
const BRAG_FROM = rarityRank('covert');

const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
// Who is mid-reveal. A button press is acknowledged before the animation ends,
// so an impatient double-click would otherwise spend a second case whose reveal
// is immediately overwritten by the first.
const opening = new Set();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------------------
// Days, rolls, and the collection itself
// ---------------------------------------------------------------------------

/** Today's date in the configured timezone, as YYYY-MM-DD. */
function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.caseTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const dayBefore = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
};

const profileOf = (guildId, userId) => store.getCardProfile(guildId, userId, DEFAULT_BACKGROUND);

/** A read-only stand-in for someone who has never opened a case. */
const blankProfile = () => ({ owned: { [DEFAULT_BACKGROUND]: 1 }, equipped: DEFAULT_BACKGROUND, seeds: 0, cases: 0, opened: 0, streak: 0 });

/** A fair float in [0,1) — crypto, so nobody can argue about the odds. */
const roll = () => randomInt(0, 1_000_000) / 1_000_000;

/** One unboxing: a rarity on CS2's odds, then a background within it. */
export function rollBackground() {
  const r = roll();
  let acc = 0;
  let tier = RARITIES[0];
  for (const rarity of RARITIES) {
    acc += rarity.odds;
    if (r < acc) {
      tier = rarity;
      break;
    }
  }
  // A tier with no artwork must never swallow a roll: fall back down the list.
  let pool = backgroundsOf(tier.key);
  for (let i = rarityRank(tier.key) - 1; !pool.length && i >= 0; i--) {
    tier = RARITIES[i];
    pool = backgroundsOf(tier.key);
  }
  return pool[randomInt(0, pool.length)];
}

/** How many of the collection someone has, per rarity and overall. */
function progress(owned) {
  const per = RARITIES.map((r) => {
    const all = backgroundsOf(r.key);
    return { rarity: r, have: all.filter((b) => owned[b.id]).length, total: all.length };
  });
  return { per, have: per.reduce((a, p) => a + p.have, 0), total: BACKGROUNDS.length };
}

/**
 * Open one case: takes the case, saves the result, and reports what happened.
 * Returns null when they have none.
 */
function openCase(guildId, userId) {
  const p = profileOf(guildId, userId);
  if ((p.cases || 0) < 1) return null;
  const bg = rollBackground();
  const duplicate = Boolean(p.owned[bg.id]);
  const rarity = rarityOf(bg.rarity);
  const seeds = duplicate ? rarity.dupe : 0;

  p.cases -= 1;
  p.opened = (p.opened || 0) + 1;
  p.owned[bg.id] = (p.owned[bg.id] || 0) + 1;
  p.seeds = (p.seeds || 0) + seeds;
  // First one of its kind, and better than what they're wearing: wear it.
  const equipped = !duplicate && rarityRank(bg.rarity) > rarityRank(backgroundById(p.equipped)?.rarity ?? 'milspec');
  if (equipped) p.equipped = bg.id;
  store.persist();
  return { bg, rarity, duplicate, seeds, left: p.cases, equipped };
}

/**
 * A drop for playing: a chance at a case per announced KZ record, capped per
 * day so a long session can't print them. Returns true when one dropped.
 */
export function maybeDropCase(guildId, userId) {
  if (!config.caseDropChance || !config.caseDropDailyCap) return false;
  const p = profileOf(guildId, userId);
  const day = today();
  if (p.dropDate !== day) {
    p.dropDate = day;
    p.dropCount = 0;
  }
  if (p.dropCount >= config.caseDropDailyCap) return false;
  if (roll() >= config.caseDropChance) return false;
  p.dropCount += 1;
  p.cases = (p.cases || 0) + 1;
  store.persist();
  return true;
}

/** Champions' reward, handed to every player on the winning team. */
export function awardChampions(guildId, userIds) {
  const each = config.caseChampionCases;
  if (!each) return 0;
  for (const id of userIds) {
    if (!id || String(id).startsWith('mock')) continue; // test players own nothing
    const p = profileOf(guildId, id);
    p.cases = (p.cases || 0) + each;
  }
  store.persist();
  return each;
}

/** The background a member's card should use (no write, so viewing costs nothing). */
export function equippedBackground(guildId, userId) {
  const p = store.getCardProfiles(guildId)[userId];
  const id = p?.equipped;
  return backgroundById(id) ? id : DEFAULT_BACKGROUND;
}

/** Card buttons for someone's own /sgprofile: collection, daily, open. */
export function profileCardRow(guildId, userId) {
  const p = store.getCardProfiles(guildId)[userId];
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}inv|${userId}`).setLabel('Backgrounds').setEmoji('🎒').setStyle(ButtonStyle.Secondary),
  );
  if (p?.lastDaily !== today()) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}daily|${userId}`).setLabel('Daily case').setEmoji('📅').setStyle(ButtonStyle.Success),
    );
  }
  if ((p?.cases || 0) > 0) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}open|${userId}`).setLabel(`Open (${p.cases})`).setEmoji(BOX).setStyle(ButtonStyle.Primary),
    );
  }
  return row;
}

/** Their card wallet, for the /sgprofile footer — null when they've never played. */
export function walletOf(guildId, userId) {
  const p = store.getCardProfiles(guildId)[userId];
  if (!p) return null;
  const { have, total } = progress(p.owned || {});
  return { seeds: p.seeds || 0, cases: p.cases || 0, have, total, opened: p.opened || 0 };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const file = (buffer, name) => new AttachmentBuilder(buffer, { name });

function revealEmbed({ bg, rarity, duplicate, seeds, left, equipped }) {
  return new EmbedBuilder()
    .setColor(rarity.color)
    .setTitle(`${rarity.emoji} ${bg.name}`)
    .setDescription(
      [
        `**${rarity.name}** · ${(rarity.odds * 100).toFixed(2)}% chance`,
        duplicate
          ? `♻️ Duplicate — traded in for **${seeds}** ${SEED} seeds.`
          : `✨ **New background!**${equipped ? ' Equipped' : ' Wear it from your inventory'} — run \`/${config.profileRoot}\` to see your card.`,
      ].join('\n'),
    )
    .setImage(`attachment://${bg.id}.png`)
    .setFooter({ text: `${plural(left, CASE_NAME.toLowerCase())} left · /${config.caseRoot} inventory` });
}

function revealButtons(userId, bgId, left) {
  const row = new ActionRowBuilder();
  if (left > 0) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}open|${userId}`).setLabel(`Open another (${left})`).setEmoji(BOX).setStyle(ButtonStyle.Primary),
    );
  }
  row.addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}equip|${userId}|${bgId}`).setLabel('Equip this').setEmoji('🖼️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PREFIX}inv|${userId}`).setLabel('Inventory').setEmoji('🎒').setStyle(ButtonStyle.Secondary),
  );
  return [row];
}

/** The equip menu: everything they own, best first. */
function equipRow(guildId, userId) {
  const p = profileOf(guildId, userId); // own collection only — see inventoryView
  const owned = BACKGROUNDS.filter((b) => p.owned[b.id])
    .sort((a, b) => rarityRank(b.rarity) - rarityRank(a.rarity) || a.name.localeCompare(b.name))
    .slice(0, 25);
  if (owned.length < 2) return [];
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}wear|${userId}`)
    .setPlaceholder('Choose your card background')
    .addOptions(
      owned.map((b) => ({
        label: b.name.slice(0, 100),
        value: b.id,
        description: `${rarityOf(b.rarity).name}${p.owned[b.id] > 1 ? ` · ×${p.owned[b.id]}` : ''}`.slice(0, 100),
        emoji: rarityOf(b.rarity).emoji,
        default: p.equipped === b.id,
      })),
    );
  return [new ActionRowBuilder().addComponents(menu)];
}

async function inventoryView(guildId, user, { own = true } = {}) {
  // Looking someone up must not create a collection for them: that would put a
  // row in the store (and a 🎒 Cards line on their /sgprofile) for a member who
  // has never touched the feature.
  const p = own ? profileOf(guildId, user.id) : store.getCardProfiles(guildId)[user.id] || blankProfile();
  const { per, have, total } = progress(p.owned);
  const equipped = backgroundById(p.equipped) || backgroundById(DEFAULT_BACKGROUND);
  const claimed = p.lastDaily === today();

  // Drawn first: if it fails, the inventory still answers, just without a picture.
  let sheet = null;
  try {
    sheet = file(await renderCollection(p.owned), 'collection.png');
  } catch (err) {
    console.error(`Collection sheet failed: ${err.message}`);
  }

  const embed = new EmbedBuilder()
    .setColor(rarityOf(equipped.rarity).color)
    .setTitle(`🎒 ${user.displayName || user.username}'s collection`)
    .setDescription(
      [
        `${BOX} **${p.cases || 0}** ${CASE_NAME.toLowerCase()}(s) · ${SEED} **${p.seeds || 0}** seeds`,
        `🖼️ Wearing **${equipped.name}** (${rarityOf(equipped.rarity).name})`,
        `📦 Opened **${p.opened || 0}** · collected **${have}/${total}**`,
        claimed ? '✅ Daily case claimed today.' : `🎁 Daily case ready — \`/${config.caseRoot} daily\``,
      ].join('\n'),
    )
    .addFields({
      name: 'By rarity',
      value: per
        .map((x) => `${x.rarity.emoji} ${x.rarity.name} — **${x.have}/${x.total}**`)
        .join('\n'),
    })
    .setFooter({ text: `Streak ${p.streak || 0} day(s) · a case costs ${config.casePrice} ${SEED}` });
  if (sheet) embed.setImage('attachment://collection.png');

  // Buttons and the equip menu only exist on your own collection — and building
  // them is itself a write, so they are skipped entirely for a lookup.
  const rows = own ? equipRow(guildId, user.id) : [];
  if (own && ((p.cases || 0) > 0 || !claimed)) {
    const row = new ActionRowBuilder();
    if (!claimed) {
      row.addComponents(
        new ButtonBuilder().setCustomId(`${PREFIX}daily|${user.id}`).setLabel('Claim daily').setEmoji('📅').setStyle(ButtonStyle.Success),
      );
    }
    if ((p.cases || 0) > 0) {
      row.addComponents(
        new ButtonBuilder().setCustomId(`${PREFIX}open|${user.id}`).setLabel(`Open a case (${p.cases})`).setEmoji(BOX).setStyle(ButtonStyle.Primary),
      );
    }
    rows.push(row);
  }
  return { embeds: [embed], components: rows, files: sheet ? [sheet] : [], attachments: [] };
}

// ---------------------------------------------------------------------------
// Opening, with a reveal
// ---------------------------------------------------------------------------

/** A teaser strip of names that aren't the answer, for the spin frames. */
function spinStrip(exclude) {
  const pool = BACKGROUNDS.filter((b) => b.id !== exclude);
  const picks = [];
  for (let i = 0; i < 4; i++) picks.push(pool[randomInt(0, pool.length)]);
  return picks.map((b) => `${rarityOf(b.rarity).emoji} ${b.name}`).join('  ▸  ');
}

/**
 * Open one case and animate the reveal over an already-deferred reply. A Covert
 * or better pull is also posted to the channel, CS2-style.
 */
async function revealOpen(interaction, userId, { updated = false } = {}) {
  const busy = `${interaction.guildId}|${userId}`;
  if (opening.has(busy)) {
    const wait = '⏳ Still opening that one — give it a second.';
    // `updated` means the press was acknowledged by editing the message it sat
    // on, so there is no pending reply to complete and a follow-up is the only
    // way to answer. Otherwise a deferred reply IS pending, and answering with
    // a follow-up would leave it spinning on "thinking…" for good.
    return (updated
      ? interaction.followUp({ flags: MessageFlags.Ephemeral, content: wait })
      : interaction.editReply({ content: wait, embeds: [], components: [], files: [], attachments: [] })
    ).catch(() => {});
  }
  opening.add(busy);
  try {
    return await unbox(interaction, userId);
  } finally {
    opening.delete(busy);
  }
}

async function unbox(interaction, userId) {
  const result = openCase(interaction.guildId, userId);
  if (!result) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x9aa0a6)
          .setTitle(`${BOX} No cases`)
          .setDescription(
            [
              `You have no ${CASE_NAME.toLowerCase()}s right now.`,
              `• \`/${config.caseRoot} daily\` — a free one every day`,
              `• Play KZ and win drafts — they drop while you play`,
              `• \`/${config.caseRoot} buy\` — ${config.casePrice} ${SEED} seeds each`,
            ].join('\n'),
          ),
      ],
      components: [],
      files: [],
      attachments: [], // editing keeps old attachments unless they're cleared
    });
  }

  // The case is already spent and the background already saved; everything from
  // here is just presentation, so a failure can't cost them the item.
  const spinning = new EmbedBuilder().setColor(0x9aa0a6).setTitle(`${BOX} Opening a ${CASE_NAME}…`);
  await interaction
    .editReply({ embeds: [spinning.setDescription(spinStrip(result.bg.id))], components: [], files: [], attachments: [] })
    .catch(() => {});
  await sleep(config.caseRevealMs);
  await interaction
    .editReply({ embeds: [spinning.setTitle(`${BOX} Almost…`).setDescription(spinStrip(result.bg.id))] })
    .catch(() => {});
  await sleep(config.caseRevealMs);

  const image = await renderBackground(result.bg.id);
  await interaction
    .editReply({
      embeds: [revealEmbed(result)],
      components: revealButtons(userId, result.bg.id, result.left),
      files: [file(image, `${result.bg.id}.png`)],
      attachments: [], // replace the previous pull's picture, don't stack on it
    })
    // The pull is already theirs; losing the picture must not look like an error
    // to them, and must not stop a rare pull being announced below.
    .catch((err) => console.error(`Could not show an unboxing (the pull is saved): ${err.message}`));

  // Covert and above: tell the room.
  if (rarityRank(result.bg.rarity) >= BRAG_FROM && interaction.channel) {
    const rarity = result.rarity;
    await interaction.channel
      .send({
        content: `${rarity.emoji} <@${userId}> just unboxed **${result.bg.name}** — *${rarity.name}* (${(rarity.odds * 100).toFixed(2)}%)!`,
        files: [file(image, `${result.bg.id}.png`)], // the same render, not a second one
        allowedMentions: { users: [userId] },
      })
      .catch(() => {});
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function cmdDaily(interaction) {
  const p = profileOf(interaction.guildId, interaction.user.id);
  const day = today();
  if (p.lastDaily === day) {
    return interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: `📅 You've already claimed today's case. Come back tomorrow — streak **${p.streak || 0}** day(s).`,
    });
  }
  p.streak = p.lastDaily === dayBefore(day) ? (p.streak || 0) + 1 : 1;
  p.lastDaily = day;
  p.cases = (p.cases || 0) + 1;
  const bonus = Math.min(config.caseStreakMax, config.caseStreakSeeds * (p.streak - 1));
  const seeds = config.caseDailySeeds + bonus;
  p.seeds = (p.seeds || 0) + seeds;
  store.persist();

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('📅 Daily case claimed')
        .setDescription(
          [
            `${BOX} +1 ${CASE_NAME} · ${SEED} +${seeds} seeds${bonus ? ` (incl. **+${bonus}** streak bonus)` : ''}`,
            `🔥 Streak: **${p.streak}** day(s)`,
            `You now hold ${BOX} **${p.cases}** and ${SEED} **${p.seeds}**.`,
          ].join('\n'),
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${PREFIX}open|${interaction.user.id}`).setLabel('Open it').setEmoji(BOX).setStyle(ButtonStyle.Primary),
      ),
    ],
  });
  return undefined;
}

async function cmdOpen(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return revealOpen(interaction, interaction.user.id);
}

async function cmdInventory(interaction) {
  const user = interaction.options.getUser('user') || interaction.user;
  await interaction.deferReply({ flags: user.id === interaction.user.id ? MessageFlags.Ephemeral : undefined });
  const own = user.id === interaction.user.id;
  const view = await inventoryView(interaction.guildId, user, { own });
  // Someone else's collection is read-only: no buttons that would act as them.
  if (!own) view.components = [];
  return interaction.editReply(view);
}

async function cmdBuy(interaction) {
  const count = interaction.options.getInteger('cases') ?? 1;
  const p = profileOf(interaction.guildId, interaction.user.id);
  const cost = config.casePrice * count;
  if ((p.seeds || 0) < cost) {
    return interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: `${SEED} That costs **${cost}** seeds and you have **${p.seeds || 0}**. Seeds come from duplicates, and from your daily claim.`,
    });
  }
  p.seeds -= cost;
  p.cases = (p.cases || 0) + count;
  store.persist();
  return interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: `${BOX} Bought ${plural(count, CASE_NAME.toLowerCase())} for ${SEED} **${cost}**. You hold ${BOX} **${p.cases}** and ${SEED} **${p.seeds}**.`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${PREFIX}open|${interaction.user.id}`).setLabel('Open one').setEmoji(BOX).setStyle(ButtonStyle.Primary),
      ),
    ],
  });
}

async function cmdOdds(interaction) {
  const lines = RARITIES.slice()
    .reverse()
    .map((r) => {
      const all = backgroundsOf(r.key);
      return `${r.emoji} **${r.name}** — ${(r.odds * 100).toFixed(2)}% · ${all.length} design(s) · duplicate = ${SEED} ${r.dupe}`;
    });
  return interaction.reply({
    flags: MessageFlags.Ephemeral,
    embeds: [
      new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle(`${BOX} ${CASE_NAME} — drop rates`)
        .setDescription(lines.join('\n'))
        .addFields({
          name: 'Where cases come from',
          value: [
            `📅 \`/${config.caseRoot} daily\` — one free every day (+${SEED} ${config.caseDailySeeds}, more on a streak)`,
            `🏁 Playing KZ — ${Math.round(config.caseDropChance * 100)}% chance per announced record (max ${config.caseDropDailyCap}/day)`,
            `🏆 Winning a \`/${config.draftRoot}\` tournament — ${config.caseChampionCases} to every champion`,
            `${SEED} \`/${config.caseRoot} buy\` — ${config.casePrice} seeds each`,
          ].join('\n'),
        })
        .setFooter({ text: 'Same odds as a CS2 case. Rolls use a cryptographic random source.' }),
    ],
  });
}

async function cmdPreview(interaction) {
  const wanted = String(interaction.options.getString('background') || '').toLowerCase();
  const bg =
    backgroundById(wanted) ||
    BACKGROUNDS.find((b) => b.name.toLowerCase() === wanted) ||
    BACKGROUNDS.find((b) => b.name.toLowerCase().includes(wanted));
  if (!bg) {
    return interaction.reply({ flags: MessageFlags.Ephemeral, content: "❌ I don't have a background by that name." });
  }
  const p = profileOf(interaction.guildId, interaction.user.id);
  const rarity = rarityOf(bg.rarity);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const preview = await renderBackground(bg.id, { title: false });
  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(rarity.color)
        .setTitle(`${rarity.emoji} ${bg.name}`)
        .setDescription(
          `**${rarity.name}** · ${(rarity.odds * 100).toFixed(2)}% per case\n${
            p.owned[bg.id] ? `✅ Owned${p.owned[bg.id] > 1 ? ` ×${p.owned[bg.id]}` : ''}` : '🔒 Not unlocked yet'
          }`,
        )
        .setImage(`attachment://${bg.id}.png`),
    ],
    files: [file(preview, `${bg.id}.png`)],
    components: p.owned[bg.id]
      ? [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`${PREFIX}equip|${interaction.user.id}|${bg.id}`)
              .setLabel('Equip this')
              .setEmoji('🖼️')
              .setStyle(ButtonStyle.Primary),
          ),
        ]
      : [],
  });
}

/**
 * Who may hand out cases and seeds. CASE_ADMIN_ID names one member and means
 * exactly that member — an admin with Manage Server does not inherit it.
 */
function canDistribute(interaction) {
  if (config.caseAdminId) return interaction.user.id === config.caseAdminId;
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

async function cmdGive(interaction) {
  if (!canDistribute(interaction)) {
    return interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: config.caseAdminId
        ? `🔒 Only <@${config.caseAdminId}> can hand out cases and seeds.`
        : '🔒 Only admins (Manage Server) can hand out cases.',
      allowedMentions: { parse: [] },
    });
  }
  const user = interaction.options.getUser('user', true);
  const cases = interaction.options.getInteger('cases') ?? 0;
  const seeds = interaction.options.getInteger('seeds') ?? 0;
  if (!cases && !seeds) {
    return interaction.reply({ flags: MessageFlags.Ephemeral, content: 'Give them cases, seeds, or both.' });
  }
  if (user.bot) {
    return interaction.reply({ flags: MessageFlags.Ephemeral, content: "Bots don't collect backgrounds." });
  }
  const p = profileOf(interaction.guildId, user.id);
  p.cases = Math.max(0, (p.cases || 0) + cases);
  p.seeds = Math.max(0, (p.seeds || 0) + seeds);
  store.persist();

  const parts = [];
  if (cases) parts.push(`${BOX} ${cases > 0 ? '+' : ''}${cases} ${CASE_NAME.toLowerCase()}(s)`);
  if (seeds) parts.push(`${SEED} ${seeds > 0 ? '+' : ''}${seeds} seeds`);
  await interaction.reply({
    content: `🎁 <@${user.id}> received ${parts.join(' and ')} from <@${interaction.user.id}>. They now hold ${BOX} **${p.cases}** · ${SEED} **${p.seeds}**.`,
    allowedMentions: { users: [user.id] },
  });
  return undefined;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export const isCaseComponent = (interaction) => Boolean(interaction.customId?.startsWith(PREFIX));

export async function handleCaseComponent(interaction) {
  const [action, ownerId, arg] = interaction.customId.slice(PREFIX.length).split('|');
  if (ownerId !== interaction.user.id) {
    return interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: `That's someone else's — run \`/${config.caseRoot} inventory\` for your own.`,
    });
  }

  if (action === 'open') {
    // The reveal replaces whatever this button was attached to when it's this
    // user's own ephemeral message; otherwise it answers fresh.
    if (interaction.message?.flags?.has(MessageFlags.Ephemeral)) {
      await interaction.deferUpdate();
      return revealOpen(interaction, ownerId, { updated: true });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return revealOpen(interaction, ownerId);
  }

  if (action === 'daily') {
    return cmdDaily(interaction);
  }

  if (action === 'inv') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return interaction.editReply(await inventoryView(interaction.guildId, interaction.user));
  }

  if (action === 'equip' || action === 'wear') {
    const id = action === 'wear' ? interaction.values?.[0] : arg;
    const bg = backgroundById(id);
    const p = profileOf(interaction.guildId, ownerId);
    if (!bg || !p.owned[bg.id]) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: "You don't own that background yet." });
    }
    p.equipped = bg.id;
    store.persist();
    return interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: `🖼️ Equipped **${bg.name}** (${rarityOf(bg.rarity).name}). Run \`/${config.profileRoot}\` to see your card.`,
    });
  }
  return undefined;
}

/** Suggestions for `/sgcase preview background:` — owned ones first. */
export async function handleCaseAutocomplete(interaction) {
  const typed = String(interaction.options.getFocused() ?? '').trim().toLowerCase();
  const owned = store.getCardProfiles(interaction.guildId)[interaction.user.id]?.owned || {};
  const choices = BACKGROUNDS.filter((b) => b.name.toLowerCase().includes(typed) || b.id.includes(typed))
    .sort((a, b) => Boolean(owned[b.id]) - Boolean(owned[a.id]) || rarityRank(a.rarity) - rarityRank(b.rarity))
    .slice(0, 25)
    .map((b) => ({
      name: `${owned[b.id] ? '✅' : '🔒'} ${b.name} — ${rarityOf(b.rarity).name}`.slice(0, 100),
      value: b.id,
    }));
  return interaction.respond(choices).catch(() => {});
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

const HANDLERS = {
  daily: cmdDaily,
  open: cmdOpen,
  inventory: cmdInventory,
  buy: cmdBuy,
  odds: cmdOdds,
  preview: cmdPreview,
  give: cmdGive,
};

async function execute(interaction) {
  const handler = HANDLERS[interaction.options.getSubcommand()];
  if (!handler) return undefined;
  return handler(interaction);
}

const data = new SlashCommandBuilder()
  .setName(config.caseRoot)
  .setDescription('Unlock profile-card backgrounds from cases.')
  .setDMPermission(false)
  .addSubcommand((s) => s.setName('daily').setDescription('Claim your free case for today'))
  .addSubcommand((s) => s.setName('open').setDescription('Open a Garden Case'))
  .addSubcommand((s) =>
    s
      .setName('inventory')
      .setDescription('Your cases, seeds and collection')
      .addUserOption((o) => o.setName('user').setDescription("Someone else's collection")),
  )
  .addSubcommand((s) =>
    s
      .setName('buy')
      .setDescription('Buy cases with seeds')
      .addIntegerOption((o) => o.setName('cases').setDescription('How many (default 1)').setMinValue(1).setMaxValue(25)),
  )
  .addSubcommand((s) => s.setName('odds').setDescription('Drop rates and where cases come from'))
  .addSubcommand((s) =>
    s
      .setName('preview')
      .setDescription('Look at any background')
      .addStringOption((o) => o.setName('background').setDescription('Which one').setRequired(true).setAutocomplete(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('give')
      .setDescription('Hand out cases or seeds (restricted)')
      .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
      .addIntegerOption((o) => o.setName('cases').setDescription('Cases (negative takes them away)').setMinValue(-100).setMaxValue(100))
      .addIntegerOption((o) => o.setName('seeds').setDescription('Seeds (negative takes them away)').setMinValue(-100000).setMaxValue(100000)),
  );

export const caseCommands = { [config.caseRoot]: { execute } };
export function caseCommandData() {
  return [data.toJSON()];
}
