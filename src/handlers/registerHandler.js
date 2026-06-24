const {
  REGISTER_ROLE_ID,
  PRIVATE_CHAT_CHANNEL_ID,
  REGISTRATION_INBOX_CHANNEL_ID,
  MINECRAFT_REGISTER_RESET_ADMIN_ID,
  TOPUP_ADMIN_DISCORD_ID,
} = require('../config');
const { isAdmin } = require('../utils/permissions');
const { createRizebotHelpPayload } = require('./helpPayload');

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
  void options;
  const content = (msg.content || '').trim();
  if (!/^!daftar\b/i.test(content) && !/^!register\b/i.test(content)) return false;
  if (!msg.guild) return false;

  await msg.reply(
    'Command ini sudah dialihkan ke register Minecraft. Pakai `!reg <gamertag>` atau `!daftar <gamertag>`, lalu lanjut `!verify`.'
  ).catch(() => null);
  return true;
}

async function handleStatusCommand(msg, options) {
  void options;
  const content = (msg.content || '').trim();
  if (!/^!status\b/i.test(content)) return false;

  await msg.reply(
    '`!status` sekarang dipakai untuk status verify Minecraft. Coba lagi, atau hubungi admin jika pesan ini muncul.'
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

  const member = await resolveMember(msg);
  const showAdmin = isAdmin(member) ||
    String(msg.author?.id || '') === String(TOPUP_ADMIN_DISCORD_ID) ||
    String(msg.author?.id || '') === String(MINECRAFT_REGISTER_RESET_ADMIN_ID);

  await msg.reply(createRizebotHelpPayload({
    showAdmin,
    registrationChannelId,
    privateChatChannelId,
  })).catch(() => null);
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
