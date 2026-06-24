const crypto = require('node:crypto');

const JOB_LEASE_MS = 20 * 1000;
const JOB_TTL_MS = 10 * 60 * 1000;
const JOB_LIMIT = 100;

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
  };
}

function createTopupBridgeService({ registerStore }) {
  const jobs = new Map();

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

  function takeJobs(limitRaw = 3) {
    pruneJobs();
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

  async function completeJob(resultRaw = {}) {
    const jobId = String(resultRaw.jobId || '');
    const record = jobs.get(jobId);
    if (!record) return { ok: false, code: 'job-not-found' };

    record.status = 'done';
    record.updatedAt = Date.now();
    record.result = resultRaw;

    try {
      if (record.job.type === 'coupon') {
        await sendCouponResult(record, resultRaw);
      } else if (record.job.type === 'topup') {
        await sendTopupResult(record, resultRaw);
      }
    } catch (err) {
      console.error('Failed to send topup bridge result:', err);
    }

    pruneJobs();
    return { ok: true };
  }

  return {
    normalizePositiveInt,
    formatNumber,
    rupiahText,
    searchTargets,
    resolveTarget,
    enqueueTopup,
    enqueueCoupon,
    takeJobs,
    completeJob,
  };
}

module.exports = { createTopupBridgeService };

