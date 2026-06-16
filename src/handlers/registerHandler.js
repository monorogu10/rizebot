const {
  REGISTER_ROLE_ID,
  PRIVATE_CHAT_CHANNEL_ID,
  REGISTRATION_INBOX_CHANNEL_ID
} = require('../config');

function isTargetChannelOrThread(msg, targetChannelId) {
  if (!targetChannelId) return true;
  const targetId = String(targetChannelId);
  const channelId = String(msg.channelId || '');
  if (channelId === targetId) return true;
  const parentId = msg.channel?.parentId ? String(msg.channel.parentId) : '';
  return parentId === targetId;
}

function ensureRegChannel(msg, registrationChannelId) {
  return isTargetChannelOrThread(msg, registrationChannelId);
}

async function resolveMember(msg) {
  if (msg.member) return msg.member;
  const userId = msg.author?.id || msg.user?.id;
  if (!userId) return null;
  return msg.guild?.members.fetch(userId).catch(() => null);
}

async function addRoleIfMissing(member, roleId) {
  if (!member || !roleId) return false;
  if (member.roles.cache.has(roleId)) return true;
  const role = member.guild.roles.cache.get(roleId) ||
    await member.guild.roles.fetch(roleId).catch(() => null);
  if (!role) return false;
  const updated = await member.roles.add(role).catch(() => null);
  if (updated?.roles?.cache?.has(roleId)) return true;
  return member.roles.cache.has(roleId);
}

async function markApprovedIfPossible(submissionStore, client, userId, source) {
  if (!submissionStore || !userId) return;
  await submissionStore.init(client);
  await submissionStore.markApprovedMember(userId, source);
}

async function handleRegisterCommand(msg, options) {
  const {
    roleId,
    submissionStore,
    registrationChannelId,
    privateChatChannelId
  } = options;
  const content = (msg.content || '').trim();
  if (!/^!daftar\b/i.test(content) && !/^!register\b/i.test(content)) return false;
  if (!msg.guild) return false;

  if (!ensureRegChannel(msg, registrationChannelId)) {
    await msg.reply(`Gunakan command ini di <#${registrationChannelId}>.`).catch(() => null);
    return true;
  }

  const member = await resolveMember(msg);
  if (!member) {
    await msg.reply('Gagal membaca data member kamu, coba lagi.').catch(() => null);
    return true;
  }

  if (!roleId) {
    await msg.reply('Role private belum dikonfigurasi. Hubungi admin.').catch(() => null);
    return true;
  }

  const alreadyRegistered = member.roles.cache.has(roleId);
  if (alreadyRegistered) {
    await markApprovedIfPossible(submissionStore, msg.client, member.id, 'role');
    await msg.reply('Kamu sudah terdaftar di private.').catch(() => null);
    return true;
  }

  const added = await addRoleIfMissing(member, roleId);
  if (!added) {
    await msg.reply('Gagal memberi role private. Hubungi admin.').catch(() => null);
    return true;
  }

  await markApprovedIfPossible(submissionStore, msg.client, member.id, 'direct');
  const privateChatHint = privateChatChannelId
    ? ` Silakan lanjut chat di <#${privateChatChannelId}>.`
    : '';
  await msg.reply(`Pendaftaran berhasil, role private sudah diberikan.${privateChatHint}`).catch(() => null);
  return true;
}

async function handleStatusCommand(msg, options) {
  const { roleId, submissionStore, registrationChannelId } = options;
  const content = (msg.content || '').trim();
  if (!/^!status\b/i.test(content)) return false;

  const member = await resolveMember(msg);
  const hasRole = Boolean(roleId && member?.roles?.cache?.has(roleId));
  let isRegistered = hasRole;

  if (submissionStore) {
    await submissionStore.init(msg.client);
    if (!isRegistered) {
      isRegistered = submissionStore.isApprovedMember(msg.author.id) ||
        submissionStore.isPermanentMember(msg.author.id);
    }
    if (hasRole) {
      await submissionStore.markApprovedMember(msg.author.id, 'role');
    }
  }

  if (isRegistered) {
    await msg.reply('Status: kamu sudah terdaftar di private.').catch(() => null);
    return true;
  }

  const channelHint = registrationChannelId ? ` di <#${registrationChannelId}>` : '';
  await msg.reply(
    `Status: belum terdaftar. Kirim \`!daftar\`${channelHint} untuk dapat akses private.`
  ).catch(() => null);
  return true;
}

async function handleHelpCommand(msg, options) {
  const {
    registrationChannelId,
    privateChatChannelId
  } = options;
  const content = (msg.content || '').trim();
  if (!/^!help\b/i.test(content)) return false;
  if (!msg.guild) return false;

  const registerHint = registrationChannelId ? `<#${registrationChannelId}>` : 'channel registrasi';
  const privateChatHint = privateChatChannelId ? `<#${privateChatChannelId}>` : 'channel private chat';
  const lines = [
    '**Panduan Singkat**',
    `- Daftar private: kirim \`!daftar\` di ${registerHint}.`,
    '- Cek status pendaftaran private: `!status`.',
    '- Daftar Minecraft: `!reg <gamertag_minecraft>`.',
    '- Ubah gamertag Minecraft: `!edit-reg <gamertag_minecraft>`.',
    '- Keluar dari registrasi Minecraft: `!out`.',
    '- List registrasi Minecraft: `!list`.',
    '- Petisi timeout (khusus member private): `!timeout @user` (butuh 17 vote dalam 1 jam).',
    '- Veto admin: `!freedom @user`.',
    `- Moderasi cepat (khusus ${privateChatHint}): react \uD83D\uDDD1\uFE0F 5x dari member private -> pesan dihapus.`
  ];

  await msg.reply(lines.join('\n')).catch(() => null);
  return true;
}

function createRegisterHandler({
  roleId = REGISTER_ROLE_ID,
  submissionStore,
  registrationChannelId = REGISTRATION_INBOX_CHANNEL_ID,
  privateChatChannelId = PRIVATE_CHAT_CHANNEL_ID
}) {
  return async function handleRegisterMessage(msg) {
    try {
      if (!msg || msg.author?.bot) return false;
      if (!msg.guild) return false;

      const handledRegister = await handleRegisterCommand(msg, {
        roleId,
        submissionStore,
        registrationChannelId,
        privateChatChannelId
      });
      if (handledRegister) return true;

      const handledHelp = await handleHelpCommand(msg, {
        registrationChannelId,
        privateChatChannelId
      });
      if (handledHelp) return true;

      const handledStatus = await handleStatusCommand(msg, {
        roleId,
        submissionStore,
        registrationChannelId
      });
      if (handledStatus) return true;

      return false;
    } catch (err) {
      console.error('Register handler error:', err);
      return false;
    }
  };
}

function createSubmissionReactionHandler() {
  return async function handleSubmissionReaction() {
    return false;
  };
}

async function scanSubmissionApprovals() {
  return { scanned: 0, approved: 0 };
}

module.exports = {
  createRegisterHandler,
  createSubmissionReactionHandler,
  scanSubmissionApprovals
};
