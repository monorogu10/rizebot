async function ensureRole(member, roleId) {
  if (!member || !roleId) return false;
  if (member.roles.cache.has(roleId)) return false;
  const role = member.guild.roles.cache.get(roleId);
  if (!role) return false;
  await member.roles.add(role).catch(() => null);
  return true;
}

async function syncPrivateRoles(client, submissionStore, privateRoleId, legacyRoleId) {
  if (!client || !submissionStore || !privateRoleId) return;
  await submissionStore.init(client);

  for (const guild of client.guilds.cache.values()) {
    const members = await guild.members.fetch().catch(() => null);
    if (!members) continue;

    const existingPrivateIds = [];
    for (const member of members.values()) {
      if (member.user?.bot) continue;
      if (member.roles.cache.has(privateRoleId)) {
        existingPrivateIds.push(member.id);
      }
    }
    if (existingPrivateIds.length) {
      await submissionStore.addApprovedMembers(existingPrivateIds, 'role');
    }

    const legacyIds = [];
    if (legacyRoleId) {
      for (const member of members.values()) {
        if (member.user?.bot) continue;
        if (member.roles.cache.has(legacyRoleId)) {
          legacyIds.push(member.id);
        }
      }
      if (legacyIds.length) {
        await submissionStore.addPermanentMembers(legacyIds, 'legacy');
      }
    }

    const approvedIds = new Set([
      ...submissionStore.getApprovedMemberIds(),
      ...submissionStore.getPermanentMemberIds(),
      ...legacyIds
    ]);

    for (const userId of approvedIds) {
      const member = members.get(userId);
      if (!member || member.user?.bot) continue;
      await ensureRole(member, privateRoleId);
    }
  }
}

function registerPrivateRoleEvents(client, {
  submissionStore,
  privateRoleId,
  legacyRoleId
} = {}) {
  if (!client || !submissionStore || !privateRoleId) {
    return { sync: async () => {} };
  }

  client.on('guildMemberAdd', async member => {
    try {
      if (member.user?.bot) return;
      await submissionStore.init(client);

      const hasLegacy = legacyRoleId && member.roles.cache.has(legacyRoleId);
      if (hasLegacy) {
        await submissionStore.markPermanentMember(member.id, 'legacy');
      }

      if (
        hasLegacy ||
        submissionStore.isApprovedMember(member.id) ||
        submissionStore.isPermanentMember(member.id)
      ) {
        await ensureRole(member, privateRoleId);
      }
    } catch (err) {
      console.error('Private role add handler error:', err);
    }
  });

  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
      if (newMember.user?.bot) return;
      await submissionStore.init(client);

      const hadLegacy = legacyRoleId && oldMember.roles.cache.has(legacyRoleId);
      const hasLegacy = legacyRoleId && newMember.roles.cache.has(legacyRoleId);
      const hadPrivate = privateRoleId && oldMember.roles.cache.has(privateRoleId);
      const hasPrivate = privateRoleId && newMember.roles.cache.has(privateRoleId);

      if (!hadLegacy && hasLegacy) {
        await submissionStore.markPermanentMember(newMember.id, 'legacy');
      }
      if (!hadPrivate && hasPrivate) {
        await submissionStore.markApprovedMember(newMember.id, 'role');
      }

      if (
        hasLegacy ||
        submissionStore.isApprovedMember(newMember.id) ||
        submissionStore.isPermanentMember(newMember.id)
      ) {
        await ensureRole(newMember, privateRoleId);
      }
    } catch (err) {
      console.error('Private role update handler error:', err);
    }
  });

  return {
    sync: async () => {
      await syncPrivateRoles(client, submissionStore, privateRoleId, legacyRoleId);
    }
  };
}

module.exports = { registerPrivateRoleEvents };
