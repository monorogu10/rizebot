const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');

const DEFAULT_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_BACKUP_RETENTION = 14;

function normalizeGamertagKey(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-');
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
  backupDir = process.env.RIZEBOT_BACKUP_DIR || '',
  backupIntervalMs = Number(process.env.RIZEBOT_DB_BACKUP_INTERVAL_MS) || DEFAULT_BACKUP_INTERVAL_MS,
  backupRetention = Number(process.env.RIZEBOT_DB_BACKUP_RETENTION) || DEFAULT_BACKUP_RETENTION,
} = {}) {
  const resolvedDataDir = path.resolve(dataDir);
  const resolvedDatabaseFile = path.resolve(databaseFile || path.join(resolvedDataDir, 'rizebot.db'));
  const resolvedRegistrationJsonFile = path.resolve(
    registrationJsonFile || path.join(resolvedDataDir, 'register-data.json')
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
    const interviewSequence = Math.max(0, Math.floor(Number(snapshot.interviewSequence) || 0));
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
    return {
      ok: integrity.ok,
      databaseFile: resolvedDatabaseFile,
      registrationJsonFile: resolvedRegistrationJsonFile,
      backupDir: resolvedBackupDir,
      registrationInitialized: metadataValue('registration_initialized') === '1',
      registrationCount: count,
      lastRegistrationUpdate: metadataValue('registration_updated_at') || '',
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
    createBackup,
    startBackupScheduler,
    stopBackupScheduler,
    getStatus,
    paths: {
      dataDir: resolvedDataDir,
      databaseFile: resolvedDatabaseFile,
      registrationJsonFile: resolvedRegistrationJsonFile,
      backupDir: resolvedBackupDir,
    },
  };
}

module.exports = { createRizebotDatabase, writeJsonAtomic };
