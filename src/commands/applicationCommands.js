const {
  MessageFlags,
  SlashCommandBuilder,
} = require('discord.js');
const { isAllowedBotOutputChannel } = require('../utils/channelPolicy');

const APPLICATION_COMMAND_NAMES = new Set([
  'register',
  'status',
  'player',
  'interview',
  'registry',
  'help',
  'verify',
  'member',
  'rules',
  'shop',
  'perusahaan',
  'organisasi',
  'tf',
  'bansos',
  'geonrate',
  'uu',
  'moderasi',
  'minecraft',
  'topup',
]);

function isLegacyPrefixCommand(content) {
  return /^!\s*[a-z][a-z0-9_-]*(?:\s|$)/i.test(String(content || '').trim());
}

function buildApplicationCommands() {
  return [
    new SlashCommandBuilder()
      .setName('register')
      .setDescription('Daftar akses Minecraft Ethergeon')
      .setDMPermission(false)
      .addStringOption(option => option
        .setName('gamertag')
        .setDescription('Gamertag Minecraft yang persis digunakan di server')
        .setMinLength(3)
        .setMaxLength(32)
        .setRequired(true)),

    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Lihat Ethergeon ID Card dan status registrasi')
      .setDMPermission(false)
      .addUserOption(option => option
        .setName('user')
        .setDescription('User lain; hanya tersedia untuk admin/interviewer')
        .setRequired(false)),

    new SlashCommandBuilder()
      .setName('player')
      .setDescription('Cari data player dari Minecraft bridge')
      .setDMPermission(false)
      .addStringOption(option => option
        .setName('nama')
        .setDescription('Nama player atau gamertag Minecraft')
        .setMinLength(2)
        .setMaxLength(80)
        .setAutocomplete(true)
        .setRequired(true)),

    new SlashCommandBuilder()
      .setName('interview')
      .setDescription('Kelola interview registrasi Minecraft')
      .setDMPermission(false)
      .addSubcommand(subcommand => subcommand
        .setName('accept')
        .setDescription('Approve interview atau jalankan recovery')
        .addUserOption(option => option
          .setName('user')
          .setDescription('Applicant; boleh kosong jika dijalankan di channel interview')
          .setRequired(false))
        .addStringOption(option => option
          .setName('gamertag')
          .setDescription('Wajib untuk force jika record user hilang')
          .setMinLength(3)
          .setMaxLength(32)
          .setAutocomplete(true)
          .setRequired(false))
        .addBooleanOption(option => option
          .setName('force')
          .setDescription('Bangun ulang mapping/registry yang rusak')
          .setRequired(false)))
      .addSubcommand(subcommand => subcommand
        .setName('reject')
        .setDescription('Reject interview applicant')
        .addUserOption(option => option
          .setName('user')
          .setDescription('Applicant; boleh kosong jika dijalankan di channel interview')
          .setRequired(false))
        .addStringOption(option => option
          .setName('alasan')
          .setDescription('Alasan penolakan')
          .setMaxLength(240)
          .setRequired(false))
        .addBooleanOption(option => option
          .setName('force')
          .setDescription('Pulihkan mapping rusak sebelum reject')
          .setRequired(false)))
      .addSubcommand(subcommand => subcommand
        .setName('close')
        .setDescription('Tutup dan arsipkan interview')
        .addUserOption(option => option
          .setName('user')
          .setDescription('Applicant; boleh kosong jika dijalankan di channel interview')
          .setRequired(false))
        .addBooleanOption(option => option
          .setName('force')
          .setDescription('Tutup interview pending atau mapping rusak')
          .setRequired(false)))
      .addSubcommand(subcommand => subcommand
        .setName('status')
        .setDescription('Audit registry dan session interview user')
        .addUserOption(option => option
          .setName('user')
          .setDescription('Applicant; boleh kosong di channel interview')
          .setRequired(false)))
      .addSubcommand(subcommand => subcommand
        .setName('doctor')
        .setDescription('Pindai masalah mapping interview'))
      .addSubcommand(subcommand => subcommand
        .setName('repair')
        .setDescription('Dry-run atau terapkan perbaikan interview')
        .addStringOption(option => option
          .setName('mode')
          .setDescription('Dry-run wajib dilakukan sebelum apply')
          .setRequired(true)
          .addChoices(
            { name: 'Dry run', value: 'dry-run' },
            { name: 'Apply', value: 'apply' },
          )))
      .addSubcommand(subcommand => subcommand
        .setName('relink')
        .setDescription('Hubungkan channel interview saat ini ke applicant')
        .addUserOption(option => option
          .setName('user')
          .setDescription('Applicant yang benar')
          .setRequired(true))
        .addStringOption(option => option
          .setName('gamertag')
          .setDescription('Wajib jika record registry hilang')
          .setMinLength(3)
          .setMaxLength(32)
          .setAutocomplete(true)
          .setRequired(false)))
      .addSubcommand(subcommand => subcommand
        .setName('compile')
        .setDescription('Compile dan bersihkan channel interview lama')
        .addIntegerOption(option => option
          .setName('jumlah')
          .setDescription('Jumlah channel; kosong berarti semua')
          .setMinValue(1)
          .setMaxValue(100)
          .setRequired(false)))
      .addSubcommand(subcommand => subcommand
        .setName('archive')
        .setDescription('Arsipkan backlog interview yang sudah ditutup')
        .addIntegerOption(option => option
          .setName('jumlah')
          .setDescription('Maksimal channel yang diarsipkan')
          .setMinValue(1)
          .setMaxValue(100)
          .setRequired(false))),

    new SlashCommandBuilder()
      .setName('registry')
      .setDescription('Registry Minecraft Ethergeon')
      .setDMPermission(false)
      .addSubcommand(subcommand => subcommand
        .setName('list')
        .setDescription('Lihat registry berdasarkan status')
        .addStringOption(option => option
          .setName('status')
          .setDescription('Filter status registry')
          .setRequired(false)
          .addChoices(
            { name: 'Semua', value: 'all' },
            { name: 'Lolos', value: 'approved' },
            { name: 'Pending', value: 'pending' },
            { name: 'Gagal', value: 'rejected' },
          ))
        .addIntegerOption(option => option
          .setName('halaman')
          .setDescription('Nomor halaman')
          .setMinValue(1)
          .setRequired(false)))
      .addSubcommand(subcommand => subcommand
        .setName('sync')
        .setDescription('Sinkronkan status, role, dan nickname registry'))
      .addSubcommand(subcommand => subcommand
        .setName('set-gamertag')
        .setDescription('Ubah gamertag legal setelah review admin')
        .addUserOption(option => option
          .setName('user')
          .setDescription('User yang gamertag-nya akan diubah')
          .setRequired(true))
        .addStringOption(option => option
          .setName('gamertag')
          .setDescription('Gamertag Minecraft yang benar')
          .setMinLength(3)
          .setMaxLength(32)
          .setAutocomplete(true)
          .setRequired(true))),

    new SlashCommandBuilder()
      .setName('help')
      .setDescription('Lihat seluruh command Rizebot yang tersedia')
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('verify')
      .setDescription('Buat kode untuk verifikasi akun Minecraft')
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('member')
      .setDescription('Lihat jumlah member Discord saat ini')
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('rules')
      .setDescription('Lihat item dan entity terlarang di server')
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('shop')
      .setDescription('Lihat harga shop atau ubah harga sebagai admin')
      .setDMPermission(false)
      .addStringOption(option => option
        .setName('item')
        .setDescription('Index atau nama item; kosong untuk melihat daftar')
        .setMaxLength(100)
        .setRequired(false))
      .addIntegerOption(option => option
        .setName('harga')
        .setDescription('Harga Geon baru; wajib jika item diisi')
        .setMinValue(1)
        .setMaxValue(100_000_000)
        .setRequired(false)),

    new SlashCommandBuilder()
      .setName('perusahaan')
      .setDescription('Buka Company Control Minecraft')
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('organisasi')
      .setDescription('Lihat daftar atau detail organisasi legal')
      .setDMPermission(false)
      .addStringOption(option => option
        .setName('nama')
        .setDescription('Nama organisasi; kosong untuk melihat daftar')
        .setMaxLength(100)
        .setRequired(false)),

    new SlashCommandBuilder()
      .setName('tf')
      .setDescription('Transfer Geon ke player atau semua player online')
      .setDMPermission(false)
      .addSubcommand(subcommand => subcommand
        .setName('player')
        .setDescription('Transfer ke gamertag Minecraft')
        .addStringOption(option => option
          .setName('nama')
          .setDescription('Gamertag target')
          .setMinLength(2)
          .setMaxLength(80)
          .setAutocomplete(true)
          .setRequired(true))
        .addIntegerOption(option => option
          .setName('jumlah')
          .setDescription('Jumlah Geon')
          .setMinValue(1)
          .setMaxValue(100_000_000)
          .setRequired(true))
        .addStringOption(option => option
          .setName('alasan')
          .setDescription('Alasan transfer opsional')
          .setMaxLength(180)
          .setRequired(false)))
      .addSubcommand(subcommand => subcommand
        .setName('user')
        .setDescription('Transfer ke akun Discord yang sudah terhubung')
        .addUserOption(option => option
          .setName('target')
          .setDescription('User Discord target')
          .setRequired(true))
        .addIntegerOption(option => option
          .setName('jumlah')
          .setDescription('Jumlah Geon')
          .setMinValue(1)
          .setMaxValue(100_000_000)
          .setRequired(true))
        .addStringOption(option => option
          .setName('alasan')
          .setDescription('Alasan transfer opsional')
          .setMaxLength(180)
          .setRequired(false)))
      .addSubcommand(subcommand => subcommand
        .setName('all')
        .setDescription('Transfer per orang ke semua player online')
        .addIntegerOption(option => option
          .setName('jumlah')
          .setDescription('Jumlah Geon per player')
          .setMinValue(1)
          .setMaxValue(100_000_000)
          .setRequired(true))),

    new SlashCommandBuilder()
      .setName('bansos')
      .setDescription('Buat bansos Geon untuk diklaim di Minecraft')
      .setDMPermission(false)
      .addIntegerOption(option => option
        .setName('geon')
        .setDescription('Geon per penerima')
        .setMinValue(1)
        .setMaxValue(100_000_000)
        .setRequired(true))
      .addIntegerOption(option => option
        .setName('orang')
        .setDescription('Jumlah maksimal penerima')
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true)),

    new SlashCommandBuilder()
      .setName('geonrate')
      .setDescription('Hitung dan kelola rate Geon')
      .setDMPermission(false)
      .addSubcommand(subcommand => subcommand
        .setName('cek')
        .setDescription('Hitung Geon dari nominal rupiah')
        .addIntegerOption(option => option
          .setName('rupiah')
          .setDescription('Nominal rupiah')
          .setMinValue(1)
          .setMaxValue(2_000_000_000)
          .setRequired(true)))
      .addSubcommand(subcommand => subcommand
        .setName('set')
        .setDescription('Ubah rate dasar untuk semua harga')
        .addIntegerOption(option => option
          .setName('geon-per-1000')
          .setDescription('Jumlah Geon untuk dasar Rp1.000')
          .setMinValue(1)
          .setMaxValue(1_000_000)
          .setRequired(true))
        .addStringOption(option => option
          .setName('alasan')
          .setDescription('Alasan perubahan rate')
          .setMaxLength(240)
          .setRequired(false)))
      .addSubcommand(subcommand => subcommand
        .setName('history')
        .setDescription('Lihat riwayat perubahan rate'))
      .addSubcommand(subcommand => subcommand
        .setName('reset')
        .setDescription('Kembalikan rate ke 100 Geon per Rp1.000')
        .addStringOption(option => option
          .setName('alasan')
          .setDescription('Alasan reset rate')
          .setMaxLength(240)
          .setRequired(false))),

    new SlashCommandBuilder()
      .setName('uu')
      .setDescription('Baca dan kelola Undang-Undang Ethergeon')
      .setDMPermission(false)
      .addSubcommand(subcommand => subcommand
        .setName('lihat')
        .setDescription('Lihat daftar atau cari Undang-Undang')
        .addStringOption(option => option
          .setName('pencarian')
          .setDescription('Nomor, kode, judul, atau kata pencarian')
          .setMaxLength(160)
          .setRequired(false)))
      .addSubcommand(subcommand => subcommand
        .setName('help')
        .setDescription('Lihat tutorial Undang-Undang'))
      .addSubcommand(subcommand => subcommand
        .setName('create')
        .setDescription('Buat draft Undang-Undang baru')
        .addStringOption(option => option
          .setName('catatan')
          .setDescription('Isi awal Pasal 1 Ayat (1)')
          .setMaxLength(1800)
          .setRequired(true)))
      .addSubcommand(subcommand => subcommand
        .setName('draft')
        .setDescription('Buka kembali draft atau revisi yang tersimpan')
        .addStringOption(option => option
          .setName('id')
          .setDescription('ID draft atau kode UU; kosong untuk draft terakhir')
          .setMaxLength(80)
          .setRequired(false)))
      .addSubcommand(subcommand => subcommand
        .setName('revise')
        .setDescription('Mulai revisi Undang-Undang')
        .addStringOption(option => option
          .setName('id')
          .setDescription('Nomor atau kode UU; kosong untuk memilih dari panel')
          .setMaxLength(80)
          .setRequired(false))
        .addStringOption(option => option
          .setName('alasan')
          .setDescription('Alasan revisi opsional')
          .setMaxLength(500)
          .setRequired(false)))
      .addSubcommand(subcommand => subcommand
        .setName('cabut')
        .setDescription('Cabut Undang-Undang tanpa menghapus arsip')
        .addStringOption(option => option
          .setName('id')
          .setDescription('Nomor atau kode UU')
          .setMaxLength(80)
          .setRequired(true))
        .addStringOption(option => option
          .setName('alasan')
          .setDescription('Alasan pencabutan')
          .setMaxLength(500)
          .setRequired(true))),

    new SlashCommandBuilder()
      .setName('moderasi')
      .setDescription('Petisi timeout dan pembatalan timeout')
      .setDMPermission(false)
      .addSubcommand(subcommand => subcommand
        .setName('timeout')
        .setDescription('Buat petisi timeout untuk user')
        .addUserOption(option => option
          .setName('user')
          .setDescription('User target petisi')
          .setRequired(true)))
      .addSubcommand(subcommand => subcommand
        .setName('freedom')
        .setDescription('Batalkan timeout aktif sebagai admin')
        .addUserOption(option => option
          .setName('user')
          .setDescription('User yang timeout-nya dibatalkan')
          .setRequired(true))),

    new SlashCommandBuilder()
      .setName('minecraft')
      .setDescription('Command administrasi Minecraft bridge')
      .setDMPermission(false)
      .addSubcommand(subcommand => subcommand.setName('status').setDescription('Lihat status bridge Minecraft'))
      .addSubcommand(subcommand => subcommand.setName('ping').setDescription('Tes koneksi behavior pack'))
      .addSubcommand(subcommand => subcommand.setName('online').setDescription('Lihat player yang sedang online'))
      .addSubcommand(subcommand => subcommand
        .setName('chat')
        .setDescription('Kirim pesan ke chat Minecraft')
        .addStringOption(option => option
          .setName('pesan')
          .setDescription('Pesan maksimal 240 karakter')
          .setMaxLength(240)
          .setRequired(true)))
      .addSubcommand(subcommand => subcommand
        .setName('search')
        .setDescription('Cari player dari data server')
        .addStringOption(option => option
          .setName('nama')
          .setDescription('Nama player')
          .setMinLength(2)
          .setMaxLength(80)
          .setAutocomplete(true)
          .setRequired(true)))
      .addSubcommand(subcommand => subcommand
        .setName('saldo')
        .setDescription('Lihat saldo player')
        .addStringOption(option => option
          .setName('nama')
          .setDescription('Nama player')
          .setMinLength(2)
          .setMaxLength(80)
          .setAutocomplete(true)
          .setRequired(true)))
      .addSubcommand(subcommand => subcommand
        .setName('migrasi')
        .setDescription('Preview migrasi data gamertag lama ke baru')
        .addStringOption(option => option
          .setName('lama')
          .setDescription('Gamertag lama')
          .setMinLength(2)
          .setMaxLength(80)
          .setRequired(true))
        .addStringOption(option => option
          .setName('baru')
          .setDescription('Gamertag baru')
          .setMinLength(2)
          .setMaxLength(80)
          .setRequired(true)))
      .addSubcommand(subcommand => subcommand
        .setName('bonus')
        .setDescription('Berikan bonus Geon sebagai admin utama')
        .addStringOption(option => option
          .setName('nama')
          .setDescription('Gamertag target')
          .setMinLength(2)
          .setMaxLength(80)
          .setAutocomplete(true)
          .setRequired(true))
        .addIntegerOption(option => option
          .setName('jumlah')
          .setDescription('Jumlah bonus Geon')
          .setMinValue(1)
          .setMaxValue(100_000_000)
          .setRequired(true))),

    new SlashCommandBuilder()
      .setName('topup')
      .setDescription('Command topup Geon untuk admin')
      .setDMPermission(false)
      .addSubcommand(subcommand => subcommand.setName('help').setDescription('Lihat bantuan topup'))
      .addSubcommand(subcommand => subcommand
        .setName('kirim')
        .setDescription('Kirim topup Geon ke player')
        .addStringOption(option => option
          .setName('nama')
          .setDescription('Gamertag atau key target')
          .setMinLength(2)
          .setMaxLength(80)
          .setAutocomplete(true)
          .setRequired(true))
        .addIntegerOption(option => option
          .setName('rupiah')
          .setDescription('Nilai rupiah transaksi')
          .setMinValue(1)
          .setMaxValue(2_000_000_000)
          .setRequired(true))
        .addIntegerOption(option => option
          .setName('geon')
          .setDescription('Override Geon; kosong = hitung dari rate aktif')
          .setMinValue(1)
          .setMaxValue(100_000_000)
          .setRequired(false)))
      .addSubcommand(subcommand => subcommand
        .setName('kupon')
        .setDescription('Generate satu atau beberapa kupon topup')
        .addIntegerOption(option => option
          .setName('rupiah')
          .setDescription('Nilai rupiah per kupon')
          .setMinValue(1)
          .setMaxValue(2_000_000_000)
          .setRequired(true))
        .addIntegerOption(option => option
          .setName('geon')
          .setDescription('Override Geon; kosong = hitung dari rate aktif')
          .setMinValue(1)
          .setMaxValue(100_000_000)
          .setRequired(false))
        .addIntegerOption(option => option
          .setName('jumlah')
          .setDescription('Jumlah kupon, default 1')
          .setMinValue(1)
          .setMaxValue(50)
          .setRequired(false))
        .addIntegerOption(option => option
          .setName('hari')
          .setDescription('Masa berlaku hari, default 30')
          .setMinValue(1)
          .setMaxValue(365)
          .setRequired(false)))
      .addSubcommand(subcommand => subcommand
        .setName('resolve')
        .setDescription('Alihkan payment SociaBuzz yang belum punya target')
        .addStringOption(option => option
          .setName('payment')
          .setDescription('ID payment dari kartu SociaBuzz')
          .setMinLength(4)
          .setMaxLength(80)
          .setRequired(true))
        .addStringOption(option => option
          .setName('nama')
          .setDescription('Gamertag, Discord, mention, atau ID tujuan')
          .setMinLength(2)
          .setMaxLength(80)
          .setRequired(true))),
  ];
}

function applicationCommandPayloads() {
  return buildApplicationCommands().map(command => command.toJSON());
}

function configuredGuildIds() {
  return String(
    process.env.DISCORD_COMMAND_GUILD_IDS ||
    process.env.DISCORD_GUILD_ID ||
    ''
  )
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

async function registerApplicationCommands(client, { guildIds = configuredGuildIds() } = {}) {
  if (!client?.application?.commands) throw new Error('Discord application belum siap untuk registrasi command');
  const payloads = applicationCommandPayloads();
  if (!guildIds.length) {
    const commands = await client.application.commands.set(payloads);
    return { scope: 'global', guilds: 0, commands: commands.size ?? payloads.length };
  }

  let commandCount = 0;
  for (const guildId of [...new Set(guildIds.map(String))]) {
    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
    const commands = await guild.commands.set(payloads);
    commandCount += commands.size ?? payloads.length;
  }
  return { scope: 'guild', guilds: new Set(guildIds).size, commands: commandCount };
}

function mention(user) {
  return user?.id ? `<@${user.id}>` : '';
}

function commandToLegacyContent(interaction) {
  const options = interaction.options;
  const commandName = interaction.commandName;
  if (commandName === 'help') return '!help';
  if (commandName === 'verify') return '!verifyme';
  if (commandName === 'member') return '!member';
  if (commandName === 'rules') return '!rules';
  if (interaction.commandName === 'register') {
    return `!reg ${options.getString('gamertag', true)}`;
  }
  if (interaction.commandName === 'status') {
    const target = options.getUser('user');
    return `!status${target ? ` ${mention(target)}` : ''}`;
  }
  if (interaction.commandName === 'player') {
    return `!player ${options.getString('nama', true)}`;
  }
  if (interaction.commandName === 'registry') {
    const subcommand = options.getSubcommand(true);
    if (subcommand === 'sync') return '!sync-reg';
    if (subcommand === 'set-gamertag') {
      return `!setreg ${mention(options.getUser('user', true))} ${options.getString('gamertag', true)}`;
    }
    const status = options.getString('status') || 'all';
    const page = options.getInteger('halaman') || 1;
    return `!list ${status} ${page}`;
  }
  if (interaction.commandName === 'shop') {
    const item = options.getString('item') || '';
    const price = options.getInteger('harga');
    return item || price ? `!shopsetting ${item}${price ? ` ${price}` : ''}` : '!shop';
  }
  if (interaction.commandName === 'perusahaan') return '!perusahaan';
  if (interaction.commandName === 'organisasi') {
    const name = options.getString('nama') || '';
    return `!organisasi${name ? ` ${name}` : ''}`;
  }
  if (interaction.commandName === 'tf') {
    const subcommand = options.getSubcommand(true);
    const amount = options.getInteger('jumlah');
    if (subcommand === 'all') return `!tf --all ${amount}`;
    const reason = options.getString('alasan') || '';
    const target = subcommand === 'user'
      ? mention(options.getUser('target', true))
      : options.getString('nama', true);
    return `!tf ${target} ${amount}${reason ? ` ${reason}` : ''}`;
  }
  if (interaction.commandName === 'bansos') {
    return `!bansos ${options.getInteger('geon')} ${options.getInteger('orang')}`;
  }
  if (interaction.commandName === 'geonrate') {
    const subcommand = options.getSubcommand(true);
    if (subcommand === 'cek') return `!geonrate cek ${options.getInteger('rupiah')}`;
    if (subcommand === 'set') {
      const reason = options.getString('alasan') || '';
      return `!geonrate set ${options.getInteger('geon-per-1000')}${reason ? ` | ${reason}` : ''}`;
    }
    if (subcommand === 'reset') {
      const reason = options.getString('alasan') || '';
      return `!geonrate reset${reason ? ` | ${reason}` : ''}`;
    }
    return '!geonrate history';
  }
  if (interaction.commandName === 'uu') {
    const subcommand = options.getSubcommand(true);
    if (subcommand === 'help') return '!uu-help';
    if (subcommand === 'lihat') {
      const query = options.getString('pencarian') || '';
      return `!uu${query ? ` ${query}` : ''}`;
    }
    if (subcommand === 'create') return `!create-uu ${options.getString('catatan', true)}`;
    if (subcommand === 'draft') {
      const id = options.getString('id') || '';
      return `!draft-uu${id ? ` ${id}` : ''}`;
    }
    if (subcommand === 'revise') {
      const id = options.getString('id') || '';
      const reason = options.getString('alasan') || '';
      return `!revise-uu${id || reason ? ` ${id}${reason ? ` | ${reason}` : ''}` : ''}`;
    }
    return `!cabut-uu ${options.getString('id', true)} | ${options.getString('alasan', true)}`;
  }
  if (interaction.commandName === 'moderasi') {
    const subcommand = options.getSubcommand(true);
    return `!${subcommand} ${mention(options.getUser('user', true))}`;
  }
  if (interaction.commandName === 'minecraft') {
    const subcommand = options.getSubcommand(true);
    if (subcommand === 'status') return '!mcstatus';
    if (subcommand === 'ping') return '!mcping';
    if (subcommand === 'online') return '!online';
    if (subcommand === 'chat') return `!p ${options.getString('pesan', true)}`;
    if (subcommand === 'search') return `!srcpl ${options.getString('nama', true)}`;
    if (subcommand === 'saldo') return `!geon ${options.getString('nama', true)}`;
    if (subcommand === 'migrasi') {
      return `!migrasi ${options.getString('lama', true)} -> ${options.getString('baru', true)}`;
    }
    return `!bonus ${options.getString('nama', true)} ${options.getInteger('jumlah')}`;
  }
  if (interaction.commandName === 'topup') {
    const subcommand = options.getSubcommand(true);
    if (subcommand === 'help') return '!topup-help';
    if (subcommand === 'kirim') {
      return `!tu ${options.getString('nama', true)} ${options.getInteger('geon') || 'auto'} ${options.getInteger('rupiah')}`;
    }
    if (subcommand === 'kupon') {
      return `!gnrtkpn ${options.getInteger('geon') || 'auto'} ${options.getInteger('rupiah')} ${options.getInteger('jumlah') || 1} ${options.getInteger('hari') || 30}`;
    }
    return `!topup-resolve ${options.getString('payment', true)} | ${options.getString('nama', true)}`;
  }
  if (interaction.commandName !== 'interview') return '';

  const subcommand = options.getSubcommand(true);
  if (subcommand === 'doctor') return '!interview-doctor';
  if (subcommand === 'repair') return `!repair-interviews --${options.getString('mode', true)}`;
  if (subcommand === 'compile') return `!compile ${options.getInteger('jumlah') || 'all'}`;
  if (subcommand === 'archive') return `!archive-interviews ${options.getInteger('jumlah') || 25}`;
  if (subcommand === 'status') {
    const target = options.getUser('user');
    return `!interview-status${target ? ` ${mention(target)}` : ''}`;
  }
  if (subcommand === 'relink') {
    const target = options.getUser('user', true);
    const gamertag = options.getString('gamertag') || '';
    return `!relink-interview ${mention(target)}${gamertag ? ` ${gamertag}` : ''}`;
  }

  const target = options.getUser('user');
  const force = options.getBoolean('force') === true;
  const forceText = force ? ' --force' : '';
  if (subcommand === 'accept') {
    const gamertag = options.getString('gamertag') || '';
    return `!accept${forceText}${target ? ` ${mention(target)}` : ''}${gamertag ? ` ${gamertag}` : ''}`;
  }
  if (subcommand === 'reject') {
    const reason = options.getString('alasan') || '';
    return `!reject${forceText}${target ? ` ${mention(target)}` : ''}${reason ? ` ${reason}` : ''}`;
  }
  if (subcommand === 'close') {
    return `!close${forceText}${target ? ` ${mention(target)}` : ''}`;
  }
  return '';
}

function normalizeReplyPayload(payload) {
  if (typeof payload === 'string') return { content: payload };
  if (!payload || typeof payload !== 'object') return { content: String(payload || '') };
  const normalized = { ...payload };
  delete normalized.ephemeral;
  return normalized;
}

function createInteractionMentions(interaction) {
  const users = [];
  for (const optionName of ['user', 'target']) {
    const user = interaction.options?.getUser?.(optionName) || null;
    if (user?.id && !users.some(item => item.id === user.id)) users.push(user);
  }
  return {
    users: {
      first: () => users[0] || null,
      get: userId => users.find(user => String(user.id) === String(userId)) || null,
      has: userId => users.some(user => String(user.id) === String(userId)),
      values: () => users.values(),
    },
  };
}

async function resolveInteractionMember(interaction) {
  if (interaction.member?.roles?.cache && interaction.member?.permissions?.has) return interaction.member;
  if (!interaction.guild?.members?.fetch) return interaction.member || null;
  return interaction.guild.members.fetch(interaction.user.id).catch(() => interaction.member || null);
}

function createInteractionMessageAdapter(interaction, content, { ephemeral = false, member = interaction.member } = {}) {
  let replyCount = 0;
  return {
    id: interaction.id,
    content,
    author: interaction.user,
    user: interaction.user,
    member,
    guild: interaction.guild,
    guildId: interaction.guildId,
    channel: interaction.channel,
    channelId: interaction.channelId,
    client: interaction.client,
    mentions: createInteractionMentions(interaction),
    interaction,
    fromApplicationCommand: true,
    createdAt: interaction.createdAt,
    createdTimestamp: interaction.createdTimestamp,
    get replyCount() {
      return replyCount;
    },
    async reply(payload) {
      const normalized = normalizeReplyPayload(payload);
      let sent;
      if (!interaction.deferred && !interaction.replied) {
        sent = await interaction.reply({
          ...normalized,
          flags: ephemeral ? MessageFlags.Ephemeral : normalized.flags,
          fetchReply: true,
        });
      } else if (replyCount === 0) {
        sent = await interaction.editReply(normalized);
      } else {
        sent = await interaction.followUp({
          ...normalized,
          flags: ephemeral ? MessageFlags.Ephemeral : normalized.flags,
          fetchReply: true,
        });
      }
      replyCount += 1;
      return sent;
    },
  };
}

function slashResponseIsEphemeral(interaction) {
  if (interaction.commandName === 'interview' || interaction.commandName === 'registry') return true;
  if (interaction.commandName === 'register') return true;
  if (interaction.commandName === 'moderasi') return true;
  return false;
}

function gamertagIdentity(value) {
  return String(value || '').replace(/\s+/g, '').trim().toLowerCase();
}

function autocompleteChoices(interaction, bridge, registerStore) {
  const focused = String(interaction.options.getFocused() || '').trim();
  const query = gamertagIdentity(focused);
  const values = [];
  const onlineOnly = interaction.commandName === 'interview';
  for (const player of bridge?.getOnlinePlayers?.() || []) {
    if (player?.name) values.push(String(player.name));
  }
  if (!onlineOnly) {
    for (const entry of registerStore?.getEntries?.() || []) {
      if (entry?.gamertag) values.push(String(entry.gamertag));
    }
  }

  const seen = new Set();
  const unique = values.filter(value => {
    const identity = gamertagIdentity(value);
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  return unique
    .filter(value => !query || gamertagIdentity(value).includes(query))
    .sort((left, right) => {
      const leftKey = gamertagIdentity(left);
      const rightKey = gamertagIdentity(right);
      const leftStarts = leftKey.startsWith(query) ? 0 : 1;
      const rightStarts = rightKey.startsWith(query) ? 0 : 1;
      return leftStarts - rightStarts || left.localeCompare(right);
    })
    .slice(0, 25)
    .map(value => ({ name: value.slice(0, 100), value: value.slice(0, 100) }));
}

function createApplicationCommandHandler({ commandHandler, registerHandler, minecraftBridgeHandler, bridge, registerStore }) {
  return async function handleApplicationCommand(interaction) {
    if (interaction?.isAutocomplete?.()) {
      if (!APPLICATION_COMMAND_NAMES.has(interaction.commandName)) return false;
      await interaction.respond(autocompleteChoices(interaction, bridge, registerStore)).catch(() => null);
      return true;
    }
    if (!interaction?.isChatInputCommand?.() || !APPLICATION_COMMAND_NAMES.has(interaction.commandName)) {
      return false;
    }

    const content = commandToLegacyContent(interaction);
    const member = await resolveInteractionMember(interaction);
    const ephemeral = slashResponseIsEphemeral(interaction);
    const adapter = createInteractionMessageAdapter(interaction, content, { ephemeral, member });
    if (!isAllowedBotOutputChannel(adapter)) {
      await interaction.reply({
        content: 'Command ini tidak tersedia di channel tersebut.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => null);
      return true;
    }

    await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});

    const handler = commandHandler || (interaction.commandName === 'player' ? minecraftBridgeHandler : registerHandler);
    if (typeof handler !== 'function') {
      await adapter.reply('Handler slash command belum tersedia.').catch(() => null);
      return true;
    }
    const handled = await handler(adapter);
    if (!handled) {
      await adapter.reply('Slash command dikenali, tetapi handler tidak dapat memprosesnya.').catch(() => null);
    } else if (adapter.replyCount === 0) {
      await adapter.reply('Command berhasil diproses.').catch(() => null);
    }
    return true;
  };
}

module.exports = {
  applicationCommandPayloads,
  autocompleteChoices,
  commandToLegacyContent,
  createApplicationCommandHandler,
  createInteractionMessageAdapter,
  isLegacyPrefixCommand,
  registerApplicationCommands,
};
