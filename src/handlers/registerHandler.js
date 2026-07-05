const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const {
  MINECRAFT_REGISTER_ROLE_ID,
  MINECRAFT_REGISTER_PENDING_ROLE_ID,
  PRIVATE_CHAT_CHANNEL_ID,
  REGISTRATION_INBOX_CHANNEL_ID,
  MINECRAFT_REGISTER_RESET_ADMIN_ID,
  TOPUP_ADMIN_DISCORD_ID,
} = require('../config');
const { isAdmin } = require('../utils/permissions');
const { createRizebotHelpPayload } = require('./helpPayload');
const {
  moveMemberToCitizenRole,
  syncEthergeonCitizenRoles,
} = require('./ethergeonCitizenRoleHandler');

const LIST_PAGE_SIZE = 20;
const LIST_BUTTON_PREFIX = 'citizenlist';

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
    legacyRoleId,
    submissionStore
  } = options;
  const content = (msg.content || '').trim();
  if (!/^!(?:reg|daftar|register)\b/i.test(content)) return false;
  if (!msg.guild) return false;

  const member = await resolveMember(msg);
  if (!member) {
    await msg.reply('Gagal membaca data member kamu, coba lagi.').catch(() => null);
    return true;
  }

  const moved = await moveMemberToCitizenRole(member, {
    citizenRoleId: roleId,
    legacyRoleId
  });

  if (!moved) {
    await msg.reply(
      'Gagal memberi role Ethergeon Citizen. Cek permission dan posisi role bot, lalu coba lagi.'
    ).catch(() => null);
    return true;
  }

  await markApprovedIfPossible(submissionStore, msg.client, member.id, 'reg').catch(err => {
    console.error('Failed to mark !reg approval:', err);
  });

  await msg.reply('Registrasi berhasil. Role Ethergeon Citizen sudah diberikan.').catch(() => null);
  return true;
}

async function handleStatusCommand(msg, options) {
  const content = (msg.content || '').trim();
  if (!/^!status\b/i.test(content)) return false;
  if (!msg.guild) return false;

  const member = await resolveMember(msg);
  const registered = Boolean(member?.roles?.cache?.has(options.roleId));
  await msg.reply(
    registered
      ? 'Status: kamu sudah menjadi Ethergeon Citizen.'
      : 'Status: kamu belum punya role Ethergeon Citizen. Pakai `!reg` untuk daftar.'
  ).catch(() => null);
  return true;
}

function parseListCommand(content) {
  const match = String(content || '').trim().match(/^!list(?:\s+(\d+))?$/i);
  if (!match) return null;
  const page = match[1] ? parseInt(match[1], 10) : 1;
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function formatRegisteredMember(member, index) {
  const name = member.displayName || member.user?.username || member.id;
  return `${index + 1}. <@${member.id}> - ${name}`;
}

async function getRegisteredMembers(guild, roleId) {
  const members = await guild?.members.fetch().catch(() => null);
  if (!members) {
    return null;
  }

  return [...members.values()]
    .filter(member => !member.user?.bot && member.roles.cache.has(roleId))
    .sort((left, right) => (
      (left.displayName || left.user?.username || '').localeCompare(
        right.displayName || right.user?.username || '',
        'id',
        { sensitivity: 'base' }
      )
    ));
}

function buildListButtonId(page) {
  return `${LIST_BUTTON_PREFIX}:${page}`;
}

function parseListButtonId(customId) {
  const match = String(customId || '').match(new RegExp(`^${LIST_BUTTON_PREFIX}:(\\d+)$`));
  if (!match) return null;
  const page = parseInt(match[1], 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function buildListButtons(page, totalPages) {
  const previousPage = Math.max(1, page - 1);
  const nextPage = Math.min(totalPages, page + 1);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildListButtonId(previousPage))
      .setLabel('Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(buildListButtonId(nextPage))
      .setLabel('Next')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page >= totalPages)
  );
}

function buildListPayload(registered, page) {
  if (!registered.length) {
    return {
      content: 'Belum ada user yang terdaftar sebagai Ethergeon Citizen.',
      embeds: [],
      components: [],
      allowedMentions: { parse: [], repliedUser: false }
    };
  }

  const totalPages = Math.max(1, Math.ceil(registered.length / LIST_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * LIST_PAGE_SIZE;
  const rows = registered
    .slice(start, start + LIST_PAGE_SIZE)
    .map((member, index) => formatRegisteredMember(member, start + index));

  const embed = new EmbedBuilder()
    .setColor(0x36a269)
    .setTitle('Daftar Ethergeon Citizen')
    .setDescription(rows.join('\n'))
    .setFooter({
      text: `Halaman ${safePage}/${totalPages} | Total ${registered.length} user`
    })
    .setTimestamp(new Date());

  return {
    embeds: [embed],
    components: [buildListButtons(safePage, totalPages)],
    allowedMentions: { parse: [], repliedUser: false }
  };
}

async function buildListPayloadForGuild(guild, roleId, page) {
  const registered = await getRegisteredMembers(guild, roleId);
  if (!registered) {
    return {
      content: 'Gagal membaca daftar member, coba lagi.',
      embeds: [],
      components: [],
      allowedMentions: { parse: [], repliedUser: false }
    };
  }
  return buildListPayload(registered, page);
}

async function handleListCommand(msg, options) {
  const page = parseListCommand(msg.content);
  if (!page) return false;
  if (!msg.guild) return false;

  const payload = await buildListPayloadForGuild(msg.guild, options.roleId, page);
  await msg.reply(payload).catch(() => null);
  return true;
}

function createRegisterInteractionHandler({
  roleId = MINECRAFT_REGISTER_ROLE_ID,
} = {}) {
  return async function handleRegisterInteraction(interaction) {
    try {
      if (!interaction || !interaction.isButton?.()) return false;
      const page = parseListButtonId(interaction.customId);
      if (!page) return false;

      if (!interaction.guild) {
        await interaction.reply({
          content: 'List ini hanya bisa dipakai di server.',
          ephemeral: true
        }).catch(() => null);
        return true;
      }

      const payload = await buildListPayloadForGuild(interaction.guild, roleId, page);
      await interaction.update(payload).catch(() => null);
      return true;
    } catch (err) {
      console.error('Register interaction handler error:', err);
      return false;
    }
  };
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

function isRegisterAdmin(msg) {
  return isAdmin(msg.member) ||
    String(msg.author?.id || '') === String(TOPUP_ADMIN_DISCORD_ID) ||
    String(msg.author?.id || '') === String(MINECRAFT_REGISTER_RESET_ADMIN_ID);
}

async function handleSyncCitizenCommand(msg, options) {
  const content = (msg.content || '').trim();
  if (!/^!(?:sync-citizen|sync-reg)\b/i.test(content)) return false;
  if (!msg.guild) return false;

  if (!isRegisterAdmin(msg)) {
    await msg.reply('Command ini khusus admin.').catch(() => null);
    return true;
  }

  const stats = await syncEthergeonCitizenRoles(msg.client, {
    registerStore: options.registerStore,
    citizenRoleId: options.roleId,
    legacyRoleId: options.legacyRoleId,
  });
  const failedIds = stats.failedMemberIds || [];
  const failedLine = failedIds.length
    ? `\nGagal: ${failedIds.slice(0, 10).map(id => `<@${id}>`).join(', ')}${failedIds.length > 10 ? `, +${failedIds.length - 10} lainnya` : ''}`
    : '';

  await msg.reply({
    content: [
      'Sync Ethergeon Citizen selesai.',
      `Diproses: ${stats.scanned}`,
      `Berhasil pindah: ${stats.migrated}`,
      `Dari role lama: ${stats.fromLegacyRole || 0}`,
      `Dari data legacy: ${stats.fromRegisterData || 0}`,
      `Tidak ditemukan: ${stats.skipped}`,
      `Gagal: ${stats.failed}`,
      failedLine,
      stats.failed ? 'Kalau masih gagal, cek permission Manage Roles dan posisi role bot harus di atas role lama + role Ethergeon Citizen.' : ''
    ].filter(Boolean).join('\n'),
    allowedMentions: { parse: [], repliedUser: false }
  }).catch(() => null);
  return true;
}

function createRegisterHandler({
  roleId = MINECRAFT_REGISTER_ROLE_ID,
  legacyRoleId = MINECRAFT_REGISTER_PENDING_ROLE_ID,
  registerStore,
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
        legacyRoleId,
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

      const handledSyncCitizen = await handleSyncCitizenCommand(msg, {
        roleId,
        legacyRoleId,
        registerStore
      });
      if (handledSyncCitizen) return true;

      const handledList = await handleListCommand(msg, {
        roleId,
        registrationChannelId
      });
      if (handledList) return true;

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
  createRegisterInteractionHandler,
  createSubmissionReactionHandler,
  scanSubmissionApprovals
};
