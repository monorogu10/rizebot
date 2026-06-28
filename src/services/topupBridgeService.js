const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EmbedBuilder } = require('discord.js');
const {
  MINECRAFT_CHAT_LOG_CHANNEL_ID,
  MINECRAFT_REGISTER_PENDING_ROLE_ID,
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
  return clean.join(' • ').slice(0, 2048) || formatJakartaTime();
}

function createLogEmbed({ color, title, description, footerParts = [], thumbnailUrl = '', fields = [] }) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(cleanText(title, 256) || 'Minecraft Log')
    .setDescription(cleanEmbedText(description))
    .setFooter({ text: compactFooter([`🕒 ${formatJakartaTime()}`, ...footerParts]) });

  const thumbnail = String(thumbnailUrl || '').trim();
  if (thumbnail) {
    embed.setThumbnail(thumbnail);
  }

  const safeFields = fields
    .map(field => ({
      name: cleanText(field.name, 256),
      value: cleanEmbedText(field.value, 1024),
      inline: field.inline !== false,
    }))
    .filter(field => field.name && field.value);

  if (safeFields.length) embed.addFields(safeFields.slice(0, 25));
  return embed;
}

function isVerifiedMinecraftLink(linked, player = {}) {
  if (!linked?.entry?.verified) return false;
  const playerName = n(player.name);
  const playerPersistentId = String(player.persistentId || '').trim();
  const entry = linked.entry;
  if (playerPersistentId && entry.persistentId === playerPersistentId) return true;
  return Boolean(playerName && n(entry.gamertag) === playerName);
}

function isRegisteredMinecraftLink(linked, player = {}) {
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
    return {
      name: cleanText(player.name, 80),
      key: cleanText(player.key || player.name, 80).toLowerCase(),
      persistentId: cleanText(player.persistentId, 160),
      rank: cleanText(player.rank || '', 180),
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
      return added && removedPending;
    }

    return false;
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

  function enqueueTopup({ target, geon, rupiah, requestedBy, message, source = '', paymentId = '' }) {
    return enqueueJob('topup', {
      targetKey: target.gamertag,
      targetName: target.gamertag,
      discordUserId: target.userId,
      geon,
      rupiah,
      requestedBy,
      source,
      paymentId,
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
      .setFooter({ text: paymentId ? `Payment ${paymentId}` : `Job ${record.job?.id || record.id || '-'}` })
      .setTimestamp();

    const avatarUrl = discordAvatarUrl(user);
    if (avatarUrl) embed.setThumbnail(avatarUrl);

    await channel.send({
      embeds: [embed],
      allowedMentions: { parse: [] },
    });
    return true;
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
      await message.reply(`Data player gagal: \`${result.code || 'unknown'}\`.`).catch(() => {});
      return;
    }

    const target = result.target || {};
    const wallet = result.wallet || {};
    const registered = target.persistentId
      ? registerStore.findUserByPersistentId?.(target.persistentId)
      : registerStore.findUserByGamertag?.(target.name || target.key);
    const registerLine = registered
      ? `Discord: <@${registered.userId}> | ${registered.entry?.verified ? 'verified' : 'terdaftar'}`
      : 'Discord: belum register';

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

  async function sendQueryResult(record, result) {
    if (record.job.type === 'wallet') {
      await sendWalletResult(record, result);
    } else if (record.job.type === 'search_server') {
      await sendSearchServerResult(record, result);
    } else if (record.job.type === 'player_info') {
      await sendPlayerInfoResult(record, result);
    } else if (record.job.type === 'ping') {
      await sendPingResult(record, result);
    } else if (record.job.type === 'discord_broadcast') {
      await sendDiscordBroadcastResult(record, result);
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

    const linked = findLinkedUserForPlayer(event);
    const user = await resolveDiscordUser(linked?.userId);
    const rank = cleanText(event.rank || 'Player', 180) || 'Player';
    const footerParts = [
      `💬 Rank: ${rank}`,
      linked?.userId ? `Discord ID: ${linked.userId}` : 'Discord: belum register',
    ];

    await channel.send({
      embeds: [createLogEmbed({
        color: EMBED_COLOR_CHAT,
        title: name,
        description: message,
        footerParts,
        thumbnailUrl: discordAvatarUrl(user),
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
        title: `📣 Transparansi: ${label || category || 'unknown'}`,
        description: message,
        footerParts: [`Kategori: ${category}`],
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
    const user = await resolveDiscordUser(linked?.userId);
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
        thumbnailUrl: discordAvatarUrl(user),
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
      const registeredMatch = Boolean(
        linkedByGamertag?.entry?.gamertag &&
        n(linkedByGamertag.entry.gamertag) === n(player?.name)
      );
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
