const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const {
  MINECRAFT_CHAT_LOG_CHANNEL_ID,
  MINECRAFT_REGISTER_PENDING_ROLE_ID,
  MINECRAFT_REGISTER_REJECTED_ROLE_ID,
  MINECRAFT_REGISTER_ROLE_ID,
  PRIVATE_CHAT_CHANNEL_ID,
} = require('../config');

const JOB_LEASE_MS = 2 * 60 * 1000;
const JOB_TTL_MS = 10 * 60 * 1000;
const JOB_LIMIT = 100;
const VERIFY_CODE_TTL_MS = 10 * 60 * 1000;
const ONLINE_TTL_MS = 90 * 1000;
const RUNTIME_DIR = process.env.RIZEBOT_RUNTIME_DIR ||
  path.join(__dirname, '..', '..', '.runtime');
const VERIFY_STORE_FILE = process.env.RIZEBOT_VERIFY_STORE_FILE ||
  path.join(RUNTIME_DIR, 'minecraft-verify-codes.json');
const JOB_STORE_FILE = process.env.RIZEBOT_JOB_STORE_FILE ||
  path.join(RUNTIME_DIR, 'minecraft-bridge-jobs.json');
const EMBED_COLOR_CHAT = 0x2f80ed;
const EMBED_COLOR_TRANS = 0xf2c94c;
const EMBED_COLOR_JOIN = 0x2ecc71;
const EMBED_COLOR_LEAVE = 0xe74c3c;
const EMBED_COLOR_TOPUP = 0x27ae60;
const EMBED_COLOR_INFO = 0x2f80ed;
const EMBED_COLOR_TRANSFER = 0x27ae60;
const EMBED_COLOR_BONUS = 0xf2c94c;
const PLAYER_SELECT_PREFIX = 'mcplayer';
const ORGANIZATION_SELECT_PREFIX = 'mcorg';
const ORGANIZATION_LIST_PREFIX = 'mcorglist';
const ORGANIZATION_DETAIL_PREFIX = 'mcorgdetail';
const MIGRATION_BUTTON_PREFIX = 'mcmig';
const QUERY_SELECT_COLLECTOR_MS = 2 * 60 * 1000;
const ORGANIZATION_PAGE_SIZE = 6;
const VERIFY_BYPASS_GAMERTAGS = new Set(['xylofly', 'monoguraa']);

function n(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizePositiveInt(rawValue, maxValue) {
  const text = String(rawValue ?? '').trim();
  if (!text || text.includes('-')) return null;
  const digits = text.replace(/[^\d]/g, '');
  const number = Number(digits);
  if (!Number.isFinite(number)) return null;
  const value = Math.floor(number);
  if (!Number.isSafeInteger(value) || value < 1 || value > maxValue) return null;
  return value;
}

function formatNumber(value) {
  const number = Math.max(0, Math.floor(Number(value) || 0));
  return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function rupiahText(value) {
  return `Rp${formatNumber(value)}`;
}

function createJobId() {
  return `tu_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function createVerifyCode() {
  return String(100000 + crypto.randomInt(900000));
}

function cleanText(value, maxLength = 1800) {
  return String(value || '')
    .replace(/\u00A7[0-9A-FK-OR]/gi, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function escapeDiscordMarkdown(value) {
  return String(value || '').replace(/([\\`*_~|>])/g, '\\$1');
}

function boldDiscordText(value, maxLength = 900) {
  const text = cleanText(value, maxLength);
  return text ? `**${escapeDiscordMarkdown(text)}**` : '-';
}

function cleanEmbedText(value, maxLength = 3800) {
  const text = String(value || '')
    .replace(/\u00A7[0-9A-FK-OR]/gi, '')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .split(/\r?\n/g)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
    .slice(0, maxLength);
  return text || '-';
}

function formatJakartaTime(date = new Date()) {
  try {
    return `${new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date)} WIB`;
  } catch {
    return date.toISOString();
  }
}

function compactFooter(parts = []) {
  const clean = parts
    .map(part => cleanText(part, 180))
    .filter(Boolean);
  return clean.join(' | ').slice(0, 2048) || formatJakartaTime();
}

function createLogEmbed({ color, title, description, footerParts = [], thumbnailUrl = '', authorIconUrl = '', fields = [], compact = false }) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setDescription(cleanEmbedText(description, compact ? 1000 : 3800))
    .setFooter({ text: compactFooter([formatJakartaTime(), ...footerParts]) });

  const safeTitle = cleanText(title, 256) || 'Minecraft Log';
  const safeAuthorIcon = String(authorIconUrl || '').trim();
  if (compact) {
    embed.setAuthor({
      name: safeTitle,
      iconURL: safeAuthorIcon || undefined,
    });
  } else {
    embed.setTitle(safeTitle);
  }

  const thumbnail = String(thumbnailUrl || '').trim();
  if (!compact && thumbnail) {
    embed.setThumbnail(thumbnail);
  }

  const safeFields = compact ? [] : fields
    .map(field => ({
      name: cleanText(field.name, 256),
      value: cleanEmbedText(field.value, 1024),
      inline: field.inline !== false,
    }))
    .filter(field => field.name && field.value);

  if (safeFields.length) embed.addFields(safeFields.slice(0, 25));
  return embed;
}

function isApprovedRegistrationEntry(entry) {
  return Boolean(entry && (entry.status === 'approved' || entry.legal === true));
}

function isVerifiedMinecraftLink(linked, player = {}) {
  if (!isApprovedRegistrationEntry(linked?.entry)) return false;
  if (!linked?.entry?.verified) return false;
  const playerName = n(player.name);
  const playerPersistentId = String(player.persistentId || '').trim();
  const entry = linked.entry;
  if (playerPersistentId && entry.persistentId === playerPersistentId) return true;
  return Boolean(playerName && n(entry.gamertag) === playerName);
}

function isRegisteredMinecraftLink(linked, player = {}) {
  if (!isApprovedRegistrationEntry(linked?.entry)) return false;
  const playerName = n(player.name || player.gamertag || player.key);
  return Boolean(linked?.entry?.gamertag && playerName && n(linked.entry.gamertag) === playerName);
}

function isVerifyBypassGamertag(gamertag) {
  return VERIFY_BYPASS_GAMERTAGS.has(n(gamertag));
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

function targetScore(entry, query) {
  const gamertag = n(entry.gamertag);
  const username = n(entry.username);
  const userId = String(entry.userId || '');
  if (!query) return 50;
  if (gamertag === query || username === query || userId === query) return 0;
  if (gamertag.startsWith(query) || username.startsWith(query)) return 1;
  if (gamertag.includes(query) || username.includes(query) || userId.includes(query)) return 2;
  return 99;
}

function normalizeTarget(entry) {
  return {
    userId: String(entry.userId || ''),
    gamertag: String(entry.gamertag || '').replace(/\s+/g, ' ').trim(),
    username: String(entry.username || '').replace(/\s+/g, ' ').trim(),
    verified: Boolean(entry.verified),
    persistentId: String(entry.persistentId || '').trim(),
    lastSeenAt: entry.lastSeenAt || null,
    lastSeenName: String(entry.lastSeenName || '').replace(/\s+/g, ' ').trim(),
  };
}

function normalizeWalletProfile(wallet) {
  if (!wallet || typeof wallet !== 'object') return null;
  return {
    geon: Math.max(0, Math.floor(Number(wallet.geon) || 0)),
    ether: Math.max(0, Math.floor(Number(wallet.ether) || 0)),
  };
}

function normalizeLandProfile(land) {
  if (!land || typeof land !== 'object') return null;
  return {
    ready: land.ready !== false && land.isReady !== false,
    count: Math.max(0, Math.floor(Number(land.count ?? land.landCount ?? land.owned) || 0)),
    totalArea: Math.max(0, Math.floor(Number(land.totalArea ?? land.area) || 0)),
  };
}

function normalizeRanksProfile(ranks, fallbackRank = '') {
  if (!ranks || typeof ranks !== 'object') {
    const fallback = cleanText(fallbackRank, 180);
    return fallback ? { ready: true, labels: [fallback] } : null;
  }

  const labels = Array.isArray(ranks.labels)
    ? ranks.labels.map(label => cleanText(label, 80)).filter(Boolean)
    : [];
  for (const value of [
    ranks.defaultRankLabel,
    ranks.default,
    ranks.customRankLabel,
    ranks.custom,
    ranks.organizationLabel,
    ranks.organization,
    ranks.companyDivisionName,
    ranks.companyPowerRoleLabel,
  ]) {
    const label = cleanText(value, 80);
    if (label && !labels.some(existing => n(existing) === n(label))) labels.push(label);
  }

  const fallback = cleanText(fallbackRank, 180);
  if (!labels.length && fallback) labels.push(fallback);

  return {
    ready: ranks.ready !== false && ranks.isReady !== false,
    labels,
    defaultRankLabel: cleanText(ranks.defaultRankLabel || ranks.default || '', 80),
    customRankLabel: cleanText(ranks.customRankLabel || ranks.custom || '', 80),
    organizationLabel: cleanText(ranks.organizationLabel || ranks.organization || '', 120),
  };
}

function formatTargetLine(target, index = 0) {
  const user = target.userId ? `<@${target.userId}>` : '-';
  const status = target.verified ? 'verified' : 'terdaftar';
  const online = target.online ? 'online' : 'offline';
  const geon = target.wallet ? ` | Geon=${formatNumber(target.wallet.geon)}` : '';
  return `${index + 1}. \`${target.gamertag || target.name || target.key || '-'}\` | ${user} | ${status} | ${online}${geon}`;
}

function formatServerTargetLine(target, index = 0) {
  const name = target.name || target.gamertag || target.key || '-';
  const online = target.online ? 'online' : 'offline';
  const geon = target.wallet ? ` | Geon=${formatNumber(target.wallet.geon)}` : '';
  const ether = target.wallet ? ` | Ether=${formatNumber(target.wallet.ether)}` : '';
  const pid = target.persistentId ? ` | pid=${target.persistentId.slice(0, 10)}...` : '';
  const registerStatus = target.verified
    ? '✅ verified'
    : (target.discordUserId ? ((target.registeredMatch || target.accessAllowed) ? '✅ resmi' : '🟢 terdaftar') : '❌ belum register');
  const discord = target.discordUserId ? `<@${target.discordUserId}> (${target.discordUserId})` : '-';
  return `${index + 1}. \`${name}\` | ${online} | ${registerStatus} | Discord=${discord}${geon}${ether}${pid}`;
}

function noPingPayload(payload) {
  return {
    ...payload,
    allowedMentions: payload.allowedMentions || { parse: [], repliedUser: false },
  };
}

function formatDateId(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return cleanText(value, 120) || '-';
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
  return cleanText(
    user?.tag ||
    user?.globalName ||
    user?.username ||
    fallback ||
    '-',
    80
  ) || '-';
}

function inlineCode(value, maxLength = 80) {
  const text = cleanText(value, maxLength).replace(/`/g, "'");
  return `\`${text || '-'}\``;
}

function isApprovedPlayer(legalProfile = {}, registered = null) {
  const entry = registered?.entry || registered || {};
  const status = String(entry.status || '').toLowerCase();
  return Boolean(
    legalProfile?.legal ||
    entry.legal === true ||
    status === 'approved'
  );
}

function statusLabelForPlayer(legalProfile = {}, registered = null) {
  if (isApprovedPlayer(legalProfile, registered)) return 'LEGAL';
  const entry = registered?.entry || registered || null;
  if (!entry) return 'BELUM REGISTER';
  const status = String(entry.status || '').toLowerCase();
  if (status === 'rejected') return 'GAGAL - BISA COBA LAGI';
  if (status === 'pending') return 'PENDING INTERVIEW';
  return entry.verified ? 'TERDAFTAR + VERIFIED' : 'TERDAFTAR';
}

function statusColorForPlayer(legalProfile = {}, registered = null) {
  if (isApprovedPlayer(legalProfile, registered)) return 0x2ecc71;
  const status = String((registered?.entry || registered || {}).status || '').toLowerCase();
  if (!registered || status === 'rejected') return 0xe74c3c;
  return 0xf2c94c;
}

function playerDisplayName(target = {}) {
  const source = target || {};
  return cleanText(source.name || source.gamertag || source.key || '-', 80) || '-';
}

function playerDiscordId(result = {}, registered = null) {
  return cleanText(
    result.legal?.discordUserId ||
    result.target?.discordUserId ||
    registered?.userId ||
    registered?.entry?.userId ||
    '',
    40
  );
}

function formatWalletField(wallet = null) {
  if (!wallet) return '-';
  return [
    `${formatNumber(wallet.geon)} Geon`,
    `${formatNumber(wallet.ether)} Ether`,
  ].join('\n');
}

function formatLandField(land = null) {
  if (!land) return '-';
  if (land.ready === false) return 'Data land belum siap.';
  const count = Math.max(0, Math.floor(Number(land.count ?? land.landCount ?? land.owned) || 0));
  const area = Math.max(0, Math.floor(Number(land.totalArea ?? land.area) || 0));
  return [
    `${formatNumber(count)} land`,
    area ? `Area: ${formatNumber(area)} blok` : '',
  ].filter(Boolean).join('\n') || '-';
}

function formatRankField(ranks = null, fallbackRank = '') {
  const labels = [];
  if (Array.isArray(ranks?.labels)) {
    for (const label of ranks.labels) {
      const clean = cleanText(label, 80);
      if (clean && !labels.some(existing => n(existing) === n(clean))) labels.push(clean);
    }
  }
  for (const value of [
    ranks?.defaultRankLabel,
    ranks?.customRankLabel,
    ranks?.organizationLabel,
    ranks?.companyDivisionName,
    ranks?.companyPowerRoleLabel,
    fallbackRank,
  ]) {
    const clean = cleanText(value, 80);
    if (clean && !labels.some(existing => n(existing) === n(clean))) labels.push(clean);
  }
  return labels.length ? labels.join('\n') : '-';
}

function organizationTypeLabel(organization = {}) {
  const source = organization || {};
  return source.isCompany ? 'Perusahaan' : 'Organisasi';
}

function organizationDisplayName(organization = {}) {
  const source = organization || {};
  const name = cleanText(source.name || source.id || '-', 120) || '-';
  const ticker = cleanText(source.ticker || source.company?.ticker || '', 24);
  return ticker ? `${name} (${ticker})` : name;
}

function formatOrganizationCash(organization = {}) {
  const source = organization || {};
  return [
    `${formatNumber(source.cashGeon)} Geon`,
    `${formatNumber(source.cashEther)} Ether`,
  ].join('\n');
}

function organizationMembers(organization = {}) {
  const source = organization || {};
  return Array.isArray(source.members) ? source.members : [];
}

function organizationDivisions(organization = {}) {
  const source = organization || {};
  const divisions = source.company?.divisions || source.divisions || [];
  return Array.isArray(divisions) ? divisions : [];
}

function organizationStock(organization = {}) {
  const stock = organization?.stock;
  return stock && typeof stock === 'object' ? stock : null;
}

function organizationShareholders(organization = {}) {
  const holders = organizationStock(organization)?.holders;
  return Array.isArray(holders) ? holders : [];
}

function isLegalOrganizationMember(member = {}) {
  return Boolean(member.legal);
}

function memberDisplayName(member = {}) {
  return cleanText(member.name || member.gamertag || member.key || '-', 56) || '-';
}

function memberRoleText(member = {}) {
  const labels = [];
  for (const value of [
    member.roleLabel,
    member.isFounder ? 'Founder' : '',
    member.isLeader ? 'Leader' : '',
    member.companyDivisionName,
    member.companyPowerRoleLabel,
  ]) {
    const clean = cleanText(value, 56);
    if (clean && !labels.some(existing => n(existing) === n(clean))) labels.push(clean);
  }
  return labels.join(' / ') || 'Member';
}

function formatMemberLines(members = [], limit = 10) {
  const safeMembers = members.slice(0, limit);
  const lines = safeMembers.map((member, index) => {
    const discord = member.discordUserId ? ` | <@${member.discordUserId}>` : '';
    const legal = isLegalOrganizationMember(member) ? 'LEGAL' : 'belum legal';
    return `${index + 1}. ${inlineCode(memberDisplayName(member), 56)} | ${memberRoleText(member)} | ${legal}${discord}`;
  });
  if (members.length > limit) lines.push(`+${formatNumber(members.length - limit)} anggota lain`);
  return cleanEmbedText(lines.join('\n'), 1024);
}

function formatDivisionLines(divisions = [], limit = 8) {
  const lines = divisions.slice(0, limit).map((division, index) => {
    const name = cleanText(division.name || division.id || `Divisi ${index + 1}`, 60);
    const manager = cleanText(division.managerName || division.managerKey || '', 60);
    const members = Math.max(0, Math.floor(Number(division.memberCount || division.members?.length) || 0));
    return `${index + 1}. ${inlineCode(name, 60)}${manager ? ` | Manager: ${manager}` : ''}${members ? ` | ${formatNumber(members)} anggota` : ''}`;
  });
  if (divisions.length > limit) lines.push(`+${formatNumber(divisions.length - limit)} divisi lain`);
  return cleanEmbedText(lines.join('\n'), 1024);
}

function organizationHoldingParent(organization = {}) {
  const source = organization || {};
  return source.holdingParent || source.company?.holdingParent || null;
}

function organizationHoldingChildren(organization = {}) {
  const source = organization || {};
  const children = source.holdingChildren || source.company?.holdingChildren || [];
  return Array.isArray(children) ? children : [];
}

function holdingRelationText(entry = {}) {
  const relation = cleanText(entry.relationLabel || entry.relationType || 'Affiliate', 40) || 'Affiliate';
  const ownership = Math.max(0, Math.min(100, Math.floor(Number(entry.ownershipPercent) || 0)));
  return ownership > 0 ? `${relation} (${formatNumber(ownership)}%)` : relation;
}

function holdingCompanyLine(entry = {}, index = 0) {
  const rank = Math.max(1, Math.floor(Number(index) + 1));
  const name = organizationDisplayName({ name: entry.name, ticker: entry.ticker, isCompany: true });
  return `${rank}. ${inlineCode(name, 80)} | ${holdingRelationText(entry)} | ${formatNumber(entry.memberCount)} anggota | ${formatNumber(entry.cashGeon)} Geon`;
}

function formatHoldingChildrenLines(children = [], limit = 8) {
  const lines = children.slice(0, limit).map(holdingCompanyLine);
  if (children.length > limit) lines.push(`+${formatNumber(children.length - limit)} perusahaan lain`);
  return cleanEmbedText(lines.join('\n'), 1024);
}

function formatShareholderLines(holders = [], limit = 10) {
  const lines = holders.slice(0, limit).map((holder, index) => {
    const name = cleanText(holder.name || holder.key || '-', 60) || '-';
    const percent = Math.max(0, Number(holder.percent) || 0);
    return `${index + 1}. ${inlineCode(name, 60)} | **${formatNumber(holder.shares)} saham** | ${percent.toFixed(2).replace(/\.00$/, '')}%`;
  });
  if (holders.length > limit) lines.push(`+${formatNumber(holders.length - limit)} pemegang lain`);
  return cleanEmbedText(lines.join('\n'), 1024);
}

function formatOrganizationForPlayer(organization = null) {
  if (!organization) return 'Tidak ada organisasi/perusahaan legal terdaftar.';
  const holdingParent = organizationHoldingParent(organization);
  const holdingChildren = organizationHoldingChildren(organization);
  return cleanEmbedText([
    `${organizationTypeLabel(organization)}: **${escapeDiscordMarkdown(organizationDisplayName(organization))}**`,
    `Kas: ${formatNumber(organization.cashGeon)} Geon | ${formatNumber(organization.cashEther)} Ether`,
    `Anggota: ${formatNumber(organization.legalMemberCount || 0)} legal / ${formatNumber(organization.memberCount || organizationMembers(organization).length)} total`,
    organization.founderName ? `Founder: ${organization.founderName}` : '',
    organization.leaderName ? `Leader: ${organization.leaderName}` : '',
    holdingParent ? `Holding: ${organizationDisplayName(holdingParent)} (${holdingRelationText(holdingParent)})` : '',
    holdingChildren.length ? `Anak/Afiliasi: ${formatNumber(holdingChildren.length)}` : '',
  ].filter(Boolean).join('\n'), 1024);
}

function buildPlayerCandidateEmbed(record = {}, result = {}) {
  const candidates = Array.isArray(result.candidates) ? result.candidates.slice(0, 5) : [];
  const query = cleanText(record.job?.query || result.query || '', 80) || '-';
  const lines = candidates.map((candidate, index) => {
    const name = playerDisplayName(candidate);
    const online = candidate.online ? 'Online' : 'Offline';
    const pid = candidate.persistentId ? ` | pid ${candidate.persistentId.slice(0, 10)}...` : '';
    return `${index + 1}. ${inlineCode(name, 56)} | ${online}${pid}`;
  });

  return new EmbedBuilder()
    .setColor(EMBED_COLOR_INFO)
    .setTitle('Pilih Player')
    .setDescription([
      `Ada ${formatNumber(candidates.length)} player yang mendekati ${inlineCode(query, 80)}.`,
      'Pilih salah satu tombol di bawah untuk membuka Ethergeon ID Card.',
      '',
      lines.join('\n') || 'Tidak ada kandidat.',
    ].join('\n'))
    .setFooter({ text: `Ref ${record.id || record.job?.id || '-'}` })
    .setTimestamp(new Date());
}

function organizationSummaryLine(organization = {}, index = 0) {
  const source = organization || {};
  const rank = Math.max(1, Math.floor(Number(source.rank) || (index + 1)));
  const holdingParent = organizationHoldingParent(source);
  const childrenCount = Math.max(0, Math.floor(Number(source.holdingChildrenCount || organizationHoldingChildren(source).length) || 0));
  return [
    `${rank}. **${escapeDiscordMarkdown(organizationDisplayName(source))}**`,
    organizationTypeLabel(source),
    `Kas ${formatNumber(source.cashGeon)} Geon`,
    `${formatNumber(source.memberCount)} anggota`,
    source.leaderName ? `Leader ${cleanText(source.leaderName, 60)}` : '',
    holdingParent ? `Parent ${cleanText(holdingParent.ticker || holdingParent.name || '-', 40)}` : '',
    childrenCount ? `${formatNumber(childrenCount)} anak/afiliasi` : '',
  ].filter(Boolean).join(' | ');
}

function organizationListPagination(result = {}, page = 1) {
  const entries = Array.isArray(result.entries)
    ? [...result.entries].sort((a, b) => (Number(b.cashGeon) || 0) - (Number(a.cashGeon) || 0))
    : [];
  const totalPages = Math.max(1, Math.ceil(entries.length / ORGANIZATION_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, Math.floor(Number(page) || 1)), totalPages);
  const startIndex = (safePage - 1) * ORGANIZATION_PAGE_SIZE;
  return {
    entries,
    page: safePage,
    totalPages,
    startIndex,
    items: entries.slice(startIndex, startIndex + ORGANIZATION_PAGE_SIZE),
  };
}

function buildOrganizationListEmbed(record = {}, result = {}, page = 1) {
  const pagination = organizationListPagination(result, page);
  const lines = pagination.items.map((entry, index) => organizationSummaryLine(entry, pagination.startIndex + index));
  const footer = [
    `Halaman ${pagination.page}/${pagination.totalPages}`,
    `Total ${formatNumber(result.total || pagination.entries.length)}`,
    `Data ${formatNumber(pagination.entries.length)}`,
    `Ref ${record.id || record.job?.id || '-'}`,
  ].join(' | ');

  return new EmbedBuilder()
    .setColor(EMBED_COLOR_INFO)
    .setTitle('Daftar Organisasi & Perusahaan')
    .setDescription(lines.join('\n') || 'Belum ada organisasi/perusahaan yang tercatat.')
    .setFooter({ text: footer })
    .setTimestamp(new Date());
}

function buildOrganizationListButtonId(sourceId, page) {
  return `${ORGANIZATION_LIST_PREFIX}:${sourceId}:${Math.max(1, Math.floor(Number(page) || 1))}`;
}

function parseOrganizationListButtonId(customId, sourceId) {
  const match = String(customId || '').match(new RegExp(`^${ORGANIZATION_LIST_PREFIX}:([^:]+):(\\d+)$`));
  if (!match || match[1] !== String(sourceId || '')) return null;
  const page = Math.max(1, Math.floor(Number(match[2]) || 1));
  return { page };
}

function buildOrganizationListButtons(sourceId, page, totalPages, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildOrganizationListButtonId(sourceId, 1))
      .setLabel('Pertama')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || page <= 1),
    new ButtonBuilder()
      .setCustomId(buildOrganizationListButtonId(sourceId, Math.max(1, page - 1)))
      .setLabel('Sebelumnya')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || page <= 1),
    new ButtonBuilder()
      .setCustomId(buildOrganizationListButtonId(sourceId, Math.min(totalPages, page + 1)))
      .setLabel('Berikutnya')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled || page >= totalPages),
    new ButtonBuilder()
      .setCustomId(buildOrganizationListButtonId(sourceId, totalPages))
      .setLabel('Terakhir')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || page >= totalPages)
  );
}

function buildOrganizationCandidateEmbed(record = {}, result = {}) {
  const candidates = Array.isArray(result.candidates) ? result.candidates.slice(0, 5) : [];
  const query = cleanText(record.job?.query || result.query || '', 80) || '-';
  const lines = candidates.map(organizationSummaryLine);

  return new EmbedBuilder()
    .setColor(EMBED_COLOR_INFO)
    .setTitle('Pilih Organisasi')
    .setDescription([
      `Ada ${formatNumber(candidates.length)} organisasi/perusahaan yang mendekati ${inlineCode(query, 80)}.`,
      'Pilih salah satu tombol di bawah untuk membuka detailnya.',
      '',
      lines.join('\n') || 'Tidak ada kandidat.',
    ].join('\n'))
    .setFooter({ text: `Ref ${record.id || record.job?.id || '-'}` })
    .setTimestamp(new Date());
}

function buildOrganizationDetailEmbed(organization = {}, record = {}, view = 'overview') {
  const members = organizationMembers(organization);
  const legalMembers = members.filter(isLegalOrganizationMember);
  const otherMembers = members.filter(member => !isLegalOrganizationMember(member));
  const divisions = organizationDivisions(organization);
  const holdingParent = organizationHoldingParent(organization);
  const holdingChildren = organizationHoldingChildren(organization);
  const stock = organizationStock(organization);
  const shareholders = organizationShareholders(organization);
  const title = `${organizationTypeLabel(organization)}: ${organizationDisplayName(organization)}`;
  const description = [
    `Kas: **${formatNumber(organization.cashGeon)} Geon** | ${formatNumber(organization.cashEther)} Ether`,
    `Anggota legal: **${formatNumber(organization.legalMemberCount ?? legalMembers.length)}** / ${formatNumber(organization.memberCount || members.length)} total`,
    holdingParent ? `Holding: **${escapeDiscordMarkdown(organizationDisplayName(holdingParent))}** (${holdingRelationText(holdingParent)})` : '',
    holdingChildren.length ? `Anak/Afiliasi: **${formatNumber(holdingChildren.length)}**` : '',
  ].filter(Boolean).join('\n');

  const embed = new EmbedBuilder()
    .setColor(organization.isCompany ? 0x27ae60 : EMBED_COLOR_INFO)
    .setTitle(cleanText(title, 256))
    .setDescription(description)
    .setFooter({ text: `Ref ${record.id || record.job?.id || '-'} | !organisasi ${organization.name || organization.id || ''}`.trim() })
    .setTimestamp(new Date());

  if (view === 'overview') {
    embed.addFields(
      { name: 'Tipe', value: organizationTypeLabel(organization), inline: true },
      { name: 'Kas', value: formatOrganizationCash(organization), inline: true },
      {
        name: 'Struktur',
        value: [
          `Founder: ${cleanText(organization.founderName || '-', 80) || '-'}`,
          `Leader: ${cleanText(organization.leaderName || '-', 80) || '-'}`,
          `Divisi: ${formatNumber(divisions.length)}`,
        ].join('\n'),
        inline: true,
      }
    );
    if (organization.isCompany) {
      embed.addFields({
        name: 'Status Bursa',
        value: stock?.listed
          ? [
              `Listed | penawaran #${formatNumber(stock.offeringRound || 1)}`,
              `${formatNumber(stock.publicShares)} / ${formatNumber(stock.totalShares)} saham publik`,
              `Last ${formatNumber(stock.lastPriceGeon)} Geon | market cap ${formatNumber(stock.marketCapGeon)} Geon`,
            ].join('\n')
          : 'Belum IPO/listed.',
        inline: false,
      });
    }
  } else if (view === 'members') {
    embed.addFields({
      name: `Anggota Legal (${formatNumber(legalMembers.length)})`,
      value: legalMembers.length ? formatMemberLines(legalMembers, 15) : 'Belum ada anggota legal terdaftar.',
      inline: false,
    });
    if (otherMembers.length) {
      embed.addFields({
        name: `Belum Legal / Belum Terhubung (${formatNumber(otherMembers.length)})`,
        value: formatMemberLines(otherMembers, 10),
        inline: false,
      });
    }
    if (divisions.length) {
      embed.addFields({
        name: 'Divisi Perusahaan',
        value: formatDivisionLines(divisions, 10),
        inline: false,
      });
    }
  } else if (view === 'stock') {
    if (!stock?.listed) {
      embed.addFields({ name: 'Bursa Saham', value: 'Perusahaan ini belum IPO/listed.', inline: false });
    } else {
      embed.addFields(
        {
          name: 'Ringkasan Saham',
          value: [
              `Total: **${formatNumber(stock.totalShares)} saham**`,
              `Publik: ${formatNumber(stock.publicShares)} | terjual ${formatNumber(stock.soldPublicShares)} | sisa penawaran ${formatNumber(stock.availablePublicShares)}`,
              `Penawaran #${formatNumber(stock.offeringRound || 1)}: ${formatNumber(stock.offeringPriceGeon)} Geon/saham`,
              `Sedang listing: ${formatNumber(stock.listedShares)}`,
            `Harga terakhir: **${formatNumber(stock.lastPriceGeon)} Geon/saham**`,
            `Market cap: **${formatNumber(stock.marketCapGeon)} Geon**`,
          ].join('\n'),
          inline: false,
        },
        {
          name: `Pemegang Saham Terbesar (top ${formatNumber(shareholders.length)} dari ${formatNumber(stock.holderCount || shareholders.length)})`,
          value: shareholders.length ? formatShareholderLines(shareholders, 10) : 'Belum ada saham publik yang dimiliki player.',
          inline: false,
        }
      );
    }
  } else if (view === 'holding') {
    embed.addFields({
      name: 'Holding Parent',
      value: holdingParent
        ? `${organizationDisplayName(holdingParent)}\n${holdingRelationText(holdingParent)}`
        : 'Tidak memiliki holding parent.',
      inline: false,
    });
    embed.addFields({
      name: `Anak / Afiliasi (${formatNumber(holdingChildren.length)})`,
      value: holdingChildren.length ? formatHoldingChildrenLines(holdingChildren, 10) : 'Tidak memiliki anak/afiliasi.',
      inline: false,
    });
  }

  return embed;
}

function buildOrganizationDetailButtonId(sourceId, view) {
  return `${ORGANIZATION_DETAIL_PREFIX}:${sourceId}:${view}`;
}

function parseOrganizationDetailButtonId(customId, sourceId) {
  const match = String(customId || '').match(new RegExp(`^${ORGANIZATION_DETAIL_PREFIX}:([^:]+):(overview|members|stock|holding)$`));
  if (!match || match[1] !== String(sourceId || '')) return null;
  return { view: match[2] };
}

function buildOrganizationDetailButtons(sourceId, organization = {}, activeView = 'overview', disabled = false) {
  const stock = organizationStock(organization);
  const hasHolding = Boolean(organizationHoldingParent(organization) || organizationHoldingChildren(organization).length);
  const definitions = [
    ['overview', 'Ringkasan'],
    ['members', 'Anggota'],
    ['stock', 'Saham'],
    ['holding', 'Holding'],
  ];
  return new ActionRowBuilder().addComponents(definitions.map(([view, label]) =>
    new ButtonBuilder()
      .setCustomId(buildOrganizationDetailButtonId(sourceId, view))
      .setLabel(label)
      .setStyle(activeView === view ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(disabled || (view === 'stock' && !organization.isCompany && !stock) || (view === 'holding' && !hasHolding))
  ));
}

function buildPlayerInfoEmbed({ record = {}, result = {}, registered = null, user = null }) {
  const target = result.target || {};
  const legalProfile = result.legal || {};
  const discordUserId = playerDiscordId(result, registered);
  const accessLabel = statusLabelForPlayer(legalProfile, registered);
  const username = discordDisplayName(user, registered?.entry?.username || '-');
  const targetName = playerDisplayName(target);
  const wallet = normalizeWalletProfile(result.wallet);
  const land = normalizeLandProfile(result.land);
  const ranks = normalizeRanksProfile(result.ranks, target.rank);
  const organization = result.organization || null;
  const profileLines = [
    `Discord: ${discordUserId ? `<@${discordUserId}>` : '`-`'}`,
    `Username: ${inlineCode(username, 80)}`,
    `Gamertag: ${inlineCode(targetName, 80)}`,
    `Access: **${accessLabel}**`,
  ];

  const fields = [
    { name: 'Discord', value: discordUserId ? `<@${discordUserId}>` : 'Belum terhubung', inline: true },
    { name: 'Gamertag', value: inlineCode(targetName, 80), inline: true },
    { name: 'Access', value: accessLabel, inline: true },
    {
      name: 'Server',
      value: [
        target.online ? 'Online' : 'Offline',
        `persistentId: ${inlineCode(target.persistentId || '-', 120)}`,
      ].join('\n'),
      inline: true,
    },
    { name: 'Saldo', value: formatWalletField(wallet), inline: true },
    { name: 'Land', value: formatLandField(land), inline: true },
    { name: 'Rank', value: formatRankField(ranks, target.rank), inline: false },
    {
      name: organization?.isCompany ? 'Perusahaan Legal' : 'Organisasi Legal',
      value: formatOrganizationForPlayer(organization),
      inline: false,
    },
  ];

  const orgMembers = organizationMembers(organization);
  const legalMembers = orgMembers.filter(isLegalOrganizationMember);
  if (legalMembers.length) {
    fields.push({
      name: 'Anggota Legal',
      value: formatMemberLines(legalMembers, 8),
      inline: false,
    });
  }

  if (registered?.entry?.approvedAt || legalProfile.approvedAt) {
    fields.push({
      name: 'Approved',
      value: formatDateId(legalProfile.approvedAt || registered?.entry?.approvedAt),
      inline: true,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(statusColorForPlayer(legalProfile, registered))
    .setTitle('Ethergeon ID Card')
    .setDescription(profileLines.join('\n'))
    .addFields(fields.slice(0, 25))
    .setFooter({
      text: isApprovedPlayer(legalProfile, registered)
        ? `Legal access aktif | Ref ${record.id || record.job?.id || '-'}`
        : `Data player dari bridge | Ref ${record.id || record.job?.id || '-'}`,
    })
    .setTimestamp(new Date());

  return embed;
}

function buildResultErrorEmbed(title, result = {}, record = {}) {
  return new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle(title)
    .setDescription(`Gagal: \`${cleanText(result.code || 'unknown', 80)}\`.`)
    .setFooter({ text: `Ref ${record.id || record.job?.id || '-'}` })
    .setTimestamp(new Date());
}

function buildCandidateButtonId(prefix, sourceId, index) {
  return `${prefix}:${sourceId}:${index}`;
}

function parseCandidateButtonId(customId, prefix, sourceId) {
  const raw = String(customId || '');
  const expected = `${prefix}:${sourceId}:`;
  if (!raw.startsWith(expected)) return null;
  const index = Number.parseInt(raw.slice(expected.length), 10);
  if (!Number.isFinite(index) || index < 0 || index > 4) return null;
  return { index };
}

function buildCandidateButtons(prefix, sourceId, candidates = [], labelResolver, disabled = false) {
  const row = new ActionRowBuilder();
  candidates.slice(0, 5).forEach((candidate, index) => {
    const label = cleanText(labelResolver(candidate, index), 70) || `Pilihan ${index + 1}`;
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(buildCandidateButtonId(prefix, sourceId, index))
        .setLabel(label)
        .setStyle(index === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(disabled)
    );
  });
  return row;
}

function buildMigrationButtonId(action, sourceId, index = '') {
  return `${MIGRATION_BUTTON_PREFIX}:${action}:${sourceId}${index === '' ? '' : `:${index}`}`;
}

function parseMigrationButtonId(customId, sourceId) {
  const raw = String(customId || '');
  const prefix = `${MIGRATION_BUTTON_PREFIX}:`;
  if (!raw.startsWith(prefix)) return null;
  const parts = raw.slice(prefix.length).split(':');
  const [action, id, indexRaw] = parts;
  if (id !== sourceId) return null;
  if (!['pick', 'confirm', 'cancel'].includes(action)) return null;
  const index = indexRaw === undefined ? null : Number.parseInt(indexRaw, 10);
  if (index !== null && (!Number.isFinite(index) || index < 0 || index > 4)) return null;
  return { action, index };
}

function migrationCandidateName(candidate = {}) {
  return cleanText(candidate.name || candidate.key || '-', 80) || '-';
}

function migrationCandidateKey(candidate = {}) {
  return cleanText(candidate.key || candidate.name || '', 80);
}

function migrationSourcesText(candidate = {}, maxItems = 4) {
  const sources = Array.isArray(candidate.sources) ? candidate.sources.map(item => cleanText(item, 60)).filter(Boolean) : [];
  if (!sources.length) return '-';
  return sources.length <= maxItems
    ? sources.join(', ')
    : `${sources.slice(0, maxItems).join(', ')}, +${sources.length - maxItems}`;
}

function migrationCandidateLine(candidate = {}, index = 0) {
  const name = migrationCandidateName(candidate);
  const key = migrationCandidateKey(candidate) || name;
  const score = Math.max(0, Math.floor(Number(candidate.score) || 0));
  const dataWeight = Math.max(0, Math.floor(Number(candidate.dataWeight) || 0));
  return `${index + 1}. ${inlineCode(name, 56)} | key ${inlineCode(key, 56)} | score ${score} | bobot ${dataWeight} | ${migrationSourcesText(candidate)}`;
}

function migrationCandidateLines(candidates = []) {
  const rows = Array.isArray(candidates) ? candidates.slice(0, 5) : [];
  return rows.length ? rows.map(migrationCandidateLine).join('\n') : 'Tidak ada kandidat data lama.';
}

function migrationNewCandidateLines(candidates = []) {
  const rows = Array.isArray(candidates) ? candidates.slice(0, 5) : [];
  if (!rows.length) return '';
  return rows
    .map((candidate, index) => {
      const name = cleanText(candidate.name || candidate.key || '-', 56) || '-';
      const online = candidate.online ? 'online' : 'offline';
      return `${index + 1}. ${inlineCode(name, 56)} | ${online}`;
    })
    .join('\n');
}

function migrationSectionLines(sections = []) {
  const visible = Array.isArray(sections)
    ? sections.filter(section => Number(section?.count || 0) > 0 || section?.ok === false).slice(0, 14)
    : [];
  if (!visible.length) return 'Tidak ada section yang berubah.';
  return visible
    .map(section => {
      const label = cleanText(section.label || section.id || '-', 60) || '-';
      const status = section.ok === false ? 'GAGAL' : formatNumber(section.count || 0);
      const message = section.message ? ` (${cleanText(section.message, 120)})` : '';
      return `- ${label}: ${status}${message}`;
    })
    .join('\n');
}

function buildMigrationPickComponents(sourceId, candidates = [], disabled = false) {
  const pickRow = new ActionRowBuilder();
  candidates.slice(0, 5).forEach((candidate, index) => {
    pickRow.addComponents(
      new ButtonBuilder()
        .setCustomId(buildMigrationButtonId('pick', sourceId, index))
        .setLabel(String(index + 1))
        .setStyle(index === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(disabled)
    );
  });
  const cancelRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildMigrationButtonId('cancel', sourceId))
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );
  return pickRow.components.length ? [pickRow, cancelRow] : [];
}

function buildMigrationConfirmComponents(sourceId, index = 0, disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(buildMigrationButtonId('confirm', sourceId, index))
        .setLabel('Confirm Migrasi')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(buildMigrationButtonId('cancel', sourceId))
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    ),
  ];
}

function buildMigrationPreviewEmbed(record = {}, result = {}, selectedCandidate = null) {
  const ok = result.ok !== false;
  const candidates = Array.isArray(result.candidates) ? result.candidates.slice(0, 5) : [];
  const newCandidatesText = migrationNewCandidateLines(result.newCandidates);
  const embed = new EmbedBuilder()
    .setColor(ok ? (selectedCandidate ? 0xf2c94c : EMBED_COLOR_INFO) : 0xe74c3c)
    .setTitle(selectedCandidate ? 'Konfirmasi Migrasi Player' : 'Preview Migrasi Player')
    .setDescription(
      selectedCandidate
        ? 'Cek ulang kandidat lama dan nama baru. Setelah confirm, data finance/home/land/rank/topup akan dipindahkan di BP.'
        : (ok ? 'Pilih kandidat data lama yang benar sebelum confirm.' : `Preview gagal: \`${cleanText(result.code || 'unknown', 80)}\`.`)
    )
    .addFields(
      { name: 'Query Lama', value: inlineCode(result.oldQuery || record.job?.oldQuery || '-', 80), inline: true },
      { name: 'Nama Baru', value: inlineCode(result.newName || record.job?.newName || '-', 80), inline: true },
      { name: 'Total Data Dikenal', value: formatNumber(result.totalKnown || 0), inline: true }
    )
    .setFooter({ text: `Ref ${record.id || record.job?.id || '-'}` })
    .setTimestamp(new Date());

  if (selectedCandidate) {
    embed.addFields({
      name: 'Kandidat Dipilih',
      value: migrationCandidateLine(selectedCandidate, 0),
      inline: false,
    });
  } else {
    embed.addFields({
      name: 'Kandidat Data Lama',
      value: migrationCandidateLines(candidates).slice(0, 1024),
      inline: false,
    });
  }

  if (Array.isArray(result.readyFailures) && result.readyFailures.length) {
    embed.addFields({
      name: 'Sistem Belum Ready',
      value: result.readyFailures.map(item => inlineCode(item, 40)).join(', ').slice(0, 1024),
      inline: false,
    });
  }

  if (newCandidatesText) {
    embed.addFields({
      name: 'Petunjuk Nama Baru',
      value: newCandidatesText.slice(0, 1024),
      inline: false,
    });
  }

  return embed;
}

function buildMigrationQueuedEmbed(record = {}, candidate = {}, newName = '', job = {}) {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR_INFO)
    .setTitle('Migrasi Dikirim ke BP')
    .setDescription(`${inlineCode(migrationCandidateKey(candidate) || migrationCandidateName(candidate), 80)} -> ${inlineCode(newName, 80)}`)
    .setFooter({ text: `Apply Ref ${job?.id || '-'} | Preview Ref ${record.id || record.job?.id || '-'}` })
    .setTimestamp(new Date());
}

function buildMigrationApplyEmbed(record = {}, result = {}) {
  const ok = result.ok !== false;
  const changed = Boolean(result.changed);
  const color = ok ? (changed ? 0x27ae60 : 0xf2c94c) : 0xe74c3c;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(ok ? 'Migrasi Player Selesai' : 'Migrasi Player Gagal')
    .setDescription(cleanText(result.message || result.code || 'Selesai.', 500))
    .addFields(
      { name: 'Dari', value: inlineCode(result.oldKey || record.job?.oldKey || '-', 80), inline: true },
      { name: 'Ke', value: inlineCode(result.newName || result.newKey || record.job?.newName || '-', 80), inline: true },
      { name: 'Legal Cache', value: result.legalCacheMoved ? 'Dipindahkan' : 'Tidak berubah', inline: true },
      { name: 'Detail', value: migrationSectionLines(result.sections).slice(0, 1024), inline: false }
    )
    .setFooter({ text: `Ref ${record.id || record.job?.id || '-'}` })
    .setTimestamp(new Date());

  if (Array.isArray(result.warnings) && result.warnings.length) {
    embed.addFields({
      name: 'Warning',
      value: result.warnings.map(item => inlineCode(item, 60)).join(', ').slice(0, 1024),
      inline: false,
    });
  }

  return embed;
}

function createTopupBridgeService({ registerStore, client = null }) {
  const jobs = new Map();
  const pendingVerifications = new Map();
  const onlinePlayers = new Map();
  const discordUserCache = new Map();
  let jobsLoaded = false;
  let chatChannelPromise = null;
  let privateChatChannelPromise = null;
  const bridgeStats = {
    lastJobPollAt: null,
    lastJobPollHadJobsAt: null,
    lastResultAt: null,
    lastEventAt: null,
    lastEventType: '',
    lastSnapshotAt: null,
    lastSnapshotOnline: 0,
    lastChatAt: null,
    lastTransparencyAt: null,
    lastPresenceAt: null,
    lastVerifyAt: null,
  };

  function normalizeVerificationRecord(record = {}) {
    const code = String(record.code || '').replace(/[^\d]/g, '');
    const userId = String(record.userId || '');
    const gamertag = cleanText(record.gamertag, 80);
    const expiresAt = Math.floor(Number(record.expiresAt) || 0);
    const createdAt = Math.floor(Number(record.createdAt) || Date.now());
    if (!code || !userId || !gamertag || !expiresAt) return null;
    return { code, userId, gamertag, expiresAt, createdAt };
  }

  function loadVerificationsFromDisk(now = Date.now()) {
    let raw = '';
    try {
      raw = fs.readFileSync(VERIFY_STORE_FILE, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        console.error('Failed to read Minecraft verification store:', err);
      }
      return false;
    }

    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      console.error('Failed to parse Minecraft verification store:', err);
      return false;
    }

    const records = Array.isArray(data?.records) ? data.records : [];
    let changed = false;
    for (const rawRecord of records) {
      const record = normalizeVerificationRecord(rawRecord);
      if (!record) {
        changed = true;
        continue;
      }
      if (record.expiresAt <= now) {
        changed = true;
        pendingVerifications.delete(record.code);
        continue;
      }
      const existing = pendingVerifications.get(record.code);
      pendingVerifications.set(record.code, {
        ...record,
        message: existing?.message || null,
      });
    }
    return changed;
  }

  function saveVerificationsToDisk(now = Date.now()) {
    const records = [...pendingVerifications.values()]
      .map(normalizeVerificationRecord)
      .filter(record => record && record.expiresAt > now);

    const payload = JSON.stringify({
      updatedAt: new Date(now).toISOString(),
      records,
    }, null, 2);

    try {
      fs.mkdirSync(path.dirname(VERIFY_STORE_FILE), { recursive: true });
      const tmpFile = `${VERIFY_STORE_FILE}.tmp`;
      fs.writeFileSync(tmpFile, payload);
      fs.renameSync(tmpFile, VERIFY_STORE_FILE);
    } catch (err) {
      console.error('Failed to write Minecraft verification store:', err);
    }
  }

  function normalizeJobRecord(record = {}, now = Date.now()) {
    const job = record.job && typeof record.job === 'object' ? record.job : null;
    const id = cleanText(record.id || job?.id, 100);
    const type = cleanText(job?.type, 80);
    if (!id || !job?.id || !type) return null;

    const safeStatus = ['queued', 'leased', 'done'].includes(record.status)
      ? record.status
      : 'queued';
    const updatedAt = Math.floor(Number(record.updatedAt) || now);
    if (safeStatus === 'done' && now - updatedAt > JOB_TTL_MS) return null;

    const leaseUntil = Math.floor(Number(record.leaseUntil) || 0);
    return {
      id,
      job: {
        ...job,
        id,
        type,
      },
      context: record.context || null,
      status: safeStatus === 'leased' && leaseUntil <= now ? 'queued' : safeStatus,
      attempts: Math.max(0, Math.floor(Number(record.attempts) || 0)),
      leaseUntil: safeStatus === 'leased' && leaseUntil > now ? leaseUntil : 0,
      createdAt: Math.floor(Number(record.createdAt) || updatedAt || now),
      updatedAt,
      result: record.result && typeof record.result === 'object' ? record.result : null,
    };
  }

  function loadJobsFromDisk(now = Date.now()) {
    if (jobsLoaded) return false;
    jobsLoaded = true;

    let raw = '';
    try {
      raw = fs.readFileSync(JOB_STORE_FILE, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        console.error('Failed to read Minecraft bridge job store:', err);
      }
      return false;
    }

    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      console.error('Failed to parse Minecraft bridge job store:', err);
      return false;
    }

    const records = Array.isArray(data?.records) ? data.records : [];
    let changed = false;
    for (const rawRecord of records) {
      const record = normalizeJobRecord(rawRecord, now);
      if (!record) {
        changed = true;
        continue;
      }
      if (rawRecord?.status !== record.status || rawRecord?.leaseUntil !== record.leaseUntil) {
        changed = true;
      }
      jobs.set(record.id, record);
    }
    return changed;
  }

  function saveJobsToDisk(now = Date.now()) {
    const records = [...jobs.values()]
      .map(record => normalizeJobRecord(record, now))
      .filter(Boolean)
      .map(record => ({
        id: record.id,
        job: record.job,
        status: record.status,
        attempts: record.attempts,
        leaseUntil: record.leaseUntil,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        result: record.result,
      }));

    const payload = JSON.stringify({
      updatedAt: new Date(now).toISOString(),
      records,
    }, null, 2);

    try {
      fs.mkdirSync(path.dirname(JOB_STORE_FILE), { recursive: true });
      const tmpFile = `${JOB_STORE_FILE}.tmp`;
      fs.writeFileSync(tmpFile, payload);
      fs.renameSync(tmpFile, JOB_STORE_FILE);
    } catch (err) {
      console.error('Failed to write Minecraft bridge job store:', err);
    }
  }

  function pruneJobs(now = Date.now()) {
    const diskChanged = loadJobsFromDisk(now);
    let changed = diskChanged;
    for (const [jobId, record] of jobs.entries()) {
      if (record.status === 'done' && now - record.updatedAt > JOB_TTL_MS) {
        jobs.delete(jobId);
        changed = true;
      }
    }

    while (jobs.size > JOB_LIMIT) {
      const first = jobs.keys().next().value;
      if (!first) break;
      jobs.delete(first);
      changed = true;
    }

    if (changed) saveJobsToDisk(now);
  }

  function pruneVerifications(now = Date.now()) {
    const diskChanged = loadVerificationsFromDisk(now);
    let changed = diskChanged;
    for (const [code, record] of pendingVerifications.entries()) {
      if (record.expiresAt <= now) {
        pendingVerifications.delete(code);
        changed = true;
      }
    }
    if (changed) saveVerificationsToDisk(now);
  }

  function onlineKey(player) {
    return String(player?.persistentId || player?.key || player?.name || '').trim().toLowerCase();
  }

  function normalizeOnlinePlayer(player = {}, now = Date.now()) {
    const fallbackRank = cleanText(player.rank || '', 180);
    return {
      name: cleanText(player.name, 80),
      key: cleanText(player.key || player.name, 80).toLowerCase(),
      persistentId: cleanText(player.persistentId, 160),
      rank: fallbackRank,
      online: player.online !== false,
      wallet: normalizeWalletProfile(player.wallet),
      land: normalizeLandProfile(player.land),
      ranks: normalizeRanksProfile(player.ranks, fallbackRank),
      updatedAt: now,
    };
  }

  function findLinkedUserForPlayer(player = {}) {
    const persistentId = cleanText(player.persistentId, 160);
    const byPersistentId = persistentId
      ? registerStore.findUserByPersistentId?.(persistentId)
      : null;
    if (byPersistentId) return byPersistentId;

    const names = [player.name, player.gamertag, player.key]
      .map(value => cleanText(value, 80))
      .filter(Boolean);
    for (const name of names) {
      const linked = registerStore.findUserByGamertag?.(name);
      if (linked) return linked;
    }
    return null;
  }

  function attachRegistrationToOnlinePlayer(player = {}) {
    const linked = findLinkedUserForPlayer(player);
    const verified = isVerifiedMinecraftLink(linked, player);
    const registeredMatch = isRegisteredMinecraftLink(linked, player);
    return {
      ...player,
      registered: Boolean(linked),
      verified,
      registeredMatch,
      accessAllowed: verified || registeredMatch || Boolean(player.verifyBypass),
      discordUserId: linked?.userId || '',
      discordUsername: linked?.entry?.username || '',
      registeredGamertag: linked?.entry?.gamertag || '',
      registeredPersistentId: linked?.entry?.persistentId || '',
    };
  }

  async function resolveDiscordUser(userIdRaw) {
    const userId = String(userIdRaw || '').trim();
    if (!userId || !client?.users) return null;

    const now = Date.now();
    const cached = discordUserCache.get(userId);
    if (cached && cached.expiresAt > now) return cached.user;

    const user = client.users.cache.get(userId) ||
      await client.users.fetch(userId).catch(() => null);
    if (user) {
      discordUserCache.set(userId, {
        user,
        expiresAt: now + (10 * 60 * 1000),
      });
    }
    return user;
  }

  function discordAvatarUrl(user) {
    try {
      return user?.displayAvatarURL?.({ size: 64 }) || '';
    } catch {
      return '';
    }
  }

  async function syncOfficialMinecraftRole(userIdRaw) {
    const userId = String(userIdRaw || '').trim();
    if (!userId || !client?.guilds?.cache) return false;

    for (const guild of client.guilds.cache.values()) {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) continue;

      const added = await addRoleIfMissing(member, MINECRAFT_REGISTER_ROLE_ID);
      const removedPending = MINECRAFT_REGISTER_PENDING_ROLE_ID === MINECRAFT_REGISTER_ROLE_ID
        ? true
        : await removeRoleIfPresent(member, MINECRAFT_REGISTER_PENDING_ROLE_ID);
      const removedRejected = MINECRAFT_REGISTER_REJECTED_ROLE_ID === MINECRAFT_REGISTER_ROLE_ID ||
        MINECRAFT_REGISTER_REJECTED_ROLE_ID === MINECRAFT_REGISTER_PENDING_ROLE_ID
        ? true
        : await removeRoleIfPresent(member, MINECRAFT_REGISTER_REJECTED_ROLE_ID);
      return added && removedPending && removedRejected;
    }

    return false;
  }

  async function deleteLoadingMessage(record = {}) {
    const ref = record.context?.loadingMessage || record.job?.loadingMessage || null;
    const channelId = cleanText(ref?.channelId, 40);
    const messageId = cleanText(ref?.messageId, 40);
    if (!client || !channelId || !messageId) return false;

    const channel = client.channels.cache.get(channelId) ||
      await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.messages?.fetch) return false;

    const message = channel.messages.cache.get(messageId) ||
      await channel.messages.fetch(messageId).catch(() => null);
    if (!message?.delete) return false;
    await message.delete().catch(() => null);
    return true;
  }

  function rememberOnlinePlayer(player = {}) {
    const normalized = normalizeOnlinePlayer(player);
    const key = onlineKey(normalized);
    if (!key) return null;
    onlinePlayers.set(key, normalized);
    return normalized;
  }

  function forgetOnlinePlayer(player = {}) {
    const key = onlineKey(player);
    if (!key) return;
    const current = onlinePlayers.get(key);
    if (current) {
      onlinePlayers.set(key, {
        ...current,
        online: false,
        updatedAt: Date.now(),
      });
    }
  }

  function applyOnlineSnapshot(players = []) {
    const seen = new Set();
    for (const player of players) {
      const normalized = rememberOnlinePlayer(player);
      const key = onlineKey(normalized);
      if (key) seen.add(key);
    }

    for (const [key, value] of onlinePlayers.entries()) {
      if (!seen.has(key)) {
        onlinePlayers.set(key, {
          ...value,
          online: false,
          updatedAt: Date.now(),
        });
      }
    }
  }

  function getOnlinePlayers() {
    const now = Date.now();
    return [...onlinePlayers.values()]
      .filter(player => player.online && now - player.updatedAt <= ONLINE_TTL_MS)
      .map(attachRegistrationToOnlinePlayer)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function getPlayerStatusByGamertag(rawGamertag) {
    const query = n(rawGamertag);
    if (!query) return null;

    const now = Date.now();
    const candidates = [...onlinePlayers.values()]
      .filter(player => {
        const names = [player.name, player.key, player.registeredGamertag]
          .map(value => n(value))
          .filter(Boolean);
        return names.includes(query);
      })
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));

    const latest = candidates[0];
    if (!latest) return null;
    const online = Boolean(latest.online) && now - Number(latest.updatedAt || 0) <= ONLINE_TTL_MS;
    return attachRegistrationToOnlinePlayer({
      ...latest,
      online,
    });
  }

  function searchTargets(rawQuery, limit = 10) {
    const query = n(rawQuery);
    if (query.length < 2) return [];

    return registerStore.getEntries()
      .map(entry => ({
        ...normalizeTarget(entry),
        score: targetScore(entry, query)
      }))
      .filter(entry => entry.score < 99)
      .sort((a, b) => a.score - b.score || a.gamertag.localeCompare(b.gamertag))
      .slice(0, limit)
      .map(({ score, ...entry }) => entry);
  }

  function resolveTarget(rawQuery) {
    const query = n(rawQuery);
    if (!query) {
      return { ok: false, code: 'target-empty', candidates: [] };
    }

    const candidates = searchTargets(rawQuery, 15);
    const exact = candidates.filter(entry => n(entry.gamertag) === query || String(entry.userId) === query);
    if (exact.length === 1) return { ok: true, target: exact[0], candidates };
    if (exact.length > 1) return { ok: false, code: 'target-ambiguous', candidates: exact };
    if (candidates.length === 1) return { ok: true, target: candidates[0], candidates };
    if (candidates.length > 1) return { ok: false, code: 'target-ambiguous', candidates };
    return { ok: false, code: 'target-not-found', candidates: [] };
  }

  function enqueueJob(type, payload, context) {
    pruneJobs();
    const id = createJobId();
    const now = Date.now();
    const job = {
      id,
      type,
      ...payload,
      createdAt: new Date(now).toISOString(),
    };

    jobs.set(id, {
      id,
      job,
      context,
      status: 'queued',
      attempts: 0,
      leaseUntil: 0,
      createdAt: now,
      updatedAt: now,
    });
    saveJobsToDisk(now);
    return job;
  }

  function enqueueTopup({ target, geon, rupiah, requestedBy, message, loadingMessage = null, source = '', paymentId = '' }) {
    return enqueueJob('topup', {
      targetKey: target.gamertag,
      targetName: target.gamertag,
      discordUserId: target.userId,
      geon,
      rupiah,
      requestedBy,
      source,
      paymentId,
    }, { message, target, loadingMessage });
  }

  function enqueueCoupon({ geon, rupiah, count, days, requestedBy, message, loadingMessage = null }) {
    return enqueueJob('coupon', {
      geon,
      rupiah,
      count,
      days,
      requestedBy,
    }, { message, loadingMessage });
  }

  function enqueueBridgeQuery(type, payload, context) {
    return enqueueJob(type, payload, context);
  }

  function createVerification({ userId, gamertag, message }) {
    const now = Date.now();
    pruneVerifications(now);
    const safeUserId = String(userId || '');
    const safeGamertag = cleanText(gamertag, 80);
    if (!safeUserId || !safeGamertag) return null;

    let existingActive = null;
    for (const [code, record] of pendingVerifications.entries()) {
      if (record.userId !== safeUserId) continue;
      if (n(record.gamertag) === n(safeGamertag) && record.expiresAt > now) {
        existingActive = { ...record, code };
        pendingVerifications.set(code, {
          ...record,
          message: message || record.message || null,
        });
        continue;
      }
      pendingVerifications.delete(code);
    }

    if (existingActive) {
      saveVerificationsToDisk(now);
      return {
        code: existingActive.code,
        gamertag: safeGamertag,
        expiresAt: existingActive.expiresAt,
        expiresInMinutes: Math.max(1, Math.ceil((existingActive.expiresAt - now) / 60_000)),
        reused: true,
      };
    }

    let code = createVerifyCode();
    while (pendingVerifications.has(code)) code = createVerifyCode();
    const expiresAt = now + VERIFY_CODE_TTL_MS;
    pendingVerifications.set(code, {
      code,
      userId: safeUserId,
      gamertag: safeGamertag,
      message,
      expiresAt,
      createdAt: now,
    });
    saveVerificationsToDisk(now);
    return {
      code,
      gamertag: safeGamertag,
      expiresAt,
      expiresInMinutes: Math.floor(VERIFY_CODE_TTL_MS / 60_000),
      reused: false,
    };
  }

  function takeJobs(limitRaw = 3) {
    pruneJobs();
    bridgeStats.lastJobPollAt = new Date().toISOString();
    const limit = Math.min(Math.max(1, Math.floor(Number(limitRaw) || 3)), 10);
    const now = Date.now();
    const result = [];

    for (const record of jobs.values()) {
      if (result.length >= limit) break;
      if (record.status !== 'queued' && record.status !== 'leased') continue;
      if (record.leaseUntil > now) continue;

      record.status = 'leased';
      record.leaseUntil = now + JOB_LEASE_MS;
      record.attempts += 1;
      record.updatedAt = now;
      result.push(record.job);
    }

    if (result.length > 0) {
      bridgeStats.lastJobPollHadJobsAt = new Date().toISOString();
      saveJobsToDisk(now);
    }
    return result;
  }

  async function sendCouponResult(record, result) {
    const message = record.context?.message;
    const requester = message?.author || await resolveDiscordUser(record.job?.requestedBy);
    if (!message && !requester) return;

    if (!result.ok) {
      const failText = `Generate kupon gagal: \`${result.code || 'unknown'}\``;
      if (message) await message.reply(failText).catch(() => {});
      else await requester.send(failText).catch(() => {});
      return;
    }

    const coupons = Array.isArray(result.coupons) ? result.coupons : [];
    const couponText = coupons.length ? coupons.map((code, idx) => `${idx + 1}. ${code}`).join('\n') : '-';
    const dmText = [
      `Kupon TOPUP berhasil dibuat.`,
      `Geon: ${formatNumber(result.geon)} | Harga: ${rupiahText(result.rupiah)} | Jumlah: ${coupons.length}`,
      '',
      couponText,
    ].join('\n');

    const dm = await requester?.send(`\`\`\`\n${dmText}\n\`\`\``).catch(() => null);
    if (dm) {
      if (message) {
        await message.reply(`Kupon berhasil dibuat dan sudah dikirim lewat DM. Jumlah: ${coupons.length}`).catch(() => {});
      }
    } else if (message) {
      await message.reply(`Kupon berhasil dibuat:\n\`\`\`\n${dmText}\n\`\`\``).catch(() => {});
    }
  }

  async function sendTopupResult(record, result) {
    const message = record.context?.message;
    const requester = message?.author || await resolveDiscordUser(record.job?.requestedBy);
    const canNotifyRequester = Boolean(message || requester);

    const targetName = result.targetName || record.context?.target?.gamertag || record.job?.targetName || '-';
    const geon = result.geon || record.job?.geon || 0;
    const rupiah = result.rupiah || record.job?.rupiah || 0;
    const text = result.ok
      ? (
        result.status === 'pending'
          ? `TOPUP pending: \`${targetName}\` akan menerima **${formatNumber(geon)} Geon** (${rupiahText(rupiah)}) saat join.`
          : `TOPUP sukses: \`${targetName}\` menerima **${formatNumber(geon)} Geon** (${rupiahText(rupiah)}).`
      )
      : `TOPUP gagal untuk \`${targetName}\`: \`${result.code || 'unknown'}\`.`;
    if (result.ok) {
      await sendTopupSuccessEmbed(record, result).catch(err => {
        console.error('Failed to send topup success embed:', err);
      });
      if (!canNotifyRequester) return;
      if (message) await message.reply(text).catch(() => {});
      else await requester.send(text).catch(() => {});
    } else {
      if (!canNotifyRequester) return;
      if (message) await message.reply(text).catch(() => {});
      else await requester.send(text).catch(() => {});
    }
  }

  async function resolvePrivateChatChannel() {
    if (!client || !PRIVATE_CHAT_CHANNEL_ID) return null;
    if (!privateChatChannelPromise) {
      privateChatChannelPromise = client.channels.fetch(PRIVATE_CHAT_CHANNEL_ID).catch(err => {
        privateChatChannelPromise = null;
        console.error('Failed to fetch private chat topup channel:', err);
        return null;
      });
    }
    return privateChatChannelPromise;
  }

  async function sendTopupSuccessEmbed(record, result) {
    if (!result?.ok || result.status === 'pending') return false;

    const channel = await resolvePrivateChatChannel();
    if (!channel?.send) return false;

    const targetName = cleanText(
      result.targetName || record.context?.target?.gamertag || record.job?.targetName || '-',
      80
    );
    const geon = result.geon || record.job?.geon || 0;
    const rupiah = result.rupiah || record.job?.rupiah || 0;
    const linked = record.job?.discordUserId
      ? { userId: record.job.discordUserId, entry: record.context?.target || {} }
      : registerStore.findUserByGamertag?.(targetName);
    const user = await resolveDiscordUser(linked?.userId);
    const source = cleanText(record.job?.source || 'manual', 80);
    const paymentId = cleanText(record.job?.paymentId || '', 120);

    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR_TOPUP)
      .setTitle('Topup Berhasil')
      .setDescription(`\`${targetName}\` berhasil menerima **${formatNumber(geon)} Geon**.`)
      .addFields(
        { name: 'Gamertag', value: `\`${targetName}\``, inline: true },
        { name: 'Geon', value: `${formatNumber(geon)} Geon`, inline: true },
        { name: 'Nominal', value: rupiahText(rupiah), inline: true },
        {
          name: 'Discord',
          value: linked?.userId ? `<@${linked.userId}>` : 'Belum terhubung',
          inline: true,
        },
        { name: 'Sumber', value: source || 'manual', inline: true }
      )
      .setFooter({ text: paymentId ? `Payment ${paymentId}` : `Ref ${record.job?.id || record.id || '-'}` })
      .setTimestamp();

    const avatarUrl = discordAvatarUrl(user);
    if (avatarUrl) embed.setThumbnail(avatarUrl);

    await channel.send({
      embeds: [embed],
      allowedMentions: { parse: [] },
    });
    return true;
  }

  function findRegisteredForPlayerInfo(result = {}) {
    const target = result.target || {};
    const persistentId = cleanText(target.persistentId, 160);
    if (persistentId) {
      const linked = registerStore.findUserByPersistentId?.(persistentId);
      if (linked) return linked;
    }

    const names = [target.name, target.gamertag, target.key]
      .map(value => cleanText(value, 80))
      .filter(Boolean);
    for (const name of names) {
      const linked = registerStore.findUserByGamertag?.(name);
      if (linked) return linked;
    }

    const discordUserId = cleanText(result.legal?.discordUserId || target.discordUserId || '', 40);
    if (!discordUserId) return null;
    const entry = registerStore.getUser?.(discordUserId);
    if (entry) return { userId: discordUserId, entry };
    return {
      userId: discordUserId,
      entry: {
        userId: discordUserId,
        gamertag: playerDisplayName(target),
        status: result.legal?.legal ? 'approved' : 'pending',
        approvedAt: result.legal?.approvedAt || null,
      },
    };
  }

  function candidateLabels(kind) {
    if (kind === 'organization') {
      return candidate => organizationDisplayName(candidate);
    }
    return candidate => playerDisplayName(candidate);
  }

  function candidatePrefix(kind) {
    return kind === 'organization' ? ORGANIZATION_SELECT_PREFIX : PLAYER_SELECT_PREFIX;
  }

  function buildCandidateRow(record, candidates, kind, disabled = false) {
    return buildCandidateButtons(
      candidatePrefix(kind),
      record.id || record.job?.id || '',
      candidates,
      candidateLabels(kind),
      disabled
    );
  }

  function candidateQuery(kind, candidate = {}) {
    const source = candidate || {};
    if (kind === 'organization') {
      return cleanText(source.id || source.name || source.ticker || '', 120);
    }
    return cleanText(source.key || source.name || source.gamertag || '', 120);
  }

  function candidateJobType(kind) {
    return kind === 'organization' ? 'organization_info' : 'player_info';
  }

  function attachCandidateCollector(reply, record, candidates, kind) {
    const sourceId = record.id || record.job?.id || '';
    if (!reply?.createMessageComponentCollector || !sourceId || !candidates.length) return;

    const prefix = candidatePrefix(kind);
    let picked = false;
    const collector = reply.createMessageComponentCollector({
      time: QUERY_SELECT_COLLECTOR_MS,
      filter: interaction => Boolean(parseCandidateButtonId(interaction.customId, prefix, sourceId)),
    });

    collector.on('collect', async interaction => {
      const parsed = parseCandidateButtonId(interaction.customId, prefix, sourceId);
      if (!parsed) return;

      const requesterId = String(record.context?.message?.author?.id || record.job?.requestedBy || '');
      if (requesterId && String(interaction.user?.id || '') !== requesterId) {
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle('Pilihan Terkunci')
              .setDescription('Tombol ini hanya untuk user yang menjalankan command.'),
          ],
          ephemeral: true,
          allowedMentions: { parse: [], repliedUser: false },
        }).catch(() => {});
        return;
      }

      const candidate = candidates[parsed.index];
      const query = candidateQuery(kind, candidate);
      if (!candidate || !query) {
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle('Pilihan Tidak Valid')
              .setDescription('Kandidat ini tidak punya identitas yang bisa dicari.'),
          ],
          ephemeral: true,
          allowedMentions: { parse: [], repliedUser: false },
        }).catch(() => {});
        return;
      }

      picked = true;
      collector.stop('picked');
      const job = enqueueBridgeQuery(candidateJobType(kind), {
        query,
        requestedBy: interaction.user?.id || record.job?.requestedBy || '',
      }, { message: record.context?.message });

      await interaction.update({
        components: [buildCandidateRow(record, candidates, kind, true)],
      }).catch(() => {});
      await interaction.followUp({
        embeds: [
          new EmbedBuilder()
            .setColor(EMBED_COLOR_INFO)
            .setTitle('Pilihan Diproses')
            .setDescription(`Mengambil detail ${inlineCode(candidateLabels(kind)(candidate), 80)}.\nRef: \`${job.id}\``)
            .setTimestamp(new Date()),
        ],
        ephemeral: true,
        allowedMentions: { parse: [], repliedUser: false },
      }).catch(() => {});
    });

    collector.on('end', async () => {
      if (picked) return;
      await reply.edit({
        components: [buildCandidateRow(record, candidates, kind, true)],
      }).catch(() => {});
    });
  }

  async function rejectLockedOrganizationButton(interaction) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xe74c3c)
          .setTitle('Tombol Terkunci')
          .setDescription('Tombol ini hanya untuk user yang menjalankan command.'),
      ],
      ephemeral: true,
      allowedMentions: { parse: [], repliedUser: false },
    }).catch(() => {});
  }

  function isOrganizationButtonRequester(interaction, record) {
    const requesterId = String(record.context?.message?.author?.id || record.job?.requestedBy || '');
    return !requesterId || String(interaction.user?.id || '') === requesterId;
  }

  function attachOrganizationListCollector(reply, record, result) {
    const sourceId = record.id || record.job?.id || '';
    const initial = organizationListPagination(result, 1);
    if (!reply?.createMessageComponentCollector || !sourceId || initial.totalPages <= 1) return;

    let currentPage = 1;
    const collector = reply.createMessageComponentCollector({
      time: QUERY_SELECT_COLLECTOR_MS,
      filter: interaction => Boolean(parseOrganizationListButtonId(interaction.customId, sourceId)),
    });
    collector.on('collect', async interaction => {
      const parsed = parseOrganizationListButtonId(interaction.customId, sourceId);
      if (!parsed) return;
      if (!isOrganizationButtonRequester(interaction, record)) {
        await rejectLockedOrganizationButton(interaction);
        return;
      }
      const pagination = organizationListPagination(result, parsed.page);
      currentPage = pagination.page;
      await interaction.update({
        embeds: [buildOrganizationListEmbed(record, result, currentPage)],
        components: [buildOrganizationListButtons(sourceId, currentPage, pagination.totalPages)],
        allowedMentions: { parse: [], repliedUser: false },
      }).catch(() => {});
    });
    collector.on('end', async () => {
      await reply.edit({
        components: [buildOrganizationListButtons(sourceId, currentPage, initial.totalPages, true)],
      }).catch(() => {});
    });
  }

  function attachOrganizationDetailCollector(reply, record, organization) {
    const sourceId = record.id || record.job?.id || '';
    if (!reply?.createMessageComponentCollector || !sourceId) return;

    let currentView = 'overview';
    const collector = reply.createMessageComponentCollector({
      time: QUERY_SELECT_COLLECTOR_MS,
      filter: interaction => Boolean(parseOrganizationDetailButtonId(interaction.customId, sourceId)),
    });
    collector.on('collect', async interaction => {
      const parsed = parseOrganizationDetailButtonId(interaction.customId, sourceId);
      if (!parsed) return;
      if (!isOrganizationButtonRequester(interaction, record)) {
        await rejectLockedOrganizationButton(interaction);
        return;
      }
      currentView = parsed.view;
      await interaction.update({
        embeds: [buildOrganizationDetailEmbed(organization, record, currentView)],
        components: [buildOrganizationDetailButtons(sourceId, organization, currentView)],
        allowedMentions: { parse: [], repliedUser: false },
      }).catch(() => {});
    });
    collector.on('end', async () => {
      await reply.edit({
        components: [buildOrganizationDetailButtons(sourceId, organization, currentView, true)],
      }).catch(() => {});
    });
  }

  async function sendWalletResult(record, result) {
    const message = record.context?.message;
    if (!message) return;

    if (!result.ok) {
      await message.reply(`Cek saldo gagal: \`${result.code || 'unknown'}\`.`).catch(() => {});
      return;
    }

    const target = result.target || {};
    const wallet = result.wallet || {};
    const registered = target.persistentId
      ? registerStore.findUserByPersistentId?.(target.persistentId)
      : registerStore.findUserByGamertag?.(target.name || target.key);
    const linked = registered
      ? ` | Discord: <@${registered.userId}> | ${registered.entry?.verified ? 'verified' : 'terdaftar'}`
      : '';

    await message.reply(
      `Saldo \`${target.name || target.key || '-'}\`: **${formatNumber(wallet.geon)} Geon** | ${formatNumber(wallet.ether)} Ether${linked}`
    ).catch(() => {});
  }

  async function sendSearchServerResult(record, result) {
    const message = record.context?.message;
    if (!message) return;

    if (!result.ok) {
      await message.reply(`Search server gagal: \`${result.code || 'unknown'}\`.`).catch(() => {});
      return;
    }

    const targets = Array.isArray(result.targets)
      ? result.targets.slice(0, 15).map(attachRegistrationToOnlinePlayer)
      : [];
    const lines = targets.length
      ? targets.map(formatServerTargetLine).join('\n')
      : 'Tidak ada hasil dari data server.';
    await message.reply({
      content: `Hasil server untuk \`${record.job.query || '-'}\`:\n${lines}`,
      allowedMentions: { parse: [], repliedUser: false },
    }).catch(() => {});
  }

  async function sendPlayerInfoResult(record, result) {
    const message = record.context?.message;
    if (!message) return;

    if (!result.ok) {
      const candidates = Array.isArray(result.candidates) ? result.candidates.slice(0, 5) : [];
      if (candidates.length && result.code === 'target-ambiguous') {
        const reply = await message.reply(noPingPayload({
          embeds: [buildPlayerCandidateEmbed(record, result)],
          components: [buildCandidateRow(record, candidates, 'player')],
        })).catch(() => null);
        attachCandidateCollector(reply, record, candidates, 'player');
        return;
      }

      await message.reply(noPingPayload({
        embeds: [buildResultErrorEmbed('Data Player', result, record)],
      })).catch(() => {});
      return;
    }

    const registered = findRegisteredForPlayerInfo(result);
    const user = await resolveDiscordUser(playerDiscordId(result, registered));
    const embed = buildPlayerInfoEmbed({ record, result, registered, user });
    const avatarUrl = discordAvatarUrl(user);
    if (avatarUrl) embed.setThumbnail(avatarUrl);

    await message.reply(noPingPayload({ embeds: [embed] })).catch(() => {});
  }

  async function sendOrganizationSearchResult(record, result) {
    const message = record.context?.message;
    if (!message) return;

    if (!result.ok) {
      await message.reply(noPingPayload({
        embeds: [buildResultErrorEmbed('Daftar Organisasi', result, record)],
      })).catch(() => {});
      return;
    }

    const sourceId = record.id || record.job?.id || '';
    const pagination = organizationListPagination(result, 1);
    const components = pagination.totalPages > 1
      ? [buildOrganizationListButtons(sourceId, pagination.page, pagination.totalPages)]
      : [];
    const reply = await message.reply(noPingPayload({
      embeds: [buildOrganizationListEmbed(record, result, pagination.page)],
      components,
    })).catch(() => null);
    attachOrganizationListCollector(reply, record, result);
  }

  async function sendOrganizationInfoResult(record, result) {
    const message = record.context?.message;
    if (!message) return;

    if (!result.ok) {
      const candidates = Array.isArray(result.candidates) ? result.candidates.slice(0, 5) : [];
      if (candidates.length && result.code === 'organization-ambiguous') {
        const reply = await message.reply(noPingPayload({
          embeds: [buildOrganizationCandidateEmbed(record, result)],
          components: [buildCandidateRow(record, candidates, 'organization')],
        })).catch(() => null);
        attachCandidateCollector(reply, record, candidates, 'organization');
        return;
      }

      await message.reply(noPingPayload({
        embeds: [buildResultErrorEmbed('Detail Organisasi', result, record)],
      })).catch(() => {});
      return;
    }

    const organization = result.organization || {};
    const sourceId = record.id || record.job?.id || '';
    const reply = await message.reply(noPingPayload({
      embeds: [buildOrganizationDetailEmbed(organization, record, 'overview')],
      components: [buildOrganizationDetailButtons(sourceId, organization, 'overview')],
    })).catch(() => null);
    attachOrganizationDetailCollector(reply, record, organization);
  }

  async function sendPingResult(record, result) {
    const message = record.context?.message;
    if (!message) return;

    if (!result.ok) {
      await message.reply(`Ping BP gagal: \`${result.code || 'unknown'}\`.`).catch(() => {});
      return;
    }

    await message.reply([
      'Ping BP sukses.',
      `Online di BP: ${formatNumber(result.onlineCount)}`,
      `Finance ready: ${result.financeReady ? 'ya' : 'tidak'}`,
      `Server time: ${result.serverTime || '-'}`,
    ].join('\n')).catch(() => {});
  }

  async function sendDiscordBroadcastResult(record, result) {
    const message = record.context?.message;
    if (!message) return;

    if (!result.ok) {
      await message.reply({
        content: `Pesan Discord gagal dikirim ke Minecraft: \`${result.code || 'unknown'}\`.`,
        allowedMentions: { parse: [], repliedUser: false },
      }).catch(() => {});
      return;
    }

    await message.reply({
      content: `Pesan Discord terkirim ke Minecraft: \`${cleanText(result.text || record.job?.text || '-', 120)}\``,
      allowedMentions: { parse: [], repliedUser: false },
    }).catch(() => {});
  }

  async function replyMigrationLocked(interaction) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xe74c3c)
          .setTitle('Tombol Terkunci')
          .setDescription('Tombol migrasi ini hanya untuk admin yang menjalankan command.'),
      ],
      ephemeral: true,
      allowedMentions: { parse: [], repliedUser: false },
    }).catch(() => {});
  }

  function attachMigrationCollector(reply, record, result) {
    const sourceId = record.id || record.job?.id || '';
    const candidates = Array.isArray(result.candidates) ? result.candidates.slice(0, 5) : [];
    if (!reply?.createMessageComponentCollector || !sourceId || !candidates.length) return;

    const requesterId = String(record.context?.message?.author?.id || record.job?.requestedBy || '');
    let selectedIndex = null;
    let completed = false;
    const collector = reply.createMessageComponentCollector({
      time: QUERY_SELECT_COLLECTOR_MS,
      filter: interaction => Boolean(parseMigrationButtonId(interaction.customId, sourceId)),
    });

    collector.on('collect', async interaction => {
      const parsed = parseMigrationButtonId(interaction.customId, sourceId);
      if (!parsed) return;

      if (requesterId && String(interaction.user?.id || '') !== requesterId) {
        await replyMigrationLocked(interaction);
        return;
      }

      if (parsed.action === 'cancel') {
        completed = true;
        collector.stop('cancelled');
        await interaction.update({
          embeds: [
            new EmbedBuilder()
              .setColor(0x95a5a6)
              .setTitle('Migrasi Dibatalkan')
              .setDescription('Tidak ada data player yang dipindahkan.')
              .setFooter({ text: `Ref ${sourceId}` })
              .setTimestamp(new Date()),
          ],
          components: selectedIndex === null
            ? buildMigrationPickComponents(sourceId, candidates, true)
            : buildMigrationConfirmComponents(sourceId, selectedIndex, true),
          allowedMentions: { parse: [], repliedUser: false },
        }).catch(() => {});
        return;
      }

      if (parsed.action === 'pick') {
        const candidate = candidates[parsed.index];
        if (!candidate) {
          await interaction.reply({
            content: 'Kandidat migrasi tidak valid.',
            ephemeral: true,
            allowedMentions: { parse: [], repliedUser: false },
          }).catch(() => {});
          return;
        }

        selectedIndex = parsed.index;
        await interaction.update({
          embeds: [buildMigrationPreviewEmbed(record, result, candidate)],
          components: buildMigrationConfirmComponents(sourceId, selectedIndex),
          allowedMentions: { parse: [], repliedUser: false },
        }).catch(() => {});
        return;
      }

      if (parsed.action === 'confirm') {
        const candidate = candidates[parsed.index];
        if (!candidate) {
          await interaction.reply({
            content: 'Kandidat migrasi tidak valid.',
            ephemeral: true,
            allowedMentions: { parse: [], repliedUser: false },
          }).catch(() => {});
          return;
        }

        completed = true;
        collector.stop('confirmed');
        const newName = cleanText(result.newName || record.job?.newName || '', 80);
        const job = enqueueBridgeQuery('player_migration_apply', {
          oldKey: migrationCandidateKey(candidate),
          oldName: migrationCandidateName(candidate),
          newName,
          requestedBy: interaction.user?.id || record.job?.requestedBy || '',
          requestedByTag: interaction.user?.tag || interaction.user?.username || record.job?.requestedByTag || '',
          previewRef: sourceId,
        }, {
          message: record.context?.message,
          migration: {
            oldKey: migrationCandidateKey(candidate),
            oldName: migrationCandidateName(candidate),
            newName,
          },
        });

        await interaction.update({
          embeds: [buildMigrationQueuedEmbed(record, candidate, newName, job)],
          components: buildMigrationConfirmComponents(sourceId, parsed.index, true),
          allowedMentions: { parse: [], repliedUser: false },
        }).catch(() => {});
        await interaction.followUp({
          content: `Migrasi dikirim ke BP. Ref: \`${job.id}\``,
          ephemeral: true,
          allowedMentions: { parse: [], repliedUser: false },
        }).catch(() => {});
      }
    });

    collector.on('end', async () => {
      if (completed) return;
      await reply.edit({
        components: selectedIndex === null
          ? buildMigrationPickComponents(sourceId, candidates, true)
          : buildMigrationConfirmComponents(sourceId, selectedIndex, true),
      }).catch(() => {});
    });
  }

  async function sendMigrationPreviewResult(record, result) {
    const message = record.context?.message;
    if (!message) return;

    const candidates = Array.isArray(result.candidates) ? result.candidates.slice(0, 5) : [];
    const components = result.ok && candidates.length
      ? buildMigrationPickComponents(record.id || record.job?.id || '', candidates)
      : [];
    const reply = await message.reply(noPingPayload({
      embeds: [buildMigrationPreviewEmbed(record, result)],
      components,
    })).catch(() => null);
    if (result.ok && candidates.length) attachMigrationCollector(reply, record, result);
  }

  async function sendMigrationApplyResult(record, result) {
    const message = record.context?.message;
    if (!message) return;

    await message.reply(noPingPayload({
      embeds: [buildMigrationApplyEmbed(record, result)],
    })).catch(() => {});
  }

  function playerNameFromTransferSide(side = {}, fallback = '-') {
    return cleanText(side.name || side.gamertag || side.key || fallback, 80) || fallback;
  }

  function transferFailureText(result = {}) {
    const code = cleanText(result.code || 'unknown', 80);
    const message = cleanText(result.message || '', 300);
    return message ? `${code}: ${message}` : code;
  }

  function transferCandidateLines(result = {}) {
    const candidates = Array.isArray(result.candidates) ? result.candidates.slice(0, 5) : [];
    if (!candidates.length) return '';
    return '\n\nKandidat:\n' + candidates
      .map((candidate, index) => {
        const name = playerNameFromTransferSide(candidate, '-');
        const status = candidate.online ? 'online' : 'offline';
        return `${index + 1}. ${inlineCode(name, 80)} | ${status}`;
      })
      .join('\n');
  }

  function discordMentionOrDash(...ids) {
    for (const idRaw of ids) {
      const id = cleanText(idRaw, 40);
      if (/^\d{5,30}$/.test(id)) return `<@${id}>`;
    }
    return '-';
  }

  async function sendWalletTransferResult(record, result) {
    const message = record.context?.message;
    if (!message) return;

    if (!result.ok) {
      await message.reply(noPingPayload({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle('Transfer Geon Gagal')
            .setDescription(`Transfer tidak dijalankan.\nAlasan: \`${transferFailureText(result)}\`${transferCandidateLines(result)}`)
            .setFooter({ text: `Ref ${record.job?.id || record.id || '-'}` })
            .setTimestamp(new Date()),
        ],
      })).catch(() => {});
      return;
    }

    const amount = result.amount || record.job?.amount || 0;
    const from = result.from || {};
    const to = result.to || {};
    const fromName = playerNameFromTransferSide(from, record.job?.fromName || '-');
    const toName = playerNameFromTransferSide(to, record.job?.targetName || record.job?.targetQuery || '-');

    await message.reply(noPingPayload({
      embeds: [
        new EmbedBuilder()
          .setColor(EMBED_COLOR_TRANSFER)
          .setTitle('Transfer Geon Berhasil')
          .setDescription(`${inlineCode(fromName, 80)} mengirim **${formatNumber(amount)} Geon** ke ${inlineCode(toName, 80)}.`)
          .addFields(
            { name: 'Pengirim', value: `${inlineCode(fromName, 80)}\nSaldo: ${formatNumber(from.balanceGeon)} Geon`, inline: true },
            { name: 'Penerima', value: `${inlineCode(toName, 80)}\nSaldo: ${formatNumber(to.balanceGeon)} Geon`, inline: true },
            { name: 'Discord', value: discordMentionOrDash(record.job?.fromDiscordUserId, record.job?.requestedBy, message.author?.id), inline: true }
          )
          .setFooter({ text: `Transparansi finance aktif | Ref ${record.job?.id || record.id || '-'}` })
          .setTimestamp(new Date()),
      ],
    })).catch(() => {});
  }

  async function sendWalletBonusResult(record, result) {
    const message = record.context?.message;
    if (!message) return;

    if (!result.ok) {
      await message.reply(noPingPayload({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle('Bonus Geon Gagal')
            .setDescription(`Bonus tidak dijalankan.\nAlasan: \`${transferFailureText(result)}\`${transferCandidateLines(result)}`)
            .setFooter({ text: `Ref ${record.job?.id || record.id || '-'}` })
            .setTimestamp(new Date()),
        ],
      })).catch(() => {});
      return;
    }

    const amount = result.amount || record.job?.amount || 0;
    const target = result.target || {};
    const targetName = playerNameFromTransferSide(target, record.job?.targetQuery || '-');
    const admin = cleanText(record.job?.requestedByTag || '', 80);

    await message.reply(noPingPayload({
      embeds: [
        new EmbedBuilder()
          .setColor(EMBED_COLOR_BONUS)
          .setTitle('Bonus Geon Berhasil')
          .setDescription(`${inlineCode(targetName, 80)} menerima bonus **${formatNumber(amount)} Geon**.`)
          .addFields(
            { name: 'Target', value: `${inlineCode(targetName, 80)}\nSaldo: ${formatNumber(target.balanceGeon)} Geon`, inline: true },
            { name: 'Admin', value: record.job?.requestedBy ? `<@${record.job.requestedBy}>${admin ? `\n${inlineCode(admin, 80)}` : ''}` : (admin || '-'), inline: true }
          )
          .setFooter({ text: `Transparansi finance aktif | Ref ${record.job?.id || record.id || '-'}` })
          .setTimestamp(new Date()),
      ],
    })).catch(() => {});
  }

  async function sendQueryResult(record, result) {
    if (record.job.type === 'wallet') {
      await sendWalletResult(record, result);
    } else if (record.job.type === 'search_server') {
      await sendSearchServerResult(record, result);
    } else if (record.job.type === 'player_info') {
      await sendPlayerInfoResult(record, result);
    } else if (record.job.type === 'organization_search' || record.job.type === 'organization_directory') {
      await sendOrganizationSearchResult(record, result);
    } else if (record.job.type === 'organization_info') {
      await sendOrganizationInfoResult(record, result);
    } else if (record.job.type === 'ping') {
      await sendPingResult(record, result);
    } else if (record.job.type === 'discord_broadcast') {
      await sendDiscordBroadcastResult(record, result);
    } else if (record.job.type === 'wallet_transfer') {
      await sendWalletTransferResult(record, result);
    } else if (record.job.type === 'wallet_bonus') {
      await sendWalletBonusResult(record, result);
    } else if (record.job.type === 'player_migration_preview') {
      await sendMigrationPreviewResult(record, result);
    } else if (record.job.type === 'player_migration_apply') {
      await sendMigrationApplyResult(record, result);
    }
  }

  async function completeJob(resultRaw = {}) {
    const jobId = String(resultRaw.jobId || '');
    const record = jobs.get(jobId);
    if (!record) return { ok: false, code: 'job-not-found' };

    record.status = 'done';
    record.updatedAt = Date.now();
    record.result = resultRaw;
    bridgeStats.lastResultAt = new Date().toISOString();
    saveJobsToDisk(record.updatedAt);

    try {
      await deleteLoadingMessage(record).catch(() => false);
      if (record.job.type === 'coupon') {
        await sendCouponResult(record, resultRaw);
      } else if (record.job.type === 'topup') {
        await sendTopupResult(record, resultRaw);
      } else {
        await sendQueryResult(record, resultRaw);
      }
    } catch (err) {
      console.error('Failed to send topup bridge result:', err);
    }

    pruneJobs();
    return { ok: true };
  }

  async function resolveChatChannel() {
    if (!client || !MINECRAFT_CHAT_LOG_CHANNEL_ID) return null;
    if (!chatChannelPromise) {
      chatChannelPromise = client.channels.fetch(MINECRAFT_CHAT_LOG_CHANNEL_ID).catch(err => {
        chatChannelPromise = null;
        console.error('Failed to fetch Minecraft chat log channel:', err);
        return null;
      });
    }
    return chatChannelPromise;
  }

  async function sendChatLog(event) {
    const channel = await resolveChatChannel();
    if (!channel?.send) return { ok: false, code: 'chat-channel-unavailable' };

    const name = cleanText(event.name || 'unknown', 80);
    const message = cleanText(event.message || '', 1600);
    if (!message) return { ok: false, code: 'empty-message' };

    const player = normalizeOnlinePlayer(event.player || event);
    const onlineCountRaw = Number(event.onlineCount);
    const onlineCount = Number.isFinite(onlineCountRaw) && onlineCountRaw >= 0
      ? Math.floor(onlineCountRaw)
      : getOnlinePlayers().length;
    const wallet = normalizeWalletProfile(event.wallet || event.player?.wallet || player.wallet);
    const source = cleanText(event.source || event.chatSource || 'global', 40) || 'global';
    const linked = findLinkedUserForPlayer(event);
    const user = await resolveDiscordUser(linked?.userId);
    const authorIconUrl = discordAvatarUrl(user);
    const rank = cleanText(event.rank || 'Player', 180) || 'Player';
    const footerParts = [
      `source: ${source}`,
      `online: ${formatNumber(onlineCount)}`,
      wallet ? `geon: ${formatNumber(wallet.geon)}` : '',
      wallet ? `ether: ${formatNumber(wallet.ether)}` : '',
      `rank: ${rank}`,
      linked?.userId ? `Discord ID: ${linked.userId}` : 'Discord: belum register'
    ];

    await channel.send({
      embeds: [createLogEmbed({
        color: EMBED_COLOR_CHAT,
        title: `Chat | ${name}`,
        description: boldDiscordText(message),
        footerParts,
        authorIconUrl,
        compact: true,
      })],
      allowedMentions: { parse: [] },
    }).catch(err => {
      throw err;
    });
    return { ok: true };
  }

  async function sendTransparencyLog(event) {
    const channel = await resolveChatChannel();
    if (!channel?.send) return { ok: false, code: 'chat-channel-unavailable' };

    const category = cleanText(event.category || 'unknown', 40);
    const label = cleanText(event.label || category || 'unknown', 80);
    const message = cleanText(event.message || '', 1600);
    if (!message) return { ok: false, code: 'empty-message' };

    await channel.send({
      embeds: [createLogEmbed({
        color: EMBED_COLOR_TRANS,
        description: message,
        title: `Transparansi | ${label || category || 'unknown'}`,
        footerParts: [`Kategori: ${category}`],
        compact: true,
      })],
      allowedMentions: { parse: [] },
    }).catch(err => {
      throw err;
    });
    return { ok: true };
  }

  async function sendPresenceLog(type, event = {}, detail = '') {
    const channel = await resolveChatChannel();
    if (!channel?.send) return { ok: false, code: 'chat-channel-unavailable' };

    const player = event.player || event;
    const name = cleanText(player.name || event.name || 'unknown', 80);
    if (!name) return { ok: false, code: 'empty-name' };

    const linked = findLinkedUserForPlayer(player);
    const isLeave = type === 'player_leave';
    const action = isLeave ? 'left the game' : 'joined the game';
    const detailText = cleanText(detail, 160);
    const description = [
      `${isLeave ? '🔴' : '🟢'} ${name} ${action}.`,
      detailText ? `Status: ${detailText}` : '',
      linked?.userId ? `Discord ID: \`${linked.userId}\`` : 'Discord ID: -',
    ].filter(Boolean).join('\n');

    await channel.send({
      embeds: [createLogEmbed({
        color: isLeave ? EMBED_COLOR_LEAVE : EMBED_COLOR_JOIN,
        title: `${isLeave ? '[-]' : '[+]'} ${name} ${action}`,
        description,
        footerParts: [isLeave ? 'Event: leave' : 'Event: join'],
        compact: true,
      })],
      allowedMentions: { parse: [] },
    }).catch(err => {
      throw err;
    });
    return { ok: true };
  }

  async function verifyFromMinecraft(event) {
    pruneVerifications();
    const code = String(event.code || '').replace(/[^\d]/g, '');
    const record = pendingVerifications.get(code);
    if (!record) {
      return {
        ok: false,
        code: 'verify-code-not-found',
        pendingCount: pendingVerifications.size,
      };
    }
    if (record.expiresAt <= Date.now()) {
      pendingVerifications.delete(code);
      saveVerificationsToDisk();
      return { ok: false, code: 'verify-code-expired' };
    }

    const name = cleanText(event.name, 80);
    const persistentId = cleanText(event.persistentId, 160);
    if (!name || !persistentId) {
      return {
        ok: false,
        code: 'invalid-player-identity',
        hasName: Boolean(name),
        hasIdentity: Boolean(persistentId),
      };
    }
    if (n(name) !== n(record.gamertag)) {
      return {
        ok: false,
        code: 'gamertag-mismatch',
        expected: record.gamertag,
        actual: name,
      };
    }

    const persistentLooksVolatile = persistentId.startsWith('entity:');
    const existingPersistent = persistentLooksVolatile
      ? null
      : registerStore.findUserByPersistentId?.(persistentId);
    if (existingPersistent && existingPersistent.userId !== record.userId) {
      return {
        ok: false,
        code: 'persistent-id-already-linked',
      };
    }

    const entry = await registerStore.markVerified(record.userId, {
      gamertag: name,
      persistentId,
    });
    if (!entry) return { ok: false, code: 'register-entry-not-found' };

    pendingVerifications.delete(code);
    saveVerificationsToDisk();
    const roleSynced = await syncOfficialMinecraftRole(record.userId).catch(err => {
      console.error('Failed to sync verified Minecraft role:', err);
      return false;
    });
    await record.message?.reply(
      `Verifikasi Minecraft berhasil: \`${name}\` sekarang linked dan verified.` +
        (roleSynced ? ' Role Discord sudah diupdate.' : ' Catatan: role Discord belum bisa diupdate otomatis.')
    ).catch(() => {});
    return { ok: true, code: 'ok', userId: record.userId, gamertag: name, roleSynced };
  }

  async function handleMinecraftEvent(eventRaw = {}) {
    const type = n(eventRaw.type);
    bridgeStats.lastEventAt = new Date().toISOString();
    bridgeStats.lastEventType = type;
    if (type === 'chat') {
      bridgeStats.lastChatAt = bridgeStats.lastEventAt;
      rememberOnlinePlayer(eventRaw.player || eventRaw);
      return sendChatLog(eventRaw);
    }
    if (type === 'transparency') {
      bridgeStats.lastTransparencyAt = bridgeStats.lastEventAt;
      return sendTransparencyLog(eventRaw);
    }
    if (type === 'verify') {
      bridgeStats.lastVerifyAt = bridgeStats.lastEventAt;
      return verifyFromMinecraft(eventRaw);
    }
    if (type === 'player_join') {
      const player = rememberOnlinePlayer(eventRaw.player || eventRaw);
      if (player?.persistentId) {
        await registerStore.markSeenByPersistentId?.(player.persistentId, player.name).catch(() => null);
      }
      const linkedByPersistentId = player?.persistentId
        ? registerStore.findUserByPersistentId?.(player.persistentId)
        : null;
      const linkedByGamertag = registerStore.findUserByGamertag?.(player?.name);
      const linked = linkedByPersistentId || linkedByGamertag;
      const bypass = Boolean(eventRaw.verifyBypass) || isVerifyBypassGamertag(player?.name);
      const verified = bypass || isVerifiedMinecraftLink(linked, player);
      const registeredMatch = isRegisteredMinecraftLink(linkedByGamertag, player);
      const accessAllowed = bypass || verified || registeredMatch;
      let roleSynced = false;
      if (!bypass && accessAllowed && linked?.userId) {
        if (registeredMatch) {
          await registerStore.markSeenByGamertag?.(player?.name).catch(err => {
            console.error('Failed to mark Minecraft gamertag seen:', err);
          });
        }
        roleSynced = await syncOfficialMinecraftRole(linked.userId).catch(err => {
          console.error('Failed to sync official Minecraft role:', err);
          return false;
        });
      }
      bridgeStats.lastPresenceAt = bridgeStats.lastEventAt;
      await sendPresenceLog(
        type,
        { player },
        bypass
          ? 'bypass Discord'
          : (verified ? 'verified Discord' : (registeredMatch ? 'registered Discord' : 'belum register Discord'))
      )
        .catch(err => console.error('Failed to send Minecraft join log:', err));
      return {
        ok: true,
        verified,
        registered: Boolean(linked),
        registeredMatch,
        accessAllowed,
        roleSynced,
        discordUserId: linked?.userId || '',
      };
    }
    if (type === 'player_leave') {
      forgetOnlinePlayer(eventRaw.player || eventRaw);
      bridgeStats.lastPresenceAt = bridgeStats.lastEventAt;
      await sendPresenceLog(type, eventRaw).catch(err => {
        console.error('Failed to send Minecraft leave log:', err);
      });
      return { ok: true };
    }
    if (type === 'snapshot') {
      applyOnlineSnapshot(Array.isArray(eventRaw.players) ? eventRaw.players : []);
      bridgeStats.lastSnapshotAt = bridgeStats.lastEventAt;
      bridgeStats.lastSnapshotOnline = getOnlinePlayers().length;
      return { ok: true, online: getOnlinePlayers().length };
    }
    return { ok: false, code: 'unknown-event-type' };
  }

  function getBridgeStatus() {
    pruneJobs();
    pruneVerifications();
    const counts = { queued: 0, leased: 0, done: 0 };
    for (const record of jobs.values()) {
      if (record.status === 'queued') counts.queued += 1;
      else if (record.status === 'leased') counts.leased += 1;
      else if (record.status === 'done') counts.done += 1;
    }
    return {
      ...bridgeStats,
      jobs: counts,
      onlineCount: getOnlinePlayers().length,
      pendingVerifyCount: pendingVerifications.size,
    };
  }

  return {
    normalizePositiveInt,
    formatNumber,
    rupiahText,
    searchTargets,
    resolveTarget,
    getOnlinePlayers,
    getPlayerStatusByGamertag,
    createVerification,
    enqueueTopup,
    enqueueCoupon,
    enqueueBridgeQuery,
    takeJobs,
    completeJob,
    handleMinecraftEvent,
    getBridgeStatus,
  };
}

module.exports = { createTopupBridgeService };
