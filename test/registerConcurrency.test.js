const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ChannelType } = require('discord.js');

const { createRizebotDatabase } = require('../src/services/rizebotDatabase');
const { createRegisterStore } = require('../src/services/registerStore');
const { createRegisterHandler } = require('../src/handlers/registerHandler');

test('fallback interview allocator returns its captured number during concurrent saves', async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const saveChannelStore = {
    async load() {
      return { users: {}, order: [], interviewSequence: 258 };
    },
    async save() {
      await wait(10);
    },
    isDataMessage() {
      return false;
    },
  };
  const store = createRegisterStore({ saveChannelStore });
  await store.init({});
  const ids = await Promise.all([
    store.nextInterviewId(),
    store.nextInterviewId(),
    store.nextInterviewId(),
    store.nextInterviewId(),
  ]);
  assert.deepEqual(ids, [
    'interview-0259',
    'interview-0260',
    'interview-0261',
    'interview-0262',
  ]);
});

test('SQLite interview reservation is unique and blocks a second active user session', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rizebot-interview-test-'));
  const database = createRizebotDatabase({ dataDir: directory });
  try {
    database.init();
    database.setInterviewSequenceAtLeast(258);
    const reservations = [];
    for (let index = 0; index < 4; index += 1) {
      const result = database.reserveInterviewSession({
        userId: String(1000 + index),
        gamertag: `Player${index}`,
      });
      assert.equal(result.ok, true);
      reservations.push(result.session);
    }
    assert.deepEqual(reservations.map(item => item.interviewId), [
      'interview-0259',
      'interview-0260',
      'interview-0261',
      'interview-0262',
    ]);
    const duplicate = database.reserveInterviewSession({ userId: '1000', gamertag: 'OtherName' });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.code, 'active-user-session');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('cancelling a force accept does not create registry or session data', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rizebot-force-cancel-test-'));
  const database = createRizebotDatabase({ dataDir: directory });
  const saveChannelStore = {
    async load() {
      return { users: {}, order: [], interviewSequence: 0 };
    },
    async save() {},
    isDataMessage() {
      return false;
    },
  };
  const registerStore = createRegisterStore({ database, saveChannelStore });
  const adminId = '900001';
  const targetId = '900002';
  const channel = { id: '800001', name: 'admin-command', parentId: '', createdAt: new Date() };
  const guild = {
    id: '700001',
    channels: {
      cache: new Map([[channel.id, channel]]),
    },
    members: {
      async fetch() {
        return null;
      },
    },
  };
  const msg = {
    id: '600001',
    content: `!accept --force <@${targetId}> RecoveredGT`,
    author: { id: adminId, username: 'admin', tag: 'admin#0001', bot: false },
    member: { permissions: { has: () => true } },
    guild,
    channel,
    channelId: channel.id,
    client: {},
    async reply(payload) {
      const cancelId = payload.components[0].components[1].data.custom_id;
      return {
        async awaitMessageComponent({ filter }) {
          const interaction = {
            user: { id: adminId },
            customId: cancelId,
            async deferUpdate() {},
          };
          assert.equal(filter(interaction), true);
          return interaction;
        },
        async edit() {},
      };
    },
  };

  try {
    const handler = createRegisterHandler({ registerStore, database });
    assert.equal(await handler(msg), true);
    assert.equal(registerStore.getUser(targetId), undefined);
    assert.equal(database.listInterviewSessions({ limit: 10 }).length, 0);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('simultaneous register commands from one user create only one channel', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rizebot-register-handler-test-'));
  const database = createRizebotDatabase({ dataDir: directory });
  const saveChannelStore = {
    async load() {
      return { users: {}, order: [], interviewSequence: 258 };
    },
    async save() {},
    isDataMessage() {
      return false;
    },
  };
  const registerStore = createRegisterStore({ database, saveChannelStore });
  const userId = '910001';
  const channelCache = new Map();
  let channelCreates = 0;
  const guild = {
    id: '710001',
    roles: {
      everyone: { id: 'everyone' },
      cache: { get: id => ({ id }) },
      async fetch(id) {
        return { id };
      },
    },
    members: {
      me: { id: 'bot-id' },
      async fetch() {
        return member;
      },
    },
    channels: {
      cache: channelCache,
      async create(options) {
        channelCreates += 1;
        await new Promise(resolve => setTimeout(resolve, 15));
        const id = String(810000 + channelCreates);
        const created = {
          id,
          name: options.name,
          parentId: options.parent || '',
          createdAt: new Date(),
          async send() {},
          async delete() {
            channelCache.delete(id);
          },
        };
        channelCache.set(id, created);
        return created;
      },
    },
  };
  const roleCache = new Set();
  const member = {
    id: userId,
    guild,
    nickname: '',
    roles: {
      cache: roleCache,
      async add(role) {
        roleCache.add(role.id);
        return member;
      },
      async remove(role) {
        roleCache.delete(role.id);
        return member;
      },
    },
    async setNickname(value) {
      member.nickname = value;
      return member;
    },
  };
  const makeMessage = index => ({
    id: `61000${index}`,
    content: '!reg ConcurrentGT',
    author: { id: userId, username: 'player', tag: 'player#0001', bot: false },
    member,
    guild,
    channel: { id: '820001', name: 'registration', parentId: '' },
    channelId: '820001',
    client: { user: { id: 'bot-id' } },
    async reply() {
      return {};
    },
  });

  try {
    const handler = createRegisterHandler({ registerStore, database });
    const handled = await Promise.all([0, 1, 2, 3].map(index => handler(makeMessage(index))));
    assert.deepEqual(handled, [true, true, true, true]);
    assert.equal(channelCreates, 1);
    assert.equal(database.listInterviewSessions({ lifecycle: 'OPEN' }).length, 1);
    assert.equal(registerStore.getUser(userId).interviewId, 'interview-0259');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('interview repair requires dry-run and renumbers duplicate channels on apply', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rizebot-repair-test-'));
  const userA = '920001';
  const userB = '920002';
  const channelAId = '830001';
  const channelBId = '830002';
  const snapshot = {
    users: {
      [userA]: {
        gamertag: 'RepairOne',
        username: 'one',
        registeredAt: new Date(1_000).toISOString(),
        status: 'pending',
        interviewId: 'interview-0259',
        interviewChannelId: channelAId,
        interviewCreatedAt: new Date(1_000).toISOString(),
      },
      [userB]: {
        gamertag: 'RepairTwo',
        username: 'two',
        registeredAt: new Date(2_000).toISOString(),
        status: 'pending',
        interviewId: 'interview-0259',
        interviewChannelId: channelBId,
        interviewCreatedAt: new Date(2_000).toISOString(),
      },
    },
    order: [userA, userB],
    interviewSequence: 259,
  };
  const database = createRizebotDatabase({ dataDir: directory });
  const saveChannelStore = {
    async load() {
      return snapshot;
    },
    async save() {},
    isDataMessage() {
      return false;
    },
  };
  const registerStore = createRegisterStore({ database, saveChannelStore });
  const emptyMessages = { size: 0 };
  const makeInterviewChannel = (id, createdTimestamp) => ({
    id,
    name: 'interview-0259',
    type: ChannelType.GuildText,
    parentId: '',
    createdTimestamp,
    createdAt: new Date(createdTimestamp),
    messages: { fetch: async () => emptyMessages },
    permissionOverwrites: { edit: async () => null },
    async setName(value) {
      this.name = value;
      return this;
    },
    async send() {},
  });
  const channelA = makeInterviewChannel(channelAId, 1_000);
  const channelB = makeInterviewChannel(channelBId, 2_000);
  const channelCache = new Map([[channelAId, channelA], [channelBId, channelB]]);
  const guild = {
    id: '720001',
    channels: {
      cache: channelCache,
      async fetch(id) {
        return id ? channelCache.get(id) || null : channelCache;
      },
    },
  };
  const reports = [];
  const msg = {
    id: '620001',
    content: '!repair-interviews --dry-run',
    author: { id: '930001', username: 'admin', tag: 'admin#0001', bot: false },
    member: { permissions: { has: () => true } },
    guild,
    channel: { id: '840001', name: 'admin-command', parentId: '' },
    channelId: '840001',
    client: {},
    async reply(payload) {
      if (payload.files) reports.push(payload);
      return {
        async delete() {},
        async edit() {},
      };
    },
  };

  try {
    const handler = createRegisterHandler({ registerStore, database });
    assert.equal(await handler(msg), true);
    assert.equal(reports.length, 1);
    msg.content = '!repair-interviews --apply';
    assert.equal(await handler(msg), true);
    assert.equal(reports.length, 2);
    assert.deepEqual([channelA.name, channelB.name].sort(), ['interview-0259', 'interview-0260']);
    const openSessions = database.listInterviewSessions({ lifecycle: 'OPEN', limit: 10 });
    assert.equal(openSessions.length, 2);
    assert.equal(new Set(openSessions.map(item => item.interviewId)).size, 2);
    assert.equal(registerStore.getUser(userA).interviewChannelId, channelAId);
    assert.equal(registerStore.getUser(userB).interviewChannelId, channelBId);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
