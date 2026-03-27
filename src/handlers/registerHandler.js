const {
  REGISTER_ROLE_ID,
  PRIVATE_CHAT_CHANNEL_ID,
  REGISTRATION_INBOX_CHANNEL_ID,
  EVENT_REGISTRATION_CHANNEL_ID,
  MODERATOR_CHANNEL_ID,
  EVENT_ROLE_FILM_ID,
  EVENT_ROLE_BUILD_ID,
  EVENT_ROLE_TALENT_ID
} = require('../config');
const { isAdmin } = require('../utils/permissions');

const EVENT_MAIN_CHOICES = {
  '1': {
    key: '1',
    name: 'Build'
  },
  '2': {
    key: '2',
    name: 'Mono Got Talent'
  },
  '3': {
    key: '3',
    name: 'Film Pendek Promosi MonoDeco'
  }
};

const EVENT_FINAL_CHOICES = {
  '1.1': {
    code: '1.1',
    categoryName: 'Build Gedung',
    mainCategory: 'Build',
    subCategory: 'Gedung'
  },
  '1.2': {
    code: '1.2',
    categoryName: 'Build Ruko',
    mainCategory: 'Build',
    subCategory: 'Ruko'
  },
  '1.3': {
    code: '1.3',
    categoryName: 'Build Rumah',
    mainCategory: 'Build',
    subCategory: 'Rumah'
  },
  '2.1': {
    code: '2.1',
    categoryName: 'Fanart 2D',
    mainCategory: 'Mono Got Talent',
    subCategory: 'Fanart 2D'
  },
  '2.2': {
    code: '2.2',
    categoryName: 'Fanart 3D',
    mainCategory: 'Mono Got Talent',
    subCategory: 'Fanart 3D'
  },
  '3': {
    code: '3',
    categoryName: 'Film Pendek Promosi MonoDeco',
    mainCategory: 'Film Pendek Promosi MonoDeco',
    subCategory: null
  }
};

const EVENT_ALIAS = {
  build: '1',
  gedung: '1.1',
  ruko: '1.2',
  rumah: '1.3',
  talent: '2',
  monogottalent: '2',
  fanart2d: '2.1',
  fanart3d: '2.2',
  film: '3'
};

const EVENT_MAIN_ORDER = ['1', '2', '3'];
const EVENT_FINAL_ORDER = ['1.1', '1.2', '1.3', '2.1', '2.2', '3'];
const EVENT_LIST_PAGE_SIZE = 15;

const EVENT_CATEGORY_ROLE_BY_MAIN_CODE = {
  '1': EVENT_ROLE_BUILD_ID,
  '2': EVENT_ROLE_TALENT_ID,
  '3': EVENT_ROLE_FILM_ID
};

const EVENT_FINAL_INDEX = EVENT_FINAL_ORDER.reduce((acc, code, index) => {
  acc[code] = index;
  return acc;
}, {});

function normalizeChoiceInput(raw) {
  return (raw || '')
    .trim()
    .toLowerCase()
    .replace(/,/g, '.')
    .replace(/\s+/g, '');
}

function resolveEventChoice(input) {
  const normalized = normalizeChoiceInput(input);
  if (!normalized) return { kind: 'none', value: '' };

  const mapped = EVENT_ALIAS[normalized] || normalized;
  if (mapped === '3' && EVENT_FINAL_CHOICES[mapped]) return { kind: 'final', value: mapped };
  if (EVENT_MAIN_CHOICES[mapped]) return { kind: 'main', value: mapped };
  if (EVENT_FINAL_CHOICES[mapped]) return { kind: 'final', value: mapped };
  return { kind: 'invalid', value: input };
}

function getMainCodeFromCategoryCode(code) {
  const normalized = normalizeChoiceInput(code);
  if (!normalized) return '';
  if (!normalized.includes('.')) return normalized;
  return normalized.split('.')[0];
}

function getCategoryRoleIdByCategoryCode(code) {
  const mainCode = getMainCodeFromCategoryCode(code);
  return EVENT_CATEGORY_ROLE_BY_MAIN_CODE[mainCode] || null;
}

function formatEventSelection(entry) {
  if (!entry) return '-';
  return `${entry.categoryCode} - ${entry.categoryName}`;
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

function sanitizeUserText(text) {
  if (!text) return '-';
  return String(text).replace(/@/g, '@\u200b');
}

async function resolveMember(msg) {
  if (msg.member) return msg.member;
  return msg.guild?.members.fetch(msg.author.id).catch(() => null);
}

async function addRoleIfMissing(member, roleId) {
  if (!member || !roleId) return false;
  if (member.roles.cache.has(roleId)) return true;
  const role = member.guild.roles.cache.get(roleId);
  if (!role) return false;
  const updated = await member.roles.add(role).catch(() => null);
  if (updated?.roles?.cache?.has(roleId)) return true;
  return member.roles.cache.has(roleId);
}

async function removeRoleIfPresent(member, roleId) {
  if (!member || !roleId) return true;
  if (!member.roles.cache.has(roleId)) return true;
  const role = member.guild.roles.cache.get(roleId);
  if (!role) return true;
  const updated = await member.roles.remove(role).catch(() => null);
  if (updated?.roles?.cache && !updated.roles.cache.has(roleId)) return true;
  return !member.roles.cache.has(roleId);
}

function getEventCategoryRoleIds() {
  return Array.from(new Set(Object.values(EVENT_CATEGORY_ROLE_BY_MAIN_CODE).filter(Boolean)));
}

async function syncEventCategoryRoles(member, targetRoleId) {
  if (!member) return false;
  const allEventRoleIds = getEventCategoryRoleIds();
  if (!allEventRoleIds.length) return false;

  let ok = true;
  for (const roleId of allEventRoleIds) {
    if (targetRoleId && roleId === targetRoleId) {
      const added = await addRoleIfMissing(member, roleId);
      if (!added) ok = false;
      continue;
    }
    const removed = await removeRoleIfPresent(member, roleId);
    if (!removed) ok = false;
  }

  return ok;
}

async function clearEventCategoryRoles(member) {
  return syncEventCategoryRoles(member, null);
}

async function markApprovedIfPossible(submissionStore, client, userId, source) {
  if (!submissionStore || !userId) return;
  await submissionStore.init(client);
  await submissionStore.markApprovedMember(userId, source);
}

function formatOpenStatus(open) {
  return open ? 'OPEN' : 'CLOSED';
}

function buildRegistrationStatusLines(eventRegistrationStore) {
  if (!eventRegistrationStore) return ['- Status pendaftaran tidak tersedia.'];
  const lines = [];
  lines.push(`- Global: ${formatOpenStatus(eventRegistrationStore.isRegistrationOpen())}`);

  for (const mainCode of EVENT_MAIN_ORDER) {
    const main = EVENT_MAIN_CHOICES[mainCode];
    lines.push(`- ${mainCode}. ${main.name}: ${formatOpenStatus(eventRegistrationStore.isRegistrationOpen(mainCode))}`);

    const subChoices = EVENT_FINAL_ORDER.filter(code => {
      return getMainCodeFromCategoryCode(code) === mainCode && code !== '3';
    });
    for (const code of subChoices) {
      lines.push(
        `  - ${code}. ${EVENT_FINAL_CHOICES[code].categoryName}: ${formatOpenStatus(eventRegistrationStore.isRegistrationOpen(code))}`
      );
    }
  }

  return lines;
}

function buildMainCategoryPrompt(mainCode, eventRegistrationStore) {
  const main = EVENT_MAIN_CHOICES[mainCode];
  if (!main) return 'Kategori tidak ditemukan.';

  const lines = [`**Kategori ${main.name}**`, 'Pilih subkategori:'];
  const subChoices = EVENT_FINAL_ORDER.filter(code => {
    return getMainCodeFromCategoryCode(code) === mainCode && code !== '3';
  });
  for (const code of subChoices) {
    const open = eventRegistrationStore?.isRegistrationOpen(code);
    lines.push(
      `- \`!reg ${code}\` -> ${EVENT_FINAL_CHOICES[code].categoryName} [${formatOpenStatus(Boolean(open))}]`
    );
  }

  if (!subChoices.length) lines.push('Belum ada subkategori tersedia.');
  return lines.join('\n');
}

function buildEventMainMenu(currentEntry, eventRegistrationStore) {
  const currentText = currentEntry
    ? `Status kamu saat ini: **${formatEventSelection(currentEntry)}**`
    : 'Status kamu saat ini: belum terdaftar.';

  const statusLines = buildRegistrationStatusLines(eventRegistrationStore);
  return [
    '**MonoDeco Event 2 - Pendaftaran**',
    currentText,
    'Aturan: 1 user hanya 1 pilihan aktif. Kalau pilih lagi, pilihan lama otomatis diganti.',
    '',
    '**Status Pendaftaran Saat Ini**',
    ...statusLines,
    '',
    'Pilih kategori dengan command berikut:',
    '- `!reg 1` -> Build',
    '- `!reg 2` -> Mono Got Talent',
    '- `!reg 3` -> Film Pendek Promosi MonoDeco',
    '',
    'Atau langsung pilih final:',
    '- `!reg 1.1` Build Gedung | `!reg 1.2` Build Ruko | `!reg 1.3` Build Rumah',
    '- `!reg 2.1` Fanart 2D | `!reg 2.2` Fanart 3D',
    '',
    'Cek data: `!reg-status` | Batalkan: `!reg-cancel`'
  ].join('\n');
}

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

function ensureModeratorChannel(msg, moderatorChannelId) {
  return isTargetChannelOrThread(msg, moderatorChannelId);
}

async function ensureEventStore(eventRegistrationStore, client) {
  if (!eventRegistrationStore) return false;
  await eventRegistrationStore.init(client);
  return true;
}

async function handleEventRegistrationCore(msg, options, choiceCode) {
  const { eventRegistrationStore } = options;
  const choice = EVENT_FINAL_CHOICES[choiceCode];
  if (!choice || !eventRegistrationStore) return false;

  const result = await eventRegistrationStore.upsertRegistration({
    userId: msg.author.id,
    username: msg.author?.tag || msg.author?.username || msg.author?.id || '',
    categoryCode: choice.code,
    categoryName: choice.categoryName,
    mainCategory: choice.mainCategory,
    subCategory: choice.subCategory
  });

  if (!result?.entry) {
    await msg.reply('Gagal mencatat pendaftaran event. Coba lagi.').catch(() => null);
    return true;
  }

  const member = await resolveMember(msg);
  const roleTargetId = getCategoryRoleIdByCategoryCode(choice.code);
  const roleSyncOk = await syncEventCategoryRoles(member, roleTargetId);
  const roleNote = roleSyncOk ? '' : '\nCatatan: role kategori belum berhasil diperbarui otomatis.';

  const { created, previous, entry } = result;
  const nowText = formatEventSelection(entry);
  const registerText = formatDateId(entry.registeredAt);

  if (created) {
    await msg.reply(
      `Pendaftaran MonoDeco Event 2 berhasil dicatat: **${nowText}**.\nWaktu daftar: ${registerText}.${roleNote}`
    ).catch(() => null);
    return true;
  }

  const prevText = previous ? formatEventSelection(previous) : '-';
  if (previous?.categoryCode === entry.categoryCode) {
    await msg.reply(`Pilihan kamu tetap **${nowText}** (sudah tercatat sebelumnya).${roleNote}`).catch(() => null);
    return true;
  }

  await msg.reply(`Pilihan pendaftaran kamu diperbarui dari **${prevText}** ke **${nowText}**.${roleNote}`).catch(() => null);
  return true;
}

function parseRegListRequest(content) {
  const raw = (content || '').trim();
  if (!/^!reg-list(?:\b|-)/i.test(raw)) return null;

  const suffix = raw.slice('!reg-list'.length).trim();
  if (!suffix) {
    return { selector: null, page: 1, error: null };
  }

  const tokens = suffix.startsWith('-')
    ? suffix.slice(1).split('-').filter(Boolean)
    : suffix.split(/\s+/).filter(Boolean);

  if (!tokens.length) {
    return { selector: null, page: 1, error: null };
  }

  if (tokens.length > 2) {
    return {
      selector: null,
      page: 1,
      error: 'Format salah. Gunakan `!reg-list`, `!reg-list-1`, atau `!reg-list-1-2`.'
    };
  }

  const firstToken = tokens[0];
  const secondToken = tokens[1] || '';
  let selector = null;
  let pageToken = secondToken;

  const resolved = resolveEventChoice(firstToken);
  if (resolved.kind === 'main' || resolved.kind === 'final') {
    selector = resolved;
  } else if (/^\d+$/.test(firstToken) && !secondToken) {
    pageToken = firstToken;
  } else {
    return {
      selector: null,
      page: 1,
      error: `Filter \`${firstToken}\` tidak dikenali. Gunakan kode kategori seperti \`1\`, \`2\`, \`1.1\`, \`2.2\`, atau \`3\`.`
    };
  }

  const page = pageToken ? parseInt(pageToken, 10) : 1;
  if (!Number.isFinite(page) || page <= 0) {
    return {
      selector,
      page: 1,
      error: `Nomor halaman \`${pageToken}\` tidak valid.`
    };
  }

  return { selector, page, error: null };
}

function sortEventEntries(entries) {
  return [...entries].sort((a, b) => {
    const aCode = normalizeChoiceInput(a.categoryCode);
    const bCode = normalizeChoiceInput(b.categoryCode);
    const aIndex = Number.isFinite(EVENT_FINAL_INDEX[aCode]) ? EVENT_FINAL_INDEX[aCode] : 9999;
    const bIndex = Number.isFinite(EVENT_FINAL_INDEX[bCode]) ? EVENT_FINAL_INDEX[bCode] : 9999;
    if (aIndex !== bIndex) return aIndex - bIndex;

    const aTime = new Date(a.registeredAt).getTime();
    const bTime = new Date(b.registeredAt).getTime();
    if (aTime !== bTime) return aTime - bTime;
    return String(a.userId).localeCompare(String(b.userId));
  });
}

function filterEventEntries(entries, selector) {
  if (!selector) return entries;
  const selectedCode = normalizeChoiceInput(selector.value);
  if (selector.kind === 'main') {
    return entries.filter(entry => getMainCodeFromCategoryCode(entry.categoryCode) === selectedCode);
  }
  return entries.filter(entry => normalizeChoiceInput(entry.categoryCode) === selectedCode);
}

function paginateEntries(entries, page, pageSize = EVENT_LIST_PAGE_SIZE) {
  const totalItems = entries.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const start = (safePage - 1) * pageSize;
  const end = start + pageSize;
  const items = entries.slice(start, end);
  return {
    items,
    totalItems,
    totalPages,
    page: safePage,
    startIndex: start
  };
}

function describeRegListSelector(selector) {
  if (!selector) return 'Semua kategori';
  if (selector.kind === 'main') {
    const main = EVENT_MAIN_CHOICES[selector.value];
    return main ? `${selector.value} - ${main.name}` : selector.value;
  }
  const finalChoice = EVENT_FINAL_CHOICES[selector.value];
  return finalChoice ? `${selector.value} - ${finalChoice.categoryName}` : selector.value;
}

function summarizeMainTotals(entries) {
  const totals = { '1': 0, '2': 0, '3': 0 };
  for (const entry of entries) {
    const mainCode = getMainCodeFromCategoryCode(entry.categoryCode);
    if (totals[mainCode] === undefined) continue;
    totals[mainCode] += 1;
  }
  return totals;
}

function formatRegistrationIdentity(entry) {
  const name = sanitizeUserText(entry.username || `user-${String(entry.userId).slice(-4)}`);
  return `${name} (\`${entry.userId}\`)`;
}

function buildAdminControlSummary(eventRegistrationStore) {
  if (!eventRegistrationStore) {
    return 'Status pendaftaran tidak tersedia.';
  }
  return [
    '**Panel Kontrol Pendaftaran Event**',
    ...buildRegistrationStatusLines(eventRegistrationStore),
    '',
    'Command admin:',
    '- `!reg-open` -> buka pendaftaran global',
    '- `!reg-close` -> tutup pendaftaran global',
    '- `!reg-open <kode>` -> buka kategori/subkategori tertentu',
    '- `!reg-close <kode>` -> tutup kategori/subkategori tertentu',
    '- `!reg-panel` -> lihat status buka/tutup',
    '- `!reg-announce <kode> | <pesan opsional>` -> kirim announcement ke channel event'
  ].join('\n');
}

async function handleEventRegAdminPanelCommand(msg, options) {
  const { moderatorChannelId, eventRegistrationStore } = options;
  const content = (msg.content || '').trim();
  if (!/^!reg-panel\b/i.test(content)) return false;
  if (!msg.guild) return false;

  if (!ensureModeratorChannel(msg, moderatorChannelId)) {
    await msg.reply(`Command admin ini hanya dipakai di <#${moderatorChannelId}>.`).catch(() => null);
    return true;
  }

  const member = await resolveMember(msg);
  if (!isAdmin(member)) {
    await msg.reply('Command ini hanya untuk admin.').catch(() => null);
    return true;
  }

  const ready = await ensureEventStore(eventRegistrationStore, msg.client);
  if (!ready) {
    await msg.reply('Sistem pendaftaran event belum aktif. Hubungi admin.').catch(() => null);
    return true;
  }

  await msg.reply(buildAdminControlSummary(eventRegistrationStore)).catch(() => null);
  return true;
}

async function handleEventRegAdminOpenCloseCommand(msg, options) {
  const { moderatorChannelId, eventRegistrationStore } = options;
  const content = (msg.content || '').trim();
  const match = content.match(/^!reg-(open|close)(?:\s+(.+))?$/i);
  if (!match) return false;
  if (!msg.guild) return false;

  if (!ensureModeratorChannel(msg, moderatorChannelId)) {
    await msg.reply(`Command admin ini hanya dipakai di <#${moderatorChannelId}>.`).catch(() => null);
    return true;
  }

  const member = await resolveMember(msg);
  if (!isAdmin(member)) {
    await msg.reply('Command ini hanya untuk admin.').catch(() => null);
    return true;
  }

  const ready = await ensureEventStore(eventRegistrationStore, msg.client);
  if (!ready) {
    await msg.reply('Sistem pendaftaran event belum aktif. Hubungi admin.').catch(() => null);
    return true;
  }

  const action = (match[1] || '').toLowerCase();
  const open = action === 'open';
  const rawTarget = (match[2] || '').trim();

  if (!rawTarget || /^all$/i.test(rawTarget)) {
    await eventRegistrationStore.setGlobalRegistrationOpen(open, msg.author.id);
    await msg.reply(
      `${open ? 'Pendaftaran global dibuka.' : 'Pendaftaran global ditutup.'}\n\n${buildAdminControlSummary(eventRegistrationStore)}`
    ).catch(() => null);
    return true;
  }

  const selected = resolveEventChoice(rawTarget);
  if (selected.kind === 'invalid' || selected.kind === 'none') {
    await msg.reply(
      `Kategori \`${rawTarget}\` tidak dikenali.\nGunakan contoh: \`!reg-close 1\`, \`!reg-open 2.1\`, atau \`!reg-open film\`.`
    ).catch(() => null);
    return true;
  }

  await eventRegistrationStore.setCategoryRegistrationOpen(selected.value, open, msg.author.id);

  let targetLabel = selected.value;
  if (selected.kind === 'main') {
    targetLabel = `${selected.value} - ${EVENT_MAIN_CHOICES[selected.value]?.name || selected.value}`;
  } else {
    targetLabel = `${selected.value} - ${EVENT_FINAL_CHOICES[selected.value]?.categoryName || selected.value}`;
  }

  await msg.reply(
    `${open ? 'Dibuka' : 'Ditutup'}: **${targetLabel}**.\n\n${buildAdminControlSummary(eventRegistrationStore)}`
  ).catch(() => null);
  return true;
}

async function handleEventRegAnnouncementCommand(msg, options) {
  const { moderatorChannelId, eventRegistrationStore, eventRegistrationChannelId } = options;
  const content = (msg.content || '').trim();
  if (!/^!reg-announce\b/i.test(content)) return false;
  if (!msg.guild) return false;

  if (!ensureModeratorChannel(msg, moderatorChannelId)) {
    await msg.reply(`Command admin ini hanya dipakai di <#${moderatorChannelId}>.`).catch(() => null);
    return true;
  }

  const member = await resolveMember(msg);
  if (!isAdmin(member)) {
    await msg.reply('Command ini hanya untuk admin.').catch(() => null);
    return true;
  }

  const ready = await ensureEventStore(eventRegistrationStore, msg.client);
  if (!ready) {
    await msg.reply('Sistem pendaftaran event belum aktif. Hubungi admin.').catch(() => null);
    return true;
  }

  const rawArgs = content.replace(/^!reg-announce\b/i, '').trim();
  if (!rawArgs) {
    await msg.reply(
      'Format: `!reg-announce <kode> | <pesan opsional>`\nContoh: `!reg-announce 1 | Build mulai 20.00 WIB`'
    ).catch(() => null);
    return true;
  }

  let codeInput = rawArgs;
  let note = '';
  const pipeIndex = rawArgs.indexOf('|');
  if (pipeIndex >= 0) {
    codeInput = rawArgs.slice(0, pipeIndex).trim();
    note = rawArgs.slice(pipeIndex + 1).trim();
  } else {
    const tokens = rawArgs.split(/\s+/);
    codeInput = tokens.shift() || '';
    note = tokens.join(' ').trim();
  }

  const selected = resolveEventChoice(codeInput);
  if (selected.kind === 'invalid' || selected.kind === 'none') {
    await msg.reply(
      `Kategori \`${codeInput}\` tidak dikenali.\nGunakan contoh: \`1\`, \`2\`, \`1.1\`, \`2.2\`, atau \`3\`.`
    ).catch(() => null);
    return true;
  }

  const categoryCode = selected.value;
  const categoryName = selected.kind === 'main'
    ? (EVENT_MAIN_CHOICES[categoryCode]?.name || categoryCode)
    : (EVENT_FINAL_CHOICES[categoryCode]?.categoryName || categoryCode);
  const roleId = getCategoryRoleIdByCategoryCode(categoryCode);

  const targetChannel = await msg.guild.channels.fetch(eventRegistrationChannelId).catch(() => null);
  if (!targetChannel || !targetChannel.isTextBased()) {
    await msg.reply('Channel announcement event tidak ditemukan atau tidak bisa dipakai.').catch(() => null);
    return true;
  }

  const lines = [];
  if (roleId) lines.push(`<@&${roleId}>`);
  lines.push(`**Pengumuman Event: ${categoryCode} - ${categoryName}**`);
  lines.push(`Kategori **${categoryName}** akan segera dimulai. Mohon peserta bersiap.`);
  if (note) lines.push(`Catatan admin: ${sanitizeUserText(note)}`);
  lines.push(`Admin: ${sanitizeUserText(msg.author?.tag || msg.author?.username || msg.author?.id || '-')}`);

  const sent = await targetChannel.send({
    content: lines.join('\n'),
    allowedMentions: roleId ? { roles: [roleId] } : { parse: [] }
  }).catch(() => null);

  if (!sent) {
    await msg.reply('Gagal mengirim announcement. Cek permission bot di channel event.').catch(() => null);
    return true;
  }

  await eventRegistrationStore.addAnnouncementLog({
    categoryCode,
    categoryName,
    announcedBy: msg.author.id,
    announcedAt: new Date().toISOString(),
    channelId: sent.channelId,
    messageId: sent.id,
    note: note || null
  }).catch(() => null);

  await msg.reply(`Announcement terkirim ke <#${targetChannel.id}> untuk **${categoryCode} - ${categoryName}**.`).catch(() => null);
  return true;
}

async function handleEventRegCommand(msg, options) {
  const { eventRegistrationChannelId, eventRegistrationStore } = options;
  const content = (msg.content || '').trim();
  const match = content.match(/^!reg(?:\s+(.+))?$/i);
  if (!match) return false;
  if (!msg.guild) return false;

  if (!ensureRegChannel(msg, eventRegistrationChannelId)) {
    await msg.reply(`Command ini dipakai di <#${eventRegistrationChannelId}>.`).catch(() => null);
    return true;
  }

  const ready = await ensureEventStore(eventRegistrationStore, msg.client);
  if (!ready) {
    await msg.reply('Sistem pendaftaran event belum aktif. Hubungi admin.').catch(() => null);
    return true;
  }

  const currentEntry = eventRegistrationStore.getRegistration(msg.author.id);
  const input = (match[1] || '').trim();
  const resolved = resolveEventChoice(input);

  if (resolved.kind === 'none') {
    await msg.reply(buildEventMainMenu(currentEntry, eventRegistrationStore)).catch(() => null);
    return true;
  }

  if (!eventRegistrationStore.isRegistrationOpen()) {
    await msg.reply(
      'Pendaftaran event sedang ditutup admin untuk sementara.\nCek lagi nanti atau pantau update dari admin.'
    ).catch(() => null);
    return true;
  }

  if (resolved.kind === 'main') {
    if (!eventRegistrationStore.isRegistrationOpen(resolved.value)) {
      await msg.reply(
        `Pendaftaran kategori **${EVENT_MAIN_CHOICES[resolved.value]?.name || resolved.value}** sedang ditutup.`
      ).catch(() => null);
      return true;
    }
    await msg.reply(buildMainCategoryPrompt(resolved.value, eventRegistrationStore)).catch(() => null);
    return true;
  }

  if (resolved.kind === 'final') {
    if (!eventRegistrationStore.isRegistrationOpen(resolved.value)) {
      await msg.reply(
        `Pendaftaran kategori **${EVENT_FINAL_CHOICES[resolved.value]?.categoryName || resolved.value}** sedang ditutup.`
      ).catch(() => null);
      return true;
    }
    return handleEventRegistrationCore(msg, options, resolved.value);
  }

  await msg.reply(
    `Pilihan \`${input}\` tidak dikenali.\n\n${buildEventMainMenu(currentEntry, eventRegistrationStore)}`
  ).catch(() => null);
  return true;
}

async function handleEventRegStatusCommand(msg, options) {
  const { eventRegistrationChannelId, eventRegistrationStore } = options;
  const content = (msg.content || '').trim();
  if (!/^!reg-status\b/i.test(content)) return false;
  if (!msg.guild) return false;

  if (!ensureRegChannel(msg, eventRegistrationChannelId)) {
    await msg.reply(`Command ini dipakai di <#${eventRegistrationChannelId}>.`).catch(() => null);
    return true;
  }

  const ready = await ensureEventStore(eventRegistrationStore, msg.client);
  if (!ready) {
    await msg.reply('Sistem pendaftaran event belum aktif. Hubungi admin.').catch(() => null);
    return true;
  }

  const entry = eventRegistrationStore.getRegistration(msg.author.id);
  if (!entry) {
    await msg.reply('Kamu belum terdaftar di MonoDeco Event 2. Gunakan `!reg` untuk mulai.').catch(() => null);
    return true;
  }

  await msg.reply(
    [
      '**Status Pendaftaran MonoDeco Event 2**',
      `- Pilihan: ${formatEventSelection(entry)}`,
      `- Pertama daftar: ${formatDateId(entry.registeredAt)}`,
      `- Update terakhir: ${formatDateId(entry.updatedAt)}`
    ].join('\n')
  ).catch(() => null);
  return true;
}

async function handleEventRegCancelCommand(msg, options) {
  const { eventRegistrationChannelId, eventRegistrationStore } = options;
  const content = (msg.content || '').trim();
  if (!/^!reg-cancel\b/i.test(content)) return false;
  if (!msg.guild) return false;

  if (!ensureRegChannel(msg, eventRegistrationChannelId)) {
    await msg.reply(`Command ini dipakai di <#${eventRegistrationChannelId}>.`).catch(() => null);
    return true;
  }

  const ready = await ensureEventStore(eventRegistrationStore, msg.client);
  if (!ready) {
    await msg.reply('Sistem pendaftaran event belum aktif. Hubungi admin.').catch(() => null);
    return true;
  }

  const entry = eventRegistrationStore.getRegistration(msg.author.id);
  if (!entry) {
    await msg.reply('Belum ada data pendaftaran kamu untuk dibatalkan.').catch(() => null);
    return true;
  }

  const removed = await eventRegistrationStore.removeRegistration(msg.author.id);
  if (!removed) {
    await msg.reply('Gagal membatalkan pendaftaran. Coba lagi.').catch(() => null);
    return true;
  }

  const member = await resolveMember(msg);
  const roleSyncOk = await clearEventCategoryRoles(member);
  const roleNote = roleSyncOk ? '' : '\nCatatan: role kategori belum berhasil dilepas otomatis.';
  await msg.reply(`Pendaftaran event kamu dibatalkan: **${formatEventSelection(entry)}**.${roleNote}`).catch(() => null);
  return true;
}

async function handleEventRegListCommand(msg, options) {
  const { eventRegistrationChannelId, eventRegistrationStore } = options;
  const content = (msg.content || '').trim();
  const parsed = parseRegListRequest(content);
  if (!parsed) return false;
  if (!msg.guild) return false;

  if (!ensureRegChannel(msg, eventRegistrationChannelId)) {
    await msg.reply(`Command ini dipakai di <#${eventRegistrationChannelId}>.`).catch(() => null);
    return true;
  }

  const ready = await ensureEventStore(eventRegistrationStore, msg.client);
  if (!ready) {
    await msg.reply('Sistem pendaftaran event belum aktif. Hubungi admin.').catch(() => null);
    return true;
  }

  if (parsed.error) {
    await msg.reply(parsed.error).catch(() => null);
    return true;
  }

  const allEntries = sortEventEntries(eventRegistrationStore.getRegistrations());
  if (!allEntries.length) {
    await msg.reply('Belum ada data pendaftaran MonoDeco Event 2.').catch(() => null);
    return true;
  }

  const filteredEntries = filterEventEntries(allEntries, parsed.selector);
  if (!filteredEntries.length) {
    await msg.reply(
      `Belum ada pendaftar untuk filter **${describeRegListSelector(parsed.selector)}**.`
    ).catch(() => null);
    return true;
  }

  const pagination = paginateEntries(filteredEntries, parsed.page, EVENT_LIST_PAGE_SIZE);
  if (parsed.page > pagination.totalPages) {
    await msg.reply(
      `Halaman ${parsed.page} tidak tersedia. Maksimal halaman: ${pagination.totalPages}.`
    ).catch(() => null);
    return true;
  }

  const totals = summarizeMainTotals(allEntries);

  const lines = [
    '**Rekap Pendaftaran MonoDeco Event 2**',
    `Filter: ${describeRegListSelector(parsed.selector)}`,
    `Halaman: ${pagination.page}/${pagination.totalPages} (maks ${EVENT_LIST_PAGE_SIZE} data per halaman)`,
    `Total pendaftar (filter): ${pagination.totalItems}`,
    `Total event: Build ${totals['1']} | Mono Got Talent ${totals['2']} | Film Pendek ${totals['3']}`,
    ''
  ];

  pagination.items.forEach((entry, idx) => {
    lines.push(
      `${pagination.startIndex + idx + 1}. ${formatRegistrationIdentity(entry)} | ${formatEventSelection(entry)} | daftar: ${formatDateId(entry.registeredAt)}`
    );
  });

  if (pagination.totalPages > 1) {
    const filterHint = parsed.selector ? `-${parsed.selector.value}` : '';
    lines.push('');
    lines.push(
      `Lanjut halaman lain: \`!reg-list${filterHint}-<nomor_halaman>\` (contoh: \`!reg-list${filterHint}-2\`).`
    );
  }

  await msg.reply(lines.join('\n')).catch(() => null);
  return true;
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
    eventRegistrationChannelId,
    privateChatChannelId,
    moderatorChannelId
  } = options;
  const content = (msg.content || '').trim();
  if (!/^!help\b/i.test(content)) return false;
  if (!msg.guild) return false;

  const registerHint = registrationChannelId ? `<#${registrationChannelId}>` : 'channel registrasi';
  const eventRegisterHint = eventRegistrationChannelId
    ? `<#${eventRegistrationChannelId}>`
    : registerHint;
  const privateChatHint = privateChatChannelId ? `<#${privateChatChannelId}>` : 'channel private chat';
  const moderatorHint = moderatorChannelId ? `<#${moderatorChannelId}>` : 'channel moderator';
  const lines = [
    '**Panduan Singkat**',
    `- Daftar private: kirim \`!daftar\` di ${registerHint}.`,
    '- Cek status pendaftaran private: `!status`.',
    `- Daftar MonoDeco Event 2: \`!reg\` di ${eventRegisterHint}.`,
    '- Event 2: 1 user hanya 1 pilihan aktif; jika daftar ulang, pilihan lama otomatis terganti.',
    '- Cek event: `!reg-status`.',
    '- Batalkan event: `!reg-cancel`.',
    '- Rekap event semua kategori: `!reg-list`.',
    '- Rekap filter kategori/subkategori: `!reg-list-1`, `!reg-list-2`, `!reg-list-1.1`.',
    '- Rekap halaman lanjutan: `!reg-list-1-2` (kategori build, halaman 2).',
    `- Admin only di ${moderatorHint}: \`!reg-open\`, \`!reg-close\`, \`!reg-panel\`, \`!reg-announce\`.`,
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
  eventRegistrationStore,
  registrationChannelId = REGISTRATION_INBOX_CHANNEL_ID,
  eventRegistrationChannelId = EVENT_REGISTRATION_CHANNEL_ID,
  privateChatChannelId = PRIVATE_CHAT_CHANNEL_ID,
  moderatorChannelId = MODERATOR_CHANNEL_ID
}) {
  return async function handleRegisterMessage(msg) {
    try {
      if (!msg || msg.author?.bot) return false;
      if (!msg.guild) return false;

      const handledEventAdminPanel = await handleEventRegAdminPanelCommand(msg, {
        moderatorChannelId,
        eventRegistrationStore
      });
      if (handledEventAdminPanel) return true;

      const handledEventAdminToggle = await handleEventRegAdminOpenCloseCommand(msg, {
        moderatorChannelId,
        eventRegistrationStore
      });
      if (handledEventAdminToggle) return true;

      const handledEventAnnouncement = await handleEventRegAnnouncementCommand(msg, {
        moderatorChannelId,
        eventRegistrationStore,
        eventRegistrationChannelId
      });
      if (handledEventAnnouncement) return true;

      const eventHandledList = await handleEventRegListCommand(msg, {
        eventRegistrationChannelId,
        eventRegistrationStore
      });
      if (eventHandledList) return true;

      const eventHandledStatus = await handleEventRegStatusCommand(msg, {
        eventRegistrationChannelId,
        eventRegistrationStore
      });
      if (eventHandledStatus) return true;

      const eventHandledCancel = await handleEventRegCancelCommand(msg, {
        eventRegistrationChannelId,
        eventRegistrationStore
      });
      if (eventHandledCancel) return true;

      const eventHandledReg = await handleEventRegCommand(msg, {
        eventRegistrationChannelId,
        eventRegistrationStore
      });
      if (eventHandledReg) return true;

      const handledRegister = await handleRegisterCommand(msg, {
        roleId,
        submissionStore,
        registrationChannelId,
        privateChatChannelId
      });
      if (handledRegister) return true;

      const handledHelp = await handleHelpCommand(msg, {
        registrationChannelId,
        eventRegistrationChannelId,
        privateChatChannelId,
        moderatorChannelId
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

module.exports = { createRegisterHandler, createSubmissionReactionHandler, scanSubmissionApprovals };
