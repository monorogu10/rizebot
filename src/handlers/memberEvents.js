const { EmbedBuilder } = require('discord.js');
const { WELCOME_CHANNEL_ID, LEAVE_CHANNEL_ID } = require('../config');

async function sendEmbed(client, channelId, embed) {
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;
  await channel.send({ embeds: [embed] }).catch(() => null);
}

function buildWelcomeEmbed(member) {
  const mention = member.user ? `<@${member.user.id}>` : 'member baru';
  const total = Number(member.guild?.memberCount) || 0;
  const avatar = member.user?.displayAvatarURL({ size: 128 });

  const embed = new EmbedBuilder()
    .setColor(0x3bb273)
    .setTitle('Selamat datang!')
    .setDescription(`Halo ${mention}, selamat bergabung di ${member.guild?.name || 'server'}!`)
    .addFields(
      { name: 'Mulai di sini', value: 'Silakan cek info penting di channel yang tersedia.' },
      { name: 'Selamat beraktivitas', value: 'Semoga betah dan enjoy di sini.' }
    )
    .setFooter({ text: `Member ke-${total}` })
    .setTimestamp();

  if (avatar) embed.setThumbnail(avatar);
  return embed;
}

function buildLeaveEmbed(member) {
  const name = member.user?.tag || member.user?.username || member.id || 'Member';
  const total = Number(member.guild?.memberCount) || 0;
  const avatar = member.user?.displayAvatarURL({ size: 128 });

  const embed = new EmbedBuilder()
    .setColor(0xe1565d)
    .setTitle('Member keluar')
    .setDescription(`${name} keluar dari server.`)
    .setFooter({ text: `Sisa member: ${total}` })
    .setTimestamp();

  if (avatar) embed.setThumbnail(avatar);
  return embed;
}

function registerMemberEvents(client) {
  client.on('guildMemberAdd', async member => {
    if (member.user?.bot) return;
    const embed = buildWelcomeEmbed(member);
    await sendEmbed(client, WELCOME_CHANNEL_ID, embed);
  });

  client.on('guildMemberRemove', async member => {
    if (member.user?.bot) return;
    const embed = buildLeaveEmbed(member);
    await sendEmbed(client, LEAVE_CHANNEL_ID, embed);
  });
}

module.exports = { registerMemberEvents };
