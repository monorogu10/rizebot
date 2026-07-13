const { EmbedBuilder } = require('discord.js');
const {
  MINECRAFT_REGISTER_RESET_ADMIN_ID,
  TOPUP_ADMIN_DISCORD_ID,
} = require('../config');
const { isAdmin } = require('../utils/permissions');

const SHOP_PRICE_MAX = 100_000_000;

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizePrice(value) {
  const digits = String(value ?? '').trim().replace(/[.,_]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number < 1 || number > SHOP_PRICE_MAX) return null;
  return number;
}

function formatNumber(value) {
  const number = Math.max(0, Math.floor(Number(value) || 0));
  return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function noPing(payload) {
  return {
    ...payload,
    allowedMentions: payload.allowedMentions || { parse: [], repliedUser: false },
  };
}

function canManageShop(msg) {
  const userId = String(msg?.author?.id || '');
  return isAdmin(msg?.member) ||
    userId === String(TOPUP_ADMIN_DISCORD_ID) ||
    userId === String(MINECRAFT_REGISTER_RESET_ADMIN_ID);
}

function bridgeFailureText(result) {
  const messages = Array.isArray(result?.messages) ? result.messages.filter(Boolean) : [];
  if (messages.length) return messages[messages.length - 1];
  const code = String(result?.code || 'unknown');
  const known = {
    'bridge-result-timeout': 'Minecraft tidak merespons sebelum batas waktu.',
    'shop-prices-unavailable': 'Daftar harga shop belum tersedia dari behavior pack.',
    'shop-query-required': 'Index atau nama barang wajib diisi.',
    'shop-index-not-found': 'Index shop tidak ditemukan.',
    'shop-item-not-found': 'Nama barang shop tidak ditemukan.',
    'shop-query-ambiguous': 'Nama tersebut cocok dengan beberapa barang. Gunakan index atau nama yang lebih lengkap.',
    'shop-price-update-rejected': 'Perubahan harga ditolak oleh sistem harga Minecraft.',
  };
  return known[code] || `Operasi shop gagal: ${code}.`;
}

function candidateText(result) {
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  if (!candidates.length) return '';
  return `\n\nPilihan yang mendekati:\n${candidates
    .map(entry => `\`${entry.index}\` — ${entry.label}`)
    .join('\n')}`;
}

function shopListEmbed(result) {
  const entries = Array.isArray(result?.entries) ? result.entries : [];
  return new EmbedBuilder()
    .setColor(0x2f80ed)
    .setTitle('ETHERGEON SHOP — Daftar Harga')
    .setDescription(entries.map(entry => {
      const custom = entry.isDefault ? '' : ' • harga khusus';
      return `\`${entry.index}\` **${entry.label}** — ${formatNumber(entry.currentValue)} ${entry.unit || 'Geon'}${custom}`;
    }).join('\n') || 'Daftar harga kosong.')
    .setFooter({ text: 'Admin: /shop item:<index/nama> harga:<Geon>' })
    .setTimestamp();
}

function createShopHandler({ bridge, serverStatusNotifier }) {
  return async function handleShop(msg) {
    if (!msg || msg.author?.bot) return false;
    const content = normalizeSpaces(msg.content);

    if (/^!shop(?:\s|$)/i.test(content) && !/^!shopsetting(?:\s|$)/i.test(content)) {
      if (content.toLowerCase() !== '!shop') {
        await msg.reply(noPing({ content: 'Gunakan `/shop` tanpa option untuk melihat seluruh harga.' })).catch(() => {});
        return true;
      }

      const loading = await msg.reply(noPing({
        embeds: [
          new EmbedBuilder()
            .setColor(0xf2c94c)
            .setTitle('Mengambil Harga Shop')
            .setDescription('Meminta daftar harga terbaru dari server Minecraft...'),
        ],
      })).catch(() => null);
      if (!loading) return true;

      const pending = bridge.enqueueBridgeQueryWithResult('shop_list', {
        requestedBy: msg.author.id,
      });
      const result = await pending.result;
      await loading.edit(noPing({
        embeds: [result?.ok
          ? shopListEmbed(result)
          : new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle('Harga Shop Tidak Tersedia')
            .setDescription(bridgeFailureText(result))
            .setFooter({ text: `Ref ${result?.jobId || '-'}` })],
      })).catch(() => {});
      return true;
    }

    if (/^!shopsetting(?:\s|$)/i.test(content)) {
      if (!canManageShop(msg)) {
        await msg.reply(noPing({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle('Shop Setting Ditolak')
              .setDescription('Command ini hanya dapat digunakan admin Discord/Minecraft.'),
          ],
        })).catch(() => {});
        return true;
      }

      const match = content.match(/^!shopsetting\s+(.+)\s+(\S+)$/i);
      const query = normalizeSpaces(match?.[1]);
      const value = normalizePrice(match?.[2]);
      if (!query || !value) {
        await msg.reply(noPing({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle('Format Shop Setting')
              .setDescription([
                'Gunakan `/shop` dengan option `item` dan `harga`.',
                'Contoh item: `1` atau `Magic Tool`.',
                'Harga harus berupa Geon bulat positif.',
              ].join('\n')),
          ],
        })).catch(() => {});
        return true;
      }

      const loading = await msg.reply(noPing({
        embeds: [
          new EmbedBuilder()
            .setColor(0xf2c94c)
            .setTitle('Mengubah Harga Shop')
            .setDescription(`Mencari \`${query}\` dan mengubah harganya menjadi **${formatNumber(value)} Geon**...`),
        ],
      })).catch(() => null);
      if (!loading) return true;

      const requestedByTag = normalizeSpaces(msg.author?.tag || msg.author?.username || `Discord ${msg.author.id}`);
      const pending = bridge.enqueueBridgeQueryWithResult('shop_set_price', {
        query,
        value,
        requestedBy: msg.author.id,
        requestedByTag,
      });
      const result = await pending.result;
      const ok = Boolean(result?.ok);
      const entry = result?.entry || {};
      const directionLabel = result?.direction === 'naik'
        ? 'naik'
        : result?.direction === 'turun' ? 'turun' : 'tetap';

      await loading.edit(noPing({
        embeds: [
          new EmbedBuilder()
            .setColor(ok ? 0x2ecc71 : 0xe74c3c)
            .setTitle(ok ? 'Harga Shop Berhasil Diubah' : 'Harga Shop Gagal Diubah')
            .setDescription(ok
              ? `Harga **${entry.label || entry.key}** ${directionLabel}: **${formatNumber(result.previousValue)}** → **${formatNumber(result.currentValue)} ${entry.unit || 'Geon'}**.`
              : `${bridgeFailureText(result)}${candidateText(result)}`)
            .setFooter({ text: `Ref ${result?.jobId || '-'}` })
            .setTimestamp(),
        ],
      })).catch(() => {});

      if (ok && result.direction !== 'tetap') {
        await serverStatusNotifier?.notifyShopPriceChanged?.(result, requestedByTag);
      }
      return true;
    }

    return false;
  };
}

module.exports = { createShopHandler };
