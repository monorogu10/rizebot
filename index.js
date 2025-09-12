require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, Partials, AttachmentBuilder } = require('discord.js');
const { Buffer } = require('node:buffer');

// --- KONFIGURASI ---
const config = {
    prefix: '!',
    botToIgnoreId: '1409389474928132108',
    welcomeChannelId: '1195884175912358031',
    leaveChannelId: '1412648951638917271',
    registrationChannelId: '1412304090146541748',
    registrationRoleId: '1412079693934624828',
    logChannelId: '1412316496830402600',
    saveDataChannelId: '1412649363037229176',
};

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildModeration // untuk audit log (opsional tapi disarankan)
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// --- Penyimpanan Data ---
let registrations = new Map();
let registrationMessageId = null;

// --- FUNGSI SAVE & LOAD DATA ---
async function saveData() {
    const channel = client.channels.cache.get(config.saveDataChannelId);
    if (!channel) return console.error("Channel save data tidak ditemukan!");

    const dataToSave = {
        registrationMessageId,
        registrations: Array.from(registrations.entries()),
    };

    const jsonString = JSON.stringify(dataToSave);
    const dataBuffer = Buffer.from(jsonString, 'utf-8');
    const attachment = new AttachmentBuilder(dataBuffer, { name: 'data.json' });

    try {
        const oldMessages = await channel.messages.fetch({ limit: 10 });
        const botMessages = oldMessages.filter(msg => msg.author.id === client.user.id);
        if (botMessages.size > 0) {
            await channel.bulkDelete(botMessages);
        }
        
        await channel.send({ content: `💾 Data backup terakhir pada: <t:${Math.floor(Date.now() / 1000)}:F>`, files: [attachment] });
        console.log('✅ Data berhasil disimpan.');
    } catch (error) {
        console.error('Gagal menyimpan data:', error);
    }
}

async function loadData() {
    const channel = client.channels.cache.get(config.saveDataChannelId);
    if (!channel) return console.error("Channel save data tidak ditemukan, memulai dengan data kosong.");

    try {
        const messages = await channel.messages.fetch({ limit: 10 });
        const lastBotMessageWithAttachment = messages
            .filter(msg => msg.author.id === client.user.id && msg.attachments.size > 0)
            .first();

        if (!lastBotMessageWithAttachment) {
            console.log('Tidak ada data save ditemukan, memulai dengan data kosong.');
            return;
        }

        const attachment = lastBotMessageWithAttachment.attachments.first();
        if (attachment.name !== 'data.json') return;

        const response = await fetch(attachment.url);
        const data = await response.json();

        registrationMessageId = data.registrationMessageId || null;
        registrations = new Map(data.registrations || []);
        
        console.log(`✅ Data berhasil dimuat. Total ${registrations.size} pendaftar.`);
    } catch (error) {
        console.error('Gagal memuat data:', error);
    }
}

// --- FUNGSI LOGGING ---
async function logActivity(embed) {
    const channel = client.channels.cache.get(config.logChannelId);
    if (!channel) return console.error("Channel log tidak ditemukan!");
    try {
        await channel.send({ embeds: [embed] });
    } catch (error) {
        console.error('Gagal mengirim log:', error);
    }
}

// --- Util kecil untuk memotong teks agar aman di Embed ---
function truncate(text, max = 1024) {
    if (!text) return '';
    return text.length > max ? text.slice(0, max - 3) + '...' : text;
}

function formatAttachments(attachments) {
    if (!attachments || attachments.size === 0) return '—';
    const lines = [];
    attachments.forEach((att, idx) => {
        lines.push(`${idx + 1}. ${att.name || 'lampiran'} (${att.contentType || 'tipe?'}): ${att.url}`);
    });
    const joined = lines.join('\n');
    return truncate(joined, 1024);
}

// --- Event Saat Bot Siap ---
client.once('ready', async () => {
    console.log(`✅ Bot siap! Login sebagai ${client.user.tag}`);
    client.user.setActivity('Para Member', { type: 'WATCHING' });
    await loadData();
    updateRegistrationMessage();
});

// --- Fungsi untuk Mengupdate Pesan List Pendaftaran ---
async function updateRegistrationMessage() {
    const channel = client.channels.cache.get(config.registrationChannelId);
    if (!channel) return console.error("Channel registrasi tidak ditemukan!");

    const embed = new EmbedBuilder()
        .setColor('#FFD700').setTitle('🌠 Pendaftaran Server Starlight')
        .setTimestamp().setFooter({ text: 'Gunakan !help untuk melihat perintah' });

    if (registrations.size === 0) {
        embed.setDescription('Saat ini belum ada member yang terdaftar.');
    } else {
        let description = '';
        let count = 1;
        registrations.forEach((gamertag, userId) => {
            // --- PERUBAHAN DI BARIS INI ---
            description += `${count}. **${gamertag}** - <@${userId}>\n`;
            count++;
        });
        embed.setDescription(description);
        embed.addFields({ name: 'Total Pendaftar', value: `${registrations.size} member` });
    }

    try {
        let message;
        if (registrationMessageId) {
            message = await channel.messages.fetch(registrationMessageId);
            await message.edit({ embeds: [embed] });
        } else {
            message = await channel.send({ embeds: [embed] });
            registrationMessageId = message.id;
            await saveData();
        }
    } catch (error) {
        console.log("Pesan registrasi lama tidak ditemukan, membuat yang baru.");
        const message = await channel.send({ embeds: [embed] });
        registrationMessageId = message.id;
        await saveData();
    }
}

// --- Fungsi Cek Link & Blokir ---
async function handleLinkDetection(message) {
    if (!message.guild || message.author.bot) return false;

    const isAdmin = message.member?.permissions.has(PermissionsBitField.Flags.Administrator);
    if (isAdmin) return false;

    const isLink = /https?:\/\/[^\s]+/g.test(message.content);
    if (isLink) {
        await message.delete().catch(console.error);
        const warningMsg = await message.channel.send(`${message.author}, dilarang mengirim link di server ini!`);
        setTimeout(() => warningMsg.delete().catch(console.error), 5000);

        const logEmbed = new EmbedBuilder()
            .setColor('#E74C3C').setTitle('🔗 Link Terdeteksi & Diblokir')
            .addFields(
                { name: 'Member', value: `${message.author} (${message.author.id})`, inline: true },
                { name: 'Channel', value: `${message.channel}`, inline: true },
                { name: 'Isi Pesan', value: `\`\`\`${truncate(message.content, 1000)}\`\`\`` }
            ).setTimestamp();
        await logActivity(logEmbed);
        return true;
    }
    return false;
}

// --- EVENT HANDLERS ---
client.on('messageCreate', async message => {
    if (await handleLinkDetection(message)) return;

    // --- FITUR JAWAB OTOMATIS KATA KUNCI ---
    const words = message.content.toLowerCase().split(/\s+/);
    if (words.includes('monodeco') || words.includes('decorize')) {
        // ... (kode ini tidak diubah)
    }

    // --- COMMAND HANDLER ---
    if (!message.content.startsWith(config.prefix)) return;
    const args = message.content.slice(config.prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'ping') {
        message.reply(`Pong! 🏓 Latency: ${Date.now() - message.createdTimestamp}ms.`);
    } else if (command === 'reg') {
        if (registrations.has(message.author.id)) return message.reply('Kamu sudah terdaftar!');
        const gamertag = args.join(' ');
        if (!gamertag) return message.reply('Contoh: `!reg NamaGamertag`');
        const role = message.guild.roles.cache.get(config.registrationRoleId);
        if (!role) return message.reply('Error: Role pendaftaran tidak ditemukan.');
        try {
            await message.member.roles.add(role);
            registrations.set(message.author.id, gamertag);
            await updateRegistrationMessage();
            await saveData();
            message.reply(`✅ Registrasi berhasil dengan gamertag **${gamertag}**.`);
        } catch (error) { message.reply('Terjadi kesalahan.'); console.error(error); }
    } else if (command === 'edit-reg') {
        if (!registrations.has(message.author.id)) return message.reply('Kamu belum terdaftar.');
        const newGamertag = args.join(' ');
        if (!newGamertag) return message.reply('Contoh: `!edit-reg GamertagBaru`');
        registrations.set(message.author.id, newGamertag);
        await updateRegistrationMessage();
        await saveData();
        message.reply(`✅ Gamertag kamu diubah menjadi **${newGamertag}**.`);
    } else if (command === 'del-reg') {
        if (!registrations.has(message.author.id)) return message.reply('Kamu belum terdaftar.');
        const role = message.guild.roles.cache.get(config.registrationRoleId);
        if (role) await message.member.roles.remove(role).catch(console.error);
        registrations.delete(message.author.id);
        await updateRegistrationMessage();
        await saveData();
        message.reply('☑️ Pendaftaran kamu telah dibatalkan.');
    } else if (command === 'help') {
        const helpEmbed = new EmbedBuilder()
            .setColor('#3498db').setTitle('📜 Bantuan Perintah Registrasi')
            .addFields(
                { name: '`!reg [gamertag]`', value: 'Mendaftarkan dirimu.', inline: false },
                { name: '`!edit-reg [gamertag baru]`', value: 'Mengubah gamertag.', inline: false },
                { name: '`!del-reg`', value: 'Membatalkan pendaftaran.', inline: false }
            );
        message.channel.send({ embeds: [helpEmbed] });
    }
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
    if (newMessage.partial) await newMessage.fetch().catch(() => { return; });
    await handleLinkDetection(newMessage);
});

client.on('messageReactionAdd', async (reaction) => {
    if (reaction.partial) await reaction.fetch().catch(() => { return; });
    if (reaction.emoji.name === '🗑️' && reaction.count >= 10) {
        const message = reaction.message;
        if (message.author.bot || message.author.id === config.botToIgnoreId) return;
        const member = await message.guild.members.fetch(message.author.id).catch(() => null);
        if (member && member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        try {
            await message.delete();
            const confirmation = await message.channel.send(`🗑️ Pesan dari ${message.author} telah dihapus.`);
            setTimeout(() => confirmation.delete().catch(console.error), 5000);
        } catch (error) { console.error('Gagal hapus via reaksi:', error); }
    }
});

// --- DETEKSI PESAN DIHAPUS & LOG KE CHANNEL ---
async function findDeleterAuditLog(guild, targetUserId) {
    // Mencoba cari siapa yang menghapus melalui Audit Log (type: Message Delete = 72)
    // Perlu permission "View Audit Log" pada bot.
    try {
        const fetched = await guild.fetchAuditLogs({ type: 72, limit: 5 }); // 72 = MessageDelete
        const now = Date.now();
        const entry = fetched.entries.find(e => {
            // kadang 'target' bisa user, kadang null; cek kedekatan waktu juga
            const closeInTime = now - e.createdTimestamp < 10_000; // dalam 10 detik terakhir
            const sameTarget = e.target && e.target.id ? (e.target.id === targetUserId) : true; // fallback jika null
            return closeInTime && sameTarget;
        });
        if (entry) {
            return entry.executor; // User yang mengeksekusi penghapusan
        }
    } catch (err) {
        // Abaikan jika tidak ada izin / gagal
    }
    return null;
}

client.on('messageDelete', async (message) => {
    try {
        // Pastikan data terisi jika partial
        if (message.partial) {
            try { await message.fetch(); } catch { /* tetap lanjut dengan data yang ada */ }
        }
        if (!message.guild) return; // DM tidak dilog
        // Abaikan penghapusan pesan bot sendiri? Biasanya tetap berguna untuk dilog.
        // Jika ingin abaikan, uncomment baris berikut:
        // if (message.author?.bot) return;

        const authorTag = message.author ? `${message.author.tag} (${message.author.id})` : 'Tidak diketahui';
        const channelMention = message.channel ? `${message.channel}` : 'Tidak diketahui';
        const content = message.content ? message.content : (message.partial ? '[Konten tidak tersedia (partial)]' : '[Tidak ada konten]');
        const attachmentsInfo = formatAttachments(message.attachments);

        // Coba cari siapa yang menghapus
        let deleterText = 'Tidak diketahui';
        if (message.guild && message.guild.members.me?.permissions.has(PermissionsBitField.Flags.ViewAuditLog)) {
            const deleter = await findDeleterAuditLog(message.guild, message.author?.id);
            if (deleter) deleterText = `${deleter.tag} (${deleter.id})`;
        }

        const embed = new EmbedBuilder()
            .setColor('#ff6b6b')
            .setTitle('🗑️ Pesan Dihapus')
            .addFields(
                { name: 'Penulis', value: authorTag, inline: false },
                { name: 'Channel', value: channelMention, inline: false },
                { name: 'Dihapus oleh', value: deleterText, inline: false },
                { name: 'Isi Pesan', value: content.trim() ? `\`\`\`${truncate(content, 1000)}\`\`\`` : '—', inline: false },
                { name: 'Lampiran', value: attachmentsInfo, inline: false }
            )
            .setFooter({ text: `Message ID: ${message.id}` })
            .setTimestamp();

        await logActivity(embed);
    } catch (error) {
        console.error('Gagal melog messageDelete:', error);
    }
});

client.on('messageDeleteBulk', async (messages) => {
    try {
        // messages adalah Collection<Message>
        const first = messages.first();
        const guild = first?.guild;
        const channel = first?.channel;

        let deleterText = 'Tidak diketahui';
        if (guild && guild.members.me?.permissions.has(PermissionsBitField.Flags.ViewAuditLog)) {
            const deleter = await findDeleterAuditLog(guild, null);
            if (deleter) deleterText = `${deleter.tag} (${deleter.id})`;
        }

        const count = messages.size;
        const sampleLines = [];
        let i = 0;
        for (const msg of messages.values()) {
            i++;
            const author = msg.author ? `${msg.author.tag}` : 'Unknown';
            const content = msg.content ? truncate(msg.content.replace(/\n/g, ' '), 120) : (msg.partial ? '[partial]' : '[empty]');
            sampleLines.push(`${i}. ${author}: ${content}`);
            if (i >= 10) break; // contoh maksimal 10 baris agar tidak kepanjangan
        }

        const embed = new EmbedBuilder()
            .setColor('#ff9f43')
            .setTitle('🧹 Bulk Delete Terdeteksi')
            .addFields(
                { name: 'Jumlah Pesan', value: String(count), inline: true },
                { name: 'Channel', value: channel ? `${channel}` : 'Tidak diketahui', inline: true },
                { name: 'Dihapus oleh', value: deleterText, inline: false },
                { name: 'Contoh (max 10)', value: sampleLines.length ? `\`\`\`\n${sampleLines.join('\n')}\n\`\`\`` : '—', inline: false }
            )
            .setTimestamp();

        await logActivity(embed);
    } catch (error) {
        console.error('Gagal melog messageDeleteBulk:', error);
    }
});

client.on('guildMemberAdd', async member => {
    const channel = member.guild.channels.cache.get(config.welcomeChannelId);
    if (!channel) return;
    const embed = new EmbedBuilder()
        .setColor('#2ecc71').setTitle(`👋 Selamat Datang di ${member.guild.name}!`)
        .setDescription(`Halo ${member}, selamat bergabung!`)
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
        .addFields({ name: 'Total Member', value: `${member.guild.memberCount} member` })
        .setTimestamp();
    channel.send({ embeds: [embed] });
});

client.on('guildMemberRemove', async member => {
    if (registrations.has(member.id)) {
        registrations.delete(member.id);
        await updateRegistrationMessage();
        await saveData();
        console.log(`Data registrasi untuk ${member.user.tag} telah dihapus karena keluar.`);
    }
    const channel = member.guild.channels.cache.get(config.leaveChannelId);
    if (!channel) return;
    const embed = new EmbedBuilder()
        .setColor('#e74c3c').setTitle('😢 Selamat Tinggal...')
        .setDescription(`**${member.user.tag}** telah meninggalkan server.`)
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
        .addFields({ name: 'Total Member', value: `${member.guild.memberCount} member` })
        .setTimestamp();
    channel.send({ embeds: [embed] });
});

client.login(process.env.DISCORD_TOKEN);
