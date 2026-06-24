const { TOPUP_ADMIN_DISCORD_ID } = require('../config');

function isBridgeAdmin(userId) {
  return String(userId || '') === TOPUP_ADMIN_DISCORD_ID;
}

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseCommand(content) {
  const raw = normalizeSpaces(content);
  const match = raw.match(/^!(verifyme|mc-help|mcstatus|mcping|online|srcsrv|geon|player)(?:\s+(.+))?$/i);
  if (!match) return null;
  return {
    command: match[1].toLowerCase(),
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

function formatOnlinePlayer(player, index = 0) {
  const wallet = player.wallet
    ? ` | Geon=${formatNumber(player.wallet.geon)} | Ether=${formatNumber(player.wallet.ether)}`
    : '';
  const pid = player.persistentId ? ` | pid=${player.persistentId.slice(0, 10)}...` : '';
  return `${index + 1}. \`${player.name || player.key || '-'}\`${wallet}${pid}`;
}

function helpText() {
  return [
    '**Minecraft bridge commands**',
    '`!verifyme` - buat kode verify Minecraft untuk akun Discord kamu; kode lama otomatis batal',
    '`!mcstatus` - admin: cek status bridge rizebot/BP',
    '`!mcping` - admin: test BP polling job',
    '`!online` - admin: lihat player online dari server',
    '`!srcsrv <nama>` - admin: cari player dari data server Minecraft',
    '`!geon <nama>` - admin: cek saldo Geon/Ether player',
    '`!player <nama>` - admin: detail player dari server',
  ].join('\n');
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
      await replyNoPing(msg, helpText());
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
        [
          `Kode verify Minecraft untuk \`${challenge.gamertag}\`: \`${challenge.code}\``,
          `Masuk ke server sebagai \`${challenge.gamertag}\`, lalu ketik:`,
          `\`/secrules:verify ${challenge.code}\``,
          `Atau fallback chat: \`!verify ${challenge.code}\``,
          `Kode expired dalam ${challenge.expiresInMinutes} menit.`,
          'Jika kamu menjalankan `!verifyme` lagi, kode sebelumnya otomatis batal.',
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

    if (parsed.command === 'online') {
      const online = bridge.getOnlinePlayers();
      const lines = online.length
        ? online.slice(0, 30).map(formatOnlinePlayer).join('\n')
        : 'Tidak ada player online yang tercatat bridge.';
      await replyNoPing(msg, `Player online: ${online.length}\n${lines}`);
      return true;
    }

    if (parsed.command === 'srcsrv') {
      if (parsed.args.length < 2) {
        await replyNoPing(msg, 'Format: `!srcsrv <minimal 2 huruf nama player>`');
        return true;
      }
      const job = bridge.enqueueBridgeQuery('search_server', { query: parsed.args }, { message: msg });
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
