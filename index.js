require('dotenv').config();
const { Client, GatewayIntentBits: I, Partials: T } = require('discord.js');

const { maybeBlockLink } = require('./src/features/linkBlocker');
const { maybeReplyKeyword } = require('./src/features/keywordReply');
const { createMessageHandler } = require('./src/handlers/messageHandler');
const { registerMemberEvents } = require('./src/handlers/memberEvents');
const { registerPrivateRoleEvents } = require('./src/handlers/privateRoleHandler');
const {
  createRegisterHandler,
  createRegisterInteractionHandler,
  syncEventCategoryRolesFromStore,
  syncEventRoleForMember
} = require('./src/handlers/registerHandler');
const {
  createModerationHandler,
  createModerationReactionHandler,
  syncActivePetitions
} = require('./src/handlers/moderationHandler');
const { createSubmissionStore } = require('./src/services/submissionStore');
const { createModerationStore } = require('./src/services/moderationStore');
const { createEventRegistrationStore } = require('./src/services/eventRegistrationStore');
const { REGISTER_ROLE_ID, LEGACY_ROLE_ID } = require('./src/config');

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
const moderationStore = createModerationStore();
const eventRegistrationStore = createEventRegistrationStore();
const registerHandler = createRegisterHandler({
  roleId: REGISTER_ROLE_ID,
  submissionStore,
  eventRegistrationStore
});
const registerInteractionHandler = createRegisterInteractionHandler({
  eventRegistrationStore
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
  moderationHandler
});

registerMemberEvents(client);
const privateRoleEvents = registerPrivateRoleEvents(client, {
  submissionStore,
  privateRoleId: REGISTER_ROLE_ID,
  legacyRoleId: LEGACY_ROLE_ID
});

client.once('ready', async () => {
  await submissionStore.init(client).catch(err => {
    console.error('Failed to init submission store:', err);
  });
  await moderationStore.init(client).catch(err => {
    console.error('Failed to init moderation store:', err);
  });
  await eventRegistrationStore.init(client).catch(err => {
    console.error('Failed to init event registration store:', err);
  });
  await syncEventCategoryRolesFromStore(client, eventRegistrationStore)
    .then(stats => {
      console.log(
        `Event role sync selesai. scanned=${stats.scanned}, synced=${stats.synced}, failed=${stats.failed}, skipped=${stats.skipped}`
      );
    })
    .catch(err => {
      console.error('Failed to sync event category roles:', err);
    });
  await privateRoleEvents.sync().catch(err => {
    console.error('Failed to sync private roles:', err);
  });
  await syncActivePetitions(client, moderationStore).catch(err => {
    console.error('Failed to sync petitions:', err);
  });
  console.log(`バ. Bot ready as ${client.user.tag}`);
});

async function handleMessage(msg) {
  await baseHandleMessage(msg);
}

client.on('messageCreate', handleMessage);
client.on('messageUpdate', async (_old, n) => {
  if (n?.partial) {
    try { await n.fetch(); } catch { /* ignore */ }
  }
  await handleMessage(n);
});
client.on('interactionCreate', async interaction => {
  await registerInteractionHandler(interaction);
});
client.on('guildMemberAdd', async member => {
  await syncEventRoleForMember(member, eventRegistrationStore).catch(err => {
    console.error('Failed to sync event role for joined member:', err);
  });
});
client.on('messageReactionAdd', async (reaction, user) => {
  await moderationReactionHandler(reaction, user);
});

client.login(process.env.DISCORD_TOKEN);
