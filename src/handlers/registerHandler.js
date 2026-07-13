const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionsBitField,
} = require('discord.js');
const {
  INTERVIEW_ADMIN_ROLE_IDS,
  LAW_ADMIN_ROLE_IDS,
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
const registerProvisioningUsers = new Set();
const interviewActionLocks = new Set();
let interviewRepairInProgress = false;
const interviewDoctorDryRuns = new Map();
const INTERVIEW_DRY_RUN_VALID_MS = 30 * 60 * 1000;
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
  return normalizeGamertag(value).replace(/\s+/g, '').toLowerCase();
}

function gamertagDisplayKey(value) {
  return normalizeGamertag(value).toLowerCase();
}

function canonicalGamertagFromBridge(bridge, value) {
  const requested = normalizeGamertag(value);
  const online = requested ? bridge?.getPlayerStatusByGamertag?.(requested) : null;
  const canonical = normalizeGamertag(online?.name || '');
  return isValidGamertag(canonical) ? canonical : requested;
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
  const canManageNicknames = botMember?.permissions?.has?.(PermissionsBitField.Flags.ManageNicknames);
  if (canManageNicknames === false || member.manageable === false) return false;

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

function buildInterviewButtonId(action, userId, sessionNumber = 0) {
  const suffix = Math.max(0, Math.floor(Number(sessionNumber) || 0));
  return `${INTERVIEW_BUTTON_PREFIX}:${action}:${userId}${suffix ? `:${suffix}` : ''}`;
}

function parseInterviewButtonId(customId) {
  const match = String(customId || '').match(/^interview:(approve|reject|close):(\d{5,32})(?::(\d+))?$/);
  if (!match) return null;
  return { action: match[1], userId: match[2], sessionNumber: Number(match[3] || 0) };
}

function sessionNumberFromInterviewId(value) {
  const match = String(value || '').match(/(\d+)$/);
  return match ? Math.max(0, Number(match[1]) || 0) : 0;
}

function buildInterviewButtons(userId, disabled = false, sessionNumber = 0, decision = 'PENDING') {
  const decided = ['APPROVED', 'REJECTED'].includes(String(decision).toUpperCase());
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildInterviewButtonId('approve', userId, sessionNumber))
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled || decided),
    new ButtonBuilder()
      .setCustomId(buildInterviewButtonId('reject', userId, sessionNumber))
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled || decided),
    new ButtonBuilder()
      .setCustomId(buildInterviewButtonId('close', userId, sessionNumber))
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

function buildListButtonId(page, filter = 'all', action = 'page') {
  const safeAction = String(action || 'page').replace(/[^a-z0-9_-]/gi, '').slice(0, 20) || 'page';
  return `${LIST_BUTTON_PREFIX}:${normalizeListFilter(filter)}:${safeAction}:${Math.max(1, Number(page) || 1)}`;
}

function parseListButtonId(customId) {
  const raw = String(customId || '');
  const parts = raw.split(':');
  const validFilters = new Set(['all', 'approved', 'pending', 'rejected']);
  if (parts[0] !== LIST_BUTTON_PREFIX) return null;

  if (parts.length === 4 && validFilters.has(parts[1])) {
    const page = parseInt(parts[3], 10);
    return {
      filter: normalizeListFilter(parts[1]),
      action: String(parts[2] || 'page').toLowerCase(),
      page: Number.isFinite(page) && page > 0 ? page : 1,
    };
  }

  if (parts.length === 3 && validFilters.has(parts[1])) {
    const page = parseInt(parts[2], 10);
    return {
      filter: normalizeListFilter(parts[1]),
      action: 'legacy',
      page: Number.isFinite(page) && page > 0 ? page : 1,
    };
  }

  if (parts.length !== 2) return null;
  const page = parseInt(parts[1], 10);
  if (!Number.isFinite(page) || page <= 0) return null;
  return {
    filter: 'all',
    action: 'legacy',
    page,
  };
}

function buildListButtons(page, totalPages, filter = 'all') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildListButtonId(1, filter, 'first'))
      .setLabel('First')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(buildListButtonId(Math.max(1, page - 1), filter, 'prev'))
      .setLabel('Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(buildListButtonId(Math.min(totalPages, page + 1), filter, 'next'))
      .setLabel('Next')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page >= totalPages),
    new ButtonBuilder()
      .setCustomId(buildListButtonId(totalPages, filter, 'last'))
      .setLabel('Last')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages)
  );
}

function buildListFilterButtons(activeFilter = 'all') {
  const filter = normalizeListFilter(activeFilter);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildListButtonId(1, 'all', 'filter'))
      .setLabel('Semua')
      .setStyle(filter === 'all' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildListButtonId(1, 'approved', 'filter'))
      .setLabel('Lolos')
      .setStyle(filter === 'approved' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildListButtonId(1, 'pending', 'filter'))
      .setLabel('Pending')
      .setStyle(filter === 'pending' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildListButtonId(1, 'rejected', 'filter'))
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

function maxInterviewNumberFromGuild(guild) {
  let max = 0;
  const channels = guild?.channels?.cache?.values?.() || [];
  for (const channel of channels) {
    const match = String(channel?.name || '').match(/(?:^|-)interview-(\d{3,})(?:$|-)/i);
    const value = match ? Number(match[1]) : 0;
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max;
}

async function handleRegisterCommandUnlocked(msg, options) {
  const requestedGamertag = parseRegisterCommand(msg.content);
  if (requestedGamertag === null) return false;
  if (!requestedGamertag || !isValidGamertag(requestedGamertag)) {
    await replyNoPing(msg, 'Format: `!register <gamertag_minecraft>` (3-32 huruf/angka/underscore/spasi).');
    return true;
  }
  const gamertag = canonicalGamertagFromBridge(options.bridge, requestedGamertag);

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

  let existing = registerStore.getUser(msg.author.id);
  if (existing?.status === 'approved') {
    let currentGamertag = normalizeGamertag(existing.gamertag);
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

    if (gamertagDisplayKey(currentGamertag) !== gamertagDisplayKey(gamertag)) {
      const canonicalized = await registerStore.updateApprovedGamertag(
        msg.author.id,
        gamertag,
        msg.author?.tag || msg.author?.username || existing.username || ''
      );
      if (canonicalized?.entry) {
        existing = canonicalized.entry;
        currentGamertag = normalizeGamertag(existing.gamertag);
      }
    }

    const nicknameNote = await syncGamertagNickname(member, currentGamertag || gamertag, 'approved gamertag refresh');
    await moveMemberToCitizenRole(member, {
      citizenRoleId: verifiedRoleId,
      legacyRoleId: pendingRoleId,
      rejectedRoleId,
    }).catch(err => {
      console.error('Failed to refresh legal role:', err);
      return false;
    });
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

  const activeSession = options.database?.getInterviewSession?.(msg.author.id, { by: 'user', activeOnly: true });
  if (activeSession) {
    await replyNoPing(
      msg,
      activeSession.channelId
        ? `Kamu sudah punya interview aktif: ${channelMention(activeSession.channelId)} (\`${activeSession.interviewId}\`).`
        : `Interview \`${activeSession.interviewId}\` sedang dibuat. Tunggu sebentar dan jangan kirim \`!reg\` lagi.`
    );
    return true;
  }

  const duplicate = registerStore.findUserByGamertag?.(gamertag, msg.author.id);
  if (duplicate) {
    await replyNoPing(msg, `Gamertag \`${gamertag}\` sudah dipakai oleh user lain.`);
    return true;
  }

  let reservedSession = null;
  let interviewId;
  if (options.database?.reserveInterviewSession) {
    const reservation = options.database.reserveInterviewSession({
      userId: msg.author.id,
      username: msg.author?.tag || msg.author?.username || '',
      gamertag,
      minimumSequence: maxInterviewNumberFromGuild(msg.guild),
      actor: msg.author,
    });
    if (!reservation.ok) {
      const session = reservation.session;
      await replyNoPing(
        msg,
        reservation.code === 'active-gamertag-session'
          ? `Gamertag \`${gamertag}\` sedang dipakai interview aktif milik <@${session?.userId || '0'}>.`
          : session?.channelId
            ? `Kamu sudah punya interview aktif: ${channelMention(session.channelId)}.`
            : `Interview \`${session?.interviewId || '-'}\` masih dalam proses pembuatan.`
      );
      return true;
    }
    reservedSession = reservation.session;
    interviewId = reservedSession.interviewId;
  } else {
    interviewId = await registerStore.nextInterviewId();
  }
  const channel = await createInterviewChannel(msg, interviewId, msg.author).catch(err => {
    console.error('Failed to create interview channel:', err);
    return null;
  });
  if (!channel) {
    if (reservedSession) {
      options.database.failInterviewSession(reservedSession.sessionNumber, 'Discord channel creation failed', msg.author);
    }
    await replyNoPing(msg, 'Gagal membuat channel interview. Cek permission bot Manage Channels.');
    return true;
  }

  if (reservedSession) {
    try {
      reservedSession = options.database.attachInterviewChannel(reservedSession.sessionNumber, channel.id, msg.author);
    } catch (error) {
      options.database.failInterviewSession(reservedSession.sessionNumber, error.message, msg.author);
      await channel.delete('Interview reservation attach failed').catch(() => null);
      await replyNoPing(msg, `Gagal menghubungkan session interview ke database: ${error.message}`);
      return true;
    }
  }

  let saved;
  try {
    saved = await registerStore.upsertPendingUser(
      msg.author.id,
      gamertag,
      msg.author?.tag || msg.author?.username || '',
      {
        interviewId,
        interviewChannelId: channel.id,
        interviewCreatedAt: new Date().toISOString(),
      }
    );
  } catch (error) {
    if (reservedSession) {
      options.database.closeInterviewSession(reservedSession, {
        actor: msg.author,
        force: true,
        reason: `Registry persist failed: ${error.message}`,
      });
    }
    await channel.delete('Registry persist failed after session reservation').catch(() => null);
    await replyNoPing(msg, `Register dibatalkan karena data gagal disimpan: ${error.message}`);
    return true;
  }
  if (saved?.duplicate) {
    if (reservedSession) {
      options.database.closeInterviewSession(reservedSession, {
        actor: msg.author,
        force: true,
        reason: `Gamertag conflict with ${saved.duplicateUserId}`,
      });
    }
    await channel.delete('Duplicate Minecraft gamertag registration').catch(() => null);
    await replyNoPing(msg, `Gamertag \`${gamertag}\` sudah dipakai oleh user lain.`);
    return true;
  }

  const nicknameNote = await syncGamertagNickname(member, gamertag, 'pending register');
  await moveMemberToPendingRole(member, { pendingRoleId, verifiedRoleId, rejectedRoleId }).catch(err => {
    console.error('Failed to set pending register role:', err);
    return false;
  });

  const entry = { ...saved.entry, userId: msg.author.id };
  await channel.send({
    content: `<@${msg.author.id}>, interview akses Minecraft kamu dimulai. Silakan jawab semua pertanyaan dan kirim perjanjian wajib di bawah ini.`,
    embeds: [buildInterviewEmbed(entry, msg.author)],
    components: [buildInterviewButtons(msg.author.id, false, reservedSession?.sessionNumber || sessionNumberFromInterviewId(interviewId))],
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

async function handleRegisterCommand(msg, options) {
  if (parseRegisterCommand(msg?.content) === null) return false;
  if (interviewRepairInProgress) {
    await replyNoPing(msg, 'Registrasi sedang maintenance karena Interview Doctor menjalankan repair. Coba lagi setelah proses selesai.');
    return true;
  }
  const userId = String(msg?.author?.id || '').trim();
  if (!userId) return handleRegisterCommandUnlocked(msg, options);
  if (registerProvisioningUsers.has(userId)) {
    await replyNoPing(msg, 'Register kamu sedang diproses. Tunggu channel interview selesai dibuat; jangan kirim `!reg` berulang kali.');
    return true;
  }
  registerProvisioningUsers.add(userId);
  try {
    return await handleRegisterCommandUnlocked(msg, options);
  } finally {
    registerProvisioningUsers.delete(userId);
  }
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
  const gamertag = canonicalGamertagFromBridge(options.bridge, parsed.gamertag);
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

  const duplicate = options.registerStore.findUserByGamertag?.(gamertag, parsed.userId);
  if (duplicate) {
    await replyNoPing(msg, `Gamertag \`${parsed.gamertag}\` sudah dipakai oleh <@${duplicate.userId}>.`);
    return true;
  }

  const member = await msg.guild.members.fetch(parsed.userId).catch(() => null);
  const user = member?.user || await msg.client.users.fetch(parsed.userId).catch(() => null);
  const updated = await options.registerStore.updateApprovedGamertag?.(
    parsed.userId,
    gamertag,
    user?.tag || user?.username || entry.username || ''
  );
  if (!updated || updated.duplicate || updated.notApproved) {
    await replyNoPing(msg, 'Gagal mengubah gamertag legal. Coba lagi atau cek data register.');
    return true;
  }

  if (member) {
    await syncGamertagNickname(member, gamertag, 'admin gamertag update');
    await moveMemberToCitizenRole(member, {
      citizenRoleId: options.verifiedRoleId,
      legacyRoleId: options.pendingRoleId,
      rejectedRoleId: options.rejectedRoleId,
    }).catch(err => {
      console.error('Failed to refresh legal role after admin gamertag update:', err);
      return false;
    });
  }

  if (updated.oldGamertag && gamertagKey(updated.oldGamertag) !== gamertagKey(gamertag)) {
    queueLegalAccessJob(options.bridge, 'revoke', { gamertag: updated.oldGamertag }, parsed.userId, msg.author);
  }
  queueLegalAccessJob(options.bridge, 'approve', updated.entry, parsed.userId, msg.author);

  const oldText = updated.oldGamertag && gamertagDisplayKey(updated.oldGamertag) !== gamertagDisplayKey(gamertag)
    ? ` dari \`${updated.oldGamertag}\``
    : '';
  await replyNoPing(
    msg,
    `Gamertag legal <@${parsed.userId}> diubah${oldText} menjadi \`${updated.entry.gamertag}\` oleh admin. Cache akses Minecraft ikut disync.`
  );
  return true;
}

function parseInterviewAdminCommand(content) {
  const match = String(content || '').trim().match(/^!(accept|approve|reject|close)(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  let tail = String(match[2] || '').trim();
  const force = /(?:^|\s)--force(?:\s|$)/i.test(tail);
  tail = tail.replace(/(?:^|\s)--force(?=\s|$)/ig, ' ').replace(/\s+/g, ' ').trim();
  const userMatch = tail.match(/<@!?(\d{5,32})>|(?:^|\s)(\d{5,32})(?=\s|$)/);
  const userId = userMatch ? (userMatch[1] || userMatch[2]) : '';
  if (userMatch) tail = tail.replace(userMatch[0], ' ').replace(/\s+/g, ' ').trim();
  return {
    action: match[1].toLowerCase() === 'approve' ? 'accept' : match[1].toLowerCase(),
    force,
    userId,
    detail: tail,
  };
}

function actorPayload(user) {
  return { id: String(user?.id || ''), name: String(user?.tag || user?.username || 'Discord Admin') };
}

function channelInterviewIdentity(channel) {
  const match = String(channel?.name || '').match(/(?:^|-)interview-(\d{3,})(?:$|-)/i);
  const sessionNumber = match ? Number(match[1]) : 0;
  return {
    sessionNumber: Number.isFinite(sessionNumber) ? sessionNumber : 0,
    interviewId: sessionNumber ? `interview-${String(sessionNumber).padStart(4, '0')}` : '',
  };
}

async function resolveInterviewCommandTarget(msg, parsed, options) {
  const database = options.database;
  const channelSession = database?.getInterviewSession?.(msg.channelId, { by: 'channel' }) || null;
  const channelLinked = options.registerStore.findUserByInterviewChannel?.(msg.channelId) || null;
  let session = channelSession;
  let linked = channelLinked;
  const userId = String(parsed.userId || session?.userId || linked?.userId || '').trim();
  if (parsed.userId && session?.userId !== userId) {
    session = database?.getInterviewSession?.(userId, { by: 'user', activeOnly: true }) ||
      database?.getInterviewSession?.(userId, { by: 'user' }) || null;
  }
  if (parsed.userId && linked?.userId !== userId) linked = null;
  const entry = userId ? options.registerStore.getUser(userId) : null;
  if (!session && userId) {
    session = database?.getInterviewSession?.(userId, { by: 'user', activeOnly: true }) ||
      database?.getInterviewSession?.(userId, { by: 'user' }) || null;
  }
  return { userId, entry, session, linked, channelSession, channelLinked };
}

async function ensureForceRegistryEntry(msg, parsed, target, options) {
  if (target.entry) return target.entry;
  if (!parsed.force || !target.userId) return null;
  const gamertag = canonicalGamertagFromBridge(
    options.bridge,
    parsed.action === 'accept' ? parsed.detail : target.session?.gamertag || ''
  );
  if (!isValidGamertag(gamertag)) return null;
  const duplicate = options.registerStore.findUserByGamertag?.(gamertag, target.userId);
  if (duplicate) {
    await replyNoPing(msg, `Force dibatalkan: gamertag \`${gamertag}\` dimiliki <@${duplicate.userId}>. Gunakan review/takeover terpisah; data tidak ditimpa otomatis.`);
    return null;
  }
  const member = await msg.guild.members.fetch(target.userId).catch(() => null);
  const currentChannelOwnedByTarget = isInterviewTicketChannel(msg.channel) &&
    (!target.channelSession || target.channelSession.userId === target.userId) &&
    (!target.channelLinked || target.channelLinked.userId === target.userId);
  const channelId = target.session?.channelId || (currentChannelOwnedByTarget ? msg.channelId : '');
  const targetChannel = channelId ? msg.guild.channels.cache.get(channelId) : null;
  const identity = channelInterviewIdentity(targetChannel || (currentChannelOwnedByTarget ? msg.channel : null));
  const result = await options.registerStore.upsertPendingUser(
    target.userId,
    gamertag,
    member?.user?.tag || member?.user?.username || '',
    {
      interviewId: target.session?.interviewId || identity.interviewId,
      interviewChannelId: channelId,
      interviewCreatedAt: targetChannel?.createdAt?.toISOString?.() ||
        (currentChannelOwnedByTarget ? msg.channel?.createdAt?.toISOString?.() : '') || new Date().toISOString(),
    }
  );
  return result?.duplicate ? null : result?.entry || null;
}

function ensureCommandSession(msg, target, entry, options, force) {
  const database = options.database;
  if (!database || !target.userId) return target.session || null;
  let session = target.session;
  const actor = actorPayload(msg.author);
  const currentChannelOwnedByTarget = isInterviewTicketChannel(msg.channel) &&
    (!target.channelSession || target.channelSession.userId === target.userId) &&
    (!target.channelLinked || target.channelLinked.userId === target.userId);
  if (session && force && String(session.channelId || '') !== String(msg.channelId || '') && currentChannelOwnedByTarget) {
    session = database.relinkInterviewSession(session, {
      channelId: msg.channelId,
      userId: target.userId,
      username: entry?.username || '',
      gamertag: entry?.gamertag || session.gamertag,
      lifecycleStatus: 'OPEN',
      legacyInterviewId: session.interviewId,
    }, actor);
  }
  if (session) return session;
  const targetChannel = msg.guild?.channels?.cache?.get(entry?.interviewChannelId || '') ||
    (currentChannelOwnedByTarget ? msg.channel : null);
  if (!targetChannel) {
    if (!force || !entry?.gamertag) return null;
    const allocation = database.allocateInterviewCode({ minimum: maxInterviewNumberFromGuild(msg.guild) });
    return database.upsertInterviewSessionFromRepair({
      sessionNumber: allocation.sessionNumber,
      interviewId: allocation.interviewId,
      userId: target.userId,
      username: entry.username || '',
      gamertag: entry.gamertag,
      channelId: '',
      lifecycleStatus: 'ORPHANED',
      decision: String(entry.status || '').toUpperCase(),
    }, actor);
  }
  const channelIdentity = channelInterviewIdentity(targetChannel);
  let allocation = channelIdentity;
  const numberConflict = allocation.sessionNumber
    ? database.getInterviewSession(String(allocation.sessionNumber), { by: 'number' })
    : null;
  if (!allocation.sessionNumber || (numberConflict && numberConflict.userId !== target.userId)) {
    allocation = database.allocateInterviewCode({ minimum: maxInterviewNumberFromGuild(msg.guild) });
  } else {
    database.setInterviewSequenceAtLeast(allocation.sessionNumber);
  }
  return database.upsertInterviewSessionFromRepair({
    sessionNumber: allocation.sessionNumber,
    interviewId: allocation.interviewId,
    legacyInterviewId: channelIdentity.interviewId,
    userId: target.userId,
    username: entry?.username || '',
    gamertag: entry?.gamertag || target.session?.gamertag || 'unknown',
    channelId: targetChannel.id,
    lifecycleStatus: 'OPEN',
    decision: String(entry?.status || '').toUpperCase(),
    openedAt: targetChannel.createdAt?.toISOString?.(),
  }, actor);
}

async function confirmForceInterviewAction(msg, parsed, target, entry) {
  if (!parsed.force) return true;
  const affectedChannelId = target.session?.channelId || entry?.interviewChannelId ||
    (isInterviewTicketChannel(msg.channel) && (!target.channelSession || target.channelSession.userId === target.userId)
      ? msg.channelId
      : '');
  const token = `${Date.now().toString(36)}_${String(msg.id || msg.author.id).slice(-8)}`;
  const confirmId = `iforce_yes_${token}`;
  const cancelId = `iforce_no_${token}`;
  const panel = await msg.reply({
    embeds: [new EmbedBuilder()
      .setColor(parsed.action === 'accept' ? 0x2ecc71 : parsed.action === 'reject' ? 0xe74c3c : 0xf2c94c)
      .setTitle(`Konfirmasi FORCE ${parsed.action.toUpperCase()}`)
      .setDescription([
        `Applicant: <@${target.userId}>`,
        `Gamertag: \`${entry?.gamertag || target.session?.gamertag || parsed.detail || '-'}\``,
        `Session: \`${target.session?.interviewId || channelInterviewIdentity(msg.channel).interviewId || 'akan direkonstruksi'}\``,
        `Channel session: ${affectedChannelId ? `<#${affectedChannelId}>` : '`tidak ada / akan direkonstruksi tanpa channel`'}`,
        '',
        'Force dapat membangun ulang mapping dan mengubah role serta akses Minecraft. Pastikan target benar.',
      ].join('\n'))],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(confirmId).setLabel('Konfirmasi Force').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(cancelId).setLabel('Batalkan').setStyle(ButtonStyle.Secondary)
    )],
    allowedMentions: { parse: [], repliedUser: false },
  });
  if (!panel?.awaitMessageComponent) return true;
  const interaction = await panel.awaitMessageComponent({
    filter: item => item.user.id === msg.author.id && [confirmId, cancelId].includes(item.customId),
    time: 60_000,
  }).catch(() => null);
  if (!interaction) {
    await panel.edit({ content: 'Konfirmasi force kedaluwarsa; tidak ada perubahan.', embeds: [], components: [] }).catch(() => null);
    return false;
  }
  await interaction.deferUpdate().catch(() => null);
  if (interaction.customId === cancelId) {
    await panel.edit({ content: 'Force dibatalkan.', embeds: [], components: [] }).catch(() => null);
    return false;
  }
  await panel.edit({ content: 'Force dikonfirmasi. Memproses...', embeds: [], components: [] }).catch(() => null);
  return true;
}

async function handleInterviewAdminCommand(msg, options) {
  const parsed = parseInterviewAdminCommand(msg.content);
  if (!parsed) return false;
  if (interviewRepairInProgress) {
    await replyNoPing(msg, 'Keputusan interview dikunci sementara karena repair sedang berjalan.');
    return true;
  }
  if (!await isInterviewAdmin(msg)) {
    await replyNoPing(msg, 'Command accept/reject/close khusus admin atau interviewer.');
    return true;
  }
  if (!await ensureRegisterStore(options.registerStore, msg.client)) {
    await replyNoPing(msg, 'Register store belum siap.');
    return true;
  }
  let target = await resolveInterviewCommandTarget(msg, parsed, options);
  if (!target.userId) {
    await replyNoPing(msg, `Applicant tidak dapat dikenali. Gunakan \`!${parsed.action}${parsed.force ? ' --force' : ''} @user\`.`);
    return true;
  }
  let entry = target.entry;
  if (!entry && !parsed.force && parsed.action !== 'close') {
    await replyNoPing(
      msg,
      `Data interview <@${target.userId}> tidak ditemukan. Gunakan mode \`--force\` setelah memastikan user dan gamertag.`
    );
    return true;
  }
  if (parsed.action === 'accept' && parsed.force) {
    const forcedGamertag = canonicalGamertagFromBridge(options.bridge, parsed.detail || entry?.gamertag || '');
    if (!isValidGamertag(forcedGamertag)) {
      await replyNoPing(msg, 'Data gamertag belum ada. Gunakan `!accept --force @user gamertag`; gamertag harus 3-32 huruf/angka/underscore/spasi.');
      return true;
    }
    const duplicate = options.registerStore.findUserByGamertag?.(forcedGamertag, target.userId);
    if (duplicate) {
      await replyNoPing(msg, `Force dibatalkan: gamertag \`${forcedGamertag}\` dimiliki <@${duplicate.userId}>.`);
      return true;
    }
  }
  if (parsed.force && parsed.action === 'reject' && !entry && !isValidGamertag(target.session?.gamertag || '')) {
    await replyNoPing(msg, 'Force reject membutuhkan record atau session dengan gamertag yang valid. Gunakan `!relink-interview @user gamertag` terlebih dahulu.');
    return true;
  }
  const canCloseCurrentTicket = isInterviewTicketChannel(msg.channel) &&
    (!target.channelSession || target.channelSession.userId === target.userId) &&
    (!target.channelLinked || target.channelLinked.userId === target.userId);
  if (parsed.action === 'close' && !entry && !target.session && !canCloseCurrentTicket) {
    await replyNoPing(msg, `Tidak ada record, session, atau channel interview milik <@${target.userId}> yang dapat ditutup.`);
    return true;
  }
  const actionKey = `${target.userId}:${target.session?.sessionNumber || msg.channelId}`;
  if (interviewActionLocks.has(actionKey)) {
    await replyNoPing(msg, 'Interview ini sedang diproses oleh aksi lain.');
    return true;
  }
  interviewActionLocks.add(actionKey);
  try {
    if (!await confirmForceInterviewAction(msg, parsed, target, entry)) return true;

    if (!entry && parsed.force && parsed.action !== 'close') {
      entry = await ensureForceRegistryEntry(msg, parsed, target, options);
      if (!entry) {
        await replyNoPing(
          msg,
          `Data <@${target.userId}> tidak dapat direkonstruksi. Untuk recovery accept gunakan \`!accept --force @user gamertag\`.`
        );
        return true;
      }
    }
    if (parsed.action === 'accept' && parsed.force) {
      const forcedGamertag = canonicalGamertagFromBridge(options.bridge, parsed.detail || entry.gamertag);
      if (gamertagDisplayKey(entry.gamertag) !== gamertagDisplayKey(forcedGamertag)) {
        entry = await options.registerStore.updateUser(target.userId, forcedGamertag, entry.username || '');
        if (!entry || entry.duplicate) {
          await replyNoPing(msg, 'Gagal memperbarui gamertag untuk force accept.');
          return true;
        }
      }
    }

    let session = ensureCommandSession(msg, target, entry, options, parsed.force);
    if (!session && !parsed.force) {
      await replyNoPing(msg, 'Session interview aktif tidak ditemukan. Jalankan `!interview-doctor`, atau gunakan mode `--force` setelah target diverifikasi.');
      return true;
    }
    if (session && !parsed.force && !['RESERVED', 'OPEN'].includes(session.lifecycleStatus)) {
      await replyNoPing(msg, `Session \`${session.interviewId}\` sudah ${session.lifecycleStatus}. Gunakan \`--force\` hanya setelah memeriksa target dan laporan Interview Doctor.`);
      return true;
    }
    if (session && !parsed.force && parsed.action !== 'close' && session.decision !== 'PENDING') {
      await replyNoPing(msg, `Session \`${session.interviewId}\` sudah diputuskan ${session.decision}. Keputusan kedua ditolak agar data tidak tumpang tindih.`);
      return true;
    }
    const actor = actorPayload(msg.author);
    const member = await msg.guild.members.fetch(target.userId).catch(() => null);
    if (parsed.action === 'accept') {
      const updated = await options.registerStore.approveUser(target.userId, actor);
      if (!updated) throw new Error('Record register tidak dapat di-approve');
      if (session) session = options.database.decideInterviewSession(session, 'APPROVED', { actor, force: parsed.force });
      if (session && parsed.force && !session.channelId) {
        session = options.database.closeInterviewSession(session, { actor, force: true, reason: 'Force accept tanpa channel interview aktif' });
      }
      if (member) {
        await syncGamertagNickname(member, updated.gamertag, parsed.force ? 'force accept interview' : 'accept interview command');
        await moveMemberToCitizenRole(member, {
          citizenRoleId: options.verifiedRoleId,
          legacyRoleId: options.pendingRoleId,
          rejectedRoleId: options.rejectedRoleId,
        });
      }
      queueLegalAccessJob(options.bridge, 'approve', updated, target.userId, msg.author);
      await replyNoPing(msg, `✅ <@${target.userId}> diputuskan **LOLOS**${parsed.force ? ' melalui force recovery' : ''} sebagai \`${updated.gamertag}\`. Session: \`${session?.interviewId || 'legacy'}\`.`);
      return true;
    }
    if (parsed.action === 'reject') {
      const reason = parsed.detail || (parsed.force ? 'Force reject oleh admin' : 'Ditolak setelah review interview');
      const updated = await options.registerStore.rejectUser(target.userId, actor, reason);
      if (!updated) throw new Error('Record register tidak dapat di-reject');
      if (session) session = options.database.decideInterviewSession(session, 'REJECTED', { actor, reason, force: parsed.force });
      if (session && parsed.force && !session.channelId) {
        session = options.database.closeInterviewSession(session, { actor, force: true, reason: 'Force reject tanpa channel interview aktif' });
      }
      if (member) {
        await moveMemberToRejectedRole(member, {
          rejectedRoleId: options.rejectedRoleId,
          pendingRoleId: options.pendingRoleId,
          verifiedRoleId: options.verifiedRoleId,
        });
      }
      queueLegalAccessJob(options.bridge, 'revoke', updated, target.userId, msg.author);
      await replyNoPing(msg, `❌ <@${target.userId}> diputuskan **GAGAL**${parsed.force ? ' melalui force recovery' : ''}. Alasan: ${reason}`);
      return true;
    }

    if (!parsed.force && entry?.status === 'pending') {
      await replyNoPing(msg, 'Interview masih PENDING. Putuskan `!accept` atau `!reject` dahulu, atau gunakan `!close --force` untuk menutup tanpa keputusan.');
      return true;
    }
    if (entry) await options.registerStore.closeInterview(target.userId, actor);
    if (session) session = options.database.closeInterviewSession(session, { actor, force: parsed.force, reason: parsed.detail });
    const currentChannelOwnedByTarget = isInterviewTicketChannel(msg.channel) &&
      (!target.channelSession || target.channelSession.userId === target.userId) &&
      (!target.channelLinked || target.channelLinked.userId === target.userId);
    const closeChannelId = session?.channelId || entry?.interviewChannelId ||
      (currentChannelOwnedByTarget ? msg.channelId : '');
    const targetChannel = closeChannelId
      ? (closeChannelId === msg.channelId ? msg.channel : await msg.guild.channels.fetch(closeChannelId).catch(() => null))
      : null;
    await targetChannel?.permissionOverwrites?.edit(target.userId, { ViewChannel: false, SendMessages: false }).catch(() => null);
    const closedName = `closed-${session?.interviewId || entry?.interviewId || channelInterviewIdentity(targetChannel).interviewId || 'interview'}`.slice(0, 100);
    await targetChannel?.setName?.(closedName, parsed.force ? 'Force close interview' : 'Close interview command').catch(() => null);
    if (options.transcriptStore?.appendTranscript && targetChannel) {
      const compiled = await compileInterviewChannel(targetChannel, {
        registerStore: options.registerStore,
        transcriptStore: options.transcriptStore,
        actor: msg.author,
        entryUserId: target.userId,
        entry,
        source: parsed.force ? 'force-close-command' : 'close-command',
      }).catch(error => ({ ok: false, code: error.message }));
      if (compiled.ok) {
        await replyNoPing(msg, `🔒 Interview <@${target.userId}> ditutup dan dicompile ke \`${compiled.fileName}\`${parsed.force ? ' melalui force recovery' : ''}.`);
        const deleted = await deleteCompiledInterviewChannel(
          targetChannel,
          options.transcriptStore,
          parsed.force ? 'Force-closed interview compiled' : 'Interview command close compiled'
        );
        await sendCompileLog(msg.client, [
          `Interview command close: \`${closedName}\``,
          `Applicant: <@${target.userId}> | Session: \`${session?.interviewId || 'legacy'}\``,
          `JSON: \`${compiled.fileName}\` | Channel deleted: ${deleted ? 'yes' : 'no'}`,
        ]);
        return true;
      }
    }
    if (targetChannel) {
      await moveChannelToArchive(msg.guild, targetChannel, parsed.force ? 'Force-closed interview archived' : 'Interview archived').catch(() => null);
    }
    await replyNoPing(msg, `🔒 Interview <@${target.userId}> ditutup${parsed.force ? ' melalui force recovery' : ''}. Session: \`${session?.interviewId || 'legacy'}\`.`);
    return true;
  } catch (error) {
    console.error('Interview admin command failed:', error);
    await replyNoPing(msg, `Gagal memproses command: ${error.message}`);
    return true;
  } finally {
    interviewActionLocks.delete(actionKey);
  }
}

async function inspectInterviewChannel(channel, registerStore, database) {
  const identity = channelInterviewIdentity(channel);
  const linked = registerStore.findUserByInterviewChannel?.(channel.id) || null;
  const session = database?.getInterviewSession?.(channel.id, { by: 'channel' }) || null;
  let userId = session?.userId || linked?.userId || '';
  let gamertag = session?.gamertag || linked?.entry?.gamertag || '';
  let controlMessageId = '';
  try {
    const ordered = await fetchInterviewMessages(channel, 1000);
    for (const message of ordered) {
      for (const row of message.components || []) {
        for (const component of row.components || []) {
          const parsed = parseInterviewButtonId(component.customId);
          if (!parsed) continue;
          userId = userId || parsed.userId;
          controlMessageId = message.id;
        }
      }
      for (const embed of message.embeds || []) {
        const description = String(embed.description || '');
        const applicant = description.match(/Discord ID:\s*`(\d{5,32})`/i) || description.match(/Applicant:\s*<@!?(\d{5,32})>/i);
        const tag = description.match(/Gamertag:\s*`([^`]+)`/i);
        if (applicant) userId = userId || applicant[1];
        if (tag) gamertag = gamertag || normalizeGamertag(tag[1]);
      }
      if (!userId) {
        const mention = String(message.content || '').match(/<@!?(\d{5,32})>/);
        if (mention) userId = mention[1];
      }
    }
  } catch (error) {
    return {
      channelId: channel.id,
      channelName: channel.name,
      createdTimestamp: Number(channel.createdTimestamp || 0),
      ...identity,
      userId,
      gamertag,
      linkedUserId: linked?.userId || '',
      sessionNumber: session?.sessionNumber || identity.sessionNumber,
      session,
      scanError: error.message,
      controlMessageId,
    };
  }
  return {
    channelId: channel.id,
    channelName: channel.name,
    createdTimestamp: Number(channel.createdTimestamp || 0),
    ...identity,
    userId,
    gamertag,
    linkedUserId: linked?.userId || '',
    sessionNumber: session?.sessionNumber || identity.sessionNumber,
    session,
    scanError: '',
    controlMessageId,
  };
}

async function buildInterviewDoctorReport(guild, options) {
  await guild.channels.fetch().catch(() => null);
  const channels = [...guild.channels.cache.values()]
    .filter(channel => channel.type === ChannelType.GuildText && isInterviewTicketChannel(channel));
  const descriptors = [];
  for (const channel of channels) {
    descriptors.push(await inspectInterviewChannel(channel, options.registerStore, options.database));
  }
  const byCode = new Map();
  const byUser = new Map();
  let maxNumber = Number(options.database?.currentInterviewSequence?.() || 0);
  for (const item of descriptors) {
    if (item.interviewId) {
      if (!byCode.has(item.interviewId)) byCode.set(item.interviewId, []);
      byCode.get(item.interviewId).push(item);
    }
    if (item.userId && !/^closed-/i.test(item.channelName)) {
      if (!byUser.has(item.userId)) byUser.set(item.userId, []);
      byUser.get(item.userId).push(item);
    }
    maxNumber = Math.max(maxNumber, Number(item.sessionNumber || 0));
  }
  const duplicateNumbers = [...byCode.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([interviewId, rows]) => ({ interviewId, channels: rows.map(row => ({ id: row.channelId, name: row.channelName, userId: row.userId })) }));
  const duplicateActiveUsers = [...byUser.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([userId, rows]) => ({ userId, channels: rows.map(row => ({ id: row.channelId, name: row.channelName })) }));
  const orphanChannels = descriptors.filter(item => !item.userId || (!item.session && !item.linkedUserId));
  const missingChannels = options.registerStore.getEntries()
    .filter(entry => entry.interviewChannelId && !guild.channels.cache.has(entry.interviewChannelId))
    .map(entry => ({ userId: entry.userId, interviewId: entry.interviewId, channelId: entry.interviewChannelId }));
  const mappingMismatches = descriptors.filter(item => item.linkedUserId && item.userId && item.linkedUserId !== item.userId);
  const openConflicts = options.database?.listRegistrationConflicts?.({ openOnly: true, limit: 1000 }) || [];
  const issueSessions = (options.database?.listInterviewSessions?.({ limit: 10000 }) || [])
    .filter(session => ['ORPHANED', 'CONFLICT', 'PROVISION_FAILED'].includes(session.lifecycleStatus));
  let plannedMax = maxNumber;
  const plannedCodeByChannel = new Map();
  for (const rows of byCode.values()) {
    rows.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    rows.forEach((row, index) => {
      if (row.sessionNumber && index === 0) {
        plannedCodeByChannel.set(row.channelId, row.interviewId);
      } else {
        plannedMax += 1;
        plannedCodeByChannel.set(row.channelId, `interview-${String(plannedMax).padStart(4, '0')}`);
      }
    });
  }
  for (const row of descriptors) {
    if (plannedCodeByChannel.has(row.channelId)) continue;
    plannedMax += 1;
    plannedCodeByChannel.set(row.channelId, `interview-${String(plannedMax).padStart(4, '0')}`);
  }
  const canonicalByUser = new Map();
  for (const [userId, rows] of byUser) {
    const newest = [...rows].sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];
    canonicalByUser.set(userId, newest?.channelId || '');
  }
  const repairPlan = descriptors.map(item => ({
    channelId: item.channelId,
    currentName: item.channelName,
    applicantUserId: item.userId,
    proposedInterviewId: plannedCodeByChannel.get(item.channelId) || item.interviewId,
    action: !item.userId
      ? 'NEEDS_REVIEW'
      : canonicalByUser.get(item.userId) === item.channelId
        ? 'RELINK_OPEN'
        : 'RENUMBER_CLOSE_DUPLICATE',
  }));
  return {
    generatedAt: new Date().toISOString(),
    guildId: guild.id,
    maxNumber,
    stats: {
      channels: descriptors.length,
      duplicateNumberGroups: duplicateNumbers.length,
      duplicateActiveUsers: duplicateActiveUsers.length,
      orphanChannels: orphanChannels.length,
      missingChannels: missingChannels.length,
      mappingMismatches: mappingMismatches.length,
      registrationConflicts: openConflicts.length,
      issueSessions: issueSessions.length,
    },
    duplicateNumbers,
    duplicateActiveUsers,
    orphanChannels,
    missingChannels,
    mappingMismatches,
    registrationConflicts: openConflicts,
    issueSessions,
    repairPlan,
    channels: descriptors,
  };
}

function doctorSummary(report, mode = 'DRY-RUN') {
  const stats = report.stats;
  return [
    `Interview Doctor — ${mode}`,
    `Channel diperiksa: ${stats.channels}`,
    `Grup nomor ganda: ${stats.duplicateNumberGroups}`,
    `User dengan beberapa interview aktif: ${stats.duplicateActiveUsers}`,
    `Channel orphan/belum punya mapping: ${stats.orphanChannels}`,
    `Record menunjuk channel hilang: ${stats.missingChannels}`,
    `Mapping applicant berbeda: ${stats.mappingMismatches}`,
    `Konflik registrasi tersimpan: ${stats.registrationConflicts}`,
    `Session bermasalah: ${stats.issueSessions}`,
    `Sequence maksimum: ${report.maxNumber}`,
  ].join('\n');
}

async function sendDoctorReport(msg, report, mode) {
  const fileName = `interview-${String(mode).toLowerCase()}-${Date.now()}.json`;
  const attachment = new AttachmentBuilder(Buffer.from(JSON.stringify(report, null, 2), 'utf8'), { name: fileName });
  const summaryReport = report?.stats ? report : report?.after;
  const repairSummary = report?.after
    ? [
      `Renamed: ${report.renamed?.length || 0}`,
      `Duplicate ditutup: ${report.closedDuplicates?.length || 0}`,
      `Relink: ${report.relinked?.length || 0}`,
      `Reconstructed: ${report.reconstructed?.length || 0}`,
      `Unresolved: ${report.unresolved?.length || 0}`,
      `Failed: ${report.failed?.length || 0}`,
    ].join('\n')
    : '';
  await msg.reply({
    content: `${doctorSummary(summaryReport, mode)}${repairSummary ? `\n${repairSummary}` : ''}\n\nLaporan lengkap: \`${fileName}\``,
    files: [attachment],
    allowedMentions: { parse: [], repliedUser: false },
  });
}

async function applyInterviewRepair(msg, report, options) {
  const database = options.database;
  const actor = actorPayload(msg.author);
  const result = {
    startedAt: new Date().toISOString(),
    renamed: [],
    closedDuplicates: [],
    relinked: [],
    reconstructed: [],
    unresolved: [],
    failed: [],
  };
  if (database?.createBackup) {
    result.databaseBackup = await database.createBackup({ reason: 'before-interview-repair' });
  }

  let simulatedMax = Math.max(report.maxNumber, database?.currentInterviewSequence?.() || 0);
  const assigned = new Map();
  const groupedByCode = new Map();
  for (const descriptor of report.channels) {
    if (!groupedByCode.has(descriptor.interviewId || `missing:${descriptor.channelId}`)) {
      groupedByCode.set(descriptor.interviewId || `missing:${descriptor.channelId}`, []);
    }
    groupedByCode.get(descriptor.interviewId || `missing:${descriptor.channelId}`).push(descriptor);
  }
  for (const rows of groupedByCode.values()) {
    rows.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const numberConflict = row.sessionNumber
        ? database?.getInterviewSession?.(String(row.sessionNumber), { by: 'number' })
        : null;
      const mustAllocate = !row.sessionNumber || index > 0 ||
        (numberConflict && numberConflict.channelId && numberConflict.channelId !== row.channelId);
      if (mustAllocate) {
        const next = database.allocateInterviewCode({ minimum: simulatedMax });
        simulatedMax = next.sessionNumber;
        assigned.set(row.channelId, next);
      } else {
        database.setInterviewSequenceAtLeast(row.sessionNumber);
        assigned.set(row.channelId, { sessionNumber: row.sessionNumber, interviewId: row.interviewId });
      }
    }
  }

  const byUser = new Map();
  for (const descriptor of report.channels) {
    if (!descriptor.userId) continue;
    if (!byUser.has(descriptor.userId)) byUser.set(descriptor.userId, []);
    byUser.get(descriptor.userId).push(descriptor);
  }
  const canonicalByUser = new Map();
  for (const [userId, rows] of byUser) {
    const openRows = rows.filter(row => !/^closed-/i.test(row.channelName));
    const candidates = openRows.length ? openRows : rows;
    candidates.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    canonicalByUser.set(userId, candidates[0]?.channelId || '');
    for (const active of database.listInterviewSessions({ userId, lifecycle: 'OPEN', limit: 100 })) {
      database.closeInterviewSession(active, { actor, force: true, reason: 'Superseded during interview repair' });
    }
    for (const reserved of database.listInterviewSessions({ userId, lifecycle: 'RESERVED', limit: 100 })) {
      database.failInterviewSession(reserved.sessionNumber, 'Superseded during interview repair', actor);
    }
  }

  const ordered = [...report.channels].sort((a, b) => {
    const aCanonical = canonicalByUser.get(a.userId) === a.channelId ? 1 : 0;
    const bCanonical = canonicalByUser.get(b.userId) === b.channelId ? 1 : 0;
    return aCanonical - bCanonical;
  });
  for (const descriptor of ordered) {
    const channel = msg.guild.channels.cache.get(descriptor.channelId) ||
      await msg.guild.channels.fetch(descriptor.channelId).catch(() => null);
    const allocation = assigned.get(descriptor.channelId);
    if (!channel || !allocation) {
      result.unresolved.push({ channelId: descriptor.channelId, reason: !channel ? 'channel-missing' : 'allocation-missing' });
      continue;
    }
    try {
      const canonical = descriptor.userId && canonicalByUser.get(descriptor.userId) === descriptor.channelId;
      const closed = descriptor.userId ? !canonical : /^closed-/i.test(descriptor.channelName);
      const newName = `${closed ? 'closed-' : ''}${allocation.interviewId}`.slice(0, 100);
      if (channel.name !== newName) {
        await channel.setName(newName, 'Interview duplicate-number repair');
        result.renamed.push({ channelId: channel.id, from: descriptor.channelName, to: newName });
      }
      if (!descriptor.userId) {
        result.unresolved.push({ channelId: channel.id, interviewId: allocation.interviewId, reason: 'applicant-unknown' });
        continue;
      }
      const entry = options.registerStore.getUser(descriptor.userId);
      const gamertag = descriptor.gamertag || entry?.gamertag || '';
      if (!isValidGamertag(gamertag)) {
        result.unresolved.push({ channelId: channel.id, userId: descriptor.userId, reason: 'gamertag-unknown' });
        continue;
      }
      const decision = entry?.status === 'approved' ? 'APPROVED' : entry?.status === 'rejected' ? 'REJECTED' : 'PENDING';
      const session = database.upsertInterviewSessionFromRepair({
        sessionNumber: allocation.sessionNumber,
        interviewId: allocation.interviewId,
        legacyInterviewId: descriptor.interviewId,
        userId: descriptor.userId,
        username: entry?.username || '',
        gamertag,
        channelId: channel.id,
        lifecycleStatus: closed ? 'CLOSED' : 'OPEN',
        decision,
        openedAt: channel.createdAt?.toISOString?.(),
        closedAt: closed ? new Date().toISOString() : null,
      }, actor);
      if (closed) {
        await channel.permissionOverwrites.edit(descriptor.userId, { ViewChannel: false, SendMessages: false }).catch(() => null);
        await moveChannelToArchive(msg.guild, channel, 'Duplicate interview archived after repair').catch(() => null);
        result.closedDuplicates.push({ channelId: channel.id, userId: descriptor.userId, interviewId: session.interviewId });
      } else {
        let canonicalEntry = entry;
        if (!canonicalEntry) {
          const duplicate = options.registerStore.findUserByGamertag?.(gamertag, descriptor.userId);
          if (!duplicate) {
            canonicalEntry = (await options.registerStore.upsertPendingUser(descriptor.userId, gamertag, '', {
              interviewId: session.interviewId,
              interviewChannelId: channel.id,
              interviewCreatedAt: channel.createdAt?.toISOString?.(),
            }))?.entry;
            result.reconstructed.push({ userId: descriptor.userId, gamertag, channelId: channel.id });
          }
        }
        if (canonicalEntry) {
          await options.registerStore.relinkInterview(descriptor.userId, {
            interviewId: session.interviewId,
            interviewChannelId: channel.id,
            interviewCreatedAt: canonicalEntry.interviewCreatedAt || channel.createdAt?.toISOString?.(),
            interviewClosedAt: null,
          });
          await channel.send({
            content: `Session interview diperbaiki dan dihubungkan kembali ke <@${descriptor.userId}> sebagai \`${session.interviewId}\`.`,
            components: [buildInterviewButtons(descriptor.userId, false, session.sessionNumber, session.decision)],
            allowedMentions: { users: [descriptor.userId], roles: [] },
          }).catch(() => null);
          result.relinked.push({ userId: descriptor.userId, channelId: channel.id, interviewId: session.interviewId });
        } else {
          result.unresolved.push({ channelId: channel.id, userId: descriptor.userId, reason: 'gamertag-conflict' });
        }
      }
    } catch (error) {
      result.failed.push({ channelId: descriptor.channelId, error: error.message });
    }
  }
  database.setInterviewSequenceAtLeast(simulatedMax);
  result.finishedAt = new Date().toISOString();
  result.sequence = database.currentInterviewSequence();
  result.after = await buildInterviewDoctorReport(msg.guild, options);
  return result;
}

async function handleInterviewDoctorCommand(msg, options) {
  const raw = String(msg.content || '').trim();
  const doctor = /^!interview-doctor(?:\s|$)/i.test(raw);
  const repairMatch = raw.match(/^!repair-interviews(?:\s+(--dry-run|--apply))?$/i);
  if (!doctor && !repairMatch) return false;
  if (!await isInterviewAdmin(msg)) {
    await replyNoPing(msg, 'Interview Doctor khusus admin/interviewer.');
    return true;
  }
  await ensureRegisterStore(options.registerStore, msg.client);
  const apply = repairMatch?.[1]?.toLowerCase() === '--apply';
  if (apply && interviewRepairInProgress) {
    await replyNoPing(msg, 'Repair interview lain masih berjalan.');
    return true;
  }
  if (apply) {
    const dryRun = interviewDoctorDryRuns.get(msg.guild.id);
    if (!dryRun || Date.now() - dryRun.at > INTERVIEW_DRY_RUN_VALID_MS) {
      await replyNoPing(msg, 'Jalankan `!repair-interviews --dry-run` terlebih dahulu. Dry-run berlaku 30 menit sebelum `--apply`.');
      return true;
    }
  }
  const progress = await msg.reply({ content: apply ? 'Membuat backup dan memperbaiki interview...' : 'Memindai channel dan database interview...', allowedMentions: { repliedUser: false } });
  if (apply) interviewRepairInProgress = true;
  try {
    const report = await buildInterviewDoctorReport(msg.guild, options);
    if (!apply) {
      interviewDoctorDryRuns.set(msg.guild.id, { at: Date.now(), report });
      await progress.delete().catch(() => null);
      await sendDoctorReport(msg, report, 'DRY-RUN');
      return true;
    }
    const repaired = await applyInterviewRepair(msg, report, options);
    interviewDoctorDryRuns.delete(msg.guild.id);
    await progress.delete().catch(() => null);
    await sendDoctorReport(msg, repaired, 'APPLY');
    return true;
  } catch (error) {
    console.error('Interview doctor failed:', error);
    await progress.edit(`Interview Doctor gagal: ${error.message}`).catch(() => null);
    return true;
  } finally {
    if (apply) interviewRepairInProgress = false;
  }
}

async function handleInterviewStatusAdminCommand(msg, options) {
  const match = String(msg.content || '').trim().match(/^!interview-status(?:\s+<@!?(\d{5,32})>)?$/i);
  if (!match) return false;
  if (!await isInterviewAdmin(msg)) {
    await replyNoPing(msg, 'Command ini khusus admin/interviewer.');
    return true;
  }
  await ensureRegisterStore(options.registerStore, msg.client);
  const linked = options.registerStore.findUserByInterviewChannel?.(msg.channelId);
  const userId = match[1] || linked?.userId || options.database?.getInterviewSession?.(msg.channelId, { by: 'channel' })?.userId;
  if (!userId) {
    await replyNoPing(msg, 'User tidak ditemukan. Gunakan `!interview-status @user`.');
    return true;
  }
  const entry = options.registerStore.getUser(userId);
  const sessions = options.database?.listInterviewSessions?.({ userId, limit: 20 }) || [];
  await replyNoPing(msg, [
    `Interview status <@${userId}>`,
    `Registry: ${entry ? `${entry.status} | ${entry.gamertag} | ${entry.interviewId || '-'}` : 'TIDAK ADA'}`,
    `Channel registry: ${entry?.interviewChannelId ? channelMention(entry.interviewChannelId) : '-'}`,
    `Sessions: ${sessions.length}`,
    ...sessions.slice(0, 8).map(session => `- \`${session.interviewId}\` ${session.lifecycleStatus}/${session.decision} ${session.channelId ? `<#${session.channelId}>` : '-'}`),
  ].join('\n'));
  return true;
}

async function handleRelinkInterviewCommand(msg, options) {
  const match = String(msg.content || '').trim().match(/^!relink-interview\s+<@!?(\d{5,32})>(?:\s+(.+))?$/i);
  if (!match) return false;
  if (!await isInterviewAdmin(msg)) {
    await replyNoPing(msg, 'Command relink khusus admin/interviewer.');
    return true;
  }
  if (!isInterviewTicketChannel(msg.channel)) {
    await replyNoPing(msg, 'Jalankan `!relink-interview` di dalam channel interview yang ingin dihubungkan.');
    return true;
  }
  await ensureRegisterStore(options.registerStore, msg.client);
  const userId = match[1];
  let entry = options.registerStore.getUser(userId);
  const gamertag = normalizeGamertag(match[2] || entry?.gamertag || '');
  if (!entry) {
    if (!isValidGamertag(gamertag)) {
      await replyNoPing(msg, 'Record tidak ada. Format recovery: `!relink-interview @user gamertag`.');
      return true;
    }
    const duplicate = options.registerStore.findUserByGamertag?.(gamertag, userId);
    if (duplicate) {
      await replyNoPing(msg, `Gamertag konflik dengan <@${duplicate.userId}>; relink dibatalkan.`);
      return true;
    }
    entry = (await options.registerStore.upsertPendingUser(userId, gamertag, '', {}))?.entry;
  }
  const target = { userId, entry, session: options.database?.getInterviewSession?.(msg.channelId, { by: 'channel' }) || options.database?.getInterviewSession?.(userId, { by: 'user', activeOnly: true }) };
  const session = ensureCommandSession(msg, target, entry, options, true);
  await options.registerStore.relinkInterview(userId, {
    interviewId: session.interviewId,
    interviewChannelId: msg.channelId,
    interviewCreatedAt: msg.channel.createdAt?.toISOString?.(),
    interviewClosedAt: null,
  });
  await replyNoPing(msg, `Channel ini berhasil direlink ke <@${userId}> sebagai \`${session.interviewId}\` / \`${entry.gamertag}\`.`);
  return true;
}

async function handleStatusCommand(msg, options) {
  const match = String(msg.content || '').trim().match(/^!status(?:\s+<@!?(\d{5,32})>)?$/i);
  if (!match) return false;
  if (!await ensureRegisterStore(options.registerStore, msg.client)) {
    await replyNoPing(msg, 'Sistem register belum aktif. Hubungi admin.');
    return true;
  }
  const userId = match[1] || msg.author.id;
  if (userId !== msg.author.id && !await isInterviewAdmin(msg)) {
    await replyNoPing(msg, 'Status user lain hanya dapat dilihat admin/interviewer.');
    return true;
  }
  const user = userId === msg.author.id
    ? msg.author
    : (msg.client.users.cache.get(userId) || await msg.client.users.fetch(userId).catch(() => null));
  const entry = options.registerStore.getUser(userId);
  const minecraftProfile = entry?.gamertag
    ? options.bridge?.getPlayerStatusByGamertag?.(entry.gamertag) || null
    : null;
  await replyNoPing(
    msg,
    buildStatusPayload(entry ? { ...entry, userId } : null, user || { id: userId }, minecraftProfile)
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
    showLawAdmin: registerAdmin || interviewAdmin || topupAdmin || moderationAdmin || memberHasAnyRole(msg.member, LAW_ADMIN_ROLE_IDS),
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
      `Status dipulihkan dari role resmi: ${stats.fromLegacyRole || 0}`,
      `Status dipulihkan dari keputusan interview: ${stats.fromInterviewData || 0}`,
      `Nickname sync: ${stats.nicknameSynced || 0} sukses, ${stats.nicknameFailed || 0} gagal`,
    ].join('\n')
  );
  return true;
}

function queueLegalAccessJob(bridge, action, entry, userId, reviewer) {
  if (!bridge?.enqueueBridgeQuery || !entry?.gamertag) return null;
  const targetName = canonicalGamertagFromBridge(bridge, entry.gamertag);
  return bridge.enqueueBridgeQuery('legal_access', {
    action,
    targetName,
    targetKey: gamertagKey(targetName),
    discordUserId: userId,
    approvedAt: entry.approvedAt || '',
    requestedBy: reviewer?.id || '',
    requestedByTag: reviewer?.tag || reviewer?.username || '',
  });
}

async function updateInterviewMessage(interaction, payload) {
  if (interaction.deferred || interaction.replied) {
    return interaction.message?.edit(payload).catch(() => null);
  }
  return interaction.update(payload).catch(() => null);
}

async function replyInterviewInteraction(interaction, content) {
  const payload = { content, ephemeral: true };
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload).catch(() => null);
  return interaction.reply(payload).catch(() => null);
}

function gamertagFromInterviewMessage(message) {
  for (const embed of message?.embeds || []) {
    const description = String(embed?.description || embed?.data?.description || '');
    const match = description.match(/Gamertag:\s*`([^`\r\n]+)`/i);
    const gamertag = normalizeGamertag(match?.[1] || '');
    if (isValidGamertag(gamertag)) return gamertag;
  }
  return '';
}

async function resolveInterviewButtonContext(interaction, parsed, registerStore, database, bridge = null) {
  const channelId = String(interaction.channelId || interaction.channel?.id || '').trim();
  const channelSession = channelId && database?.getInterviewSession
    ? database.getInterviewSession(channelId, { by: 'channel' })
    : null;
  const numberedSession = parsed.sessionNumber && database?.getInterviewSession
    ? database.getInterviewSession(String(parsed.sessionNumber), { by: 'number' })
    : null;
  const numberedBelongsHere = numberedSession && (
    !numberedSession.channelId || String(numberedSession.channelId) === channelId
  );
  // The channel mapping is more reliable than a custom id from an old control
  // message. A numbered session from another channel must never be reused here.
  const session = channelSession || (numberedBelongsHere ? numberedSession : null);
  const linked = channelId ? registerStore.findUserByInterviewChannel?.(channelId) : null;
  const userId = String(session?.userId || linked?.userId || parsed.userId || '').trim();
  if (!userId) {
    return { error: 'Applicant tombol tidak dapat dikenali. Gunakan `!relink-interview @user [gamertag]`.' };
  }

  let entry = registerStore.getUser(userId) || null;
  const gamertag = canonicalGamertagFromBridge(bridge,
    session?.gamertag || entry?.gamertag || linked?.entry?.gamertag || gamertagFromInterviewMessage(interaction.message)
  );

  if (!entry) {
    if (!isValidGamertag(gamertag)) {
      return {
        error: `Data interview <@${userId}> tidak lengkap dan gamertag tidak dapat dipulihkan dari session/panel. Gunakan \`!accept --force @user gamertag\`.`,
      };
    }
    const duplicate = registerStore.findUserByGamertag?.(gamertag, userId);
    if (duplicate) {
      return { error: `Recovery dihentikan: gamertag \`${gamertag}\` tercatat untuk <@${duplicate.userId}>.` };
    }
    const member = interaction.guild?.members?.fetch
      ? await interaction.guild.members.fetch(userId).catch(() => null)
      : null;
    const identity = channelInterviewIdentity(interaction.channel);
    const restored = await registerStore.upsertPendingUser(
      userId,
      gamertag,
      member?.user?.tag || member?.user?.username || session?.username || '',
      {
        interviewId: session?.interviewId || identity.interviewId,
        interviewChannelId: channelId,
        interviewCreatedAt: session?.openedAt || interaction.channel?.createdAt?.toISOString?.() || new Date().toISOString(),
      }
    );
    if (!restored?.entry || restored.duplicate) {
      return { error: `Registry <@${userId}> gagal direkonstruksi dari data interview.` };
    }
    entry = restored.entry;
  } else if (channelId && session?.userId === userId && (
    entry.interviewChannelId !== channelId || entry.interviewId !== session.interviewId
  )) {
    entry = await registerStore.relinkInterview(userId, {
      interviewId: session.interviewId,
      interviewChannelId: channelId,
      interviewCreatedAt: entry.interviewCreatedAt || session.openedAt || session.reservedAt,
      interviewClosedAt: null,
    }) || entry;
  }

  // If a previous click reached the durable session decision but failed before
  // updating the JSON/role, make the next button click idempotently finish it.
  if (entry.status === 'pending' && session?.decision === 'APPROVED') {
    entry = await registerStore.approveUser(userId, {
      id: interaction.user?.id,
      tag: interaction.user?.tag || interaction.user?.username || 'button recovery',
    }) || entry;
  } else if (entry.status === 'pending' && session?.decision === 'REJECTED') {
    entry = await registerStore.rejectUser(userId, {
      id: interaction.user?.id,
      tag: interaction.user?.tag || interaction.user?.username || 'button recovery',
    }, session.decisionReason || 'Recovered from interview session') || entry;
  }

  return { userId, entry, session, channelSession, numberedSession };
}

async function approveInterview(interaction, registerStore, entryUserId, options) {
  const member = await interaction.guild.members.fetch(entryUserId).catch(() => null);
  const entry = await registerStore.approveUser(entryUserId, {
    id: interaction.user?.id,
    tag: interaction.user?.tag || interaction.user?.username || '',
  });
  if (!entry) {
    await replyInterviewInteraction(interaction, 'Data interview tidak ditemukan. Gunakan `!accept --force @user [gamertag]` untuk recovery.');
    return true;
  }
  if (member) {
    await syncGamertagNickname(member, entry.gamertag, 'approve interview');
    await moveMemberToCitizenRole(member, {
      citizenRoleId: options.roleId,
      legacyRoleId: options.legacyRoleId,
      rejectedRoleId: options.rejectedRoleId,
    }).catch(err => {
      console.error('Failed to move approved member role:', err);
      return false;
    });
  }
  const session = options.database?.getInterviewSession?.(
    String(options.sessionNumber || interaction.channelId),
    { by: options.sessionNumber ? 'number' : 'channel' }
  );
  if (session?.decision === 'PENDING') {
    options.database.decideInterviewSession(session, 'APPROVED', { actor: interaction.user, force: false });
  }
  await updateInterviewMessage(interaction, {
    embeds: [buildInterviewEmbed({ ...entry, userId: entryUserId }, { id: entryUserId })],
    components: [buildInterviewButtons(entryUserId, false, session?.sessionNumber || options.sessionNumber, 'APPROVED')],
  });
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
    await replyInterviewInteraction(interaction, 'Data interview tidak ditemukan. Gunakan `!reject --force @user [alasan]` untuk recovery.');
    return true;
  }
  if (member) {
    await moveMemberToRejectedRole(member, {
      rejectedRoleId: options.rejectedRoleId,
      pendingRoleId: options.legacyRoleId,
      verifiedRoleId: options.roleId,
    }).catch(() => false);
  }
  const session = options.database?.getInterviewSession?.(
    String(options.sessionNumber || interaction.channelId),
    { by: options.sessionNumber ? 'number' : 'channel' }
  );
  if (session?.decision === 'PENDING') {
    options.database.decideInterviewSession(session, 'REJECTED', { actor: interaction.user, force: false });
  }
  await updateInterviewMessage(interaction, {
    embeds: [buildInterviewEmbed({ ...entry, userId: entryUserId }, { id: entryUserId })],
    components: [buildInterviewButtons(entryUserId, false, session?.sessionNumber || options.sessionNumber, 'REJECTED')],
  });
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
    await replyInterviewInteraction(interaction, 'Data interview tidak ditemukan. Gunakan `!close --force @user` untuk recovery.');
    return true;
  }

  const session = options.database?.getInterviewSession?.(
    String(options.sessionNumber || interaction.channelId),
    { by: options.sessionNumber ? 'number' : 'channel' }
  );
  if (session) options.database.closeInterviewSession(session, { actor: interaction.user, force: false });
  await updateInterviewMessage(interaction, {
    embeds: [buildInterviewEmbed({ ...entry, userId: entryUserId }, { id: entryUserId })],
    components: [buildInterviewButtons(entryUserId, true, session?.sessionNumber || options.sessionNumber, session?.decision)],
  });
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
  database = null,
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
      if (interviewRepairInProgress) {
        await interaction.reply({ content: 'Tombol interview dikunci sementara karena repair sedang berjalan.', ephemeral: true }).catch(() => null);
        return true;
      }
      if (!interaction.guild || !await canUseInterviewButton(interaction, interview.userId)) {
        await interaction.reply({ content: 'Tombol interview khusus admin.', ephemeral: true }).catch(() => null);
        return true;
      }
      await interaction.deferUpdate().catch(() => null);
      await ensureRegisterStore(registerStore, interaction.client);

      const context = await resolveInterviewButtonContext(interaction, interview, registerStore, database, bridge);
      if (context.error) {
        await replyInterviewInteraction(interaction, context.error);
        return true;
      }
      const buttonSession = context.session;
      const entryUserId = context.userId;
      if (buttonSession && !['RESERVED', 'OPEN'].includes(buttonSession.lifecycleStatus)) {
        await replyInterviewInteraction(interaction, `Session \`${buttonSession.interviewId}\` sudah ${buttonSession.lifecycleStatus}; tombol lama tidak boleh dipakai.`);
        return true;
      }
      if (buttonSession && interview.action !== 'close' && buttonSession.decision !== 'PENDING') {
        const repeatedDecision =
          (interview.action === 'approve' && buttonSession.decision === 'APPROVED') ||
          (interview.action === 'reject' && buttonSession.decision === 'REJECTED');
        if (!repeatedDecision) {
          await replyInterviewInteraction(interaction, `Session ini sudah diputuskan ${buttonSession.decision}. Gunakan command \`--force\` hanya jika keputusan memang harus dikoreksi.`);
          return true;
        }
      }
      const actionLock = String(buttonSession?.sessionNumber || `${entryUserId}:${interaction.channelId}`);
      if (interviewActionLocks.has(actionLock)) {
        await replyInterviewInteraction(interaction, 'Session ini sedang diproses admin lain. Tunggu sebentar.');
        return true;
      }
      interviewActionLocks.add(actionLock);

      const options = {
        roleId,
        legacyRoleId,
        rejectedRoleId,
        bridge,
        transcriptStore,
        database,
        sessionNumber: buttonSession?.sessionNumber || 0,
      };
      try {
        if (interview.action === 'approve') return await approveInterview(interaction, registerStore, entryUserId, options);
        if (interview.action === 'reject') return await rejectInterview(interaction, registerStore, entryUserId, options);
        if (interview.action === 'close') return await closeInterview(interaction, registerStore, entryUserId, options);
        return false;
      } finally {
        interviewActionLocks.delete(actionLock);
      }
    } catch (err) {
      console.error('Register interaction handler error:', err);
      if (String(interaction?.customId || '').startsWith(`${INTERVIEW_BUTTON_PREFIX}:`)) {
        await replyInterviewInteraction(interaction, `Gagal memproses tombol interview: ${err.message || err}`);
        return true;
      }
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
  database = null,
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
        database,
      };

      if (await handleRegisterCommand(msg, options)) return true;
      if (await handleSetRegisterGamertagCommand(msg, options)) return true;
      if (await handleInterviewAdminCommand(msg, options)) return true;
      if (await handleRelinkInterviewCommand(msg, options)) return true;
      if (await handleInterviewStatusAdminCommand(msg, options)) return true;
      if (await handleInterviewDoctorCommand(msg, options)) return true;
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
