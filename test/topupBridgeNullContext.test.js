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

test.after(() => {
  fs.rmSync(runtimeDirectory, { recursive: true, force: true });
});
