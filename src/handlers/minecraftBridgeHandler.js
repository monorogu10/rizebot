const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const {
  INTERVIEW_ADMIN_ROLE_IDS,
  LAW_ADMIN_ROLE_IDS,
  MINECRAFT_CHAT_LOG_CHANNEL_ID,
  MINECRAFT_REGISTER_RESET_ADMIN_ID,
  TOPUP_ADMIN_DISCORD_ID,
} = require('../config');
const { isAdmin } = require('../utils/permissions');
const {
  logCommandError,
  logCommandInfo,
  replyWithDiagnostics,
  sendCommandError,
} = require('../utils/commandDiagnostics');
const { createRizebotHelpPayload } = require('./helpPayload');

const ONLINE_PAGE_SIZE = 10;
const ONLINE_BUTTON_PREFIX = 'mconline';
const ONLINE_COLLECTOR_MS = 2 * 60 * 1000;
const DISCORD_BROADCAST_MAX_LENGTH = 240;
const GEON_TRANSFER_MAX = 100_000_000;
const LOADING_GIF_URL = 'https://media1.tenor.com/m/UnFx-k_lSckAAAAd/amalie-steiness.gif';

function isBridgeAdmin(userId) {
  return String(userId || '') === TOPUP_ADMIN_DISCORD_ID;
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
  if (Array.isArray(roles)) return roles.some(roleId => roleIds.has(String(roleId)));
  if (Array.isArray(member._roles)) return member._roles.some(roleId => roleIds.has(String(roleId)));
  if (roles instanceof Set) {
    for (const roleId of roleIds) {
      if (roles.has(roleId)) return true;
    }
  }
  return false;
}

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseCommand(content) {
  const raw = normalizeSpaces(content);
  const match = raw.match(/^!(verify|verifyme|verifme|veryfyme|mc-help|mcstatus|mcping|online|srcsrv|srcpl|geon|player|organisasi|organization|org|p|tf|transfer|bonus|migrasi|migration|migrate)(?:\s+(.+))?$/i);
  if (!match) return null;
  const command = match[1].toLowerCase();
  return {
    command: ['verify', 'verifme', 'veryfyme'].includes(command)
      ? 'verifyme'
      : (command === 'srcpl'
        ? 'srcsrv'
        : (['organization', 'org'].includes(command)
          ? 'organisasi'
          : (command === 'transfer' ? 'tf' : (['migration', 'migrate'].includes(command) ? 'migrasi' : command)))),
    args: normalizeSpaces(match[2] || ''),
  };
}

function stripWrappingQuotes(value) {
  const text = normalizeSpaces(value);
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`')) {
      return normalizeSpaces(text.slice(1, -1));
    }
  }
  return text;
}

function parseQuotedMigrationArgs(args) {
  const values = [];
  const re = /"([^"]+)"|'([^']+)'|`([^`]+)`/g;
  let match = re.exec(args);
  while (match) {
    values.push(normalizeSpaces(match[1] || match[2] || match[3] || ''));
    match = re.exec(args);
  }
  if (values.length < 2) return null;
  return { oldName: values[0], newName: values[1] };
}

function parseMigrationArgs(args) {
  const raw = normalizeSpaces(args);
  if (!raw) return null;

  const separated = raw.match(/^(.+?)\s*(?:->|=>|\|)\s*(.+)$/);
  if (separated) {
    const oldName = stripWrappingQuotes(separated[1]);
    const newName = stripWrappingQuotes(separated[2]);
    return oldName && newName ? { oldName, newName } : null;
  }

  const quoted = parseQuotedMigrationArgs(raw);
  if (quoted?.oldName && quoted?.newName) return quoted;

  const parts = raw.split(/\s+/g).filter(Boolean);
  if (parts.length < 2) return null;
  return {
    oldName: stripWrappingQuotes(parts[0]),
    newName: stripWrappingQuotes(parts.slice(1).join(' ')),
  };
}

function isMinecraftAdmin(msg) {
  const userId = String(msg?.author?.id || '').trim();
  return isAdmin(msg?.member) ||
    isBridgeAdmin(userId) ||
    userId === String(MINECRAFT_REGISTER_RESET_ADMIN_ID);
}

function noPing(payload) {
  if (typeof payload === 'string') {
    return { content: payload, allowedMentions: { parse: [], repliedUser: false } };
  }
  return {
    ...payload,
    allowedMentions: payload.allowedMentions || { parse: [], repliedUser: false },
  };
}

async function replyNoPing(msg, payload, diagnostics = {}) {
  const parsed = parseCommand(msg?.content);
  return replyWithDiagnostics(msg, noPing(payload), {
    scope: 'minecraft-bridge-command',
    command: diagnostics.command || (parsed ? `!${parsed.command}` : String(msg?.content || '').split(/\s+/g)[0]),
    stage: diagnostics.stage || 'mengirim balasan command bridge',
  });
}

function formatNumber(value) {
  const number = Math.max(0, Math.floor(Number(value) || 0));
  return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function buildCommandEmbed({ color = 0x2f80ed, title, description, footer = '' }) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp(new Date());
  if (footer) embed.setFooter({ text: footer });
  return noPing({ embeds: [embed] });
}

function buildQueuedBridgePayload({ title, description, job }) {
  return buildLoadingPayload({
    title,
    description,
    footer: `Diproses oleh Minecraft BP | Ref ${job?.id || '-'}`,
  });
}

function buildFormatErrorPayload(format) {
  return buildCommandEmbed({
    color: 0xe74c3c,
    title: 'Format Command',
    description: `Format: \`${format}\``,
  });
}

function cleanDiscordBroadcastMessage(value) {
  return normalizeSpaces(value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, DISCORD_BROADCAST_MAX_LENGTH)
    .trim();
}

function isRegisteredOnlinePlayer(player) {
  return Boolean(player?.discordUserId);
}

function sortOnlinePlayers(players = []) {
  return [...players].sort((a, b) => {
    const leftRegistered = isRegisteredOnlinePlayer(a) ? 0 : 1;
    const rightRegistered = isRegisteredOnlinePlayer(b) ? 0 : 1;
    if (leftRegistered !== rightRegistered) return leftRegistered - rightRegistered;
    return String(a.name || a.key || '').localeCompare(String(b.name || b.key || ''));
  });
}

function onlineStatusIcon(player) {
  if (player?.discordUserId && (player?.verified || player?.registeredMatch || player?.accessAllowed)) return '✅';
  if (player?.discordUserId) return '🟢';
  return '❌';
}

function discordLine(player) {
  if (!player?.discordUserId) return 'Discord: -';
  return `Discord: <@${player.discordUserId}> (${player.discordUserId})`;
}

function formatOnlinePlayer(player, index = 0) {
  const wallet = player.wallet
    ? ` | Geon=${formatNumber(player.wallet.geon)} | Ether=${formatNumber(player.wallet.ether)}`
    : '';
  const pid = player.persistentId ? ` | pid=${player.persistentId.slice(0, 10)}...` : '';
  const status = player.verified
    ? 'verified'
    : (player.discordUserId ? ((player.registeredMatch || player.accessAllowed) ? 'resmi' : 'terdaftar') : 'belum register');
  return `${index + 1}. ${onlineStatusIcon(player)} \`${player.name || player.key || '-'}\` | ${status} | ${discordLine(player)}${wallet}${pid}`;
}

function paginateItems(items, page, pageSize = ONLINE_PAGE_SIZE) {
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(Math.max(Number(page) || 1, 1), totalPages);
  const startIndex = (safePage - 1) * pageSize;
  return {
    page: safePage,
    totalPages,
    totalItems,
    startIndex,
    items: items.slice(startIndex, startIndex + pageSize),
  };
}

function buildOnlineButtonId(sourceMessageId, page) {
  return `${ONLINE_BUTTON_PREFIX}:${sourceMessageId}:${page}`;
}

function parseOnlineButtonId(customId, sourceMessageId) {
  const raw = String(customId || '');
  const prefix = `${ONLINE_BUTTON_PREFIX}:${sourceMessageId}:`;
  if (!raw.startsWith(prefix)) return null;
  const page = Number.parseInt(raw.slice(prefix.length), 10);
  if (!Number.isFinite(page) || page < 1) return null;
  return { page };
}

function buildOnlineButtons(sourceMessageId, page, totalPages, disabled = false) {
  const prevPage = Math.max(1, page - 1);
  const nextPage = Math.min(totalPages, page + 1);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildOnlineButtonId(sourceMessageId, prevPage))
      .setLabel('Sebelumnya')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || page <= 1),
    new ButtonBuilder()
      .setCustomId(buildOnlineButtonId(sourceMessageId, nextPage))
      .setLabel('Berikutnya')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled || page >= totalPages)
  );
}

function buildOnlineEmbed(onlinePlayers, pagination, createdAt = new Date()) {
  const registered = pagination.items.filter(isRegisteredOnlinePlayer);
  const unregistered = pagination.items.filter(player => !isRegisteredOnlinePlayer(player));
  const linesRegistered = registered.map((player, idx) => (
    formatOnlinePlayer(player, pagination.startIndex + idx)
  ));
  const linesUnregistered = unregistered.map((player, idx) => (
    formatOnlinePlayer(player, pagination.startIndex + registered.length + idx)
  ));
  const totalRegistered = onlinePlayers.filter(isRegisteredOnlinePlayer).length;
  const totalUnregistered = Math.max(0, onlinePlayers.length - totalRegistered);
  const description = [
    linesRegistered.length ? `✅ **Terdaftar Discord (${formatNumber(totalRegistered)})**\n${linesRegistered.join('\n')}` : '',
    linesUnregistered.length ? `⚠️ **Belum register Discord (${formatNumber(totalUnregistered)})**\n${linesUnregistered.join('\n')}` : '',
  ].filter(Boolean).join('\n\n') || 'Tidak ada player online yang tercatat bridge.';

  const embed = new EmbedBuilder()
    .setColor(0x2f80ed)
    .setTitle(`Player Online: ${formatNumber(pagination.totalItems)} | Terdaftar: ${formatNumber(totalRegistered)} | Belum: ${formatNumber(totalUnregistered)}`)
    .setDescription(description)
    .setFooter({
      text: `Halaman ${pagination.page}/${pagination.totalPages} | Snapshot bridge`
    })
    .setTimestamp(createdAt);

  return embed;
}

function buildOnlineResponse(onlinePlayers, sourceMessageId, page, options = {}) {
  const sortedPlayers = sortOnlinePlayers(onlinePlayers);
  const pagination = paginateItems(sortedPlayers, page);
  const components = pagination.totalPages > 1
    ? [buildOnlineButtons(sourceMessageId, pagination.page, pagination.totalPages, options.disabled)]
    : [];
  return noPing({
    embeds: [buildOnlineEmbed(sortedPlayers, pagination, options.createdAt)],
    components,
  });
}

async function sendOnlinePagination(msg, onlinePlayers) {
  const createdAt = new Date();
  const sourceMessageId = msg.id;
  let currentPage = 1;
  const reply = await replyNoPing(msg, buildOnlineResponse(onlinePlayers, sourceMessageId, 1, { createdAt }));
  if (!reply?.createMessageComponentCollector) return;

  const collector = reply.createMessageComponentCollector({
    time: ONLINE_COLLECTOR_MS,
    filter: interaction => Boolean(parseOnlineButtonId(interaction.customId, sourceMessageId)),
  });

  collector.on('collect', async interaction => {
    if (String(interaction.user?.id || '') !== String(msg.author?.id || '')) {
      await interaction.reply({
        content: 'Pagination ini hanya untuk admin yang menjalankan `!online`.',
        ephemeral: true,
      }).catch(() => {});
      return;
    }

    const parsed = parseOnlineButtonId(interaction.customId, sourceMessageId);
    if (!parsed) return;
    currentPage = parsed.page;
    await interaction.update(
      buildOnlineResponse(onlinePlayers, sourceMessageId, parsed.page, { createdAt })
    ).catch(() => {});
  });

  collector.on('end', async () => {
    await reply.edit(
      buildOnlineResponse(onlinePlayers, sourceMessageId, currentPage, { createdAt, disabled: true })
    ).catch(() => {});
  });
}

function timeOrDash(value) {
  return value ? String(value) : '-';
}

function formatBridgeStatus(status) {
  const jobs = status.jobs || {};
  return [
    '**Minecraft bridge status**',
    `Job poll terakhir: ${timeOrDash(status.lastJobPollAt)}`,
    `Job hasil terakhir: ${timeOrDash(status.lastResultAt)}`,
    `Event terakhir: ${timeOrDash(status.lastEventAt)} (${status.lastEventType || '-'})`,
    `Snapshot terakhir: ${timeOrDash(status.lastSnapshotAt)} | online=${formatNumber(status.lastSnapshotOnline || 0)}`,
    `Chat terakhir: ${timeOrDash(status.lastChatAt)}`,
    `Transparansi terakhir: ${timeOrDash(status.lastTransparencyAt)}`,
    `Join/leave terakhir: ${timeOrDash(status.lastPresenceAt)}`,
    `Verify terakhir: ${timeOrDash(status.lastVerifyAt)}`,
    `Cache online: ${formatNumber(status.onlineCount || 0)}`,
    `Job queue: queued=${formatNumber(jobs.queued || 0)} leased=${formatNumber(jobs.leased || 0)} done=${formatNumber(jobs.done || 0)}`,
    `Pending verify: ${formatNumber(status.pendingVerifyCount || 0)}`,
  ].join('\n');
}

function createMinecraftBridgeHandler({ bridge, registerStore }) {
  return async function handleMinecraftBridgeCommand(msg) {
    if (!msg || msg.author?.bot) return false;

    const parsed = parseCommand(msg.content);
    if (!parsed) return false;

    if (parsed.command === 'mc-help') {
      const userId = String(msg.author?.id || '').trim();
      const moderationAdmin = isAdmin(msg.member);
      const bridgeAdmin = isBridgeAdmin(userId);
      const registerAdmin = moderationAdmin ||
        bridgeAdmin ||
        userId === String(MINECRAFT_REGISTER_RESET_ADMIN_ID);
      const interviewAdmin = registerAdmin || memberHasAnyRole(msg.member, INTERVIEW_ADMIN_ROLE_IDS);
      await replyNoPing(msg, createRizebotHelpPayload({
        showRegisterAdmin: registerAdmin,
        showInterviewAdmin: interviewAdmin,
        showBridgeAdmin: bridgeAdmin,
        showTopupAdmin: bridgeAdmin,
        showModerationAdmin: moderationAdmin,
        showLawAdmin: registerAdmin || interviewAdmin || bridgeAdmin || moderationAdmin || memberHasAnyRole(msg.member, LAW_ADMIN_ROLE_IDS),
      }));
      return true;
    }

    if (parsed.command === 'verifyme') {
      const entry = registerStore.getUser(msg.author.id);
      if (!entry?.gamertag) {
        await replyNoPing(msg, 'Kamu belum punya data Minecraft. Pakai `!reg <gamertag_minecraft>` dulu.');
        return true;
      }

      const challenge = bridge.createVerification({
        userId: msg.author.id,
        gamertag: entry.gamertag,
        message: msg,
      });
      if (!challenge) {
        await replyNoPing(msg, 'Gagal membuat kode verify. Coba lagi sebentar.');
        return true;
      }

      await replyNoPing(
        msg,
        challenge.reused
          ? [
            `Kode verify Minecraft kamu masih aktif untuk \`${challenge.gamertag}\`: \`${challenge.code}\``,
            `Di chat Minecraft ketik: \`!verify ${challenge.code}\``,
            `Expired sekitar ${challenge.expiresInMinutes} menit lagi.`,
          ].join('\n')
          : [
            `Kode verify Minecraft untuk \`${challenge.gamertag}\`: \`${challenge.code}\``,
            `Masuk ke server sebagai \`${challenge.gamertag}\`, lalu di chat Minecraft ketik:`,
            `\`!verify ${challenge.code}\``,
            `Kode expired dalam ${challenge.expiresInMinutes} menit.`,
            'Jika kamu menjalankan `!verify` lagi, kode yang sama akan dipakai selama masih aktif.',
          ].join('\n')
      );
      return true;
    }

    if (parsed.command === 'player') {
      if (parsed.args.length < 2) {
        await replyNoPing(msg, buildFormatErrorPayload('!player <nama_player>'));
        return true;
      }
      await enqueueBridgeJobWithLoading(msg, bridge, 'player_info', {
        query: parsed.args,
        requestedBy: msg.author.id,
      }, {
        title: 'Cek Data Player',
        description: `Mencari player yang mendekati \`${parsed.args}\`.`,
      });
      return true;
    }

    if (parsed.command === 'organisasi') {
      const jobType = parsed.args ? 'organization_info' : 'organization_search';
      await enqueueBridgeJobWithLoading(msg, bridge, jobType, {
        query: parsed.args,
        limit: parsed.args ? 5 : 50,
        requestedBy: msg.author.id,
      }, {
        title: parsed.args ? 'Cek Detail Organisasi' : 'Daftar Organisasi & Perusahaan',
        description: parsed.args
          ? `Mencari organisasi/perusahaan yang mendekati \`${parsed.args}\`.`
          : 'Mengambil daftar organisasi/perusahaan berdasarkan kas Geon terbesar.',
      });
      return true;
    }

    if (parsed.command === 'tf') {
      const transfer = parseGeonTransferArgs(parsed.args, bridge);
      if (!transfer) {
        await replyNoPing(msg, buildFormatErrorPayload('!tf <nama_player/mention> <jumlah_geon> [alasan opsional]'));
        return true;
      }

      const entry = registerStore.getUser(msg.author.id);
      if (!isApprovedRegisterEntry(entry) || !entry?.gamertag) {
        await replyNoPing(msg, buildCommandEmbed({
          color: 0xe74c3c,
          title: 'Transfer Ditolak',
          description: 'Akun Discord kamu harus sudah legal/approved dan punya gamertag Minecraft untuk mengirim Geon.',
        }));
        return true;
      }

      let targetQuery = transfer.target;
      if (transfer.discordUserId) {
        const linkedTarget = registerStore.getUser(transfer.discordUserId);
        if (!isApprovedRegisterEntry(linkedTarget) || !linkedTarget?.gamertag) {
          await replyNoPing(msg, buildCommandEmbed({
            color: 0xe74c3c,
            title: 'Target Discord Tidak Terhubung',
            description: 'User Discord yang disebut belum approved/legal atau belum memiliki gamertag Minecraft.',
          }));
          return true;
        }
        targetQuery = linkedTarget.gamertag;
      }

      await enqueueBridgeJobWithLoading(msg, bridge, 'wallet_transfer', {
        fromKey: entry.gamertag,
        fromName: entry.gamertag,
        fromDiscordUserId: msg.author.id,
        fromDiscordTag: msg.author?.tag || msg.author?.username || '',
        targetQuery,
        amount: transfer.amount,
        reason: transfer.reason,
        requestedBy: msg.author.id,
      }, {
        title: 'Transfer Geon',
        description: [
          `Mengirim **${bridge.formatNumber(transfer.amount)} Geon** dari \`${entry.gamertag}\` ke player yang mendekati \`${targetQuery}\`.`,
          transfer.reason ? `Alasan: \`${transfer.reason}\`` : '',
        ].filter(Boolean).join('\n'),
      });
      return true;
    }

    if (parsed.command === 'bonus') {
      if (!isBridgeAdmin(msg.author?.id)) {
        await replyNoPing(msg, buildCommandEmbed({
          color: 0xe74c3c,
          title: 'Command Admin Utama',
          description: 'Command `!bonus` khusus admin utama.',
        }));
        return true;
      }

      const bonus = parseGeonTransferArgs(parsed.args, bridge);
      if (!bonus) {
        await replyNoPing(msg, buildFormatErrorPayload('!bonus <nama_player> <jumlah_geon>'));
        return true;
      }

      await enqueueBridgeJobWithLoading(msg, bridge, 'wallet_bonus', {
        targetQuery: bonus.target,
        amount: bonus.amount,
        requestedBy: msg.author.id,
        requestedByTag: msg.author?.tag || msg.author?.username || '',
      }, {
        title: 'Bonus Geon',
        description: `Memberikan bonus **${bridge.formatNumber(bonus.amount)} Geon** ke player yang mendekati \`${bonus.target}\`.`,
      });
      return true;
    }

    if (parsed.command === 'migrasi') {
      if (!isMinecraftAdmin(msg)) {
        await replyNoPing(msg, buildCommandEmbed({
          color: 0xe74c3c,
          title: 'Command Admin',
          description: 'Command `!migrasi` khusus admin.',
        }));
        return true;
      }

      const migration = parseMigrationArgs(parsed.args);
      if (!migration) {
        await replyNoPing(msg, buildCommandEmbed({
          color: 0xe74c3c,
          title: 'Format Migrasi',
          description: [
            'Format: `!migrasi <nama_lama> -> <nama_baru>`',
            'Alternatif: `!migrasi "Nama Lama" "Nama Baru"`',
            'Untuk nama tanpa spasi: `!migrasi Lama Baru`.',
          ].join('\n'),
        }));
        return true;
      }

      await enqueueBridgeJobWithLoading(msg, bridge, 'player_migration_preview', {
        oldQuery: migration.oldName,
        newName: migration.newName,
        requestedBy: msg.author.id,
        requestedByTag: msg.author?.tag || msg.author?.username || '',
      }, {
        title: 'Preview Migrasi Player',
        description: `Mencari data lama yang mendekati \`${migration.oldName}\`, untuk dipindah ke \`${migration.newName}\`.`,
      });
      return true;
    }

    if (!isBridgeAdmin(msg.author?.id)) {
      await replyNoPing(msg, buildCommandEmbed({
        color: 0xe74c3c,
        title: 'Command Admin',
        description: 'Command Minecraft admin hanya untuk admin.',
      }));
      return true;
    }

    if (parsed.command === 'mcstatus') {
      await replyNoPing(msg, formatBridgeStatus(bridge.getBridgeStatus()));
      return true;
    }

    if (parsed.command === 'mcping') {
      await enqueueBridgeJobWithLoading(msg, bridge, 'ping', { requestedBy: msg.author.id }, {
        title: 'Ping Minecraft BP',
        description: 'Mengecek koneksi bridge Minecraft BP.',
      });
      return true;
    }

    if (parsed.command === 'p') {
      if (String(msg.channelId || msg.channel?.id || '') !== MINECRAFT_CHAT_LOG_CHANNEL_ID) {
        await replyNoPing(msg, `Command \`!p\` hanya dipakai di channel chat log Minecraft: <#${MINECRAFT_CHAT_LOG_CHANNEL_ID}>.`);
        return true;
      }

      const text = cleanDiscordBroadcastMessage(parsed.args);
      if (!text) {
        await replyNoPing(msg, 'Format: `!p <pesan chat>`');
        return true;
      }

      await enqueueBridgeJobWithLoading(msg, bridge, 'discord_broadcast', {
        text,
        requestedBy: msg.author.id,
        requestedByTag: msg.author?.tag || msg.author?.username || '',
      }, {
        title: 'Kirim Chat ke Minecraft',
        description: `Mengirim pesan ke Minecraft: \`${text}\``,
      });
      return true;
    }

    if (parsed.command === 'online') {
      const online = bridge.getOnlinePlayers();
      await sendOnlinePagination(msg, online);
      return true;
    }

    if (parsed.command === 'srcsrv') {
      if (parsed.args.length < 2) {
        await replyNoPing(msg, 'Format: `!srcpl <minimal 2 huruf nama player>`');
        return true;
      }
      await enqueueBridgeJobWithLoading(msg, bridge, 'search_server', {
        query: parsed.args,
        requestedBy: msg.author.id,
      }, {
        title: 'Search Player Server',
        description: `Mencari player yang mendekati \`${parsed.args}\`.`,
      });
      return true;
    }

    if (parsed.command === 'geon') {
      if (parsed.args.length < 2) {
        await replyNoPing(msg, 'Format: `!geon <nama_player>`');
        return true;
      }
      await enqueueBridgeJobWithLoading(msg, bridge, 'wallet', {
        query: parsed.args,
        requestedBy: msg.author.id,
      }, {
        title: 'Cek Saldo Player',
        description: `Mengambil saldo player yang mendekati \`${parsed.args}\`.`,
      });
      return true;
    }

    return false;
  };
}

function parseGeonTransferArgs(args, bridge) {
  const raw = normalizeSpaces(args);
  if (!raw) return null;

  const amountFromToken = token => {
    if (!/^\d[\d.,_]*$/.test(String(token || ''))) return null;
    return bridge.normalizePositiveInt(token, GEON_TRANSFER_MAX);
  };

  const mention = raw.match(/^<@!?(\d{5,30})>\s+(\S+)(?:\s+(.+))?$/);
  if (mention) {
    const amount = amountFromToken(mention[2]);
    if (!amount) return null;
    return {
      target: `<@${mention[1]}>`,
      discordUserId: mention[1],
      amount,
      reason: normalizeSpaces(mention[3] || '').slice(0, 180),
    };
  }

  const quoted = raw.match(/^(?:"([^"]+)"|'([^']+)'|`([^`]+)`)\s+(\S+)(?:\s+(.+))?$/);
  if (quoted) {
    const amount = amountFromToken(quoted[4]);
    const target = normalizeSpaces(quoted[1] || quoted[2] || quoted[3] || '');
    if (!target || !amount) return null;
    return { target, amount, reason: normalizeSpaces(quoted[5] || '').slice(0, 180) };
  }

  const parts = raw.split(' ').filter(Boolean);
  const amountIndex = parts.findIndex((part, index) => index > 0 && amountFromToken(part));
  if (amountIndex < 1) return null;
  const amount = amountFromToken(parts[amountIndex]);
  const target = normalizeSpaces(parts.slice(0, amountIndex).join(' '));
  const reason = normalizeSpaces(parts.slice(amountIndex + 1).join(' ')).slice(0, 180);
  if (!target || !amount) return null;
  return { target, amount, reason };
}

function isApprovedRegisterEntry(entry) {
  const status = String(entry?.status || '').toLowerCase();
  return Boolean(entry?.legal === true || status === 'approved');
}

function loadingMessageRef(message) {
  if (!message?.id) return null;
  return {
    channelId: String(message.channelId || message.channel?.id || ''),
    messageId: String(message.id || ''),
  };
}

function buildLoadingPayload({ title, description, footer = 'Sedang diproses oleh Minecraft BP.' }) {
  const embed = new EmbedBuilder()
    .setColor(0x2f80ed)
    .setTitle(title || 'Loading')
    .setDescription(description || 'Sedang diproses...')
    .setImage(LOADING_GIF_URL)
    .setFooter({ text: footer })
    .setTimestamp(new Date());
  return noPing({ embeds: [embed] });
}

async function sendBridgeLoading(msg, options) {
  return replyNoPing(msg, buildLoadingPayload(options), {
    stage: 'mengirim pesan loading command bridge',
  });
}

function bridgeJobContext(msg, loadingMessage, extra = {}) {
  return {
    ...extra,
    message: msg,
    messageRef: loadingMessageRef(msg),
    loadingMessage: loadingMessageRef(loadingMessage),
  };
}

async function enqueueBridgeJobWithLoading(msg, bridge, type, payload, {
  title,
  description,
  context = {},
} = {}) {
  const loading = await sendBridgeLoading(msg, {
    title,
    description,
    footer: 'Menunggu Minecraft BP...',
  });
  if (!loading) return null;

  let job = null;
  try {
    job = bridge.enqueueBridgeQuery(type, payload, bridgeJobContext(msg, loading, context));
  } catch (err) {
    logCommandError('minecraft-bridge-command', msg, err, {
      command: `!${parseCommand(msg?.content)?.command || type}`,
      stage: `membuat job bridge ${type}`,
    });
    await sendCommandError(msg, {
      scope: 'minecraft-bridge-command',
      command: `!${parseCommand(msg?.content)?.command || type}`,
      stage: `membuat job bridge ${type}`,
      error: err,
    });
    return null;
  }
  if (loading?.edit) {
    await loading.edit(buildQueuedBridgePayload({ title, description, job })).catch(err => {
      logCommandError('minecraft-bridge-command', msg, err, {
        command: `!${parseCommand(msg?.content)?.command || type}`,
        stage: `memperbarui status job bridge ${type}`,
        details: { jobId: job?.id || '-' },
      });
    });
  }
  logCommandInfo('minecraft-bridge-command', msg, {
    command: `!${parseCommand(msg?.content)?.command || type}`,
    stage: `job bridge ${type} masuk antrean`,
    details: { jobId: job?.id || '-' },
  });
  return job;
}

module.exports = { createMinecraftBridgeHandler };
