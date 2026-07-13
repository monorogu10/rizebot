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
]);

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
        .setDescription('Sinkronkan status, role, dan nickname registry')),
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
    const status = options.getString('status') || 'all';
    const page = options.getInteger('halaman') || 1;
    return `!list ${status} ${page}`;
  }
  if (interaction.commandName !== 'interview') return '';

  const subcommand = options.getSubcommand(true);
  if (subcommand === 'doctor') return '!interview-doctor';
  if (subcommand === 'repair') return `!repair-interviews --${options.getString('mode', true)}`;
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
    createdAt: interaction.createdAt,
    createdTimestamp: interaction.createdTimestamp,
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

function createApplicationCommandHandler({ registerHandler, minecraftBridgeHandler, bridge, registerStore }) {
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

    const handler = interaction.commandName === 'player' ? minecraftBridgeHandler : registerHandler;
    const handled = await handler(adapter);
    if (!handled) {
      await adapter.reply('Slash command dikenali, tetapi handler tidak dapat memprosesnya.').catch(() => null);
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
  registerApplicationCommands,
};
