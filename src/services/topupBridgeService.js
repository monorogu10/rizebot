const crypto = require('node:crypto');
const { MINECRAFT_CHAT_LOG_CHANNEL_ID } = require('../config');

const JOB_LEASE_MS = 20 * 1000;
const JOB_TTL_MS = 10 * 60 * 1000;
const JOB_LIMIT = 100;
const VERIFY_CODE_TTL_MS = 10 * 60 * 1000;
const ONLINE_TTL_MS = 90 * 1000;

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
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
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

function formatTargetLine(target, index = 0) {
  const user = target.userId ? `<@${target.userId}>` : '-';
  const status = target.verified ? 'verified' : 'legacy';
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
  return `${index + 1}. \`${name}\` | ${online}${geon}${ether}${pid}`;
}

function createTopupBridgeService({ registerStore, client = null }) {
  const jobs = new Map();
  const pendingVerifications = new Map();
  const onlinePlayers = new Map();
  let chatChannelPromise = null;
  const bridgeStats = {
    lastJobPollAt: null,
    lastJobPollHadJobsAt: null,
    lastResultAt: null,
    lastEventAt: null,
    lastEventType: '',
    lastSnapshotAt: null,
    lastSnapshotOnline: 0,
    lastChatAt: null,
    lastVerifyAt: null,
  };

  function pruneJobs(now = Date.now()) {
    for (const [jobId, record] of jobs.entries()) {
      if (record.status === 'done' && now - record.updatedAt > JOB_TTL_MS) {
        jobs.delete(jobId);
      }
    }

    while (jobs.size > JOB_LIMIT) {
      const first = jobs.keys().next().value;
      if (!first) break;
      jobs.delete(first);
    }
  }

  function pruneVerifications(now = Date.now()) {
    for (const [code, record] of pendingVerifications.entries()) {
      if (record.expiresAt <= now) pendingVerifications.delete(code);
    }
  }

  function onlineKey(player) {
    return String(player?.persistentId || player?.key || player?.name || '').trim().toLowerCase();
  }

  function normalizeOnlinePlayer(player = {}, now = Date.now()) {
    return {
      name: cleanText(player.name, 80),
      key: cleanText(player.key || player.name, 80).toLowerCase(),
      persistentId: cleanText(player.persistentId, 160),
      online: player.online !== false,
      wallet: player.wallet && typeof player.wallet === 'object'
        ? {
          geon: Math.max(0, Math.floor(Number(player.wallet.geon) || 0)),
          ether: Math.max(0, Math.floor(Number(player.wallet.ether) || 0)),
        }
        : null,
      updatedAt: now,
    };
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
      .sort((a, b) => a.name.localeCompare(b.name));
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
    return job;
  }

  function enqueueTopup({ target, geon, rupiah, requestedBy, message }) {
    return enqueueJob('topup', {
      targetKey: target.gamertag,
      targetName: target.gamertag,
      discordUserId: target.userId,
      geon,
      rupiah,
      requestedBy,
    }, { message, target });
  }

  function enqueueCoupon({ geon, rupiah, count, days, requestedBy, message }) {
    return enqueueJob('coupon', {
      geon,
      rupiah,
      count,
      days,
      requestedBy,
    }, { message });
  }

  function enqueueBridgeQuery(type, payload, context) {
    return enqueueJob(type, payload, context);
  }

  function createVerification({ userId, gamertag, message }) {
    pruneVerifications();
    const safeUserId = String(userId || '');
    const safeGamertag = cleanText(gamertag, 80);
    if (!safeUserId || !safeGamertag) return null;

    for (const [code, record] of pendingVerifications.entries()) {
      if (record.userId === safeUserId) pendingVerifications.delete(code);
    }

    let code = createVerifyCode();
    while (pendingVerifications.has(code)) code = createVerifyCode();
    const expiresAt = Date.now() + VERIFY_CODE_TTL_MS;
    pendingVerifications.set(code, {
      code,
      userId: safeUserId,
      gamertag: safeGamertag,
      message,
      expiresAt,
      createdAt: Date.now(),
    });
    return {
      code,
      gamertag: safeGamertag,
      expiresAt,
      expiresInMinutes: Math.floor(VERIFY_CODE_TTL_MS / 60_000),
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
    }
    return result;
  }

  async function sendCouponResult(record, result) {
    const message = record.context?.message;
    if (!message) return;

    if (!result.ok) {
      await message.reply(`Generate kupon gagal: \`${result.code || 'unknown'}\``).catch(() => {});
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

    const dm = await message.author?.send(`\`\`\`\n${dmText}\n\`\`\``).catch(() => null);
    if (dm) {
      await message.reply(`Kupon berhasil dibuat dan sudah dikirim lewat DM. Jumlah: ${coupons.length}`).catch(() => {});
    } else {
      await message.reply(`Kupon berhasil dibuat:\n\`\`\`\n${dmText}\n\`\`\``).catch(() => {});
    }
  }

  async function sendTopupResult(record, result) {
    const message = record.context?.message;
    if (!message) return;

    const targetName = result.targetName || record.context?.target?.gamertag || record.job?.targetName || '-';
    const geon = result.geon || record.job?.geon || 0;
    const rupiah = result.rupiah || record.job?.rupiah || 0;
    if (result.ok) {
      await message.reply(
        `TOPUP sukses: \`${targetName}\` menerima **${formatNumber(geon)} Geon** (${rupiahText(rupiah)}).`
      ).catch(() => {});
    } else {
      await message.reply(
        `TOPUP gagal untuk \`${targetName}\`: \`${result.code || 'unknown'}\`.`
      ).catch(() => {});
    }
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
      ? ` | Discord: <@${registered.userId}> | ${registered.entry?.verified ? 'verified' : 'legacy'}`
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

    const targets = Array.isArray(result.targets) ? result.targets.slice(0, 15) : [];
    const lines = targets.length
      ? targets.map(formatServerTargetLine).join('\n')
      : 'Tidak ada hasil dari data server.';
    await message.reply(`Hasil server untuk \`${record.job.query || '-'}\`:\n${lines}`).catch(() => {});
  }

  async function sendPlayerInfoResult(record, result) {
    const message = record.context?.message;
    if (!message) return;

    if (!result.ok) {
      await message.reply(`Data player gagal: \`${result.code || 'unknown'}\`.`).catch(() => {});
      return;
    }

    const target = result.target || {};
    const wallet = result.wallet || {};
    const registered = target.persistentId
      ? registerStore.findUserByPersistentId?.(target.persistentId)
      : registerStore.findUserByGamertag?.(target.name || target.key);
    const registerLine = registered
      ? `Discord: <@${registered.userId}> | ${registered.entry?.verified ? 'verified' : 'legacy'}`
      : 'Discord: belum terhubung/terverifikasi';

    await message.reply([
      `Player: \`${target.name || target.key || '-'}\``,
      `Status: ${target.online ? 'online' : 'offline'}`,
      `Saldo: ${formatNumber(wallet.geon)} Geon | ${formatNumber(wallet.ether)} Ether`,
      registerLine,
      `persistentId: \`${target.persistentId || '-'}\``,
    ].join('\n')).catch(() => {});
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

  async function sendQueryResult(record, result) {
    if (record.job.type === 'wallet') {
      await sendWalletResult(record, result);
    } else if (record.job.type === 'search_server') {
      await sendSearchServerResult(record, result);
    } else if (record.job.type === 'player_info') {
      await sendPlayerInfoResult(record, result);
    } else if (record.job.type === 'ping') {
      await sendPingResult(record, result);
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

    try {
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

    await channel.send({
      content: `**[MC] ${name}:** ${message}`,
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
    if (!record) return { ok: false, code: 'verify-code-not-found' };
    if (record.expiresAt <= Date.now()) {
      pendingVerifications.delete(code);
      return { ok: false, code: 'verify-code-expired' };
    }

    const name = cleanText(event.name, 80);
    const persistentId = cleanText(event.persistentId, 160);
    if (!name || !persistentId) return { ok: false, code: 'invalid-player-identity' };
    if (n(name) !== n(record.gamertag)) {
      return {
        ok: false,
        code: 'gamertag-mismatch',
        expected: record.gamertag,
        actual: name,
      };
    }

    const existingPersistent = registerStore.findUserByPersistentId?.(persistentId);
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
    await record.message?.reply(
      `Verifikasi Minecraft berhasil: \`${name}\` sekarang linked dan verified.`
    ).catch(() => {});
    return { ok: true, code: 'ok', userId: record.userId, gamertag: name };
  }

  async function handleMinecraftEvent(eventRaw = {}) {
    const type = n(eventRaw.type);
    bridgeStats.lastEventAt = new Date().toISOString();
    bridgeStats.lastEventType = type;
    if (type === 'chat') {
      bridgeStats.lastChatAt = bridgeStats.lastEventAt;
      return sendChatLog(eventRaw);
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
      const linked = player?.persistentId
        ? registerStore.findUserByPersistentId?.(player.persistentId)
        : null;
      return {
        ok: true,
        verified: Boolean(linked?.entry?.verified),
        discordUserId: linked?.userId || '',
      };
    }
    if (type === 'player_leave') {
      forgetOnlinePlayer(eventRaw.player || eventRaw);
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
