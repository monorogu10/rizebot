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
  showLawAdmin = showAdmin,
  privateChatChannelId = PRIVATE_CHAT_CHANNEL_ID,
} = {}) {
  const privateChannel = channelText(privateChatChannelId, 'channel private');
  const hasAdminSection = Boolean(
    showRegisterAdmin ||
    showInterviewAdmin ||
    showBridgeAdmin ||
    showTopupAdmin ||
    showModerationAdmin ||
    showLawAdmin
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
          ['!organisasi [nama]', 'lihat daftar berhalaman, atau detail anggota, kas, holding, dan pemegang saham jika nama diisi. Alias: `!org`.'],
          ['!member', 'lihat total member Discord saat ini.'],
        ]),
        inline: false,
      },
      {
        name: 'Ekonomi & Server',
        value: commandLines([
          ['!shop', 'lihat daftar harga terbaru ETHERGEON SHOP langsung dari server.'],
          ['!perusahaan', 'buka Company Control untuk tambah, edit, atau hapus divisi sesuai permission Minecraft.'],
          ['!tf <nama/mention> <geon> [alasan]', 'transfer Geon dengan alasan opsional yang tampil di server.'],
          ['!tf --all <geon>', 'kirim Geon per orang ke semua player lain yang sedang online.'],
          ['!bansos <geon> <orang>', 'buat bansos dengan konfirmasi; claim tetap dilakukan di server Minecraft.'],
          ['!geonrate <rupiah>', 'cek estimasi Geon dari nominal rupiah. Alias: `!kurs`, `!harga`, `!rate`.'],
        ]),
        inline: false,
      },
      {
        name: 'Rules & Undang-Undang',
        value: commandLines([
          ['!rules', 'lihat item/entity terlarang langsung dari sistem keamanan Minecraft, dengan cache saat server offline.'],
          ['!uu [nomor/kode/kata]', 'baca dan cari Undang-Undang Ethergeon beserta status serta versinya.'],
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
  const interviewRecoveryLines = [];
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
    interviewRecoveryLines.push(
      ['!accept [--force] [@user] [gamertag]', 'loloskan interview; mode force memulihkan record/mapping yang rusak.'],
      ['!reject [--force] [@user] [alasan]', 'gagalkan interview dan sinkronkan role serta akses Minecraft.'],
      ['!close [--force] [@user]', 'tutup dan arsipkan interview; pending membutuhkan force.'],
      ['!relink-interview @user [gamertag]', 'hubungkan channel interview saat ini ke record/session yang benar.'],
      ['!interview-status [@user]', 'lihat registry dan histori session interview.'],
      ['!repair-interviews --dry-run/--apply', 'audit atau perbaiki nomor ganda, orphan channel, dan mapping setelah backup.']
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

  if (interviewRecoveryLines.length) {
    embed.addFields({
      name: 'Admin Interview Recovery',
      value: commandLines(interviewRecoveryLines),
      inline: false,
    });
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

  if (showBridgeAdmin || showModerationAdmin) {
    embed.addFields({
      name: 'Admin Shop',
      value: commandLines([
        ['!shopsetting <index/nama> <geon>', 'ubah harga shop dan umumkan kenaikan/penurunan di server serta Discord.'],
      ]),
      inline: false,
    });
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

  if (showLawAdmin) {
    embed.addFields({
      name: 'Admin Undang-Undang',
      value: commandLines([
        ['!create-uu <catatan>', 'buat draft Pasal 1 Ayat (1), lalu edit judul/Pasal/Ayat dan terbitkan lewat panel.'],
        ['!draft-uu [ID]', 'lanjutkan draft terakhir atau buka draft berdasarkan ID. Alias: `!edit-uu`.'],
        ['!revise-uu <nomor/kode> | <catatan>', 'buat versi revisi baru setelah konfirmasi.'],
        ['!cabut-uu <nomor/kode> | <alasan>', 'cabut UU tanpa menghapus arsip dan riwayatnya.'],
      ]),
      inline: false,
    });
  }

  return {
    embeds: [embed],
    allowedMentions: { parse: [], repliedUser: false },
  };
}

module.exports = { createRizebotHelpPayload };
