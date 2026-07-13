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
          ['/register gamertag:<nama>', 'daftar Minecraft. Prefix lama tetap tersedia: `!reg <gamertag>`.'],
          ['!daftar', 'alias dari `!reg`.'],
          ['!register', 'alias dari `!reg`.'],
          ['/status [user]', 'lihat Ethergeon ID Card sendiri; admin/interviewer dapat memilih user lain. Prefix: `!status`.'],
          ['/player nama:<gamertag>', 'cek Ethergeon ID Card player lain dengan autocomplete. Prefix: `!player <nama>`.'],
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
          ['!uu-help', 'tutorial lengkap membaca, membuat, merevisi, menerbitkan, dan mencabut UU.'],
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
      ['/registry sync', 'paksa migrasi role lama ke Ethergeon Citizen. Prefix: `!sync-citizen`.']
    );
  }
  if (showInterviewAdmin) {
    registerAdminLines.push(
      ['/registry list [status] [halaman]', 'lihat registry Minecraft dengan tombol filter/page. Prefix: `!list`.'],
      ['!setreg @user <gamertag>', 'ubah gamertag legal setelah review manual admin/interviewer. Alias: `!ganti-reg`.'],
      ['!compile [jumlah|all]', 'compile closed interview lama ke JSON save channel, lalu hapus channel ticket.'],
      ['!archive-interviews [jumlah]', 'pindahkan backlog closed interview ke archive.']
    );
    interviewRecoveryLines.push(
      ['/interview accept [user] [gamertag] [force]', 'loloskan interview; force memulihkan record/mapping yang rusak. Prefix: `!accept`.'],
      ['/interview reject [user] [alasan] [force]', 'gagalkan interview dan sinkronkan role serta akses Minecraft. Prefix: `!reject`.'],
      ['/interview close [user] [force]', 'tutup dan arsipkan interview; pending membutuhkan force. Prefix: `!close`.'],
      ['/interview relink user [gamertag]', 'hubungkan channel interview saat ini ke record/session yang benar.'],
      ['/interview status [user]', 'lihat registry dan histori session interview.'],
      ['/interview doctor', 'diagnosis data registry, session, channel, role, dan akses interview.'],
      ['/interview repair mode:<dry-run|apply>', 'audit atau perbaiki nomor ganda, orphan channel, dan mapping setelah backup.']
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
        ['!draft-uu [ID/kode]', 'lanjutkan draft autosave. Alias: `!edit-uu`; kode dipakai untuk draft revisi.'],
        ['!revise-uu [nomor/kode] [| alasan]', 'pilih UU dan Pasal, lalu buka editor revisi tanpa mengubah versi publik.'],
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
