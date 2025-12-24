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
  monodeco: 'https://www.curseforge.com/minecraft-bedrock/addons/mdco26',
  mdco: 'https://www.curseforge.com/minecraft-bedrock/addons/mdco26',
  mde: 'https://www.curseforge.com/minecraft-bedrock/addons/mdco26',
  monodecogen4: 'https://www.curseforge.com/minecraft-bedrock/addons/monodeco-plus',
  decorize: 'https://www.curseforge.com/minecraft-bedrock/addons/decorize-furniture',
  gen4: 'https://www.curseforge.com/minecraft-bedrock/addons/monodeco-plus',
  mdg4: 'https://www.curseforge.com/minecraft-bedrock/addons/monodeco-plus',
  server: 'https://discord.gg/XvMgRJpRBV',
  live: 'https://www.youtube.com/@monodeco_md',
  update: 'https://www.youtube.com/@monodeco_md',
  liveupdate: 'https://www.youtube.com/@monodeco_md',
  donate: 'https://sociabuzz.com/monodeco/tribe',
  donasi: 'https://sociabuzz.com/monodeco/tribe',
  support: 'https://sociabuzz.com/monodeco/tribe',
  website: 'https://curseforge.com/members/monodeco/projects'
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
