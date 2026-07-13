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
  const match = raw.match(/^!(srcpl|searchpl|tu|topup|gnrtkpn|kupon|coupon|topup-help|geonrate|rategeon|cek-harga|cekharga|kurs|harga|rate)(?:\s+(.+))?$/i);
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
    '`/geonrate` - cek kalkulasi Geon otomatis SociaBuzz',
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

function createTopupHandler({ bridge }) {
  return async function handleTopupCommand(msg) {
    if (!msg || msg.author?.bot) return false;

    const parsed = parseCommand(msg.content);
    if (!parsed) return false;

    if (isRateCommand(parsed.command)) {
      const rupiah = bridge.normalizePositiveInt(parsed.args, RUPIAH_MAX);
      if (!rupiah) {
        await msg.reply('Gunakan `/geonrate rupiah:<nominal>`.').catch(() => {});
        return true;
      }
      await msg.reply(
        `${bridge.rupiahText(rupiah)} = **${bridge.formatNumber(calculateGeon(rupiah))} Geon**`
      ).catch(() => {});
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
        await msg.reply('Gunakan `/topup kirim` dengan option `nama`, `geon`, dan `rupiah`.').catch(() => {});
        return true;
      }

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
        await msg.reply('Gunakan `/topup kupon` dengan option `geon`, `rupiah`, `jumlah`, dan `hari`.').catch(() => {});
        return true;
      }

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
