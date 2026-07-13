const assert = require('node:assert/strict');
const test = require('node:test');
const { MessageFlags } = require('discord.js');

const {
  applicationCommandPayloads,
  autocompleteChoices,
  commandToLegacyContent,
  createApplicationCommandHandler,
  createInteractionMessageAdapter,
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

test('application command definitions expose the hybrid registration surface', () => {
  const payloads = applicationCommandPayloads();
  assert.deepEqual(payloads.map(command => command.name), [
    'register',
    'status',
    'player',
    'interview',
    'registry',
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
  ]);
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

test('application command handler defers and routes register through the legacy handler', async () => {
  let routedContent = '';
  let deferredPayload = null;
  let responsePayload = null;
  const registerHandler = async message => {
    routedContent = message.content;
    await message.reply('Register diproses');
    return true;
  };
  const handler = createApplicationCommandHandler({
    registerHandler,
    minecraftBridgeHandler: async () => false,
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
