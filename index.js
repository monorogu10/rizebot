require('dotenv').config();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client, GatewayIntentBits: I, MessageFlags, Partials: T } = require('discord.js');

const { maybeBlockLink } = require('./src/features/linkBlocker');
const { maybeReplyKeyword } = require('./src/features/keywordReply');
const { createMessageHandler } = require('./src/handlers/messageHandler');
const {
  createApplicationCommandHandler,
  isLegacyPrefixCommand,
  registerApplicationCommands,
} = require('./src/commands/applicationCommands');
const { registerMemberEvents } = require('./src/handlers/memberEvents');
const { registerPrivateRoleEvents } = require('./src/handlers/privateRoleHandler');
const {
  INTERVIEW_REPLY_TIMEOUT_MS,
  archiveClosedInterviewBacklog,
  createRegisterHandler,
  createRegisterInteractionHandler,
  expireUnansweredInterviews,
} = require('./src/handlers/registerHandler');
const { createMinecraftBridgeHandler } = require('./src/handlers/minecraftBridgeHandler');
const { createCompanyPanelHandler } = require('./src/handlers/companyPanelHandler');
const { createSocialFinanceHandler } = require('./src/handlers/socialFinanceHandler');
const { createShopHandler } = require('./src/handlers/shopHandler');
const { createRulesHandler } = require('./src/handlers/rulesHandler');
const { createLawHandler } = require('./src/handlers/lawHandler');
const { createTopupHandler } = require('./src/handlers/topupHandler');
const { registerEthergeonCitizenRoleEvents } = require('./src/handlers/ethergeonCitizenRoleHandler');
const {
  createModerationHandler,
  createModerationReactionHandler,
  syncActivePetitions
} = require('./src/handlers/moderationHandler');
const { createSubmissionStore } = require('./src/services/submissionStore');
const { createRegisterStore } = require('./src/services/registerStore');
const { createModerationStore } = require('./src/services/moderationStore');
const { createInterviewTranscriptStore } = require('./src/services/interviewTranscriptStore');
const { createTopupBridgeService } = require('./src/services/topupBridgeService');
const { createTopupBridgeServer } = require('./src/services/topupBridgeServer');
const { createServerStatusNotifier } = require('./src/services/serverStatusNotifier');
const { createRizebotDatabase } = require('./src/services/rizebotDatabase');
const { createSociabuzzTopupService } = require('./src/services/sociabuzzTopupService');
const {
  REGISTER_ROLE_ID,
  LEGACY_ROLE_ID,
  MINECRAFT_REGISTER_ROLE_ID,
  MINECRAFT_REGISTER_PENDING_ROLE_ID,
  MINECRAFT_REGISTER_REJECTED_ROLE_ID,
  REGISTRATION_INBOX_CHANNEL_ID,
  SERVER_STATUS_CHANNEL_ID,
  TOPUP_BRIDGE_HOST,
  TOPUP_BRIDGE_PORT,
  TOPUP_BRIDGE_TOKEN,
  SOCIABUZZ_WEBHOOK_TOKEN,
} = require('./src/config');
const { isAllowedBotOutputChannel } = require('./src/utils/channelPolicy');
const {
  logCommandError,
  logCommandInfo,
  logCommandWarning,
  sendCommandError,
} = require('./src/utils/commandDiagnostics');

const LOCK_FILE = process.env.RIZEBOT_LOCK_FILE || path.join(os.tmpdir(), 'rizebot.lock');
let beforeShutdown = async () => {};
let shutdownRequested = false;

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  try {
    const raw = fs.readFileSync(LOCK_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.pid === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {
    // ignore lock cleanup issues
  }
}

function requestShutdown(signal, exitCode) {
  if (shutdownRequested) return;
  shutdownRequested = true;
  const forceExit = setTimeout(() => {
    releaseLock();
    process.exit(exitCode);
  }, 5_000);
  void Promise.resolve()
    .then(() => beforeShutdown(signal))
    .catch(error => console.error(`Failed to announce ${signal} shutdown:`, error))
    .finally(() => {
      clearTimeout(forceExit);
      releaseLock();
      process.exit(exitCode);
    });
}

function acquireLock() {
  const lockPayload = JSON.stringify({
    pid: process.pid,
    cwd: process.cwd(),
    startedAt: new Date().toISOString()
  });

  try {
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeFileSync(fd, lockPayload);
    fs.closeSync(fd);
    process.once('exit', releaseLock);
    process.once('SIGINT', () => {
      requestShutdown('SIGINT', 130);
    });
    process.once('SIGTERM', () => {
      requestShutdown('SIGTERM', 143);
    });
    return;
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }

  try {
    const raw = fs.readFileSync(LOCK_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (isProcessAlive(Number(data.pid))) {
      console.error(`Rizebot instance already running with pid ${data.pid}. Exiting.`);
      process.exit(1);
    }
  } catch {
    // stale or unreadable lock, replace it below
  }

  fs.rmSync(LOCK_FILE, { force: true });
  acquireLock();
}

acquireLock();

const client = new Client({
  intents: [
    I.Guilds,
    I.GuildMessages,
    I.MessageContent,
    I.GuildMembers,
    I.DirectMessages,
    I.GuildMessageReactions
  ],
  partials: [T.Message, T.Channel, T.Reaction, T.User]
});

const submissionStore = createSubmissionStore();
const databaseService = createRizebotDatabase();
const legacyRegisterStore = createRegisterStore({ database: databaseService });
const moderationStore = createModerationStore();
const interviewTranscriptStore = createInterviewTranscriptStore();
const bridgeService = createTopupBridgeService({
  registerStore: legacyRegisterStore,
  client,
});
const sociabuzzTopupService = createSociabuzzTopupService({
  bridge: bridgeService,
  registerStore: legacyRegisterStore,
  client,
});
const bridgeServer = createTopupBridgeServer({
  bridge: bridgeService,
  host: TOPUP_BRIDGE_HOST,
  port: TOPUP_BRIDGE_PORT,
  token: TOPUP_BRIDGE_TOKEN,
  sociabuzz: sociabuzzTopupService,
  sociabuzzToken: SOCIABUZZ_WEBHOOK_TOKEN,
});
const serverStatusNotifier = createServerStatusNotifier({
  client,
  channelId: SERVER_STATUS_CHANNEL_ID,
});
beforeShutdown = async signal => {
  const reason = signal === 'UNCAUGHT_EXCEPTION' || signal === 'UNHANDLED_REJECTION'
    ? 'BOT mengalami error fatal dan akan dihentikan agar dapat direstart dengan aman.'
    : `BOT menerima ${signal} dan sedang dihentikan atau direload.`;
  await serverStatusNotifier.notifyBotStopping(
    reason
  );
  serverStatusNotifier.stop();
};
process.once('uncaughtException', error => {
  console.error('Uncaught exception:', error);
  requestShutdown('UNCAUGHT_EXCEPTION', 1);
});
process.once('unhandledRejection', reason => {
  console.error('Unhandled promise rejection:', reason);
  requestShutdown('UNHANDLED_REJECTION', 1);
});
const registerHandler = createRegisterHandler({
  roleId: MINECRAFT_REGISTER_ROLE_ID,
  legacyRoleId: MINECRAFT_REGISTER_PENDING_ROLE_ID,
  rejectedRoleId: MINECRAFT_REGISTER_REJECTED_ROLE_ID,
  registerStore: legacyRegisterStore,
  bridge: bridgeService,
  transcriptStore: interviewTranscriptStore,
  submissionStore,
  database: databaseService,
});
const registerInteractionHandler = createRegisterInteractionHandler({
  roleId: MINECRAFT_REGISTER_ROLE_ID,
  legacyRoleId: MINECRAFT_REGISTER_PENDING_ROLE_ID,
  rejectedRoleId: MINECRAFT_REGISTER_REJECTED_ROLE_ID,
  registerStore: legacyRegisterStore,
  bridge: bridgeService,
  transcriptStore: interviewTranscriptStore,
  database: databaseService,
});
const minecraftBridgeHandler = createMinecraftBridgeHandler({
  bridge: bridgeService,
  registerStore: legacyRegisterStore,
});
const companyPanelHandler = createCompanyPanelHandler({
  bridge: bridgeService,
  registerStore: legacyRegisterStore,
});
const socialFinanceHandler = createSocialFinanceHandler({
  bridge: bridgeService,
  registerStore: legacyRegisterStore,
});
const shopHandler = createShopHandler({
  bridge: bridgeService,
  serverStatusNotifier,
});
const rulesHandler = createRulesHandler({
  bridge: bridgeService,
  database: databaseService,
});
const lawHandler = createLawHandler({
  database: databaseService,
  serverStatusNotifier,
});
const topupHandler = createTopupHandler({
  bridge: bridgeService,
  sociabuzz: sociabuzzTopupService,
});
const moderationHandler = createModerationHandler({
  moderationStore,
  privateRoleId: REGISTER_ROLE_ID
});
const moderationReactionHandler = createModerationReactionHandler({
  moderationStore,
  privateRoleId: REGISTER_ROLE_ID
});

const baseHandleMessage = createMessageHandler({
  linkBlocker: maybeBlockLink,
  keywordReply: maybeReplyKeyword,
  registerHandler,
  moderationHandler,
  rulesHandler,
  lawHandler,
  shopHandler,
  socialFinanceHandler,
  companyPanelHandler,
  minecraftBridgeHandler,
  topupHandler
});
const applicationCommandHandler = createApplicationCommandHandler({
  commandHandler: baseHandleMessage,
  bridge: bridgeService,
  registerStore: legacyRegisterStore,
});

registerMemberEvents(client);
const privateRoleEvents = registerPrivateRoleEvents(client, {
  submissionStore,
  privateRoleId: REGISTER_ROLE_ID,
  legacyRoleId: LEGACY_ROLE_ID
});
const ethergeonCitizenRoleEvents = registerEthergeonCitizenRoleEvents(client, {
  registerStore: legacyRegisterStore,
  citizenRoleId: MINECRAFT_REGISTER_ROLE_ID,
  legacyRoleId: MINECRAFT_REGISTER_PENDING_ROLE_ID,
  rejectedRoleId: MINECRAFT_REGISTER_REJECTED_ROLE_ID
});

const ARCHIVE_SWEEP_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.INTERVIEW_ARCHIVE_SWEEP_INTERVAL_MS) || 5 * 60_000
);
const ARCHIVE_SWEEP_LIMIT = Math.max(
  1,
  Math.min(100, Number(process.env.INTERVIEW_ARCHIVE_SWEEP_LIMIT) || 50)
);
const INTERVIEW_NO_REPLY_SWEEP_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.INTERVIEW_NO_REPLY_SWEEP_INTERVAL_MS) || 5 * 60_000
);
const INTERVIEW_NO_REPLY_SWEEP_LIMIT = Math.max(
  1,
  Math.min(100, Number(process.env.INTERVIEW_NO_REPLY_SWEEP_LIMIT) || 50)
);
const BRIDGE_MONITOR_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.MINECRAFT_BRIDGE_MONITOR_INTERVAL_MS) || 10_000
);
const BRIDGE_STALE_MS = Math.max(
  15_000,
  Number(process.env.MINECRAFT_BRIDGE_STALE_MS) || 30_000
);
const BRIDGE_STARTUP_GRACE_MS = Math.max(
  BRIDGE_STALE_MS,
  Number(process.env.MINECRAFT_BRIDGE_STARTUP_GRACE_MS) || 60_000
);

let bridgeAlertChannelPromise = null;
let bridgeMonitorStartedAt = Date.now();
let bridgeMonitorState = 'unknown';
let archiveSweepRunning = false;
let unansweredInterviewSweepRunning = false;

function bridgePollTimeMs(status) {
  const raw = status?.lastJobPollAt || status?.lastEventAt || status?.lastSnapshotAt;
  if (!raw) return 0;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatLogTimestamp(date = new Date()) {
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}:${pad(date.getMilliseconds(), 3)}`,
  ].join(' ');
}

function bridgeLogLine(level, scope, message) {
  return `[${formatLogTimestamp()} ${level}] [Scripting] ${scope} ${message}`;
}

function redactedBridgeUrl() {
  return 'http://[REDACTED_IP]';
}

async function resolveBridgeAlertChannel() {
  if (!REGISTRATION_INBOX_CHANNEL_ID) return null;
  if (!bridgeAlertChannelPromise) {
    bridgeAlertChannelPromise = client.channels.fetch(REGISTRATION_INBOX_CHANNEL_ID).catch(err => {
      bridgeAlertChannelPromise = null;
      console.error('Failed to fetch bridge alert channel:', err);
      return null;
    });
  }
  return bridgeAlertChannelPromise;
}

async function sendBridgeAlert(message) {
  const channel = await resolveBridgeAlertChannel();
  if (!channel?.send) return false;
  await channel.send({
    content: message,
    allowedMentions: { parse: [] },
  }).catch(err => {
    console.error('Failed to send bridge alert:', err);
  });
  return true;
}

async function sendBotReloadNotice() {
  const tag = client.user?.tag || client.user?.username || 'unknown';
  await sendBridgeAlert(
    bridgeLogLine(
      'INFO',
      '[rizebot][system]',
      `Bot reload selesai. User=${tag} | PID=${process.pid} | Node=${process.version}`
    )
  );
  await serverStatusNotifier.notifyBotOnline({ tag });
}

async function checkBridgeHealth() {
  const now = Date.now();
  const status = bridgeService.getBridgeStatus();
  const lastPollMs = bridgePollTimeMs(status);
  const ageMs = lastPollMs ? now - lastPollMs : Number.POSITIVE_INFINITY;
  const inGrace = now - bridgeMonitorStartedAt < BRIDGE_STARTUP_GRACE_MS;
  const connected = lastPollMs > 0 && ageMs <= BRIDGE_STALE_MS;

  if (connected) {
    if (bridgeMonitorState !== 'connected') {
      bridgeMonitorState = 'connected';
      await sendBridgeAlert(
        bridgeLogLine('INFO', '[secRules][bridge]', `HTTP Discord bridge connected: ${redactedBridgeUrl()}.`)
      );
      await serverStatusNotifier.notifyConnected();
    }
    return;
  }

  if (inGrace || bridgeMonitorState === 'disconnected') return;
  bridgeMonitorState = 'disconnected';
  const staleText = Number.isFinite(ageMs)
    ? `${Math.ceil(ageMs / 1000)} detik`
    : 'belum pernah sejak bot start';
  await sendBridgeAlert(
    bridgeLogLine(
      'WARN',
      '[secRules][access]',
      `Discord bridge check gagal: Minecraft BP tidak polling bridge selama ${staleText}. Jika BDS menampilkan InternalHttpRequestError code 111, cek rizebot bridge di port ${TOPUP_BRIDGE_PORT}.`
    )
  );
  await serverStatusNotifier.notifyDisconnected({
    lastContactAt: lastPollMs ? new Date(lastPollMs) : null,
    staleText,
  });
}

async function runArchiveSweep(reason = 'auto') {
  if (archiveSweepRunning) return;
  archiveSweepRunning = true;
  try {
    const summary = await archiveClosedInterviewBacklog(client, {
      limit: ARCHIVE_SWEEP_LIMIT,
      reason: `Interview archive sweep (${reason})`,
    });
    if (summary.moved || summary.failed) {
      console.log(
        `Interview archive sweep (${reason}) moved=${summary.moved}, failed=${summary.failed}, remaining=${summary.remaining}`
      );
    }
  } catch (err) {
    console.error('Interview archive sweep failed:', err);
  } finally {
    archiveSweepRunning = false;
  }
}

async function runUnansweredInterviewSweep(reason = 'auto') {
  if (unansweredInterviewSweepRunning) return;
  unansweredInterviewSweepRunning = true;
  try {
    const summary = await expireUnansweredInterviews(client, {
      registerStore: legacyRegisterStore,
      transcriptStore: interviewTranscriptStore,
      bridge: bridgeService,
      roleId: MINECRAFT_REGISTER_ROLE_ID,
      legacyRoleId: MINECRAFT_REGISTER_PENDING_ROLE_ID,
      rejectedRoleId: MINECRAFT_REGISTER_REJECTED_ROLE_ID,
      limit: INTERVIEW_NO_REPLY_SWEEP_LIMIT,
    });
    if (summary.checked || summary.failed || summary.unavailable) {
      console.log(
        `Interview no-reply sweep (${reason}) checked=${summary.checked}, answered=${summary.answered}, expired=${summary.expired}, closed=${summary.closed}, unavailable=${summary.unavailable}, failed=${summary.failed}`
      );
    }
  } catch (err) {
    console.error('Interview no-reply sweep failed:', err);
  } finally {
    unansweredInterviewSweepRunning = false;
  }
}

client.once('clientReady', async () => {
  await submissionStore.init(client).catch(err => {
    console.error('Failed to init submission store:', err);
  });
  try {
    await legacyRegisterStore.init(client);
    const databaseStatus = databaseService.getStatus();
    console.log(
      `SQLite ready. registrations=${databaseStatus.registrationCount}, database=${databaseStatus.databaseFile}, json=${databaseStatus.registrationJsonFile}`
    );
    await databaseService.createBackup({ reason: 'startup' })
      .then(result => console.log(`SQLite startup backup: ${result.file}`))
      .catch(err => console.error('Failed to create SQLite startup backup:', err));
    databaseService.startBackupScheduler();
  } catch (err) {
    console.error('FATAL: Failed to initialize SQLite registration store:', err);
    process.exit(1);
    return;
  }
  await sociabuzzTopupService.recoverPendingPayments()
    .then(summary => {
      if (summary.checked) {
        console.log(
          `SociaBuzz recovery selesai. checked=${summary.checked}, recovered=${summary.recovered}, refreshed=${summary.refreshed}, failed=${summary.failed}`
        );
      }
    })
    .catch(err => console.error('Failed to recover pending SociaBuzz payments:', err));
  await sociabuzzTopupService.backfillRecentDiscordPayments()
    .then(summary => {
      console.log(
        `SociaBuzz backfill selesai. channels=${summary.channels}, scanned=${summary.scanned}, matched=${summary.matched}, failed=${summary.failed}`
      );
    })
    .catch(err => console.error('Failed to backfill SociaBuzz source channels:', err));
  await bridgeService.redeliverCompletedTopupNotifications()
    .then(summary => {
      if (summary.checked) {
        console.log(
          `Topup notification recovery selesai. checked=${summary.checked}, delivered=${summary.delivered}, failed=${summary.failed}`
        );
      }
    })
    .catch(err => console.error('Failed to redeliver completed topup notifications:', err));
  const topupNotificationRetryInterval = setInterval(() => {
    void bridgeService.redeliverCompletedTopupNotifications()
      .then(summary => {
        if (summary.delivered || summary.failed) {
          console.log(
            `Topup notification retry. checked=${summary.checked}, delivered=${summary.delivered}, failed=${summary.failed}`
          );
        }
      })
      .catch(err => console.error('Failed to retry completed topup notifications:', err));
  }, 60_000);
  topupNotificationRetryInterval.unref?.();
  await moderationStore.init(client).catch(err => {
    console.error('Failed to init moderation store:', err);
  });
  await interviewTranscriptStore.init(client).catch(err => {
    console.error('Failed to init interview transcript store:', err);
  });
  await registerApplicationCommands(client)
    .then(result => {
      console.log(
        `Discord application commands ready. scope=${result.scope}, guilds=${result.guilds}, commands=${result.commands}`
      );
    })
    .catch(err => {
      console.error('Failed to register Discord application commands:', err);
    });
  await privateRoleEvents.sync().catch(err => {
    console.error('Failed to sync private roles:', err);
  });
  await ethergeonCitizenRoleEvents.sync()
    .then(stats => {
      console.log(
        `Ethergeon Citizen role sync selesai. scanned=${stats.scanned}, migrated=${stats.migrated}, failed=${stats.failed}, skipped=${stats.skipped}, fromLegacyRole=${stats.fromLegacyRole || 0}, fromInterviewData=${stats.fromInterviewData || 0}, fromRegisterData=${stats.fromRegisterData || 0}`
      );
    })
    .catch(err => {
      console.error('Failed to sync Ethergeon Citizen roles:', err);
    });
  await syncActivePetitions(client, moderationStore).catch(err => {
    console.error('Failed to sync petitions:', err);
  });
  await bridgeServer.start()
    .then(() => {
      console.log(`Minecraft bridge server ready on ${TOPUP_BRIDGE_HOST}:${TOPUP_BRIDGE_PORT}`);
    })
    .catch(err => {
      console.error('Failed to start Minecraft bridge server:', err);
    });

  const nextRestartNoticeAt = serverStatusNotifier.start();
  if (nextRestartNoticeAt) {
    console.log(`Next Ethergeon restart notice: ${new Date(nextRestartNoticeAt).toISOString()}`);
  }

  await runArchiveSweep('startup');
  const archiveInterval = setInterval(() => {
    void runArchiveSweep('interval');
  }, ARCHIVE_SWEEP_INTERVAL_MS);
  archiveInterval.unref?.();

  await runUnansweredInterviewSweep('startup');
  const unansweredInterviewInterval = setInterval(() => {
    void runUnansweredInterviewSweep('interval');
  }, INTERVIEW_NO_REPLY_SWEEP_INTERVAL_MS);
  unansweredInterviewInterval.unref?.();

  void checkBridgeHealth();
  const bridgeMonitorInterval = setInterval(() => {
    void checkBridgeHealth();
  }, BRIDGE_MONITOR_INTERVAL_MS);
  bridgeMonitorInterval.unref?.();

  await sendBotReloadNotice();
  console.log(`バ. Bot ready as ${client.user.tag}`);
});

const processedMessageContent = new Map();
const PROCESSED_MESSAGE_TTL_MS = 5 * 60 * 1000;
const PROCESSED_MESSAGE_MAX = 1000;
const PROCESS_CLAIM_TTL_MS = 10 * 60 * 1000;
const PROCESS_CLAIM_PRUNE_MS = 60 * 1000;
const MESSAGE_CLAIM_DIR = process.env.RIZEBOT_MESSAGE_CLAIM_DIR ||
  path.join(os.tmpdir(), 'rizebot-message-claims');
let lastProcessClaimPruneAt = 0;

function pruneProcessedMessages(now = Date.now()) {
  for (const [messageId, entry] of processedMessageContent) {
    if (now - entry.at <= PROCESSED_MESSAGE_TTL_MS) continue;
    processedMessageContent.delete(messageId);
  }

  while (processedMessageContent.size > PROCESSED_MESSAGE_MAX) {
    const oldest = processedMessageContent.keys().next().value;
    if (!oldest) break;
    processedMessageContent.delete(oldest);
  }
}

function getMessageContent(msg) {
  return String(msg?.content || '');
}

function diagnosticCommandName(content) {
  const raw = String(content || '').trim();
  if (/^!rules(?:\s|$)/i.test(raw)) return '!rules';
  if (/^!(?:uu(?:\s|$)|uu-help$|help-uu$|tutorial-uu$)/i.test(raw)) return '!uu';
  if (/^!create-uu(?:\s|$)/i.test(raw)) return '!create-uu';
  if (/^!(?:draft-uu|edit-uu)(?:\s|$)/i.test(raw)) return '!draft-uu';
  if (/^!revise-uu(?:\s|$)/i.test(raw)) return '!revise-uu';
  if (/^!cabut-uu(?:\s|$)/i.test(raw)) return '!cabut-uu';
  if (/^!(?:accept|approve)(?:\s|$)/i.test(raw)) return '!accept';
  if (/^!reject(?:\s|$)/i.test(raw)) return '!reject';
  if (/^!close(?:\s|$)/i.test(raw)) return '!close';
  if (/^!relink-interview(?:\s|$)/i.test(raw)) return '!relink-interview';
  if (/^!interview-status(?:\s|$)/i.test(raw)) return '!interview-status';
  if (/^!(?:interview-doctor|repair-interviews)(?:\s|$)/i.test(raw)) return '!repair-interviews';
  if (/^!shopsetting(?:\s|$)/i.test(raw)) return '!shopsetting';
  if (/^!shop(?:\s|$)/i.test(raw)) return '!shop';
  if (/^!bansos(?:\s|$)/i.test(raw)) return '!bansos';
  if (/^!tf\s+--all(?:\s|$)/i.test(raw)) return '!tf --all';
  if (/^!(?:perusahaan|company|company-panel)(?:\s|$)/i.test(raw)) return '!perusahaan';
  if (/^!(?:organisasi|organization|org)(?:\s|$)/i.test(raw)) return '!organisasi';
  if (/^!(?:list|listreg|list-reg|registry|registrasi|pendaftaran)(?:\s|$)/i.test(raw)) return '!list';
  return '';
}

function wasContentProcessed(msg) {
  if (!msg?.id) return false;
  pruneProcessedMessages();
  const entry = processedMessageContent.get(msg.id);
  return Boolean(entry && entry.content === getMessageContent(msg));
}

function rememberProcessedContent(msg) {
  if (!msg?.id) return;
  processedMessageContent.set(msg.id, {
    content: getMessageContent(msg),
    at: Date.now()
  });
  pruneProcessedMessages();
}

function safeMessageClaimId(messageId) {
  return String(messageId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
}

function pruneProcessClaims(now = Date.now()) {
  if (now - lastProcessClaimPruneAt < PROCESS_CLAIM_PRUNE_MS) return;
  lastProcessClaimPruneAt = now;

  let entries = [];
  try {
    entries = fs.readdirSync(MESSAGE_CLAIM_DIR, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const claimPath = path.join(MESSAGE_CLAIM_DIR, entry.name);
    try {
      const stat = fs.statSync(claimPath);
      if (now - stat.mtimeMs > PROCESS_CLAIM_TTL_MS) {
        fs.rmSync(claimPath, { recursive: true, force: true });
      }
    } catch {
      // Ignore stale claim cleanup errors.
    }
  }
}

function claimMessageAcrossProcesses(msg) {
  const messageId = safeMessageClaimId(msg?.id);
  if (!messageId) return false;

  const now = Date.now();
  try {
    fs.mkdirSync(MESSAGE_CLAIM_DIR, { recursive: true });
    pruneProcessClaims(now);
  } catch {
    return true;
  }

  const claimPath = path.join(MESSAGE_CLAIM_DIR, messageId);
  try {
    fs.mkdirSync(claimPath);
    fs.writeFileSync(path.join(claimPath, 'owner.json'), JSON.stringify({
      pid: process.pid,
      content: getMessageContent(msg).slice(0, 200),
      createdAt: new Date(now).toISOString()
    }));
    return true;
  } catch (err) {
    if (err?.code !== 'EEXIST') return true;
  }

  try {
    const stat = fs.statSync(claimPath);
    if (now - stat.mtimeMs > PROCESS_CLAIM_TTL_MS) {
      fs.rmSync(claimPath, { recursive: true, force: true });
      return claimMessageAcrossProcesses(msg);
    }
  } catch {
    return true;
  }

  return false;
}

async function reloadLegacyRegisterDataFromMessage(msg) {
  const reloadedLegacyRegisterData = await legacyRegisterStore.reloadFromMessage(msg).catch(err => {
    console.error('Failed to reload legacy register data from message:', err);
    return false;
  });
  return reloadedLegacyRegisterData;
}

async function reloadInterviewTranscriptDataFromMessage(msg) {
  const reloadedTranscriptData = await interviewTranscriptStore.reloadFromMessage(msg).catch(err => {
    console.error('Failed to reload interview transcript data from message:', err);
    return false;
  });
  return reloadedTranscriptData;
}

async function markInterviewApplicantReply(msg) {
  if (!msg || msg.author?.bot || !msg.author?.id || !msg.channelId) return false;
  const registration = legacyRegisterStore.findUserByInterviewChannel?.(msg.channelId);
  if (!registration || String(registration.userId) !== String(msg.author.id)) return false;
  if (registration.entry?.status !== 'pending' || registration.entry?.answered || registration.entry?.interviewClosedAt) {
    return false;
  }

  const interviewStartedAt = new Date(
    registration.entry.interviewCreatedAt || registration.entry.registeredAt || ''
  ).getTime();
  const messageCreatedAt = Number(msg.createdTimestamp || msg.createdAt?.getTime?.() || Date.now());
  if (Number.isFinite(interviewStartedAt) && messageCreatedAt < interviewStartedAt) return false;
  if (Number.isFinite(interviewStartedAt) && messageCreatedAt >= interviewStartedAt + INTERVIEW_REPLY_TIMEOUT_MS) {
    return false;
  }

  return Boolean(await legacyRegisterStore.markAnswered(registration.userId));
}

async function handleMessageCreate(msg) {
  if (await reloadLegacyRegisterDataFromMessage(msg)) return;
  if (await reloadInterviewTranscriptDataFromMessage(msg)) return;
  if (!msg.author?.bot && isLegacyPrefixCommand(msg.content)) {
    if (isAllowedBotOutputChannel(msg)) {
      await msg.reply({
        content: 'Command prefix `!` sudah dinonaktifkan. Gunakan `/help` untuk melihat seluruh slash command.',
        allowedMentions: { parse: [], repliedUser: false },
      }).catch(() => null);
    }
    return;
  }
  await markInterviewApplicantReply(msg).catch(err => {
    console.error('Failed to mark interview applicant reply:', err);
  });
  if (wasContentProcessed(msg)) return;
  if (!claimMessageAcrossProcesses(msg)) return;
  rememberProcessedContent(msg);

  const handledSociabuzz = await sociabuzzTopupService.handleDiscordMessage(msg).catch(err => {
    console.error('Failed to process SociaBuzz message:', err);
    return false;
  });
  if (handledSociabuzz) return;

  const diagnosticCommand = diagnosticCommandName(msg.content);
  if (diagnosticCommand) {
    logCommandInfo('message-received', msg, {
      command: diagnosticCommand,
      stage: 'command diterima dari Discord',
    });
  }

  if (!isAllowedBotOutputChannel(msg)) {
    const command = diagnosticCommand;
    if (command) {
      const reason = `Channel ID ${msg.channelId || '-'} tidak terdaftar sebagai channel command dan akun tidak terdeteksi sebagai admin/interviewer.`;
      logCommandWarning('channel-policy', msg, {
        command,
        stage: 'validasi channel command',
        details: { reason },
      });
      await sendCommandError(msg, {
        scope: 'channel-policy',
        command,
        stage: 'validasi channel command',
        reason,
      });
    }
    return;
  }

  try {
    await baseHandleMessage(msg);
  } catch (err) {
    const command = diagnosticCommandName(msg.content) || String(msg.content || '').trim().split(/\s+/g)[0];
    logCommandError('message-handler', msg, err, {
      command,
      stage: 'menjalankan command handler',
    });
    if (diagnosticCommandName(msg.content)) {
      await sendCommandError(msg, {
        scope: 'message-handler',
        command,
        stage: 'menjalankan command handler',
        error: err,
      });
    }
  }
}

async function handleMessageUpdate(oldMsg, newMsg) {
  let msg = newMsg;
  if (msg?.partial) {
    msg = await msg.fetch().catch(() => null);
  }
  if (!msg) return;

  if (await reloadLegacyRegisterDataFromMessage(msg)) return;
  if (await reloadInterviewTranscriptDataFromMessage(msg)) return;
  const handledSociabuzz = await sociabuzzTopupService.handleDiscordMessage(msg).catch(err => {
    console.error('Failed to process updated SociaBuzz message:', err);
    return false;
  });
  if (handledSociabuzz) return;

  if (!isAllowedBotOutputChannel(msg)) return;
  if (wasContentProcessed(msg)) return;

  const oldContent = oldMsg?.partial ? null : getMessageContent(oldMsg);
  const newContent = getMessageContent(msg);
  if (oldContent !== null && oldContent === newContent) return;

  await maybeBlockLink(msg);
  rememberProcessedContent(msg);
}

client.on('messageCreate', handleMessageCreate);
client.on('messageUpdate', handleMessageUpdate);
let discordDisconnectedAt = 0;
client.on('shardDisconnect', (_event, shardId) => {
  discordDisconnectedAt = Date.now();
  console.warn(`Discord shard ${shardId} disconnected; waiting for resume.`);
});
client.on('shardResume', (shardId, replayedEvents) => {
  void (async () => {
    const disconnectedForMs = discordDisconnectedAt ? Date.now() - discordDisconnectedAt : 0;
    discordDisconnectedAt = 0;
    await serverStatusNotifier.notifyBotOnline({
      tag: client.user?.tag || client.user?.username || 'unknown',
      reconnected: true,
      shardId,
    });
    const recovery = await sociabuzzTopupService.recoverPendingPayments();
    const backfill = await sociabuzzTopupService.backfillRecentDiscordPayments();
    const notifications = await bridgeService.redeliverCompletedTopupNotifications();
    console.log(
      `SociaBuzz reconnect recovery shard=${shardId}, replayed=${replayedEvents}, disconnectedMs=${disconnectedForMs}, recovered=${recovery.recovered}, refreshed=${recovery.refreshed}, scanned=${backfill.scanned}, matched=${backfill.matched}, notifications=${notifications.delivered}, failed=${recovery.failed + backfill.failed + notifications.failed}`
    );
  })().catch(err => console.error('Failed to recover SociaBuzz after Discord reconnect:', err));
});
client.on('interactionCreate', async interaction => {
  const handledApplicationCommand = await applicationCommandHandler(interaction).catch(async err => {
    console.error('Application command handler error:', err);
    const content = `Slash command gagal diproses: ${err.message || err}`;
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({ content }).catch(() => null);
    } else if (interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => null);
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => null);
    }
    return true;
  });
  if (handledApplicationCommand) return;
  const handledRegister = await registerInteractionHandler(interaction);
  if (handledRegister) return;
  const handledSociabuzz = await sociabuzzTopupService.handleInteraction(interaction).catch(err => {
    console.error('Failed to process SociaBuzz interaction:', err);
    return false;
  });
  if (handledSociabuzz) return;
  if (!isAllowedBotOutputChannel(interaction)) return;
});
client.on('messageReactionAdd', async (reaction, user) => {
  await moderationReactionHandler(reaction, user);
});

client.login(process.env.DISCORD_TOKEN);
