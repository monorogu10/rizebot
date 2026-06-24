const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const {
  MINECRAFT_CHAT_LOG_CHANNEL_ID,
  MINECRAFT_REGISTER_RESET_ADMIN_ID,
  TOPUP_ADMIN_DISCORD_ID,
} = require('../config');
const { isAdmin } = require('../utils/permissions');
const { createRizebotHelpPayload } = require('./helpPayload');

const ONLINE_PAGE_SIZE = 10;
const ONLINE_BUTTON_PREFIX = 'mconline';
const ONLINE_COLLECTOR_MS = 2 * 60 * 1000;
const DISCORD_BROADCAST_MAX_LENGTH = 240;

function isBridgeAdmin(userId) {
  return String(userId || '') === TOPUP_ADMIN_DISCORD_ID;
}

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseCommand(content) {
  const raw = normalizeSpaces(content);
  const match = raw.match(/^!(verify|verifyme|verifme|veryfyme|mc-help|mcstatus|mcping|online|srcsrv|srcpl|geon|player|p)(?:\s+(.+))?$/i);
  if (!match) return null;
  const command = match[1].toLowerCase();
  return {
    command: ['verify', 'verifme', 'veryfyme'].includes(command)
      ? 'verifyme'
      : (command === 'srcpl' ? 'srcsrv' : command),
    args: normalizeSpaces(match[2] || ''),
  };
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

async function replyNoPing(msg, payload) {
  return msg.reply(noPing(payload)).catch(() => null);
}

function formatNumber(value) {
  const number = Math.max(0, Math.floor(Number(value) || 0));
  return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
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
  if (player?.verified && player?.discordUserId) return '✅';
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
    : (player.discordUserId ? 'terdaftar' : 'belum register');
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
      const showAdmin = isAdmin(msg.member) ||
        isBridgeAdmin(msg.author?.id) ||
        String(msg.author?.id || '') === String(MINECRAFT_REGISTER_RESET_ADMIN_ID);
      await replyNoPing(msg, createRizebotHelpPayload({ showAdmin }));
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

    if (!isBridgeAdmin(msg.author?.id)) {
      await replyNoPing(msg, 'Command Minecraft admin hanya untuk admin.');
      return true;
    }

    if (parsed.command === 'mcstatus') {
      await replyNoPing(msg, formatBridgeStatus(bridge.getBridgeStatus()));
      return true;
    }

    if (parsed.command === 'mcping') {
      const job = bridge.enqueueBridgeQuery('ping', { requestedBy: msg.author.id }, { message: msg });
      await replyNoPing(msg, `Ping BP masuk antrean. Job: \`${job.id}\``);
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

      const job = bridge.enqueueBridgeQuery('discord_broadcast', {
        text,
        requestedBy: msg.author.id,
        requestedByTag: msg.author?.tag || msg.author?.username || '',
      }, { message: msg });
      await replyNoPing(msg, `Pesan Discord masuk antrean Minecraft. Job: \`${job.id}\``);
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
      const job = bridge.enqueueBridgeQuery('search_server', {
        query: parsed.args,
        requestedBy: msg.author.id,
      }, { message: msg });
      await replyNoPing(msg, `Search server masuk antrean. Job: \`${job.id}\``);
      return true;
    }

    if (parsed.command === 'geon') {
      if (parsed.args.length < 2) {
        await replyNoPing(msg, 'Format: `!geon <nama_player>`');
        return true;
      }
      const job = bridge.enqueueBridgeQuery('wallet', { query: parsed.args }, { message: msg });
      await replyNoPing(msg, `Cek saldo masuk antrean. Job: \`${job.id}\``);
      return true;
    }

    if (parsed.command === 'player') {
      if (parsed.args.length < 2) {
        await replyNoPing(msg, 'Format: `!player <nama_player>`');
        return true;
      }
      const job = bridge.enqueueBridgeQuery('player_info', { query: parsed.args }, { message: msg });
      await replyNoPing(msg, `Cek data player masuk antrean. Job: \`${job.id}\``);
      return true;
    }

    return false;
  };
}

module.exports = { createMinecraftBridgeHandler };
