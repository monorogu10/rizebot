const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require('discord.js');
const {
  MINECRAFT_REGISTER_ROLE_ID,
  MINECRAFT_REGISTER_RESET_ADMIN_ID,
  MINECRAFT_INFO_CHANNEL_ID,
  MINECRAFT_INFO_URL
} = require('../config');
const { isAdmin } = require('../utils/permissions');

const GAMERTAG_REGEX = /^[A-Za-z0-9_]{3,16}$/;
const LIST_PAGE_SIZE = 10;
const LIST_BUTTON_PREFIX = 'mcreglist';

function parseSingleArgCommand(content, command) {
  const pattern = new RegExp(`^${command}(?:\\s+(.+))?$`, 'i');
  const match = String(content || '').trim().match(pattern);
  if (!match) return null;
  return {
    arg: (match[1] || '').trim(),
    hasArg: Boolean(match[1])
  };
}

function isValidGamertag(gamertag) {
  return GAMERTAG_REGEX.test(gamertag);
}

function gamertagFormatHelp(command = '!reg') {
  return `Format: \`${command} <gamertag_minecraft>\` (3-16 huruf/angka/underscore, tanpa spasi).`;
}

function formatDateId(iso) {
  if (!iso) return '-';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('id-ID', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Jakarta'
    }).format(parsed);
  } catch {
    return parsed.toISOString();
  }
}

function createNoPingPayload(payload) {
  const allowedMentions = { parse: [], repliedUser: false };
  if (typeof payload === 'string') {
    return { content: payload, allowedMentions };
  }
  return {
    ...payload,
    allowedMentions: payload.allowedMentions || allowedMentions
  };
}

async function replyNoPing(msg, payload) {
  return msg.reply(createNoPingPayload(payload)).catch(() => null);
}

async function resolveMember(msg) {
  if (msg.member) return msg.member;
  const userId = msg.author?.id || msg.user?.id;
  if (!userId) return null;
  return msg.guild?.members.fetch(userId).catch(() => null);
}

async function fetchRole(guild, roleId) {
  if (!guild || !roleId) return null;
  return guild.roles.cache.get(roleId) || guild.roles.fetch(roleId).catch(() => null);
}

async function addRoleIfMissing(member, roleId) {
  if (!member || !roleId) return false;
  if (member.roles.cache.has(roleId)) return true;
  const role = await fetchRole(member.guild, roleId);
  if (!role) return false;
  const updated = await member.roles.add(role).catch(() => null);
  if (updated?.roles?.cache?.has(roleId)) return true;
  return member.roles.cache.has(roleId);
}

async function removeRoleIfPresent(member, roleId) {
  if (!member || !roleId) return true;
  if (!member.roles.cache.has(roleId)) return true;
  const role = await fetchRole(member.guild, roleId);
  if (!role) return false;
  const updated = await member.roles.remove(role).catch(() => null);
  if (updated?.roles?.cache && !updated.roles.cache.has(roleId)) return true;
  return !member.roles.cache.has(roleId);
}

function getInfoLine(infoChannelId = MINECRAFT_INFO_CHANNEL_ID, infoUrl = MINECRAFT_INFO_URL) {
  const channelText = infoChannelId ? `<#${infoChannelId}>` : 'channel info';
  return `Silakan lanjut ke ${channelText}: ${infoUrl}`;
}

function formatExistingRegistration(entry) {
  return [
    `Gamertag tersimpan: \`${entry.gamertag}\``,
    `Daftar: ${formatDateId(entry.registeredAt)}`,
    `Update terakhir: ${formatDateId(entry.updatedAt || entry.registeredAt)}`
  ].join('\n');
}

function parseListPage(content) {
  const raw = String(content || '').trim();
  const match = raw.match(/^!list(?:\s+(\d+))?$/i);
  if (!match) return null;
  const page = match[1] ? parseInt(match[1], 10) : 1;
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function paginateEntries(entries, page, pageSize = LIST_PAGE_SIZE) {
  const totalItems = entries.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const start = (safePage - 1) * pageSize;
  return {
    page: safePage,
    totalPages,
    totalItems,
    startIndex: start,
    items: entries.slice(start, start + pageSize)
  };
}

function buildListButtonId(page, ownerId) {
  return `${LIST_BUTTON_PREFIX}:${page}:${ownerId || '0'}`;
}

function parseListButtonId(customId) {
  const raw = String(customId || '');
  if (!raw.startsWith(`${LIST_BUTTON_PREFIX}:`)) return null;
  const [, pageToken, ownerId] = raw.split(':');
  const page = parseInt(pageToken, 10);
  if (!Number.isFinite(page) || page <= 0) return null;
  return { page, ownerId: ownerId || null };
}

function buildListButtons(page, totalPages, ownerId) {
  const prevPage = Math.max(1, page - 1);
  const nextPage = Math.min(totalPages, page + 1);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildListButtonId(prevPage, ownerId))
      .setLabel('Sebelumnya')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(buildListButtonId(nextPage, ownerId))
      .setLabel('Berikutnya')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page >= totalPages)
  );
}

function buildListEmbed(entries, pagination) {
  const lines = pagination.items.map((entry, idx) => {
    const rank = pagination.startIndex + idx + 1;
    return [
      `**${rank}.** <@${entry.userId}> - \`${entry.gamertag}\``,
      `ID: \`${entry.userId}\` | Daftar: ${formatDateId(entry.registeredAt)}`
    ].join('\n');
  });

  const embed = new EmbedBuilder()
    .setColor(0x36a269)
    .setTitle('List Registrasi Minecraft')
    .setDescription(lines.length ? lines.join('\n\n') : 'Belum ada user terdaftar.')
    .setFooter({
      text: `Halaman ${pagination.page}/${pagination.totalPages} | Total ${pagination.totalItems} user`
    });

  if (entries.length) {
    embed.setTimestamp(new Date());
  }

  return embed;
}

function buildListResponse(entries, page, ownerId) {
  const pagination = paginateEntries(entries, page);
  return {
    embeds: [buildListEmbed(entries, pagination)],
    components: [buildListButtons(pagination.page, pagination.totalPages, ownerId)],
    allowedMentions: { parse: [], repliedUser: false }
  };
}

async function ensureRegisterStore(registerStore, client) {
  if (!registerStore) return false;
  await registerStore.init(client);
  return true;
}

async function handleMinecraftRegCommand(msg, options) {
  const {
    registerStore,
    roleId = MINECRAFT_REGISTER_ROLE_ID,
    infoChannelId = MINECRAFT_INFO_CHANNEL_ID,
    infoUrl = MINECRAFT_INFO_URL
  } = options;
  const parsed = parseSingleArgCommand(msg.content, '!reg');
  if (!parsed) return false;
  if (!msg.guild) return false;
  if (!parsed.hasArg) {
    await replyNoPing(msg, gamertagFormatHelp('!reg'));
    return true;
  }

  const gamertag = parsed.arg;
  if (!isValidGamertag(gamertag)) {
    await replyNoPing(msg, gamertagFormatHelp('!reg'));
    return true;
  }

  const ready = await ensureRegisterStore(registerStore, msg.client);
  if (!ready) {
    await replyNoPing(msg, 'Sistem registrasi belum aktif. Hubungi admin.');
    return true;
  }

  const member = await resolveMember(msg);
  if (!member) {
    await replyNoPing(msg, 'Gagal membaca data member kamu, coba lagi.');
    return true;
  }

  const roleOk = await addRoleIfMissing(member, roleId);
  if (!roleOk) {
    await replyNoPing(msg, 'Gagal memberi role registrasi. Cek permission dan posisi role bot.');
    return true;
  }

  const result = await registerStore.registerUser(
    msg.author.id,
    gamertag,
    msg.author?.tag || msg.author?.username || ''
  );

  if (!result.created) {
    await replyNoPing(
      msg,
      [
        'Kamu sudah terdaftar.',
        formatExistingRegistration(result.entry),
        `Untuk ganti gamertag, pakai \`!edit-reg ${gamertag}\`.`,
        getInfoLine(infoChannelId, infoUrl)
      ].join('\n')
    );
    return true;
  }

  await replyNoPing(
    msg,
    [
      `Registrasi berhasil. Gamertag kamu: \`${gamertag}\`.`,
      'Role registrasi sudah diberikan.',
      getInfoLine(infoChannelId, infoUrl)
    ].join('\n')
  );
  return true;
}

async function handleMinecraftEditRegCommand(msg, options) {
  const {
    registerStore,
    roleId = MINECRAFT_REGISTER_ROLE_ID,
    infoChannelId = MINECRAFT_INFO_CHANNEL_ID,
    infoUrl = MINECRAFT_INFO_URL
  } = options;
  const parsed = parseSingleArgCommand(msg.content, '!edit-reg');
  if (!parsed) return false;
  if (!msg.guild) return false;

  if (!parsed.hasArg || !isValidGamertag(parsed.arg)) {
    await replyNoPing(msg, gamertagFormatHelp('!edit-reg'));
    return true;
  }

  const ready = await ensureRegisterStore(registerStore, msg.client);
  if (!ready) {
    await replyNoPing(msg, 'Sistem registrasi belum aktif. Hubungi admin.');
    return true;
  }

  const existing = registerStore.getUser(msg.author.id);
  if (!existing) {
    await replyNoPing(msg, 'Kamu belum terdaftar. Pakai `!reg <gamertag_minecraft>` dulu.');
    return true;
  }

  const member = await resolveMember(msg);
  const roleOk = await addRoleIfMissing(member, roleId);
  if (!roleOk) {
    await replyNoPing(msg, 'Gamertag belum diubah karena role registrasi gagal dicek. Hubungi admin.');
    return true;
  }

  const updated = await registerStore.updateUser(
    msg.author.id,
    parsed.arg,
    msg.author?.tag || msg.author?.username || ''
  );
  if (!updated) {
    await replyNoPing(msg, 'Data registrasi tidak ditemukan. Pakai `!reg <gamertag_minecraft>` dulu.');
    return true;
  }

  await replyNoPing(
    msg,
    [
      `Gamertag berhasil diubah dari \`${existing.gamertag}\` ke \`${updated.gamertag}\`.`,
      getInfoLine(infoChannelId, infoUrl)
    ].join('\n')
  );
  return true;
}

async function handleMinecraftOutCommand(msg, options) {
  const { registerStore, roleId = MINECRAFT_REGISTER_ROLE_ID } = options;
  const content = String(msg.content || '').trim();
  if (!/^!out\s*$/i.test(content)) return false;
  if (!msg.guild) return false;

  const ready = await ensureRegisterStore(registerStore, msg.client);
  if (!ready) {
    await replyNoPing(msg, 'Sistem registrasi belum aktif. Hubungi admin.');
    return true;
  }

  const member = await resolveMember(msg);
  const hadData = Boolean(registerStore.getUser(msg.author.id));
  const hadRole = Boolean(roleId && member?.roles?.cache?.has(roleId));

  if (!hadData && !hadRole) {
    await replyNoPing(msg, 'Kamu belum terdaftar di registrasi Minecraft.');
    return true;
  }

  const removedRole = await removeRoleIfPresent(member, roleId);
  if (!removedRole) {
    await replyNoPing(msg, 'Gagal mencabut role registrasi. Hubungi admin.');
    return true;
  }

  if (hadData) {
    await registerStore.removeUser(msg.author.id);
  }

  await replyNoPing(msg, 'Kamu sudah keluar dari registrasi Minecraft. Role dicabut dan data reg dihapus.');
  return true;
}

async function handleMinecraftResetCommand(msg, options) {
  const {
    registerStore,
    roleId = MINECRAFT_REGISTER_ROLE_ID,
    resetAdminId = MINECRAFT_REGISTER_RESET_ADMIN_ID
  } = options;
  const content = String(msg.content || '').trim();
  if (!/^!reset\s*$/i.test(content)) return false;
  if (!msg.guild) return false;

  if (msg.author?.id !== resetAdminId) {
    await replyNoPing(msg, 'Command `!reset` khusus admin register.');
    return true;
  }

  const ready = await ensureRegisterStore(registerStore, msg.client);
  if (!ready) {
    await replyNoPing(msg, 'Sistem registrasi belum aktif. Hubungi admin.');
    return true;
  }

  const entries = registerStore.getEntries();
  let rolesRemoved = 0;
  let noRole = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of entries) {
    const member = await msg.guild.members.fetch(entry.userId).catch(() => null);
    if (!member) {
      skipped += 1;
      continue;
    }

    const hadRole = Boolean(roleId && member.roles.cache.has(roleId));
    const removed = await removeRoleIfPresent(member, roleId);
    if (!removed) {
      failed += 1;
      continue;
    }

    if (hadRole) {
      rolesRemoved += 1;
    } else {
      noRole += 1;
    }
  }

  await registerStore.resetAll();
  await replyNoPing(
    msg,
    [
      `Register Minecraft direset. Data terhapus: ${entries.length}.`,
      `Role dicabut: ${rolesRemoved}. Tanpa role: ${noRole}. Tidak ditemukan: ${skipped}. Gagal: ${failed}.`
    ].join('\n')
  );
  return true;
}

async function handleMinecraftListCommand(msg, options) {
  const { registerStore } = options;
  const page = parseListPage(msg.content);
  if (!page) return false;
  if (!msg.guild) return false;

  const ready = await ensureRegisterStore(registerStore, msg.client);
  if (!ready) {
    await replyNoPing(msg, 'Sistem registrasi belum aktif. Hubungi admin.');
    return true;
  }

  const entries = registerStore.getEntries();
  if (!entries.length) {
    await replyNoPing(msg, 'Belum ada user yang terdaftar.');
    return true;
  }

  const maxPage = Math.max(1, Math.ceil(entries.length / LIST_PAGE_SIZE));
  if (page > maxPage) {
    await replyNoPing(msg, `Halaman ${page} tidak tersedia. Maksimal halaman: ${maxPage}.`);
    return true;
  }

  await replyNoPing(msg, buildListResponse(entries, page, msg.author?.id || null));
  return true;
}

function createMinecraftRegisterHandler({
  registerStore,
  roleId = MINECRAFT_REGISTER_ROLE_ID,
  resetAdminId = MINECRAFT_REGISTER_RESET_ADMIN_ID,
  infoChannelId = MINECRAFT_INFO_CHANNEL_ID,
  infoUrl = MINECRAFT_INFO_URL
}) {
  return async function handleMinecraftRegisterMessage(msg) {
    try {
      if (!msg || msg.author?.bot) return false;
      if (!msg.guild) return false;

      const options = { registerStore, roleId, resetAdminId, infoChannelId, infoUrl };

      const handledEdit = await handleMinecraftEditRegCommand(msg, options);
      if (handledEdit) return true;

      const handledReset = await handleMinecraftResetCommand(msg, options);
      if (handledReset) return true;

      const handledOut = await handleMinecraftOutCommand(msg, options);
      if (handledOut) return true;

      const handledList = await handleMinecraftListCommand(msg, options);
      if (handledList) return true;

      const handledReg = await handleMinecraftRegCommand(msg, options);
      if (handledReg) return true;

      return false;
    } catch (err) {
      console.error('Minecraft register handler error:', err);
      return false;
    }
  };
}

function createMinecraftRegisterInteractionHandler({
  registerStore
}) {
  return async function handleMinecraftRegisterInteraction(interaction) {
    try {
      if (!interaction || !interaction.isButton?.()) return false;
      const payload = parseListButtonId(interaction.customId);
      if (!payload) return false;

      if (!interaction.guild) {
        await interaction.reply({
          content: 'Pagination ini hanya bisa dipakai di server.',
          ephemeral: true
        }).catch(() => null);
        return true;
      }

      if (
        payload.ownerId &&
        payload.ownerId !== '0' &&
        payload.ownerId !== interaction.user?.id &&
        !isAdmin(interaction.member)
      ) {
        await interaction.reply({
          content: 'Hanya pembuat list atau admin yang bisa mengubah halaman ini.',
          ephemeral: true
        }).catch(() => null);
        return true;
      }

      const ready = await ensureRegisterStore(registerStore, interaction.client);
      if (!ready) {
        await interaction.reply({
          content: 'Sistem registrasi belum aktif.',
          ephemeral: true
        }).catch(() => null);
        return true;
      }

      const entries = registerStore.getEntries();
      if (!entries.length) {
        await interaction.update({
          content: 'Belum ada user yang terdaftar.',
          embeds: [],
          components: [],
          allowedMentions: { parse: [], repliedUser: false }
        }).catch(() => null);
        return true;
      }

      await interaction.update(buildListResponse(
        entries,
        payload.page,
        payload.ownerId && payload.ownerId !== '0'
          ? payload.ownerId
          : (interaction.user?.id || null)
      )).catch(() => null);
      return true;
    } catch (err) {
      console.error('Minecraft register interaction handler error:', err);
      return false;
    }
  };
}

async function findMemberAcrossGuilds(client, userId) {
  if (!client || !userId) return null;
  for (const guild of client.guilds.cache.values()) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) return member;
  }
  return null;
}

async function syncMinecraftRoleForMember(
  member,
  registerStore,
  roleId = MINECRAFT_REGISTER_ROLE_ID
) {
  if (!member || member.user?.bot || !registerStore) return false;
  await registerStore.init(member.client);
  const entry = registerStore.getUser(member.id);
  if (!entry) return false;
  return addRoleIfMissing(member, roleId);
}

async function syncMinecraftRegistrationRolesFromStore(
  client,
  registerStore,
  roleId = MINECRAFT_REGISTER_ROLE_ID
) {
  if (!client || !registerStore || !roleId) {
    return { scanned: 0, synced: 0, failed: 0, skipped: 0 };
  }

  await registerStore.init(client);
  const entries = registerStore.getEntries();
  const stats = { scanned: entries.length, synced: 0, failed: 0, skipped: 0 };

  for (const entry of entries) {
    const member = await findMemberAcrossGuilds(client, entry.userId);
    if (!member) {
      stats.skipped += 1;
      continue;
    }

    const ok = await addRoleIfMissing(member, roleId);
    if (ok) {
      stats.synced += 1;
    } else {
      stats.failed += 1;
    }
  }

  return stats;
}

module.exports = {
  createMinecraftRegisterHandler,
  createMinecraftRegisterInteractionHandler,
  syncMinecraftRegistrationRolesFromStore,
  syncMinecraftRoleForMember
};
