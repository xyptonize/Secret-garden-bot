// Who counts as staff: the people who may override the ordinary rules.
//
// "Admin" in Discord means whoever holds Manage Server, which in a busy server
// is a dozen moderator and integration roles. STAFF_ROLES names the few who
// should be able to take something over — owners and developers — by role name
// or id. The server owner always counts.

import { PermissionFlagsBits } from 'discord.js';
import { config } from './config.js';

/** The member's roles, whichever shape the interaction handed us. */
function rolesOf(interaction) {
  const roles = interaction.member?.roles;
  if (!roles) return [];
  if (Array.isArray(roles)) return roles.map((r) => ({ id: typeof r === 'string' ? r : r.id, name: r.name ?? '' }));
  if (roles.cache) return [...roles.cache.values()].map((r) => ({ id: r.id, name: r.name }));
  return [];
}

/** True for the server owner and anyone holding a STAFF_ROLES role. */
export function isStaff(interaction) {
  if (interaction.guild?.ownerId && interaction.guild.ownerId === interaction.user.id) return true;
  if (!config.staffRoles.length) {
    // Nothing configured: fall back to Manage Server, the old behaviour.
    return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
  }
  const wanted = config.staffRoles.map((r) => r.toLowerCase());
  return rolesOf(interaction).some((r) => wanted.includes(r.id) || wanted.includes((r.name || '').toLowerCase()));
}

/** Named in a refusal, so people know who to ask rather than guessing. */
export const staffText = () =>
  config.staffRoles.length
    ? config.staffRoles.map((r) => (/^\d{5,}$/.test(r) ? `<@&${r}>` : `**${r}**`)).join(', ')
    : 'admins';
