const { AttachmentBuilder } = require('discord.js');
const config = require('../config.json');

// Struktur data default
let data = {
    users: {}, // { userId: { voteCount: 1, linkTimestamps: [] } }
    activeVotes: {} // { messageId: { authorId, endTime, petition, timer } }
};

const getChannel = async (client, channelId) => {
    try {
        return await client.channels.fetch(channelId);
    } catch (error) {
        console.error(`Error: Tidak dapat menemukan channel dengan ID: ${channelId}. Pastikan bot ada di server tersebut.`);
        return null;
    }
};

const saveData = async (client) => {
    const channel = await getChannel(client, config.channelIds.save);
    if (!channel) return;

    try {
        const minifiedData = JSON.stringify(data);
        const attachment = new AttachmentBuilder(Buffer.from(minifiedData, 'utf-8'), { name: 'database.json' });
        await channel.send({ content: `Backup data terakhir: ${new Date().toISOString()}`, files: [attachment] });
    } catch (error) {
        console.error('Gagal menyimpan data:', error);
    }
};

const loadData = async (client) => {
    const saveChannel = await getChannel(client, config.channelIds.save);
    const logChannel = await getChannel(client, config.channelIds.log);

    if (!saveChannel || !logChannel) {
        console.error("Channel 'save' atau 'log' tidak ditemukan. Memulai dengan data kosong.");
        return;
    }

    try {
        const messages = await saveChannel.messages.fetch({ limit: 1 });
        const lastMessage = messages.first();

        if (lastMessage && lastMessage.attachments.size > 0) {
            const lastAttachment = lastMessage.attachments.first();
            if (lastAttachment.name === 'database.json') {
                const response = await fetch(lastAttachment.url);
                const loadedData = await response.json();
                data = loadedData;
                await logChannel.send('✅ **Data berhasil dimuat** dari backup terakhir.');
                console.log('Data berhasil dimuat.');
            } else {
                 await logChannel.send('⚠️ **Tidak ada file `database.json` ditemukan.** Memulai dengan data baru.');
            }
        } else {
            await logChannel.send('ℹ️ **Tidak ada data lama.** Bot memulai sesi baru.');
        }
    } catch (error) {
        console.error('Gagal memuat data, memulai dengan data kosong:', error);
        await logChannel.send('❌ **Gagal memuat data.** Terjadi error, bot memulai sesi baru.');
    }
};

module.exports = {
    data,
    saveData,
    loadData
};