const { PermissionsBitField } = require('discord.js');
const dataManager = require('../utils/dataManager');

module.exports = {
    name: 'save',
    description: 'Menyimpan semua data bot secara manual ke channel save. (Hanya Admin)',
    async execute(message, args) {
        // Cek apakah pengguna memiliki izin Administrator
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return message.reply('❌ Anda tidak memiliki izin untuk menggunakan perintah ini.');
        }

        try {
            await message.channel.send('💾 **Menyimpan data...** Mohon tunggu.');
            await dataManager.saveData(message.client);
            await message.channel.send('✅ **Data berhasil disimpan secara manual!**');
            console.log(`Data disimpan secara manual oleh ${message.author.tag}`);
        } catch (error) {
            console.error('Gagal saat menyimpan data manual:', error);
            await message.channel.send('❌ **Terjadi error saat mencoba menyimpan data.**');
        }
    }
};