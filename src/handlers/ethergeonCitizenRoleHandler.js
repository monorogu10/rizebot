const {
  MINECRAFT_REGISTER_ROLE_ID,
  MINECRAFT_REGISTER_PENDING_ROLE_ID,
} = require('../config');

async function fetchRole(guild, roleId) {
  if (!guild || !roleId) return null;
  return guild.roles.cache.get(roleId) || guild.roles.fetch(roleId).catch(() => null);
}

async function addRoleIfMissing(member, roleId) {
  if (!member || !roleId) return false;
  if (member.roles.cache.has(roleId)) return true;
  const role = await fetchRole(member.guild, roleId);
  if (!role) return false;
  const updated = await member.roles.add(role, 'Ethergeon Citizen registration').catch(() => null);
  if (updated?.roles?.cache?.has(roleId)) return true;
  return member.roles.cache.has(roleId);
}

async function removeRoleIfPresent(member, roleId) {
  if (!member || !roleId) return true;
  if (!member.roles.cache.has(roleId)) return true;
  const role = await fetchRole(member.guild, roleId);
  if (!role) return false;
  const updated = await member.roles.remove(role, 'Migrated to Ethergeon Citizen').catch(() => null);
  if (updated?.roles?.cache && !updated.roles.cache.has(roleId)) return true;
  return !member.roles.cache.has(roleId);
}

async function moveMemberToCitizenRole(member, {
  citizenRoleId = MINECRAFT_REGISTER_ROLE_ID,
  legacyRoleId = MINECRAFT_REGISTER_PENDING_ROLE_ID,
} = {}) {
  if (!member || member.user?.bot) return false;
  const added = await addRoleIfMissing(member, citizenRoleId);
  const removedLegacy = citizenRoleId === legacyRoleId
    ? true
    : await removeRoleIfPresent(member, legacyRoleId);
  return added && removedLegacy;
}

async function collectRegisteredUserIds(registerStore, client) {
  if (!registerStore) return new Set();
  await registerStore.init(client);
  return new Set(
    registerStore.getEntries()
      .map(entry => String(entry.userId || '').trim())
      .filter(Boolean)
  );
}

async function syncEthergeonCitizenRoles(client, {
  registerStore,
  citizenRoleId = MINECRAFT_REGISTER_ROLE_ID,
  legacyRoleId = MINECRAFT_REGISTER_PENDING_ROLE_ID,
} = {}) {
  if (!client || !citizenRoleId) {
    return { scanned: 0, migrated: 0, failed: 0, skipped: 0, fromLegacyRole: 0, fromRegisterData: 0 };
  }

  const registeredUserIds = await collectRegisteredUserIds(registerStore, client);
  const stats = {
    scanned: 0,
    migrated: 0,
    failed: 0,
    skipped: 0,
    fromLegacyRole: 0,
    fromRegisterData: registeredUserIds.size,
  };

  for (const guild of client.guilds.cache.values()) {
    const members = await guild.members.fetch().catch(() => null);
    if (!members) continue;

    for (const member of members.values()) {
      if (member.user?.bot) continue;
      const hasLegacyRole = Boolean(legacyRoleId && member.roles.cache.has(legacyRoleId));
      const hasRegisterData = registeredUserIds.has(member.id);
      if (!hasLegacyRole && !hasRegisterData) continue;

      stats.scanned += 1;
      if (hasLegacyRole) stats.fromLegacyRole += 1;

      const ok = await moveMemberToCitizenRole(member, { citizenRoleId, legacyRoleId });
      if (ok) {
        stats.migrated += 1;
      } else {
        stats.failed += 1;
      }
    }
  }

  stats.skipped = Math.max(0, registeredUserIds.size - stats.scanned);
  return stats;
}

function registerEthergeonCitizenRoleEvents(client, {
  registerStore,
  citizenRoleId = MINECRAFT_REGISTER_ROLE_ID,
  legacyRoleId = MINECRAFT_REGISTER_PENDING_ROLE_ID,
} = {}) {
  if (!client || !citizenRoleId) {
    return { sync: async () => ({ scanned: 0, migrated: 0, failed: 0, skipped: 0 }) };
  }

  client.on('guildMemberAdd', async member => {
    try {
      if (member.user?.bot) return;
      const registeredUserIds = await collectRegisteredUserIds(registerStore, member.client);
      if (registeredUserIds.has(member.id) || (legacyRoleId && member.roles.cache.has(legacyRoleId))) {
        await moveMemberToCitizenRole(member, { citizenRoleId, legacyRoleId });
      }
    } catch (err) {
      console.error('Ethergeon Citizen add handler error:', err);
    }
  });

  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
      if (newMember.user?.bot) return;
      const hadLegacy = legacyRoleId && oldMember.roles.cache.has(legacyRoleId);
      const hasLegacy = legacyRoleId && newMember.roles.cache.has(legacyRoleId);
      if (!hadLegacy && hasLegacy) {
        await moveMemberToCitizenRole(newMember, { citizenRoleId, legacyRoleId });
      }
    } catch (err) {
      console.error('Ethergeon Citizen update handler error:', err);
    }
  });

  return {
    sync: async () => syncEthergeonCitizenRoles(client, { registerStore, citizenRoleId, legacyRoleId })
  };
}

module.exports = {
  moveMemberToCitizenRole,
  registerEthergeonCitizenRoleEvents,
  syncEthergeonCitizenRoles,
};
