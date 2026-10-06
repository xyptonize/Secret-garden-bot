import { Client, GatewayIntentBits, Events, MessageFlags, Partials, REST, Routes } from 'discord.js';
import { config } from './config.js';
import * as kzApi from './kzApi.js';
import * as store from './store.js';
import { commands as kzCommands, handleComponent, handleAutocomplete } from './commands.js';
import { birthdayCommands, startBirthdayScheduler } from './birthday.js';
import {
  draftCommands,
  handleDraftButton,
  isDraftButton,
  repostDeletedLobby,
  dropLobbiesInChannel,
  onChannelMessage,
  reconcileLobbies,
} from './draft.js';
import { contactCommands } from './contacts.js';
import { caseCommands, isCaseComponent, handleCaseComponent, handleCaseAutocomplete } from './cases.js';
import { countCommands, onCountingMessage } from './counting.js';
import {
  casinoCommands,
  isCasinoComponent,
  handleCasinoComponent,
  handleCasinoAutocomplete,
  refundInterruptedGames,
} from './casino.js';
import { profileCommands, isProfileButton, isProfileModal, handleProfileButton, handleProfileModal } from './profile.js';
import { startAnnouncer } from './announcer.js';
import { startLeaderboardUpdater } from './leaderboard.js';

store.load();
// A mines or blackjack game interrupted by a restart has already paid its
// stake: give it back rather than swallow it.
refundInterruptedGames();

// One router for every sg*** command root (/sgkz, /sghb, …).
const commands = { ...kzCommands, ...birthdayCommands, ...draftCommands, ...contactCommands, ...profileCommands, ...caseCommands, ...casinoCommands, ...countCommands };

/**
 * /sgcount has to read the numbers people type, which needs the Message Content
 * privilege — a switch in the Developer Portal, not something a bot can grant
 * itself. Asking the gateway for an intent the application does not hold gets
 * the connection refused outright and the bot would never start, so ask the API
 * what we actually have before connecting. If the check itself fails, assume we
 * don't have it: a counting round that doesn't run beats a bot that doesn't.
 */
async function canReadMessageContent() {
  const MESSAGE_CONTENT = (1n << 18n) | (1n << 19n); // full, or limited
  try {
    const app = await new REST({ version: '10' }).setToken(config.token).get(Routes.currentApplication());
    return Boolean(BigInt(app.flags || 0) & MESSAGE_CONTENT);
  } catch (err) {
    console.error('Could not check the application privileges, starting without Message Content:', err.message);
    return false;
  }
}

const readsContent = await canReadMessageContent();
if (!readsContent) {
  console.warn(
    `⚠️  Message Content is off, so /${config.countRoot} cannot read typed numbers.\n` +
      '   Turn it on at https://discord.com/developers/applications → your app → Bot →\n' +
      '   Privileged Gateway Intents → Message Content Intent, then restart the bot.',
  );
}

// GuildMessages (not privileged) + partial messages: /sgdraft needs to hear
// about new messages (to keep lobbies at the bottom) and deleted ones. Message
// content is only read when the privilege above is actually granted.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    ...(readsContent ? [GatewayIntentBits.MessageContent] : []),
  ],
  partials: [Partials.Message],
});

// A deleted lobby message is re-posted (only the host closes a lobby). A deleted
// channel/thread ends its lobbies. Channel deletes send no per-message events.
client.on(Events.MessageDelete, (message) => repostDeletedLobby(message.id, client));
client.on(Events.MessageBulkDelete, (messages) => messages.forEach((m) => repostDeletedLobby(m.id, client)));
// Chat in a lobby's channel: move the lobby back to the bottom.
client.on(Events.MessageCreate, (message) => {
  onChannelMessage(message);
  if (readsContent) onCountingMessage(message, client);
});
client.on(Events.ChannelDelete, (channel) => {
  dropLobbiesInChannel(channel.id, channel.guildId);
  channel.threads?.cache.forEach((thread) => dropLobbiesInChannel(thread.id, channel.guildId));
});
client.on(Events.ThreadDelete, (thread) => dropLobbiesInChannel(thread.id, thread.guildId));
// discord.js only emits ThreadDelete for cached threads; archived ones aren't cached.
client.on(Events.Raw, (packet) => {
  if (packet.t === 'THREAD_DELETE') dropLobbiesInChannel(packet.d.id, packet.d.guild_id);
});

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}${readsContent ? ' (reading message content)' : ''}`);
  startAnnouncer(client);
  startLeaderboardUpdater(client);
  startBirthdayScheduler(client);
  reconcileLobbies(client).catch((err) => console.error('Draft lobby reconcile failed:', err.message));
  // Warm the map list so the first autocomplete after a restart is instant.
  kzApi.getAllMaps().catch((err) => console.error('Could not pre-load the map list:', err.message));
});

client.on(Events.InteractionCreate, async (interaction) => {
  // Map/course suggestions while typing — must answer within 3 seconds.
  if (interaction.isAutocomplete()) {
    try {
      if (interaction.commandName === config.caseRoot) await handleCaseAutocomplete(interaction);
      else if (interaction.commandName === config.casinoRoot) await handleCasinoAutocomplete(interaction);
      else await handleAutocomplete(interaction);
    } catch (err) {
      console.error('Autocomplete failed:', err.message);
    }
    return;
  }

  // Buttons and menus: draft lobbies, and page buttons on paginated replies (e.g. /unfinished).
  // Pop-up forms from the profile card.
  if (interaction.isModalSubmit()) {
    if (isProfileModal(interaction)) {
      try {
        await handleProfileModal(interaction);
      } catch (err) {
        console.error('Profile form failed:', err);
      }
    }
    return;
  }

  if (interaction.isButton() && isProfileButton(interaction)) {
    try {
      await handleProfileButton(interaction);
    } catch (err) {
      console.error('Profile button failed:', err);
    }
    return;
  }

  if (interaction.isButton() || interaction.isAnySelectMenu()) {
    try {
      if (isCaseComponent(interaction)) await handleCaseComponent(interaction);
      else if (isCasinoComponent(interaction)) await handleCasinoComponent(interaction);
      else if (isDraftButton(interaction)) await handleDraftButton(interaction);
      else await handleComponent(interaction);
    } catch (err) {
      console.error('Component handler failed:', err);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = commands[interaction.commandName];
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`Error handling /${interaction.commandName}:`, err);
    const message = '⚠️ Something went wrong running that command. Please try again.';
    if (interaction.deferred || interaction.replied) {
      interaction.editReply(message).catch(() => {});
    } else {
      interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

// Without a listener, an 'error' event from the client crashes the process.
client.on(Events.Error, (err) => console.error('Discord client error:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

client.login(config.token);
