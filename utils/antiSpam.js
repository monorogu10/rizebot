const { PermissionsBitField } = require('discord.js');
const dataManager = require('./dataManager');
const config = require('../config.json');

const linkRegex = /(https?:\/\/[^\s]+)/g;
const SPAM_COUNT = 3;
const SPAM_TIMEFRAME_MS = 60 * 1000; // 1 menit

async function checkLinkSpam(message) {
    if (!message.guild || message.author.bot) return;

    // Pengecualian untuk admin
    if (message.member.permissions.has(PermissionsBitField.Flags.Administrator) || message.member.roles.cache.some(role => role.name === config.adminRoleName)) {
        return;
    }

    if (linkRegex.test(message.content)) {
        const userId = message.author.id;
        const now = Date.now();

        // Inisialisasi data user jika belum ada
        if (!dataManager.data.users[userId]) {
            dataManager.data.users[userId] = { voteCount: 1, linkTimestamps: [] };
        }
        if (!dataManager.data.users[userId].linkTimestamps) {
            dataManager.data.users[userId].linkTimestamps = [];
        }

        const userTimestamps = dataManager.data.users[userId].linkTimestamps;
        
        // Tambahkan timestamp sekarang dan filter yang sudah lewat 1 menit
        userTimestamps.push(now);
        const recentTimestamps = userTimestamps.filter(ts => now - ts < SPAM_TIMEFRAME_MS);
        dataManager.data.users[userId].linkTimestamps = recentTimestamps;

        if (recentTimestamps.length >= SPAM_COUNT) {
            try {
                // Timeout user selama 5 menit
                await message.member.timeout(5 * 60 * 1000, 'Spam link terdeteksi');
                await message.channel.send(`🚨 **PERINGATAN KERAS** 🚨\n${message.author}, Anda telah di-timeout karena mengirim link sebanyak **${SPAM_COUNT}x** dalam 1 menit!`);
                
                // Hapus histori link setelah dihukum
                dataManager.data.users[userId].linkTimestamps = [];
                await dataManager.saveData(message.client);

            } catch (error) {
                console.error(`Gagal melakukan timeout pada ${message.author.tag}:`, error);
                message.channel.send(`Gagal melakukan timeout pada ${message.author.tag}, mungkin role saya dibawah dia.`);
            }
        }
    }
}

module.exports = { checkLinkSpam };