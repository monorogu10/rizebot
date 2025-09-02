const dataManager = require('../utils/dataManager');

module.exports = {
    name: 'del-vote',
    description: 'Membatalkan petisi yang sedang berjalan.',
    async execute(message, args) {
        const userId = message.author.id;
        
        // Cari vote aktif milik user
        const activeVoteId = Object.keys(dataManager.data.activeVotes).find(
            msgId => dataManager.data.activeVotes[msgId].authorId === userId
        );

        if (!activeVoteId) {
            return message.reply('Anda tidak memiliki petisi yang sedang aktif.');
        }

        const voteData = dataManager.data.activeVotes[activeVoteId];

        try {
            const voteChannel = await message.client.channels.fetch(voteData.channelId);
            const voteMessage = await voteChannel.messages.fetch(activeVoteId);
            await voteMessage.delete();

            // Kembalikan kuota vote
            dataManager.data.users[userId].voteCount += 1;
            // Hapus dari data aktif
            delete dataManager.data.activeVotes[activeVoteId];

            await dataManager.saveData(message.client);

            message.reply('✅ Petisi Anda berhasil dibatalkan dan 1 kuota vote telah dikembalikan.');

        } catch (error) {
            console.error('Gagal menghapus vote:', error);
            message.reply('Gagal menghapus petisi. Mungkin sudah dihapus atau terjadi error.');
        }
    }
};