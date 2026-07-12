const { EmbedBuilder } = require('discord.js');

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
const RESTART_INTERVAL_HOURS = 3;
const RESTART_MINUTE = 10;

function nextRestartAtMs(nowMs = Date.now()) {
  const shiftedNowMs = nowMs + JAKARTA_OFFSET_MS;
  const shiftedNow = new Date(shiftedNowMs);
  const candidate = new Date(Date.UTC(
    shiftedNow.getUTCFullYear(),
    shiftedNow.getUTCMonth(),
    shiftedNow.getUTCDate(),
    shiftedNow.getUTCHours(),
    RESTART_MINUTE,
    0,
    0
  ));

  while (candidate.getTime() <= shiftedNowMs || candidate.getUTCHours() % RESTART_INTERVAL_HOURS !== 0) {
    candidate.setUTCHours(candidate.getUTCHours() + 1);
  }
  return candidate.getTime() - JAKARTA_OFFSET_MS;
}

function formatJakartaTime(date) {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(date);
}

function createServerStatusNotifier({ client, channelId }) {
  let channelPromise = null;
  let restartTimer = null;
  let stopped = false;

  async function resolveChannel() {
    if (!client || !channelId) return null;
    if (!channelPromise) {
      channelPromise = client.channels.fetch(channelId).catch(error => {
        channelPromise = null;
        console.error('Failed to fetch Ethergeon server status channel:', error);
        return null;
      });
    }
    return channelPromise;
  }

  async function sendEmbed(embed) {
    const channel = await resolveChannel();
    if (!channel?.send) return false;
    const sent = await channel.send({
      embeds: [embed],
      allowedMentions: { parse: [] },
    }).catch(error => {
      console.error('Failed to send Ethergeon server status notification:', error);
      return null;
    });
    return Boolean(sent);
  }

  async function notifyRestarting(scheduledAt = new Date()) {
    return sendEmbed(
      new EmbedBuilder()
        .setColor(0xf2c94c)
        .setTitle('Server Sedang Direstart...')
        .setDescription([
          'Server Ethergeon sedang menjalani restart rutin tiga jam sekali.',
          'Mohon tunggu hingga server aktif dan bridge Discord tersambung kembali.',
        ].join('\n'))
        .addFields({
          name: 'Jadwal',
          value: `${formatJakartaTime(scheduledAt)} WIB`,
          inline: false,
        })
        .setTimestamp(scheduledAt)
    );
  }

  async function notifyConnected() {
    return sendEmbed(
      new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('Server Ethergeon Sudah Aktif')
        .setDescription('Server sudah aktif, dan Discord sudah tersambung ke server Ethergeon.')
        .setFooter({ text: 'Command bridge dan layanan Minecraft dapat digunakan kembali.' })
        .setTimestamp()
    );
  }

  async function notifyShopPriceChanged(result = {}, adminTag = "Discord Admin") {
    const entry = result.entry || {};
    const previousValue = Math.max(0, Math.floor(Number(result.previousValue) || 0));
    const currentValue = Math.max(0, Math.floor(Number(result.currentValue) || 0));
    const direction = currentValue > previousValue ? 'naik' : currentValue < previousValue ? 'turun' : 'tetap';
    const color = direction === 'naik' ? 0xe67e22 : direction === 'turun' ? 0x2ecc71 : 0x95a5a6;
    const formatNumber = value => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return sendEmbed(
      new EmbedBuilder()
        .setColor(color)
        .setTitle(`Harga Shop ${direction === 'naik' ? 'Naik' : direction === 'turun' ? 'Turun' : 'Diperbarui'}`)
        .setDescription(`Harga **${entry.label || entry.key || 'Item Shop'}** telah ${direction}.`)
        .addFields(
          { name: 'Harga Sebelumnya', value: `${formatNumber(previousValue)} ${entry.unit || 'Geon'}`, inline: true },
          { name: 'Harga Sekarang', value: `${formatNumber(currentValue)} ${entry.unit || 'Geon'}`, inline: true },
          { name: 'Diubah Oleh', value: String(adminTag || 'Discord Admin').slice(0, 1024), inline: false }
        )
        .setFooter({ text: `Shop index ${entry.index || '-'} • ${entry.key || '-'}` })
        .setTimestamp()
    );
  }

  function lawName(law = {}) {
    return law.number && law.year ? `UU No. ${law.number} Tahun ${law.year}` : law.code || 'UU Ethergeon';
  }

  async function notifyLawPublished(law = {}, adminTag = 'Admin') {
    return sendEmbed(
      new EmbedBuilder()
        .setColor(0x2f80ed)
        .setTitle('Undang-Undang Ethergeon Diterbitkan')
        .setDescription(`**${lawName(law)} — ${law.title || 'Tanpa Judul'}** telah resmi diterbitkan dan berlaku.`)
        .addFields(
          { name: 'Kode', value: `\`${law.code || '-'}\``, inline: true },
          { name: 'Versi', value: String(law.version || 1), inline: true },
          { name: 'Diterbitkan Oleh', value: String(adminTag).slice(0, 1024), inline: false }
        )
        .setFooter({ text: 'Gunakan !uu untuk membaca isi lengkap.' })
        .setTimestamp()
    );
  }

  async function notifyLawRevised(law = {}, adminTag = 'Admin') {
    return sendEmbed(
      new EmbedBuilder()
        .setColor(0xf2c94c)
        .setTitle('Undang-Undang Ethergeon Direvisi')
        .setDescription(`**${lawName(law)} — ${law.title || 'Tanpa Judul'}** diperbarui ke versi **${law.version || law.currentVersion || '-'}**.`)
        .addFields(
          { name: 'Catatan Perubahan', value: String(law.changeNote || '-').slice(0, 1024), inline: false },
          { name: 'Direvisi Oleh', value: String(adminTag).slice(0, 1024), inline: false }
        )
        .setFooter({ text: 'Riwayat versi tetap tersimpan. Gunakan !uu untuk membaca versi terbaru.' })
        .setTimestamp()
    );
  }

  async function notifyLawRevoked(law = {}, adminTag = 'Admin') {
    return sendEmbed(
      new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('Undang-Undang Ethergeon Dicabut')
        .setDescription(`**${lawName(law)} — ${law.title || 'Tanpa Judul'}** telah dicabut.`)
        .addFields(
          { name: 'Alasan', value: String(law.revokeReason || '-').slice(0, 1024), inline: false },
          { name: 'Dicabut Oleh', value: String(adminTag).slice(0, 1024), inline: false }
        )
        .setFooter({ text: 'Dokumen tetap tersedia sebagai arsip publik.' })
        .setTimestamp()
    );
  }

  function scheduleNextRestartNotice(nowMs = Date.now()) {
    if (stopped) return null;
    if (restartTimer) clearTimeout(restartTimer);
    const targetMs = nextRestartAtMs(nowMs);
    const delayMs = Math.max(1_000, targetMs - nowMs);
    restartTimer = setTimeout(async () => {
      restartTimer = null;
      await notifyRestarting(new Date(targetMs));
      scheduleNextRestartNotice(targetMs + 1_000);
    }, delayMs);
    restartTimer.unref?.();
    return targetMs;
  }

  function start() {
    stopped = false;
    return scheduleNextRestartNotice();
  }

  function stop() {
    stopped = true;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
  }

  return {
    start,
    stop,
    notifyConnected,
    notifyRestarting,
    notifyShopPriceChanged,
    notifyLawPublished,
    notifyLawRevised,
    notifyLawRevoked,
    nextRestartAtMs,
  };
}

module.exports = {
  createServerStatusNotifier,
  nextRestartAtMs,
};
