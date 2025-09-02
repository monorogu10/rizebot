require('dotenv').config(); // <-- BARIS BARU: Muat variabel dari file .env

const { Client, GatewayIntentBits, Collection, EmbedBuilder, PermissionsBitField } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('./config.json');
const dataManager = require('./utils/dataManager');
const { checkLinkSpam } = require('./utils/antiSpam');
const { concludeVote } = require('./commands/vote');


const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions
    ]
});

// Koleksi untuk menyimpan command
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    client.commands.set(command.name, command);
}


client.once('ready', async () => {
    console.log(`Bot siap! Login sebagai ${client.user.tag}`);
    client.user.setActivity('Mengawasi Member', { type: 'WATCHING' });

    // Muat data saat bot menyala
    await dataManager.loadData(client);

    // Setelah data dimuat, setel ulang timer untuk vote yang masih aktif
    Object.keys(dataManager.data.activeVotes).forEach(messageId => {
        const vote = dataManager.data.activeVotes[messageId];
        const timeLeft = vote.endTime - Date.now();

        if (timeLeft > 0) {
            console.log(`Menjadwalkan ulang vote untuk message ID: ${messageId}`);
            setTimeout(() => concludeVote(client, messageId), timeLeft);
        } else {
            // Jika waktu sudah habis saat bot offline, langsung selesaikan
            console.log(`Menyelesaikan vote yang terlewat untuk message ID: ${messageId}`);
            concludeVote(client, messageId);
        }
    });
});

client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;

    // 1. Cek Link Spam
    await checkLinkSpam(message);

    // 2. Cek keyword "monodeco" atau "decorize"
    const contentLower = message.content.toLowerCase();
    if (contentLower.includes('monodeco') || contentLower.includes('decorize')) {
        const embed = new EmbedBuilder()
            .setColor('#3498db')
            .setTitle('Monodeco Downloader')
            .setDescription('Silakan download resource yang Anda butuhkan melalui link di bawah ini.')
            .addFields({ name: 'Link Download', value: '➡️ [Klik di sini](https://monodeco.my.id) ⬅️' })
            .setThumbnail('https://i.imgur.com/example.png') // Ganti dengan URL logo jika ada
            .setTimestamp();
        
        message.channel.send({ embeds: [embed] });
    }

    // 3. Command Handler
    if (!message.content.startsWith(config.prefix)) return;

    const args = message.content.slice(config.prefix.length).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();

    const command = client.commands.get(commandName);

    if (!command) return;

    try {
        await command.execute(message, args);
    } catch (error) {
        console.error(error);
        message.reply('Terjadi error saat menjalankan perintah itu!');
    }
});


// EVENT HANDLER UNTUK REACTION
client.on('messageReactionAdd', async (reaction, user) => {
    // Abaikan jika reaction dari bot
    if (user.bot) return;

    // Hanya proses jika emoji adalah 🗑️
    if (reaction.emoji.name === '🗑️') {
        if (reaction.partial) {
            try {
                await reaction.fetch();
            } catch (error) {
                console.error('Gagal mengambil data reaction:', error);
                return;
            }
        }

        const message = reaction.message;
        if (!message.guild) return;

        try {
            const messageAuthorMember = await message.guild.members.fetch(message.author.id);
            if (messageAuthorMember.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return; 
            }

            // (Saya lihat Anda mengubahnya menjadi 3, jadi saya sesuaikan)
            if (reaction.count >= 3) {
                await message.delete();
                const embed = new EmbedBuilder()
                    .setColor('#6c757d')
                    .setDescription(`🗑️ Pesan dari ${message.author} telah dibuang atas permintaan komunitas.`);
                const reply = await message.channel.send({ embeds: [embed] });
                setTimeout(() => {
                    reply.delete().catch(console.error);
                }, 5000);
            }
        } catch (error) {
            console.error('Terjadi error pada fitur hapus via reaction:', error);
        }
    }
});

// <-- PERUBAHAN DI SINI: Login menggunakan token dari .env
client.login(process.env.DISCORD_TOKEN);