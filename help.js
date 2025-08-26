const { EmbedBuilder } = require('discord.js');

const helpEmbed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📜 Panduan Bermain Ethernia Hunt')
    .setDescription('Selamat datang di dunia Ethernia! Berikut adalah perintah yang bisa kamu gunakan untuk berpetualang.')
    .addFields(
        { 
            name: ' adventurer️ Memulai Petualangan', 
            value: '`!stats` - Melihat status karaktermu.\n`!go` - Mencari monster untuk dilawan.' 
        },
        { 
            name: '⚔️ Sistem Pertarungan', 
            value: '`!atk` - Menyerang monster.\n`!catch` - Mencoba menangkap monster.\n`!run` - Kabur dari pertarungan (kena penalti koin).' 
        },
        { 
            name: '💰 Ekonomi & Barang', 
            value: '`!shop` - Melihat barang di toko.\n`!buy <item>` - Membeli barang.\n`!inv` - Cek inventory dan equipment.\n`!equip <item>` - Memakai senjata/armor.\n`!unequip <weapon/armor>` - Melepas equipment.\n`!give <item> @user` - Memberi item ke pemain lain.'
        },
        { 
            name: '🛋️ Fitur Request Khusus', 
            value: '`!use ticket` - Cek instruksi untuk request.\n`!request <pesan>` - Mengirim request furniture ke admin (wajib lampirkan 1 gambar).'
        },
        { 
            name: '🏆 Komunitas', 
            value: '`!top5` - Menampilkan 5 pemain terkaya.\n`!save` - Menyimpan progres game server.'
        },
        {
            name: '👑 Perintah Admin',
            value: 'Admin server memiliki perintah khusus untuk mengelola game. Hubungi admin untuk informasi lebih lanjut.'
        }
    )
    .setFooter({ text: 'Selamat berburu di Ethernia!' });

module.exports = helpEmbed;