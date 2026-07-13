const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rizebot-null-context-test-'));
const jobStoreFile = path.join(runtimeDirectory, 'jobs.json');
process.env.RIZEBOT_JOB_STORE_FILE = jobStoreFile;
process.env.RIZEBOT_VERIFY_STORE_FILE = path.join(runtimeDirectory, 'verify.json');
process.env.RIZEBOT_EVENT_OUTBOX_FILE = path.join(runtimeDirectory, 'outbox.json');

const { createTopupBridgeService } = require('../src/services/topupBridgeService');

test('topup bridge persists jobs when message context is null', () => {
  const bridge = createTopupBridgeService({
    registerStore: {
      getEntries: () => [],
      findUserByGamertag: () => null,
      findUserByPersistentId: () => null,
    },
  });

  const job = bridge.enqueueTopup({
    target: { userId: '1', gamertag: 'Jozr Vladzov' },
    geon: 19_950,
    rupiah: 48_000,
    requestedBy: 'admin',
    message: null,
    loadingMessage: null,
    source: 'sociabuzz',
    paymentId: 'sb_null_context',
  });

  assert.ok(job.id);
  const persisted = JSON.parse(fs.readFileSync(jobStoreFile, 'utf8'));
  assert.equal(persisted.records.length, 1);
  assert.equal(persisted.records[0].job.paymentId, 'sb_null_context');
  assert.equal(persisted.records[0].context, null);
});

test('pending topup is announced to Ethergeon chat', async () => {
  const sent = [];
  const privateChannel = {
    async send(payload) {
      sent.push(payload);
      return { id: `ethergeon-${sent.length}` };
    },
  };
  const bridge = createTopupBridgeService({
    registerStore: {
      getEntries: () => [],
      findUserByGamertag: () => null,
      findUserByPersistentId: () => null,
    },
    client: {
      channels: { fetch: async () => privateChannel },
      users: { cache: new Map(), fetch: async () => null },
    },
  });
  const job = bridge.enqueueTopup({
    target: { userId: '1', gamertag: 'Offline Player' },
    geon: 1_500,
    rupiah: 10_000,
    requestedBy: 'admin',
    message: null,
    loadingMessage: null,
    source: 'sociabuzz',
    paymentId: 'sb_pending_announcement',
  });

  assert.deepEqual(bridge.takeJobs(10).some(item => item.id === job.id), true);
  assert.equal((await bridge.completeJob({
    jobId: job.id,
    ok: true,
    status: 'pending',
    targetName: 'Offline Player',
    geon: 1_500,
    rupiah: 10_000,
  })).ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].embeds[0].data.title, 'Topup Menunggu Player Join');
  assert.equal((await bridge.redeliverCompletedTopupNotifications()).checked, 0);
});

test('completed topup notification is retried after Discord delivery failure', async () => {
  const sent = [];
  let discordAvailable = false;
  const privateChannel = {
    async send(payload) {
      if (!discordAvailable) throw new Error('Discord temporarily unavailable');
      sent.push(payload);
      return { id: `ethergeon-retry-${sent.length}` };
    },
  };
  const bridge = createTopupBridgeService({
    registerStore: {
      getEntries: () => [],
      findUserByGamertag: () => null,
      findUserByPersistentId: () => null,
    },
    client: {
      channels: { fetch: async () => privateChannel },
      users: { cache: new Map(), fetch: async () => null },
    },
  });
  const job = bridge.enqueueTopup({
    target: { userId: '2', gamertag: 'Reconnect Player' },
    geon: 2_100,
    rupiah: 10_000,
    requestedBy: 'admin',
    source: 'sociabuzz',
    paymentId: 'sb_reconnect_announcement',
  });
  bridge.takeJobs(10);
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    assert.equal((await bridge.completeJob({
      jobId: job.id,
      ok: true,
      status: 'success',
      targetName: 'Reconnect Player',
      geon: 2_100,
      rupiah: 10_000,
    })).ok, true);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(sent.length, 0);

  discordAvailable = true;
  const recovery = await bridge.redeliverCompletedTopupNotifications();
  assert.equal(recovery.delivered, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].embeds[0].data.title, 'Topup Berhasil');
});

test('historical payment quarantine removes queued topup from Minecraft delivery', () => {
  const bridge = createTopupBridgeService({
    registerStore: {
      getEntries: () => [],
      findUserByGamertag: () => null,
      findUserByPersistentId: () => null,
    },
  });
  const job = bridge.enqueueTopup({
    target: { userId: '3', gamertag: 'Historical Player' },
    geon: 10_000,
    rupiah: 100_000,
    requestedBy: 'sociabuzz-history',
    source: 'sociabuzz',
    paymentId: 'sb_historical_must_cancel',
  });

  const canceled = bridge.cancelTopupPayment('sb_historical_must_cancel', 'historical-replay-blocked');
  assert.equal(canceled.canceled, 1);
  const persisted = JSON.parse(fs.readFileSync(jobStoreFile, 'utf8')).records
    .find(record => record.id === job.id);
  assert.equal(persisted.status, 'canceled');
  assert.equal(bridge.takeJobs(10).some(item => item.id === job.id), false);
});

test('active bridge backlog is never silently pruned at the history limit', () => {
  const bridge = createTopupBridgeService({
    registerStore: {
      getEntries: () => [],
      findUserByGamertag: () => null,
      findUserByPersistentId: () => null,
    },
  });
  const paymentIds = [];
  for (let index = 0; index < 105; index += 1) {
    const paymentId = `sb_backlog_${index}`;
    paymentIds.push(paymentId);
    bridge.enqueueTopup({
      target: { userId: String(index), gamertag: `Player${index}` },
      geon: 100,
      rupiah: 1_000,
      requestedBy: 'admin',
      source: 'sociabuzz',
      paymentId,
    });
  }
  const records = JSON.parse(fs.readFileSync(jobStoreFile, 'utf8')).records;
  const persistedPaymentIds = new Set(records.map(record => record.job.paymentId));
  assert.equal(paymentIds.every(paymentId => persistedPaymentIds.has(paymentId)), true);
});

test.after(() => {
  fs.rmSync(runtimeDirectory, { recursive: true, force: true });
});
