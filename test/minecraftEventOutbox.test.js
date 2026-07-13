const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.RIZEBOT_EVENT_OUTBOX_FILE = path.join(
  os.tmpdir(),
  `rizebot-event-outbox-test-${process.pid}.json`
);
process.env.MINECRAFT_CHAT_LOG_CHANNEL_ID = 'test-chat-channel';
process.env.MINECRAFT_AUDIT_LOG_CHANNEL_ID = 'test-audit-channel';
process.env.MINECRAFT_ERROR_LOG_CHANNEL_ID = 'test-error-channel';
process.env.MINECRAFT_ORGANIZATION_LOG_CHANNEL_ID = 'test-organization-channel';

const { createTopupBridgeService } = require('../src/services/topupBridgeService');

function createRegisterStoreStub() {
  return {
    findUserByGamertag() {
      return null;
    },
    findUserByPersistentId() {
      return null;
    },
  };
}

function chatEvent(eventId) {
  return {
    type: 'chat',
    eventId,
    name: 'Tester',
    message: 'halo server',
    source: 'global',
    onlineCount: 1,
    player: {
      name: 'Tester',
      key: 'tester',
      online: true,
    },
  };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timeout');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('Minecraft event outbox acknowledges and deduplicates a delivered chat event', async () => {
  let sends = 0;
  const client = {
    channels: {
      async fetch() {
        return {
          async send() {
            sends += 1;
          },
        };
      },
    },
  };
  const bridge = createTopupBridgeService({ registerStore: createRegisterStoreStub(), client });
  const event = chatEvent(`test:${process.pid}:delivered`);

  const first = await bridge.handleMinecraftEvent(event);
  await waitFor(() => bridge.getBridgeStatus().lastLogEventId === event.eventId &&
    bridge.getBridgeStatus().lastLogDeliveredAt);
  const duplicate = await bridge.handleMinecraftEvent(event);

  assert.equal(first.ok, true);
  assert.equal(first.accepted, true);
  assert.equal(first.delivered, false);
  assert.equal(first.code, 'queued-for-delivery');
  assert.equal(first.eventId, event.eventId);
  assert.equal(duplicate.duplicate, true);
  assert.equal(sends, 1);
});

test('Minecraft event outbox owns retry after Discord delivery temporarily fails', async () => {
  let sends = 0;
  const client = {
    channels: {
      async fetch() {
        return {
          async send() {
            sends += 1;
            if (sends === 1) throw new Error('temporary-discord-failure');
          },
        };
      },
    },
  };
  const bridge = createTopupBridgeService({ registerStore: createRegisterStoreStub(), client });
  const event = chatEvent(`test:${process.pid}:retry`);

  const accepted = await bridge.handleMinecraftEvent(event);
  await waitFor(() => sends === 1 && bridge.getBridgeStatus().lastLogFailureCode);
  const retried = await bridge.handleMinecraftEvent(event);
  await waitFor(() => sends === 2 && bridge.getBridgeStatus().lastLogEventId === event.eventId &&
    bridge.getBridgeStatus().lastLogDeliveredAt);
  const delivered = await bridge.handleMinecraftEvent(event);

  assert.equal(accepted.ok, true);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.delivered, false);
  assert.equal(accepted.code, 'queued-for-delivery');
  assert.equal(retried.ok, true);
  assert.equal(retried.delivered, false);
  assert.equal(retried.duplicate, true);
  assert.equal(delivered.delivered, true);
  assert.equal(delivered.duplicate, true);
  assert.equal(sends, 2);
});

test('Minecraft event outbox resumes a pending delivery after service recreation', async () => {
  const event = chatEvent(`test:${process.pid}:restart`);
  const failingClient = {
    channels: {
      async fetch() {
        return {
          async send() {
            throw new Error('discord-offline');
          },
        };
      },
    },
  };
  const firstBridge = createTopupBridgeService({
    registerStore: createRegisterStoreStub(),
    client: failingClient,
  });

  const accepted = await firstBridge.handleMinecraftEvent(event);
  await waitFor(() => firstBridge.getBridgeStatus().lastLogFailureCode === 'discord-offline');
  assert.equal(accepted.accepted, true);

  let recoveredSends = 0;
  const recoveredClient = {
    channels: {
      async fetch() {
        return {
          async send() {
            recoveredSends += 1;
          },
        };
      },
    },
  };
  const recoveredBridge = createTopupBridgeService({
    registerStore: createRegisterStoreStub(),
    client: recoveredClient,
  });

  await waitFor(() => recoveredBridge.getBridgeStatus().lastLogEventId === event.eventId &&
    recoveredBridge.getBridgeStatus().lastLogDeliveredAt);
  assert.equal(recoveredSends, 1);
});

test('Minecraft log categories route to their configured channels', async () => {
  const sentChannels = [];
  const client = {
    channels: {
      async fetch(channelId) {
        return {
          async send() {
            sentChannels.push(channelId);
          },
        };
      },
    },
  };
  const bridge = createTopupBridgeService({ registerStore: createRegisterStoreStub(), client });
  const suffix = `${process.pid}:${Date.now()}`;
  const events = [
    chatEvent(`test:${suffix}:chat`),
    { ...chatEvent(`test:${suffix}:organization`), source: 'organization' },
    {
      type: 'command_attempt',
      eventId: `test:${suffix}:command`,
      actor: 'Tester',
      message: 'Tester menjalankan /home',
    },
    {
      type: 'server_log',
      eventId: `test:${suffix}:error`,
      severity: 'error',
      message: 'script gagal',
    },
  ];

  for (const event of events) await bridge.handleMinecraftEvent(event);
  await waitFor(() => sentChannels.length === events.length);

  assert.deepEqual([...sentChannels].sort(), [
    'test-audit-channel',
    'test-chat-channel',
    'test-error-channel',
    'test-organization-channel',
  ].sort());
});

test('Minecraft access check does not emit a repeated presence log', async () => {
  let channelFetches = 0;
  const client = {
    channels: {
      async fetch() {
        channelFetches += 1;
        return { async send() {} };
      },
    },
  };
  const bridge = createTopupBridgeService({ registerStore: createRegisterStoreStub(), client });

  const result = await bridge.handleMinecraftEvent({
    type: 'player_access',
    player: { name: 'BelumRegister', key: 'belumregister', online: true },
  });

  assert.equal(result.ok, true);
  assert.equal(result.accessAllowed, false);
  assert.equal(channelFetches, 0);
});

test('Minecraft outbox rejects malformed events before they can block retries', async () => {
  const bridge = createTopupBridgeService({ registerStore: createRegisterStoreStub() });
  const result = await bridge.handleMinecraftEvent({
    type: 'chat',
    eventId: `test:${process.pid}:empty`,
    name: 'Tester',
    message: '',
  });

  assert.equal(result.ok, false);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'event-message-required');
});
