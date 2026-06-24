const { EmbedBuilder } = require('discord.js');
const {
  MINECRAFT_CHAT_LOG_CHANNEL_ID,
  MINECRAFT_INFO_CHANNEL_ID,
  MINECRAFT_INFO_URL,
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
  privateChatChannelId = PRIVATE_CHAT_CHANNEL_ID,
  minecraftInfoChannelId = MINECRAFT_INFO_CHANNEL_ID,
  minecraftInfoUrl = MINECRAFT_INFO_URL,
  minecraftChatLogChannelId = MINECRAFT_CHAT_LOG_CHANNEL_ID,
} = {}) {
  const privateChannel = channelText(privateChatChannelId, 'channel private');
  const mcInfo = minecraftInfoChannelId
    ? `<#${minecraftInfoChannelId}>`
    : (minecraftInfoUrl || 'channel info Minecraft');

  const embed = new EmbedBuilder()
    .setColor(showAdmin ? 0xf2c94c : 0x2f80ed)
    .setTitle(showAdmin ? '🛠️ Rizebot Help - Admin' : '📘 Rizebot Help')
    .setDescription(
      showAdmin
        ? 'Command publik + command admin yang tersedia.'
        : 'Command yang bisa dipakai user biasa.'
    )
    .addFields(
      {
        name: '👤 User biasa',
        value: commandLines([
          ['!help', 'lihat daftar command.'],
          ['!reg <gamertag>', 'daftar atau update gamertag Minecraft.'],
          ['!daftar <gamertag>', 'alias dari register Minecraft.'],
          ['!register <gamertag>', 'alias dari register Minecraft.'],
          ['!verify', 'ambil kode verify Minecraft.'],
          ['!status', 'cek apakah akun Minecraft kamu sudah verified.'],
          ['!edit-reg <gamertag>', 'ubah gamertag Minecraft.'],
          ['!out', 'hapus data register Minecraft kamu.'],
          ['!list [halaman]', 'lihat list register Minecraft.'],
          ['!list-reg', 'lihat total register Minecraft.'],
        ]),
        inline: false,
      },
      {
        name: '🗳️ Member private',
        value: [
          commandLines([
            ['!timeout @user', 'buat petisi timeout.'],
          ]),
          `React 🗑️ di ${privateChannel}: 5 vote member private akan menghapus pesan.`,
        ].join('\n'),
        inline: false,
      },
      {
        name: '🎮 Verify Minecraft',
        value: [
          '1. `!reg <gamertag>` di Discord.',
          '2. `!verify` di Discord untuk ambil kode.',
          '3. Masuk server Minecraft, lalu chat `!verify <kode>`.',
          `Info server: ${mcInfo}.`,
        ].join('\n'),
        inline: false,
      }
    )
    .setFooter({
      text: showAdmin
        ? 'Admin view: command sensitif hanya muncul untuk admin.'
        : 'Command admin disembunyikan dari user biasa.',
    });

  if (showAdmin) {
    embed.addFields(
      {
        name: '🔐 Admin Minecraft Bridge',
        value: commandLines([
          ['!mcstatus', 'cek status bridge Minecraft.'],
          ['!mcping', 'test polling BP.'],
          ['!online', 'lihat player online dari bridge.'],
          ['!srcpl <nama>', 'cari player dari data asli server Minecraft + status Discord.'],
          ['!srcsrv <nama>', 'alias dari `!srcpl`.'],
          ['!geon <nama>', 'cek saldo Geon/Ether player.'],
          ['!player <nama>', 'lihat detail player server.'],
          ['!p <pesan>', `kirim pesan Discord ke Minecraft, khusus ${channelText(minecraftChatLogChannelId, 'channel chat log')}.`],
        ]),
        inline: false,
      },
      {
        name: '💎 Admin TOPUP',
        value: commandLines([
          ['!srcpl <nama>', 'cari player dari data server sebelum topup.'],
          ['!tu <nama/key> <geon> <rupiah>', 'kirim topup ke Minecraft.'],
          ['!gnrtkpn <geon> <rupiah> [jumlah] [hari]', 'generate kupon topup.'],
          ['!topup-help', 'lihat ringkasan TOPUP admin.'],
        ]),
        inline: false,
      },
      {
        name: '🧰 Admin Registrasi & Moderasi',
        value: commandLines([
          ['!reset', 'reset semua register Minecraft dan cabut role register.'],
          ['!freedom @user', 'batalkan timeout aktif.'],
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
