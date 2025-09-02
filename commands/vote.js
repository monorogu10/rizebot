const { EmbedBuilder } = require('discord.js');
const config = require('../config.json');
const dataManager = require('../utils/dataManager');

module.exports = {
    name: 'vote',
    description: 'Membuat petisi baru untuk di-vote oleh member lain.',
    async execute(message, args) {
        const userId = message.author.id;
        const petition = args.join(' ');

        if (!petition) {
            return message.reply('Harap sertakan pesan petisi Anda. Contoh: `!vote Naikkan gaji admin`');
        }

        // Inisialisasi data jika user baru
        if (!dataManager.data.users[userId]) {
            dataManager.data.users[userId] = { voteCount: 1, linkTimestamps: [] };
        }

        // Cek kuota vote
        if (dataManager.data.users[userId].voteCount <= 0) {
            return message.reply('Anda sudah tidak memiliki kuota vote. Batalkan petisi lama Anda dengan `!del-vote` atau tunggu petisi Anda selesai.');
        }

        const voteChannel = await message.client.channels.fetch(config.channelIds.vote).catch(() => null);
        if (!voteChannel) {
            return message.reply('Channel vote tidak ditemukan!');
        }
        
        const embed = new EmbedBuilder()
            .setAuthor({ name: `Petisi dari: ${message.author.username}`, iconURL: message.author.displayAvatarURL() })
            .setColor('#0099ff')
            .setTitle('📝 VOTE BARU')
            .setDescription(petition)
            .addFields({ name: 'Status', value: 'Berlangsung...', inline: true })
            .setTimestamp()
            .setFooter({ text: `Vote akan berakhir dalam ${config.voteDurationHours} jam.` });

        try {
            const voteMessage = await voteChannel.send({ embeds: [embed] });
            await voteMessage.react('👍');
            await voteMessage.react('👎');

            // Kurangi kuota vote dan simpan data petisi
            dataManager.data.users[userId].voteCount -= 1;
            const endTime = Date.now() + (config.voteDurationHours * 60 * 60 * 1000);
            dataManager.data.activeVotes[voteMessage.id] = {
                authorId: userId,
                endTime: endTime,
                petition: petition,
                channelId: voteMessage.channel.id
            };
            
            await dataManager.saveData(message.client);
            message.reply('✅ Petisi Anda berhasil dibuat di channel vote!');

            // Atur timer untuk mengakhiri vote
            setTimeout(() => {
                concludeVote(message.client, voteMessage.id);
            }, endTime - Date.now());

        } catch (error) {
            console.error('Gagal membuat vote:', error);
            message.reply('Terjadi kesalahan saat membuat petisi Anda.');
        }
    }
};

async function concludeVote(client, messageId) {
    const voteData = dataManager.data.activeVotes[messageId];
    if (!voteData) return;

    const voteChannel = await client.channels.fetch(voteData.channelId).catch(() => null);
    const accChannel = await client.channels.fetch(config.channelIds.acc).catch(() => null);

    if (!voteChannel || !accChannel) {
        console.error("Channel vote atau acc tidak ditemukan saat penyelesaian.");
        return;
    }

    try {
        const voteMessage = await voteChannel.messages.fetch(messageId);
        const agrees = voteMessage.reactions.cache.get('👍')?.count - 1 || 0;
        const disagrees = voteMessage.reactions.cache.get('👎')?.count - 1 || 0;

        let resultText, color, result;
        const user = await client.users.fetch(voteData.authorId);

        if (agrees > disagrees) {
            result = 'DITERIMA';
            resultText = `🎉 **Petisi Diterima!** (${agrees} setuju, ${disagrees} tidak setuju)`;
            color = '#00FF00';
            // Kembalikan 1 kuota + 1 kuota bonus
            dataManager.data.users[voteData.authorId].voteCount += 2;
        } else if (disagrees > agrees) {
            result = 'DITOLAK';
            resultText = `❌ **Petisi Ditolak.** (${agrees} setuju, ${disagrees} tidak setuju)`;
            color = '#FF0000';
            // Kembalikan 1 kuota
            dataManager.data.users[voteData.authorId].voteCount += 1;
        } else {
            result = 'SERI';
            resultText = `😐 **Hasil Seri!** (${agrees} setuju, ${disagrees} tidak setuju)`;
            color = '#FFFF00';
             // Kembalikan 1 kuota
            dataManager.data.users[voteData.authorId].voteCount += 1;
        }
        
        const resultEmbed = new EmbedBuilder()
            .setAuthor({ name: `Petisi dari: ${user.username}`, iconURL: user.displayAvatarURL() })
            .setColor(color)
            .setTitle(`HASIL VOTE: ${result}`)
            .setDescription(voteData.petition)
            .addFields({ name: 'Hasil Akhir', value: resultText })
            .setTimestamp();
        
        await accChannel.send({ embeds: [resultEmbed] });
        await voteMessage.delete();

    } catch (error) {
        console.error(`Gagal menyelesaikan vote untuk message ID ${messageId}:`, error);
    } finally {
        // Hapus data vote yang sudah selesai
        delete dataManager.data.activeVotes[messageId];
        await dataManager.saveData(client);
    }
}

// Ekspor fungsi ini agar bisa diakses oleh `index.js` saat restart
module.exports.concludeVote = concludeVote;