const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionsBitField,
} = require('discord.js');
const {
  INTERVIEW_ADMIN_ROLE_IDS,
  INTERVIEW_CATEGORY_ID,
  MINECRAFT_REGISTER_PENDING_ROLE_ID,
  MINECRAFT_REGISTER_REJECTED_ROLE_ID,
  MINECRAFT_REGISTER_RESET_ADMIN_ID,
  MINECRAFT_REGISTER_ROLE_ID,
  PRIVATE_CHAT_CHANNEL_ID,
  REGISTRATION_INBOX_CHANNEL_ID,
  TOPUP_ADMIN_DISCORD_ID,
} = require('../config');
const { isAdmin } = require('../utils/permissions');
const { createRizebotHelpPayload } = require('./helpPayload');
const {
  moveMemberToCitizenRole,
  syncEthergeonCitizenRoles,
} = require('./ethergeonCitizenRoleHandler');

const GAMERTAG_REGEX = /^[A-Za-z0-9_ ]{3,32}$/;
const LIST_PAGE_SIZE = 10;
const LIST_BUTTON_PREFIX = 'citizenlist';
const INTERVIEW_BUTTON_PREFIX = 'interview';

function noPing(payload) {
  if (typeof payload === 'string') {
    return { content: payload, allowedMentions: { parse: [], repliedUser: false } };
  }
  return {
    ...payload,
    allowedMentions: payload.allowedMentions || { parse: [], repliedUser: false },
  };
}

async function replyNoPing(msg, payload) {
  return msg.reply(noPing(payload)).catch(() => null);
}

function normalizeGamertag(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function gamertagKey(value) {
  return normalizeGamertag(value).toLowerCase();
}

function isValidGamertag(value) {
  return GAMERTAG_REGEX.test(normalizeGamertag(value));
}

function parseRegisterCommand(content) {
  const match = String(content || '').trim().match(/^!(?:reg|daftar|register)(?:\s+(.+))?$/i);
  if (!match) return null;
  return normalizeGamertag(match[1] || '');
}

function parseListCommand(content) {
  const match = String(content || '').trim().match(/^!list(?:\s+(\d+))?$/i);
  if (!match) return null;
  const page = match[1] ? parseInt(match[1], 10) : 1;
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function formatDateId(iso) {
  if (!iso) return '-';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('id-ID', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Jakarta',
    }).format(parsed);
  } catch {
    return parsed.toISOString();
  }
}

async function ensureRegisterStore(registerStore, client) {
  if (!registerStore) return false;
  await registerStore.init(client);
  return true;
}

async function resolveMember(target) {
  if (target.member) return target.member;
  const userId = target.author?.id || target.user?.id;
  if (!userId) return null;
  return target.guild?.members.fetch(userId).catch(() => null);
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
  return Boolean(updated?.roles?.cache?.has(roleId) || member.roles.cache.has(roleId));
}

async function removeRoleIfPresent(member, roleId) {
  if (!member || !roleId) return true;
  if (!member.roles.cache.has(roleId)) return true;
  const role = await fetchRole(member.guild, roleId);
  if (!role) return false;
  const updated = await member.roles.remove(role).catch(() => null);
  return Boolean((updated?.roles?.cache && !updated.roles.cache.has(roleId)) || !member.roles.cache.has(roleId));
}

async function moveMemberToPendingRole(member, {
  pendingRoleId = MINECRAFT_REGISTER_PENDING_ROLE_ID,
  verifiedRoleId = MINECRAFT_REGISTER_ROLE_ID,
  rejectedRoleId = MINECRAFT_REGISTER_REJECTED_ROLE_ID,
} = {}) {
  const addedPending = await addRoleIfMissing(member, pendingRoleId);
  const removedVerified = pendingRoleId === verifiedRoleId ? true : await removeRoleIfPresent(member, verifiedRoleId);
  const removedRejected = pendingRoleId === rejectedRoleId ? true : await removeRoleIfPresent(member, rejectedRoleId);
  return addedPending && removedVerified && removedRejected;
}

async function clearMinecraftRegistrationRoles(member, {
  pendingRoleId = MINECRAFT_REGISTER_PENDING_ROLE_ID,
  verifiedRoleId = MINECRAFT_REGISTER_ROLE_ID,
  rejectedRoleId = MINECRAFT_REGISTER_REJECTED_ROLE_ID,
} = {}) {
  const removedPending = await removeRoleIfPresent(member, pendingRoleId);
  const removedVerified = pendingRoleId === verifiedRoleId ? true : await removeRoleIfPresent(member, verifiedRoleId);
  const removedRejected = rejectedRoleId === pendingRoleId || rejectedRoleId === verifiedRoleId
    ? true
    : await removeRoleIfPresent(member, rejectedRoleId);
  return removedPending && removedVerified && removedRejected;
}

async function moveMemberToRejectedRole(member, {
  rejectedRoleId = MINECRAFT_REGISTER_REJECTED_ROLE_ID,
  pendingRoleId = MINECRAFT_REGISTER_PENDING_ROLE_ID,
  verifiedRoleId = MINECRAFT_REGISTER_ROLE_ID,
} = {}) {
  const addedRejected = await addRoleIfMissing(member, rejectedRoleId);
  const removedPending = rejectedRoleId === pendingRoleId ? true : await removeRoleIfPresent(member, pendingRoleId);
  const removedVerified = rejectedRoleId === verifiedRoleId ? true : await removeRoleIfPresent(member, verifiedRoleId);
  return addedRejected && removedPending && removedVerified;
}

function isRegisterAdmin(target) {
  return isAdmin(target?.member) ||
    String(target?.author?.id || target?.user?.id || '') === String(TOPUP_ADMIN_DISCORD_ID) ||
    String(target?.author?.id || target?.user?.id || '') === String(MINECRAFT_REGISTER_RESET_ADMIN_ID);
}

function memberHasAnyRole(member, roleIds) {
  if (!member || !roleIds?.size) return false;
  const roles = member.roles;
  if (roles?.cache) {
    for (const roleId of roleIds) {
      if (roles.cache.has(roleId)) return true;
    }
    return false;
  }
  if (Array.isArray(roles)) {
    return roles.some(roleId => roleIds.has(String(roleId)));
  }
  return false;
}

function isInterviewAdmin(target) {
  return isRegisterAdmin(target) || memberHasAnyRole(target?.member, INTERVIEW_ADMIN_ROLE_IDS);
}

function adminUserIds() {
  return [...new Set([TOPUP_ADMIN_DISCORD_ID, MINECRAFT_REGISTER_RESET_ADMIN_ID].filter(Boolean))];
}

function statusLabel(statusRaw) {
  const status = String(statusRaw || '').toLowerCase();
  if (status === 'approved') return 'LEGAL';
  if (status === 'rejected') return 'GAGAL - BISA COBA LAGI';
  return 'PENDING INTERVIEW';
}

function statusColor(statusRaw) {
  const status = String(statusRaw || '').toLowerCase();
  if (status === 'approved') return 0x2ecc71;
  if (status === 'rejected') return 0xe74c3c;
  return 0xf2c94c;
}

function buildInterviewButtonId(action, userId) {
  return `${INTERVIEW_BUTTON_PREFIX}:${action}:${userId}`;
}

function parseInterviewButtonId(customId) {
  const match = String(customId || '').match(/^interview:(approve|reject|close):(\d{5,32})$/);
  if (!match) return null;
  return { action: match[1], userId: match[2] };
}

function buildInterviewButtons(userId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildInterviewButtonId('approve', userId))
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(buildInterviewButtonId('reject', userId))
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(buildInterviewButtonId('close', userId))
      .setLabel('Close Interview')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );
}

function buildInterviewEmbed(entry, user) {
  const status = statusLabel(entry?.status);
  return new EmbedBuilder()
    .setColor(statusColor(entry?.status))
    .setTitle(`${entry?.interviewId || 'interview'} | Minecraft Access Interview`)
    .setDescription([
      `Applicant: ${user ? `<@${user.id}>` : '-'}`,
      `Discord ID: \`${user?.id || '-'}\``,
      `Gamertag: \`${entry?.gamertag || '-'}\``,
      `Status: **${status}**`,
      `Registered: ${formatDateId(entry?.registeredAt)}`,
    ].join('\n'))
    .setFooter({ text: 'Admin: approve jika interview lolos. Close untuk mengunci channel.' })
    .setTimestamp(new Date());
}

function buildStatusPayload(entry, user) {
  if (!entry) {
    return noPing({
      embeds: [
        new EmbedBuilder()
          .setColor(0xe74c3c)
          .setTitle('Ethergeon ID Card')
          .setDescription([
            'Status: **BELUM REGISTER**',
            'Daftar dulu dengan `!register <gamertag_minecraft>`.',
          ].join('\n'))
          .setTimestamp(new Date()),
      ],
    });
  }

  const fields = [
    { name: 'Discord', value: user ? `<@${user.id}>` : `\`${entry.userId || '-'}\``, inline: true },
    { name: 'Gamertag', value: `\`${entry.gamertag || '-'}\``, inline: true },
    { name: 'Access', value: statusLabel(entry.status), inline: true },
    { name: 'Interview', value: entry.interviewId || '-', inline: true },
    { name: 'Registered', value: formatDateId(entry.registeredAt), inline: true },
    { name: 'Updated', value: formatDateId(entry.updatedAt), inline: true },
  ];
  if (entry.approvedAt) {
    fields.push({
      name: 'Approved',
      value: `${formatDateId(entry.approvedAt)}${entry.approvedBy ? ` oleh <@${entry.approvedBy}>` : ''}`,
      inline: false,
    });
  }
  if (entry.rejectedAt) {
    fields.push({
      name: 'Rejected',
      value: `${formatDateId(entry.rejectedAt)}${entry.rejectedBy ? ` oleh <@${entry.rejectedBy}>` : ''}`,
      inline: false,
    });
  }
  if (entry.lastSeenName || entry.lastSeenAt) {
    fields.push({
      name: 'Minecraft Seen',
      value: `Last seen: \`${entry.lastSeenName || '-'}\`\nWaktu: ${formatDateId(entry.lastSeenAt)}`,
      inline: false,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(statusColor(entry.status))
    .setTitle('Ethergeon ID Card')
    .addFields(fields)
    .setFooter({
      text: entry.status === 'approved'
        ? 'Legal access aktif. Join Minecraft dengan gamertag yang tertera.'
        : entry.status === 'rejected'
          ? 'Belum lolos interview. Kamu masih bisa coba lagi dengan register ulang.'
          : 'Akses Minecraft aktif setelah interview di-approve admin.',
    })
    .setTimestamp(new Date());

  return noPing({ embeds: [embed] });
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
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildListButtonId(Math.max(1, page - 1)))
      .setLabel('Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(buildListButtonId(Math.min(totalPages, page + 1)))
      .setLabel('Next')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page >= totalPages)
  );
}

function buildListPayload(entries, page) {
  const totalPages = Math.max(1, Math.ceil(entries.length / LIST_PAGE_SIZE));
  const safePage = Math.min(Math.max(Number(page) || 1, 1), totalPages);
  const start = (safePage - 1) * LIST_PAGE_SIZE;
  const rows = entries.slice(start, start + LIST_PAGE_SIZE).map((entry, index) => (
    `${start + index + 1}. ${statusLabel(entry.status)} | \`${entry.gamertag}\` | <@${entry.userId}> | ${entry.interviewId || '-'}`
  ));

  const embed = new EmbedBuilder()
    .setColor(0x36a269)
    .setTitle('Daftar Register Minecraft')
    .setDescription(rows.join('\n') || 'Belum ada registrasi baru.')
    .setFooter({ text: `Halaman ${safePage}/${totalPages} | Total ${entries.length}` })
    .setTimestamp(new Date());

  return noPing({
    embeds: [embed],
    components: totalPages > 1 ? [buildListButtons(safePage, totalPages)] : [],
  });
}

function channelMention(channelId) {
  return channelId ? `<#${channelId}>` : 'channel interview';
}

async function createInterviewChannel(msg, interviewId, applicant) {
  const guild = msg.guild;
  const botId = guild.members.me?.id || msg.client.user?.id;
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionsBitField.Flags.ViewChannel],
    },
    {
      id: applicant.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AttachFiles,
        PermissionsBitField.Flags.EmbedLinks,
      ],
    },
  ];

  if (botId) {
    overwrites.push({
      id: botId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.ManageChannels,
        PermissionsBitField.Flags.ManageMessages,
        PermissionsBitField.Flags.EmbedLinks,
      ],
    });
  }

  for (const roleId of INTERVIEW_ADMIN_ROLE_IDS || []) {
    overwrites.push({
      id: roleId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.EmbedLinks,
      ],
    });
  }

  for (const userId of adminUserIds()) {
    if (String(userId) === String(applicant.id)) continue;
    overwrites.push({
      id: userId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.EmbedLinks,
      ],
    });
  }

  const options = {
    name: interviewId,
    type: ChannelType.GuildText,
    permissionOverwrites: overwrites,
    reason: `Minecraft access interview for ${applicant.id}`,
  };
  if (INTERVIEW_CATEGORY_ID) options.parent = INTERVIEW_CATEGORY_ID;
  return guild.channels.create(options);
}

async function handleRegisterCommand(msg, options) {
  const gamertag = parseRegisterCommand(msg.content);
  if (gamertag === null) return false;
  if (!gamertag || !isValidGamertag(gamertag)) {
    await replyNoPing(msg, 'Format: `!register <gamertag_minecraft>` (3-32 huruf/angka/underscore/spasi).');
    return true;
  }

  const { registerStore, pendingRoleId, verifiedRoleId, rejectedRoleId } = options;
  if (!await ensureRegisterStore(registerStore, msg.client)) {
    await replyNoPing(msg, 'Sistem register belum aktif. Hubungi admin.');
    return true;
  }

  const member = await resolveMember(msg);
  if (!member) {
    await replyNoPing(msg, 'Gagal membaca data member kamu, coba lagi.');
    return true;
  }

  const existing = registerStore.getUser(msg.author.id);
  if (existing?.status === 'approved') {
    await replyNoPing(msg, buildStatusPayload({ ...existing, userId: msg.author.id }, msg.author));
    return true;
  }
  if (existing?.status === 'pending' && existing.interviewChannelId) {
    await replyNoPing(
      msg,
      `Kamu sudah punya interview aktif: ${channelMention(existing.interviewChannelId)}. Lanjutkan di sana.`
    );
    return true;
  }

  const duplicate = registerStore.findUserByGamertag?.(gamertag, msg.author.id);
  if (duplicate) {
    await replyNoPing(msg, `Gamertag \`${gamertag}\` sudah dipakai oleh user lain.`);
    return true;
  }

  const interviewId = await registerStore.nextInterviewId();
  const channel = await createInterviewChannel(msg, interviewId, msg.author).catch(err => {
    console.error('Failed to create interview channel:', err);
    return null;
  });
  if (!channel) {
    await replyNoPing(msg, 'Gagal membuat channel interview. Cek permission bot Manage Channels.');
    return true;
  }

  const saved = await registerStore.upsertPendingUser(
    msg.author.id,
    gamertag,
    msg.author?.tag || msg.author?.username || '',
    {
      interviewId,
      interviewChannelId: channel.id,
      interviewCreatedAt: new Date().toISOString(),
    }
  );
  if (saved?.duplicate) {
    await channel.delete('Duplicate Minecraft gamertag registration').catch(() => null);
    await replyNoPing(msg, `Gamertag \`${gamertag}\` sudah dipakai oleh user lain.`);
    return true;
  }

  await moveMemberToPendingRole(member, { pendingRoleId, verifiedRoleId, rejectedRoleId }).catch(err => {
    console.error('Failed to set pending register role:', err);
    return false;
  });

  const entry = { ...saved.entry, userId: msg.author.id };
  await channel.send({
    content: `<@${msg.author.id}> interview akses Minecraft kamu dimulai di sini. Admin akan meninjau sebelum akses legal diberikan.`,
    embeds: [buildInterviewEmbed(entry, msg.author)],
    components: [buildInterviewButtons(msg.author.id)],
    allowedMentions: { users: [msg.author.id], roles: [] },
  }).catch(err => {
    console.error('Failed to send interview intro:', err);
  });

  await replyNoPing(
    msg,
    `Register diterima. Channel interview kamu: ${channelMention(channel.id)}.`
  );
  return true;
}

async function handleStatusCommand(msg, options) {
  if (!/^!status\b/i.test(String(msg.content || '').trim())) return false;
  if (!await ensureRegisterStore(options.registerStore, msg.client)) {
    await replyNoPing(msg, 'Sistem register belum aktif. Hubungi admin.');
    return true;
  }
  const entry = options.registerStore.getUser(msg.author.id);
  await replyNoPing(msg, buildStatusPayload(entry ? { ...entry, userId: msg.author.id } : null, msg.author));
  return true;
}

async function handleListCommand(msg, options) {
  const page = parseListCommand(msg.content);
  if (!page) return false;
  if (!isRegisterAdmin(msg)) {
    await replyNoPing(msg, 'Command list register khusus admin.');
    return true;
  }
  if (!await ensureRegisterStore(options.registerStore, msg.client)) {
    await replyNoPing(msg, 'Sistem register belum aktif. Hubungi admin.');
    return true;
  }
  await replyNoPing(msg, buildListPayload(options.registerStore.getEntries(), page));
  return true;
}

async function handleHelpCommand(msg, options) {
  const content = String(msg.content || '').trim();
  if (!/^!help\b/i.test(content)) return false;
  const showAdmin = isRegisterAdmin(msg);
  await replyNoPing(msg, createRizebotHelpPayload({
    showAdmin,
    registrationChannelId: options.registrationChannelId,
    privateChatChannelId: options.privateChatChannelId,
  }));
  return true;
}

async function handleSyncCitizenCommand(msg, options) {
  const content = String(msg.content || '').trim();
  if (!/^!(?:sync-citizen|sync-reg)\b/i.test(content)) return false;
  if (!isRegisterAdmin(msg)) {
    await replyNoPing(msg, 'Command ini khusus admin.');
    return true;
  }
  const stats = await syncEthergeonCitizenRoles(msg.client, {
    registerStore: options.registerStore,
    citizenRoleId: options.roleId,
    legacyRoleId: options.legacyRoleId,
    rejectedRoleId: options.rejectedRoleId,
  });
  await replyNoPing(
    msg,
    [
      'Sync Ethergeon Citizen selesai.',
      `Diproses: ${stats.scanned}`,
      `Berhasil: ${stats.migrated}`,
      `Tidak ditemukan: ${stats.skipped}`,
      `Gagal: ${stats.failed}`,
    ].join('\n')
  );
  return true;
}

async function approveInterview(interaction, registerStore, entryUserId, options) {
  const member = await interaction.guild.members.fetch(entryUserId).catch(() => null);
  const entry = await registerStore.approveUser(entryUserId, {
    id: interaction.user?.id,
    tag: interaction.user?.tag || interaction.user?.username || '',
  });
  if (!entry) {
    await interaction.reply({ content: 'Data interview tidak ditemukan.', ephemeral: true }).catch(() => null);
    return true;
  }
  if (member) {
    await moveMemberToCitizenRole(member, {
      citizenRoleId: options.roleId,
      legacyRoleId: options.legacyRoleId,
      rejectedRoleId: options.rejectedRoleId,
    }).catch(err => {
      console.error('Failed to move approved member role:', err);
      return false;
    });
  }
  await interaction.update({
    embeds: [buildInterviewEmbed({ ...entry, userId: entryUserId }, { id: entryUserId })],
    components: [buildInterviewButtons(entryUserId, false)],
  }).catch(() => null);
  await interaction.channel?.send(
    `Approved. <@${entryUserId}> sekarang LEGAL dan boleh masuk Minecraft sebagai \`${entry.gamertag}\`.`
  ).catch(() => null);
  return true;
}

async function rejectInterview(interaction, registerStore, entryUserId, options) {
  const member = await interaction.guild.members.fetch(entryUserId).catch(() => null);
  const entry = await registerStore.rejectUser(entryUserId, {
    id: interaction.user?.id,
    tag: interaction.user?.tag || interaction.user?.username || '',
  });
  if (!entry) {
    await interaction.reply({ content: 'Data interview tidak ditemukan.', ephemeral: true }).catch(() => null);
    return true;
  }
  if (member) {
    await moveMemberToRejectedRole(member, {
      rejectedRoleId: options.rejectedRoleId,
      pendingRoleId: options.legacyRoleId,
      verifiedRoleId: options.roleId,
    }).catch(() => false);
  }
  await interaction.update({
    embeds: [buildInterviewEmbed({ ...entry, userId: entryUserId }, { id: entryUserId })],
    components: [buildInterviewButtons(entryUserId, false)],
  }).catch(() => null);
  await interaction.channel?.send(
    `Rejected. <@${entryUserId}> belum mendapat akses legal Minecraft, tapi masih bisa coba lagi dengan register ulang.`
  ).catch(() => null);
  return true;
}

async function closeInterview(interaction, registerStore, entryUserId) {
  const entry = await registerStore.closeInterview(entryUserId, {
    id: interaction.user?.id,
    tag: interaction.user?.tag || interaction.user?.username || '',
  });
  if (!entry) {
    await interaction.reply({ content: 'Data interview tidak ditemukan.', ephemeral: true }).catch(() => null);
    return true;
  }

  await interaction.update({
    embeds: [buildInterviewEmbed({ ...entry, userId: entryUserId }, { id: entryUserId })],
    components: [buildInterviewButtons(entryUserId, true)],
  }).catch(() => null);
  await interaction.channel?.permissionOverwrites.edit(entryUserId, {
    ViewChannel: false,
    SendMessages: false,
  }).catch(() => null);
  const closedName = `closed-${entry.interviewId || 'interview'}`.slice(0, 100);
  await interaction.channel?.setName(closedName, 'Interview closed').catch(() => null);
  await interaction.channel?.send('Interview ditutup dan channel dikunci dari applicant.').catch(() => null);
  return true;
}

function createRegisterInteractionHandler({
  roleId = MINECRAFT_REGISTER_ROLE_ID,
  legacyRoleId = MINECRAFT_REGISTER_PENDING_ROLE_ID,
  rejectedRoleId = MINECRAFT_REGISTER_REJECTED_ROLE_ID,
  registerStore,
} = {}) {
  return async function handleRegisterInteraction(interaction) {
    try {
      if (!interaction || !interaction.isButton?.()) return false;

      const listPage = parseListButtonId(interaction.customId);
      if (listPage) {
        if (!interaction.guild || !isRegisterAdmin(interaction)) {
          await interaction.reply({ content: 'Pagination ini khusus admin.', ephemeral: true }).catch(() => null);
          return true;
        }
        await ensureRegisterStore(registerStore, interaction.client);
        await interaction.update(buildListPayload(registerStore.getEntries(), listPage)).catch(() => null);
        return true;
      }

      const interview = parseInterviewButtonId(interaction.customId);
      if (!interview) return false;
      if (!interaction.guild || !isInterviewAdmin(interaction)) {
        await interaction.reply({ content: 'Tombol interview khusus admin.', ephemeral: true }).catch(() => null);
        return true;
      }
      await ensureRegisterStore(registerStore, interaction.client);

      const options = { roleId, legacyRoleId, rejectedRoleId };
      if (interview.action === 'approve') return approveInterview(interaction, registerStore, interview.userId, options);
      if (interview.action === 'reject') return rejectInterview(interaction, registerStore, interview.userId, options);
      if (interview.action === 'close') return closeInterview(interaction, registerStore, interview.userId);
      return false;
    } catch (err) {
      console.error('Register interaction handler error:', err);
      return false;
    }
  };
}

function createRegisterHandler({
  roleId = MINECRAFT_REGISTER_ROLE_ID,
  legacyRoleId = MINECRAFT_REGISTER_PENDING_ROLE_ID,
  rejectedRoleId = MINECRAFT_REGISTER_REJECTED_ROLE_ID,
  registerStore,
  registrationChannelId = REGISTRATION_INBOX_CHANNEL_ID,
  privateChatChannelId = PRIVATE_CHAT_CHANNEL_ID,
}) {
  return async function handleRegisterMessage(msg) {
    try {
      if (!msg || msg.author?.bot) return false;
      if (!msg.guild) return false;

      const options = {
        roleId,
        legacyRoleId,
        rejectedRoleId,
        pendingRoleId: legacyRoleId,
        verifiedRoleId: roleId,
        registerStore,
        registrationChannelId,
        privateChatChannelId,
      };

      if (await handleRegisterCommand(msg, options)) return true;
      if (await handleHelpCommand(msg, options)) return true;
      if (await handleSyncCitizenCommand(msg, options)) return true;
      if (await handleListCommand(msg, options)) return true;
      if (await handleStatusCommand(msg, options)) return true;
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
  scanSubmissionApprovals,
};
