const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField
} = require('discord.js');
const {
  MINECRAFT_REGISTER_ROLE_ID,
  MINECRAFT_REGISTER_PENDING_ROLE_ID,
  MINECRAFT_REGISTER_RESET_ADMIN_ID,
  MINECRAFT_INFO_CHANNEL_ID,
  MINECRAFT_INFO_URL
} = require('../config');

const GAMERTAG_REGEX = /^[A-Za-z0-9_ ]{3,32}$/;
const LIST_PAGE_SIZE = 10;
const LIST_BUTTON_PREFIX = 'mcreglist';
const COMMAND_CLEANUP_DELAY_MS = 60 * 1000;
const BOT_CLEANUP_SCAN_LIMIT = 50;
const MINECRAFT_REPLY_MARKERS = [
  'Kamu sudah terdaftar.',
  'Gamertag tersimpan:',
  'Registrasi berhasil.',
  'Gamertag berhasil diubah',
  'Command `!req` salah.',
  'Total Regist:',
  'Belum ada user yang terdaftar.',
  'Halaman ',
  'List Registrasi Minecraft',
  'Sistem registrasi belum aktif.',
  'Gagal menyimpan',
  'Gagal memberi role registrasi',
  'Gagal mencabut role registrasi',
  'Kamu sudah keluar dari registrasi Minecraft',
  'Register Minecraft direset.',
  'Format: `!reg',
  'Format: `!edit-reg'
];

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildCommandPattern(command) {
  const raw = String(command || '').trim();
  const withoutBang = raw.startsWith('!') ? raw.slice(1) : raw;
  const commandBody = withoutBang
    .split('-')
    .map(part => escapeRegExp(part))
    .join('\\s*-\\s*');
  return `!\\s*${commandBody}`;
}

function parseSingleArgCommand(content, command) {
  const pattern = new RegExp(`^${buildCommandPattern(command)}(?:\\s+(.+))?$`, 'i');
  const match = String(content || '').trim().match(pattern);
  if (!match) return null;
  return {
    arg: (match[1] || '').trim(),
    hasArg: Boolean(match[1])
  };
}

function parseSingleArgCommandAny(content, commands) {
  for (const command of commands) {
    const parsed = parseSingleArgCommand(content, command);
    if (parsed) return { ...parsed, command };
  }
  return null;
}

function isExactCommand(content, command) {
  const pattern = new RegExp(`^${buildCommandPattern(command)}\\s*$`, 'i');
  return pattern.test(String(content || '').trim());
}

function isMinecraftCommandLike(content) {
  return /^!\s*(?:edit\s*-\s*reg|list\s*-\s*reg|list|req|reg|daftar|register|status|out|reset)(?:\s|$)/i
    .test(String(content || '').trim());
}

function isMinecraftBotMessage(message) {
  const content = String(message?.content || '');
  const embedText = message?.embeds?.map(embed => [
    embed.title,
    embed.description,
    embed.footer?.text
  ].filter(Boolean).join('\n')).join('\n') || '';
  const text = `${content}\n${embedText}`;
  return MINECRAFT_REPLY_MARKERS.some(marker => text.includes(marker));
}

async function cleanupRecentMinecraftBotMessages(msg) {
  // Keep bot replies as permanent audit/history in Discord.
  void msg;
}

function isValidGamertag(gamertag) {
  return GAMERTAG_REGEX.test(gamertag);
}

function normalizeGamertag(gamertag) {
  return String(gamertag || '').replace(/\s+/g, ' ').trim();
}

function isSameGamertag(left, right) {
  return normalizeGamertag(left).toLowerCase() === normalizeGamertag(right).toLowerCase();
}

function gamertagFormatHelp(command = '!reg') {
  return `Format: \`${command} <gamertag_minecraft>\` (3-32 huruf/angka/underscore/spasi).`;
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
  const replyPayload = createNoPingPayload(payload);
  const reply = await msg.channel?.send(replyPayload).catch(() => null) ||
    await msg.reply(replyPayload).catch(() => null);
  return reply;
}

function scheduleCommandCleanup(msg, reply, delayMs = COMMAND_CLEANUP_DELAY_MS) {
  if (!reply?.delete) return;
  const cleanupTimer = setTimeout(() => {
    if (reply?.deletable !== false) {
      void reply.delete?.().catch(() => {});
    }
  }, delayMs);
  cleanupTimer.unref?.();
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

async function syncMinecraftRegistrationRoleState(member, entry, {
  pendingRoleId = MINECRAFT_REGISTER_PENDING_ROLE_ID,
  verifiedRoleId = MINECRAFT_REGISTER_ROLE_ID,
} = {}) {
  if (!member || !entry) return false;
  const verified = Boolean(entry.verified);
  const addRoleId = verified ? verifiedRoleId : pendingRoleId;
  const removeRoleId = verified ? pendingRoleId : verifiedRoleId;
  const added = await addRoleIfMissing(member, addRoleId);
  const removed = addRoleId === removeRoleId ? true : await removeRoleIfPresent(member, removeRoleId);
  return added && removed;
}

async function removeMinecraftRegistrationRoles(member, {
  pendingRoleId = MINECRAFT_REGISTER_PENDING_ROLE_ID,
  verifiedRoleId = MINECRAFT_REGISTER_ROLE_ID,
} = {}) {
  const removedPending = await removeRoleIfPresent(member, pendingRoleId);
  const removedVerified = pendingRoleId === verifiedRoleId
    ? true
    : await removeRoleIfPresent(member, verifiedRoleId);
  return removedPending && removedVerified;
}

async function setNicknameToGamertag(member, gamertag) {
  if (!member || !gamertag) return false;
  if (member.nickname === gamertag) return true;
  if (member.user?.username === gamertag && !member.nickname) return true;

  const botMember = member.guild?.members?.me;
  const canManageNicknames = botMember?.permissions?.has(PermissionsBitField.Flags.ManageNicknames);
  if (!canManageNicknames || member.manageable === false) return false;

  try {
    const updated = await member.setNickname(gamertag, 'Minecraft registration gamertag sync');
    return updated?.nickname === gamertag || member.nickname === gamertag;
  } catch (err) {
    if (err?.code === 50013) return false;
    throw err;
  }
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
  const match = raw.match(new RegExp(`^${buildCommandPattern('!list')}(?:\\s+(\\d+))?$`, 'i'));
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

function buildListButtonId(page) {
  return `${LIST_BUTTON_PREFIX}:${page}`;
}

function parseListButtonId(customId) {
  const raw = String(customId || '');
  if (!raw.startsWith(`${LIST_BUTTON_PREFIX}:`)) return null;
  const [, pageToken] = raw.split(':');
  const page = parseInt(pageToken, 10);
  if (!Number.isFinite(page) || page <= 0) return null;
  return { page };
}

function buildListButtons(page, totalPages) {
  const prevPage = Math.max(1, page - 1);
  const nextPage = Math.min(totalPages, page + 1);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildListButtonId(prevPage))
      .setLabel('Sebelumnya')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(buildListButtonId(nextPage))
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

function buildListResponse(entries, page) {
  const pagination = paginateEntries(entries, page);
  return {
    embeds: [buildListEmbed(entries, pagination)],
    components: [buildListButtons(pagination.page, pagination.totalPages)],
    allowedMentions: { parse: [], repliedUser: false }
  };
}

function buildMinecraftStatusPayload(entry) {
  if (!entry) {
    return {
      embeds: [
        new EmbedBuilder()
          .setColor(0xe74c3c)
          .setTitle('🎮 Status Minecraft')
          .setDescription('Akun Discord kamu belum punya data register Minecraft.')
          .addFields({
            name: 'Mulai daftar',
            value: 'Pakai `!reg <gamertag>` atau `!daftar <gamertag>` sesuai nama Minecraft kamu.',
          }),
      ],
      allowedMentions: { parse: [], repliedUser: false },
    };
  }

  const verified = Boolean(entry.verified);
  const lines = [
    `Gamertag: \`${entry.gamertag || '-'}\``,
    `Status: ${verified ? '✅ Terdaftar + verified' : '🟢 Terdaftar'}`,
    `Daftar: ${formatDateId(entry.registeredAt)}`,
    `Update: ${formatDateId(entry.updatedAt || entry.registeredAt)}`,
  ];
  if (entry.verifiedAt) lines.push(`Verified: ${formatDateId(entry.verifiedAt)}`);
  if (entry.lastSeenName) lines.push(`Last seen: \`${entry.lastSeenName}\``);

  const embed = new EmbedBuilder()
    .setColor(verified ? 0x2ecc71 : 0xf2c94c)
    .setTitle('🎮 Status Minecraft')
    .setDescription(lines.join('\n'))
    .setFooter({
      text: verified
        ? 'Akun sudah terdaftar dan terkunci ke Minecraft asli.'
        : 'Sudah terdaftar. Join server dengan gamertag yang sama; !verify opsional untuk mengunci akun.',
    });

  return {
    embeds: [embed],
    allowedMentions: { parse: [], repliedUser: false },
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
    pendingRoleId = MINECRAFT_REGISTER_PENDING_ROLE_ID,
    verifiedRoleId = MINECRAFT_REGISTER_ROLE_ID,
    infoChannelId = MINECRAFT_INFO_CHANNEL_ID,
    infoUrl = MINECRAFT_INFO_URL
  } = options;
  const parsed = parseSingleArgCommandAny(msg.content, ['!reg', '!daftar', '!register']);
  if (!parsed) return false;
  if (!msg.guild) return false;
  if (!parsed.hasArg) {
    await replyNoPing(
      msg,
      [
        gamertagFormatHelp(parsed.command || '!reg'),
        'Command ini sekarang terhubung ke register Minecraft, bukan private Discord.',
      ].join('\n')
    );
    return true;
  }

  const gamertag = normalizeGamertag(parsed.arg);
  if (!isValidGamertag(gamertag)) {
    await replyNoPing(msg, gamertagFormatHelp(parsed.command || '!reg'));
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

  const existing = registerStore.getUser(msg.author.id);
  if (existing) {
    const previousGamertag = existing.gamertag;
    const duplicate = registerStore.findUserByGamertag?.(gamertag, msg.author.id);
    if (duplicate) {
      await replyNoPing(
        msg,
        `Gamertag \`${gamertag}\` sudah dipakai oleh <@${duplicate.userId}>. Pakai gamertag lain.`
      );
      return true;
    }

    let updated = null;
    try {
      updated = await registerStore.updateUser(
        msg.author.id,
        gamertag,
        msg.author?.tag || msg.author?.username || ''
      );
    } catch (err) {
      console.error('Failed to save minecraft registration update from !reg:', err);
      await replyNoPing(msg, 'Gagal menyimpan perubahan gamertag ke channel save. Coba lagi atau hubungi admin.');
      return true;
    }

    if (updated?.duplicate) {
      await replyNoPing(
        msg,
        `Gamertag \`${gamertag}\` sudah dipakai oleh <@${updated.duplicateUserId}>. Pakai gamertag lain.`
      );
      return true;
    }
    if (!updated) {
      await replyNoPing(msg, 'Data registrasi tidak ditemukan. Pakai `!reg <gamertag_minecraft>` dulu.');
      return true;
    }

    const roleOk = await syncMinecraftRegistrationRoleState(member, updated, { pendingRoleId, verifiedRoleId });
    if (!roleOk) {
      await replyNoPing(msg, 'Gamertag sudah disimpan, tapi role Discord gagal diupdate. Hubungi admin.');
      return true;
    }

    const nicknameOk = await setNicknameToGamertag(member, updated.gamertag).catch(err => {
      console.error('Failed to set Minecraft registration nickname:', err);
      return false;
    });
    const nicknameNote = nicknameOk
      ? 'Nickname Discord sudah diubah ke gamertag.'
      : 'Catatan: nickname Discord gagal diubah otomatis. Cek permission dan posisi role bot.';
    const changed = !isSameGamertag(previousGamertag, updated.gamertag);
    const verifyLine = changed
      ? 'Join server dengan gamertag baru itu. `!verify` opsional untuk mengunci akun ke Minecraft asli.'
      : 'Join server dengan gamertag yang sama. `!verify` opsional untuk keamanan ekstra.';

    await replyNoPing(
      msg,
      [
        changed
          ? `Gamertag berhasil diubah dari \`${previousGamertag}\` ke \`${updated.gamertag}\`.`
          : `Gamertag kamu tetap: \`${updated.gamertag}\`.`,
        verifyLine,
        nicknameNote,
        getInfoLine(infoChannelId, infoUrl)
      ].join('\n')
    );
    return true;
  }

  let result = null;
  try {
    result = await registerStore.registerUser(
      msg.author.id,
      gamertag,
      msg.author?.tag || msg.author?.username || ''
    );
  } catch (err) {
    console.error('Failed to save minecraft registration:', err);
    await replyNoPing(msg, 'Gagal menyimpan data register ke channel save. Coba lagi atau hubungi admin.');
    return true;
  }

  if (result.duplicate) {
    await replyNoPing(
      msg,
      `Gamertag \`${gamertag}\` sudah dipakai oleh <@${result.duplicateUserId}>. Pakai gamertag lain.`
    );
    return true;
  }

  if (!result.created) {
    const roleOk = await syncMinecraftRegistrationRoleState(member, result.entry, { pendingRoleId, verifiedRoleId });
    const nicknameOk = await setNicknameToGamertag(member, result.entry.gamertag).catch(err => {
      console.error('Failed to set Minecraft registration nickname:', err);
      return false;
    });
    const roleNote = roleOk
      ? ''
      : '\nCatatan: data kamu sudah ada, tapi role registrasi gagal diberikan otomatis.';
    const nicknameNote = nicknameOk
      ? ''
      : '\nCatatan: data kamu sudah ada, tapi nickname Discord gagal diubah otomatis.';
    await replyNoPing(
      msg,
      [
        'Kamu sudah terdaftar.',
        formatExistingRegistration(result.entry),
        `Untuk ganti gamertag, pakai \`!reg ${gamertag}\` atau \`!edit-reg ${gamertag}\`.`,
        'Join server dengan gamertag yang sama. Untuk mengunci akun ke Minecraft asli, opsional pakai `!verify`.',
        getInfoLine(infoChannelId, infoUrl) + roleNote + nicknameNote
      ].join('\n')
    );
    return true;
  }

  const roleOk = await syncMinecraftRegistrationRoleState(member, result.entry, { pendingRoleId, verifiedRoleId });
  if (!roleOk) {
    const rolledBack = await registerStore.removeUser(msg.author.id)
      .then(() => true)
      .catch(() => false);
    const dataNote = rolledBack
      ? 'Data baru sudah dibatalkan.'
      : 'Data sempat tersimpan tapi gagal dibatalkan otomatis, hubungi admin.';
    await replyNoPing(
      msg,
      `Gagal memberi role registrasi. ${dataNote} Cek permission dan posisi role bot.`
    );
    return true;
  }

  const nicknameOk = await setNicknameToGamertag(member, gamertag).catch(err => {
    console.error('Failed to set Minecraft registration nickname:', err);
    return false;
  });
  const nicknameNote = nicknameOk
    ? 'Nickname Discord sudah diubah ke gamertag.'
    : 'Catatan: nickname Discord gagal diubah otomatis. Cek permission dan posisi role bot.';

  await replyNoPing(
    msg,
    [
      `Registrasi berhasil. Gamertag kamu: \`${gamertag}\`.`,
      'Role registrasi sudah diberikan.',
      'Sekarang join server dengan gamertag yang sama. `!verify` opsional untuk keamanan ekstra.',
      nicknameNote,
      getInfoLine(infoChannelId, infoUrl)
    ].join('\n')
  );
  return true;
}

async function handleMinecraftReqTypoCommand(msg) {
  const parsed = parseSingleArgCommand(msg.content, '!req');
  if (!parsed) return false;
  if (!msg.guild) return false;

  await replyNoPing(
    msg,
    [
      'Command `!req` salah.',
      'Untuk daftar Minecraft, pakai `!reg <gamertag_minecraft>`.',
      'Contoh: `!reg Steve123`'
    ].join('\n')
  );
  return true;
}

async function handleMinecraftEditRegCommand(msg, options) {
  const {
    registerStore,
    pendingRoleId = MINECRAFT_REGISTER_PENDING_ROLE_ID,
    verifiedRoleId = MINECRAFT_REGISTER_ROLE_ID,
    infoChannelId = MINECRAFT_INFO_CHANNEL_ID,
    infoUrl = MINECRAFT_INFO_URL
  } = options;
  const parsed = parseSingleArgCommand(msg.content, '!edit-reg');
  if (!parsed) return false;
  if (!msg.guild) return false;

  const gamertag = normalizeGamertag(parsed.arg);
  if (!parsed.hasArg || !isValidGamertag(gamertag)) {
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

  const duplicate = registerStore.findUserByGamertag?.(gamertag, msg.author.id);
  if (duplicate) {
    await replyNoPing(
      msg,
      `Gamertag \`${gamertag}\` sudah dipakai oleh <@${duplicate.userId}>. Pakai gamertag lain.`
    );
    return true;
  }

  const member = await resolveMember(msg);
  let updated = null;
  try {
    updated = await registerStore.updateUser(
      msg.author.id,
      gamertag,
      msg.author?.tag || msg.author?.username || ''
    );
  } catch (err) {
    console.error('Failed to save minecraft registration edit:', err);
    await replyNoPing(msg, 'Gagal menyimpan perubahan gamertag ke channel save. Coba lagi atau hubungi admin.');
    return true;
  }
  if (updated?.duplicate) {
    await replyNoPing(
      msg,
      `Gamertag \`${gamertag}\` sudah dipakai oleh <@${updated.duplicateUserId}>. Pakai gamertag lain.`
    );
    return true;
  }
  if (!updated) {
    await replyNoPing(msg, 'Data registrasi tidak ditemukan. Pakai `!reg <gamertag_minecraft>` dulu.');
    return true;
  }

  const roleOk = await syncMinecraftRegistrationRoleState(member, updated, { pendingRoleId, verifiedRoleId });
  if (!roleOk) {
    await replyNoPing(msg, 'Gamertag sudah disimpan, tapi role Discord gagal diupdate. Hubungi admin.');
    return true;
  }

  const nicknameOk = await setNicknameToGamertag(member, updated.gamertag).catch(err => {
    console.error('Failed to set Minecraft registration nickname:', err);
    return false;
  });
  const nicknameNote = nicknameOk
    ? 'Nickname Discord sudah diubah ke gamertag.'
    : 'Catatan: nickname Discord gagal diubah otomatis. Cek permission dan posisi role bot.';

  await replyNoPing(
    msg,
    [
      `Gamertag berhasil diubah dari \`${existing.gamertag}\` ke \`${updated.gamertag}\`.`,
      'Join server dengan gamertag baru itu. `!verify` opsional untuk mengunci akun ke Minecraft asli.',
      nicknameNote,
      getInfoLine(infoChannelId, infoUrl)
    ].join('\n')
  );
  return true;
}

async function handleMinecraftOutCommand(msg, options) {
  const {
    registerStore,
    pendingRoleId = MINECRAFT_REGISTER_PENDING_ROLE_ID,
    verifiedRoleId = MINECRAFT_REGISTER_ROLE_ID,
  } = options;
  if (!isExactCommand(msg.content, '!out')) return false;
  if (!msg.guild) return false;

  const ready = await ensureRegisterStore(registerStore, msg.client);
  if (!ready) {
    await replyNoPing(msg, 'Sistem registrasi belum aktif. Hubungi admin.');
    return true;
  }

  const member = await resolveMember(msg);
  const hadData = Boolean(registerStore.getUser(msg.author.id));
  const hadRole = Boolean(
    (pendingRoleId && member?.roles?.cache?.has(pendingRoleId)) ||
    (verifiedRoleId && member?.roles?.cache?.has(verifiedRoleId))
  );

  if (!hadData && !hadRole) {
    await replyNoPing(msg, 'Kamu belum terdaftar di registrasi Minecraft.');
    return true;
  }

  const removedRole = await removeMinecraftRegistrationRoles(member, { pendingRoleId, verifiedRoleId });
  if (!removedRole) {
    await replyNoPing(msg, 'Gagal mencabut role registrasi. Hubungi admin.');
    return true;
  }

  if (hadData) {
    try {
      await registerStore.removeUser(msg.author.id);
    } catch (err) {
      console.error('Failed to remove minecraft registration:', err);
      await replyNoPing(msg, 'Role sudah dicabut, tapi data register gagal dihapus dari channel save. Hubungi admin.');
      return true;
    }
  }

  await replyNoPing(msg, 'Kamu sudah keluar dari registrasi Minecraft. Role dicabut dan data reg dihapus.');
  return true;
}

async function handleMinecraftResetCommand(msg, options) {
  const {
    registerStore,
    pendingRoleId = MINECRAFT_REGISTER_PENDING_ROLE_ID,
    verifiedRoleId = MINECRAFT_REGISTER_ROLE_ID,
    resetAdminId = MINECRAFT_REGISTER_RESET_ADMIN_ID
  } = options;
  if (!isExactCommand(msg.content, '!reset')) return false;
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

    const hadRole = Boolean(
      (pendingRoleId && member.roles.cache.has(pendingRoleId)) ||
      (verifiedRoleId && member.roles.cache.has(verifiedRoleId))
    );
    const removed = await removeMinecraftRegistrationRoles(member, { pendingRoleId, verifiedRoleId });
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

  try {
    await registerStore.resetAll();
  } catch (err) {
    console.error('Failed to reset minecraft registration data:', err);
    await replyNoPing(msg, 'Role sudah diproses, tapi data register gagal direset di channel save. Coba lagi atau cek permission bot.');
    return true;
  }
  await replyNoPing(
    msg,
    [
      `Register Minecraft direset. Data terhapus: ${entries.length}.`,
      `Role dicabut: ${rolesRemoved}. Tanpa role: ${noRole}. Tidak ditemukan: ${skipped}. Gagal: ${failed}.`
    ].join('\n')
  );
  return true;
}

async function handleMinecraftTotalRegCommand(msg, options) {
  const { registerStore } = options;
  if (!isExactCommand(msg.content, '!list-reg')) return false;
  if (!msg.guild) return false;

  const ready = await ensureRegisterStore(registerStore, msg.client);
  if (!ready) {
    await replyNoPing(msg, 'Sistem registrasi belum aktif. Hubungi admin.');
    return true;
  }

  await replyNoPing(msg, `Total Regist: ${registerStore.getTotal()}`);
  return true;
}

async function handleMinecraftStatusCommand(msg, options) {
  const { registerStore } = options;
  if (!isExactCommand(msg.content, '!status')) return false;
  if (!msg.guild) return false;

  const ready = await ensureRegisterStore(registerStore, msg.client);
  if (!ready) {
    await replyNoPing(msg, 'Sistem registrasi belum aktif. Hubungi admin.');
    return true;
  }

  await replyNoPing(msg, buildMinecraftStatusPayload(registerStore.getUser(msg.author.id)));
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

  await replyNoPing(msg, buildListResponse(entries, page));
  return true;
}

function createMinecraftRegisterHandler({
  registerStore,
  pendingRoleId = MINECRAFT_REGISTER_PENDING_ROLE_ID,
  verifiedRoleId = MINECRAFT_REGISTER_ROLE_ID,
  resetAdminId = MINECRAFT_REGISTER_RESET_ADMIN_ID,
  infoChannelId = MINECRAFT_INFO_CHANNEL_ID,
  infoUrl = MINECRAFT_INFO_URL
}) {
  return async function handleMinecraftRegisterMessage(msg) {
    try {
      if (!msg || msg.author?.bot) return false;
      if (!msg.guild) return false;
      const isMinecraftCommand = isMinecraftCommandLike(msg.content);
      if (isMinecraftCommand) {
        await cleanupRecentMinecraftBotMessages(msg);
      }

      const options = { registerStore, pendingRoleId, verifiedRoleId, resetAdminId, infoChannelId, infoUrl };

      const handledEdit = await handleMinecraftEditRegCommand(msg, options);
      if (handledEdit) return true;

      const handledReset = await handleMinecraftResetCommand(msg, options);
      if (handledReset) return true;

      const handledOut = await handleMinecraftOutCommand(msg, options);
      if (handledOut) return true;

      const handledTotalReg = await handleMinecraftTotalRegCommand(msg, options);
      if (handledTotalReg) return true;

      const handledStatus = await handleMinecraftStatusCommand(msg, options);
      if (handledStatus) return true;

      const handledList = await handleMinecraftListCommand(msg, options);
      if (handledList) return true;

      const handledReqTypo = await handleMinecraftReqTypoCommand(msg);
      if (handledReqTypo) return true;

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
        payload.page
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
  roleIds = {}
) {
  if (!member || member.user?.bot || !registerStore) return false;
  await registerStore.init(member.client);
  const entry = registerStore.getUser(member.id);
  if (!entry) return false;
  const roleOk = await syncMinecraftRegistrationRoleState(member, entry, roleIds);
  await setNicknameToGamertag(member, entry.gamertag).catch(err => {
    console.error('Failed to sync minecraft nickname for joined member:', err);
  });
  return roleOk;
}

async function syncMinecraftRegistrationRolesFromStore(
  client,
  registerStore,
  roleIds = {}
) {
  const {
    pendingRoleId = MINECRAFT_REGISTER_PENDING_ROLE_ID,
    verifiedRoleId = MINECRAFT_REGISTER_ROLE_ID,
  } = roleIds || {};

  if (!client || !registerStore || (!pendingRoleId && !verifiedRoleId)) {
    return { scanned: 0, synced: 0, failed: 0, skipped: 0 };
  }

  await registerStore.init(client);
  const entries = registerStore.getEntries();
  const cleanup = registerStore.getLastCleanup?.() || { removedDuplicateUserIds: [] };
  const stats = {
    scanned: entries.length,
    synced: 0,
    failed: 0,
    skipped: 0,
    duplicateEntriesRemoved: cleanup.removedDuplicateUserIds.length,
    duplicateRolesRemoved: 0,
    duplicateRoleRemoveFailed: 0
  };

  for (const userId of cleanup.removedDuplicateUserIds) {
    const member = await findMemberAcrossGuilds(client, userId);
    if (!member) continue;
    const removed = await removeMinecraftRegistrationRoles(member, { pendingRoleId, verifiedRoleId });
    if (removed) {
      stats.duplicateRolesRemoved += 1;
    } else {
      stats.duplicateRoleRemoveFailed += 1;
    }
  }
  registerStore.clearLastCleanup?.();

  for (const entry of entries) {
    const member = await findMemberAcrossGuilds(client, entry.userId);
    if (!member) {
      stats.skipped += 1;
      continue;
    }

    const ok = await syncMinecraftRegistrationRoleState(member, entry, { pendingRoleId, verifiedRoleId });
    await setNicknameToGamertag(member, entry.gamertag).catch(err => {
      console.error('Failed to sync minecraft nickname from store:', err);
    });
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
