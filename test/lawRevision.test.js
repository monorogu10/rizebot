const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { createRizebotDatabase } = require('../src/services/rizebotDatabase');
const { createLawHandler } = require('../src/handlers/lawHandler');

test('law revision draft preserves the published version until publish', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rizebot-law-revision-test-'));
  const database = createRizebotDatabase({ dataDir: directory });
  const actor = { id: '100001', name: 'Law Admin' };
  try {
    database.init();
    let law = database.createLawDraft({ note: 'Ketentuan pertama tetap berlaku.', title: 'Ketertiban', actor });
    law = database.publishLaw(law.id, actor);
    const versionOneText = law.articles[0].paragraphs[0].content;
    assert.equal(law.version, 1);
    assert.equal(law.revisionStatus, 'PUBLISHED');

    const draft = database.createLawRevisionDraft(law.code, 'Menambahkan ketentuan kedua.', actor);
    assert.equal(draft.version, 2);
    assert.equal(draft.baseVersion, 1);
    assert.equal(draft.revisionStatus, 'DRAFT');
    assert.equal(database.getLaw(law.code).version, 1);

    const sameDraft = database.createLawRevisionDraft(law.code, 'Catatan lain tidak menimpa draft.', actor);
    assert.equal(sameDraft.version, 2);
    const edited = database.addLawParagraph(law.id, 'Ketentuan kedua yang baru.', actor, 1);
    assert.equal(edited.articles[0].paragraphs.length, 2);
    assert.equal(edited.articles[0].paragraphs[0].content, versionOneText);

    const oldVersion = database.getLaw(law.code, { version: 1 });
    assert.equal(oldVersion.articles[0].paragraphs.length, 1);
    assert.equal(oldVersion.articles[0].paragraphs[0].content, versionOneText);
    const diff = database.lawRevisionDiff(law.id, 2);
    assert.equal(diff.changes.some(change => change.type === 'ADD_PARAGRAPH' && change.paragraph === 2), true);

    const published = database.publishLawRevisionDraft(law.id, actor);
    assert.equal(published.version, 2);
    assert.equal(published.status, 'AMENDED');
    assert.equal(published.revisionStatus, 'PUBLISHED');
    assert.equal(database.getLaw(law.code).articles[0].paragraphs.length, 2);
    assert.equal(database.getLawRevisionDraft(law.code), null);

    database.createLawRevisionDraft(law.code, 'Draft yang akan dibatalkan.', actor);
    assert.throws(() => database.publishLawRevisionDraft(law.id, actor), /belum memiliki perubahan/i);
    database.addLawParagraph(law.id, 'Tidak boleh menjadi publik.', actor, 1);
    database.discardLawRevisionDraft(law.id, actor);
    assert.equal(database.getLawRevisionDraft(law.code), null);
    assert.equal(database.getLaw(law.code).version, 2);
    assert.equal(database.getLaw(law.code).articles[0].paragraphs.length, 2);

    const json = JSON.parse(fs.readFileSync(path.join(directory, 'laws.json'), 'utf8'));
    assert.equal(json.version, 2);
    assert.deepEqual(json.revisionDrafts, []);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('repealing a paragraph is visible only in the revision draft until publish', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rizebot-law-repeal-test-'));
  const database = createRizebotDatabase({ dataDir: directory });
  const actor = { id: '100002', name: 'Law Admin' };
  try {
    database.init();
    const initial = database.createLawDraft({ note: 'Ayat yang masih berlaku.', actor });
    const published = database.publishLaw(initial.id, actor);
    database.createLawRevisionDraft(published.code, 'Mencabut ketentuan lama.', actor);
    const draft = database.setLawParagraphRepealed(
      published.id,
      1,
      1,
      { repealed: true, reason: 'Ketentuan sudah tidak relevan.' },
      actor
    );
    assert.equal(draft.articles[0].paragraphs[0].status, 'REPEALED');
    assert.equal(database.getLaw(published.code).articles[0].paragraphs[0].status, 'ACTIVE');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema migration upgrades an existing published law without changing its content', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rizebot-law-migration-test-'));
  const databaseFile = path.join(directory, 'rizebot.db');
  const legacy = new DatabaseSync(databaseFile);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE laws (
      id INTEGER PRIMARY KEY AUTOINCREMENT, law_code TEXT UNIQUE, law_number INTEGER, law_year INTEGER,
      title TEXT NOT NULL, status TEXT NOT NULL, current_version INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL, created_by_name TEXT NOT NULL, created_at TEXT NOT NULL,
      published_by TEXT NOT NULL DEFAULT '', published_by_name TEXT NOT NULL DEFAULT '', published_at TEXT,
      effective_at TEXT, revoked_by TEXT NOT NULL DEFAULT '', revoked_by_name TEXT NOT NULL DEFAULT '',
      revoked_at TEXT, revoke_reason TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
      UNIQUE(law_year, law_number)
    );
    CREATE TABLE law_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, law_id INTEGER NOT NULL REFERENCES laws(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL, title TEXT NOT NULL, change_note TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL, created_by_name TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(law_id, version_number)
    );
    CREATE TABLE law_articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT, version_id INTEGER NOT NULL REFERENCES law_versions(id) ON DELETE CASCADE,
      article_number INTEGER NOT NULL, heading TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL,
      UNIQUE(version_id, article_number)
    );
    CREATE TABLE law_paragraphs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, article_id INTEGER NOT NULL REFERENCES law_articles(id) ON DELETE CASCADE,
      paragraph_number INTEGER NOT NULL, content TEXT NOT NULL, position INTEGER NOT NULL,
      UNIQUE(article_id, paragraph_number)
    );
    INSERT INTO laws(
      id, law_code, law_number, law_year, title, status, current_version, created_by, created_by_name,
      created_at, published_by, published_by_name, published_at, effective_at, updated_at
    ) VALUES (1, 'UU-EG-2026-001', 1, 2026, 'UU Lama', 'ACTIVE', 1, '1', 'Admin',
      '2026-01-01T00:00:00.000Z', '1', 'Admin', '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO law_versions(id, law_id, version_number, title, change_note, created_by, created_by_name, created_at)
      VALUES (1, 1, 1, 'UU Lama', 'Versi awal', '1', 'Admin', '2026-01-01T00:00:00.000Z');
    INSERT INTO law_articles(id, version_id, article_number, heading, position) VALUES (1, 1, 1, 'Ketentuan', 1);
    INSERT INTO law_paragraphs(id, article_id, paragraph_number, content, position)
      VALUES (1, 1, 1, 'Isi lama harus tetap sama.', 1);
  `);
  legacy.close();

  const database = createRizebotDatabase({ dataDir: directory, databaseFile });
  try {
    database.init();
    const law = database.getLaw('UU-EG-2026-001');
    assert.equal(law.revisionStatus, 'PUBLISHED');
    assert.equal(law.articles[0].paragraphs[0].status, 'ACTIVE');
    assert.equal(law.articles[0].paragraphs[0].content, 'Isi lama harus tetap sama.');
    const draft = database.createLawRevisionDraft(law.code, 'Uji migrasi revisi.', { id: '2', name: 'Admin Baru' });
    assert.equal(draft.baseVersion, 1);
    assert.equal(database.getLaw(law.code).articles[0].paragraphs[0].content, 'Isi lama harus tetap sama.');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('revise command selects a Pasal before opening the revision editor', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rizebot-law-ui-test-'));
  const database = createRizebotDatabase({ dataDir: directory });
  const actor = { id: '100003', name: 'Law Admin' };
  const panels = [];
  function makeCollector() {
    const handlers = {};
    return {
      handlers,
      on(event, callback) {
        handlers[event] = callback;
        return this;
      },
      stop(reason) {
        handlers.end?.(new Map(), reason);
      },
    };
  }
  try {
    database.init();
    let law = database.createLawDraft({ note: 'Isi awal.', title: 'UU Panel', actor });
    law = database.publishLaw(law.id, actor);
    const msg = {
      content: `!revise-uu ${law.code}`,
      author: { id: actor.id, username: 'law-admin', tag: 'law-admin#0001', bot: false },
      member: { permissions: { has: () => true } },
      async reply(payload) {
        const collector = makeCollector();
        const panel = {
          payload,
          collector,
          edits: [],
          createMessageComponentCollector() {
            return collector;
          },
          async edit(next) {
            panel.edits.push(next);
            return panel;
          },
        };
        panels.push(panel);
        return panel;
      },
    };
    const handler = createLawHandler({ database, serverStatusNotifier: null });
    assert.equal(await handler(msg), true);
    assert.equal(panels.length, 1);
    assert.match(panels[0].payload.embeds[0].data.title, /Pilih Pasal/i);

    const selectId = panels[0].payload.components[0].components[0].data.custom_id;
    let modalId = '';
    const interaction = {
      customId: selectId,
      values: ['1'],
      user: { id: actor.id },
      replied: false,
      deferred: false,
      async showModal(modal) {
        modalId = modal.data.custom_id;
        interaction.replied = true;
      },
      async awaitModalSubmit({ filter }) {
        const submit = {
          customId: modalId,
          user: { id: actor.id },
          fields: { getTextInputValue: () => 'Menambahkan Ayat baru.' },
          replied: false,
          deferred: false,
          async reply() {
            submit.replied = true;
          },
        };
        assert.equal(filter(submit), true);
        return submit;
      },
      async followUp() {},
    };
    await panels[0].collector.handlers.collect(interaction);
    assert.equal(panels.length, 2);
    const editorLabels = panels[1].payload.components
      .flatMap(row => row.components.map(component => component.data.label));
    assert.equal(editorLabels.includes('Tambah Ayat'), true);
    assert.equal(editorLabels.includes('Lihat Perubahan'), true);
    assert.equal(editorLabels.includes('Terbitkan Revisi'), true);
    assert.equal(database.getLaw(law.code).version, 1);
    assert.equal(database.getLawRevisionDraft(law.code).version, 2);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
