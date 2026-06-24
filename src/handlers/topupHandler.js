const { TOPUP_ADMIN_DISCORD_ID } = require('../config');

const GEON_MAX = 100_000_000;
const RUPIAH_MAX = 2_000_000_000;
const COUPON_BATCH_MAX = 50;
const COUPON_EXPIRE_MAX_DAYS = 365;

function isTopupAdmin(userId) {
  return String(userId || '') === TOPUP_ADMIN_DISCORD_ID;
}

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseCommand(content) {
  const raw = normalizeSpaces(content);
  const match = raw.match(/^!(srcpl|searchpl|tu|topup|gnrtkpn|kupon|coupon|topup-help)(?:\s+(.+))?$/i);
  if (!match) return null;
  return {
    command: match[1].toLowerCase(),
    args: normalizeSpaces(match[2] || ''),
  };
}

function parseTopupArgs(args, bridge) {
  const parts = normalizeSpaces(args).split(' ').filter(Boolean);
  if (parts.length < 3) return null;

  const rupiah = bridge.normalizePositiveInt(parts.pop(), RUPIAH_MAX);
  const geon = bridge.normalizePositiveInt(parts.pop(), GEON_MAX);
  const target = normalizeSpaces(parts.join(' '));
  if (!target || !geon || !rupiah) return null;
  return { target, geon, rupiah };
}

function parseCouponArgs(args, bridge) {
  const parts = normalizeSpaces(args).split(' ').filter(Boolean);
  if (parts.length < 2) return null;

  const geon = bridge.normalizePositiveInt(parts[0], GEON_MAX);
  const rupiah = bridge.normalizePositiveInt(parts[1], RUPIAH_MAX);
  const count = bridge.normalizePositiveInt(parts[2] || '1', COUPON_BATCH_MAX);
  const days = bridge.normalizePositiveInt(parts[3] || '30', COUPON_EXPIRE_MAX_DAYS);
  if (!geon || !rupiah || !count || !days) return null;
  return { geon, rupiah, count, days };
}

function formatTarget(target) {
  const user = target.userId ? `<@${target.userId}>` : '-';
  const username = target.username ? ` | discord=${target.username}` : '';
  const status = target.verified ? 'verified' : 'legacy';
  return `\`${target.gamertag}\` | ${user} | ${status}${username}`;
}

function formatCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length < 1) return 'Tidak ada hasil.';
  return candidates.map((target, index) => `${index + 1}. ${formatTarget(target)}`).join('\n');
}

function helpText() {
  return [
    '**TOPUP admin commands**',
    '`!srcpl <nama>` - cari player dari data asli server Minecraft + status Discord',
    '`!tu <nama/key> <geon> <rupiah>` - kirim topup ke Minecraft',
    '`!gnrtkpn <geon> <rupiah> [jumlah] [hari_expired]` - generate kupon',
  ].join('\n');
}

function createTopupHandler({ bridge }) {
  return async function handleTopupCommand(msg) {
    if (!msg || msg.author?.bot) return false;

    const parsed = parseCommand(msg.content);
    if (!parsed) return false;

    if (!isTopupAdmin(msg.author?.id)) {
      await msg.reply('Command TOPUP hanya untuk admin.').catch(() => {});
      return true;
    }

    if (parsed.command === 'topup-help') {
      await msg.reply(helpText()).catch(() => {});
      return true;
    }

    if (parsed.command === 'srcpl' || parsed.command === 'searchpl') {
      if (parsed.args.length < 2) {
        await msg.reply('Format: `!srcpl <minimal 2 huruf nama player>`').catch(() => {});
        return true;
      }

      const job = bridge.enqueueBridgeQuery('search_server', {
        query: parsed.args,
        requestedBy: msg.author.id,
      }, { message: msg });
      await msg.reply(`Search player server masuk antrean. Job: \`${job.id}\``).catch(() => {});
      return true;
    }

    if (parsed.command === 'tu' || parsed.command === 'topup') {
      const topup = parseTopupArgs(parsed.args, bridge);
      if (!topup) {
        await msg.reply('Format: `!tu <nama/key> <geon> <rupiah>`').catch(() => {});
        return true;
      }

      const resolved = bridge.resolveTarget(topup.target);
      if (!resolved.ok) {
        await msg.reply(
          `Target tidak valid (${resolved.code}). Kandidat:\n${formatCandidates(resolved.candidates)}`
        ).catch(() => {});
        return true;
      }

      const job = bridge.enqueueTopup({
        target: resolved.target,
        geon: topup.geon,
        rupiah: topup.rupiah,
        requestedBy: msg.author.id,
        message: msg,
      });

      await msg.reply(
        `TOPUP masuk antrean: \`${resolved.target.gamertag}\` +${bridge.formatNumber(topup.geon)} Geon (${bridge.rupiahText(topup.rupiah)}). Job: \`${job.id}\``
      ).catch(() => {});
      return true;
    }

    if (parsed.command === 'gnrtkpn' || parsed.command === 'kupon' || parsed.command === 'coupon') {
      const coupon = parseCouponArgs(parsed.args, bridge);
      if (!coupon) {
        await msg.reply('Format: `!gnrtkpn <geon> <rupiah> [jumlah] [hari_expired]`').catch(() => {});
        return true;
      }

      const job = bridge.enqueueCoupon({
        ...coupon,
        requestedBy: msg.author.id,
        message: msg,
      });

      await msg.reply(
        `Generate kupon masuk antrean: ${coupon.count} kupon, ${bridge.formatNumber(coupon.geon)} Geon, ${bridge.rupiahText(coupon.rupiah)}. Job: \`${job.id}\``
      ).catch(() => {});
      return true;
    }

    return false;
  };
}

module.exports = { createTopupHandler };
