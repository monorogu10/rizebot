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
const {
  logCommandError,
  replyWithDiagnostics,
  sendCommandError,
} = require('../utils/commandDiagnostics');
const { createRizebotHelpPayload } = require('./helpPayload');
const {
  moveMemberToCitizenRole,
  syncEthergeonCitizenRoles,
} = require('./ethergeonCitizenRoleHandler');

const GAMERTAG_REGEX = /^[A-Za-z0-9_ ]{3,32}$/;
const LIST_PAGE_SIZE = 5;
const LIST_ENTRY_MAX_LENGTH = 360;
const LIST_DESCRIPTION_MAX_LENGTH = 3900;
const LIST_BUTTON_PREFIX = 'citizenlist';
const INTERVIEW_BUTTON_PREFIX = 'interview';
const INTERVIEW_REPLY_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const INTERVIEW_REPLY_SCAN_MAX_MESSAGES = 1000;
const DISCORD_CATEGORY_CHANNEL_LIMIT = 50;
const DISCORD_SERVER_CATEGORY_LIMIT = 50;
const DISCORD_SERVER_CHANNEL_LIMIT = 500;
const INTERVIEW_TRANSCRIPT_MESSAGE_LIMIT = Math.max(
  100,
  Math.min(5000, Number(process.env.INTERVIEW_TRANSCRIPT_MESSAGE_LIMIT) || 1000)
);
const COMPILE_COMMAND_MAX_CHANNELS = Math.max(
  1,
  Math.min(500, Number(process.env.INTERVIEW_COMPILE_MAX_CHANNELS) || 500)
);

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
  const listCommand = parseListCommand(msg?.content);
  return replyWithDiagnostics(msg, noPing(payload), {
    scope: 'register-handler',
    command: listCommand ? '!list' : String(msg?.content || '').trim().split(/\s+/g)[0],
    stage: listCommand ? 'mengirim halaman registry Minecraft' : 'mengirim balasan register',
  });
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

function userIdFromMentionOrId(value) {
  const match = String(value || '').trim().match(/^<@!?(\d{5,32})>$|^(\d{5,32})$/);
  return match ? (match[1] || match[2]) : '';
}

function parseSetRegisterGamertagCommand(content) {
  const match = String(content || '').trim().match(/^!(?:setreg|set-reg|ganti-reg|gantireg|ubah-reg|ubahreg)\s+(\S+)\s+(.+)$/i);
  if (!match) return null;
  return {
    userId: userIdFromMentionOrId(match[1]),
    gamertag: normalizeGamertag(match[2] || ''),
  };
}

function parseListCommand(content) {
  const match = String(content || '').trim().match(/^!(?:list|listreg|list-reg|registry|registrasi|pendaftaran)(?:\s+(.+))?$/i);
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
    const nextFilter = normalizeListFilter(lowered);
    if (nextFilter !== 'all' || ['all', 'semua', 'registered', 'register', 'semuanya'].includes(lowered)) {
      filter = nextFilter;
    }
  }
  return { page, filter };
}

function parseArchiveInterviewsCommand(content) {
  const match = String(content || '').trim().match(/^!(?:archive-interviews|archiveinterviews|arsip-interviews|arsipinterviews)(?:\s+(\d+))?$/i);
  if (!match) return null;
  const limit = Math.min(100, Math.max(1, parseInt(match[1] || '25', 10) || 25));
  return { limit };
}

function parseCompileCommand(content) {
  const match = String(content || '').trim().match(/^!(?:compile|compile-interviews|compileinterviews)(?:\s+(\d+|all|semua))?$/i);
  if (!match) return null;
  const rawLimit = String(match[1] || 'all').toLowerCase();
  if (rawLimit === 'all' || rawLimit === 'semua') {
    return { limit: COMPILE_COMMAND_MAX_CHANNELS };
  }
  const limit = Math.min(COMPILE_COMMAND_MAX_CHANNELS, Math.max(1, parseInt(rawLimit, 10) || COMPILE_COMMAND_MAX_CHANNELS));
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
  const gamertag = entry?.gamertag || '-';
  return new EmbedBuilder()
    .setColor(statusColor(entry?.status))
    .setTitle(`${entry?.interviewId || 'interview'} | Minecraft Access Interview`)
    .setDescription([
      `Applicant: ${user ? `<@${user.id}>` : '-'}`,
      `Discord ID: \`${user?.id || '-'}\``,
      `Gamertag: \`${gamertag}\``,
      `Status: **${status}**`,
      `Registered: ${formatDateId(entry?.registeredAt)}`,
    ].join('\n'))
    .addFields(
      {
        name: 'Pertanyaan Interview',
        value: [
          '**Batas waktu menjawab: 24 jam sejak interview dibuat.** Tanpa balasan, interview otomatis gagal dan ditutup.',
          'Jawab pertanyaan berikut secara jujur dengan nomor **1-5**:',
          '1. Silakan perkenalkan diri kamu secara singkat.',
          '2. Apa tujuan kamu masuk ke server Ethergeon?',
          '3. Apakah kamu player baru atau sudah lama bermain Server Ethergeon?',
          '4. Apakah kamu pernah merusuh di server lain, atau memiliki niat untuk merusuh di Ethergeon? Jelaskan dengan jujur.',
          '5. Jika lolos, apakah kamu bersedia membaca dan mematuhi seluruh aturan di lobby sebelum bermain?',
        ].join('\n'),
        inline: false,
      },
      {
        name: 'Perjanjian Wajib',
        value: [
          'Setelah menjawab, salin dan kirim pernyataan berikut:',
          `**Saya, ${gamertag}, berjanji tidak akan merusuh, merusak, mengganggu player lain, atau melanggar aturan di server Ethergeon. Jika saya lolos, saya wajib membaca dan mematuhi aturan di lobby. Saya bersedia menerima sanksi jika melanggar perjanjian ini.**`,
        ].join('\n'),
        inline: false,
      },
      {
        name: 'Untuk Admin / Interviewer',
        value: 'Periksa seluruh jawaban dan perjanjian applicant di channel ini, lalu pilih **Approve** atau **Reject**.',
        inline: false,
      }
    )
    .setFooter({ text: 'Applicant: jawab 1-5 dan kirim perjanjian. Admin: review sebelum approve/reject.' })
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
  if (['approved', 'legal', 'lolos', 'lulus', 'acc', 'accepted', 'approve', 'diterima', 'sukses', 'citizen'].includes(filter)) return 'approved';
  if (['pending', 'antri', 'queue', 'interview', 'menunggu', 'proses'].includes(filter)) return 'pending';
  if (['rejected', 'reject', 'gagal', 'failed', 'fail', 'ditolak', 'tolak'].includes(filter)) return 'rejected';
  return 'all';
}

function listFilterLabel(filterRaw) {
  const filter = normalizeListFilter(filterRaw);
  if (filter === 'approved') return 'Lolos';
  if (filter === 'pending') return 'Pending';
  if (filter === 'rejected') return 'Gagal';
  return 'Semua';
}

function listFilterCommand(filterRaw) {
  const filter = normalizeListFilter(filterRaw);
  if (filter === 'approved') return 'lolos';
  if (filter === 'pending') return 'pending';
  if (filter === 'rejected') return 'gagal';
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
      .setLabel('Semua')
      .setStyle(filter === 'all' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildListButtonId(1, 'approved'))
      .setLabel('Lolos')
      .setStyle(filter === 'approved' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildListButtonId(1, 'pending'))
      .setLabel('Pending')
      .setStyle(filter === 'pending' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildListButtonId(1, 'rejected'))
      .setLabel('Gagal')
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
    ? '[LOLOS]'
    : status === 'rejected'
      ? '[GAGAL]'
      : '[PENDING]';
  const user = entry?.userId ? `<@${entry.userId}>` : '-';
  const interview = entry?.interviewChannelId
    ? `<#${entry.interviewChannelId}>`
    : (entry?.interviewId || '-');
  const updated = formatDateId(entry?.updatedAt || entry?.registeredAt);
  const reviewer = status === 'approved'
    ? (entry?.approvedBy ? ` | Oleh: <@${entry.approvedBy}>` : '')
    : status === 'rejected' && entry?.rejectedBy
      ? ` | Oleh: <@${entry.rejectedBy}>`
      : '';
  const reason = status === 'rejected' && entry?.rejectionReason
    ? `\nAlasan: ${truncateListText(entry.rejectionReason, 120)}`
    : '';
  return truncateListText([
    `**${rowNumber}. ${badge}** \`${entry?.gamertag || '-'}\``,
    `${user} | Interview: ${interview} | Update: ${updated}${reviewer}${reason}`,
  ].join('\n'), LIST_ENTRY_MAX_LENGTH);
}

function truncateListText(value, maxLength = LIST_ENTRY_MAX_LENGTH) {
  const text = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function safeListDescription(rows, filter) {
  const fallback = `Belum ada data untuk filter ${listFilterLabel(filter)}.`;
  if (!rows.length) return fallback;

  const parts = [];
  let used = 0;
  for (const row of rows) {
    const next = parts.length ? `\n\n${row}` : row;
    if (used + next.length > LIST_DESCRIPTION_MAX_LENGTH) {
      const notice = '\n\nData halaman ini dipotong agar tidak terkena limit Discord.';
      if (used + notice.length <= LIST_DESCRIPTION_MAX_LENGTH) parts.push(notice);
      break;
    }
    parts.push(next);
    used += next.length;
  }
  return parts.join('').slice(0, LIST_DESCRIPTION_MAX_LENGTH) || fallback;
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
    .setDescription(safeListDescription(rows, filter))
    .addFields(
      { name: 'Total', value: String(stats.total), inline: true },
      { name: 'Lolos', value: String(stats.approved), inline: true },
      { name: 'Pending', value: String(stats.pending), inline: true },
      { name: 'Gagal', value: String(stats.rejected), inline: true },
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
    const currentGamertag = normalizeGamertag(existing.gamertag);
    if (gamertagKey(currentGamertag) !== gamertagKey(gamertag)) {
      await replyNoPing(
        msg,
        [
          `Akun kamu sudah legal sebagai \`${currentGamertag || '-'}\`.`,
          'Demi keamanan akun dan wallet, ganti gamertag legal tidak bisa dilakukan dengan `!reg` lagi.',
          'Minta admin/interviewer review manual, lalu admin bisa pakai `!setreg @user <gamertag>` jika memang sah.',
        ].join('\n')
      );
      return true;
    }

    await moveMemberToCitizenRole(member, {
      citizenRoleId: verifiedRoleId,
      legacyRoleId: pendingRoleId,
      rejectedRoleId,
    }).catch(err => {
      console.error('Failed to refresh legal role:', err);
      return false;
    });
    const nicknameNote = await syncGamertagNickname(member, currentGamertag || gamertag, 'approved gamertag refresh');
    queueLegalAccessJob(options.bridge, 'approve', existing, msg.author.id, msg.author);
    await replyNoPing(
      msg,
      `Kamu sudah legal sebagai \`${currentGamertag || gamertag}\`. Role dan nickname disync ulang.${nicknameNote}`
    );
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
    content: `<@${msg.author.id}>, interview akses Minecraft kamu dimulai. Silakan jawab semua pertanyaan dan kirim perjanjian wajib di bawah ini.`,
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

async function handleSetRegisterGamertagCommand(msg, options) {
  const parsed = parseSetRegisterGamertagCommand(msg.content);
  if (!parsed) return false;

  if (!await isInterviewAdmin(msg)) {
    await replyNoPing(msg, 'Command `!setreg` khusus admin/interviewer.');
    return true;
  }
  if (!parsed.userId) {
    await replyNoPing(msg, 'Format: `!setreg @user <gamertag_minecraft>`.');
    return true;
  }
  if (!parsed.gamertag || !isValidGamertag(parsed.gamertag)) {
    await replyNoPing(msg, 'Format gamertag invalid. Gunakan 3-32 huruf/angka/underscore/spasi.');
    return true;
  }
  if (!await ensureRegisterStore(options.registerStore, msg.client)) {
    await replyNoPing(msg, 'Sistem register belum aktif. Hubungi admin.');
    return true;
  }

  const entry = options.registerStore.getUser(parsed.userId);
  if (!entry?.gamertag) {
    await replyNoPing(msg, `Data register untuk <@${parsed.userId}> tidak ditemukan.`);
    return true;
  }
  if (entry.status !== 'approved' && entry.legal !== true) {
    await replyNoPing(msg, `<@${parsed.userId}> belum berstatus legal/approved. Selesaikan interview biasa dulu.`);
    return true;
  }

  const duplicate = options.registerStore.findUserByGamertag?.(parsed.gamertag, parsed.userId);
  if (duplicate) {
    await replyNoPing(msg, `Gamertag \`${parsed.gamertag}\` sudah dipakai oleh <@${duplicate.userId}>.`);
    return true;
  }

  const member = await msg.guild.members.fetch(parsed.userId).catch(() => null);
  const user = member?.user || await msg.client.users.fetch(parsed.userId).catch(() => null);
  const updated = await options.registerStore.updateApprovedGamertag?.(
    parsed.userId,
    parsed.gamertag,
    user?.tag || user?.username || entry.username || ''
  );
  if (!updated || updated.duplicate || updated.notApproved) {
    await replyNoPing(msg, 'Gagal mengubah gamertag legal. Coba lagi atau cek data register.');
    return true;
  }

  if (member) {
    await moveMemberToCitizenRole(member, {
      citizenRoleId: options.verifiedRoleId,
      legacyRoleId: options.pendingRoleId,
      rejectedRoleId: options.rejectedRoleId,
    }).catch(err => {
      console.error('Failed to refresh legal role after admin gamertag update:', err);
      return false;
    });
    await syncGamertagNickname(member, parsed.gamertag, 'admin gamertag update');
  }

  if (updated.oldGamertag && gamertagKey(updated.oldGamertag) !== gamertagKey(parsed.gamertag)) {
    queueLegalAccessJob(options.bridge, 'revoke', { gamertag: updated.oldGamertag }, parsed.userId, msg.author);
  }
  queueLegalAccessJob(options.bridge, 'approve', updated.entry, parsed.userId, msg.author);

  const oldText = updated.oldGamertag && gamertagKey(updated.oldGamertag) !== gamertagKey(parsed.gamertag)
    ? ` dari \`${updated.oldGamertag}\``
    : '';
  await replyNoPing(
    msg,
    `Gamertag legal <@${parsed.userId}> diubah${oldText} menjadi \`${updated.entry.gamertag}\` oleh admin. Cache akses Minecraft ikut disync.`
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

function isClosedInterviewAnyChannel(channel) {
  const name = String(channel?.name || '').toLowerCase();
  return channel?.type === ChannelType.GuildText && /^closed[-_ ]*interview/i.test(name);
}

function interviewIdFromChannelName(channel) {
  const match = String(channel?.name || '').match(/(interview-\d{3,})/i);
  return match ? match[1].toLowerCase() : '';
}

function jsonClone(value) {
  if (!value) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function serializeCollection(collection, mapper) {
  if (!collection?.values) return [];
  return [...collection.values()].map(mapper).filter(Boolean);
}

function serializeMessageForTranscript(message) {
  return {
    id: message.id,
    type: message.type,
    createdAt: message.createdAt?.toISOString?.() || '',
    editedAt: message.editedAt?.toISOString?.() || null,
    pinned: Boolean(message.pinned),
    system: Boolean(message.system),
    author: {
      id: message.author?.id || '',
      username: message.author?.username || '',
      tag: message.author?.tag || '',
      bot: Boolean(message.author?.bot),
    },
    memberDisplayName: message.member?.displayName || '',
    content: message.content || '',
    attachments: serializeCollection(message.attachments, attachment => ({
      id: attachment.id,
      name: attachment.name || '',
      url: attachment.url || '',
      proxyUrl: attachment.proxyURL || '',
      contentType: attachment.contentType || '',
      size: attachment.size || 0,
      width: attachment.width || null,
      height: attachment.height || null,
    })),
    embeds: Array.isArray(message.embeds)
      ? message.embeds.map(embed => embed?.toJSON?.() || jsonClone(embed)).filter(Boolean)
      : [],
    components: Array.isArray(message.components)
      ? message.components.map(component => component?.toJSON?.() || jsonClone(component)).filter(Boolean)
      : [],
    stickers: serializeCollection(message.stickers, sticker => ({
      id: sticker.id,
      name: sticker.name || '',
      format: sticker.format || '',
    })),
    reactions: serializeCollection(message.reactions?.cache, reaction => ({
      emoji: reaction.emoji?.toString?.() || reaction.emoji?.name || '',
      count: reaction.count || 0,
    })),
    mentions: {
      users: serializeCollection(message.mentions?.users, user => user.id),
      roles: serializeCollection(message.mentions?.roles, role => role.id),
      channels: serializeCollection(message.mentions?.channels, channel => channel.id),
    },
    reference: message.reference ? {
      messageId: message.reference.messageId || '',
      channelId: message.reference.channelId || '',
      guildId: message.reference.guildId || '',
    } : null,
  };
}

async function fetchInterviewMessages(channel, limit = INTERVIEW_TRANSCRIPT_MESSAGE_LIMIT) {
  const messages = [];
  let before = null;

  while (messages.length < limit) {
    const batchLimit = Math.min(100, limit - messages.length);
    const options = before ? { limit: batchLimit, before } : { limit: batchLimit };
    const batch = await channel.messages.fetch(options).catch(err => {
      console.error('Failed to fetch interview messages:', err);
      return null;
    });
    if (!batch?.size) break;

    messages.push(...batch.values());
    before = batch.last()?.id || null;
    if (!before || batch.size < batchLimit) break;
  }

  return messages.sort((a, b) => Number(a.createdTimestamp || 0) - Number(b.createdTimestamp || 0));
}

function resolveInterviewEntry(registerStore, channel, entryUserId = '', entry = null) {
  if (entry && entryUserId) return { userId: entryUserId, entry };

  const byChannel = registerStore?.findUserByInterviewChannel?.(channel?.id);
  if (byChannel) return byChannel;

  const interviewId = interviewIdFromChannelName(channel);
  if (interviewId && registerStore?.getEntries) {
    const found = registerStore.getEntries()
      .find(item => String(item.interviewId || '').toLowerCase() === interviewId);
    if (found) return { userId: found.userId, entry: found };
  }

  if (entryUserId && registerStore?.getUser) {
    const fallbackEntry = registerStore.getUser(entryUserId);
    if (fallbackEntry) return { userId: entryUserId, entry: fallbackEntry };
  }

  return { userId: entryUserId || '', entry: entry || null };
}

function buildInterviewTranscript(channel, messages, {
  registerStore,
  actor,
  entryUserId = '',
  entry = null,
  source = 'manual-compile',
} = {}) {
  const resolved = resolveInterviewEntry(registerStore, channel, entryUserId, entry);
  const participants = new Map();
  for (const message of messages) {
    const authorId = message.author?.id || '';
    if (!authorId || participants.has(authorId)) continue;
    participants.set(authorId, {
      id: authorId,
      username: message.author?.username || '',
      tag: message.author?.tag || '',
      bot: Boolean(message.author?.bot),
      displayName: message.member?.displayName || '',
    });
  }

  const compiledAt = new Date().toISOString();
  const transcriptId = `${channel.guild?.id || 'guild'}:${channel.id}`;
  return {
    version: 1,
    type: 'ethergeon-interview-transcript',
    source,
    transcriptId,
    compiledAt,
    compiledBy: {
      id: actor?.id || '',
      username: actor?.username || '',
      tag: actor?.tag || '',
    },
    guild: {
      id: channel.guild?.id || '',
      name: channel.guild?.name || '',
    },
    channel: {
      id: channel.id,
      name: channel.name || '',
      parentId: channel.parentId || '',
      topic: channel.topic || '',
      createdAt: channel.createdAt?.toISOString?.() || '',
    },
    applicant: {
      discordUserId: resolved.userId || '',
      gamertag: resolved.entry?.gamertag || '',
      username: resolved.entry?.username || '',
      status: resolved.entry?.status || '',
    },
    interview: {
      id: resolved.entry?.interviewId || interviewIdFromChannelName(channel),
      createdAt: resolved.entry?.interviewCreatedAt || null,
      closedAt: resolved.entry?.interviewClosedAt || null,
      approvedAt: resolved.entry?.approvedAt || null,
      approvedBy: resolved.entry?.approvedBy || '',
      rejectedAt: resolved.entry?.rejectedAt || null,
      rejectedBy: resolved.entry?.rejectedBy || '',
    },
    participants: [...participants.values()],
    messageCount: messages.length,
    truncated: messages.length >= INTERVIEW_TRANSCRIPT_MESSAGE_LIMIT,
    messages: messages.map(serializeMessageForTranscript),
  };
}

async function compileInterviewChannel(channel, {
  registerStore,
  transcriptStore,
  actor,
  entryUserId = '',
  entry = null,
  source = 'manual-compile',
} = {}) {
  if (!channel || channel.type !== ChannelType.GuildText) {
    return { ok: false, code: 'not-text-channel' };
  }
  if (!transcriptStore?.appendTranscript) {
    return { ok: false, code: 'transcript-store-missing' };
  }

  await transcriptStore.init?.(channel.client);
  const messages = await fetchInterviewMessages(channel);
  const transcript = buildInterviewTranscript(channel, messages, {
    registerStore,
    actor,
    entryUserId,
    entry,
    source,
  });
  const saved = await transcriptStore.appendTranscript(transcript);
  return {
    ok: true,
    saved,
    transcriptId: saved.transcriptId,
    fileName: saved.fileName,
    shard: saved.shard,
    duplicate: Boolean(saved.duplicate),
    messageCount: messages.length,
  };
}

async function deleteCompiledInterviewChannel(channel, transcriptStore, reason = 'Interview transcript compiled') {
  const deleted = await channel.delete(reason).then(() => true).catch(err => {
    console.error('Failed to delete compiled interview channel:', err);
    return false;
  });
  if (deleted) {
    await transcriptStore?.markChannelDeleted?.(channel.id).catch(err => {
      console.error('Failed to mark transcript channel deleted:', err);
      return false;
    });
  }
  return deleted;
}

async function compileAndDeleteInterviewChannel(channel, options = {}) {
  const compiled = await compileInterviewChannel(channel, options).catch(err => {
    console.error('Failed to compile interview transcript:', err);
    return { ok: false, code: 'compile-failed', error: err };
  });
  if (!compiled.ok) return { ...compiled, deleted: false };

  const deleted = await deleteCompiledInterviewChannel(
    channel,
    options.transcriptStore,
    'Closed interview transcript saved to JSON'
  );
  return { ...compiled, deleted };
}

function interviewStartTimeMs(entry = {}) {
  const value = new Date(entry.interviewCreatedAt || entry.registeredAt || '').getTime();
  return Number.isFinite(value) ? value : 0;
}

async function findApplicantInterviewReply(channel, applicantUserId, sinceMs, {
  untilMs = Number.POSITIVE_INFINITY,
  maxMessages = INTERVIEW_REPLY_SCAN_MAX_MESSAGES,
} = {}) {
  if (!channel?.messages?.fetch) return { ok: false, code: 'message-fetch-unavailable' };

  let before = null;
  let scanned = 0;
  let reachedStart = false;
  while (scanned < maxMessages) {
    const limit = Math.min(100, maxMessages - scanned);
    const batch = await channel.messages.fetch(before ? { limit, before } : { limit }).catch(err => {
      console.error(`Failed to inspect interview replies in ${channel.id || channel.name || 'unknown'}:`, err);
      return null;
    });
    if (!batch) return { ok: false, code: 'message-fetch-failed', scanned };
    if (!batch.size) return { ok: true, replied: false, scanned };

    scanned += batch.size;
    for (const message of batch.values()) {
      const createdAt = Number(message.createdTimestamp || message.createdAt?.getTime?.() || 0);
      if (createdAt && createdAt < sinceMs) {
        reachedStart = true;
        continue;
      }
      if (createdAt && createdAt >= untilMs) continue;
      if (!message.author?.bot && String(message.author?.id || '') === String(applicantUserId || '')) {
        return { ok: true, replied: true, scanned, messageId: message.id || '' };
      }
    }

    const oldest = batch.last?.();
    const oldestAt = Number(oldest?.createdTimestamp || oldest?.createdAt?.getTime?.() || 0);
    if (reachedStart || batch.size < limit || (oldestAt && oldestAt < sinceMs)) {
      return { ok: true, replied: false, scanned };
    }
    before = oldest?.id || null;
    if (!before) return { ok: true, replied: false, scanned };
  }

  return { ok: false, code: 'message-scan-limit', scanned };
}

async function expireUnansweredInterviews(client, {
  registerStore,
  transcriptStore = null,
  bridge = null,
  roleId = MINECRAFT_REGISTER_ROLE_ID,
  legacyRoleId = MINECRAFT_REGISTER_PENDING_ROLE_ID,
  rejectedRoleId = MINECRAFT_REGISTER_REJECTED_ROLE_ID,
  timeoutMs = INTERVIEW_REPLY_TIMEOUT_MS,
  limit = 50,
} = {}) {
  const summary = {
    checked: 0,
    answered: 0,
    expired: 0,
    closed: 0,
    unavailable: 0,
    failed: 0,
  };
  if (!client?.channels?.fetch || !registerStore?.getEntries) return summary;

  const now = Date.now();
  const safeTimeoutMs = Math.max(60_000, Number(timeoutMs) || INTERVIEW_REPLY_TIMEOUT_MS);
  const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
  const candidates = registerStore.getEntries()
    .filter(entry => {
      if (entry.status !== 'pending' || entry.answered || entry.interviewClosedAt || !entry.interviewChannelId) return false;
      const startedAt = interviewStartTimeMs(entry);
      return startedAt > 0 && now - startedAt >= safeTimeoutMs;
    })
    .slice(0, safeLimit);

  for (const candidate of candidates) {
    summary.checked += 1;
    try {
      const channel = await client.channels.fetch(candidate.interviewChannelId).catch(() => null);
      if (!channel?.guild || !channel.messages?.fetch) {
        summary.unavailable += 1;
        continue;
      }

      const replyCheck = await findApplicantInterviewReply(
        channel,
        candidate.userId,
        interviewStartTimeMs(candidate),
        { untilMs: interviewStartTimeMs(candidate) + safeTimeoutMs }
      );
      if (!replyCheck.ok) {
        summary.failed += 1;
        continue;
      }
      if (replyCheck.replied) {
        await registerStore.markAnswered?.(candidate.userId);
        summary.answered += 1;
        continue;
      }

      const current = registerStore.getUser?.(candidate.userId);
      if (!current || current.status !== 'pending' || current.answered || current.interviewClosedAt) continue;

      const actor = {
        id: client.user?.id || '',
        tag: client.user?.tag || client.user?.username || 'Rizebot',
      };
      const reason = 'Tidak menjawab pertanyaan interview dalam 24 jam.';
      const rejected = await registerStore.rejectUser(candidate.userId, actor, reason);
      if (!rejected) {
        summary.failed += 1;
        continue;
      }
      const closed = await registerStore.closeInterview(candidate.userId, actor) || rejected;
      summary.expired += 1;

      const member = await channel.guild.members.fetch(candidate.userId).catch(() => null);
      if (member) {
        await moveMemberToRejectedRole(member, {
          rejectedRoleId,
          pendingRoleId: legacyRoleId,
          verifiedRoleId: roleId,
        }).catch(err => {
          console.error('Failed to set rejected role after interview timeout:', err);
          return false;
        });
      }

      await channel.send({
        content: `<@${candidate.userId}> interview otomatis **gagal** karena tidak ada balasan dalam 24 jam. Interview ini sekarang ditutup.`,
        embeds: [buildInterviewEmbed({ ...closed, userId: candidate.userId }, { id: candidate.userId })],
        components: [buildInterviewButtons(candidate.userId, true)],
        allowedMentions: { users: [candidate.userId], roles: [] },
      }).catch(err => {
        console.error('Failed to send interview timeout notice:', err);
      });
      queueLegalAccessJob(bridge, 'revoke', closed, candidate.userId, actor);

      await channel.permissionOverwrites?.edit(candidate.userId, {
        ViewChannel: false,
        SendMessages: false,
      }).catch(() => null);
      const closedName = `closed-${closed.interviewId || 'interview'}`.slice(0, 100);
      await channel.setName?.(closedName, 'Interview auto-closed after 24 hours without reply').catch(() => null);

      let compileResult = null;
      if (transcriptStore?.appendTranscript) {
        compileResult = await compileInterviewChannel(channel, {
          registerStore,
          transcriptStore,
          actor: client.user,
          entryUserId: candidate.userId,
          entry: closed,
          source: 'auto-no-reply-timeout',
        }).catch(err => {
          console.error('Failed to compile timed-out interview:', err);
          return null;
        });
      }

      if (compileResult?.ok) {
        const deleted = await deleteCompiledInterviewChannel(
          channel,
          transcriptStore,
          'Interview timed out and transcript saved to JSON'
        );
        if (deleted) {
          summary.closed += 1;
          await sendCompileLog(client, [
            `Interview timeout: \`${closedName}\``,
            `Applicant: <@${candidate.userId}> | Gamertag: \`${closed.gamertag || '-'}\``,
            `Alasan: ${reason}`,
            `JSON: \`${compileResult.fileName}\` | Messages: ${compileResult.messageCount}`,
            'Channel deleted: yes',
          ]);
          continue;
        }
      }

      const archiveResult = await moveChannelToArchive(
        channel.guild,
        channel,
        'Interview timed out without applicant reply'
      );
      if (archiveResult.ok) summary.closed += 1;
      else summary.failed += 1;
    } catch (err) {
      summary.failed += 1;
      console.error(`Failed to expire interview for ${candidate.userId}:`, err);
    }
  }

  return summary;
}

async function sendCompileLog(client, lines) {
  const channel = await client.channels.fetch(REGISTRATION_INBOX_CHANNEL_ID).catch(() => null);
  if (!channel?.send) return false;
  await channel.send({
    content: Array.isArray(lines) ? lines.filter(Boolean).join('\n') : String(lines || ''),
    allowedMentions: { parse: [] },
  }).catch(err => {
    console.error('Failed to send compile log:', err);
  });
  return true;
}

async function compileClosedInterviewBacklogForGuild(guild, {
  limit = COMPILE_COMMAND_MAX_CHANNELS,
  registerStore,
  transcriptStore,
  actor,
} = {}) {
  const summary = {
    scanned: 0,
    compiled: 0,
    duplicates: 0,
    deleted: 0,
    failed: 0,
    failedLines: [],
    files: new Set(),
  };

  if (!guild) return summary;
  await guild.channels.fetch().catch(() => null);
  const candidates = [...guild.channels.cache.values()]
    .filter(isClosedInterviewAnyChannel)
    .sort((a, b) => Number(a.rawPosition || 0) - Number(b.rawPosition || 0))
    .slice(0, Math.max(1, Math.min(COMPILE_COMMAND_MAX_CHANNELS, Number(limit) || COMPILE_COMMAND_MAX_CHANNELS)));

  summary.scanned = candidates.length;
  for (const channel of candidates) {
    const result = await compileAndDeleteInterviewChannel(channel, {
      registerStore,
      transcriptStore,
      actor,
      source: 'manual-compile',
    });

    if (result.ok) {
      summary.compiled += result.duplicate ? 0 : 1;
      summary.duplicates += result.duplicate ? 1 : 0;
      summary.deleted += result.deleted ? 1 : 0;
      if (result.fileName) summary.files.add(result.fileName);
    } else {
      summary.failed += 1;
      summary.failedLines.push(`${channel.name}: ${result.code || 'compile-failed'}`);
    }
  }

  summary.files = [...summary.files];
  return summary;
}

async function handleCompileCommand(msg, options) {
  const parsed = parseCompileCommand(msg.content);
  if (!parsed) return false;
  if (!msg.guild) return true;
  if (!await isInterviewAdmin(msg)) {
    await replyNoPing(msg, 'Command compile interview khusus admin/interviewer.');
    return true;
  }
  if (!options.transcriptStore?.appendTranscript) {
    await replyNoPing(msg, 'Transcript store belum aktif.');
    return true;
  }

  const progress = await replyNoPing(
    msg,
    `Compile interview dimulai. Target maksimal ${parsed.limit} channel closed.`
  );
  const result = await compileClosedInterviewBacklogForGuild(msg.guild, {
    limit: parsed.limit,
    registerStore: options.registerStore,
    transcriptStore: options.transcriptStore,
    actor: msg.author,
  });

  const summary = [
    'Compile interview selesai.',
    `Channel dicek: ${result.scanned}`,
    `Transcript baru: ${result.compiled}`,
    `Sudah ada di JSON: ${result.duplicates}`,
    `Channel terhapus: ${result.deleted}`,
    `Gagal: ${result.failed}`,
    result.files.length ? `File JSON: ${result.files.join(', ')}` : '',
    result.failedLines.length ? `Gagal:\n${result.failedLines.slice(0, 8).join('\n')}` : '',
  ].filter(Boolean).join('\n');

  if (progress?.edit) {
    await progress.edit(noPing(summary)).catch(() => null);
  } else {
    await replyNoPing(msg, summary);
  }
  return true;
}

async function handleHelpCommand(msg, options) {
  const content = String(msg.content || '').trim();
  if (!/^!help\b/i.test(content)) return false;
  const userId = String(msg.author?.id || '').trim();
  const registerAdmin = isRegisterAdmin(msg);
  const interviewAdmin = await isInterviewAdmin(msg);
  const topupAdmin = userId === String(TOPUP_ADMIN_DISCORD_ID);
  const moderationAdmin = isAdmin(msg.member);
  await replyNoPing(msg, createRizebotHelpPayload({
    showRegisterAdmin: registerAdmin,
    showInterviewAdmin: interviewAdmin,
    showBridgeAdmin: topupAdmin,
    showTopupAdmin: topupAdmin,
    showModerationAdmin: moderationAdmin,
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

  if (options.transcriptStore?.appendTranscript && interaction.channel) {
    const compileResult = await compileInterviewChannel(interaction.channel, {
      registerStore,
      transcriptStore: options.transcriptStore,
      actor: interaction.user,
      entryUserId,
      entry,
      source: 'auto-close',
    }).catch(err => {
      console.error('Failed to compile closed interview:', err);
      return { ok: false, code: 'compile-failed' };
    });

    if (compileResult.ok) {
      await interaction.followUp({
        content: `Interview dicompile ke \`${compileResult.fileName}\`, lalu channel ticket akan dihapus.`,
        ephemeral: true,
      }).catch(() => null);
      const deleted = await deleteCompiledInterviewChannel(
        interaction.channel,
        options.transcriptStore,
        'Interview closed and transcript saved to JSON'
      );
      await sendCompileLog(interaction.client, [
        `Interview compiled: \`${closedName}\``,
        `Applicant: <@${entryUserId}> | Gamertag: \`${entry.gamertag || '-'}\``,
        `JSON: \`${compileResult.fileName}\` | Messages: ${compileResult.messageCount}`,
        `Channel deleted: ${deleted ? 'yes' : 'no'}`,
      ]);
      return true;
    }
  }

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
  transcriptStore = null,
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
        transcriptStore,
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
  transcriptStore = null,
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
        transcriptStore,
        registrationChannelId,
        privateChatChannelId,
      };

      if (await handleRegisterCommand(msg, options)) return true;
      if (await handleSetRegisterGamertagCommand(msg, options)) return true;
      if (await handleHelpCommand(msg, options)) return true;
      if (await handleSyncCitizenCommand(msg, options)) return true;
      if (await handleCompileCommand(msg, options)) return true;
      if (await handleArchiveInterviewsCommand(msg)) return true;
      if (await handleListCommand(msg, options)) return true;
      if (await handleStatusCommand(msg, options)) return true;
      return false;
    } catch (err) {
      const listCommand = parseListCommand(msg?.content);
      logCommandError('register-handler', msg, err, {
        command: listCommand ? '!list' : String(msg?.content || '').trim().split(/\s+/g)[0],
        stage: listCommand ? 'membangun atau memproses registry Minecraft' : 'memproses command register',
      });
      if (listCommand) {
        await sendCommandError(msg, {
          scope: 'register-handler',
          command: '!list',
          stage: 'membangun atau memproses registry Minecraft',
          error: err,
        });
        return true;
      }
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
  INTERVIEW_REPLY_TIMEOUT_MS,
  archiveClosedInterviewBacklog,
  createRegisterHandler,
  createRegisterInteractionHandler,
  createSubmissionReactionHandler,
  expireUnansweredInterviews,
  scanSubmissionApprovals,
};
