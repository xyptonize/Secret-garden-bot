import { PermissionFlagsBits } from 'discord.js';
import { config } from './config.js';
import * as store from './store.js';
import { RANKS, rankFor } from './ranks.js';

const roleName = (rank) => `${config.rankRolePrefix} ${rank.name}`.trim();
const UNKNOWN_MEMBER = 10007;

/** Take every rank role off a member (after /sgkz unregister). Never throws. */
export async function removeRankRoles(guild, discordId) {
  const rankIds = new Set(Object.values(store.getRankRoles(guild.id)));
  if (!rankIds.size) return 0;
  try {
    const member = await guild.members.fetch({ user: discordId, force: true });
    const held = [...member.roles.cache.keys()].filter((id) => rankIds.has(id));
    for (const id of held) await member.roles.remove(id, 'CS2KZ: unregistered');
    return held.length;
  } catch (err) {
    if (err.code !== UNKNOWN_MEMBER) console.error(`Couldn't remove rank roles from ${discordId}:`, err.message);
    return 0;
  }
}

/**
 * Make sure a Discord role exists for every rank, creating any that are
 * missing. Returns a map of rankName -> Role. Throws if the bot lacks the
 * Manage Roles permission and a role needs creating.
 */
export async function ensureRankRoles(guild) {
  await guild.roles.fetch(); // populate cache
  const saved = store.getRankRoles(guild.id); // { rankName: roleId }
  const byName = {};

  for (const rank of RANKS) {
    let role = saved[rank.name] ? guild.roles.cache.get(saved[rank.name]) : null;
    if (!role) role = guild.roles.cache.find((r) => r.name === roleName(rank));
    if (!role) {
      if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
        throw new Error('I need the "Manage Roles" permission to create rank roles.');
      }
      role = await guild.roles.create({
        name: roleName(rank),
        color: rank.color,
        mentionable: false,
        reason: 'CS2KZ rank role',
      });
    }
    if (saved[rank.name] !== role.id) store.setRankRole(guild.id, rank.name, role.id);
    byName[rank.name] = role;
  }
  return byName;
}

/**
 * Give a member the single rank role matching their rating and strip any
 * other rank roles. `rolesByName` comes from ensureRankRoles().
 * Returns the rank name applied, or null if skipped (member left, etc.).
 */
export async function syncMemberRoles(guild, discordId, rating, rolesByName) {
  const rank = rankFor(rating);
  const targetRole = rank && rolesByName[rank.name];
  if (!targetRole) return null;

  let member;
  try {
    // Fresh, not cached: without the members intent the cached roles go stale.
    member = await guild.members.fetch({ user: discordId, force: true });
  } catch (err) {
    if (err.code === UNKNOWN_MEMBER) return null; // no longer in the server
    throw err;
  }

  const rankRoleIds = new Set(Object.values(rolesByName).map((r) => r.id));
  const stale = member.roles.cache.filter((r) => rankRoleIds.has(r.id) && r.id !== targetRole.id);

  if (!member.roles.cache.has(targetRole.id)) {
    await member.roles.add(targetRole, 'CS2KZ rank update');
  }
  // One removal per role: removing a collection rewrites the member's whole role
  // list from a copy taken before the add, which would undo it.
  for (const role of stale.values()) await member.roles.remove(role, 'CS2KZ rank update');
  return rank.name;
}
