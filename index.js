require('dotenv').config();
const { Client, GatewayIntentBits: I, EmbedBuilder: E, PermissionsBitField: P, Partials: T, AttachmentBuilder: A } = require('discord.js');
const { Buffer } = require('node:buffer');

// === KONFIG ===
const C = {
  prefix:'!', botToIgnoreId:'1409389474928132108',
  welcomeChannelId:'1195884175912358031', leaveChannelId:'1412648951638917271',
  registrationChannelId:'1412304090146541748', registrationRoleId:'1412079693934624828',
  logChannelId:'1412316496830402600', saveDataChannelId:'1412649363037229176',
};

// === CLIENT ===
const client = new Client({
  intents:[I.Guilds,I.GuildMessages,I.MessageContent,I.GuildMembers,I.GuildMessageReactions,I.GuildModeration],
  partials:[T.Message,T.Channel,T.Reaction],
});

// === STATE ===
let registrations = new Map();
let registrationMessageIds = []; // pagination
const msgCache = new Map();      // snapshot konten pesan
const CACHE_TTL_MS = 1000*60*60; // 1 jam
let updatePending = false;

// === UTIL ===
const t = (s,m=1024)=>!s?'':(s.length>m?`${s.slice(0,m-3)}...`:s);
const att = (atts)=>!atts||!atts.size?'—':t([...atts.values()].map((a,i)=>`${i+1}. ${a.name||'lampiran'} (${a.contentType||'tipe?'}): ${a.url}`).join('\n'),1024);
const L = async (embed)=>{ const ch=client.channels.cache.get(C.logChannelId); if(!ch) return console.error('Channel log tidak ditemukan!'); try{ await ch.send({embeds:[embed]}); }catch(e){ console.error('Gagal mengirim log:',e);} };
const scheduleUpdate = ()=>{ if(updatePending) return; updatePending=true; setTimeout(()=>{updatePending=false; updateRegistrationMessage();},1500); };

// Cache snapshot isi pesan saat masuk / edit
function cacheMessageSnapshot(msg){
  try{
    if(!msg||!msg.id||!msg.guild) return;
    const attachments = [];
    if(msg.attachments?.size) msg.attachments.forEach(a=>attachments.push({name:a.name,url:a.url,contentType:a.contentType}));
    msgCache.set(msg.id,{
      id:msg.id, channelId:msg.channelId,
      authorId:msg.author?.id,
      authorTag: msg.author?`${msg.author.tag} (${msg.author.id})`:'Tidak diketahui',
      content: msg.content||'', attachments,
      createdTimestamp: msg.createdTimestamp
    });
    setTimeout(()=>msgCache.delete(msg.id), CACHE_TTL_MS);
  }catch{}
}

// === SAVE / LOAD ===
async function saveData(){
  const ch = client.channels.cache.get(C.saveDataChannelId);
  if(!ch) return console.error('Channel save data tidak ditemukan!');
  const data = { registrationMessageIds, registrations:[...registrations.entries()] };
  const attachment = new A(Buffer.from(JSON.stringify(data),'utf-8'),{name:'data.json'});
  try{
    const old = await ch.messages.fetch({limit:10});
    const mine = old.filter(m=>m.author.id===client.user.id);
    if(mine.size>0) await ch.bulkDelete(mine).catch(()=>{});
    await ch.send({content:`💾 Data backup terakhir pada: <t:${Math.floor(Date.now()/1000)}:F>`, files:[attachment]});
    console.log('✅ Data tersimpan.');
  }catch(e){ console.error('Gagal menyimpan data:',e); }
}
async function loadData(){
  const ch = client.channels.cache.get(C.saveDataChannelId);
  if(!ch) return console.error('Channel save data tidak ditemukan, mulai data kosong.');
  try{
    const msgs = await ch.messages.fetch({limit:10});
    const last = msgs.filter(m=>m.author.id===client.user.id && m.attachments.size>0).first();
    if(!last) return console.log('Tidak ada backup, mulai kosong.');
    const file = last.attachments.first(); if(file.name!=='data.json') return;
    const res = await fetch(file.url); const data = await res.json();
    registrationMessageIds = Array.isArray(data.registrationMessageIds)?data.registrationMessageIds:[];
    registrations = new Map(data.registrations||[]);
    console.log(`✅ Data dimuat. Total ${registrations.size} pendaftar.`);
  }catch(e){ console.error('Gagal memuat data:',e); }
}

// === REGISTRATION EMBEDS (pagination anti-limit) ===
function buildRegistrationEmbeds(){
  const MAX = 3900, embeds=[], header='🌠 Pendaftaran Server Starlight', footer='Gunakan !help untuk melihat perintah';
  if(registrations.size===0){
    embeds.push(new E().setColor('#FFD700').setTitle(header).setDescription('Saat ini belum ada member yang terdaftar.').setTimestamp().setFooter({text:footer}));
    return embeds;
  }
  const lines=[]; let i=1; for(const [uid,gt] of registrations.entries()) lines.push(`${i++}. **${gt}** - <@${uid}>`);
  let page=[], len=0;
  for(const line of lines){
    const add=line.length+1;
    if(len+add>MAX && page.length){ embeds.push(page); page=[]; len=0; }
    page.push(line); len+=add;
  }
  if(page.length) embeds.push(page);
  return embeds.map((pg,idx)=> new E()
    .setColor('#FFD700')
    .setTitle(`${header} — Hal ${idx+1}/${embeds.length||1}`)
    .setDescription(pg.join('\n'))
    .addFields({name:'Total Pendaftar', value:`${registrations.size} member`, inline:true})
    .setTimestamp().setFooter({text:footer})
  );
}

// === UPDATE REGISTRATION MESSAGE(S) ===
async function updateRegistrationMessage(){
  const ch = client.channels.cache.get(C.registrationChannelId);
  if(!ch) return console.error('Channel registrasi tidak ditemukan!');
  const embeds = buildRegistrationEmbeds();
  try{
    let i=0;
    for(; i<Math.min(registrationMessageIds.length, embeds.length); i++){
      try{
        const msg = await ch.messages.fetch(registrationMessageIds[i]).catch(()=>null);
        if(msg) await msg.edit({embeds:[embeds[i]]});
        else { const sent = await ch.send({embeds:[embeds[i]]}); registrationMessageIds[i]=sent.id; }
      }catch{
        const sent = await ch.send({embeds:[embeds[i]]}); registrationMessageIds[i]=sent.id;
      }
    }
    for(; i<embeds.length; i++){ const sent=await ch.send({embeds:[embeds[i]]}); registrationMessageIds.push(sent.id); }
    if(registrationMessageIds.length>embeds.length){
      const extra = registrationMessageIds.slice(embeds.length);
      for(const id of extra){ const msg=await ch.messages.fetch(id).catch(()=>null); if(msg) await msg.delete().catch(()=>{}); }
      registrationMessageIds = registrationMessageIds.slice(0, embeds.length);
    }
    await saveData();
  }catch(e){ console.error('Gagal update pesan registrasi:',e); }
}

// === LINK DETECTION ===
async function handleLinkDetection(m){
  if(!m.guild || m.author.bot) return false;
  if(m.member?.permissions.has(P.Flags.Administrator)) return false;
  if(/https?:\/\/[^\s]+/g.test(m.content)){
    await m.delete().catch(()=>{});
    const w = await m.channel.send(`${m.author}, dilarang mengirim link di server ini!`);
    setTimeout(()=>w.delete().catch(()=>{}),5000);
    const embed = new E().setColor('#E74C3C').setTitle('🔗 Link Terdeteksi & Diblokir')
      .addFields(
        {name:'Member', value:`${m.author} (${m.author.id})`, inline:true},
        {name:'Channel', value:`${m.channel}`, inline:true},
        {name:'Isi Pesan', value:`\`\`\`${t(m.content,1000)}\`\`\``}
      ).setTimestamp();
    await L(embed);
    return true;
  }
  return false;
}

// === AUDIT LOG (siapa yang hapus) ===
async function findDeleterAuditLog(guild, targetUserId){
  try{
    const fetched = await guild.fetchAuditLogs({type:72, limit:5});
    const now = Date.now();
    const entry = fetched.entries.find(e=>{
      const close = now - e.createdTimestamp < 10_000;
      const same = e.target && e.target.id ? (e.target.id===targetUserId) : true;
      return close && same;
    });
    if(entry) return entry.executor;
  }catch{}
  return null;
}

// === EVENTS ===
client.once('ready', async ()=>{
  console.log(`✅ Bot siap! Login sebagai ${client.user.tag}`);
  client.user.setActivity('Para Member',{type:'WATCHING'});
  await loadData();
  updateRegistrationMessage();
});

client.on('messageCreate', async m=>{
  cacheMessageSnapshot(m);                 // <— simpan snapshot
  if(await handleLinkDetection(m)) return;

  const words = m.content.toLowerCase().split(/\s+/);
  if(words.includes('monodeco')||words.includes('decorize')){ /* ... */ }

  if(!m.content.startsWith(C.prefix)) return;
  const args = m.content.slice(C.prefix.length).trim().split(/ +/), cmd = args.shift()?.toLowerCase();

  if(cmd==='ping') return m.reply(`Pong! 🏓 Latency: ${Date.now()-m.createdTimestamp}ms.`);
  if(cmd==='reg'){
    if(registrations.has(m.author.id)) return m.reply('Kamu sudah terdaftar!');
    const gamertag = args.join(' '); if(!gamertag) return m.reply('Contoh: `!reg NamaGamertag`');
    const role = m.guild.roles.cache.get(C.registrationRoleId); if(!role) return m.reply('Error: Role pendaftaran tidak ditemukan.');
    try{
      await m.member.roles.add(role);
      registrations.set(m.author.id, gamertag);
      scheduleUpdate(); await saveData();
      m.reply(`✅ Registrasi berhasil dengan gamertag **${gamertag}**.`);
    }catch(e){ console.error(e); m.reply('Terjadi kesalahan.'); }
  }else if(cmd==='edit-reg'){
    if(!registrations.has(m.author.id)) return m.reply('Kamu belum terdaftar.');
    const ng = args.join(' '); if(!ng) return m.reply('Contoh: `!edit-reg GamertagBaru`');
    registrations.set(m.author.id, ng);
    scheduleUpdate(); await saveData();
    m.reply(`✅ Gamertag kamu diubah menjadi **${ng}**.`);
  }else if(cmd==='del-reg'){
    if(!registrations.has(m.author.id)) return m.reply('Kamu belum terdaftar.');
    const role = m.guild.roles.cache.get(C.registrationRoleId); if(role) await m.member.roles.remove(role).catch(()=>{});
    registrations.delete(m.author.id);
    scheduleUpdate(); await saveData();
    m.reply('☑️ Pendaftaran kamu telah dibatalkan.');
  }else if(cmd==='help'){
    const help = new E().setColor('#3498db').setTitle('📜 Bantuan Perintah Registrasi').addFields(
      {name:'`!reg [gamertag]`', value:'Mendaftarkan dirimu.'},
      {name:'`!edit-reg [gamertag baru]`', value:'Mengubah gamertag.'},
      {name:'`!del-reg`', value:'Membatalkan pendaftaran.'}
    );
    m.channel.send({embeds:[help]});
  }
});

client.on('messageUpdate', async (_o,n)=>{
  if(n.partial) await n.fetch().catch(()=>{});
  cacheMessageSnapshot(n);                 // <— update snapshot
  await handleLinkDetection(n);
});

client.on('messageReactionAdd', async (r)=>{
  if(r.partial) await r.fetch().catch(()=>{});
  if(r.emoji.name==='🗑️' && r.count>=10){
    const m=r.message;
    if(m.author.bot || m.author.id===C.botToIgnoreId) return;
    const mem = await m.guild.members.fetch(m.author.id).catch(()=>null);
    if(mem?.permissions.has(P.Flags.Administrator)) return;
    try{
      await m.delete();
      const x = await m.channel.send(`🗑️ Pesan dari ${m.author} telah dihapus.`);
      setTimeout(()=>x.delete().catch(()=>{}),5000);
    }catch(e){ console.error('Gagal hapus via reaksi:',e); }
  }
});

// === LOG DELETE: gunakan snapshot ===
client.on('messageDelete', async (m)=>{
  try{
    if(m.partial){ try{ await m.fetch(); }catch{} }
    if(!m.guild) return;
    const snap = msgCache.get(m.id);
    const authorTag = snap?.authorTag || (m.author?`${m.author.tag} (${m.author.id})`:'Tidak diketahui');
    const channelMention = m.channel?`${m.channel}`:(snap?.channelId?`<#${snap.channelId}>`:'Tidak diketahui');
    const contentText = (snap?.content?.length?snap.content:(m.content||''));
    const content = contentText.length?contentText:(m.partial?'[Konten tidak tersedia (partial)]':'[Tidak ada konten]');
    const attachmentsInfo = (snap?.attachments?.length
      ? t(snap.attachments.map((a,i)=>`${i+1}. ${a.name||'lampiran'} (${a.contentType||'tipe?'})${a.url?`: ${a.url}`:''}`).join('\n'),1024)
      : att(m.attachments));

    let deleter='Tidak diketahui';
    if(m.guild.members.me?.permissions.has(P.Flags.ViewAuditLog)){
      const ex = await findDeleterAuditLog(m.guild, m.author?.id);
      if(ex) deleter = `${ex.tag} (${ex.id})`;
    }

    const embed = new E().setColor('#ff6b6b').setTitle('🗑️ Pesan Dihapus').addFields(
      {name:'Penulis', value:authorTag},
      {name:'Channel', value:channelMention},
      {name:'Dihapus oleh', value:deleter},
      {name:'Isi Pesan', value: content.trim()?`\`\`\`${t(content,1000)}\`\`\``:'—'},
      {name:'Lampiran', value:attachmentsInfo}
    ).setFooter({text:`Message ID: ${m.id}`}).setTimestamp();
    await L(embed);
  }catch(e){ console.error('Gagal melog messageDelete:',e); }
});

client.on('messageDeleteBulk', async (msgs)=>{
  try{
    const first = msgs.first(), g = first?.guild, ch = first?.channel;
    let deleter='Tidak diketahui';
    if(g?.members.me?.permissions.has(P.Flags.ViewAuditLog)){
      const ex = await findDeleterAuditLog(g,null); if(ex) deleter=`${ex.tag} (${ex.id})`;
    }
    const sample=[], iter = msgs.values(); let i=0, cur;
    while(!(cur=iter.next()).done){
      i++; const msg = cur.value, snap = msgCache.get(msg.id);
      const author = (snap?.authorTag?.split(' (')[0]) || (msg.author?`${msg.author.tag}`:'Unknown');
      const raw = snap?.content ?? msg.content ?? (msg.partial?'[partial]':'[empty]');
      sample.push(`${i}. ${author}: ${t((raw||'').replace(/\n/g,' '),120)}`);
      if(i>=10) break;
    }
    const embed = new E().setColor('#ff9f43').setTitle('🧹 Bulk Delete Terdeteksi').addFields(
      {name:'Jumlah Pesan', value:String(msgs.size), inline:true},
      {name:'Channel', value: ch?`${ch}`:'Tidak diketahui', inline:true},
      {name:'Dihapus oleh', value: deleter, inline:false},
      {name:'Contoh (max 10)', value: sample.length?`\`\`\`\n${sample.join('\n')}\n\`\`\``:'—', inline:false}
    ).setTimestamp();
    await L(embed);
  }catch(e){ console.error('Gagal melog messageDeleteBulk:',e); }
});

// === WELCOME / LEAVE ===
client.on('guildMemberAdd', async m=>{
  const ch = m.guild.channels.cache.get(C.welcomeChannelId); if(!ch) return;
  const embed = new E().setColor('#2ecc71').setTitle(`👋 Selamat Datang di ${m.guild.name}!`)
    .setDescription(`Halo ${m}, selamat bergabung!`)
    .setThumbnail(m.user.displayAvatarURL({dynamic:true}))
    .addFields({name:'Total Member', value:`${m.guild.memberCount} member`})
    .setTimestamp();
  ch.send({embeds:[embed]});
});
client.on('guildMemberRemove', async m=>{
  if(registrations.has(m.id)){ registrations.delete(m.id); scheduleUpdate(); await saveData(); console.log(`Data registrasi ${m.user.tag} dihapus (keluar).`); }
  const ch = m.guild.channels.cache.get(C.leaveChannelId); if(!ch) return;
  const embed = new E().setColor('#e74c3c').setTitle('😢 Selamat Tinggal...')
    .setDescription(`**${m.user.tag}** telah meninggalkan server.`)
    .setThumbnail(m.user.displayAvatarURL({dynamic:true}))
    .addFields({name:'Total Member', value:`${m.guild.memberCount} member`})
    .setTimestamp();
  ch.send({embeds:[embed]});
});

// === START ===
client.login(process.env.DISCORD_TOKEN);
