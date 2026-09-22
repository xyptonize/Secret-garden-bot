// Registers the slash commands with Discord. Run once after changing commands:
//   npm run deploy
import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commandData } from './commands.js';
import { birthdayCommandData } from './birthday.js';
import { draftCommandData } from './draft.js';
import { contactCommandData } from './contacts.js';
import { profileCommandData } from './profile.js';
import { caseCommandData } from './cases.js';

const body = [
  ...commandData(),
  ...birthdayCommandData(),
  ...draftCommandData(),
  ...contactCommandData(),
  ...profileCommandData(),
  ...caseCommandData(),
];
const rest = new REST({ version: '10' }).setToken(config.token);

const route = config.guildId
  ? Routes.applicationGuildCommands(config.clientId, config.guildId)
  : Routes.applicationCommands(config.clientId);

try {
  // This endpoint REPLACES every command the application has. Another bot can
  // share this Discord application (whereis-bot does), so read what's already
  // registered and keep anything that isn't ours instead of deleting it.
  const existing = await rest.get(route);
  const ours = new Set(body.map((c) => c.name));
  const preserved = existing.filter((c) => !ours.has(c.name));

  await rest.put(route, { body: [...preserved, ...body] });

  console.log(
    `✅ Registered ${body.length} slash command(s) ${
      config.guildId ? `to guild ${config.guildId} (instant).` : 'globally (may take up to 1 hour to appear).'
    }`,
  );
  if (preserved.length) {
    console.log(`   Left ${preserved.length} other command(s) alone: ${preserved.map((c) => `/${c.name}`).join(', ')}`);
  }
} catch (err) {
  console.error('❌ Failed to register commands:', err);
  process.exit(1);
}
