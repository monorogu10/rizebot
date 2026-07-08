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
  INTERVIEW_ARCHIVE_CATEGORY_ID,
  INTERVIEW_ARCHIVE_CATEGORY_NAME,
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
const DISCORD_CATEGORY_CHANNEL_LIMIT = 50;
const DISCORD_SERVER_CATEGORY_LIMIT = 50;
const DISCORD_SERVER_CHANNEL_LIMIT = 500;

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
  const match = String(content || '').trim().match(/^!list(?:\s+(.+))?$/i);
  if (!match) return null;
  const tokens = String(match[1] || '').split(/\s+/g).map(item => item.trim()).filter(Boolean);
  let page = 1;
  let filter = 'all';
  for (const token of tokens) {
    const lowered = token.toLowerCase();
    if (/^\d+$/.test(lowered)) {
      page = Math.max(1, parseInt(lowered, 10));
      continue;
    }
    if (['all', 'semua', 'registered', 'register'].includes(lowered)) filter = 'all';
    else if (['legal', 'approved', 'acc', 'citizen'].includes(lowered)) filter = 'approved';
    else if (['pending', 'antri', 'queue', 'interview'].includes(lowered)) filter = 'pending';
    else if (['rejected', 'reject', 'gagal', 'failed'].includes(lowered)) filter = 'rejected';
  }
  return { page, filter };
}

function parseArchiveInterviewsCommand(content) {
  const match = String(content || '').trim().match(/^!(?:archive-interviews|archiveinterviews|arsip-interviews|arsipinterviews)(?:\s+(\d+))?$/i);
  if (!match) return null;
  const limit = Math.min(100, Math.max(1, parseInt(match[1] || '25', 10) || 25));
  return { limit };
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

function discordDisplayName(user, fallback = '-') {
  return String(
    user?.tag ||
    user?.globalName ||
    user?.username ||
    fallback ||
    '-'
  ).replace(/\s+/g, ' ').trim() || '-';
}

function discordAvatarUrl(user) {
  try {
    return user?.displayAvatarURL?.({ size: 128 }) || '';
  } catch {
    return '';
  }
}

function formatNumberId(value) {
  const number = Math.max(0, Math.floor(Number(value) || 0));
  try {
    return new Intl.NumberFormat('id-ID').format(number);
  } catch {
    return String(number);
  }
}

function formatSnapshotTime(value) {
  const parsed = new Date(Number(value) || value || 0);
  if (Number.isNaN(parsed.getTime())) return '-';
  return formatDateId(parsed.toISOString());
}

function formatRankLabels(profile) {
  const labels = Array.isArray(profile?.ranks?.labels)
    ? profile.ranks.labels.map(label => String(label || '').trim()).filter(Boolean)
    : [];
  if (!labels.length && profile?.rank) labels.push(String(profile.rank).trim());
  return labels.length ? labels.join(', ') : '-';
}

function buildMinecraftStatusFields(profile) {
  if (!profile) {
    return [
      { name: 'Server', value: 'Belum ada snapshot Minecraft.', inline: false },
    ];
  }

  const wallet = profile.wallet || {};
  const land = profile.land || {};
  const landCount = Math.max(0, Math.floor(Number(land.count ?? land.landCount ?? land.owned) || 0));
  const totalArea = Math.max(0, Math.floor(Number(land.totalArea ?? land.area) || 0));

  return [
    {
      name: 'Server',
      value: `${profile.online ? 'Online' : 'Offline'}\nUpdate: ${formatSnapshotTime(profile.updatedAt)}`,
      inline: true,
    },
    {
      name: 'Geon',
      value: profile.wallet ? `${formatNumberId(wallet.geon)} Geon` : '-',
      inline: true,
    },
    {
      name: 'Land',
      value: profile.land
        ? `${formatNumberId(landCount)} land${totalArea ? `\nArea: ${formatNumberId(totalArea)} blok` : ''}`
        : '-',
      inline: true,
    },
    {
      name: 'Rank',
      value: formatRankLabels(profile),
      inline: false,
    },
  ];
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

async function setNicknameToGamertag(member, gamertag) {
  const nickname = normalizeGamertag(gamertag).slice(0, 32);
  if (!member || !nickname) return false;
  if (member.nickname === nickname) return true;
  if (!member.nickname && member.user?.username === nickname) return true;

  const botMember = member.guild?.members?.me;
  const canManageNicknames = botMember?.permissions?.has(PermissionsBitField.Flags.ManageNicknames);
  if (!canManageNicknames || member.manageable === false) return false;

  try {
    const updated = await member.setNickname(nickname, 'Ethergeon gamertag registration sync');
    return updated?.nickname === nickname || member.nickname === nickname;
  } catch (err) {
    if (err?.code === 50013) return false;
    throw err;
  }
}

async function syncGamertagNickname(member, gamertag, context = 'registration') {
  const ok = await setNicknameToGamertag(member, gamertag).catch(err => {
    console.error(`Failed to sync Discord nickname for ${context}:`, err);
    return false;
  });
  return ok
    ? ''
    : ' Catatan: nickname Discord gagal diubah otomatis. Cek permission Manage Nicknames dan posisi role bot.';
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
  if (Array.isArray(member._roles)) {
    return member._roles.some(roleId => roleIds.has(String(roleId)));
  }
  if (roles instanceof Set) {
    for (const roleId of roleIds) {
      if (roles.has(roleId)) return true;
    }
  }
  return false;
}

async function fetchInteractionMember(target) {
  const userId = String(target?.author?.id || target?.user?.id || '').trim();
  if (!target?.guild || !userId) return target?.member || null;
  if (memberHasAnyRole(target.member, INTERVIEW_ADMIN_ROLE_IDS)) return target.member;
  if (isAdmin(target.member)) return target.member;
  return target.guild.members.fetch(userId).catch(() => target.member || null);
}

async function isInterviewAdmin(target) {
  if (isRegisterAdmin(target)) return true;
  if (memberHasAnyRole(target?.member, INTERVIEW_ADMIN_ROLE_IDS)) return true;
  const member = await fetchInteractionMember(target);
  return memberHasAnyRole(member, INTERVIEW_ADMIN_ROLE_IDS);
}

function isInterviewTicketChannel(channel) {
  const name = String(channel?.name || '').toLowerCase();
  return /^interview-\d{3,}$/.test(name) ||
    /^closed-interview-\d{3,}$/.test(name) ||
    String(channel?.parentId || '') === String(INTERVIEW_CATEGORY_ID || '');
}

async function canUseInterviewButton(interaction, applicantUserId) {
  if (await isInterviewAdmin(interaction)) return true;
  const actorId = String(interaction?.user?.id || '').trim();
  if (!actorId || actorId === String(applicantUserId || '')) return false;
  if (!isInterviewTicketChannel(interaction?.channel)) return false;

  const member = await fetchInteractionMember(interaction);
  const permissions = interaction.channel?.permissionsFor?.(member);
  return Boolean(
    permissions?.has(PermissionsBitField.Flags.ViewChannel) &&
    permissions?.has(PermissionsBitField.Flags.SendMessages)
  );
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

function buildStatusPayload(entry, user, minecraftProfile = null) {
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
  fields.push(...buildMinecraftStatusFields(minecraftProfile));

  const profileLines = [
    `Discord: ${user ? `<@${user.id}>` : `\`${entry.userId || '-'}\``}`,
    `Username: \`${discordDisplayName(user, entry.username)}\``,
    `Gamertag: \`${entry.gamertag || '-'}\``,
    `Access: **${statusLabel(entry.status)}**`,
  ];
  const avatarUrl = discordAvatarUrl(user);
  const embed = new EmbedBuilder()
    .setColor(statusColor(entry.status))
    .setTitle('Ethergeon ID Card')
    .setDescription(profileLines.join('\n'))
    .addFields(fields)
    .setFooter({
      text: entry.status === 'approved'
        ? 'Legal access aktif. Join Minecraft dengan gamertag yang tertera.'
        : entry.status === 'rejected'
          ? 'Belum lolos interview. Kamu masih bisa coba lagi dengan register ulang.'
          : 'Akses Minecraft aktif setelah interview di-approve admin.',
    })
    .setTimestamp(new Date());
  if (avatarUrl) embed.setThumbnail(avatarUrl);

  return noPing({ embeds: [embed] });
}

function normalizeListFilter(filterRaw) {
  const filter = String(filterRaw || 'all').toLowerCase();
  if (filter === 'approved' || filter === 'legal') return 'approved';
  if (filter === 'pending') return 'pending';
  if (filter === 'rejected') return 'rejected';
  return 'all';
}

function listFilterLabel(filterRaw) {
  const filter = normalizeListFilter(filterRaw);
  if (filter === 'approved') return 'Legal';
  if (filter === 'pending') return 'Pending';
  if (filter === 'rejected') return 'Rejected';
  return 'All';
}

function listFilterCommand(filterRaw) {
  const filter = normalizeListFilter(filterRaw);
  if (filter === 'approved') return 'legal';
  if (filter === 'pending') return 'pending';
  if (filter === 'rejected') return 'rejected';
  return '';
}

function buildListButtonId(page, filter = 'all') {
  return `${LIST_BUTTON_PREFIX}:${normalizeListFilter(filter)}:${Math.max(1, Number(page) || 1)}`;
}

function parseListButtonId(customId) {
  const raw = String(customId || '');
  const next = raw.match(new RegExp(`^${LIST_BUTTON_PREFIX}:(all|approved|pending|rejected):(\\d+)$`));
  if (next) {
    const page = parseInt(next[2], 10);
    return {
      filter: normalizeListFilter(next[1]),
      page: Number.isFinite(page) && page > 0 ? page : 1,
    };
  }

  const legacy = raw.match(new RegExp(`^${LIST_BUTTON_PREFIX}:(\\d+)$`));
  if (!legacy) return null;
  const page = parseInt(legacy[1], 10);
  return {
    filter: 'all',
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

function buildListButtons(page, totalPages, filter = 'all') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildListButtonId(1, filter))
      .setLabel('First')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(buildListButtonId(Math.max(1, page - 1), filter))
      .setLabel('Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(buildListButtonId(Math.min(totalPages, page + 1), filter))
      .setLabel('Next')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page >= totalPages),
    new ButtonBuilder()
      .setCustomId(buildListButtonId(totalPages, filter))
      .setLabel('Last')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages)
  );
}

function buildListFilterButtons(activeFilter = 'all') {
  const filter = normalizeListFilter(activeFilter);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildListButtonId(1, 'all'))
      .setLabel('All')
      .setStyle(filter === 'all' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildListButtonId(1, 'approved'))
      .setLabel('Legal')
      .setStyle(filter === 'approved' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildListButtonId(1, 'pending'))
      .setLabel('Pending')
      .setStyle(filter === 'pending' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildListButtonId(1, 'rejected'))
      .setLabel('Rejected')
      .setStyle(filter === 'rejected' ? ButtonStyle.Danger : ButtonStyle.Secondary)
  );
}

function listStats(entries = []) {
  return entries.reduce((stats, entry) => {
    const status = String(entry?.status || '').toLowerCase();
    stats.total += 1;
    if (status === 'approved') stats.approved += 1;
    else if (status === 'rejected') stats.rejected += 1;
    else stats.pending += 1;
    return stats;
  }, { total: 0, approved: 0, pending: 0, rejected: 0 });
}

function filterListEntries(entries, filterRaw) {
  const filter = normalizeListFilter(filterRaw);
  if (filter === 'all') return entries;
  return entries.filter(entry => String(entry?.status || '').toLowerCase() === filter);
}

function formatListEntry(entry, rowNumber) {
  const status = String(entry?.status || '').toLowerCase();
  const badge = status === 'approved'
    ? '[LEGAL]'
    : status === 'rejected'
      ? '[REJECTED]'
      : '[PENDING]';
  const user = entry?.userId ? `<@${entry.userId}>` : '-';
  const interview = entry?.interviewChannelId
    ? `<#${entry.interviewChannelId}>`
    : (entry?.interviewId || '-');
  const updated = formatDateId(entry?.updatedAt || entry?.registeredAt);
  return [
    `**${rowNumber}. ${badge}** \`${entry?.gamertag || '-'}\``,
    `${user} | Interview: ${interview} | Update: ${updated}`,
  ].join('\n');
}

function buildListPayload(entries, pageOrOptions = 1) {
  const options = typeof pageOrOptions === 'object' && pageOrOptions !== null
    ? pageOrOptions
    : { page: pageOrOptions, filter: 'all' };
  const filter = normalizeListFilter(options.filter);
  const allEntries = Array.isArray(entries) ? entries : [];
  const filtered = filterListEntries(allEntries, filter);
  const totalPages = Math.max(1, Math.ceil(filtered.length / LIST_PAGE_SIZE));
  const page = Number(options.page) || 1;
  const safePage = Math.min(Math.max(Number(page) || 1, 1), totalPages);
  const start = (safePage - 1) * LIST_PAGE_SIZE;
  const rows = filtered
    .slice(start, start + LIST_PAGE_SIZE)
    .map((entry, index) => formatListEntry(entry, start + index + 1));
  const stats = listStats(allEntries);

  const embed = new EmbedBuilder()
    .setColor(0x36a269)
    .setTitle('Ethergeon Citizen Registry')
    .setDescription(rows.join('\n\n') || `Belum ada data untuk filter ${listFilterLabel(filter)}.`)
    .addFields(
      { name: 'Total', value: String(stats.total), inline: true },
      { name: 'Legal', value: String(stats.approved), inline: true },
      { name: 'Pending', value: String(stats.pending), inline: true },
      { name: 'Rejected', value: String(stats.rejected), inline: true },
      { name: 'Filter', value: listFilterLabel(filter), inline: true },
      { name: 'Shown', value: `${filtered.length}`, inline: true }
    )
    .setFooter({ text: `Halaman ${safePage}/${totalPages} | !list ${listFilterCommand(filter)}`.trim() })
    .setTimestamp(new Date());

  const components = [buildListFilterButtons(filter)];
  if (totalPages > 1) components.push(buildListButtons(safePage, totalPages, filter));

  return noPing({
    embeds: [embed],
    components,
  });
}

function channelMention(channelId) {
  return channelId ? `<#${channelId}>` : 'channel interview';
}

function cleanCategoryName(value) {
  return String(value || 'interview-archive')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'interview-archive';
}

function archiveCategoryStem(seedCategory = null) {
  const configuredName = String(INTERVIEW_ARCHIVE_CATEGORY_NAME || '').trim()
    ? cleanCategoryName(INTERVIEW_ARCHIVE_CATEGORY_NAME)
    : '';
  const sourceName = configuredName || cleanCategoryName(seedCategory?.name || 'interview-archive');
  return cleanCategoryName(sourceName.replace(/\s+\d{1,4}$/g, ''));
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function archiveCategoryIndex(category, stem) {
  const name = cleanCategoryName(category?.name).toLowerCase();
  const safeStem = cleanCategoryName(stem).toLowerCase();
  if (name === safeStem) return 1;
  const match = name.match(new RegExp(`^${escapeRegex(safeStem)}\\s+(\\d{1,4})$`, 'i'));
  if (!match) return null;
  const index = parseInt(match[1], 10);
  return Number.isFinite(index) && index > 0 ? index : null;
}

function isArchiveCategory(channelOrCategory, stem = INTERVIEW_ARCHIVE_CATEGORY_NAME || 'interview-archive') {
  if (!channelOrCategory) return false;
  if (INTERVIEW_ARCHIVE_CATEGORY_ID && String(channelOrCategory.id || '') === String(INTERVIEW_ARCHIVE_CATEGORY_ID)) {
    return true;
  }
  return archiveCategoryIndex(channelOrCategory, archiveCategoryStem({ name: stem })) !== null;
}

function categoryChannelCount(guild, categoryId) {
  if (!guild || !categoryId) return DISCORD_CATEGORY_CHANNEL_LIMIT;
  return guild.channels.cache.filter(channel => channel.parentId === categoryId).size;
}

function buildArchiveCategoryOverwrites(guild) {
  const botId = guild.members.me?.id || guild.client.user?.id;
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionsBitField.Flags.ViewChannel],
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

  return overwrites;
}

async function fetchChannelSafe(guild, channelId) {
  if (!guild || !channelId) return null;
  return guild.channels.cache.get(channelId) ||
    guild.channels.fetch(channelId).catch(() => null);
}

function nextArchiveCategoryName(categories, stem) {
  let maxIndex = 0;
  for (const category of categories) {
    const index = archiveCategoryIndex(category, stem);
    if (index && index > maxIndex) maxIndex = index;
  }
  return cleanCategoryName(`${stem} ${String(maxIndex + 1).padStart(3, '0')}`);
}

async function resolveArchiveCategory(guild) {
  if (!guild) return { category: null, code: 'guild-missing' };

  await guild.channels.fetch().catch(() => null);
  const seedCategory = await fetchChannelSafe(guild, INTERVIEW_ARCHIVE_CATEGORY_ID);
  const stem = archiveCategoryStem(seedCategory);
  const allCategories = [...guild.channels.cache.values()]
    .filter(channel => channel.type === ChannelType.GuildCategory);

  const candidates = allCategories
    .filter(category => (
      category.id === INTERVIEW_ARCHIVE_CATEGORY_ID ||
      archiveCategoryIndex(category, stem) !== null
    ))
    .sort((a, b) => {
      const ai = archiveCategoryIndex(a, stem) || 0;
      const bi = archiveCategoryIndex(b, stem) || 0;
      if (ai !== bi) return ai - bi;
      return a.rawPosition - b.rawPosition;
    });

  for (const category of candidates) {
    if (categoryChannelCount(guild, category.id) < DISCORD_CATEGORY_CHANNEL_LIMIT) {
      return { category, created: false };
    }
  }

  if (allCategories.length >= DISCORD_SERVER_CATEGORY_LIMIT) {
    return { category: null, code: 'server-category-limit' };
  }
  if (guild.channels.cache.size >= DISCORD_SERVER_CHANNEL_LIMIT) {
    return { category: null, code: 'server-channel-limit' };
  }

  const category = await guild.channels.create({
    name: nextArchiveCategoryName(candidates, stem),
    type: ChannelType.GuildCategory,
    permissionOverwrites: buildArchiveCategoryOverwrites(guild),
    reason: 'Create next interview archive category',
  }).catch(err => {
    console.error('Failed to create interview archive category:', err);
    return null;
  });

  if (!category) return { category: null, code: 'create-failed' };
  return { category, created: true };
}

async function moveChannelToArchive(guild, channel, reason = 'Interview archived') {
  const archiveResult = await resolveArchiveCategory(guild);
  if (!archiveResult.category) {
    return {
      ok: false,
      code: archiveResult.code || 'archive-unavailable',
      created: false,
      category: null,
    };
  }
  if (!channel?.setParent) {
    return {
      ok: false,
      code: 'channel-move-unavailable',
      created: archiveResult.created,
      category: archiveResult.category,
    };
  }

  const moved = await channel
    .setParent(archiveResult.category.id, { lockPermissions: true, reason })
    .catch(err => {
      console.error('Failed to move interview channel to archive:', err);
      return null;
    });
  return {
    ok: Boolean(moved),
    code: moved ? 'archived' : 'move-failed',
    created: archiveResult.created,
    category: archiveResult.category,
  };
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
    const duplicate = registerStore.findUserByGamertag?.(gamertag, msg.author.id);
    if (duplicate) {
      await replyNoPing(msg, `Gamertag \`${gamertag}\` sudah dipakai oleh user lain.`);
      return true;
    }

    const updated = await registerStore.updateApprovedGamertag?.(
      msg.author.id,
      gamertag,
      msg.author?.tag || msg.author?.username || ''
    );
    if (!updated || updated.duplicate || updated.notApproved) {
      await replyNoPing(msg, 'Gagal memperbarui gamertag legal. Coba lagi atau hubungi admin.');
      return true;
    }

    await moveMemberToCitizenRole(member, {
      citizenRoleId: verifiedRoleId,
      legacyRoleId: pendingRoleId,
      rejectedRoleId,
    }).catch(err => {
      console.error('Failed to refresh legal role after gamertag update:', err);
      return false;
    });
    const nicknameNote = await syncGamertagNickname(member, gamertag, 'approved gamertag update');

    const oldText = updated.oldGamertag && gamertagKey(updated.oldGamertag) !== gamertagKey(gamertag)
      ? ` dari \`${updated.oldGamertag}\``
      : '';
    await replyNoPing(
      msg,
      `Gamertag legal kamu diperbarui${oldText} menjadi \`${gamertag}\`. Nickname Discord disync ke gamertag. Tidak perlu interview ulang. Relog Minecraft atau tunggu cek ulang akses.${nicknameNote}`
    );
    if (updated.oldGamertag && gamertagKey(updated.oldGamertag) !== gamertagKey(gamertag)) {
      queueLegalAccessJob(options.bridge, 'revoke', { gamertag: updated.oldGamertag }, msg.author.id, msg.author);
    }
    queueLegalAccessJob(options.bridge, 'approve', updated.entry, msg.author.id, msg.author);
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
  const nicknameNote = await syncGamertagNickname(member, gamertag, 'pending register');

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
    `Register diterima. Nickname Discord disync ke \`${gamertag}\`. Channel interview kamu: ${channelMention(channel.id)}.${nicknameNote}`
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
  const minecraftProfile = entry?.gamertag
    ? options.bridge?.getPlayerStatusByGamertag?.(entry.gamertag) || null
    : null;
  await replyNoPing(
    msg,
    buildStatusPayload(entry ? { ...entry, userId: msg.author.id } : null, msg.author, minecraftProfile)
  );
  return true;
}

async function handleListCommand(msg, options) {
  const listOptions = parseListCommand(msg.content);
  if (!listOptions) return false;
  if (!await isInterviewAdmin(msg)) {
    await replyNoPing(msg, 'Command list register khusus admin/interviewer.');
    return true;
  }
  if (!await ensureRegisterStore(options.registerStore, msg.client)) {
    await replyNoPing(msg, 'Sistem register belum aktif. Hubungi admin.');
    return true;
  }
  await replyNoPing(msg, buildListPayload(options.registerStore.getEntries(), listOptions));
  return true;
}

function isClosedInterviewChannel(channel, guild = null) {
  const name = String(channel?.name || '').toLowerCase();
  if (channel?.type !== ChannelType.GuildText) return false;
  if (!/^closed[-_ ]*interview/i.test(name)) return false;
  const parent = guild?.channels?.cache?.get?.(channel.parentId);
  if (parent && isArchiveCategory(parent)) return false;
  if (!INTERVIEW_CATEGORY_ID) return true;
  return String(channel.parentId || '') === String(INTERVIEW_CATEGORY_ID) || !parent;
}

async function archiveClosedInterviewBacklogForGuild(guild, {
  limit = 25,
  reason = 'Auto archive closed interview channels',
} = {}) {
  if (!guild) {
    return { scanned: 0, moved: 0, failed: 0, remaining: 0, createdCategories: [], failedLines: [] };
  }

  await guild.channels.fetch().catch(() => null);
  const backlog = [...guild.channels.cache.values()]
    .filter(channel => isClosedInterviewChannel(channel, guild))
    .sort((a, b) => Number(a.rawPosition || 0) - Number(b.rawPosition || 0))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 25)));

  let moved = 0;
  let failed = 0;
  const createdCategories = new Set();
  const failedLines = [];

  for (const channel of backlog) {
    const result = await moveChannelToArchive(guild, channel, reason);
    if (result.ok) {
      moved += 1;
      if (result.created && result.category?.name) createdCategories.add(result.category.name);
    } else {
      failed += 1;
      failedLines.push(`${channel.name}: ${result.code || 'move-failed'}`);
    }
  }

  const remaining = [...guild.channels.cache.values()]
    .filter(channel => isClosedInterviewChannel(channel, guild))
    .length;

  return {
    scanned: backlog.length,
    moved,
    failed,
    remaining,
    createdCategories: [...createdCategories],
    failedLines,
  };
}

async function archiveClosedInterviewBacklog(client, options = {}) {
  const summary = {
    guilds: 0,
    scanned: 0,
    moved: 0,
    failed: 0,
    remaining: 0,
    createdCategories: [],
    failedLines: [],
  };

  if (!client?.guilds?.cache) return summary;
  for (const guild of client.guilds.cache.values()) {
    summary.guilds += 1;
    const result = await archiveClosedInterviewBacklogForGuild(guild, options);
    summary.scanned += result.scanned;
    summary.moved += result.moved;
    summary.failed += result.failed;
    summary.remaining += result.remaining;
    summary.createdCategories.push(...result.createdCategories);
    summary.failedLines.push(...result.failedLines);
  }

  summary.createdCategories = [...new Set(summary.createdCategories)];
  return summary;
}

async function handleArchiveInterviewsCommand(msg) {
  const parsed = parseArchiveInterviewsCommand(msg.content);
  if (!parsed) return false;
  if (!msg.guild) return true;
  if (!await isInterviewAdmin(msg)) {
    await replyNoPing(msg, 'Command archive interview khusus admin/interviewer.');
    return true;
  }

  if (!INTERVIEW_CATEGORY_ID) {
    await replyNoPing(msg, 'INTERVIEW_CATEGORY_ID belum diset.');
    return true;
  }

  const result = await archiveClosedInterviewBacklogForGuild(msg.guild, {
    limit: parsed.limit,
    reason: 'Bulk archive closed interview channels',
  });

  if (!result.scanned) {
    await replyNoPing(msg, 'Tidak ada channel `closed-interview-*` yang masih nyangkut di category interview.');
    return true;
  }
  await replyNoPing(
    msg,
    [
      'Archive sweep selesai.',
      `Dipindahkan: ${result.moved}/${result.scanned}`,
      `Gagal: ${result.failed}`,
      `Sisa backlog di Interview Area: ${result.remaining}`,
      result.createdCategories.length ? `Category baru: ${result.createdCategories.join(', ')}` : '',
      result.failedLines.length ? `Gagal:\n${result.failedLines.slice(0, 5).join('\n')}` : '',
      result.remaining > 0 ? 'Jalankan lagi `!archive-interviews` untuk lanjut batch berikutnya.' : '',
    ].filter(Boolean).join('\n')
  );
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
      `Nickname sync: ${stats.nicknameSynced || 0} sukses, ${stats.nicknameFailed || 0} gagal`,
    ].join('\n')
  );
  return true;
}

function queueLegalAccessJob(bridge, action, entry, userId, reviewer) {
  if (!bridge?.enqueueBridgeQuery || !entry?.gamertag) return null;
  return bridge.enqueueBridgeQuery('legal_access', {
    action,
    targetName: entry.gamertag,
    targetKey: gamertagKey(entry.gamertag),
    discordUserId: userId,
    approvedAt: entry.approvedAt || '',
    requestedBy: reviewer?.id || '',
    requestedByTag: reviewer?.tag || reviewer?.username || '',
  });
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
    await syncGamertagNickname(member, entry.gamertag, 'approve interview');
  }
  await interaction.update({
    embeds: [buildInterviewEmbed({ ...entry, userId: entryUserId }, { id: entryUserId })],
    components: [buildInterviewButtons(entryUserId, false)],
  }).catch(() => null);
  await interaction.channel?.send(
    `Approved. <@${entryUserId}> sekarang LEGAL dan boleh masuk Minecraft sebagai \`${entry.gamertag}\`.`
  ).catch(() => null);
  queueLegalAccessJob(options.bridge, 'approve', entry, entryUserId, interaction.user);
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
  queueLegalAccessJob(options.bridge, 'revoke', entry, entryUserId, interaction.user);
  return true;
}

async function closeInterview(interaction, registerStore, entryUserId, options = {}) {
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
  let archiveNotice = '';
  const archiveResult = await moveChannelToArchive(interaction.guild, interaction.channel, 'Interview archived');
  if (archiveResult.ok && archiveResult.created) {
    archiveNotice = ` Category archive baru dibuat: ${archiveResult.category.name}.`;
  } else if (archiveResult.code === 'server-category-limit') {
    archiveNotice = ' Archive tidak dipindahkan karena server sudah mencapai limit category Discord.';
  } else if (archiveResult.code === 'server-channel-limit') {
    archiveNotice = ' Archive tidak dipindahkan karena server sudah mencapai limit total channel Discord.';
  } else if (!archiveResult.ok && archiveResult.code) {
    archiveNotice = ` Archive tidak dipindahkan (${archiveResult.code}).`;
  }
  await interaction.channel?.send(
    archiveResult.ok
      ? `Interview ditutup, channel dikunci dari applicant, lalu dipindahkan ke archive.${archiveNotice}`
      : `Interview ditutup dan channel dikunci dari applicant.${archiveNotice}`
  ).catch(() => null);
  return true;
}

function createRegisterInteractionHandler({
  roleId = MINECRAFT_REGISTER_ROLE_ID,
  legacyRoleId = MINECRAFT_REGISTER_PENDING_ROLE_ID,
  rejectedRoleId = MINECRAFT_REGISTER_REJECTED_ROLE_ID,
  registerStore,
  bridge = null,
} = {}) {
  return async function handleRegisterInteraction(interaction) {
    try {
      if (!interaction || !interaction.isButton?.()) return false;

      const listPage = parseListButtonId(interaction.customId);
      if (listPage) {
        if (!interaction.guild || !await isInterviewAdmin(interaction)) {
          await interaction.reply({ content: 'Registry ini khusus admin/interviewer.', ephemeral: true }).catch(() => null);
          return true;
        }
        await ensureRegisterStore(registerStore, interaction.client);
        await interaction.update(buildListPayload(registerStore.getEntries(), listPage)).catch(() => null);
        return true;
      }

      const interview = parseInterviewButtonId(interaction.customId);
      if (!interview) return false;
      if (!interaction.guild || !await canUseInterviewButton(interaction, interview.userId)) {
        await interaction.reply({ content: 'Tombol interview khusus admin.', ephemeral: true }).catch(() => null);
        return true;
      }
      await ensureRegisterStore(registerStore, interaction.client);

      const options = {
        roleId,
        legacyRoleId,
        rejectedRoleId,
        bridge,
      };
      if (interview.action === 'approve') return approveInterview(interaction, registerStore, interview.userId, options);
      if (interview.action === 'reject') return rejectInterview(interaction, registerStore, interview.userId, options);
      if (interview.action === 'close') return closeInterview(interaction, registerStore, interview.userId, options);
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
  bridge = null,
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
        bridge,
        registrationChannelId,
        privateChatChannelId,
      };

      if (await handleRegisterCommand(msg, options)) return true;
      if (await handleHelpCommand(msg, options)) return true;
      if (await handleSyncCitizenCommand(msg, options)) return true;
      if (await handleArchiveInterviewsCommand(msg)) return true;
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
  archiveClosedInterviewBacklog,
  createRegisterHandler,
  createRegisterInteractionHandler,
  createSubmissionReactionHandler,
  scanSubmissionApprovals,
};
