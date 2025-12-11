const SAVE_CHANNEL_ID = '1412649363037229176';
const STORAGE_FILE_NAME = 'leaderboard-data.json';

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
const KEYWORD_CHANNELS = new Set(['1412299373731385354', '1411683951575040160', '1209816094156529745']);
const KEYWORD_REGEX = /^(?:monodeco|decorize|mdco)$/i;
const COMMAND_CHANNELS = new Set(['1444968497800286219', '1209816094156529745']);

module.exports = {
  SAVE_CHANNEL_ID,
  STORAGE_FILE_NAME,
  LINK_REGEX,
  ALLOWED_GIF_HOSTS,
  KEYWORD_CHANNELS,
  KEYWORD_REGEX,
  COMMAND_CHANNELS
};
