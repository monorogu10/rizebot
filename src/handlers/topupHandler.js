const { EmbedBuilder } = require('discord.js');
const { TOPUP_ADMIN_DISCORD_ID } = require('../config');
const { calculateGeon } = require('../services/sociabuzzTopupService');

const GEON_MAX = 100_000_000;
const RUPIAH_MAX = 2_000_000_000;
const COUPON_BATCH_MAX = 50;
const COUPON_EXPIRE_MAX_DAYS = 365;
const LOADING_GIF_URL = 'https://media1.tenor.com/m/UnFx-k_lSckAAAAd/amalie-steiness.gif';

function isTopupAdmin(userId) {
  return String(userId || '') === TOPUP_ADMIN_DISCORD_ID;
}

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseCommand(content) {
  const raw = normalizeSpaces(content);
  const match = raw.match(/^!(srcpl|searchpl|tu|topup|topup-resolve|gnrtkpn|kupon|coupon|topup-help|geonrate|rategeon|cek-harga|cekharga|kurs|harga|rate)(?:\s+(.+))?$/i);
  if (!match) return null;
  return {
    command: match[1].toLowerCase(),
    args: normalizeSpaces(match[2] || ''),
  };
}

function isRateCommand(command) {
  return ['geonrate', 'rategeon', 'cek-harga', 'cekharga', 'kurs', 'harga', 'rate'].includes(command);
}

function parseTopupArgs(args, bridge) {
  const parts = normalizeSpaces(args).split(' ').filter(Boolean);
  if (parts.length < 3) return null;

  const rupiah = bridge.normalizePositiveInt(parts.pop(), RUPIAH_MAX);
  const geonRaw = parts.pop();
  const geon = /^auto$/i.test(geonRaw) ? 0 : bridge.normalizePositiveInt(geonRaw, GEON_MAX);
  const target = normalizeSpaces(parts.join(' '));
  if (!target || (!geon && !/^auto$/i.test(geonRaw)) || !rupiah) return null;
  return { target, geon, rupiah };
}

function parseCouponArgs(args, bridge) {
  const parts = normalizeSpaces(args).split(' ').filter(Boolean);
  if (parts.length < 2) return null;

  const geon = /^auto$/i.test(parts[0]) ? 0 : bridge.normalizePositiveInt(parts[0], GEON_MAX);
  const rupiah = bridge.normalizePositiveInt(parts[1], RUPIAH_MAX);
  const count = bridge.normalizePositiveInt(parts[2] || '1', COUPON_BATCH_MAX);
  const days = bridge.normalizePositiveInt(parts[3] || '30', COUPON_EXPIRE_MAX_DAYS);
  if ((!geon && !/^auto$/i.test(parts[0])) || !rupiah || !count || !days) return null;
  return { geon, rupiah, count, days };
}

function parseResolveArgs(args) {
  const [paymentRaw, ...targetParts] = String(args || '').split('|');
  const paymentId = normalizeSpaces(paymentRaw);
  const target = normalizeSpaces(targetParts.join('|'));
  return paymentId && target ? { paymentId, target } : null;
}

function formatTarget(target) {
  const user = target.userId ? `<@${target.userId}>` : '-';
  const username = target.username ? ` | discord=${target.username}` : '';
  const status = target.verified ? 'verified' : 'terdaftar';
  return `\`${target.gamertag}\` | ${user} | ${status}${username}`;
}

function formatCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length < 1) return 'Tidak ada hasil.';
  return candidates.map((target, index) => `${index + 1}. ${formatTarget(target)}`).join('\n');
}

function helpText() {
  return [
    '**TOPUP admin commands**',
    '`/minecraft search` - cari player dari data asli server Minecraft + status Discord',
    '`/topup kirim` - kirim topup ke Minecraft',
    '`/topup kupon` - generate kupon',
    '`/topup resolve` - alihkan payment SociaBuzz tanpa reject',
    '`/geonrate cek` - cek kalkulasi Geon otomatis SociaBuzz',
    '`/geonrate set` - ubah rate dasar seluruh harga',
    '`/geonrate history` - lihat audit perubahan rate',
  ].join('\n');
}

function noPing(payload) {
  return {
    ...payload,
    allowedMentions: payload.allowedMentions || { parse: [], repliedUser: false },
  };
}

function loadingMessageRef(message) {
  if (!message?.id) return null;
  return {
    channelId: String(message.channelId || message.channel?.id || ''),
    messageId: String(message.id || ''),
  };
}

function buildLoadingPayload({ title, description, ref = '' }) {
  return noPing({
    embeds: [
      new EmbedBuilder()
        .setColor(0x2f80ed)
        .setTitle(title)
        .setDescription(description)
        .setImage(LOADING_GIF_URL)
        .setFooter({ text: ref ? `Diproses oleh Minecraft BP | Ref ${ref}` : 'Menunggu Minecraft BP...' })
        .setTimestamp(new Date()),
    ],
  });
}

async function sendLoading(msg, options) {
  return msg.reply(buildLoadingPayload(options)).catch(() => null);
}

function createTopupHandler({ bridge, sociabuzz = null }) {
  const calculateForRupiah = rupiah => (
    sociabuzz?.calculateForRupiah?.(rupiah) ?? calculateGeon(rupiah)
  );

  return async function handleTopupCommand(msg) {
    if (!msg || msg.author?.bot) return false;

    const parsed = parseCommand(msg.content);
    if (!parsed) return false;

    if (isRateCommand(parsed.command)) {
      const [actionRaw, ...tail] = parsed.args.split(' ');
      const legacyRupiah = /^[\d.,\s]+$/.test(parsed.args)
        ? bridge.normalizePositiveInt(parsed.args, RUPIAH_MAX)
        : null;
      const action = legacyRupiah ? 'cek' : String(actionRaw || '').toLowerCase();
      if (action === 'cek') {
        const rupiahRaw = legacyRupiah || tail.join(' ');
        const rupiah = bridge.normalizePositiveInt(rupiahRaw, RUPIAH_MAX);
        if (!rupiah) {
          await msg.reply('Gunakan `/geonrate cek rupiah:<nominal>`.').catch(() => {});
          return true;
        }
        const rate = sociabuzz?.getRate?.();
        await msg.reply([
          `${bridge.rupiahText(rupiah)} = **${bridge.formatNumber(calculateForRupiah(rupiah))} Geon**`,
          rate ? `Rate aktif: ${bridge.formatNumber(rate.geonPer1000)} Geon / Rp1.000 (versi ${rate.version}).` : '',
        ].filter(Boolean).join('\n')).catch(() => {});
        return true;
      }

      if (!isTopupAdmin(msg.author?.id)) {
        await msg.reply('Perubahan dan history rate hanya untuk admin topup.').catch(() => {});
        return true;
      }
      if (!sociabuzz) {
        await msg.reply('Service rate SociaBuzz belum tersedia.').catch(() => {});
        return true;
      }

      const actor = {
        id: msg.author.id,
        name: msg.author.globalName || msg.author.username || msg.author.tag || 'Topup Admin',
      };
      if (action === 'set') {
        const joined = tail.join(' ');
        const [valueRaw, ...reasonParts] = joined.split('|');
        const value = bridge.normalizePositiveInt(valueRaw, 1_000_000);
        if (!value) {
          await msg.reply('Gunakan `/geonrate set geon-per-1000:<jumlah>`.').catch(() => {});
          return true;
        }
        const rate = sociabuzz.setRate(value, actor, normalizeSpaces(reasonParts.join('|')) || 'Diubah oleh admin');
        await msg.reply(
          `Rate versi ${rate.version} aktif: **${bridge.formatNumber(rate.geonPer1000)} Geon / Rp1.000**. Semua kalkulasi harga baru ikut diskalakan.`
        ).catch(() => {});
        return true;
      }
      if (action === 'reset') {
        const reason = normalizeSpaces(tail.join(' ').replace(/^\|\s*/, '')) || 'Reset ke rate standar';
        const rate = sociabuzz.setRate(100, actor, reason);
        await msg.reply(`Rate di-reset ke **100 Geon / Rp1.000** (versi ${rate.version}).`).catch(() => {});
        return true;
      }
      if (action === 'history') {
        const rows = sociabuzz.listRateHistory(10);
        const lines = rows.map(row => (
          `v${row.version} | ${bridge.formatNumber(row.geonPer1000)} Geon/Rp1.000 | ${normalizeSpaces(row.changedByName || row.changedBy || 'system').slice(0, 60)} | ${normalizeSpaces(row.reason || '-').slice(0, 100)}`
        ));
        await msg.reply(`**Riwayat Geon rate**\n${lines.join('\n').slice(0, 1800) || 'Belum ada riwayat.'}`).catch(() => {});
        return true;
      }

      await msg.reply('Gunakan `/geonrate cek`, `/geonrate set`, `/geonrate history`, atau `/geonrate reset`.').catch(() => {});
      return true;
    }

    if (!isTopupAdmin(msg.author?.id)) {
      await msg.reply('Command topup hanya untuk admin. Untuk cek kurs, gunakan `/geonrate`.').catch(() => {});
      return true;
    }

    if (parsed.command === 'topup-help') {
      await msg.reply(helpText()).catch(() => {});
      return true;
    }

    if (parsed.command === 'topup-resolve') {
      const resolution = parseResolveArgs(parsed.args);
      if (!resolution) {
        await msg.reply('Gunakan `/topup resolve` dengan option `payment` dan `nama`.').catch(() => {});
        return true;
      }
      if (!sociabuzz?.resolvePayment) {
        await msg.reply('Service resolusi SociaBuzz belum tersedia.').catch(() => {});
        return true;
      }
      const result = await sociabuzz.resolvePayment(
        resolution.paymentId,
        resolution.target,
        {
          id: msg.author.id,
          name: msg.author.globalName || msg.author.username || msg.author.tag || 'Topup Admin',
        },
        msg
      );
      if (!result.ok) {
        await msg.reply(
          `Payment tidak dapat dialihkan (${result.code}). Kandidat:\n${formatCandidates(result.candidates)}`
        ).catch(() => {});
        return true;
      }
      await msg.reply(
        `Payment \`${resolution.paymentId}\` diantrikan ke \`${result.record.target.gamertag}\` dengan ref \`${result.job.id}\`.`
      ).catch(() => {});
      return true;
    }

    if (parsed.command === 'srcpl' || parsed.command === 'searchpl') {
      if (parsed.args.length < 2) {
        await msg.reply('Gunakan `/minecraft search nama:<minimal 2 huruf>`.').catch(() => {});
        return true;
      }

      const loading = await sendLoading(msg, {
        title: 'Search Player Server',
        description: `Mencari player yang mendekati \`${parsed.args}\`.`,
      });
      const job = bridge.enqueueBridgeQuery('search_server', {
        query: parsed.args,
        requestedBy: msg.author.id,
      }, { message: msg, loadingMessage: loadingMessageRef(loading) });
      await loading?.edit(buildLoadingPayload({
        title: 'Search Player Server',
        description: `Mencari player yang mendekati \`${parsed.args}\`.`,
        ref: job.id,
      })).catch(() => {});
      return true;
    }

    if (parsed.command === 'tu' || parsed.command === 'topup') {
      const topup = parseTopupArgs(parsed.args, bridge);
      if (!topup) {
        await msg.reply('Gunakan `/topup kirim` dengan option `nama` dan `rupiah`; `geon` hanya untuk override.').catch(() => {});
        return true;
      }
      if (!topup.geon) topup.geon = calculateForRupiah(topup.rupiah);

      const resolved = bridge.resolveTarget(topup.target);
      if (!resolved.ok) {
        await msg.reply(
          `Target tidak valid (${resolved.code}). Kandidat:\n${formatCandidates(resolved.candidates)}`
        ).catch(() => {});
        return true;
      }

      const loading = await sendLoading(msg, {
        title: 'Topup Geon',
        description: `Mengirim **${bridge.formatNumber(topup.geon)} Geon** ke \`${resolved.target.gamertag}\`.`,
      });
      const job = bridge.enqueueTopup({
        target: resolved.target,
        geon: topup.geon,
        rupiah: topup.rupiah,
        requestedBy: msg.author.id,
        message: msg,
        loadingMessage: loadingMessageRef(loading),
      });

      await loading?.edit(buildLoadingPayload({
        title: 'Topup Geon',
        description: `Mengirim **${bridge.formatNumber(topup.geon)} Geon** ke \`${resolved.target.gamertag}\` (${bridge.rupiahText(topup.rupiah)}).`,
        ref: job.id,
      })).catch(() => {});
      return true;
    }

    if (parsed.command === 'gnrtkpn' || parsed.command === 'kupon' || parsed.command === 'coupon') {
      const coupon = parseCouponArgs(parsed.args, bridge);
      if (!coupon) {
        await msg.reply('Gunakan `/topup kupon` dengan option `rupiah`; `geon` hanya untuk override.').catch(() => {});
        return true;
      }
      if (!coupon.geon) coupon.geon = calculateForRupiah(coupon.rupiah);

      const loading = await sendLoading(msg, {
        title: 'Generate Kupon',
        description: `Membuat ${coupon.count} kupon, masing-masing **${bridge.formatNumber(coupon.geon)} Geon**.`,
      });
      const job = bridge.enqueueCoupon({
        ...coupon,
        requestedBy: msg.author.id,
        message: msg,
        loadingMessage: loadingMessageRef(loading),
      });

      await loading?.edit(buildLoadingPayload({
        title: 'Generate Kupon',
        description: `Membuat ${coupon.count} kupon, ${bridge.formatNumber(coupon.geon)} Geon, ${bridge.rupiahText(coupon.rupiah)}.`,
        ref: job.id,
      })).catch(() => {});
      return true;
    }

    return false;
  };
}

module.exports = { createTopupHandler };
