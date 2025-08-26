require('dotenv').config();
const { Client, GatewayIntentBits, PermissionsBitField, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const helpEmbed = require('./help.js');

const c = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] });

// --- Konfigurasi & Database ---
const { GAME_CHANNEL_ID, STORAGE_CHANNEL_ID, ADMIN_CHANNEL_ID, REQUEST_CHANNEL_ID, ADMIN_ROLE_ID } = process.env;
const MONSTER_NAMES = {
    Common: ['Pidgey', 'Rattata', 'Caterpie', 'Weedle', 'Zubat', 'Geodude', 'Magikarp'],
    Rare: ['Pikachu', 'Vulpix', 'Growlithe', 'Abra', 'Machop', 'Ponyta', 'Gastly', 'Scyther', 'Pinsir'],
    Elite: ['Snorlax', 'Lapras', 'Dratini', 'Articuno', 'Zapdos', 'Moltres', 'Mewtwo', 'Mew']
};
let ITEMS = { 'ticket': { name: 'Ticket Request Furniture', cost: 10000, type: 'consumable', stock: Infinity, desc: 'Gunakan untuk request custom furniture' } };

// --- State Game ---
let monsters = [], players = {};

// --- Helper Functions ---
const spawnMonster = () => {
    const tiers = [{ t: 'Common', hp: 20, w: 70, atk: [4, 7] }, { t: 'Rare', hp: 40, w: 25, atk: [7, 11] }, { t: 'Elite', hp: 80, w: 5, atk: [10, 15] }];
    const totalW = tiers.reduce((s, t) => s + t.w, 0); let r = Math.random() * totalW;
    for (const tier of tiers) {
        if (r < tier.w) {
            const names = MONSTER_NAMES[tier.t];
            const name = names[Math.floor(Math.random() * names.length)];
            return { tier: tier.t, name: name, maxHp: tier.hp, hp: tier.hp, atk: tier.atk };
        } r -= tier.w;
    }
};

// --- [PERBAIKAN] saveData dengan replacer untuk menangani Infinity ---
const saveData = async (isAuto = false) => {
    try {
        // Replacer: Jika value adalah Infinity, ubah jadi string "Infinity"
        const replacer = (key, value) => (value === Infinity ? "Infinity" : value);
        const data = JSON.stringify({ players, monsters, ITEMS }, replacer); // Gunakan replacer di sini
        const fileName = 'game_data.json';
        fs.writeFileSync(`./${fileName}`, data);
        
        const channel = await c.channels.fetch(STORAGE_CHANNEL_ID).catch(() => null);
        if (channel) {
            await channel.send({ 
                content: isAuto ? `💾 Autosave @ ${new Date().toISOString()}` : `💾 Manual save @ ${new Date().toISOString()}`, 
                files: [new AttachmentBuilder(`./${fileName}`)] 
            });
        }
    } catch (error) {
        console.error('Save failed:', error);
    }
};

// --- [PERBAIKAN] loadData dengan reviver untuk mengubah "Infinity" kembali ---
const loadData = async () => {
    console.log('Mencoba memuat data terakhir dari channel storage...');
    try {
        const channel = await c.channels.fetch(STORAGE_CHANNEL_ID);
        const lastMessages = await channel.messages.fetch({ limit: 50 });
        const lastSaveMsg = lastMessages.find(msg => msg.attachments.size > 0 && msg.attachments.first().name.endsWith('.json'));

        if (lastSaveMsg) {
            const fileUrl = lastSaveMsg.attachments.first().url;
            const response = await fetch(fileUrl);
            const textData = await response.text();
            
            // Reviver: Jika value adalah string "Infinity", ubah kembali jadi Infinity
            const reviver = (key, value) => (value === "Infinity" ? Infinity : value);
            const data = JSON.parse(textData, reviver); // Gunakan reviver di sini
            
            players = data.players || {};
            monsters = data.monsters || [];
            ITEMS = data.ITEMS || ITEMS;
            console.log('✅ Data berhasil dimuat dari save terakhir di channel storage.');
            return;
        }
    } catch (error) {
        console.error('Gagal memuat dari channel, mencoba memuat dari file lokal...', error);
    }

    if (fs.existsSync('./game_data.json')) {
        try {
            const textData = fs.readFileSync('./game_data.json', 'utf8');
            const reviver = (key, value) => (value === "Infinity" ? Infinity : value);
            const data = JSON.parse(textData, reviver);
            players = data.players || {};
            monsters = data.monsters || [];
            ITEMS = data.ITEMS || ITEMS;
            console.log('✅ Data berhasil dimuat dari file lokal.');
            return;
        } catch (error) {
            console.error('Gagal memuat file lokal.', error);
        }
    }

    console.log('Tidak ada data save ditemukan. Memulai game baru...');
    monsters = [];
    for (let i = 0; i < 5; i++) monsters.push(spawnMonster());
};

// --- Event Ready (c.on('ready',...)) dan Event Pesan (c.on('messageCreate',...)) ---
// Kode di bawah ini TIDAK PERLU DIUBAH sama sekali.
// Cukup ganti dua fungsi di atas (saveData dan loadData) di file Anda.
// Saya tetap sertakan di sini untuk kelengkapan.

c.on('ready', async () => {
    await loadData();
    console.log('WELCOME TO ETHERNIA HUNT');
    setInterval(() => saveData(true), 300000); 

    try {
        const channel = await c.channels.fetch(process.env.GAME_CHANNEL_ID);
        if (!channel || !channel.isTextBased()) return console.error('Channel game tidak ditemukan.');
        
        console.log(`Membersihkan chat di channel: ${channel.name}...`);
        let fetched;
        do {
            fetched = await channel.messages.fetch({ limit: 100 });
            const messagesToDelete = fetched.filter(msg => Date.now() - msg.createdTimestamp < 1209600000);
            if (messagesToDelete.size > 0) await channel.bulkDelete(messagesToDelete, true);
        } while (fetched.size >= 100);
        console.log('Pembersihan selesai.');

        await channel.send('## ⚔️ WELCOME TO ETHERNIA HUNT! ⚔️\n\nChannel telah dibersihkan dan data game terakhir berhasil dimuat. Petualangan siap dimulai! Gunakan `!help` untuk melihat daftar perintah.');

    } catch (error) {
        console.error("Gagal membersihkan channel:", error);
    }
});

c.on('messageCreate', async m => {
    if (m.author.bot || ![GAME_CHANNEL_ID, ADMIN_CHANNEL_ID].includes(m.channel.id)) return;
    const args = m.content.split(' '), cmd = args.shift().toLowerCase(), id = m.author.id;
    const p = players[id] ??= { hp: 100, maxHp: 100, coin: 10, kills: 0, catches: 0, combat: null, inv: {}, eq: { weapon: null, armor: null } };
    const isAdmin = m.member && m.member.roles.cache.has(ADMIN_ROLE_ID);

    if (cmd === '!help') { return m.reply({ embeds: [helpEmbed] }); }
    if (cmd === '!stats') return m.reply(`**${m.author.username} Stats:**\n**HP:** ${p.hp}/${p.maxHp} | **Coin:** ${p.coin}\n**Kills:** ${p.kills} | **Catches:** ${p.catches}\n**Monsters in Wild:** ${monsters.length}/151`);
    if (cmd === '!shop') return m.reply(`**Toko Ethernia:**\n${Object.entries(ITEMS).map(([key, item]) => `- **${item.name}** (${item.desc}): ${item.cost} coin | Stok: ${item.stock} (\`!buy ${key}\`)`).join('\n')}`);
    if (cmd === '!inv') return m.reply(`**Inventory:**\n${Object.entries(p.inv).filter(([, qty]) => qty > 0).map(([key, qty]) => `- ${ITEMS[key]?.name || key}: ${qty}`).join('\n') || 'Kosong'}\n**Equipped:**\n- Weapon: ${p.eq.weapon ? ITEMS[p.eq.weapon]?.name : 'None'}\n- Armor: ${p.eq.armor ? ITEMS[p.eq.armor]?.name : 'None'}`);
    
    if (cmd === '!buy') {
        const itemKey = args[0]?.toLowerCase(), item = ITEMS[itemKey];
        if (!item) return m.reply('Item tidak ditemukan.');
        if (item.stock <= 0) return m.reply('Stok item ini sudah habis.');
        if (p.coin < item.cost) return m.reply('Koin tidak cukup.');
        p.coin -= item.cost; if(item.stock !== Infinity) item.stock--; p.inv[itemKey] = (p.inv[itemKey] || 0) + 1;
        return m.reply(`Kamu membeli **${item.name}**.`);
    }

    if (cmd === '!use' && args[0]?.toLowerCase() === 'ticket') {
        if (!p.inv['ticket'] || p.inv['ticket'] < 1) return m.reply('Kamu tidak punya Ticket Request.');
        return m.reply('Silakan gunakan perintah `!request [pesanmu]` dan lampirkan 1 gambar referensi.');
    }

    if (cmd === '!request') {
        if (!p.inv['ticket'] || p.inv['ticket'] < 1) return m.reply('Kamu harus punya Ticket Request untuk menggunakan perintah ini.');
        if (m.attachments.size !== 1) return m.reply('Harap lampirkan 1 gambar referensi.');
        const requestMsg = args.join(' ');
        if (!requestMsg) return m.reply('Pesan request tidak boleh kosong.');
        const reqChannel = await c.channels.fetch(REQUEST_CHANNEL_ID).catch(() => null);
        if (!reqChannel) return m.reply('Channel request tidak ditemukan, hubungi admin.');
        p.inv['ticket']--;
        const embed = new EmbedBuilder().setColor(0x00AE86).setTitle('Furniture Request Baru').setAuthor({ name: m.author.tag, iconURL: m.author.displayAvatarURL() }).addFields({ name: 'Request dari Player', value: requestMsg }).setImage(m.attachments.first().url).setTimestamp();
        await reqChannel.send({ embeds: [embed] });
        return m.reply('Request kamu telah dikirim ke admin!');
    }

    if (cmd === '!equip') {
        const itemKey = args[0]?.toLowerCase(), item = ITEMS[itemKey];
        if (!item) return m.reply(`Item dengan key '${args[0]}' tidak ditemukan di database toko.`);
        if (!p.inv[itemKey] || p.inv[itemKey] < 1) return m.reply('Kamu tidak punya item itu.');
        if (!['weapon', 'armor'].includes(item.type)) return m.reply('Item ini tidak bisa di-equip.');
        if (p.eq[item.type]) p.inv[p.eq[item.type]] = (p.inv[p.eq[item.type]] || 0) + 1;
        p.inv[itemKey]--; p.eq[item.type] = itemKey;
        return m.reply(`Kamu memakai **${item.name}**.`);
    }

    if (cmd === '!unequip') {
        const type = args[0]?.toLowerCase();
        if (!['weapon', 'armor'].includes(type)) return m.reply('Gunakan `!unequip weapon` atau `!unequip armor`.');
        if (!p.eq[type]) return m.reply(`Tidak ada ${type} yang sedang dipakai.`);
        const itemKey = p.eq[type];
        p.inv[itemKey] = (p.inv[itemKey] || 0) + 1; p.eq[type] = null;
        return m.reply(`Kamu melepas **${ITEMS[itemKey].name}**.`);
    }

    if (cmd === '!give') {
        const itemKey = args[0]?.toLowerCase(), target = m.mentions.members.first();
        if (!target || target.user.bot) return m.reply('Sebutkan member yang valid.');
        if (!p.inv[itemKey] || p.inv[itemKey] < 1) return m.reply('Kamu tidak punya item itu.');
        p.inv[itemKey]--;
        const targetP = players[target.id] ??= { hp: 100, maxHp: 100, coin: 10, kills: 0, catches: 0, combat: null, inv: {}, eq: { weapon: null, armor: null } };
        targetP.inv[itemKey] = (targetP.inv[itemKey] || 0) + 1;
        return m.reply(`Kamu memberikan **${ITEMS[itemKey].name}** kepada ${target.displayName}.`);
    }

    if (cmd === '!top5') {
        const sorted = Object.entries(players).sort(([, a], [, b]) => b.coin - a.coin).slice(0, 5);
        if (!sorted.length) return m.reply('Belum ada data di leaderboard.');
        const userPromises = sorted.map(([uid]) => c.users.fetch(uid).catch(() => ({ username: 'Unknown User' })));
        const users = await Promise.all(userPromises);
        return m.reply(`**Top 5 Terkaya:**\n${sorted.map(([, data], i) => `${i + 1}. **${users[i].username}** - ${data.coin} coin`).join('\n')}`);
    }

    if (isAdmin && m.channel.id === ADMIN_CHANNEL_ID) {
        if (cmd === '!get') {
            const item = args[0]?.toLowerCase(); const qty = parseInt(args[1]) || 1;
            if (isNaN(qty)) return m.reply('Jumlah harus berupa angka.');
            if (item === 'coin') { p.coin += qty; return m.reply(`Menambahkan ${qty} coin.`); }
            if (!ITEMS[item]) return m.reply('Item tidak ada di database toko.');
            p.inv[item] = (p.inv[item] || 0) + qty; return m.reply(`Mendapatkan ${qty} ${ITEMS[item].name}.`);
        }
        if (cmd === '!drop') {
            const item = args[0]?.toLowerCase(); const qty = parseInt(args[1]) || 1;
            if (isNaN(qty)) return m.reply('Jumlah harus berupa angka.');
            if (item === 'coin') { p.coin = Math.max(0, p.coin - qty); return m.reply(`Menghapus ${qty} coin.`); }
            if (!p.inv[item] || p.inv[item] < qty) return m.reply('Item di inventory tidak cukup untuk dihapus.');
            p.inv[item] -= qty; return m.reply(`Menghapus ${qty} ${ITEMS[item].name}.`);
        }
        if (cmd === '!additem') {
            const [key, name, cost, type, bonus, stock, ...desc] = args;
            if (args.length < 7) return m.reply('Format: `!additem key "Nama Item" cost type bonus stock "deskripsi"`');
            ITEMS[key.toLowerCase()] = { name: name.replace(/"/g, ''), cost: parseInt(cost), type, bonus: parseInt(bonus), stock: parseInt(stock), desc: desc.join(' ').replace(/"/g, '') };
            return m.reply(`Item **${name.replace(/"/g, '')}** telah ditambahkan ke toko.`);
        }
        if (cmd === '!load' && m.attachments.size > 0) {
            const file = m.attachments.first();
            if (file.name.endsWith('.json')) {
                try {
                    const res = await fetch(file.url); const data = await res.json();
                    players = data.players || {}; monsters = data.monsters || []; ITEMS = data.ITEMS || ITEMS;
                    return m.reply('✅ **Game data berhasil di-load dari file!** Ini akan menimpa data saat ini.');
                } catch (e) { console.error(e); return m.reply('❌ Gagal mem-parsing file JSON.'); }
            }
        }
    }
    if (cmd === '!save') { if (p.combat) return m.reply('Selesaikan pertarungan dulu!'); await saveData(); return m.reply('💾 **Game data berhasil disimpan secara manual...** Cek channel penyimpanan.'); }

    if (m.channel.id !== GAME_CHANNEL_ID) return;
    if (cmd === '!go') {
        if (p.combat) return m.reply('Kamu sudah dalam pertarungan!');
        if (!monsters.length) return m.reply('Hutan sepi, coba lagi nanti.');
        p.combat = monsters.shift(); return m.reply(`Kamu bertemu **${p.combat.name}** (*${p.combat.tier}*) (HP: ${p.combat.hp})!\nGunakan \`!atk\`, \`!catch\`, atau \`!run\`.`);
    }
    if (!p.combat) { if (['!atk', '!catch', '!run'].includes(cmd)) m.reply('Gunakan `!go` untuk mencari monster.'); return; }

    const monster = p.combat;
    if (cmd === '!atk') {
        const wepBonus = p.eq.weapon && ITEMS[p.eq.weapon] ? ITEMS[p.eq.weapon].bonus : 0;
        const armBonus = p.eq.armor && ITEMS[p.eq.armor] ? ITEMS[p.eq.armor].bonus : 0;
        const pDmg = Math.floor(Math.random() * 5) + 8 + wepBonus;
        const mDmg = Math.max(1, (Math.floor(Math.random() * (monster.atk[1] - monster.atk[0] + 1)) + monster.atk[0]) - armBonus);
        monster.hp -= pDmg; p.hp -= mDmg;
        if (monster.hp <= 0) { p.kills++; let coin = 0; if (Math.random() < 0.5) { p.coin++; coin = 1; } const deadMonsterName = monster.name; p.combat = null; return m.reply(`Kamu mengalahkan **${deadMonsterName}**! (+${coin} coin). HP: ${p.hp}/${p.maxHp}.`); }
        if (p.hp <= 0) { const pen = Math.ceil(p.coin * 0.1); p.coin = Math.max(0, p.coin - pen); p.hp = p.maxHp; p.combat = null; return m.reply(`Kamu dikalahkan! Kehilangan ${pen} coin. HP dipulihkan.`); }
        return m.reply(`Kamu serang (-${pDmg}), **${monster.name}** balas (-${mDmg}).\n**Monster HP:** ${monster.hp}/${monster.maxHp}. **HP Kamu:** ${p.hp}/${p.maxHp}.`);
    }

    if (cmd === '!run') {
        const penalty = Math.ceil(p.coin * 0.05);
        p.coin = Math.max(0, p.coin - penalty);
        const escapedMonster = p.combat.name;
        p.combat = null;
        return m.reply(`Kamu kabur dari **${escapedMonster}** tapi kehilangan ${penalty} coin.`);
    }

    if (cmd === '!catch') {
        const chance = 0.2 + (1 - (monster.hp / monster.maxHp)) * 0.5;
        const caughtMonster = monster.name;
        p.combat = null;
        if (Math.random() < chance) {
            p.catches++;
            let coin = 0;
            if (Math.random() < 0.5) { p.coin++; coin = 1; }
            return m.reply(`Berhasil menangkap **${caughtMonster}**! (+${coin} coin).`);
        }
        return m.reply(`Gagal! **${caughtMonster}** kabur.`);
    }
});

c.login(process.env.BOT_TOKEN);