const assert = require('node:assert/strict');
const test = require('node:test');
const { MessageFlags } = require('discord.js');

const {
  applicationCommandPayloads,
  autocompleteChoices,
  commandToLegacyContent,
  createApplicationCommandHandler,
  createInteractionMessageAdapter,
  isLegacyPrefixCommand,
} = require('../src/commands/applicationCommands');

function mockOptions(values = {}, subcommand = '') {
  return {
    getString(name, required = false) {
      const value = values[name] ?? null;
      if (required && value === null) throw new Error(`missing string ${name}`);
      return value;
    },
    getInteger(name) {
      return values[name] ?? null;
    },
    getBoolean(name) {
      return values[name] ?? null;
    },
    getUser(name, required = false) {
      const value = values[name] ?? null;
      if (required && value === null) throw new Error(`missing user ${name}`);
      return value;
    },
    getSubcommand(required = false) {
      if (required && !subcommand) throw new Error('missing subcommand');
      return subcommand || null;
    },
    getFocused() {
      return values.focused || '';
    },
  };
}

test('application command definitions expose the complete slash-only surface', () => {
  const payloads = applicationCommandPayloads();
  assert.deepEqual(payloads.map(command => command.name), [
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
  assert.equal(new Set(payloads.map(command => command.name)).size, payloads.length);

  const interview = payloads.find(command => command.name === 'interview');
  assert.deepEqual(interview.options.map(option => option.name), [
    'accept',
    'reject',
    'close',
    'status',
    'doctor',
    'repair',
    'relink',
    'compile',
    'archive',
  ]);

  const registry = payloads.find(command => command.name === 'registry');
  assert.deepEqual(registry.options.map(option => option.name), ['list', 'sync', 'set-gamertag']);
});

test('legacy Discord prefix commands are recognized for deprecation handling', () => {
  assert.equal(isLegacyPrefixCommand('!reg DampTester'), true);
  assert.equal(isLegacyPrefixCommand(' !repair-interviews --dry-run '), true);
  assert.equal(isLegacyPrefixCommand('/register gamertag:DampTester'), false);
  assert.equal(isLegacyPrefixCommand('pesan biasa!'), false);
});

test('slash options map to the existing command handlers without losing force data', () => {
  const target = { id: '123456789' };
  assert.equal(commandToLegacyContent({
    commandName: 'register',
    options: mockOptions({ gamertag: 'DampTester7862' }),
  }), '!reg DampTester7862');

  assert.equal(commandToLegacyContent({
    commandName: 'status',
    options: mockOptions({ user: target }),
  }), '!status <@123456789>');

  assert.equal(commandToLegacyContent({
    commandName: 'interview',
    options: mockOptions({ user: target, gamertag: 'DampTester7862', force: true }, 'accept'),
  }), '!accept --force <@123456789> DampTester7862');

  assert.equal(commandToLegacyContent({
    commandName: 'interview',
    options: mockOptions({ user: target, alasan: 'Jawaban tidak lengkap', force: false }, 'reject'),
  }), '!reject <@123456789> Jawaban tidak lengkap');

  assert.equal(commandToLegacyContent({
    commandName: 'registry',
    options: mockOptions({ status: 'pending', halaman: 3 }, 'list'),
  }), '!list pending 3');
});

test('every migrated command family maps to its internal handler command', () => {
  const target = { id: '123456789' };
  const cases = [
    ['help', '', {}, '!help'],
    ['verify', '', {}, '!verifyme'],
    ['member', '', {}, '!member'],
    ['rules', '', {}, '!rules'],
    ['shop', '', {}, '!shop'],
    ['shop', '', { item: 'Magic Tool', harga: 250 }, '!shopsetting Magic Tool 250'],
    ['perusahaan', '', {}, '!perusahaan'],
    ['organisasi', '', { nama: 'Ether Corp' }, '!organisasi Ether Corp'],
    ['tf', 'player', { nama: 'DampTester', jumlah: 500, alasan: 'Hadiah' }, '!tf DampTester 500 Hadiah'],
    ['tf', 'user', { target, jumlah: 250 }, '!tf <@123456789> 250'],
    ['tf', 'all', { jumlah: 100 }, '!tf --all 100'],
    ['bansos', '', { geon: 500, orang: 20 }, '!bansos 500 20'],
    ['geonrate', '', { rupiah: 10000 }, '!geonrate 10000'],
    ['uu', 'lihat', { pencarian: 'UU-EG-1' }, '!uu UU-EG-1'],
    ['uu', 'help', {}, '!uu-help'],
    ['uu', 'create', { catatan: 'Isi awal' }, '!create-uu Isi awal'],
    ['uu', 'draft', { id: '12' }, '!draft-uu 12'],
    ['uu', 'revise', { id: 'UU-EG-1', alasan: 'Pembaruan' }, '!revise-uu UU-EG-1 | Pembaruan'],
    ['uu', 'cabut', { id: 'UU-EG-1', alasan: 'Tidak berlaku' }, '!cabut-uu UU-EG-1 | Tidak berlaku'],
    ['moderasi', 'timeout', { user: target }, '!timeout <@123456789>'],
    ['minecraft', 'status', {}, '!mcstatus'],
    ['minecraft', 'ping', {}, '!mcping'],
    ['minecraft', 'online', {}, '!online'],
    ['minecraft', 'chat', { pesan: 'Halo server' }, '!p Halo server'],
    ['minecraft', 'search', { nama: 'Damp' }, '!srcpl Damp'],
    ['minecraft', 'saldo', { nama: 'Damp' }, '!geon Damp'],
    ['minecraft', 'migrasi', { lama: 'Nama Lama', baru: 'Nama Baru' }, '!migrasi Nama Lama -> Nama Baru'],
    ['minecraft', 'bonus', { nama: 'Damp', jumlah: 1000 }, '!bonus Damp 1000'],
    ['topup', 'help', {}, '!topup-help'],
    ['topup', 'kirim', { nama: 'Damp', geon: 1000, rupiah: 5000 }, '!tu Damp 1000 5000'],
    ['topup', 'kupon', { geon: 1000, rupiah: 5000, jumlah: 2, hari: 7 }, '!gnrtkpn 1000 5000 2 7'],
    ['registry', 'set-gamertag', { user: target, gamertag: 'DampTester' }, '!setreg <@123456789> DampTester'],
    ['interview', 'compile', { jumlah: 10 }, '!compile 10'],
    ['interview', 'archive', { jumlah: 20 }, '!archive-interviews 20'],
  ];

  for (const [commandName, subcommand, values, expected] of cases) {
    assert.equal(commandToLegacyContent({
      commandName,
      options: mockOptions(values, subcommand),
    }), expected, `${commandName} ${subcommand}`.trim());
  }
});

test('gamertag autocomplete matches names while ignoring whitespace', () => {
  const choices = autocompleteChoices({
    commandName: 'player',
    options: mockOptions({ focused: 'damp tester' }),
  }, {
    getOnlinePlayers() {
      return [{ name: 'DampTester7862' }, { name: 'OtherPlayer' }];
    },
  }, {
    getEntries() {
      return [{ gamertag: 'Damp Tester7862' }];
    },
  });

  assert.deepEqual(choices.map(choice => choice.value), ['DampTester7862']);
});

test('interaction message adapter edits the deferred reply then follows up', async () => {
  const calls = [];
  const interaction = {
    id: 'interaction-id',
    deferred: true,
    replied: false,
    user: { id: 'user-id' },
    async editReply(payload) {
      calls.push(['edit', payload]);
      return { id: 'first' };
    },
    async followUp(payload) {
      calls.push(['followUp', payload]);
      return { id: 'second' };
    },
  };
  const adapter = createInteractionMessageAdapter(interaction, '!sync-reg', { ephemeral: true });
  assert.equal((await adapter.reply('pertama')).id, 'first');
  assert.equal((await adapter.reply({ content: 'kedua' })).id, 'second');
  assert.equal(calls[0][0], 'edit');
  assert.equal(calls[1][0], 'followUp');
  assert.equal(calls[1][1].flags, MessageFlags.Ephemeral);
});

test('application command handler defers and routes through the shared command dispatcher', async () => {
  let routedContent = '';
  let deferredPayload = null;
  let responsePayload = null;
  const commandHandler = async message => {
    routedContent = message.content;
    await message.reply('Register diproses');
    return true;
  };
  const handler = createApplicationCommandHandler({
    commandHandler,
    bridge: null,
    registerStore: null,
  });
  const interaction = {
    id: 'interaction-id',
    commandName: 'register',
    options: mockOptions({ gamertag: 'SlashPlayer' }),
    user: { id: 'user-id', bot: false },
    member: {
      roles: { cache: new Map() },
      permissions: { has: () => true },
    },
    guild: {},
    guildId: 'guild-id',
    channel: {},
    channelId: 'channel-id',
    client: {},
    deferred: false,
    replied: false,
    isAutocomplete() {
      return false;
    },
    isChatInputCommand() {
      return true;
    },
    async deferReply(payload) {
      deferredPayload = payload;
      this.deferred = true;
    },
    async editReply(payload) {
      responsePayload = payload;
      return { id: 'response' };
    },
  };

  assert.equal(await handler(interaction), true);
  assert.equal(routedContent, '!reg SlashPlayer');
  assert.equal(deferredPayload.flags, MessageFlags.Ephemeral);
  assert.equal(responsePayload.content, 'Register diproses');
});
