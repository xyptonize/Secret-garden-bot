import { Client, GatewayIntentBits, Events, MessageFlags, Partials } from 'discord.js';
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
import { profileCommands, isProfileButton, isProfileModal, handleProfileButton, handleProfileModal } from './profile.js';
import { startAnnouncer } from './announcer.js';
import { startLeaderboardUpdater } from './leaderboard.js';

store.load();

// One router for every sg*** command root (/sgkz, /sghb, …).
const commands = { ...kzCommands, ...birthdayCommands, ...draftCommands, ...contactCommands, ...profileCommands, ...caseCommands };

// GuildMessages (not privileged) + partial messages: /sgdraft needs to hear
// about new messages (to keep lobbies at the bottom) and deleted ones. Message
// *content* is never read, so no privileged intent is needed.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Message],
});

// A deleted lobby message is re-posted (only the host closes a lobby). A deleted
// channel/thread ends its lobbies. Channel deletes send no per-message events.
client.on(Events.MessageDelete, (message) => repostDeletedLobby(message.id, client));
client.on(Events.MessageBulkDelete, (messages) => messages.forEach((m) => repostDeletedLobby(m.id, client)));
// Chat in a lobby's channel: move the lobby back to the bottom.
client.on(Events.MessageCreate, (message) => onChannelMessage(message));
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
  console.log(`✅ Logged in as ${c.user.tag}`);
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
