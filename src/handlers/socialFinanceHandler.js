const crypto = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');

const BANSOS_MAX_RECIPIENTS = 100;
const FINANCE_TRANSFER_MAX = 100_000_000;
const CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizePositiveInt(value, max = FINANCE_TRANSFER_MAX) {
  const raw = String(value ?? '').trim();
  const digits = raw.replace(/[.,_]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) return null;
  return number;
}

function formatNumber(value) {
  const number = Math.max(0, Math.floor(Number(value) || 0));
  return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function isApprovedRegisterEntry(entry) {
  const status = String(entry?.status || '').toLowerCase();
  return Boolean(entry?.legal === true || status === 'approved');
}

function noPing(payload) {
  return {
    ...payload,
    allowedMentions: payload.allowedMentions || { parse: [], repliedUser: false },
  };
}

function bridgeFailureText(result) {
  const messages = Array.isArray(result?.messages) ? result.messages.filter(Boolean) : [];
  if (messages.length) return messages[messages.length - 1];
  const code = String(result?.code || 'unknown');
  const known = {
    'bridge-result-timeout': 'Minecraft tidak merespons sebelum batas waktu. Pastikan world dan behavior pack aktif.',
    'company-actor-not-legal': 'Gamertag kamu belum tercatat legal di behavior pack.',
    'discord-actor-not-legal': 'Gamertag kamu belum tercatat legal di behavior pack.',
    'company-discord-link-mismatch': 'Gamertag tersebut terhubung ke akun Discord lain.',
    'discord-link-mismatch': 'Gamertag tersebut terhubung ke akun Discord lain.',
    'bansos-create-rejected': 'Bansos ditolak oleh sistem Minecraft. Periksa saldo, jumlah penerima, dan slot bansos aktif.',
    'wallet-transfer-all-rejected': 'Transfer massal ditolak. Periksa saldo dan pastikan ada player lain yang online.',
  };
  return known[code] || `Operasi gagal: ${code}.`;
}

function registeredActor(msg, registerStore) {
  const entry = registerStore.getUser(msg.author.id);
  if (!isApprovedRegisterEntry(entry) || !entry?.gamertag) return null;
  return {
    userId: String(msg.author.id),
    gamertag: normalizeSpaces(entry.gamertag),
  };
}

function runLegalJob(bridge, actor, type, payload) {
  const pending = bridge.enqueueBridgeQueryWithResult(type, {
    actorKey: actor.gamertag,
    actorDiscordUserId: actor.userId,
    requestedBy: actor.userId,
    ...payload,
  });
  return pending.result;
}

function lockedRegistrationEmbed() {
  return new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle('Akses Finance Terkunci')
    .setDescription('Akun Discord kamu harus approved/legal dan memiliki gamertag Minecraft.');
}

function createSocialFinanceHandler({ bridge, registerStore }) {
  return async function handleSocialFinance(msg) {
    if (!msg || msg.author?.bot) return false;
    const content = normalizeSpaces(msg.content);

    const bansosMatch = content.match(/^!bansos(?:\s+(\S+)\s+(\S+))?$/i);
    if (/^!bansos(?:\s|$)/i.test(content)) {
      const geonPerClaim = normalizePositiveInt(bansosMatch?.[1]);
      const maxClaims = normalizePositiveInt(bansosMatch?.[2], BANSOS_MAX_RECIPIENTS);
      const totalGeon = geonPerClaim && maxClaims ? geonPerClaim * maxClaims : 0;
      if (!geonPerClaim || !maxClaims || !Number.isSafeInteger(totalGeon) || totalGeon > FINANCE_TRANSFER_MAX) {
        await msg.reply(noPing({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle('Format Bansos')
              .setDescription([
                'Gunakan `/bansos` dengan option `geon` dan `orang`.',
                'Contoh: `geon:500 orang:20`.',
                `Maksimal **${BANSOS_MAX_RECIPIENTS} orang** dan total **${formatNumber(FINANCE_TRANSFER_MAX)} Geon**.`,
              ].join('\n')),
          ],
        })).catch(() => {});
        return true;
      }

      const actor = registeredActor(msg, registerStore);
      if (!actor) {
        await msg.reply(noPing({ embeds: [lockedRegistrationEmbed()] })).catch(() => {});
        return true;
      }

      const sessionId = crypto.randomBytes(5).toString('hex');
      const confirmId = `bansos:${sessionId}:confirm`;
      const cancelId = `bansos:${sessionId}:cancel`;
      const row = disabled => new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(confirmId)
          .setLabel('Konfirmasi & Buat')
          .setStyle(ButtonStyle.Success)
          .setDisabled(disabled),
        new ButtonBuilder()
          .setCustomId(cancelId)
          .setLabel('Batalkan')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(disabled)
      );

      const confirmation = await msg.reply(noPing({
        embeds: [
          new EmbedBuilder()
            .setColor(0xf2c94c)
            .setTitle('Konfirmasi Bansos Ethergeon')
            .setDescription('Dana langsung dipotong dari wallet Minecraft setelah dikonfirmasi.')
            .addFields(
              { name: 'Pemberi', value: `\`${actor.gamertag}\``, inline: true },
              { name: 'Hadiah', value: `${formatNumber(geonPerClaim)} Geon/orang`, inline: true },
              { name: 'Penerima', value: `${formatNumber(maxClaims)} orang`, inline: true },
              { name: 'Total Biaya', value: `**${formatNumber(totalGeon)} Geon**`, inline: false },
              { name: 'Cara Claim', value: 'Masuk server Ethergeon, lalu buka **SR Gram > Bansos** atau gunakan `/claim`.', inline: false }
            )
            .setFooter({ text: 'Hanya pembuat command yang dapat mengakses tombol ini.' })
            .setTimestamp(),
        ],
        components: [row(false)],
      })).catch(() => null);
      if (!confirmation) return true;

      const collector = confirmation.createMessageComponentCollector({
        time: CONFIRM_TIMEOUT_MS,
        filter: interaction => interaction.customId === confirmId || interaction.customId === cancelId,
      });
      let completed = false;

      collector.on('collect', async interaction => {
        if (String(interaction.user?.id || '') !== actor.userId) {
          await interaction.reply(noPing({
            content: 'Konfirmasi ini hanya dapat digunakan oleh pemberi bansos.',
            ephemeral: true,
          })).catch(() => {});
          return;
        }

        completed = true;
        collector.stop(interaction.customId === cancelId ? 'cancelled' : 'confirmed');
        if (interaction.customId === cancelId) {
          await interaction.update(noPing({
            embeds: [
              new EmbedBuilder()
                .setColor(0x95a5a6)
                .setTitle('Bansos Dibatalkan')
                .setDescription(`Tidak ada Geon yang dipotong dari \`${actor.gamertag}\`.`),
            ],
            components: [row(true)],
          })).catch(() => {});
          return;
        }

        await interaction.update(noPing({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf2c94c)
              .setTitle('Membuat Bansos')
              .setDescription('Menunggu konfirmasi transaksi dari server Minecraft...'),
          ],
          components: [row(true)],
        })).catch(() => {});

        const result = await runLegalJob(bridge, actor, 'discord_bansos_create', {
          geonPerClaim,
          maxClaims,
        });
        const ok = Boolean(result?.ok);
        await confirmation.edit(noPing({
          embeds: [
            new EmbedBuilder()
              .setColor(ok ? 0x2ecc71 : 0xe74c3c)
              .setTitle(ok ? 'Bansos Berhasil Dibuat' : 'Bansos Gagal Dibuat')
              .setDescription(ok
                ? `Bansos **${formatNumber(geonPerClaim)} Geon/orang** untuk **${formatNumber(maxClaims)} orang** sudah aktif.\nClaim hanya dapat dilakukan dengan masuk ke server Ethergeon.`
                : bridgeFailureText(result))
              .setFooter({ text: `Ref ${result?.jobId || '-'}` })
              .setTimestamp(),
          ],
          components: [row(true)],
        })).catch(() => {});
      });

      collector.on('end', async () => {
        if (completed) return;
        await confirmation.edit(noPing({
          embeds: [
            new EmbedBuilder()
              .setColor(0x95a5a6)
              .setTitle('Konfirmasi Bansos Kedaluwarsa')
              .setDescription('Jalankan command kembali jika masih ingin membuat bansos.'),
          ],
          components: [row(true)],
        })).catch(() => {});
      });
      return true;
    }

    const transferAllMatch = content.match(/^!tf\s+--all\s+(\S+)$/i);
    if (/^!tf\s+--all(?:\s|$)/i.test(content)) {
      const amount = normalizePositiveInt(transferAllMatch?.[1]);
      if (!amount) {
        await msg.reply(noPing({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle('Format Transfer Massal')
              .setDescription('Gunakan `/tf all jumlah:<geon_per_player>`.\nContoh: `jumlah:1000`.'),
          ],
        })).catch(() => {});
        return true;
      }

      const actor = registeredActor(msg, registerStore);
      if (!actor) {
        await msg.reply(noPing({ embeds: [lockedRegistrationEmbed()] })).catch(() => {});
        return true;
      }

      const loading = await msg.reply(noPing({
        embeds: [
          new EmbedBuilder()
            .setColor(0xf2c94c)
            .setTitle('Transfer Massal Diproses')
            .setDescription(`Mengirim **${formatNumber(amount)} Geon** dari \`${actor.gamertag}\` ke setiap player lain yang online.`),
        ],
      })).catch(() => null);
      if (!loading) return true;

      const result = await runLegalJob(bridge, actor, 'wallet_transfer_all', { amount });
      const ok = Boolean(result?.ok);
      const recipients = Array.isArray(result?.recipients) ? result.recipients.filter(Boolean) : [];
      await loading.edit(noPing({
        embeds: [
          new EmbedBuilder()
            .setColor(ok ? 0x2ecc71 : 0xe74c3c)
            .setTitle(ok ? 'Transfer Massal Berhasil' : 'Transfer Massal Gagal')
            .setDescription(ok
              ? `**${formatNumber(result.amount)} Geon** dikirim ke **${formatNumber(result.recipientCount)} player online**.\nTotal: **${formatNumber(result.totalAmount)} Geon**.`
              : bridgeFailureText(result))
            .addFields(ok && recipients.length ? [{
              name: 'Penerima',
              value: recipients.map(name => `\`${String(name).replace(/`/g, '')}\``).join(', ').slice(0, 1024),
              inline: false,
            }] : [])
            .setFooter({ text: `Ref ${result?.jobId || '-'}` })
            .setTimestamp(),
        ],
      })).catch(() => {});
      return true;
    }

    return false;
  };
}

module.exports = { createSocialFinanceHandler };
