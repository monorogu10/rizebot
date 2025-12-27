const SAVE_CHANNEL_ID = '1412649363037229176';
const STORAGE_FILE_NAME = 'leaderboard-data.json';
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
  WELCOME_CHANNEL_ID,
  LEAVE_CHANNEL_ID,
  LINK_REGEX,
  ALLOWED_GIF_HOSTS,
  KEYWORD_LINKS,
  COMMAND_CHANNELS
};
