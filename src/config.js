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
const KEYWORD_LINKS = {
  monodeco: 'https://www.curseforge.com/minecraft-bedrock/addons/mdco26',
  mdco: 'https://www.curseforge.com/minecraft-bedrock/addons/mdco26',
  mde: 'https://www.curseforge.com/minecraft-bedrock/addons/mdco26',
  decorize: 'https://www.curseforge.com/minecraft-bedrock/addons/decorize-furniture',
  gen4: 'https://www.curseforge.com/minecraft-bedrock/addons/monodeco-plus',
  mdg4: 'https://www.curseforge.com/minecraft-bedrock/addons/monodeco-plus'
};
const COMMAND_CHANNELS = new Set(['1444968497800286219', '1209816094156529745']);

module.exports = {
  SAVE_CHANNEL_ID,
  STORAGE_FILE_NAME,
  LINK_REGEX,
  ALLOWED_GIF_HOSTS,
  KEYWORD_LINKS,
  COMMAND_CHANNELS
};
