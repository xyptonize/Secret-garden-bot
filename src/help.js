// /sghelp — what each part of the bot does, and how to drive it.
//
// The prose is written by hand, because "what happens if two people type the
// same number" is not something a command definition can tell you. The command
// lists underneath are generated from the real slash-command definitions, so
// they can never drift from what is actually registered.

import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { config } from './config.js';
import { commandData } from './commands.js';
import { birthdayCommandData } from './birthday.js';
import { draftCommandData } from './draft.js';
import { contactCommandData } from './contacts.js';
import { profileCommandData } from './profile.js';
import { caseCommandData } from './cases.js';
import { casinoCommandData } from './casino.js';
import { countCommandData } from './counting.js';
import { alarmCommandData } from './alarms.js';

const SUB = 1;
const GROUP = 2;

/** Every registered command, by name, straight from its own definition. */
function definitions() {
  const all = [
    ...commandData(),
    ...birthdayCommandData(),
    ...draftCommandData(),
    ...contactCommandData(),
    ...profileCommandData(),
    ...caseCommandData(),
    ...casinoCommandData(),
    ...countCommandData(),
    ...alarmCommandData(),
  ];
  return new Map(all.map((c) => [c.name, c]));
}
const DEFS = definitions();

const args = (options = []) =>
  options
    .filter((o) => o.type !== SUB && o.type !== GROUP)
    .map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`))
    .join(' ');

/** "`/sgkz register <steamid>` — what it does", for every subcommand. */
function usageLines(name) {
  const def = DEFS.get(name);
  if (!def) return [];
  const subs = (def.options || []).filter((o) => o.type === SUB || o.type === GROUP);
  if (!subs.length) return [`\`/${name} ${args(def.options)}\``.replace(/\s+`$/, '`') + ` — ${def.description}`];
  const lines = [];
  for (const s of subs) {
    if (s.type === GROUP) {
      for (const g of s.options || []) lines.push(`\`/${name} ${s.name} ${g.name} ${args(g.options)}\``.replace(/ +`/, '`') + ` — ${g.description}`);
      continue;
    }
    lines.push(`\`/${name} ${s.name} ${args(s.options)}\``.replace(/ +`/, '`') + ` — ${s.description}`);
  }
  return lines;
}

/** Split the generated list across fields, since one field holds 1024 chars. */
function usageFields(name) {
  const lines = usageLines(name);
  const fields = [];
  let value = '';
  for (const line of lines) {
    if ((value + '\n' + line).length > 1000) {
      fields.push(value);
      value = '';
    }
    value = value ? `${value}\n${line}` : line;
  }
  if (value) fields.push(value);
  return fields.map((v, i) => ({ name: i === 0 ? '⌨️ Every command' : '⌨️ …continued', value: v }));
}

// ---------------------------------------------------------------------------
// The topics
// ---------------------------------------------------------------------------

const R = config;

const TOPICS = {
  [R.commandRoot]: {
    emoji: '🏁',
    title: 'CS2KZ tracker',
    summary:
      'Watches the CS2KZ API for records set by members who have registered, and posts them as they happen — with the run, the points, and where it places both here and worldwide.',
    sections: [
      {
        name: 'Getting started',
        value:
          `**1.** \`/${R.commandRoot} register <steamid>\` — your SteamID64, \`STEAM_1:0:…\`, \`[U:1:…]\` or your profile link.\n` +
          '**2.** That\'s it. New personal bests are announced automatically, usually within a couple of minutes.\n' +
          `**3.** \`/${R.commandRoot} profile\` to see yourself as the bot does.`,
      },
      {
        name: 'Finding maps to play',
        value:
          `\`/${R.commandRoot} unfinished 3\` — every tier-3 course you haven't done.\n` +
          `\`/${R.commandRoot} finished 3\` — the ones you have, with your times.\n` +
          `\`/${R.commandRoot} maptop kz_divert\` — our ranking on a map, each run with its world rank.\n` +
          'Map and course names autocomplete as you type.',
      },
      {
        name: 'Bounties',
        value:
          `An admin posts \`/${R.commandRoot} bounty add\` with a map and a reward. The **first** member to finish it *after* the bounty went up wins — the bot works out who was first by submission time, so it is decided by the run, not by who shouted first.`,
      },
      {
        name: 'Ranks and the leaderboard',
        value:
          `Rank roles (\`${R.rankRolePrefix} …\`) are created and kept up to date automatically, and the pinned leaderboard refreshes every ${Math.round(R.leaderboardIntervalMs / 60000)} minutes. \`/${R.commandRoot} ranks\` shows the ladder.`,
      },
    ],
  },

  [R.draftRoot]: {
    emoji: '🎮',
    title: 'CS2 team drafter',
    summary:
      'Opens a lobby, waits for people to join, then splits them into even teams by AURA and runs a knockout bracket — keeping a permanent record of who played and who won.',
    sections: [
      {
        name: 'Before you can join',
        value:
          `You need a phone number saved — \`/${R.phoneRoot} set\`, 8 digits like \`9911 2233\`. It is how the host reaches the people who signed up.\n` +
          'It stays private: replies about it are only visible to you, it never appears in a channel, and only the owner and developer roles can look it up.',
      },
      {
        name: 'How a night runs',
        value:
          `**1.** \`/${R.draftRoot} start\` — a lobby appears and stays at the bottom of the channel as people chat.\n` +
          '**2.** Everyone presses ✅ **Join**.\n' +
          '**3.** The host presses 🎲 **Draft** and picks how many teams the turnout allows.\n' +
          '**4.** 🏁 **Start bracket**, choose the pairing, then click who won each match.\n' +
          '**5.** The champions are announced and the whole thing is saved forever.',
      },
      {
        name: 'How the teams are decided',
        value:
          '• Every team is balanced on **total AURA** (the number in your role; lower is stronger).\n' +
          '• The strongest players are **split up** — with 4 teams, GOD / KING / 1 / 1.5 each lead a different one.\n' +
          '• 🎀 **Girls are spread evenly** — team counts differ by at most one.\n' +
          '• 🤝 **Friend groups stay together** (host picks them with the Friends button).\n' +
          '• 💤 **Сануулга** holders sit out first when the numbers do not divide evenly — before whoever joined last. Higher tier sits out first.',
      },
      {
        name: 'Host controls 👑',
        value:
          '🔀 **Reshuffle** another fair lineup · ✏️ **Swap** two players by hand\n' +
          '🤝 **Friends** keep 2–5 together · 🔒 **Lock** stop new joins\n' +
          '📣 **Notify** ping and DM the players · 🔁 **Sub** replace someone mid-tournament\n' +
          'Only the host can press these. If a host disappears, an owner or developer can take the lobby over.',
      },
      {
        name: 'Afterwards',
        value:
          `\`/${R.draftRoot} history\` — past tournaments, with page buttons.\n` +
          `\`/${R.draftRoot} game <id>\` — one night in full: teams, every match, every sub.\n` +
          `\`/${R.draftRoot} stats\` · \`/${R.draftRoot} top\` — titles and match records.`,
      },
    ],
  },

  [R.countRoot]: {
    emoji: '🔢',
    title: 'The counting draw',
    summary:
      'We count from 1 upwards in one channel, in order. When the last number is claimed, three members are drawn and win real prizes — revealed third, second, first.',
    sections: [
      {
        name: 'How to take part',
        value:
          'Type the **next number** in the counting channel. If it is yours, you get a ✅ and that number is your ticket. Type anything else and it does not count.\n' +
          `You may claim **${R.countDailyLimit} numbers a day**. Every number you hold is a ticket, so counting often is worth more.`,
      },
      {
        name: 'Strikes ⚠️',
        value:
          `You get **${R.countStrikes} strikes** per round. One costs you if you:\n` +
          '• type a number that is not the next one,\n' +
          '• are beaten to a number by somebody faster (yes, lag counts),\n' +
          '• write anything that is not a number — the channel is numbers only.\n' +
          `**${R.countStrikes} strikes and you are out of the round:** you cannot count any more, and the numbers you already hold cannot win. If one of them is drawn anyway, that prize is **lost**, not passed on.`,
      },
      {
        name: 'The draw',
        value:
          'Three members are drawn when the range fills. The first drawn takes **3rd**, then **2nd**, and the last one drawn takes **1st** — so the biggest prize comes last.\n' +
          'The channel is open only while a round is running, and closes again as soon as it is drawn.',
      },
      {
        name: 'Checking on it',
        value:
          `\`/${R.countRoot} status\` — the next number and how far along we are\n` +
          `\`/${R.countRoot} me\` — the numbers you hold · \`/${R.countRoot} top\` — who holds the most\n` +
          `\`/${R.countRoot} strikes\` — who has strikes and why · \`/${R.countRoot} history\` — past rounds`,
      },
    ],
  },

  [R.caseRoot]: {
    emoji: '🎁',
    title: 'Profile-card backgrounds',
    summary:
      `The picture behind your \`/${R.profileRoot}\` card is unlocked from Garden Cases, on the same odds as a CS2 case. 22 designs across five rarities, all drawn by the bot.`,
    sections: [
      {
        name: 'The odds',
        value:
          '🔵 Mil-Spec **79.92%** · 🟣 Restricted **15.98%** · 🩷 Classified **3.20%** · 🔴 Covert **0.64%** · 🟡 Exceedingly Rare **0.26%**\n' +
          'Pull a Covert or better and the whole channel hears about it. Rolls use a cryptographic random source.',
      },
      {
        name: 'Getting cases',
        value:
          `📅 \`/${R.caseRoot} daily\` — one free every day, plus 🌱 seeds (more on a streak)\n` +
          `🏁 **Playing KZ** — ${Math.round(R.caseDropChance * 100)}% chance per announced record, up to ${R.caseDropDailyCap} a day\n` +
          `🏆 **Winning a draft** — one to every champion\n` +
          `🌱 \`/${R.caseRoot} buy\` — ${R.casePrice} seeds each; duplicates pay seeds back`,
      },
      {
        name: 'Wearing one',
        value:
          `A background rarer than the one you are wearing equips itself. Otherwise \`/${R.caseRoot} inventory\` shows your collection and lets you pick. \`/${R.caseRoot} preview\` looks at any design, owned or not.`,
      },
    ],
  },

  [R.casinoRoot]: {
    emoji: '🎲',
    title: 'The casino',
    summary:
      'Wager the 🌱 seeds you earn from cases. The house takes nothing: every payout is the exact inverse of its chance, so seeds only move between members.',
    sections: [
      {
        name: 'Playing against the bot',
        value:
          '🪙 **flip** — 50/50 to double\n' +
          '🎲 **dice** — roll 1–100, call over or under. Over 60 pays 2.50×, under 25 pays 4×\n' +
          '🎰 **slots** — pair 2× · triple 11× · 🟡🟡🟡 **25×**\n' +
          '💣 **mines** — reveal safe tiles, cash out before a bomb. Clear 20 tiles on 1 bomb for **20×**\n' +
          '🃏 **blackjack** — 3:2, dealer draws to 17',
      },
      {
        name: 'Playing against each other',
        value:
          '⚔️ **duel** — both stake the same, one flip, winner takes the pot.\n' +
          `🏆 **bet** — back a team in a live \`/${R.draftRoot}\` match. Everything staked goes into one pot and the backers of the winning team split it in proportion. Cancelled bracket or closed lobby means a full refund, and **nobody playing in a match may bet on it** — either way.`,
      },
      {
        name: 'Limits',
        value:
          `Stakes run ${R.casinoMinBet}–${R.casinoMaxBet.toLocaleString('en-US')} 🌱. Lose ${R.casinoDailyLossCap.toLocaleString('en-US')} in a day and the bot stops taking your bets until tomorrow — that one is there on purpose.`,
      },
    ],
  },

  [R.alarmRoot]: {
    emoji: '⏰',
    title: 'Reminders',
    summary:
      'Set an alarm and the bot reminds you twice over — a message in the channel **and** a DM — so a closed DM or a deleted channel is not the reason you miss it.',
    sections: [
      {
        name: 'How to say when',
        value:
          '`30m` · `2h` · `1h30m` · `3d` · `2 weeks` · `in 45 minutes` — that long from now\n' +
          '`21:00` · `9pm` — today, or tomorrow if that has passed\n' +
          '`tomorrow 09:00` · `today 18:30`\n' +
          '`25/12 18:00` · `2027-03-14 21:00`\n' +
          `All read in ${R.alarmTimeZone}. Anything it cannot read, it refuses rather than guessing.`,
      },
      {
        name: 'Repeating',
        value:
          '`repeat: Every day` or `Every week` keeps it going. One missed while the bot was down rings once and then skips to the next future slot — a week offline does not give you seven.',
      },
    ],
  },

  [R.profileRoot]: {
    emoji: '👤',
    title: 'Your profile card',
    summary:
      'Everything the bot knows about a member on one card: avatar and stats drawn over your unlocked background, plus Discord standing, saved contacts, live CS2KZ ratings with your world position, and your draft record.',
    sections: [
      {
        name: 'Filling it in',
        value:
          'On **your own** card there are buttons for anything missing — birthday, Instagram, Steam, phone. **Use my KZ Steam** copies the account you already registered in one click.',
      },
      {
        name: 'Privacy',
        value:
          'A saved phone number never appears on the card — only the words "Saved — private". Everything else on it is already public in the server.',
      },
    ],
  },

  [R.birthdayRoot]: {
    emoji: '🎂',
    title: 'Birthdays',
    summary: `Save your birthday and the bot posts in the birthday channel on the day, at ${String(R.birthdayHour).padStart(2, '0')}:00 ${R.birthdayTimeZone}.`,
    sections: [
      {
        name: 'Notes',
        value:
          'The year is optional and only used to show your age. Leave the year box empty when changing your date and a year you saved before is kept.\n' +
          '29 February is celebrated on the 28th in years that do not have one.',
      },
    ],
  },

  [R.igRoot]: {
    emoji: '📸',
    title: 'Saved contacts',
    summary: `\`/${R.igRoot}\` for Instagram and \`/${R.steamRoot}\` for Steam are public — anyone can look them up. \`/${R.phoneRoot}\` is private.`,
    sections: [
      {
        name: 'Phone numbers',
        value:
          'Every reply is private, so a number never appears in a channel. You can always see your own; only the owner and developer roles can look anyone else up or list them.\n' +
          'Numbers take 8 digits (`9911 2233`) or any international number starting with `+`.',
      },
    ],
  },
};
TOPICS[R.steamRoot] = TOPICS[R.igRoot];
TOPICS[R.phoneRoot] = TOPICS[R.igRoot];

const ALIASES = {
  kz: R.commandRoot, cs2kz: R.commandRoot, records: R.commandRoot,
  draft: R.draftRoot, teams: R.draftRoot, drafter: R.draftRoot,
  count: R.countRoot, counting: R.countRoot, numbers: R.countRoot,
  case: R.caseRoot, cases: R.caseRoot, backgrounds: R.caseRoot,
  casino: R.casinoRoot, gamble: R.casinoRoot, seeds: R.casinoRoot, bet: R.casinoRoot,
  alarm: R.alarmRoot, reminder: R.alarmRoot, reminders: R.alarmRoot,
  profile: R.profileRoot, card: R.profileRoot,
  birthday: R.birthdayRoot, birthdays: R.birthdayRoot, hb: R.birthdayRoot,
  contacts: R.igRoot, instagram: R.igRoot, ig: R.igRoot, steam: R.steamRoot, phone: R.phoneRoot,
};

const resolve = (input) => {
  const key = String(input ?? '').trim().toLowerCase().replace(/^\//, '');
  return TOPICS[key] ? key : TOPICS[ALIASES[key]] ? ALIASES[key] : null;
};

// ---------------------------------------------------------------------------

function overview() {
  const line = (root) => {
    const t = TOPICS[root];
    return `${t.emoji} **\`/${root}\`** — ${t.title}`;
  };
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🤖 SG-BOT')
    .setDescription(
      'Everything the bot does, one command root at a time.\n' +
        `Ask for details with **\`/sghelp ${R.draftRoot}\`**, or any of these:\n\n` +
        [R.commandRoot, R.draftRoot, R.countRoot, R.caseRoot, R.casinoRoot, R.profileRoot, R.alarmRoot, R.birthdayRoot, R.igRoot]
          .map(line)
          .join('\n'),
    )
    .setFooter({ text: 'Type / in any channel and Discord will show the options as you type.' });
}

function topicEmbed(root) {
  const t = TOPICS[root];
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${t.emoji} /${root} — ${t.title}`)
    .setDescription(t.summary);
  for (const s of t.sections) embed.addFields({ name: s.name, value: s.value.slice(0, 1024) });
  for (const f of usageFields(root)) embed.addFields(f);
  embed.setFooter({ text: `/sghelp for everything else · 🔒 = admins only` });
  return embed;
}

async function execute(interaction) {
  const asked = interaction.options.getString('topic');
  const root = asked ? resolve(asked) : null;
  if (asked && !root) {
    return interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: `I have no help for **${asked}**. Try \`/sghelp\` on its own to see what there is.`,
    });
  }
  const isPublic = interaction.options.getBoolean('public') ?? false;
  return interaction.reply({
    embeds: [root ? topicEmbed(root) : overview()],
    ...(isPublic ? {} : { flags: MessageFlags.Ephemeral }),
  });
}

export async function handleHelpAutocomplete(interaction) {
  const typed = String(interaction.options.getFocused() ?? '').toLowerCase();
  const choices = Object.keys(TOPICS)
    .filter((root, i, list) => list.indexOf(root) === i)
    .map((root) => ({ name: `/${root} — ${TOPICS[root].title}`.slice(0, 100), value: root }))
    .filter((c) => !typed || c.name.toLowerCase().includes(typed) || c.value.includes(typed))
    .slice(0, 25);
  return interaction.respond(choices).catch(() => {});
}

const data = new SlashCommandBuilder()
  .setName('sghelp')
  .setDescription('What each part of SG-BOT does, and how to use it.')
  .setDMPermission(false)
  .addStringOption((o) => o.setName('topic').setDescription('Which command to explain (e.g. sgdraft)').setAutocomplete(true))
  .addBooleanOption((o) => o.setName('public').setDescription('Post it in the channel instead of just to you'));

export const helpCommands = { sghelp: { execute } };
export function helpCommandData() {
  return [data.toJSON()];
}
