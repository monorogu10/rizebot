const {
  REGISTER_ROLE_ID,
  PRIVATE_CHAT_CHANNEL_ID,
  REGISTRATION_INBOX_CHANNEL_ID
} = require('../config');
const { isAdmin } = require('../utils/permissions');

const EVENT_MAIN_CHOICES = {
  '1': {
    key: '1',
    name: 'Build',
    prompt: [
      '**Kategori Build**',
      'Pilih subkategori:',
      '- `!reg 1.1` -> Build Gedung',
      '- `!reg 1.2` -> Build Ruko',
      '- `!reg 1.3` -> Build Rumah'
    ].join('\n')
  },
  '2': {
    key: '2',
    name: 'Mono Got Talent',
    prompt: [
      '**Kategori Mono Got Talent**',
      'Pilih subkategori:',
      '- `!reg 2.1` -> Fanart 2D',
      '- `!reg 2.2` -> Fanart 3D'
    ].join('\n')
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
  if (EVENT_MAIN_CHOICES[mapped]) return { kind: 'main', value: mapped };
  if (EVENT_FINAL_CHOICES[mapped]) return { kind: 'final', value: mapped };
  return { kind: 'invalid', value: input };
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

function splitIntoChunks(lines, maxLength = 1800) {
  const chunks = [];
  let current = '';

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }

    if (current) chunks.push(current);

    if (line.length <= maxLength) {
      current = line;
      continue;
    }

    let remaining = line;
    while (remaining.length > maxLength) {
      chunks.push(remaining.slice(0, maxLength));
      remaining = remaining.slice(maxLength);
    }
    current = remaining;
  }

  if (current) chunks.push(current);
  return chunks.length ? chunks : ['-'];
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

async function markApprovedIfPossible(submissionStore, client, userId, source) {
  if (!submissionStore || !userId) return;
  await submissionStore.init(client);
  await submissionStore.markApprovedMember(userId, source);
}

function buildEventMainMenu(currentEntry) {
  const currentText = currentEntry
    ? `Status kamu saat ini: **${formatEventSelection(currentEntry)}**`
    : 'Status kamu saat ini: belum terdaftar.';

  return [
    '**MonoDeco Event 2 - Pendaftaran**',
    currentText,
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

function ensureRegChannel(msg, registrationChannelId) {
  if (!registrationChannelId) return true;
  return String(msg.channelId) === String(registrationChannelId);
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

  const { created, previous, entry } = result;
  const nowText = formatEventSelection(entry);
  const registerText = formatDateId(entry.registeredAt);

  if (created) {
    await msg.reply(
      `Pendaftaran MonoDeco Event 2 berhasil dicatat: **${nowText}**.\nWaktu daftar: ${registerText}.`
    ).catch(() => null);
    return true;
  }

  const prevText = previous ? formatEventSelection(previous) : '-';
  if (previous?.categoryCode === entry.categoryCode) {
    await msg.reply(`Pilihan kamu tetap **${nowText}** (sudah tercatat sebelumnya).`).catch(() => null);
    return true;
  }

  await msg.reply(`Pilihan pendaftaran kamu diperbarui dari **${prevText}** ke **${nowText}**.`).catch(() => null);
  return true;
}

async function handleEventRegCommand(msg, options) {
  const { registrationChannelId, eventRegistrationStore } = options;
  const content = (msg.content || '').trim();
  const match = content.match(/^!reg(?:\s+(.+))?$/i);
  if (!match) return false;
  if (!msg.guild) return false;

  if (!ensureRegChannel(msg, registrationChannelId)) {
    await msg.reply(`Command ini dipakai di <#${registrationChannelId}>.`).catch(() => null);
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
    await msg.reply(buildEventMainMenu(currentEntry)).catch(() => null);
    return true;
  }

  if (resolved.kind === 'main') {
    if (resolved.value === '3') {
      return handleEventRegistrationCore(msg, options, '3');
    }
    const prompt = EVENT_MAIN_CHOICES[resolved.value]?.prompt;
    if (prompt) {
      await msg.reply(prompt).catch(() => null);
      return true;
    }
  }

  if (resolved.kind === 'final') {
    return handleEventRegistrationCore(msg, options, resolved.value);
  }

  await msg.reply(
    `Pilihan \`${input}\` tidak dikenali.\n\n${buildEventMainMenu(currentEntry)}`
  ).catch(() => null);
  return true;
}

async function handleEventRegStatusCommand(msg, options) {
  const { registrationChannelId, eventRegistrationStore } = options;
  const content = (msg.content || '').trim();
  if (!/^!reg-status\b/i.test(content)) return false;
  if (!msg.guild) return false;

  if (!ensureRegChannel(msg, registrationChannelId)) {
    await msg.reply(`Command ini dipakai di <#${registrationChannelId}>.`).catch(() => null);
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
  const { registrationChannelId, eventRegistrationStore } = options;
  const content = (msg.content || '').trim();
  if (!/^!reg-cancel\b/i.test(content)) return false;
  if (!msg.guild) return false;

  if (!ensureRegChannel(msg, registrationChannelId)) {
    await msg.reply(`Command ini dipakai di <#${registrationChannelId}>.`).catch(() => null);
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

  await msg.reply(`Pendaftaran event kamu dibatalkan: **${formatEventSelection(entry)}**.`).catch(() => null);
  return true;
}

async function handleEventRegListCommand(msg, options) {
  const { registrationChannelId, eventRegistrationStore } = options;
  const content = (msg.content || '').trim();
  if (!/^!reg-list\b/i.test(content)) return false;
  if (!msg.guild) return false;

  if (!ensureRegChannel(msg, registrationChannelId)) {
    await msg.reply(`Command ini dipakai di <#${registrationChannelId}>.`).catch(() => null);
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

  const entries = eventRegistrationStore.getRegistrations();
  if (!entries.length) {
    await msg.reply('Belum ada data pendaftaran MonoDeco Event 2.').catch(() => null);
    return true;
  }

  const totals = {
    build: entries.filter(item => item.mainCategory === 'Build').length,
    talent: entries.filter(item => item.mainCategory === 'Mono Got Talent').length,
    film: entries.filter(item => item.categoryCode === '3').length
  };

  const lines = [
    '**Rekap Pendaftaran MonoDeco Event 2**',
    `Total pendaftar: ${entries.length}`,
    `Build: ${totals.build} | Mono Got Talent: ${totals.talent} | Film Pendek: ${totals.film}`,
    ''
  ];

  entries.forEach((entry, idx) => {
    lines.push(
      `${idx + 1}. <@${entry.userId}> | ${formatEventSelection(entry)} | daftar: ${formatDateId(entry.registeredAt)}`
    );
  });

  const chunks = splitIntoChunks(lines);
  for (let i = 0; i < chunks.length; i += 1) {
    if (i === 0) {
      await msg.reply(chunks[i]).catch(() => null);
      continue;
    }
    await msg.channel.send(chunks[i]).catch(() => null);
  }
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
  const { registrationChannelId, privateChatChannelId } = options;
  const content = (msg.content || '').trim();
  if (!/^!help\b/i.test(content)) return false;
  if (!msg.guild) return false;

  const registerHint = registrationChannelId ? `<#${registrationChannelId}>` : 'channel registrasi';
  const privateChatHint = privateChatChannelId ? `<#${privateChatChannelId}>` : 'channel private chat';
  const lines = [
    '**Panduan Singkat**',
    `- Daftar private: kirim \`!daftar\` di ${registerHint}.`,
    '- Cek status pendaftaran private: `!status`.',
    `- Daftar MonoDeco Event 2: \`!reg\` di ${registerHint}.`,
    '- Cek event: `!reg-status`.',
    '- Batalkan event: `!reg-cancel`.',
    '- Rekap event (admin): `!reg-list`.',
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
  privateChatChannelId = PRIVATE_CHAT_CHANNEL_ID
}) {
  return async function handleRegisterMessage(msg) {
    try {
      if (!msg || msg.author?.bot) return false;
      if (!msg.guild) return false;

      const eventHandledList = await handleEventRegListCommand(msg, {
        registrationChannelId,
        eventRegistrationStore
      });
      if (eventHandledList) return true;

      const eventHandledStatus = await handleEventRegStatusCommand(msg, {
        registrationChannelId,
        eventRegistrationStore
      });
      if (eventHandledStatus) return true;

      const eventHandledCancel = await handleEventRegCancelCommand(msg, {
        registrationChannelId,
        eventRegistrationStore
      });
      if (eventHandledCancel) return true;

      const eventHandledReg = await handleEventRegCommand(msg, {
        registrationChannelId,
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

module.exports = { createRegisterHandler, createSubmissionReactionHandler, scanSubmissionApprovals };
