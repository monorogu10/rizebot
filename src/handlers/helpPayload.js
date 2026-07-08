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
  privateChatChannelId = PRIVATE_CHAT_CHANNEL_ID,
} = {}) {
  const privateChannel = channelText(privateChatChannelId, 'channel private');

  const embed = new EmbedBuilder()
    .setColor(showAdmin ? 0xf2c94c : 0x2f80ed)
    .setTitle(showAdmin ? 'Rizebot Help - Admin' : 'Rizebot Help')
    .setDescription(
      showAdmin
        ? 'Command publik + command admin yang tersedia.'
        : 'Command yang bisa dipakai user biasa.'
    )
    .addFields(
      {
        name: 'User biasa',
        value: commandLines([
          ['!help', 'lihat daftar command.'],
          ['!reg <gamertag>', 'daftar Minecraft dan buka interview akses.'],
          ['!daftar', 'alias dari `!reg`.'],
          ['!register', 'alias dari `!reg`.'],
          ['!status', 'lihat Ethergeon ID Card.'],
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
      text: showAdmin
        ? 'Admin view: command sensitif hanya muncul untuk admin.'
        : 'Command admin disembunyikan dari user biasa.',
    });

  if (showAdmin) {
    embed.addFields(
      {
        name: 'Admin Registrasi & Moderasi',
        value: commandLines([
          ['!sync-citizen', 'paksa migrasi role lama ke Ethergeon Citizen.'],
          ['!list [halaman]', 'lihat daftar register Minecraft baru.'],
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
