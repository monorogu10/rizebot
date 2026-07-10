const { EmbedBuilder } = require('discord.js');
const {
  PRIVATE_CHAT_CHANNEL_ID,
} = require('../config');

function commandLines(items) {
  return items.map(([command, text]) => `\`${command}\` ${text}`).join('\n');
}

function channelText(channelId, fallback) {
  return channelId ? `<#${channelId}>` : fallback;
}

function createRizebotHelpPayload({
  showAdmin = false,
  showRegisterAdmin = showAdmin,
  showInterviewAdmin = showAdmin,
  showBridgeAdmin = showAdmin,
  showTopupAdmin = showAdmin,
  showModerationAdmin = showAdmin,
  privateChatChannelId = PRIVATE_CHAT_CHANNEL_ID,
} = {}) {
  const privateChannel = channelText(privateChatChannelId, 'channel private');
  const hasAdminSection = Boolean(
    showRegisterAdmin ||
    showInterviewAdmin ||
    showBridgeAdmin ||
    showTopupAdmin ||
    showModerationAdmin
  );

  const embed = new EmbedBuilder()
    .setColor(hasAdminSection ? 0xf2c94c : 0x2f80ed)
    .setTitle(hasAdminSection ? 'Rizebot Help - Admin' : 'Rizebot Help')
    .setDescription(
      hasAdminSection
        ? 'Command publik + command admin yang tersedia untuk akses kamu.'
        : 'Command yang bisa dipakai user biasa.'
    )
    .addFields(
      {
        name: 'User biasa',
        value: commandLines([
          ['!help', 'lihat daftar command. Alias: `!mc-help`.'],
          ['!reg <gamertag>', 'daftar Minecraft. Kalau sudah legal, command ini hanya refresh data gamertag yang sama.'],
          ['!daftar', 'alias dari `!reg`.'],
          ['!register', 'alias dari `!reg`.'],
          ['!status', 'lihat Ethergeon ID Card.'],
          ['!player <nama>', 'cek Ethergeon ID Card player lain, dengan tombol pilihan kalau hasilnya mirip.'],
          ['!organisasi [nama]', 'lihat daftar organisasi/perusahaan, atau detail anggota dan kas jika nama diisi. Alias: `!org`.'],
          ['!tf <nama> <geon>', 'transfer Geon ke player lain lewat Discord, diproses langsung oleh finance Minecraft.'],
          ['!geonrate <rupiah>', 'cek estimasi Geon dari nominal rupiah. Alias: `!kurs`, `!harga`, `!rate`.'],
          ['!member', 'lihat total member Discord saat ini.'],
        ]),
        inline: false,
      },
      {
        name: 'Member private',
        value: [
          commandLines([
            ['!timeout @user', 'buat petisi timeout.'],
          ]),
          `React trash di ${privateChannel}: 5 vote member private akan menghapus pesan.`,
        ].join('\n'),
        inline: false,
      }
    )
    .setFooter({
      text: hasAdminSection
        ? 'Admin view: command sensitif hanya muncul sesuai akses.'
        : 'Command admin disembunyikan dari user biasa.',
    });

  const registerAdminLines = [];
  if (showRegisterAdmin) {
    registerAdminLines.push(
      ['!sync-citizen', 'paksa migrasi role lama ke Ethergeon Citizen.']
    );
  }
  if (showInterviewAdmin) {
    registerAdminLines.push(
      ['!list [semua|lolos|pending|gagal] [halaman]', 'lihat registry Minecraft dengan tombol filter/page. Alias: `!registrasi`.'],
      ['!setreg @user <gamertag>', 'ubah gamertag legal setelah review manual admin/interviewer. Alias: `!ganti-reg`.'],
      ['!compile [jumlah|all]', 'compile closed interview lama ke JSON save channel, lalu hapus channel ticket.'],
      ['!archive-interviews [jumlah]', 'pindahkan backlog closed interview ke archive.']
    );
  }
  if (showModerationAdmin) {
    registerAdminLines.push(
      ['!freedom @user', 'batalkan timeout aktif.']
    );
  }
  if (registerAdminLines.length) {
    embed.addFields(
      {
        name: 'Admin Registrasi & Moderasi',
        value: commandLines(registerAdminLines),
        inline: false,
      }
    );
  }

  if (showBridgeAdmin) {
    embed.addFields(
      {
        name: 'Admin Minecraft Bridge',
        value: commandLines([
          ['!mcstatus / !mcping', 'cek status/ping bridge Minecraft BP.'],
          ['!online', 'lihat snapshot player online dari bridge Minecraft.'],
          ['!p <pesan>', 'kirim pesan Discord ke chat Minecraft dari channel chat log.'],
          ['!srcpl <nama>', 'cari player langsung dari data server Minecraft.'],
          ['!geon <nama>', 'cek wallet Geon/Ether player dari bridge Minecraft.'],
          ['!migrasi <lama> -> <baru>', 'preview dan confirm migrasi data player lama ke gamertag baru.'],
          ['!bonus <nama> <geon>', 'beri bonus Geon ke player dengan transparansi finance.'],
        ]),
        inline: false,
      }
    );
  }

  if (showTopupAdmin) {
    embed.addFields(
      {
        name: 'Admin Topup',
        value: commandLines([
          ['!tu <nama> <geon> <rupiah>', 'topup admin ke player Minecraft. Alias: `!topup`.'],
          ['!gnrtkpn <geon> <rupiah> [jumlah] [hari]', 'generate kupon topup. Alias: `!kupon`.'],
          ['!topup-help', 'lihat bantuan command topup admin.'],
        ]),
        inline: false,
      }
    );
  }

  return {
    embeds: [embed],
    allowedMentions: { parse: [], repliedUser: false },
  };
}

module.exports = { createRizebotHelpPayload };
