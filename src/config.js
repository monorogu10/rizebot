const SAVE_CHANNEL_ID = '1412649363037229176';
const STORAGE_FILE_NAME = 'leaderboard-data.json';
const REGISTER_STORAGE_FILE_NAME = 'register-data.json';
const REGISTER_ROLE_ID = '1457175840386191548';
const SUBMISSION_CHANNEL_ID = '1466590962066133023';
const SUBMISSION_ROLE_ID = '1195887506021957697';
const RATING_PREFIX = '[rate]';
const RATING_APPROVE_EMOJI = '\u2705';
const RATING_REJECT_EMOJI = '\u274C';
const RATING_MIN_APPROVALS = 11;
const REGISTRATION_INBOX_CHANNEL_ID = '1209816094156529745';
const WELCOME_CHANNEL_ID = '1195884175912358031';
const LEAVE_CHANNEL_ID = '1412648951638917271';

const LINK_REGEX = /https?:\/\/\S+/i;
const ALLOWED_GIF_HOSTS = new Set([
  'tenor.com',
  'media.tenor.com',
  'giphy.com',
  'media.giphy.com',
  'i.giphy.com',
  'i.imgur.com',
  'cdn.discordapp.com'
]);
const KEYWORD_LINKS = {
  monodeco: 'https://monodeco.my.id/',
  mdco: 'https://monodeco.my.id/',
  mde: 'https://monodeco.my.id/',
  engine: 'https://monodeco.my.id/',
  mdengine: 'https://monodeco.my.id/',
  monodecoengine: 'https://monodeco.my.id/',
  monodecogen4: 'https://monodeco.my.id/',
  decorize: 'https://monodeco.my.id/',
  gen4: 'https://monodeco.my.id/',
  mdg4: 'https://monodeco.my.id/',
  server: 'https://discord.gg/XvMgRJpRBV',
  live: 'https://www.youtube.com/@monodeco_md',
  update: 'https://www.youtube.com/@monodeco_md',
  liveupdate: 'https://www.youtube.com/@monodeco_md',
  donate: 'https://sociabuzz.com/monodeco/tribe',
  donasi: 'https://sociabuzz.com/monodeco/tribe',
  support: 'https://sociabuzz.com/monodeco/tribe',
  website: 'https://monodeco.my.id/'
};
const COMMAND_CHANNELS = new Set(['1444968497800286219', '1209816094156529745']);

module.exports = {
  SAVE_CHANNEL_ID,
  STORAGE_FILE_NAME,
  REGISTER_STORAGE_FILE_NAME,
  REGISTER_ROLE_ID,
  SUBMISSION_CHANNEL_ID,
  SUBMISSION_ROLE_ID,
  RATING_PREFIX,
  RATING_APPROVE_EMOJI,
  RATING_REJECT_EMOJI,
  RATING_MIN_APPROVALS,
  REGISTRATION_INBOX_CHANNEL_ID,
  WELCOME_CHANNEL_ID,
  LEAVE_CHANNEL_ID,
  LINK_REGEX,
  ALLOWED_GIF_HOSTS,
  KEYWORD_LINKS,
  COMMAND_CHANNELS
};
