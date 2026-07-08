const { PermissionsBitField } = require('discord.js');
const {
  MINECRAFT_REGISTER_ROLE_ID,
  MINECRAFT_REGISTER_PENDING_ROLE_ID,
  MINECRAFT_REGISTER_REJECTED_ROLE_ID,
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
  rejectedRoleId = MINECRAFT_REGISTER_REJECTED_ROLE_ID,
} = {}) {
  if (!member || member.user?.bot) return false;
  const added = await addRoleIfMissing(member, citizenRoleId);
  const removedLegacy = citizenRoleId === legacyRoleId
    ? true
    : await removeRoleIfPresent(member, legacyRoleId);
  const removedRejected = rejectedRoleId === citizenRoleId || rejectedRoleId === legacyRoleId
    ? true
    : await removeRoleIfPresent(member, rejectedRoleId);
  return added && removedLegacy && removedRejected;
}

function normalizeGamertag(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 32);
}

async function setNicknameToGamertag(member, gamertag) {
  const nickname = normalizeGamertag(gamertag);
  if (!member || !nickname) return false;
  if (member.nickname === nickname) return true;
  if (!member.nickname && member.user?.username === nickname) return true;

  const botMember = member.guild?.members?.me;
  const canManageNicknames = botMember?.permissions?.has(PermissionsBitField.Flags.ManageNicknames);
  if (!canManageNicknames || member.manageable === false) return false;

  const updated = await member
    .setNickname(nickname, 'Ethergeon gamertag registration sync')
    .catch(() => null);
  return Boolean(updated?.nickname === nickname || member.nickname === nickname);
}

async function collectRegisteredEntries(registerStore, client) {
  if (!registerStore) return new Map();
  await registerStore.init(client);
  return new Map(
    registerStore.getEntries()
      .filter(entry => entry.status === 'approved' || entry.legal === true)
      .map(entry => [String(entry.userId || '').trim(), entry])
      .filter(([userId]) => Boolean(userId))
  );
}

async function syncEthergeonCitizenRoles(client, {
  registerStore,
  citizenRoleId = MINECRAFT_REGISTER_ROLE_ID,
  legacyRoleId = MINECRAFT_REGISTER_PENDING_ROLE_ID,
  rejectedRoleId = MINECRAFT_REGISTER_REJECTED_ROLE_ID,
} = {}) {
  if (!client || !citizenRoleId) {
    return { scanned: 0, migrated: 0, failed: 0, skipped: 0, fromLegacyRole: 0, fromRegisterData: 0 };
  }

  const registeredEntries = await collectRegisteredEntries(registerStore, client);
  const stats = {
    scanned: 0,
    migrated: 0,
    failed: 0,
    skipped: 0,
    nicknameSynced: 0,
    nicknameFailed: 0,
    fromLegacyRole: 0,
    fromRegisterData: registeredEntries.size,
    failedMemberIds: [],
  };

  for (const guild of client.guilds.cache.values()) {
    const members = await guild.members.fetch().catch(() => null);
    if (!members) continue;

    for (const member of members.values()) {
      if (member.user?.bot) continue;
      const entry = registeredEntries.get(member.id);
      if (!entry) continue;

      stats.scanned += 1;

      const ok = await moveMemberToCitizenRole(member, { citizenRoleId, legacyRoleId, rejectedRoleId });
      const nicknameOk = await setNicknameToGamertag(member, entry.gamertag);
      if (nicknameOk) stats.nicknameSynced += 1;
      else stats.nicknameFailed += 1;
      if (ok) {
        stats.migrated += 1;
      } else {
        stats.failed += 1;
        stats.failedMemberIds.push(member.id);
      }
    }
  }

  stats.skipped = Math.max(0, registeredEntries.size - stats.scanned);
  return stats;
}

function registerEthergeonCitizenRoleEvents(client, {
  registerStore,
  citizenRoleId = MINECRAFT_REGISTER_ROLE_ID,
  legacyRoleId = MINECRAFT_REGISTER_PENDING_ROLE_ID,
  rejectedRoleId = MINECRAFT_REGISTER_REJECTED_ROLE_ID,
} = {}) {
  if (!client || !citizenRoleId) {
    return { sync: async () => ({ scanned: 0, migrated: 0, failed: 0, skipped: 0 }) };
  }

  client.on('guildMemberAdd', async member => {
    try {
      if (member.user?.bot) return;
      const registeredEntries = await collectRegisteredEntries(registerStore, member.client);
      const entry = registeredEntries.get(member.id);
      if (entry) {
        await moveMemberToCitizenRole(member, { citizenRoleId, legacyRoleId, rejectedRoleId });
        await setNicknameToGamertag(member, entry.gamertag);
      }
    } catch (err) {
      console.error('Ethergeon Citizen add handler error:', err);
    }
  });

  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
      if (newMember.user?.bot) return;
      void oldMember;
      void newMember;
    } catch (err) {
      console.error('Ethergeon Citizen update handler error:', err);
    }
  });

  return {
    sync: async () => syncEthergeonCitizenRoles(client, { registerStore, citizenRoleId, legacyRoleId, rejectedRoleId })
  };
}

module.exports = {
  moveMemberToCitizenRole,
  registerEthergeonCitizenRoleEvents,
  syncEthergeonCitizenRoles,
};
