const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rizebot-sociabuzz-test-'));
process.env.SOCIABUZZ_TOPUP_STORE_FILE = path.join(runtimeDirectory, 'payments.json');

const { createRizebotDatabase } = require('../src/services/rizebotDatabase');
const {
  calculateGeon,
  createSociabuzzTopupService,
  parsePayment,
} = require('../src/services/sociabuzzTopupService');
const { createTopupHandler } = require('../src/handlers/topupHandler');

function approvedEntry(userId = '100000000000000001', gamertag = 'presiden5531') {
  return {
    userId,
    gamertag,
    username: 'monodeco',
    status: 'approved',
    legal: true,
    verified: true,
  };
}

function registerStoreStub(entries, database = null) {
  return {
    getDatabase: () => database,
    getEntries: () => entries,
    getUser(userId) {
      return entries.find(entry => entry.userId === String(userId));
    },
    findUserByGamertag(query) {
      const key = String(query || '').replace(/\s+/g, '').toLowerCase();
      const entry = entries.find(item => item.gamertag.replace(/\s+/g, '').toLowerCase() === key);
      return entry ? { userId: entry.userId, entry } : null;
    },
  };
}

function screenshotSource(messageId = 'payment-screenshot') {
  return {
    kind: 'discord',
    sourceKey: `discord:${messageId}`,
    messageId,
    channelId: 'source-channel',
    content: '',
    embeds: [{
      title: 'DANA SEBESAR IDR10,000 DARI INVESTOR gideon',
      description: 'Nama :presiden5531|nama dc: monodeco',
      author: '',
      footer: '',
      url: '',
      fields: [],
    }],
  };
}

test('SociaBuzz parser understands Nama and Nama DC from the crowdfunding card', () => {
  const entry = approvedEntry();
  const payment = parsePayment(screenshotSource(), registerStoreStub([entry]));

  assert.equal(payment.rupiah, 10_000);
  assert.equal(payment.geon, 1_000);
  assert.equal(payment.identity.gamertag, 'presiden5531');
  assert.equal(payment.identity.discord, 'monodeco');
  assert.equal(payment.identity.donor, 'gideon');
  assert.equal(payment.autoCandidate.userId, entry.userId);
});

test('SociaBuzz parser recognizes the Gt-only format and active rate from the incident card', () => {
  const entry = approvedEntry('100000000000000009', 'Jozr Vladzov');
  const payment = parsePayment({
    kind: 'discord',
    sourceKey: 'discord:gt-only-48000',
    messageId: 'gt-only-48000',
    channelId: 'source-channel',
    content: '',
    embeds: [{
      title: 'DANA SEBESAR IDR48,000 DARI INVESTOR Someone',
      description: 'Gt: Jozr Vladzov',
      author: '', footer: '', url: '', fields: [],
    }],
  }, registerStoreStub([entry]), {
    rate: { version: 3, geonPer1000: 210 },
  });

  assert.equal(payment.identity.gamertag, 'Jozr Vladzov');
  assert.equal(payment.geon, 19_950);
  assert.equal(payment.autoCandidate.userId, entry.userId);
});

test('dynamic rate scales the complete tier curve proportionally', () => {
  assert.equal(calculateGeon(1_000, 150), 150);
  assert.equal(calculateGeon(10_000, 150), 1_500);
  assert.equal(calculateGeon(20_000, 150), 3_750);
  assert.equal(calculateGeon(50_000, 150), 15_000);
  assert.equal(calculateGeon(100_000, 150), 75_000);
});

test('admin rate command is parsed as a rate change and auto topup uses the shared calculator', async () => {
  let changedRate = 0;
  let queuedTopup = null;
  const bridge = {
    normalizePositiveInt(value, maximum) {
      const text = String(value || '').trim();
      if (!/^\d+$/.test(text)) return null;
      const number = Number(text);
      return number > 0 && number <= maximum ? number : null;
    },
    formatNumber: value => String(value),
    rupiahText: value => `Rp${value}`,
    resolveTarget() {
      return {
        ok: true,
        target: { userId: '100000000000000002', gamertag: 'RealPlayer', username: 'mono', verified: true },
      };
    },
    enqueueTopup(payload) {
      queuedTopup = payload;
      return { id: 'manual-job-1' };
    },
  };
  const sociabuzz = {
    calculateForRupiah: () => 1_500,
    setRate(value) {
      changedRate = value;
      return { version: 2, geonPer1000: value };
    },
    getRate: () => ({ version: 2, geonPer1000: 150 }),
    listRateHistory: () => [],
  };
  const handler = createTopupHandler({ bridge, sociabuzz });
  const replies = [];
  const message = content => ({
    content,
    author: {
      id: '683306687511265290',
      username: 'admin',
      bot: false,
    },
    async reply(payload) {
      replies.push(payload);
      return { id: 'loading', async edit() {} };
    },
  });

  assert.equal(await handler(message('!geonrate set 150 | Promo')), true);
  assert.equal(changedRate, 150);

  assert.equal(await handler(message('!tu RealPlayer auto 10000')), true);
  assert.equal(queuedTopup.geon, 1_500);
  assert.equal(queuedTopup.rupiah, 10_000);
});

test('unmatched payment stays open, can be redirected, learns aliases, and records Minecraft result', async () => {
  const dataDirectory = path.join(runtimeDirectory, 'database');
  const database = createRizebotDatabase({ dataDir: dataDirectory });
  const entry = approvedEntry('100000000000000002', 'RealPlayer');
  const registerStore = registerStoreStub([entry], database);
  const sentMessages = new Map();
  const logChannel = {
    async send(payload) {
      const message = {
        id: `log-${sentMessages.size + 1}`,
        payload,
        async edit(next) {
          this.payload = next;
          return this;
        },
      };
      sentMessages.set(message.id, message);
      return message;
    },
    messages: {
      async fetch(messageId) {
        return sentMessages.get(messageId) || null;
      },
    },
  };
  let resultListener = null;
  let failNextEnqueue = false;
  const jobs = [];
  const bridge = {
    onJobResult(listener) {
      resultListener = listener;
      return () => {};
    },
    enqueueTopup(payload) {
      if (failNextEnqueue) {
        failNextEnqueue = false;
        throw new Error('simulated bridge persistence failure');
      }
      const job = { id: `job-${jobs.length + 1}`, type: 'topup', ...payload };
      jobs.push(job);
      return job;
    },
  };
  const client = {
    channels: { fetch: async () => logChannel },
    users: { cache: new Map() },
    guilds: { cache: new Map() },
  };

  try {
    const service = createSociabuzzTopupService({ bridge, registerStore, client });
    const received = await service.handleWebhookPayload({
      payment_id: 'unmatched-001',
      provider: 'SociaBuzz',
      amount: '10000',
      message: 'Nama: wrongplayer | Nama DC: mysteryperson',
    });

    assert.equal(received.ok, true);
    assert.equal(received.code, 'needs-target');
    assert.equal(received.record.status, 'needs_target');
    assert.equal(jobs.length, 0);
    assert.equal(sentMessages.get(received.record.logMessageId).payload.components.length, 2);

    const rate = service.setRate(150, { id: 'admin', name: 'Admin' }, 'Promo test');
    assert.equal(rate.geonPer1000, 150);
    assert.equal(service.calculateForRupiah(10_000), 1_500);

    const resolved = await service.resolvePayment(
      received.record.id,
      'RealPlayer',
      { id: 'admin', name: 'Admin' }
    );
    assert.equal(resolved.ok, true);
    assert.equal(resolved.record.status, 'queued');
    assert.equal(resolved.record.geon, 1_000, 'rate is frozen when payment is received');
    assert.equal(jobs.length, 1);
    assert.equal(database.findTopupRecipientAlias('wrongplayer').userId, entry.userId);
    assert.equal(database.findTopupRecipientAlias('mysteryperson').userId, entry.userId);
    assert.equal(database.getSociabuzzPayment(received.record.id).status, 'queued');

    const learned = service.parsePayment({
      ...screenshotSource('learned-payment'),
      embeds: [{
        title: 'DANA SEBESAR IDR10,000 DARI INVESTOR someoneelse',
        description: 'Nama: wrongplayer | Nama DC: mysteryperson',
        author: '', footer: '', url: '', fields: [],
      }],
    });
    assert.equal(learned.autoCandidate.userId, entry.userId);
    assert.equal(learned.geon, 1_500);

    const duplicatePayload = {
      payment_id: 'concurrent-exact-001',
      provider: 'SociaBuzz',
      amount: '10000',
      message: 'Nama: RealPlayer | Nama DC: monodeco',
    };
    const duplicateResults = await Promise.all([
      service.handleWebhookPayload(duplicatePayload),
      service.handleWebhookPayload(duplicatePayload),
    ]);
    assert.equal(duplicateResults[0].record.id, duplicateResults[1].record.id);
    assert.equal(jobs.length, 2, 'concurrent copies of one payment enqueue one bridge job');

    await resultListener({
      job: jobs[0],
      result: { ok: true, status: 'pending' },
    });
    assert.equal(database.getSociabuzzPayment(received.record.id).status, 'pending_join');

    failNextEnqueue = true;
    const recoverablePayload = {
      payment_id: 'recoverable-exact-001',
      provider: 'SociaBuzz',
      amount: '1000',
      message: 'Nama: RealPlayer | Nama DC: monodeco',
    };
    await assert.rejects(
      service.handleWebhookPayload(recoverablePayload),
      /simulated bridge persistence failure/
    );
    const recoverable = database.listSociabuzzPayments({ limit: 20 })
      .find(record => record.sourceKey === 'webhook:recoverable-exact-001');
    assert.ok(recoverable);
    assert.equal(database.getSociabuzzPayment(recoverable.id).status, 'preparing');
    const recovery = await service.recoverPendingPayments();
    assert.equal(recovery.failed, 0);
    assert.equal(database.getSociabuzzPayment(recoverable.id).status, 'queued');
  } finally {
    database.close();
  }
});

test.after(() => {
  fs.rmSync(runtimeDirectory, { recursive: true, force: true });
});
