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
          ['/help', 'lihat seluruh slash command yang tersedia.'],
          ['/register gamertag:<nama>', 'daftar atau lanjutkan registrasi Minecraft.'],
          ['/verify', 'buat kode verifikasi akun Minecraft.'],
          ['/status [user]', 'lihat Ethergeon ID Card milik sendiri atau user lain.'],
          ['/cek server', 'cek apakah bot dan server Minecraft Ethergeon aktif.'],
          ['/cek online', 'lihat snapshot player yang sedang online.'],
          ['/cek player nama:<gamertag>', 'cek data player lain dengan autocomplete.'],
          ['/member', 'lihat total member Discord saat ini.'],
        ]),
        inline: false,
      },
      {
        name: 'Ekonomi & Server',
        value: commandLines([
          ['/shop', 'lihat daftar harga terbaru ETHERGEON SHOP.'],
          ['/perusahaan', 'buka Company Control sesuai permission Minecraft.'],
          ['/organisasi [nama]', 'lihat daftar atau detail organisasi/perusahaan legal.'],
          ['/tf player|user', 'transfer Geon ke gamertag atau akun Discord terhubung.'],
          ['/tf all', 'kirim Geon per orang ke semua player lain yang online.'],
          ['/bansos geon:<n> orang:<n>', 'buat bansos dengan konfirmasi.'],
          ['/geonrate rupiah:<n>', 'cek estimasi Geon dari nominal rupiah.'],
        ]),
        inline: false,
      },
      {
        name: 'Rules & Undang-Undang',
        value: commandLines([
          ['/rules', 'lihat item/entity terlarang, dengan cache saat server offline.'],
          ['/uu lihat [pencarian]', 'baca dan cari Undang-Undang beserta status serta versinya.'],
          ['/uu help', 'tutorial lengkap sistem Undang-Undang.'],
        ]),
        inline: false,
      },
      {
        name: 'Member private',
        value: [
          commandLines([
            ['/moderasi timeout user:<user>', 'buat petisi timeout.'],
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
      ['/registry sync', 'paksa sinkronisasi status, role, dan nickname registry.']
    );
  }
  if (showInterviewAdmin) {
    registerAdminLines.push(
      ['/registry list [status] [halaman]', 'lihat registry Minecraft dengan filter dan pagination.'],
      ['/registry set-gamertag user gamertag', 'ubah gamertag legal setelah review manual.'],
      ['/interview compile [jumlah]', 'compile interview lama lalu hapus channel ticket.'],
      ['/interview archive [jumlah]', 'pindahkan backlog closed interview ke archive.']
    );
    interviewRecoveryLines.push(
      ['/interview accept [user] [gamertag] [force]', 'loloskan interview; force memulihkan record/mapping rusak.'],
      ['/interview reject [user] [alasan] [force]', 'gagalkan interview dan sinkronkan role serta akses.'],
      ['/interview close [user] [force]', 'tutup dan arsipkan interview; pending membutuhkan force.'],
      ['/interview relink user [gamertag]', 'hubungkan channel interview saat ini ke record/session yang benar.'],
      ['/interview status [user]', 'lihat registry dan histori session interview.'],
      ['/interview doctor', 'diagnosis data registry, session, channel, role, dan akses interview.'],
      ['/interview repair mode:<dry-run|apply>', 'audit atau perbaiki nomor ganda, orphan channel, dan mapping setelah backup.']
    );
  }
  if (showModerationAdmin) {
    registerAdminLines.push(
      ['/moderasi freedom user:<user>', 'batalkan timeout aktif.']
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
          ['/minecraft status|ping', 'cek status atau ping bridge Minecraft BP.'],
          ['/minecraft chat pesan:<teks>', 'kirim pesan ke chat Minecraft dari channel chat log.'],
          ['/minecraft search nama:<player>', 'cari player dari data server.'],
          ['/minecraft saldo nama:<player>', 'cek wallet Geon/Ether player.'],
          ['/minecraft migrasi lama baru', 'preview migrasi gamertag lama ke baru.'],
          ['/minecraft bonus nama jumlah', 'beri bonus Geon dengan transparansi finance.'],
        ]),
        inline: false,
      }
    );
  }

  if (showBridgeAdmin || showModerationAdmin) {
    embed.addFields({
      name: 'Admin Shop',
      value: commandLines([
        ['/shop item:<index/nama> harga:<geon>', 'ubah harga dan umumkan perubahannya.'],
      ]),
      inline: false,
    });
  }

  if (showTopupAdmin) {
    embed.addFields(
      {
        name: 'Admin Topup',
        value: commandLines([
          ['/topup kirim nama geon rupiah', 'topup admin ke player Minecraft.'],
          ['/topup kupon geon rupiah [jumlah] [hari]', 'generate kupon topup.'],
          ['/topup help', 'lihat bantuan topup admin.'],
        ]),
        inline: false,
      }
    );
  }

  if (showLawAdmin) {
    embed.addFields({
      name: 'Admin Undang-Undang',
      value: commandLines([
        ['/uu create catatan:<isi>', 'buat draft Pasal 1 Ayat (1) dan buka editor.'],
        ['/uu draft [id]', 'lanjutkan draft autosave atau draft revisi.'],
        ['/uu revise [id] [alasan]', 'buka editor revisi tanpa mengubah versi publik.'],
        ['/uu cabut id alasan', 'cabut UU tanpa menghapus arsip dan riwayatnya.'],
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
