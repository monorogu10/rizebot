const assert = require('node:assert/strict');
const test = require('node:test');

const { createMinecraftBridgeHandler } = require('../src/handlers/minecraftBridgeHandler');
const { createRegisterHandler } = require('../src/handlers/registerHandler');
const { createServerStatusNotifier } = require('../src/services/serverStatusNotifier');

function createMessage(content, replies, overrides = {}) {
  return {
    id: `message-${replies.length + 1}`,
    content,
    author: { id: '11111', username: 'ordinary-user', bot: false },
    guild: {},
    client: {},
    async reply(payload) {
      replies.push(payload);
      return {};
    },
    ...overrides,
  };
}

test('ordinary users can check server health and online players', async () => {
  const replies = [];
  const now = new Date().toISOString();
  const bridge = {
    getBridgeStatus() {
      return { lastJobPollAt: now, onlineCount: 1, jobs: { queued: 0, leased: 0 } };
    },
    getOnlinePlayers() {
      return [{ name: 'PublicPlayer', discordUserId: '22222', verified: true }];
    },
  };
  const handler = createMinecraftBridgeHandler({ bridge, registerStore: {} });

  assert.equal(await handler(createMessage('!cekserver', replies)), true);
  assert.equal(replies[0].embeds[0].data.title, 'Status Ethergeon');
  assert.match(replies[0].embeds[0].data.description, /sedang terhubung/i);

  assert.equal(await handler(createMessage('!online', replies)), true);
  assert.match(replies[1].embeds[0].data.title, /Player Online: 1/);
  assert.doesNotMatch(replies[1].embeds[0].data.title, /Command Admin/);
});

test('online check refuses to present stale player cache as current', async () => {
  const replies = [];
  let onlineReads = 0;
  const handler = createMinecraftBridgeHandler({
    bridge: {
      getBridgeStatus() {
        return {
          lastJobPollAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          onlineCount: 1,
        };
      },
      getOnlinePlayers() {
        onlineReads += 1;
        return [{ name: 'StalePlayer' }];
      },
    },
    registerStore: {},
  });

  assert.equal(await handler(createMessage('!online', replies)), true);
  assert.equal(replies[0].embeds[0].data.title, 'Player Online Tidak Tersedia');
  assert.equal(onlineReads, 0);
});

test('ordinary users can view another Discord user Ethergeon ID card', async () => {
  const replies = [];
  const target = { id: '22222', username: 'target-user' };
  const handler = createRegisterHandler({
    registerStore: {
      async init() {},
      getUser(userId) {
        if (userId !== target.id) return null;
        return {
          userId,
          username: target.username,
          gamertag: 'TargetPlayer',
          status: 'approved',
          registeredAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      },
    },
  });
  const users = new Map([[target.id, target]]);
  const message = createMessage(`!status <@${target.id}>`, replies, {
    client: {
      users: {
        cache: users,
        fetch: async userId => users.get(userId) || null,
      },
    },
  });

  assert.equal(await handler(message), true);
  assert.equal(replies[0].embeds[0].data.title, 'Ethergeon ID Card');
  assert.match(replies[0].embeds[0].data.description, /TargetPlayer/);
});

test('Ethergeon status notifier announces bot and Minecraft lifecycle states', async () => {
  const sent = [];
  const notifier = createServerStatusNotifier({
    client: {
      channels: {
        async fetch(channelId) {
          assert.equal(channelId, '1465702373946163353');
          return {
            async send(payload) {
              sent.push(payload);
              return {};
            },
          };
        },
      },
    },
    channelId: '1465702373946163353',
  });

  await notifier.notifyBotOnline({ tag: 'monoDeco Bot' });
  await notifier.notifyDisconnected({ staleText: '45 detik' });
  await notifier.notifyConnected();
  await notifier.notifyBotStopping('BOT sedang direload.');

  assert.deepEqual(sent.map(payload => payload.embeds[0].data.title), [
    'BOT monoDeco Sudah Online',
    'Server Ethergeon Tidak Terhubung',
    'Server Ethergeon Sudah Aktif',
    'BOT monoDeco Akan Offline',
  ]);
  assert.ok(sent.every(payload => payload.allowedMentions.parse.length === 0));
});
