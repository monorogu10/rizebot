const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');

const DEFAULT_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_BACKUP_RETENTION = 14;

function normalizeGamertagKey(value) {
  return String(value || '').replace(/\s+/g, '').trim().toLowerCase();
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-');
}

function cleanLawText(value, maxLength = 1800) {
  return String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n/g, '\n').trim().slice(0, maxLength);
}

function jakartaYear(date = new Date()) {
  const value = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jakarta', year: 'numeric' }).format(date);
  return Math.max(2000, Math.floor(Number(value) || date.getUTCFullYear()));
}

function lawActor(actor = {}) {
  return {
    id: String(actor.id || actor.userId || '').trim(),
    name: cleanLawText(actor.name || actor.tag || actor.username || 'Unknown Admin', 100),
  };
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function createRizebotDatabase({
  dataDir = process.env.RIZEBOT_DATA_DIR || path.join(__dirname, '..', '..', 'data'),
  databaseFile = process.env.RIZEBOT_DATABASE_FILE || '',
  registrationJsonFile = process.env.RIZEBOT_REGISTER_JSON_BACKUP_FILE || '',
  rulesCacheJsonFile = process.env.RIZEBOT_RULES_JSON_BACKUP_FILE || '',
  lawsJsonFile = process.env.RIZEBOT_LAWS_JSON_BACKUP_FILE || '',
  backupDir = process.env.RIZEBOT_BACKUP_DIR || '',
  backupIntervalMs = Number(process.env.RIZEBOT_DB_BACKUP_INTERVAL_MS) || DEFAULT_BACKUP_INTERVAL_MS,
  backupRetention = Number(process.env.RIZEBOT_DB_BACKUP_RETENTION) || DEFAULT_BACKUP_RETENTION,
} = {}) {
  const resolvedDataDir = path.resolve(dataDir);
  const resolvedDatabaseFile = path.resolve(databaseFile || path.join(resolvedDataDir, 'rizebot.db'));
  const resolvedRegistrationJsonFile = path.resolve(
    registrationJsonFile || path.join(resolvedDataDir, 'register-data.json')
  );
  const resolvedRulesCacheJsonFile = path.resolve(
    rulesCacheJsonFile || path.join(resolvedDataDir, 'rules-cache.json')
  );
  const resolvedLawsJsonFile = path.resolve(
    lawsJsonFile || path.join(resolvedDataDir, 'laws.json')
  );
  const resolvedBackupDir = path.resolve(backupDir || path.join(resolvedDataDir, 'backups'));
  const safeBackupIntervalMs = Math.max(60_000, Math.floor(Number(backupIntervalMs) || DEFAULT_BACKUP_INTERVAL_MS));
  const safeBackupRetention = Math.max(2, Math.min(100, Math.floor(Number(backupRetention) || DEFAULT_BACKUP_RETENTION)));

  let db = null;
  let backupTimer = null;
  let backupPromise = null;

  function ensureOpen() {
    if (!db) throw new Error('Rizebot database is not initialized');
    return db;
  }

  function migrate() {
    const connection = ensureOpen();
    connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS registrations (
        user_id TEXT PRIMARY KEY,
        position INTEGER NOT NULL UNIQUE,
        gamertag TEXT NOT NULL,
        gamertag_key TEXT NOT NULL UNIQUE,
        username TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
        persistent_id TEXT NOT NULL DEFAULT '',
        verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
        registered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        entry_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_registrations_status ON registrations(status);
      CREATE INDEX IF NOT EXISTS idx_registrations_persistent_id ON registrations(persistent_id);
      CREATE INDEX IF NOT EXISTS idx_registrations_updated_at ON registrations(updated_at);

      CREATE TABLE IF NOT EXISTS storage_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store_name TEXT NOT NULL,
        operation TEXT NOT NULL,
        record_count INTEGER NOT NULL DEFAULT 0,
        detail TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (1, datetime('now'));

      CREATE TABLE IF NOT EXISTS rules_cache (
        cache_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'minecraft',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS laws (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        law_code TEXT UNIQUE,
        law_number INTEGER,
        law_year INTEGER,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'AMENDED', 'REVOKED', 'ARCHIVED')),
        current_version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL,
        created_by_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        published_by TEXT NOT NULL DEFAULT '',
        published_by_name TEXT NOT NULL DEFAULT '',
        published_at TEXT,
        effective_at TEXT,
        revoked_by TEXT NOT NULL DEFAULT '',
        revoked_by_name TEXT NOT NULL DEFAULT '',
        revoked_at TEXT,
        revoke_reason TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        UNIQUE(law_year, law_number)
      );

      CREATE INDEX IF NOT EXISTS idx_laws_status ON laws(status);
      CREATE INDEX IF NOT EXISTS idx_laws_number ON laws(law_year, law_number);
      CREATE INDEX IF NOT EXISTS idx_laws_updated_at ON laws(updated_at);

      CREATE TABLE IF NOT EXISTS law_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        law_id INTEGER NOT NULL REFERENCES laws(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        change_note TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_by_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(law_id, version_number)
      );

      CREATE TABLE IF NOT EXISTS law_articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id INTEGER NOT NULL REFERENCES law_versions(id) ON DELETE CASCADE,
        article_number INTEGER NOT NULL,
        heading TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL,
        UNIQUE(version_id, article_number)
      );

      CREATE TABLE IF NOT EXISTS law_paragraphs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        article_id INTEGER NOT NULL REFERENCES law_articles(id) ON DELETE CASCADE,
        paragraph_number INTEGER NOT NULL,
        content TEXT NOT NULL,
        position INTEGER NOT NULL,
        UNIQUE(article_id, paragraph_number)
      );

      CREATE TABLE IF NOT EXISTS law_audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        law_id INTEGER REFERENCES laws(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_law_audit_law_id ON law_audit_logs(law_id);

      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (2, datetime('now'));

      CREATE TABLE IF NOT EXISTS interview_sessions (
        session_number INTEGER PRIMARY KEY AUTOINCREMENT,
        interview_id TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL DEFAULT '',
        gamertag TEXT NOT NULL,
        gamertag_key TEXT NOT NULL,
        channel_id TEXT NOT NULL DEFAULT '',
        lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN (
          'RESERVED', 'OPEN', 'CLOSED', 'PROVISION_FAILED', 'ORPHANED', 'CONFLICT'
        )),
        decision TEXT NOT NULL DEFAULT 'PENDING' CHECK (decision IN ('PENDING', 'APPROVED', 'REJECTED')),
        attempt INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL DEFAULT 'discord',
        legacy_interview_id TEXT NOT NULL DEFAULT '',
        reserved_at TEXT NOT NULL,
        opened_at TEXT,
        resolved_at TEXT,
        resolved_by TEXT NOT NULL DEFAULT '',
        resolved_by_name TEXT NOT NULL DEFAULT '',
        decision_reason TEXT NOT NULL DEFAULT '',
        closed_at TEXT,
        closed_by TEXT NOT NULL DEFAULT '',
        closed_by_name TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_interview_sessions_channel_unique
      ON interview_sessions(channel_id) WHERE channel_id <> '';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_interview_sessions_active_user
      ON interview_sessions(user_id) WHERE lifecycle_status IN ('RESERVED', 'OPEN');
      CREATE UNIQUE INDEX IF NOT EXISTS idx_interview_sessions_active_gamertag
      ON interview_sessions(gamertag_key) WHERE lifecycle_status IN ('RESERVED', 'OPEN');
      CREATE INDEX IF NOT EXISTS idx_interview_sessions_user ON interview_sessions(user_id, session_number DESC);
      CREATE INDEX IF NOT EXISTS idx_interview_sessions_status ON interview_sessions(lifecycle_status, decision);

      CREATE TABLE IF NOT EXISTS interview_audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_number INTEGER REFERENCES interview_sessions(session_number) ON DELETE SET NULL,
        interview_id TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL,
        actor_id TEXT NOT NULL DEFAULT '',
        actor_name TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_interview_audit_session
      ON interview_audit_logs(session_number, created_at DESC);

      CREATE TABLE IF NOT EXISTS registration_conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        gamertag TEXT NOT NULL DEFAULT '',
        conflict_type TEXT NOT NULL,
        canonical_user_id TEXT NOT NULL DEFAULT '',
        entry_json TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT NOT NULL DEFAULT '',
        resolution TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_registration_conflicts_open
      ON registration_conflicts(resolved_at, user_id);

      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (3, datetime('now'));

      CREATE TABLE IF NOT EXISTS geon_rate_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        geon_per_1000 INTEGER NOT NULL CHECK (geon_per_1000 BETWEEN 1 AND 1000000),
        changed_by TEXT NOT NULL DEFAULT '',
        changed_by_name TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      INSERT INTO geon_rate_versions(
        geon_per_1000, changed_by, changed_by_name, reason, created_at
      )
      SELECT 100, 'system', 'Rizebot migration', 'Default Geon rate', datetime('now')
      WHERE NOT EXISTS (SELECT 1 FROM geon_rate_versions);

      CREATE TABLE IF NOT EXISTS topup_recipient_aliases (
        alias_key TEXT PRIMARY KEY,
        alias_text TEXT NOT NULL,
        alias_type TEXT NOT NULL DEFAULT 'manual',
        user_id TEXT NOT NULL,
        confirmed_by TEXT NOT NULL DEFAULT '',
        confirmed_by_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_topup_alias_user
      ON topup_recipient_aliases(user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS sociabuzz_payments (
        payment_id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        recipient_user_id TEXT NOT NULL DEFAULT '',
        job_id TEXT NOT NULL DEFAULT '',
        rupiah INTEGER NOT NULL DEFAULT 0,
        geon INTEGER NOT NULL DEFAULT 0,
        rate_version INTEGER NOT NULL DEFAULT 0,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sociabuzz_payments_status
      ON sociabuzz_payments(status, updated_at DESC);

    `);

    const versionColumns = new Set(connection.prepare('PRAGMA table_info(law_versions)').all().map(row => String(row.name)));
    if (!versionColumns.has('revision_status')) {
      connection.exec("ALTER TABLE law_versions ADD COLUMN revision_status TEXT NOT NULL DEFAULT 'PUBLISHED';");
    }
    if (!versionColumns.has('base_version')) {
      connection.exec('ALTER TABLE law_versions ADD COLUMN base_version INTEGER NOT NULL DEFAULT 0;');
    }
    if (!versionColumns.has('updated_at')) {
      connection.exec("ALTER TABLE law_versions ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';");
    }
    if (!versionColumns.has('published_at')) {
      connection.exec('ALTER TABLE law_versions ADD COLUMN published_at TEXT;');
    }
    const paragraphColumns = new Set(connection.prepare('PRAGMA table_info(law_paragraphs)').all().map(row => String(row.name)));
    if (!paragraphColumns.has('paragraph_status')) {
      connection.exec("ALTER TABLE law_paragraphs ADD COLUMN paragraph_status TEXT NOT NULL DEFAULT 'ACTIVE';");
    }
    if (!paragraphColumns.has('repeal_note')) {
      connection.exec("ALTER TABLE law_paragraphs ADD COLUMN repeal_note TEXT NOT NULL DEFAULT '';");
    }
    connection.exec(`
      UPDATE law_versions SET updated_at = created_at WHERE updated_at = '';
      UPDATE law_versions SET published_at = created_at
      WHERE revision_status = 'PUBLISHED' AND published_at IS NULL;
      UPDATE law_versions SET revision_status = 'DRAFT'
      WHERE law_id IN (SELECT id FROM laws WHERE status = 'DRAFT');
      UPDATE law_versions SET revision_status = 'ARCHIVED'
      WHERE law_id IN (SELECT id FROM laws WHERE status = 'ARCHIVED');
      CREATE UNIQUE INDEX IF NOT EXISTS idx_law_versions_one_draft
      ON law_versions(law_id) WHERE revision_status = 'DRAFT';
      CREATE INDEX IF NOT EXISTS idx_law_versions_state
      ON law_versions(law_id, revision_status, version_number DESC);
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (4, datetime('now'));
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (5, datetime('now'));
    `);
  }

  function integrityCheck() {
    const rows = ensureOpen().prepare('PRAGMA quick_check').all();
    const messages = rows.map(row => String(row.quick_check || Object.values(row)[0] || ''));
    const ok = messages.length === 1 && messages[0].toLowerCase() === 'ok';
    if (!ok) throw new Error(`SQLite integrity check failed: ${messages.join('; ') || 'unknown'}`);
    return { ok: true, messages };
  }

  function init() {
    if (db) return getStatus();
    fs.mkdirSync(resolvedDataDir, { recursive: true });
    fs.mkdirSync(resolvedBackupDir, { recursive: true });
    db = new DatabaseSync(resolvedDatabaseFile);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = FULL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    migrate();
    integrityCheck();
    return getStatus();
  }

  function metadataValue(key) {
    const row = ensureOpen().prepare('SELECT value FROM app_metadata WHERE key = ?').get(String(key));
    return row ? String(row.value) : '';
  }

  function loadRegistrationSnapshot() {
    ensureOpen();
    const initialized = metadataValue('registration_initialized') === '1';
    if (!initialized) return { initialized: false, data: null };

    const users = {};
    const order = [];
    const rows = db.prepare(`
      SELECT user_id, entry_json
      FROM registrations
      ORDER BY position ASC
    `).all();
    for (const row of rows) {
      try {
        const entry = JSON.parse(String(row.entry_json || '{}'));
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const userId = String(row.user_id);
        users[userId] = entry;
        order.push(userId);
      } catch (error) {
        throw new Error(`Invalid registration JSON in SQLite for user ${row.user_id}: ${error.message}`);
      }
    }

    return {
      initialized: true,
      data: {
        users,
        order,
        interviewSequence: Math.max(0, Math.floor(Number(metadataValue('registration_interview_sequence')) || 0)),
        updatedAt: metadataValue('registration_updated_at') || new Date().toISOString(),
      },
    };
  }

  function saveRegistrationSnapshot(snapshot = {}, { operation = 'save' } = {}) {
    const connection = ensureOpen();
    const users = snapshot.users && typeof snapshot.users === 'object' ? snapshot.users : {};
    const order = Array.isArray(snapshot.order) ? snapshot.order.map(String) : Object.keys(users);
    const now = new Date().toISOString();
    const updatedAt = String(snapshot.updatedAt || now);
    const interviewSequence = Math.max(
      0,
      Math.floor(Number(snapshot.interviewSequence) || 0),
      Math.floor(Number(metadataValue('registration_interview_sequence')) || 0)
    );
    const insert = connection.prepare(`
      INSERT INTO registrations (
        user_id, position, gamertag, gamertag_key, username, status,
        persistent_id, verified, registered_at, updated_at, entry_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const upsertMetadata = connection.prepare(`
      INSERT INTO app_metadata(key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    connection.exec('BEGIN IMMEDIATE;');
    try {
      connection.exec('DELETE FROM registrations;');
      let position = 0;
      for (const userId of order) {
        const entry = users[userId];
        if (!entry || typeof entry !== 'object') continue;
        const gamertag = String(entry.gamertag || '').replace(/\s+/g, ' ').trim();
        const gamertagKey = normalizeGamertagKey(gamertag);
        if (!gamertagKey) continue;
        const status = ['pending', 'approved', 'rejected'].includes(String(entry.status))
          ? String(entry.status)
          : 'pending';
        insert.run(
          String(userId),
          position,
          gamertag,
          gamertagKey,
          String(entry.username || ''),
          status,
          String(entry.persistentId || ''),
          entry.verified ? 1 : 0,
          String(entry.registeredAt || updatedAt),
          String(entry.updatedAt || entry.registeredAt || updatedAt),
          JSON.stringify(entry)
        );
        position += 1;
      }
      upsertMetadata.run('registration_initialized', '1', now);
      upsertMetadata.run('registration_interview_sequence', String(interviewSequence), now);
      upsertMetadata.run('registration_updated_at', updatedAt, now);
      connection.prepare(`
        INSERT INTO storage_audit(store_name, operation, record_count, detail, created_at)
        VALUES ('registrations', ?, ?, ?, ?)
      `).run(String(operation), position, `sequence=${interviewSequence}`, now);
      connection.exec(`
        DELETE FROM storage_audit
        WHERE id NOT IN (SELECT id FROM storage_audit ORDER BY id DESC LIMIT 1000);
      `);
      connection.exec('COMMIT;');
    } catch (error) {
      connection.exec('ROLLBACK;');
      throw error;
    }

    const stored = loadRegistrationSnapshot().data;
    writeJsonAtomic(resolvedRegistrationJsonFile, stored);
    return { ok: true, count: stored.order.length, updatedAt: stored.updatedAt };
  }

  function loadRegistrationJsonBackup() {
    if (!fs.existsSync(resolvedRegistrationJsonFile)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(resolvedRegistrationJsonFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !parsed.users) return null;
      return parsed;
    } catch (error) {
      throw new Error(`Invalid registration JSON backup ${resolvedRegistrationJsonFile}: ${error.message}`);
    }
  }

  function exportRegistrationJsonBackup() {
    const stored = loadRegistrationSnapshot();
    if (!stored.initialized || !stored.data) {
      throw new Error('Registration store has not been initialized in SQLite');
    }
    writeJsonAtomic(resolvedRegistrationJsonFile, stored.data);
    return {
      ok: true,
      file: resolvedRegistrationJsonFile,
      count: stored.data.order.length,
    };
  }

  function interviewRow(row) {
    if (!row) return null;
    return {
      sessionNumber: Number(row.session_number),
      interviewId: String(row.interview_id),
      userId: String(row.user_id),
      username: String(row.username || ''),
      gamertag: String(row.gamertag || ''),
      gamertagKey: String(row.gamertag_key || ''),
      channelId: String(row.channel_id || ''),
      lifecycleStatus: String(row.lifecycle_status),
      decision: String(row.decision),
      attempt: Number(row.attempt || 1),
      source: String(row.source || ''),
      legacyInterviewId: String(row.legacy_interview_id || ''),
      reservedAt: String(row.reserved_at),
      openedAt: row.opened_at ? String(row.opened_at) : null,
      resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
      resolvedBy: String(row.resolved_by || ''),
      resolvedByName: String(row.resolved_by_name || ''),
      decisionReason: String(row.decision_reason || ''),
      closedAt: row.closed_at ? String(row.closed_at) : null,
      closedBy: String(row.closed_by || ''),
      closedByName: String(row.closed_by_name || ''),
      updatedAt: String(row.updated_at),
    };
  }

  function saveRegistrationConflicts(conflicts = []) {
    ensureOpen();
    const insert = db.prepare(`
      INSERT INTO registration_conflicts(
        user_id, gamertag, conflict_type, canonical_user_id, entry_json, detected_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    const now = new Date().toISOString();
    for (const conflict of Array.isArray(conflicts) ? conflicts : []) {
      const userId = String(conflict?.userId || '').trim();
      const gamertag = cleanLawText(conflict?.entry?.gamertag || conflict?.gamertag, 64);
      const type = String(conflict?.type || 'duplicate-gamertag');
      if (!userId) continue;
      const exists = db.prepare(`
        SELECT 1 FROM registration_conflicts
        WHERE user_id = ? AND conflict_type = ? AND lower(gamertag) = lower(?) AND resolved_at IS NULL
        LIMIT 1
      `).get(userId, type, gamertag);
      if (exists) continue;
      insert.run(
        userId,
        gamertag,
        type,
        String(conflict?.canonicalUserId || ''),
        JSON.stringify(conflict?.entry || {}),
        now
      );
      inserted += 1;
    }
    return { ok: true, inserted };
  }

  function listRegistrationConflicts({ openOnly = true, limit = 500 } = {}) {
    ensureOpen();
    const safeLimit = Math.max(1, Math.min(5000, Math.floor(Number(limit) || 500)));
    const where = openOnly ? 'WHERE resolved_at IS NULL' : '';
    return db.prepare(`SELECT * FROM registration_conflicts ${where} ORDER BY id DESC LIMIT ${safeLimit}`).all().map(row => ({
      id: Number(row.id), userId: String(row.user_id), gamertag: String(row.gamertag || ''),
      conflictType: String(row.conflict_type), canonicalUserId: String(row.canonical_user_id || ''),
      entry: JSON.parse(String(row.entry_json || '{}')), detectedAt: String(row.detected_at),
      resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
      resolvedBy: String(row.resolved_by || ''), resolution: String(row.resolution || ''),
    }));
  }

  function topupAliasKey(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '')
      .slice(0, 160);
  }

  function getGeonRate() {
    ensureOpen();
    const row = db.prepare(`
      SELECT id, geon_per_1000, changed_by, changed_by_name, reason, created_at
      FROM geon_rate_versions ORDER BY id DESC LIMIT 1
    `).get();
    return row ? {
      version: Number(row.id),
      geonPer1000: Number(row.geon_per_1000),
      changedBy: String(row.changed_by || ''),
      changedByName: String(row.changed_by_name || ''),
      reason: String(row.reason || ''),
      createdAt: String(row.created_at || ''),
    } : null;
  }

  function setGeonRate(geonPer1000Raw, actor = {}, reason = '') {
    ensureOpen();
    const geonPer1000 = Math.floor(Number(geonPer1000Raw) || 0);
    if (geonPer1000 < 1 || geonPer1000 > 1_000_000) {
      throw new Error('Geon rate harus antara 1 dan 1.000.000 per Rp1.000');
    }
    const who = lawActor(actor);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO geon_rate_versions(
        geon_per_1000, changed_by, changed_by_name, reason, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(geonPer1000, who.id, who.name, cleanLawText(reason, 240), now);
    return getGeonRate();
  }

  function listGeonRateHistory({ limit = 10 } = {}) {
    ensureOpen();
    const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 10)));
    return db.prepare(`
      SELECT id, geon_per_1000, changed_by, changed_by_name, reason, created_at
      FROM geon_rate_versions ORDER BY id DESC LIMIT ${safeLimit}
    `).all().map(row => ({
      version: Number(row.id),
      geonPer1000: Number(row.geon_per_1000),
      changedBy: String(row.changed_by || ''),
      changedByName: String(row.changed_by_name || ''),
      reason: String(row.reason || ''),
      createdAt: String(row.created_at || ''),
    }));
  }

  function saveTopupRecipientAlias(aliasRaw, userIdRaw, actor = {}, aliasType = 'manual') {
    ensureOpen();
    const aliasText = cleanLawText(aliasRaw, 160).replace(/\s+/g, ' ').trim();
    const aliasKey = topupAliasKey(aliasText);
    const userId = String(userIdRaw || '').trim();
    if (!aliasKey || !userId) return null;
    const who = lawActor(actor);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO topup_recipient_aliases(
        alias_key, alias_text, alias_type, user_id, confirmed_by, confirmed_by_name,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(alias_key) DO UPDATE SET
        alias_text = excluded.alias_text,
        alias_type = excluded.alias_type,
        user_id = excluded.user_id,
        confirmed_by = excluded.confirmed_by,
        confirmed_by_name = excluded.confirmed_by_name,
        updated_at = excluded.updated_at
    `).run(
      aliasKey,
      aliasText,
      cleanLawText(aliasType || 'manual', 40),
      userId,
      who.id,
      who.name,
      now,
      now
    );
    return findTopupRecipientAlias(aliasText);
  }

  function findTopupRecipientAlias(aliasRaw) {
    ensureOpen();
    const aliasKey = topupAliasKey(aliasRaw);
    if (!aliasKey) return null;
    const row = db.prepare(`
      SELECT alias_key, alias_text, alias_type, user_id, confirmed_by,
        confirmed_by_name, created_at, updated_at
      FROM topup_recipient_aliases WHERE alias_key = ?
    `).get(aliasKey);
    return row ? {
      aliasKey: String(row.alias_key),
      alias: String(row.alias_text),
      type: String(row.alias_type),
      userId: String(row.user_id),
      confirmedBy: String(row.confirmed_by || ''),
      confirmedByName: String(row.confirmed_by_name || ''),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    } : null;
  }

  function saveSociabuzzPayment(record = {}) {
    ensureOpen();
    const paymentId = String(record.id || '').trim();
    const sourceKey = String(record.sourceKey || '').trim();
    if (!paymentId || !sourceKey) throw new Error('SociaBuzz payment id/source tidak valid');
    const now = new Date().toISOString();
    const createdAt = String(record.createdAt || now);
    const updatedAt = String(record.updatedAt || now);
    db.prepare(`
      INSERT INTO sociabuzz_payments(
        payment_id, source_key, status, recipient_user_id, job_id, rupiah, geon,
        rate_version, record_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(payment_id) DO UPDATE SET
        source_key = excluded.source_key,
        status = excluded.status,
        recipient_user_id = excluded.recipient_user_id,
        job_id = excluded.job_id,
        rupiah = excluded.rupiah,
        geon = excluded.geon,
        rate_version = excluded.rate_version,
        record_json = excluded.record_json,
        updated_at = excluded.updated_at
    `).run(
      paymentId,
      sourceKey,
      String(record.status || 'needs_target'),
      String(record.target?.userId || record.recipientUserId || ''),
      String(record.jobId || ''),
      Math.max(0, Math.floor(Number(record.rupiah) || 0)),
      Math.max(0, Math.floor(Number(record.geon) || 0)),
      Math.max(0, Math.floor(Number(record.rate?.version || record.rateVersion) || 0)),
      JSON.stringify(record),
      createdAt,
      updatedAt
    );
    return getSociabuzzPayment(paymentId);
  }

  function sociabuzzPaymentFromRow(row) {
    if (!row) return null;
    try {
      return JSON.parse(String(row.record_json || '{}'));
    } catch (error) {
      throw new Error(`Invalid SociaBuzz payment JSON ${row.payment_id}: ${error.message}`);
    }
  }

  function getSociabuzzPayment(paymentIdRaw) {
    ensureOpen();
    const row = db.prepare('SELECT * FROM sociabuzz_payments WHERE payment_id = ?').get(String(paymentIdRaw || '').trim());
    return sociabuzzPaymentFromRow(row);
  }

  function listSociabuzzPayments({ limit = 1000 } = {}) {
    ensureOpen();
    const safeLimit = Math.max(1, Math.min(5000, Math.floor(Number(limit) || 1000)));
    return db.prepare(`SELECT * FROM sociabuzz_payments ORDER BY updated_at DESC LIMIT ${safeLimit}`)
      .all().map(sociabuzzPaymentFromRow).filter(Boolean);
  }

  function insertInterviewAudit(session, action, actor = {}, detail = '') {
    const who = lawActor(actor);
    db.prepare(`
      INSERT INTO interview_audit_logs(
        session_number, interview_id, action, actor_id, actor_name, detail, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      session?.sessionNumber || session?.session_number || null,
      String(session?.interviewId || session?.interview_id || ''),
      String(action || 'UNKNOWN'),
      who.id,
      who.name,
      cleanLawText(detail, 1000),
      new Date().toISOString()
    );
  }

  function currentInterviewSequence() {
    const metadata = Math.max(0, Math.floor(Number(metadataValue('registration_interview_sequence')) || 0));
    const sessions = Number(db.prepare('SELECT COALESCE(MAX(session_number), 0) AS value FROM interview_sessions').get()?.value || 0);
    return Math.max(metadata, sessions);
  }

  function setInterviewSequenceAtLeast(rawMinimum) {
    const minimum = Math.max(0, Math.floor(Number(rawMinimum) || 0));
    const current = currentInterviewSequence();
    const next = Math.max(current, minimum);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO app_metadata(key, value, updated_at) VALUES ('registration_interview_sequence', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(String(next), now);
    return next;
  }

  function allocateInterviewCode({ minimum = 0 } = {}) {
    ensureOpen();
    db.exec('BEGIN IMMEDIATE;');
    try {
      const current = Math.max(currentInterviewSequence(), Math.max(0, Math.floor(Number(minimum) || 0)));
      const number = current + 1;
      setInterviewSequenceAtLeast(number);
      db.exec('COMMIT;');
      return { sessionNumber: number, interviewId: `interview-${String(number).padStart(4, '0')}` };
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  }

  function getInterviewSession(identifier, { by = 'auto', activeOnly = false } = {}) {
    ensureOpen();
    const raw = String(identifier || '').trim();
    if (!raw) return null;
    const active = activeOnly ? " AND lifecycle_status IN ('RESERVED', 'OPEN')" : '';
    let row;
    if (by === 'channel') {
      row = db.prepare(`SELECT * FROM interview_sessions WHERE channel_id = ?${active} ORDER BY session_number DESC LIMIT 1`).get(raw);
    } else if (by === 'user') {
      row = db.prepare(`SELECT * FROM interview_sessions WHERE user_id = ?${active} ORDER BY session_number DESC LIMIT 1`).get(raw);
    } else if (by === 'number' || /^\d+$/.test(raw)) {
      row = db.prepare(`SELECT * FROM interview_sessions WHERE session_number = ?${active}`).get(Number(raw));
    } else {
      row = db.prepare(`SELECT * FROM interview_sessions WHERE lower(interview_id) = lower(?)${active} ORDER BY session_number DESC LIMIT 1`).get(raw);
      if (!row && by === 'auto') {
        row = db.prepare(`SELECT * FROM interview_sessions WHERE channel_id = ? OR user_id = ? ORDER BY session_number DESC LIMIT 1`).get(raw, raw);
      }
    }
    return interviewRow(row);
  }

  function listInterviewSessions({ lifecycle = '', decision = '', userId = '', limit = 1000 } = {}) {
    ensureOpen();
    const conditions = [];
    const params = [];
    if (lifecycle) {
      conditions.push('lifecycle_status = ?');
      params.push(String(lifecycle).toUpperCase());
    }
    if (decision) {
      conditions.push('decision = ?');
      params.push(String(decision).toUpperCase());
    }
    if (userId) {
      conditions.push('user_id = ?');
      params.push(String(userId));
    }
    const safeLimit = Math.max(1, Math.min(10000, Math.floor(Number(limit) || 1000)));
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return db.prepare(`SELECT * FROM interview_sessions ${where} ORDER BY session_number DESC LIMIT ${safeLimit}`)
      .all(...params).map(interviewRow);
  }

  function reserveInterviewSession({ userId, username = '', gamertag, minimumSequence = 0, actor = {} }) {
    ensureOpen();
    const safeUserId = String(userId || '').trim();
    const safeGamertag = cleanLawText(gamertag, 64).replace(/\s+/g, ' ').trim();
    const gamertagKey = normalizeGamertagKey(safeGamertag);
    if (!safeUserId || !gamertagKey) throw new Error('User/gamertag reservation interview tidak valid');
    db.exec('BEGIN IMMEDIATE;');
    try {
      const activeUser = db.prepare(`
        SELECT * FROM interview_sessions WHERE user_id = ?
          AND lifecycle_status IN ('RESERVED', 'OPEN') ORDER BY session_number DESC LIMIT 1
      `).get(safeUserId);
      if (activeUser) {
        db.exec('COMMIT;');
        return { ok: false, code: 'active-user-session', session: interviewRow(activeUser) };
      }
      const activeGamertag = db.prepare(`
        SELECT * FROM interview_sessions WHERE gamertag_key = ?
          AND lifecycle_status IN ('RESERVED', 'OPEN') ORDER BY session_number DESC LIMIT 1
      `).get(gamertagKey);
      if (activeGamertag) {
        db.exec('COMMIT;');
        return { ok: false, code: 'active-gamertag-session', session: interviewRow(activeGamertag) };
      }
      const current = Math.max(currentInterviewSequence(), Math.max(0, Math.floor(Number(minimumSequence) || 0)));
      const sessionNumber = current + 1;
      const interviewId = `interview-${String(sessionNumber).padStart(4, '0')}`;
      const attempt = Number(db.prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS value FROM interview_sessions WHERE user_id = ?')
        .get(safeUserId)?.value || 1);
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO interview_sessions(
          session_number, interview_id, user_id, username, gamertag, gamertag_key,
          lifecycle_status, decision, attempt, source, reserved_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'RESERVED', 'PENDING', ?, 'discord', ?, ?)
      `).run(sessionNumber, interviewId, safeUserId, cleanLawText(username, 100), safeGamertag, gamertagKey, attempt, now, now);
      setInterviewSequenceAtLeast(sessionNumber);
      const session = interviewRow(db.prepare('SELECT * FROM interview_sessions WHERE session_number = ?').get(sessionNumber));
      insertInterviewAudit(session, 'RESERVE', actor, `${safeUserId}:${safeGamertag}`);
      db.exec('COMMIT;');
      return { ok: true, session };
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  }

  function attachInterviewChannel(sessionNumber, channelId, actor = {}) {
    ensureOpen();
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(`
        UPDATE interview_sessions SET channel_id = ?, lifecycle_status = 'OPEN', opened_at = COALESCE(opened_at, ?), updated_at = ?
        WHERE session_number = ? AND lifecycle_status = 'RESERVED'
      `).run(String(channelId || ''), now, now, Number(sessionNumber));
      const session = getInterviewSession(String(sessionNumber), { by: 'number' });
      if (!session || session.channelId !== String(channelId || '')) throw new Error('Session reservation tidak dapat dihubungkan ke channel');
      insertInterviewAudit(session, 'OPEN', actor, String(channelId || ''));
      db.exec('COMMIT;');
      return session;
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  }

  function failInterviewSession(sessionNumber, reason = '', actor = {}) {
    ensureOpen();
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE interview_sessions SET lifecycle_status = 'PROVISION_FAILED', decision_reason = ?, updated_at = ?
      WHERE session_number = ? AND lifecycle_status = 'RESERVED'
    `).run(cleanLawText(reason, 500), now, Number(sessionNumber));
    const session = getInterviewSession(String(sessionNumber), { by: 'number' });
    if (session) insertInterviewAudit(session, 'PROVISION_FAILED', actor, reason);
    return session;
  }

  function decideInterviewSession(identifier, decision, { reason = '', actor = {}, force = false } = {}) {
    ensureOpen();
    const session = typeof identifier === 'object' ? identifier : getInterviewSession(String(identifier), { by: 'auto' });
    const normalizedDecision = String(decision || '').toUpperCase();
    if (!session || !['APPROVED', 'REJECTED'].includes(normalizedDecision)) return null;
    if (!force && !['RESERVED', 'OPEN'].includes(session.lifecycleStatus)) return null;
    const who = lawActor(actor);
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE interview_sessions SET decision = ?, resolved_at = ?, resolved_by = ?, resolved_by_name = ?,
        decision_reason = ?, updated_at = ? WHERE session_number = ?
    `).run(normalizedDecision, now, who.id, who.name, cleanLawText(reason, 500), now, session.sessionNumber);
    const updated = getInterviewSession(String(session.sessionNumber), { by: 'number' });
    insertInterviewAudit(updated, force ? `FORCE_${normalizedDecision}` : normalizedDecision, who, reason);
    return updated;
  }

  function relinkInterviewSession(identifier, payload = {}, actor = {}) {
    ensureOpen();
    const session = typeof identifier === 'object' ? identifier : getInterviewSession(String(identifier), { by: 'auto' });
    if (!session) return null;
    const channelId = payload.channelId === undefined ? session.channelId : String(payload.channelId || '');
    const gamertag = cleanLawText(payload.gamertag || session.gamertag, 64).replace(/\s+/g, ' ').trim();
    const userId = String(payload.userId || session.userId).trim();
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE interview_sessions SET user_id = ?, username = ?, gamertag = ?, gamertag_key = ?,
        channel_id = ?, lifecycle_status = ?, legacy_interview_id = CASE WHEN ? <> '' THEN ? ELSE legacy_interview_id END,
        updated_at = ? WHERE session_number = ?
    `).run(
      userId,
      cleanLawText(payload.username || session.username, 100),
      gamertag,
      normalizeGamertagKey(gamertag),
      channelId,
      String(payload.lifecycleStatus || session.lifecycleStatus).toUpperCase(),
      cleanLawText(payload.legacyInterviewId, 64),
      cleanLawText(payload.legacyInterviewId, 64),
      now,
      session.sessionNumber
    );
    const updated = getInterviewSession(String(session.sessionNumber), { by: 'number' });
    insertInterviewAudit(updated, 'RELINK', actor, `${session.channelId}->${channelId}`);
    return updated;
  }

  function closeInterviewSession(identifier, { actor = {}, force = false, reason = '' } = {}) {
    ensureOpen();
    const session = typeof identifier === 'object' ? identifier : getInterviewSession(String(identifier), { by: 'auto' });
    if (!session) return null;
    if (!force && !['RESERVED', 'OPEN'].includes(session.lifecycleStatus)) return null;
    const who = lawActor(actor);
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE interview_sessions SET lifecycle_status = 'CLOSED', closed_at = ?, closed_by = ?,
        closed_by_name = ?, decision_reason = CASE WHEN ? <> '' THEN ? ELSE decision_reason END, updated_at = ?
      WHERE session_number = ?
    `).run(now, who.id, who.name, cleanLawText(reason, 500), cleanLawText(reason, 500), now, session.sessionNumber);
    const updated = getInterviewSession(String(session.sessionNumber), { by: 'number' });
    insertInterviewAudit(updated, force ? 'FORCE_CLOSE' : 'CLOSE', who, reason);
    return updated;
  }

  function upsertInterviewSessionFromRepair(payload = {}, actor = {}) {
    ensureOpen();
    const sessionNumber = Math.max(1, Math.floor(Number(payload.sessionNumber) || 0));
    const interviewId = cleanLawText(payload.interviewId, 64).toLowerCase();
    const userId = String(payload.userId || '').trim();
    const gamertag = cleanLawText(payload.gamertag || 'unknown', 64).replace(/\s+/g, ' ').trim();
    const lifecycle = ['OPEN', 'CLOSED', 'ORPHANED', 'CONFLICT'].includes(String(payload.lifecycleStatus).toUpperCase())
      ? String(payload.lifecycleStatus).toUpperCase()
      : 'ORPHANED';
    const decision = ['APPROVED', 'REJECTED'].includes(String(payload.decision).toUpperCase())
      ? String(payload.decision).toUpperCase()
      : 'PENDING';
    if (!sessionNumber || !interviewId || !userId) throw new Error('Payload repair session tidak lengkap');
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE;');
    try {
      const existingChannel = payload.channelId ? getInterviewSession(String(payload.channelId), { by: 'channel' }) : null;
      if (existingChannel && existingChannel.sessionNumber !== sessionNumber) {
        db.prepare('DELETE FROM interview_sessions WHERE session_number = ?').run(existingChannel.sessionNumber);
      }
      const targetNumber = sessionNumber;
      db.prepare(`
      INSERT INTO interview_sessions(
        session_number, interview_id, user_id, username, gamertag, gamertag_key, channel_id,
        lifecycle_status, decision, attempt, source, legacy_interview_id, reserved_at, opened_at,
        closed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'repair', ?, ?, ?, ?, ?)
      ON CONFLICT(session_number) DO UPDATE SET
        interview_id = excluded.interview_id, user_id = excluded.user_id, username = excluded.username,
        gamertag = excluded.gamertag, gamertag_key = excluded.gamertag_key, channel_id = excluded.channel_id,
        lifecycle_status = excluded.lifecycle_status, decision = excluded.decision,
        legacy_interview_id = excluded.legacy_interview_id, opened_at = excluded.opened_at,
        closed_at = excluded.closed_at, updated_at = excluded.updated_at
      `).run(
        targetNumber, interviewId, userId, cleanLawText(payload.username, 100), gamertag,
        normalizeGamertagKey(gamertag), String(payload.channelId || ''), lifecycle, decision,
        cleanLawText(payload.legacyInterviewId, 64), String(payload.reservedAt || now),
        lifecycle === 'OPEN' ? String(payload.openedAt || now) : null,
        lifecycle === 'CLOSED' ? String(payload.closedAt || now) : null,
        now
      );
      setInterviewSequenceAtLeast(sessionNumber);
      const updated = getInterviewSession(String(targetNumber), { by: 'number' });
      insertInterviewAudit(updated, 'REPAIR_UPSERT', actor, payload.legacyInterviewId || interviewId);
      db.exec('COMMIT;');
      return updated;
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  }

  function getInterviewAuditLogs({ sessionNumber = 0, limit = 100 } = {}) {
    ensureOpen();
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 100)));
    const rows = sessionNumber
      ? db.prepare(`SELECT * FROM interview_audit_logs WHERE session_number = ? ORDER BY id DESC LIMIT ${safeLimit}`).all(Number(sessionNumber))
      : db.prepare(`SELECT * FROM interview_audit_logs ORDER BY id DESC LIMIT ${safeLimit}`).all();
    return rows.map(row => ({
      id: Number(row.id), sessionNumber: row.session_number == null ? null : Number(row.session_number),
      interviewId: String(row.interview_id || ''), action: String(row.action), actorId: String(row.actor_id || ''),
      actorName: String(row.actor_name || ''), detail: String(row.detail || ''), createdAt: String(row.created_at),
    }));
  }

  function saveRulesCache(payload = {}, { source = 'minecraft' } = {}) {
    const connection = ensureOpen();
    const fetchedAt = String(payload.fetchedAt || new Date().toISOString());
    const now = new Date().toISOString();
    const safePayload = {
      ...payload,
      fetchedAt,
      bannedItems: Array.isArray(payload.bannedItems) ? payload.bannedItems.map(String) : [],
      dangerousItems: Array.isArray(payload.dangerousItems) ? payload.dangerousItems.map(String) : [],
      bannedEntities: Array.isArray(payload.bannedEntities) ? payload.bannedEntities.map(String) : [],
      entityAllowlist: Array.isArray(payload.entityAllowlist) ? payload.entityAllowlist.map(String) : [],
    };
    connection.prepare(`
      INSERT INTO rules_cache(cache_key, payload_json, fetched_at, source, updated_at)
      VALUES ('active_rules', ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        fetched_at = excluded.fetched_at,
        source = excluded.source,
        updated_at = excluded.updated_at
    `).run(JSON.stringify(safePayload), fetchedAt, String(source), now);
    writeJsonAtomic(resolvedRulesCacheJsonFile, { source, fetchedAt, rules: safePayload });
    return { ok: true, fetchedAt, payload: safePayload };
  }

  function getRulesCache() {
    const connection = ensureOpen();
    const row = connection.prepare(`
      SELECT payload_json, fetched_at, source
      FROM rules_cache WHERE cache_key = 'active_rules'
    `).get();
    if (!row && fs.existsSync(resolvedRulesCacheJsonFile)) {
      try {
        const backupPayload = JSON.parse(fs.readFileSync(resolvedRulesCacheJsonFile, 'utf8'));
        if (backupPayload?.rules && typeof backupPayload.rules === 'object') {
          saveRulesCache(backupPayload.rules, { source: backupPayload.source || 'json-backup' });
          return getRulesCache();
        }
      } catch (error) {
        throw new Error(`Invalid rules JSON backup ${resolvedRulesCacheJsonFile}: ${error.message}`);
      }
    }
    if (!row) return null;
    try {
      return {
        payload: JSON.parse(String(row.payload_json)),
        fetchedAt: String(row.fetched_at),
        source: String(row.source),
      };
    } catch (error) {
      throw new Error(`Invalid rules cache JSON in SQLite: ${error.message}`);
    }
  }

  function exportRulesCacheJsonBackup() {
    const cached = getRulesCache();
    if (!cached) return { ok: false, skipped: true, reason: 'rules-cache-empty' };
    writeJsonAtomic(resolvedRulesCacheJsonFile, {
      source: cached.source,
      fetchedAt: cached.fetchedAt,
      rules: cached.payload,
    });
    return { ok: true, file: resolvedRulesCacheJsonFile, fetchedAt: cached.fetchedAt };
  }

  function lawVersionDocument(lawId, versionNumber) {
    const law = ensureOpen().prepare('SELECT * FROM laws WHERE id = ?').get(Number(lawId));
    if (!law) return null;
    const requestedVersion = Math.max(1, Math.floor(Number(versionNumber) || Number(law.current_version) || 1));
    const version = db.prepare(`
      SELECT * FROM law_versions WHERE law_id = ? AND version_number = ?
    `).get(Number(law.id), requestedVersion);
    if (!version) return null;
    const articleRows = db.prepare(`
      SELECT * FROM law_articles WHERE version_id = ? ORDER BY position ASC, article_number ASC
    `).all(Number(version.id));
    const paragraphStatement = db.prepare(`
      SELECT * FROM law_paragraphs WHERE article_id = ? ORDER BY position ASC, paragraph_number ASC
    `);
    const articles = articleRows.map(article => ({
      id: Number(article.id),
      number: Number(article.article_number),
      heading: String(article.heading || ''),
      paragraphs: paragraphStatement.all(Number(article.id)).map(paragraph => ({
        id: Number(paragraph.id),
        number: Number(paragraph.paragraph_number),
        content: String(paragraph.content),
        status: String(paragraph.paragraph_status || 'ACTIVE'),
        repealNote: String(paragraph.repeal_note || ''),
      })),
    }));
    const versions = db.prepare(`
      SELECT version_number, change_note, created_by, created_by_name, created_at,
             revision_status, base_version, updated_at, published_at
      FROM law_versions WHERE law_id = ? AND revision_status = 'PUBLISHED'
      ORDER BY version_number DESC
    `).all(Number(law.id)).map(row => ({
      version: Number(row.version_number),
      changeNote: String(row.change_note || ''),
      createdBy: String(row.created_by),
      createdByName: String(row.created_by_name),
      createdAt: String(row.created_at),
      status: String(row.revision_status || 'PUBLISHED'),
      baseVersion: Number(row.base_version || 0),
      updatedAt: String(row.updated_at || row.created_at),
      publishedAt: row.published_at ? String(row.published_at) : null,
    }));
    return {
      id: Number(law.id),
      code: String(law.law_code || ''),
      number: law.law_number == null ? null : Number(law.law_number),
      year: law.law_year == null ? null : Number(law.law_year),
      title: String(version.title || law.title),
      status: String(law.status),
      version: Number(version.version_number),
      currentVersion: Number(law.current_version),
      revisionStatus: String(version.revision_status || 'PUBLISHED'),
      baseVersion: Number(version.base_version || 0),
      versionCreatedAt: String(version.created_at),
      versionUpdatedAt: String(version.updated_at || version.created_at),
      versionPublishedAt: version.published_at ? String(version.published_at) : null,
      changeNote: String(version.change_note || ''),
      createdBy: String(law.created_by),
      createdByName: String(law.created_by_name),
      createdAt: String(law.created_at),
      publishedBy: String(law.published_by || ''),
      publishedByName: String(law.published_by_name || ''),
      publishedAt: law.published_at ? String(law.published_at) : null,
      effectiveAt: law.effective_at ? String(law.effective_at) : null,
      revokedBy: String(law.revoked_by || ''),
      revokedByName: String(law.revoked_by_name || ''),
      revokedAt: law.revoked_at ? String(law.revoked_at) : null,
      revokeReason: String(law.revoke_reason || ''),
      updatedAt: String(law.updated_at),
      articles,
      versions,
    };
  }

  function listLaws({ query = '', includeDraft = false, creatorId = '', limit = 100 } = {}) {
    ensureOpen();
    const conditions = [];
    const params = [];
    if (!includeDraft) conditions.push("status IN ('ACTIVE', 'AMENDED', 'REVOKED')");
    if (creatorId) {
      conditions.push('created_by = ?');
      params.push(String(creatorId));
    }
    const cleanQuery = cleanLawText(query, 120).toLowerCase();
    if (cleanQuery) {
      conditions.push(`(
        lower(title) LIKE ? OR lower(COALESCE(law_code, '')) LIKE ? OR
        CAST(COALESCE(law_number, '') AS TEXT) = ? OR CAST(id AS TEXT) = ? OR
        EXISTS (
          SELECT 1 FROM law_versions lv
          JOIN law_articles la ON la.version_id = lv.id
          JOIN law_paragraphs lp ON lp.article_id = la.id
          WHERE lv.law_id = laws.id
            ${includeDraft ? '' : "AND lv.revision_status = 'PUBLISHED'"}
            AND lower(lp.content) LIKE ?
        )
      )`);
      params.push(`%${cleanQuery}%`, `%${cleanQuery}%`, cleanQuery, cleanQuery, `%${cleanQuery}%`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
    return db.prepare(`
      SELECT id, law_code, law_number, law_year, title, status, current_version,
             created_by, created_by_name, created_at, published_at, revoked_at, updated_at
      FROM laws ${where}
      ORDER BY COALESCE(law_year, 9999) DESC, COALESCE(law_number, id) DESC, id DESC
      LIMIT ${safeLimit}
    `).all(...params).map(row => ({
      id: Number(row.id),
      code: String(row.law_code || ''),
      number: row.law_number == null ? null : Number(row.law_number),
      year: row.law_year == null ? null : Number(row.law_year),
      title: String(row.title),
      status: String(row.status),
      version: Number(row.current_version),
      createdBy: String(row.created_by),
      createdByName: String(row.created_by_name),
      createdAt: String(row.created_at),
      publishedAt: row.published_at ? String(row.published_at) : null,
      revokedAt: row.revoked_at ? String(row.revoked_at) : null,
      updatedAt: String(row.updated_at),
    }));
  }

  function getLaw(identifier, { includeDraft = false, version = undefined, byId = false } = {}) {
    ensureOpen();
    const raw = cleanLawText(identifier, 120);
    if (!raw) return null;
    let row;
    if (byId) {
      row = db.prepare('SELECT id, status, current_version FROM laws WHERE id = ?').get(Number(raw));
    } else if (/^\d+$/.test(raw)) {
      row = db.prepare(`
        SELECT id, status, current_version FROM laws
        WHERE law_number = ? ${includeDraft ? '' : "AND status IN ('ACTIVE', 'AMENDED', 'REVOKED')"}
        ORDER BY law_year DESC LIMIT 1
      `).get(Number(raw));
    } else {
      row = db.prepare(`
        SELECT id, status, current_version FROM laws
        WHERE (lower(law_code) = lower(?) OR lower(title) LIKE lower(?))
          ${includeDraft ? '' : "AND status IN ('ACTIVE', 'AMENDED', 'REVOKED')"}
        ORDER BY law_year DESC, law_number DESC LIMIT 1
      `).get(raw, `%${raw}%`);
    }
    if (!row) return null;
    if (!includeDraft && (row.status === 'DRAFT' || row.status === 'ARCHIVED')) return null;
    const document = lawVersionDocument(row.id, version || row.current_version);
    if (!includeDraft && document?.revisionStatus !== 'PUBLISHED') return null;
    return document;
  }

  function insertLawAudit(lawId, action, actor, detail = '') {
    const who = lawActor(actor);
    db.prepare(`
      INSERT INTO law_audit_logs(law_id, action, actor_id, actor_name, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(Number(lawId) || null, String(action), who.id, who.name, cleanLawText(detail, 1000), new Date().toISOString());
  }

  function draftVersionRow(lawId) {
    return ensureOpen().prepare(`
      SELECT * FROM law_versions
      WHERE law_id = ? AND revision_status = 'DRAFT'
      ORDER BY version_number DESC LIMIT 1
    `).get(Number(lawId));
  }

  function ensureEditableLawVersion(lawId) {
    const law = ensureOpen().prepare('SELECT * FROM laws WHERE id = ?').get(Number(lawId));
    if (!law || law.status === 'ARCHIVED' || law.status === 'REVOKED') {
      throw new Error('Draft UU tidak ditemukan, diarsipkan, atau UU sudah dicabut');
    }
    const version = draftVersionRow(law.id);
    if (!version) throw new Error('Draft yang dapat diedit tidak ditemukan');
    return { law, version };
  }

  function getLawRevisionDraft(identifier, { byId = false } = {}) {
    const published = getLaw(identifier, { byId });
    if (!published || published.status === 'REVOKED') return null;
    const version = draftVersionRow(published.id);
    if (!version || Number(version.version_number) <= Number(published.currentVersion)) return null;
    return lawVersionDocument(published.id, version.version_number);
  }

  function listLawRevisionDrafts({ creatorId = '', limit = 100 } = {}) {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
    const params = [];
    const creator = creatorId ? 'AND lv.created_by = ?' : '';
    if (creatorId) params.push(String(creatorId));
    return ensureOpen().prepare(`
      SELECT lv.law_id, lv.version_number
      FROM law_versions lv
      JOIN laws l ON l.id = lv.law_id
      WHERE lv.revision_status = 'DRAFT' AND l.status IN ('ACTIVE', 'AMENDED') ${creator}
      ORDER BY lv.updated_at DESC, lv.id DESC LIMIT ${safeLimit}
    `).all(...params).map(row => lawVersionDocument(row.law_id, row.version_number)).filter(Boolean);
  }

  function createLawRevisionDraft(identifier, note, actor = {}) {
    const current = getLaw(identifier);
    if (!current || current.status === 'REVOKED') throw new Error('UU aktif tidak ditemukan atau sudah dicabut');
    const existing = draftVersionRow(current.id);
    if (existing) {
      if (Number(existing.version_number) > Number(current.currentVersion)) {
        return lawVersionDocument(current.id, existing.version_number);
      }
      throw new Error('UU ini memiliki draft yang tidak valid; periksa database sebelum melanjutkan');
    }
    const body = cleanLawText(note, 1800);
    if (!body) throw new Error('Alasan/catatan revisi tidak boleh kosong');
    const who = lawActor(actor);
    if (!who.id) throw new Error('Identitas pembuat revisi tidak valid');
    const nextVersion = current.currentVersion + 1;
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE;');
    try {
      const versionId = Number(db.prepare(`
        INSERT INTO law_versions(
          law_id, version_number, title, change_note, created_by, created_by_name, created_at,
          revision_status, base_version, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)
      `).run(current.id, nextVersion, current.title, body, who.id, who.name, now, current.currentVersion, now).lastInsertRowid);
      for (const article of current.articles) {
        const articleId = Number(db.prepare(`
          INSERT INTO law_articles(version_id, article_number, heading, position) VALUES (?, ?, ?, ?)
        `).run(versionId, article.number, article.heading, article.number).lastInsertRowid);
        for (const paragraph of article.paragraphs) {
          db.prepare(`
            INSERT INTO law_paragraphs(
              article_id, paragraph_number, content, position, paragraph_status, repeal_note
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            articleId,
            paragraph.number,
            paragraph.content,
            paragraph.number,
            paragraph.status || 'ACTIVE',
            paragraph.repealNote || ''
          );
        }
      }
      insertLawAudit(current.id, 'START_REVISION_DRAFT', who, `Versi ${nextVersion} dari versi ${current.currentVersion}: ${body}`);
      db.prepare('UPDATE laws SET updated_at = ? WHERE id = ?').run(now, current.id);
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      const racedDraft = draftVersionRow(current.id);
      if (racedDraft && Number(racedDraft.version_number) > Number(current.currentVersion)) {
        return lawVersionDocument(current.id, racedDraft.version_number);
      }
      throw error;
    }
    exportLawsJsonBackup();
    return lawVersionDocument(current.id, nextVersion);
  }

  function createLawDraft({ note, title = '', actor = {} }) {
    const connection = ensureOpen();
    const body = cleanLawText(note, 1800);
    if (!body) throw new Error('Catatan UU tidak boleh kosong');
    const who = lawActor(actor);
    if (!who.id) throw new Error('Identitas pembuat UU tidak valid');
    const safeTitle = cleanLawText(title, 160) || `Rancangan ${body.replace(/\n/g, ' ').slice(0, 70)}`;
    const now = new Date().toISOString();
    connection.exec('BEGIN IMMEDIATE;');
    let lawId;
    try {
      lawId = Number(connection.prepare(`
        INSERT INTO laws(title, status, current_version, created_by, created_by_name, created_at, updated_at)
        VALUES (?, 'DRAFT', 1, ?, ?, ?, ?)
      `).run(safeTitle, who.id, who.name, now, now).lastInsertRowid);
      const versionId = Number(connection.prepare(`
        INSERT INTO law_versions(
          law_id, version_number, title, change_note, created_by, created_by_name, created_at,
          revision_status, base_version, updated_at
        ) VALUES (?, 1, ?, 'Draft awal', ?, ?, ?, 'DRAFT', 0, ?)
      `).run(lawId, safeTitle, who.id, who.name, now, now).lastInsertRowid);
      const articleId = Number(connection.prepare(`
        INSERT INTO law_articles(version_id, article_number, heading, position)
        VALUES (?, 1, 'Ketentuan', 1)
      `).run(versionId).lastInsertRowid);
      connection.prepare(`
        INSERT INTO law_paragraphs(article_id, paragraph_number, content, position)
        VALUES (?, 1, ?, 1)
      `).run(articleId, body);
      insertLawAudit(lawId, 'CREATE_DRAFT', who, safeTitle);
      connection.exec('COMMIT;');
    } catch (error) {
      connection.exec('ROLLBACK;');
      throw error;
    }
    exportLawsJsonBackup();
    return lawVersionDocument(lawId, 1);
  }

  function ensureDraftLaw(lawId) {
    const row = ensureOpen().prepare(`SELECT * FROM laws WHERE id = ? AND status = 'DRAFT'`).get(Number(lawId));
    if (!row) throw new Error('Draft UU tidak ditemukan atau sudah diterbitkan');
    return row;
  }

  function updateLawDraftTitle(lawId, title, actor = {}) {
    const { law, version } = ensureEditableLawVersion(lawId);
    const safeTitle = cleanLawText(title, 160);
    if (!safeTitle) throw new Error('Judul UU tidak boleh kosong');
    const who = lawActor(actor);
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE;');
    try {
      if (law.status === 'DRAFT') db.prepare('UPDATE laws SET title = ?, updated_at = ? WHERE id = ?').run(safeTitle, now, law.id);
      else db.prepare('UPDATE laws SET updated_at = ? WHERE id = ?').run(now, law.id);
      db.prepare('UPDATE law_versions SET title = ?, updated_at = ? WHERE id = ?')
        .run(safeTitle, now, version.id);
      insertLawAudit(law.id, 'UPDATE_TITLE', who, safeTitle);
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
    exportLawsJsonBackup();
    return lawVersionDocument(law.id, version.version_number);
  }

  function addLawParagraph(lawId, content, actor = {}, articleNumber = undefined) {
    const { law, version } = ensureEditableLawVersion(lawId);
    const body = cleanLawText(content, 1800);
    if (!body) throw new Error('Isi Ayat tidak boleh kosong');
    const article = articleNumber
      ? db.prepare('SELECT * FROM law_articles WHERE version_id = ? AND article_number = ?').get(version.id, Number(articleNumber))
      : db.prepare('SELECT * FROM law_articles WHERE version_id = ? ORDER BY article_number DESC LIMIT 1').get(version.id);
    if (!article) throw new Error('Pasal tujuan tidak ditemukan');
    const next = Number(db.prepare('SELECT COALESCE(MAX(paragraph_number), 0) + 1 AS n FROM law_paragraphs WHERE article_id = ?')
      .get(article.id).n);
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare('INSERT INTO law_paragraphs(article_id, paragraph_number, content, position) VALUES (?, ?, ?, ?)')
        .run(article.id, next, body, next);
      const now = new Date().toISOString();
      db.prepare('UPDATE laws SET updated_at = ? WHERE id = ?').run(now, law.id);
      db.prepare('UPDATE law_versions SET updated_at = ? WHERE id = ?').run(now, version.id);
      insertLawAudit(law.id, 'ADD_PARAGRAPH', actor, `Pasal ${article.article_number} Ayat (${next})`);
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
    exportLawsJsonBackup();
    return lawVersionDocument(law.id, version.version_number);
  }

  function addLawArticle(lawId, { heading = '', content = '' } = {}, actor = {}) {
    const { law, version } = ensureEditableLawVersion(lawId);
    const body = cleanLawText(content, 1800);
    if (!body) throw new Error('Isi Pasal tidak boleh kosong');
    const next = Number(db.prepare('SELECT COALESCE(MAX(article_number), 0) + 1 AS n FROM law_articles WHERE version_id = ?')
      .get(version.id).n);
    db.exec('BEGIN IMMEDIATE;');
    try {
      const articleId = Number(db.prepare(`
        INSERT INTO law_articles(version_id, article_number, heading, position) VALUES (?, ?, ?, ?)
      `).run(version.id, next, cleanLawText(heading, 120), next).lastInsertRowid);
      db.prepare('INSERT INTO law_paragraphs(article_id, paragraph_number, content, position) VALUES (?, 1, ?, 1)')
        .run(articleId, body);
      const now = new Date().toISOString();
      db.prepare('UPDATE laws SET updated_at = ? WHERE id = ?').run(now, law.id);
      db.prepare('UPDATE law_versions SET updated_at = ? WHERE id = ?').run(now, version.id);
      insertLawAudit(law.id, 'ADD_ARTICLE', actor, `Pasal ${next}`);
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
    exportLawsJsonBackup();
    return lawVersionDocument(law.id, version.version_number);
  }

  function updateLawArticleHeading(lawId, articleNumber, heading = '', actor = {}) {
    const { law, version } = ensureEditableLawVersion(lawId);
    const article = db.prepare('SELECT * FROM law_articles WHERE version_id = ? AND article_number = ?')
      .get(version.id, Number(articleNumber));
    if (!article) throw new Error('Pasal tujuan tidak ditemukan');
    const safeHeading = cleanLawText(heading, 120);
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare('UPDATE law_articles SET heading = ? WHERE id = ?').run(safeHeading, article.id);
      db.prepare('UPDATE law_versions SET updated_at = ? WHERE id = ?').run(now, version.id);
      db.prepare('UPDATE laws SET updated_at = ? WHERE id = ?').run(now, law.id);
      insertLawAudit(law.id, 'UPDATE_ARTICLE_HEADING', actor, `Pasal ${article.article_number}: ${safeHeading || '(tanpa judul)'}`);
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
    exportLawsJsonBackup();
    return lawVersionDocument(law.id, version.version_number);
  }

  function updateLawParagraph(lawId, articleNumber, paragraphNumber, content, reason = '', actor = {}) {
    const { law, version } = ensureEditableLawVersion(lawId);
    const body = cleanLawText(content, 1800);
    const safeReason = cleanLawText(reason, 500);
    if (!body) throw new Error('Isi Ayat baru tidak boleh kosong');
    if (!safeReason) throw new Error('Alasan perubahan Ayat wajib diisi');
    const paragraph = db.prepare(`
      SELECT lp.*, la.article_number FROM law_paragraphs lp
      JOIN law_articles la ON la.id = lp.article_id
      WHERE la.version_id = ? AND la.article_number = ? AND lp.paragraph_number = ?
    `).get(version.id, Number(articleNumber), Number(paragraphNumber));
    if (!paragraph) throw new Error('Ayat tujuan tidak ditemukan pada Pasal ini');
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare("UPDATE law_paragraphs SET content = ?, paragraph_status = 'ACTIVE', repeal_note = '' WHERE id = ?")
        .run(body, paragraph.id);
      db.prepare('UPDATE law_versions SET updated_at = ? WHERE id = ?').run(now, version.id);
      db.prepare('UPDATE laws SET updated_at = ? WHERE id = ?').run(now, law.id);
      insertLawAudit(law.id, 'UPDATE_PARAGRAPH', actor, `Pasal ${articleNumber} Ayat (${paragraphNumber}): ${safeReason}`);
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
    exportLawsJsonBackup();
    return lawVersionDocument(law.id, version.version_number);
  }

  function setLawParagraphRepealed(lawId, articleNumber, paragraphNumber, { repealed = true, reason = '' } = {}, actor = {}) {
    const { law, version } = ensureEditableLawVersion(lawId);
    const safeReason = cleanLawText(reason, 500);
    if (!safeReason) throw new Error(`Alasan ${repealed ? 'pencabutan' : 'pemulihan'} Ayat wajib diisi`);
    const paragraph = db.prepare(`
      SELECT lp.*, la.article_number FROM law_paragraphs lp
      JOIN law_articles la ON la.id = lp.article_id
      WHERE la.version_id = ? AND la.article_number = ? AND lp.paragraph_number = ?
    `).get(version.id, Number(articleNumber), Number(paragraphNumber));
    if (!paragraph) throw new Error('Ayat tujuan tidak ditemukan pada Pasal ini');
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare('UPDATE law_paragraphs SET paragraph_status = ?, repeal_note = ? WHERE id = ?')
        .run(repealed ? 'REPEALED' : 'ACTIVE', repealed ? safeReason : '', paragraph.id);
      db.prepare('UPDATE law_versions SET updated_at = ? WHERE id = ?').run(now, version.id);
      db.prepare('UPDATE laws SET updated_at = ? WHERE id = ?').run(now, law.id);
      insertLawAudit(
        law.id,
        repealed ? 'REPEAL_PARAGRAPH' : 'RESTORE_PARAGRAPH',
        actor,
        `Pasal ${articleNumber} Ayat (${paragraphNumber}): ${safeReason}`
      );
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
    exportLawsJsonBackup();
    return lawVersionDocument(law.id, version.version_number);
  }

  function publishLaw(lawId, actor = {}) {
    const law = ensureDraftLaw(lawId);
    const who = lawActor(actor);
    const year = jakartaYear();
    const nextNumber = Number(db.prepare('SELECT COALESCE(MAX(law_number), 0) + 1 AS n FROM laws WHERE law_year = ?')
      .get(year).n);
    const code = `UU-EG-${year}-${String(nextNumber).padStart(3, '0')}`;
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(`
        UPDATE laws SET law_code = ?, law_number = ?, law_year = ?, status = 'ACTIVE',
          published_by = ?, published_by_name = ?, published_at = ?, effective_at = ?, updated_at = ?
        WHERE id = ?
      `).run(code, nextNumber, year, who.id, who.name, now, now, now, law.id);
      db.prepare(`
        UPDATE law_versions SET revision_status = 'PUBLISHED', published_at = ?, updated_at = ?
        WHERE law_id = ? AND version_number = ?
      `).run(now, now, law.id, law.current_version);
      insertLawAudit(law.id, 'PUBLISH', who, code);
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
    exportLawsJsonBackup();
    return lawVersionDocument(law.id, law.current_version);
  }

  function archiveLawDraft(lawId, actor = {}) {
    const law = ensureDraftLaw(lawId);
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare("UPDATE laws SET status = 'ARCHIVED', updated_at = ? WHERE id = ?").run(now, law.id);
      db.prepare("UPDATE law_versions SET revision_status = 'ARCHIVED', updated_at = ? WHERE law_id = ? AND revision_status = 'DRAFT'")
        .run(now, law.id);
      insertLawAudit(law.id, 'ARCHIVE_DRAFT', actor, 'Draft dibatalkan');
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
    exportLawsJsonBackup();
    return lawVersionDocument(law.id, law.current_version);
  }

  function reviseLaw(identifier, note, actor = {}) {
    return createLawRevisionDraft(identifier, note, actor);
  }

  function lawRevisionDiff(lawId, draftVersion = undefined) {
    const draftRow = draftVersion
      ? db.prepare("SELECT * FROM law_versions WHERE law_id = ? AND version_number = ? AND revision_status = 'DRAFT'")
        .get(Number(lawId), Number(draftVersion))
      : draftVersionRow(lawId);
    if (!draftRow) throw new Error('Draft revisi tidak ditemukan');
    const draft = lawVersionDocument(lawId, draftRow.version_number);
    const baseNumber = Number(draftRow.base_version || 0);
    const base = baseNumber ? lawVersionDocument(lawId, baseNumber) : null;
    const changes = [];
    const baseArticles = new Map((base?.articles || []).map(article => [article.number, article]));
    const draftArticles = new Map(draft.articles.map(article => [article.number, article]));
    for (const article of draft.articles) {
      const beforeArticle = baseArticles.get(article.number);
      if (!beforeArticle) {
        changes.push({ type: 'ADD_ARTICLE', article: article.number, heading: article.heading, content: article.paragraphs });
        continue;
      }
      if (beforeArticle.heading !== article.heading) {
        changes.push({ type: 'UPDATE_ARTICLE_HEADING', article: article.number, before: beforeArticle.heading, after: article.heading });
      }
      const beforeParagraphs = new Map(beforeArticle.paragraphs.map(paragraph => [paragraph.number, paragraph]));
      for (const paragraph of article.paragraphs) {
        const before = beforeParagraphs.get(paragraph.number);
        if (!before) {
          changes.push({ type: 'ADD_PARAGRAPH', article: article.number, paragraph: paragraph.number, after: paragraph.content });
        } else if (
          before.content !== paragraph.content || before.status !== paragraph.status ||
          before.repealNote !== paragraph.repealNote
        ) {
          changes.push({
            type: paragraph.status === 'REPEALED' && before.status !== 'REPEALED' ? 'REPEAL_PARAGRAPH' : 'UPDATE_PARAGRAPH',
            article: article.number,
            paragraph: paragraph.number,
            before: before.content,
            after: paragraph.content,
            beforeStatus: before.status,
            afterStatus: paragraph.status,
            note: paragraph.repealNote,
          });
        }
      }
    }
    for (const article of base?.articles || []) {
      if (!draftArticles.has(article.number)) changes.push({ type: 'REMOVE_ARTICLE', article: article.number });
    }
    if (base && base.title !== draft.title) changes.unshift({ type: 'UPDATE_TITLE', before: base.title, after: draft.title });
    return { lawId: Number(lawId), baseVersion: baseNumber, draftVersion: Number(draftRow.version_number), changes };
  }

  function publishLawRevisionDraft(lawId, actor = {}) {
    const { law, version } = ensureEditableLawVersion(lawId);
    if (!['ACTIVE', 'AMENDED'].includes(String(law.status))) throw new Error('UU ini bukan UU aktif yang dapat direvisi');
    if (Number(version.version_number) <= Number(law.current_version)) throw new Error('Versi ini bukan draft revisi');
    const diff = lawRevisionDiff(law.id, version.version_number);
    if (!diff.changes.length) throw new Error('Draft revisi belum memiliki perubahan isi');
    const who = lawActor(actor);
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(`
        UPDATE law_versions SET revision_status = 'PUBLISHED', published_at = ?, updated_at = ?
        WHERE id = ?
      `).run(now, now, version.id);
      db.prepare(`
        UPDATE laws SET title = ?, status = 'AMENDED', current_version = ?, updated_at = ? WHERE id = ?
      `).run(version.title, version.version_number, now, law.id);
      insertLawAudit(
        law.id,
        'PUBLISH_REVISION',
        who,
        `Versi ${version.version_number} dari versi ${version.base_version}; ${diff.changes.length} perubahan`
      );
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
    exportLawsJsonBackup();
    return lawVersionDocument(law.id, version.version_number);
  }

  function discardLawRevisionDraft(lawId, actor = {}) {
    const { law, version } = ensureEditableLawVersion(lawId);
    if (!['ACTIVE', 'AMENDED'].includes(String(law.status)) || Number(version.version_number) <= Number(law.current_version)) {
      throw new Error('Draft ini bukan draft revisi UU aktif');
    }
    const detail = `Draft versi ${version.version_number} dari versi ${version.base_version}`;
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare('DELETE FROM law_versions WHERE id = ?').run(version.id);
      db.prepare('UPDATE laws SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), law.id);
      insertLawAudit(law.id, 'DISCARD_REVISION_DRAFT', actor, detail);
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
    exportLawsJsonBackup();
    return getLaw(String(law.id), { byId: true });
  }

  function revokeLaw(identifier, reason, actor = {}) {
    const current = getLaw(identifier);
    if (!current || current.status === 'REVOKED') throw new Error('UU aktif tidak ditemukan atau sudah dicabut');
    const safeReason = cleanLawText(reason, 1000);
    if (!safeReason) throw new Error('Alasan pencabutan tidak boleh kosong');
    const who = lawActor(actor);
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(`
        UPDATE laws SET status = 'REVOKED', revoked_by = ?, revoked_by_name = ?,
          revoked_at = ?, revoke_reason = ?, updated_at = ? WHERE id = ?
      `).run(who.id, who.name, now, safeReason, now, current.id);
      db.prepare(`
        UPDATE law_versions SET revision_status = 'ARCHIVED', updated_at = ?
        WHERE law_id = ? AND revision_status = 'DRAFT' AND base_version > 0
      `).run(now, current.id);
      insertLawAudit(current.id, 'REVOKE', who, safeReason);
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
    exportLawsJsonBackup();
    return lawVersionDocument(current.id, current.currentVersion);
  }

  function exportLawsJsonBackup() {
    const summaries = listLaws({ includeDraft: true, limit: 500 });
    const laws = summaries.map(summary => lawVersionDocument(summary.id, summary.version)).filter(Boolean);
    const revisionDrafts = ensureOpen().prepare(`
      SELECT law_id, version_number FROM law_versions
      WHERE revision_status = 'DRAFT' AND base_version > 0
      ORDER BY updated_at DESC
    `).all().map(row => lawVersionDocument(row.law_id, row.version_number)).filter(Boolean);
    const payload = { version: 2, updatedAt: new Date().toISOString(), laws, revisionDrafts };
    writeJsonAtomic(resolvedLawsJsonFile, payload);
    return { ok: true, file: resolvedLawsJsonFile, count: laws.length, revisionDraftCount: revisionDrafts.length };
  }

  function pruneBackups() {
    let files = [];
    try {
      files = fs.readdirSync(resolvedBackupDir)
        .filter(name => /^rizebot-\d{8}-\d{6}Z\.db$/.test(name))
        .sort()
        .reverse();
    } catch {
      return [];
    }
    const removed = [];
    for (const name of files.slice(safeBackupRetention)) {
      const target = path.resolve(resolvedBackupDir, name);
      if (path.dirname(target) !== resolvedBackupDir) continue;
      fs.rmSync(target, { force: true });
      removed.push(name);
    }
    return removed;
  }

  async function createBackup({ reason = 'manual' } = {}) {
    ensureOpen();
    if (backupPromise) return backupPromise;
    backupPromise = (async () => {
      fs.mkdirSync(resolvedBackupDir, { recursive: true });
      const target = path.join(resolvedBackupDir, `rizebot-${timestampForFile()}.db`);
      await backup(db, target);
      const check = new DatabaseSync(target, { readOnly: true });
      try {
        const row = check.prepare('PRAGMA quick_check').get();
        const message = String(row?.quick_check || Object.values(row || {})[0] || '');
        if (message.toLowerCase() !== 'ok') throw new Error(`Backup integrity check failed: ${message}`);
      } finally {
        check.close();
      }
      pruneBackups();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO storage_audit(store_name, operation, record_count, detail, created_at)
        VALUES ('database', 'backup', 0, ?, ?)
      `).run(`${reason}:${path.basename(target)}`, now);
      return { ok: true, file: target, size: fs.statSync(target).size };
    })().finally(() => {
      backupPromise = null;
    });
    return backupPromise;
  }

  function startBackupScheduler({ logger = console } = {}) {
    if (backupTimer) return false;
    backupTimer = setInterval(() => {
      void createBackup({ reason: 'scheduled' })
        .then(result => logger.log(`SQLite backup selesai: ${result.file}`))
        .catch(error => logger.error('SQLite backup gagal:', error));
    }, safeBackupIntervalMs);
    backupTimer.unref?.();
    return true;
  }

  function stopBackupScheduler() {
    if (backupTimer) clearInterval(backupTimer);
    backupTimer = null;
  }

  function getStatus() {
    ensureOpen();
    const integrity = integrityCheck();
    const count = Number(db.prepare('SELECT COUNT(*) AS count FROM registrations').get()?.count || 0);
    const laws = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status IN ('ACTIVE', 'AMENDED') THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'DRAFT' THEN 1 ELSE 0 END) AS drafts
      FROM laws
    `).get();
    const rules = db.prepare("SELECT fetched_at, source FROM rules_cache WHERE cache_key = 'active_rules'").get();
    const revisionDrafts = Number(db.prepare("SELECT COUNT(*) AS count FROM law_versions WHERE revision_status = 'DRAFT' AND base_version > 0").get()?.count || 0);
    const interviews = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN lifecycle_status IN ('RESERVED', 'OPEN') THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN lifecycle_status IN ('ORPHANED', 'CONFLICT', 'PROVISION_FAILED') THEN 1 ELSE 0 END) AS issues
      FROM interview_sessions
    `).get();
    const registrationConflicts = Number(db.prepare('SELECT COUNT(*) AS count FROM registration_conflicts WHERE resolved_at IS NULL').get()?.count || 0);
    return {
      ok: integrity.ok,
      databaseFile: resolvedDatabaseFile,
      registrationJsonFile: resolvedRegistrationJsonFile,
      rulesCacheJsonFile: resolvedRulesCacheJsonFile,
      lawsJsonFile: resolvedLawsJsonFile,
      backupDir: resolvedBackupDir,
      registrationInitialized: metadataValue('registration_initialized') === '1',
      registrationCount: count,
      lastRegistrationUpdate: metadataValue('registration_updated_at') || '',
      lawCount: Number(laws?.total || 0),
      activeLawCount: Number(laws?.active || 0),
      draftLawCount: Number(laws?.drafts || 0),
      revisionDraftLawCount: revisionDrafts,
      rulesCacheAt: String(rules?.fetched_at || ''),
      rulesCacheSource: String(rules?.source || ''),
      interviewSessionCount: Number(interviews?.total || 0),
      activeInterviewSessionCount: Number(interviews?.active || 0),
      interviewIssueCount: Number(interviews?.issues || 0),
      interviewSequence: currentInterviewSequence(),
      registrationConflictCount: registrationConflicts,
      databaseSize: fs.existsSync(resolvedDatabaseFile) ? fs.statSync(resolvedDatabaseFile).size : 0,
      backupIntervalMs: safeBackupIntervalMs,
      backupRetention: safeBackupRetention,
    };
  }

  function close() {
    stopBackupScheduler();
    if (!db) return;
    db.close();
    db = null;
  }

  return {
    init,
    close,
    integrityCheck,
    loadRegistrationSnapshot,
    loadRegistrationJsonBackup,
    exportRegistrationJsonBackup,
    saveRegistrationSnapshot,
    saveRegistrationConflicts,
    listRegistrationConflicts,
    getGeonRate,
    setGeonRate,
    listGeonRateHistory,
    saveTopupRecipientAlias,
    findTopupRecipientAlias,
    saveSociabuzzPayment,
    getSociabuzzPayment,
    listSociabuzzPayments,
    currentInterviewSequence,
    setInterviewSequenceAtLeast,
    allocateInterviewCode,
    reserveInterviewSession,
    attachInterviewChannel,
    failInterviewSession,
    getInterviewSession,
    listInterviewSessions,
    decideInterviewSession,
    relinkInterviewSession,
    closeInterviewSession,
    upsertInterviewSessionFromRepair,
    getInterviewAuditLogs,
    saveRulesCache,
    getRulesCache,
    exportRulesCacheJsonBackup,
    listLaws,
    getLaw,
    getLawRevisionDraft,
    listLawRevisionDrafts,
    createLawDraft,
    createLawRevisionDraft,
    updateLawDraftTitle,
    addLawParagraph,
    addLawArticle,
    updateLawArticleHeading,
    updateLawParagraph,
    setLawParagraphRepealed,
    publishLaw,
    publishLawRevisionDraft,
    archiveLawDraft,
    discardLawRevisionDraft,
    lawRevisionDiff,
    reviseLaw,
    revokeLaw,
    exportLawsJsonBackup,
    createBackup,
    startBackupScheduler,
    stopBackupScheduler,
    getStatus,
    paths: {
      dataDir: resolvedDataDir,
      databaseFile: resolvedDatabaseFile,
      registrationJsonFile: resolvedRegistrationJsonFile,
      rulesCacheJsonFile: resolvedRulesCacheJsonFile,
      lawsJsonFile: resolvedLawsJsonFile,
      backupDir: resolvedBackupDir,
    },
  };
}

module.exports = { createRizebotDatabase, writeJsonAtomic };
