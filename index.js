const tmi = require('tmi.js');
const Groq = require('groq-sdk');

// ══════════════════════════════════════════
//  CONFIGURACIÓN GLOBAL
// ══════════════════════════════════════════
const TWITCH_BOT_USERNAME = process.env.TWITCH_BOT_USERNAME; // muffet_osoking
const TWITCH_OAUTH_TOKEN  = process.env.TWITCH_OAUTH_TOKEN;  // token de muffet_osoking
const GROQ_API_KEY        = process.env.GROQ_API_KEY;
const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_KEY        = process.env.SUPABASE_KEY;

const groq = new Groq({ apiKey: GROQ_API_KEY });

// ══════════════════════════════════════════
//  CONFIG POR CANAL (cargada desde Supabase)
// ══════════════════════════════════════════
let channelConfigs = {}; // { 'elosoking1': { bot_prompt, commands, ... } }
let muffetActiveMap = {}; // { 'elosoking1': true/false }
let greetedMap = {}; // { 'elosoking1': Set() }

const defaultConfig = (username) => ({
  bot_prompt: `Eres Muffet, la araña de Undertale. Eres la consejera del canal de ${username}. Los viewers son "súbditos" o "dearies". Hablas en español, eres coqueta y misteriosa. Usas emojis 🕷️ 👑 ♥. Respuestas cortas (máximo 2 oraciones).`,
  commands: {
    '!muffet': { response: '🕷️ ¡Soy Muffet, consejera del canal! 👑♥', perms: ['everyone'] },
    '!comandos': { response: '🕷️ Comandos: !ask — ¡Pregúntame lo que quieras! 👑♥', perms: ['everyone'] },
  },
  auto_messages: ['🕷️ ¡Usa !ask para preguntarme cualquier cosa! 👑♥'],
  ai_enabled: true,
  mod_enabled: false,
  banned_words: [],
  warn_message: '⚠️ Cuidado, dearie~ 🕷️',
  plan: 'free',
});

// ══════════════════════════════════════════
//  CARGAR TODOS LOS CANALES APROBADOS
// ══════════════════════════════════════════
async function loadAllChannels() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/streamers?approved=eq.true&select=*`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const streamers = await res.json();
    if (!Array.isArray(streamers)) { console.error('Error cargando canales:', streamers); return []; }

    streamers.forEach(s => {
      const ch = s.twitch_username.toLowerCase();
      channelConfigs[ch] = {
        bot_prompt:    s.bot_prompt    || defaultConfig(ch).bot_prompt,
        commands:      s.commands      || defaultConfig(ch).commands,
        auto_messages: s.auto_messages || defaultConfig(ch).auto_messages,
        auto_message_interval: s.auto_message_interval || 20,
        ai_enabled:    s.ai_enabled    !== undefined ? s.ai_enabled  : true,
        mod_enabled:   s.mod_enabled   !== undefined ? s.mod_enabled : false,
        banned_words:  s.banned_words  || [],
        warn_message:  s.warn_message  || '⚠️ Cuidado, dearie~ 🕷️',
        plan:          s.plan          || 'free',
        on_off_ai:     s.on_off_ai     !== false,
        on_message:    s.on_message    || null,
        off_message:   s.off_message   || null,
        counters:      s.counters      || {},
        points_config: s.points_config || {},
        viewer_points: s.viewer_points || {},
        social_links:  s.social_links  || {},
        custom_bot_username: s.custom_bot_username || null,
        custom_bot_token:    s.custom_bot_token    || null,
      };
      if (muffetActiveMap[ch] === undefined) muffetActiveMap[ch] = true;
      if (!greetedMap[ch]) greetedMap[ch] = new Set();
    });

    console.log(`🐻🕷️ Config cargada para ${streamers.length} canales:`, streamers.map(s => s.twitch_username).join(', '));
    // Debug auto_messages
    streamers.forEach(s => {
      const ch = s.twitch_username.toLowerCase();
      console.log(`📨 ${ch} auto_messages:`, JSON.stringify(s.auto_messages)?.substring(0,100));
    });
    return streamers.map(s => s.twitch_username.toLowerCase());
  } catch (err) {
    console.error('Error cargando canales:', err.message);
    return [];
  }
}

// ══════════════════════════════════════════
//  STATS
// ══════════════════════════════════════════
let statsBuffer = {};
let statsFlushTimer = null;

function trackCommandUse(channel, trigger) {
  const key = `${channel}:${trigger}`;
  statsBuffer[key] = (statsBuffer[key] || 0) + 1;
  if (!statsFlushTimer) statsFlushTimer = setTimeout(flushStats, 30000);
}

async function flushStats() {
  statsFlushTimer = null;
  if (Object.keys(statsBuffer).length === 0) return;
  try {
    const byChannel = {};
    for (const [key, count] of Object.entries(statsBuffer)) {
      const [ch, cmd] = key.split(':');
      if (!byChannel[ch]) byChannel[ch] = {};
      byChannel[ch][cmd] = (byChannel[ch][cmd] || 0) + count;
    }
    statsBuffer = {};

    for (const [ch, newStats] of Object.entries(byChannel)) {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${ch}&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const data = await res.json();
      const current = (data && data[0] && data[0].command_stats) || {};
      const updated = { ...current };
      for (const [cmd, count] of Object.entries(newStats)) updated[cmd] = (updated[cmd] || 0) + count;
      await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${ch}`, {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ command_stats: updated })
      });
    }
    console.log('📊 Stats actualizadas');
  } catch (err) {
    console.error('Error guardando stats:', err.message);
  }
}

// ══════════════════════════════════════════
//  MODERACIÓN CON IA
// ══════════════════════════════════════════
async function checkMessageWithAI(message) {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: `Eres un sistema de moderación de chat de Twitch. Analiza el mensaje y responde SOLO con JSON: {"flagged": true/false, "reason": "razón o null"}. Marca true si hay: insultos, groserías, links maliciosos, spam, acoso, contenido adulto. Marca false si es conversación normal. SOLO el JSON.` },
        { role: 'user', content: `Mensaje: "${message}"` }
      ],
      max_tokens: 60,
      temperature: 0.1,
    });
    const text = completion.choices[0]?.message?.content || '{"flagged":false}';
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (err) {
    return { flagged: false };
  }
}

// ── Formatear links de redes ──
function formatSocials(social_links) {
  const icons = { twitch:'🎮', youtube:'📺', tiktok:'🎵', twitter:'🐦', instagram:'📸', discord:'💬', youtube_channel:'▶️' };
  const labels = { twitch:'Twitch', youtube:'YouTube', tiktok:'TikTok', twitter:'Twitter', instagram:'Instagram', discord:'Discord', youtube_channel:'YouTube' };
  return Object.entries(social_links)
    .filter(([,v]) => v)
    .map(([k,v]) => `${icons[k]||'🔗'} ${labels[k]||k}: ${v}`)
    .join(' | ');
}

// ── Resolver variables dinámicas ──
async function resolveVariables(text, channelName, username, touser) {
  let result = text;
  result = result.replace(/\{user\}/g, username);
  result = result.replace(/\{touser\}/g, touser || username);
  result = result.replace(/\{channel\}/g, channelName);

  // Variable {redes}
  const config = channelConfigs[channelName];
  if (result.includes('{redes}')) {
    const socials = formatSocials(config?.social_links || {});
    result = result.replace(/\{redes\}/g, socials || 'Sin redes configuradas');
  }

  // Variable {random}, {random:max}, {random:min-max}
  if (result.includes('{random')) {
    result = result.replace(/\{random:(\d+)-(\d+)\}/g, (_, min, max) => {
      return Math.floor(Math.random() * (parseInt(max) - parseInt(min) + 1)) + parseInt(min);
    });
    result = result.replace(/\{random:(\d+)\}/g, (_, max) => {
      return Math.floor(Math.random() * parseInt(max)) + 1;
    });
    result = result.replace(/\{random\}/g, () => {
      return Math.floor(Math.random() * 100) + 1;
    });
  }

  // Variable {count:nombre}
  if (result.includes('{count:')) {
    result = result.replace(/\{count:(\w+)\}/g, (match, name) => {
      const val = config?.counters?.[name.toLowerCase()];
      return val !== undefined ? val : '0';
    });
  }

  // Variables que requieren llamada a la API de Twitch
  if (result.includes('{game}') || result.includes('{title}') || result.includes('{uptime}')) {
    try {
      // Buscar el access token del canal
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const data = await res.json();
      const token = data?.[0]?.access_token;

      if (token) {
        const streamRes = await fetch(
          `https://api.twitch.tv/helix/streams?user_login=${channelName}`,
          { headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': process.env.TWITCH_CLIENT_ID || '' } }
        );
        const streamData = await streamRes.json();
        const stream = streamData?.data?.[0];

        if (stream) {
          result = result.replace(/\{game\}/g, stream.game_name || 'un juego');
          result = result.replace(/\{title\}/g, stream.title || 'sin título');
          // Calcular uptime
          const start = new Date(stream.started_at);
          const diff = Math.floor((Date.now() - start) / 1000);
          const h = Math.floor(diff / 3600);
          const m = Math.floor((diff % 3600) / 60);
          const uptime = h > 0 ? `${h}h ${m}m` : `${m}m`;
          result = result.replace(/\{uptime\}/g, uptime);
        } else {
          result = result.replace(/\{game\}/g, 'offline');
          result = result.replace(/\{title\}/g, 'sin stream');
          result = result.replace(/\{uptime\}/g, '0m');
        }
      }
    } catch(e) {
      result = result.replace(/\{game\}/g, '?').replace(/\{title\}/g, '?').replace(/\{uptime\}/g, '?');
    }
  }
  return result;
}
async function getMuffetResponse(channel, userMessage, username) {
  try {
    const config = channelConfigs[channel] || defaultConfig(channel);
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: config.bot_prompt },
        { role: 'user', content: `El usuario "${username}" dice: ${userMessage}` }
      ],
      max_tokens: 150,
      temperature: 0.85,
    });
    return completion.choices[0]?.message?.content || '¡Algo salió mal en la cueva! 🕷️';
  } catch (err) {
    console.error('Error Groq:', err.message);
    return '¡Las telarañas se enredaron, dearie! 🕷️';
  }
}

// ══════════════════════════════════════════
//  CLIENTE TMI PRINCIPAL (muffet_osoking)
// ══════════════════════════════════════════
let mainClient = null;

function createMainClient(channels) {
  const client = new tmi.Client({
    options: { debug: false },
    identity: { username: TWITCH_BOT_USERNAME, password: TWITCH_OAUTH_TOKEN },
    channels: channels,
  });
  return client;
}

// ══════════════════════════════════════════
//  HANDLER DE MENSAJES
// ══════════════════════════════════════════
function isMod(tags, channelName) {
  return tags.mod || tags.badges?.broadcaster === '1' || tags.username?.toLowerCase() === channelName.toLowerCase();
}

async function handleMessage(client, channel, tags, message, self) {
  if (self) return;

  const channelName = channel.replace('#', '').toLowerCase();
  const config = channelConfigs[channelName] || defaultConfig(channelName);
  const username = tags['display-name'] || tags.username;
  const msgLower = message.trim().toLowerCase();
  const firstWord = msgLower.split(' ')[0];
  const botName = TWITCH_BOT_USERNAME.toLowerCase();

  // Ignorar al bot
  if (username.toLowerCase() === botName) return;

  // ── Comandos de control (solo mods) ──
  if (firstWord === '!muffeton') {
    if (!isMod(tags, channelName)) return;
    muffetActiveMap[channelName] = true;
    let onMsg;
    if (config.on_off_ai !== false) {
      onMsg = await getMuffetResponse(channelName, 'Anuncia brevemente que acabas de activarte y estás lista para interactuar con el chat. Habla en primera persona según tu personalidad.', username);
    } else {
      onMsg = config.on_message || '¡La guardiana ha despertado! 🕷️ ¡Estoy de vuelta, dearies! 👑♥';
    }
    client.say(channel, onMsg);
    return;
  }
  if (firstWord === '!muffetoff') {
    if (!isMod(tags, channelName)) return;
    muffetActiveMap[channelName] = false;
    let offMsg;
    if (config.on_off_ai !== false) {
      offMsg = await getMuffetResponse(channelName, 'Anuncia brevemente que te vas a descansar y te despides del chat. Habla en primera persona según tu personalidad.', username);
    } else {
      offMsg = config.off_message || '¡La guardiana se va a descansar~ 🕷️ ¡Hasta pronto, dearies! ♥';
    }
    client.say(channel, offMsg);
    return;
  }
  if (firstWord === '!muffetstatus') {
    const active = muffetActiveMap[channelName] !== false;
    client.say(channel, active ? `🟢 La guardiana está activa~ 🕷️♥` : `🔴 La guardiana está descansando~ 🕷️ Usa !muffeton para despertarla`);
    return;
  }

  // ── Saludo nuevo viewer (siempre activo) ──
  if (!greetedMap[channelName]) greetedMap[channelName] = new Set();
  if (!greetedMap[channelName].has(username.toLowerCase())) {
    greetedMap[channelName].add(username.toLowerCase());
    setTimeout(async () => {
      try {
        const welcomeMsg = await getMuffetResponse(channelName, `Saluda brevemente a ${username} que acaba de llegar al canal por primera vez. Sé breve y usa tu personalidad.`, username);
        client.say(channel, welcomeMsg);
      } catch(e) {
        client.say(channel, `¡Bienvenid@ ${username}! 🎉`);
      }
    }, 2000);
  }

  // ── Si está en silencio ──
  if (muffetActiveMap[channelName] === false) return;

  // ── Moderación ──
  if (config.mod_enabled) {
    const isModOrBroadcaster = isMod(tags, channelName);
    const isSub = !!tags.subscriber || !!tags.badges?.subscriber;
    const isVIP = !!tags.badges?.vip;

    if (!isModOrBroadcaster) {
      if (config.banned_words?.length > 0) {
        if (config.banned_words.some(w => msgLower.includes(w.toLowerCase()))) {
          client.say(channel, `@${username} ${config.warn_message}`);
          return;
        }
      }
      if (!isSub && !isVIP) {
        const check = await checkMessageWithAI(message);
        if (check.flagged) {
          client.say(channel, `@${username} ${config.warn_message}`);
          return;
        }
      }
    }
  }

  // ── !titulo — cambiar título del stream ──
  if (firstWord === '!titulo' || firstWord === '!title') {
    if (!isMod(tags, channelName)) return;
    const newTitle = message.trim().slice(firstWord.length).trim();
    if (!newTitle) { client.say(channel, `@${username} Uso: !titulo Mi nuevo título 🕷️`); return; }
    if (newTitle.length > 140) { client.say(channel, `@${username} El título es muy largo, máximo 140 caracteres~ 🕷️`); return; }
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      const data = await res.json();
      const token = data?.[0]?.access_token;
      const twitchId = data?.[0]?.twitch_id;
      if (!token) { client.say(channel, `@${username} Sin token de Twitch~ 🕷️`); return; }
      const r = await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${twitchId}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': process.env.TWITCH_CLIENT_ID || '', 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle })
      });
      if (r.status === 204) client.say(channel, `✅ Título actualizado: "${newTitle}" 🕷️👑`);
      else client.say(channel, `@${username} Error al cambiar el título — intenta reconectar el dashboard~ 🕷️`);
    } catch(e) { client.say(channel, `@${username} Error al conectar con Twitch~ 🕷️`); }
    return;
  }

  // ── !juego — cambiar categoría del stream ──
  if (firstWord === '!juego' || firstWord === '!game') {
    if (!isMod(tags, channelName)) return;
    const gameName = message.trim().slice(firstWord.length).trim();
    if (!gameName) { client.say(channel, `@${username} Uso: !juego Minecraft 🕷️`); return; }
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      const data = await res.json();
      const token = data?.[0]?.access_token;
      const twitchId = data?.[0]?.twitch_id;
      if (!token) { client.say(channel, `@${username} Sin token de Twitch~ 🕷️`); return; }
      // Buscar el juego
      const searchRes = await fetch(`https://api.twitch.tv/helix/search/categories?query=${encodeURIComponent(gameName)}&first=1`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': process.env.TWITCH_CLIENT_ID || '' }
      });
      const searchData = await searchRes.json();
      const game = searchData?.data?.[0];
      if (!game) { client.say(channel, `@${username} No encontré ese juego, dearie~ 🕷️ Intenta con otro nombre`); return; }
      const r = await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${twitchId}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': process.env.TWITCH_CLIENT_ID || '', 'Content-Type': 'application/json' },
        body: JSON.stringify({ game_id: game.id })
      });
      if (r.status === 204) client.say(channel, `✅ Categoría cambiada a: ${game.name} 🎮🕷️`);
      else client.say(channel, `@${username} Error al cambiar la categoría~ 🕷️`);
    } catch(e) { client.say(channel, `@${username} Error al conectar con Twitch~ 🕷️`); }
    return;
  }

  // ── Sistema de puntos y niveles ──
  const pointsConfig = config.points_config || {};
  const pointsEnabled = pointsConfig.enabled !== false;

  if (pointsEnabled && !self) {
    // Dar XP por mensaje
    const isSub = !!tags.subscriber || !!tags.badges?.subscriber;
    const isVIP = !!tags.badges?.vip;
    const xpGain = isSub || isVIP ? (pointsConfig.xp_bonus || 2) : (pointsConfig.xp_per_message || 1);

    const viewerPoints = channelConfigs[channelName].viewer_points || {};
    const userLower = username.toLowerCase();
    const currentXP = viewerPoints[userLower] || 0;
    const newXP = currentXP + xpGain;

    // Verificar subida de nivel
    const levels = pointsConfig.levels || [{level:1,name:'Súbdito',xp:0},{level:2,name:'Caballero',xp:100},{level:3,name:'Noble',xp:300},{level:4,name:'Lord',xp:600},{level:5,name:'Rey',xp:1000}];
    const oldLevel = levels.filter(l => currentXP >= l.xp).pop();
    const newLevel = levels.filter(l => newXP >= l.xp).pop();

    if (newLevel && oldLevel && newLevel.level > oldLevel.level) {
      const emoji = pointsConfig.emoji || '🏆';
      setTimeout(() => client.say(channel, `🎉 ¡@${username} subió al nivel ${newLevel.level} — ${newLevel.name}! ${emoji}`), 1000);
    }

    // Guardar XP
    viewerPoints[userLower] = newXP;
    channelConfigs[channelName].viewer_points = viewerPoints;

    // Flush a Supabase cada 60 segundos
    if (!channelConfigs[channelName]._pointsFlushTimer) {
      channelConfigs[channelName]._pointsFlushTimer = setTimeout(async () => {
        channelConfigs[channelName]._pointsFlushTimer = null;
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
            method: 'PATCH',
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ viewer_points: channelConfigs[channelName].viewer_points })
          });
        } catch(e) {}
      }, 60000);
    }
  }

  // ── Comandos de puntos ──
  if (firstWord === '!puntos' || firstWord === '!xp' || firstWord === '!nivel' || firstWord === '!level') {
    const target = message.trim().split(' ')[1]?.replace('@','').toLowerCase() || username.toLowerCase();
    const viewerPoints = channelConfigs[channelName].viewer_points || {};
    const xp = viewerPoints[target] || 0;
    const pointsConfig = config.points_config || {};
    const levels = pointsConfig.levels || [{level:1,name:'Súbdito',xp:0}];
    const currentLevel = levels.filter(l => xp >= l.xp).pop() || levels[0];
    const nextLevel = levels.find(l => l.xp > xp);
    const emoji = pointsConfig.emoji || '🏆';
    const name = pointsConfig.name || 'puntos';
    const progress = nextLevel ? ` | Próximo nivel: ${nextLevel.xp - xp} ${name} más` : ' | ¡Nivel máximo!';
    client.say(channel, `${emoji} @${target} — Nivel ${currentLevel.level} (${currentLevel.name}) | ${xp} ${name}${progress} 🕷️`);
    return;
  }

  if (firstWord === '!top' || firstWord === '!ranking') {
    const viewerPoints = channelConfigs[channelName].viewer_points || {};
    const pointsConfig = config.points_config || {};
    const emoji = pointsConfig.emoji || '🏆';
    const top5 = Object.entries(viewerPoints).sort((a,b) => b[1]-a[1]).slice(0,5);
    if (!top5.length) { client.say(channel, `Aún no hay viewers con ${pointsConfig.name||'puntos'}~ 🕷️`); return; }
    const medals = ['🥇','🥈','🥉','4️⃣','5️⃣'];
    client.say(channel, `${emoji} Top 5: ${top5.map(([u,xp],i) => `${medals[i]} ${u}(${xp})`).join(' | ')} 🕷️`);
    return;
  }

  if (firstWord === '!dar' || firstWord === '!give') {
    if (!isMod(tags, channelName)) return;
    const parts = message.trim().split(' ');
    const amount = parseInt(parts[1]);
    const target = parts[2]?.replace('@','').toLowerCase();
    if (!amount || !target) { client.say(channel, `@${username} Uso: !dar 100 @usuario 🕷️`); return; }
    const viewerPoints = channelConfigs[channelName].viewer_points || {};
    viewerPoints[target] = (viewerPoints[target] || 0) + amount;
    channelConfigs[channelName].viewer_points = viewerPoints;
    const emoji = config.points_config?.emoji || '🏆';
    client.say(channel, `✅ @${target} recibió ${amount} ${emoji} de @${username} 🕷️`);
    fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewer_points: viewerPoints })
    }).catch(() => {});
    return;
  }

  // ── !clip ──
  if (firstWord === '!clip') {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      const data = await res.json();
      const token = data?.[0]?.access_token;
      const twitchId = data?.[0]?.twitch_id;
      if (!token) { client.say(channel, `@${username} Sin token de Twitch~ 🕷️`); return; }

      const clipRes = await fetch(`https://api.twitch.tv/helix/clips?broadcaster_id=${twitchId}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': process.env.TWITCH_CLIENT_ID || '' }
      });
      const clipData = await clipRes.json();

      if (clipData.data?.[0]?.edit_url) {
        const clipUrl = clipData.data[0].edit_url.replace('/edit', '');
        client.say(channel, `✂️ ¡Clip creado por @${username}! ${clipUrl} 🕷️`);
      } else {
        client.say(channel, `@${username} No se pudo crear el clip — ¿el stream está en vivo? 🕷️`);
      }
    } catch(e) {
      client.say(channel, `@${username} Error al crear el clip~ 🕷️`);
    }
    return;
  }

  // ── !random ──
  if (firstWord === '!random' || firstWord === '!dado' || firstWord === '!ruleta') {
    const parts = message.trim().split(' ').slice(1);
    const subCmd = parts[0]?.toLowerCase();

    // !random amor @usuario
    if (subCmd === 'amor' || subCmd === 'love') {
      const target = parts[1]?.replace('@','') || username;
      const pct = Math.floor(Math.random() * 101);
      const emoji = pct >= 80 ? '💕' : pct >= 50 ? '❤️' : pct >= 20 ? '💔' : '😬';
      client.say(channel, `${emoji} @${username} tiene un ${pct}% de amor por ${target} ${emoji}`);
      return;
    }

    // !random pick opcion1 opcion2 opcion3
    if (subCmd === 'pick' || subCmd === 'elige') {
      const options = parts.slice(1).filter(Boolean);
      if (options.length < 2) { client.say(channel, `@${username} Uso: !random pick opcion1 opcion2 opcion3 🕷️`); return; }
      const picked = options[Math.floor(Math.random() * options.length)];
      client.say(channel, `🎯 @${username} La ruleta eligió: ${picked} 🕷️`);
      return;
    }

    // !random 1 6 (entre dos números)
    if (parts.length >= 2 && !isNaN(parseInt(parts[0])) && !isNaN(parseInt(parts[1]))) {
      const min = parseInt(parts[0]);
      const max = parseInt(parts[1]);
      if (min >= max) { client.say(channel, `@${username} El primer número debe ser menor que el segundo~ 🕷️`); return; }
      const result = Math.floor(Math.random() * (max - min + 1)) + min;
      client.say(channel, `🎲 @${username} Número entre ${min} y ${max}: ${result} 🕷️`);
      return;
    }

    // !random 50 (entre 1 y X)
    if (parts.length === 1 && !isNaN(parseInt(parts[0]))) {
      const max = Math.abs(parseInt(parts[0]));
      const result = Math.floor(Math.random() * max) + 1;
      client.say(channel, `🎲 @${username} Número entre 1 y ${max}: ${result} 🕷️`);
      return;
    }

    // !random (entre 1 y 100)
    const result = Math.floor(Math.random() * 100) + 1;
    client.say(channel, `🎲 @${username} Número random: ${result} 🕷️`);
    return;
  }

  // ── Contadores ──
  // Uso: !deaths, !deaths +1, !deaths -1, !deaths reset, !deaths 5
  // Crear: !addcounter deaths, Borrar: !delcounter deaths
  if (firstWord === '!addcounter') {
    if (!isMod(tags, channelName)) return;
    const name = message.trim().split(' ')[1]?.toLowerCase();
    if (!name) { client.say(channel, `@${username} Uso: !addcounter nombre 🕷️`); return; }
    const counters = { ...(channelConfigs[channelName].counters || {}) };
    counters[name] = 0;
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ counters })
      });
      channelConfigs[channelName].counters = counters;
      client.say(channel, `✅ Contador !${name} creado (valor: 0) 🕷️`);
    } catch(e) { client.say(channel, `@${username} Error al crear contador 🕷️`); }
    return;
  }

  if (firstWord === '!delcounter') {
    if (!isMod(tags, channelName)) return;
    const name = message.trim().split(' ')[1]?.toLowerCase();
    if (!name) { client.say(channel, `@${username} Uso: !delcounter nombre 🕷️`); return; }
    const counters = { ...(channelConfigs[channelName].counters || {}) };
    if (counters[name] === undefined) { client.say(channel, `@${username} El contador !${name} no existe~ 🕷️`); return; }
    delete counters[name];
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ counters })
      });
      channelConfigs[channelName].counters = counters;
      client.say(channel, `🗑️ Contador !${name} eliminado 🕷️`);
    } catch(e) { client.say(channel, `@${username} Error al eliminar contador 🕷️`); }
    return;
  }

  // Usar contador existente
  const counterName = firstWord.startsWith('!') ? firstWord.slice(1).toLowerCase() : null;
  const counters = channelConfigs[channelName]?.counters || {};
  if (counterName && counters[counterName] !== undefined) {
    if (!isMod(tags, channelName) && message.trim().split(' ').length > 1) return; // Solo mods pueden modificar
    const parts = message.trim().split(' ');
    const arg = parts[1]?.toLowerCase();
    let value = counters[counterName];

    if (!arg) {
      // Solo mostrar el valor
      client.say(channel, `📊 ${counterName}: ${value} 🕷️`);
    } else if (arg === '+1' || arg === 'add' || arg === '+') {
      value++;
      client.say(channel, `📊 ${counterName}: ${value} (+1) 🕷️`);
    } else if (arg === '-1' || arg === 'sub' || arg === '-') {
      value = Math.max(0, value - 1);
      client.say(channel, `📊 ${counterName}: ${value} (-1) 🕷️`);
    } else if (arg === 'reset' || arg === '0') {
      value = 0;
      client.say(channel, `🔄 ${counterName} reiniciado a 0 🕷️`);
    } else if (!isNaN(parseInt(arg))) {
      value = parseInt(arg);
      client.say(channel, `📊 ${counterName}: ${value} 🕷️`);
    } else {
      client.say(channel, `📊 ${counterName}: ${value} 🕷️`);
    }

    // Guardar nuevo valor
    const newCounters = { ...counters, [counterName]: value };
    channelConfigs[channelName].counters = newCounters;
    fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ counters: newCounters })
    }).catch(() => {});
    return;
  }

  // ── Gestión de comandos desde el chat ──
  if (firstWord === '!addcmd' || firstWord === '!editcmd') {
    if (!isMod(tags, channelName)) return;
    const parts = message.trim().split(' ');
    const trigger = parts[1]?.toLowerCase();
    const response = parts.slice(2).join(' ').trim();
    if (!trigger || !response) {
      client.say(channel, `@${username} Uso: !addcmd !comando respuesta del bot 🕷️`);
      return;
    }
    if (!trigger.startsWith('!')) {
      client.say(channel, `@${username} El comando debe empezar con ! dearie~ 🕷️`);
      return;
    }
    // Guardar en Supabase
    const config = channelConfigs[channelName];
    const commands = { ...(config.commands || {}) };
    commands[trigger] = { response, perms: ['everyone'] };
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands })
      });
      channelConfigs[channelName].commands = commands;
      const action = firstWord === '!addcmd' ? 'creado' : 'editado';
      client.say(channel, `✅ Comando ${trigger} ${action} correctamente~ 🕷️`);
    } catch(e) {
      client.say(channel, `@${username} Error al guardar el comando 🕷️`);
    }
    return;
  }

  if (firstWord === '!delcmd') {
    if (!isMod(tags, channelName)) return;
    const trigger = message.trim().split(' ')[1]?.toLowerCase();
    if (!trigger) {
      client.say(channel, `@${username} Uso: !delcmd !comando 🕷️`);
      return;
    }
    const config = channelConfigs[channelName];
    const commands = { ...(config.commands || {}) };
    if (!commands[trigger]) {
      client.say(channel, `@${username} El comando ${trigger} no existe, dearie~ 🕷️`);
      return;
    }
    delete commands[trigger];
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands })
      });
      channelConfigs[channelName].commands = commands;
      client.say(channel, `🗑️ Comando ${trigger} eliminado~ 🕷️`);
    } catch(e) {
      client.say(channel, `@${username} Error al eliminar el comando 🕷️`);
    }
    return;
  }

  if (firstWord === '!cmds' || firstWord === '!comandos') {
    const config = channelConfigs[channelName];
    const cmds = Object.keys(config.commands || {}).join(' • ');
    client.say(channel, cmds ? `📋 Comandos: ${cmds} 🕷️` : `No hay comandos configurados aún~ 🕷️`);
    return;
  }

  // ── Sorteo ──
  if (firstWord === '!sorteo') {
    const subCmd = msgLower.split(' ')[1];
    if (subCmd === 'crear' || subCmd === 'start') {
      if (!isMod(tags, channelName)) return;
      const prize = message.trim().split(' ').slice(2).join(' ') || 'Sorpresa';
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
          method: 'PATCH',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raffle_active: { active: true, prize, participants: [], started_at: new Date().toISOString() } })
        });
        const joinCmd = channelConfigs[channelName]?.raffle_settings?.join_cmd || '!entrar';
        client.say(channel, `🎉 ¡Sorteo iniciado! Premio: ${prize} 🏆 Escribe ${joinCmd} para participar~ 🕷️`);
      } catch(e) { client.say(channel, '⚠️ Error al iniciar el sorteo'); }
      return;
    }
    if (subCmd === 'end' || subCmd === 'fin') {
      if (!isMod(tags, channelName)) return;
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
        const data = await res.json();
        const raffle = data?.[0]?.raffle_active || {};
        const participants = raffle.participants || [];
        if (!participants.length) { client.say(channel, '⚠️ No hay participantes en el sorteo~ 🕷️'); return; }
        const winner = participants[Math.floor(Math.random() * participants.length)];
        await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
          method: 'PATCH',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raffle_active: { active: false, prize: raffle.prize, winner, participants: [] } })
        });
        const winnerMsg = await getMuffetResponse(channelName, `¡Anuncia emocionado que @${winner} ganó el sorteo! El premio es: ${raffle.prize}. Sé entusiasta y usa tu personalidad.`, winner);
        client.say(channel, winnerMsg);
      } catch(e) { client.say(channel, '⚠️ Error al terminar el sorteo'); }
      return;
    }
    if (subCmd === 'cancel' || subCmd === 'cancelar') {
      if (!isMod(tags, channelName)) return;
      await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raffle_active: { active: false } })
      });
      client.say(channel, '❌ Sorteo cancelado~ 🕷️');
      return;
    }
    if (subCmd === 'info') {
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
        const data = await res.json();
        const raffle = data?.[0]?.raffle_active || {};
        if (!raffle.active) { client.say(channel, '🎉 No hay sorteo activo~ 🕷️'); return; }
        client.say(channel, `🎉 Sorteo activo | Premio: ${raffle.prize} | Participantes: ${(raffle.participants||[]).length} 🕷️`);
      } catch(e) {}
      return;
    }
  }

  // ── Entrar al sorteo ──
  const raffleConfig = channelConfigs[channelName];
  const joinCmd = raffleConfig?.raffle_settings?.join_cmd || '!entrar';
  if (firstWord === joinCmd || firstWord === '!entrar') {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      const data = await res.json();
      const raffle = data?.[0]?.raffle_active || {};
      if (!raffle.active) return;

      const participants = raffle.participants || [];
      if (participants.includes(username)) { client.say(channel, `@${username} ¡Ya estás participando, dearie! 🕷️`); return; }

      // Verificar permisos
      const allowed = raffleConfig?.raffle_settings?.allowed || ['everyone'];
      if (!allowed.includes('everyone')) {
        const isSub = !!tags.subscriber || !!tags.badges?.subscriber;
        const isVIP = !!tags.badges?.vip;
        const isModUser = isMod(tags, channelName);
        const canJoin = (allowed.includes('sub') && isSub) || (allowed.includes('vip') && isVIP) || (allowed.includes('mod') && isModUser);
        if (!canJoin) {
          const reqLabels = { sub:'suscriptores', vip:'VIPs', mod:'moderadores' };
          const req = allowed.map(p => reqLabels[p] || p).join(' y ');
          client.say(channel, `@${username} Este sorteo es solo para ${req}~ 🕷️`);
          return;
        }
      }

      // Agregar entradas según multiplicador
      const isSub = !!tags.subscriber || !!tags.badges?.subscriber;
      const isVIP = !!tags.badges?.vip;
      const isModUser = isMod(tags, channelName);
      const settings = raffleConfig?.raffle_settings || {};
      let entries = settings.entries_everyone || 1;
      if (isSub) entries = settings.entries_sub || 2;
      if (isVIP) entries = Math.max(entries, settings.entries_vip || 2);
      if (isModUser) entries = Math.max(entries, settings.entries_mod || 1);

      // Agregar múltiples entradas
      for (let i = 0; i < entries; i++) participants.push(username);

      await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raffle_active: { ...raffle, participants } })
      });
      const uniqueCount = [...new Set(participants)].length;
      const entryMsg = entries > 1 ? ` (x${entries} entradas)` : '';
      client.say(channel, `✅ @${username} ¡Entraste al sorteo!${entryMsg} Somos ${uniqueCount} participantes 🎉🕷️`);
    } catch(e) {}
    return;
  }

  // ── !redes automático ──
  if (firstWord === '!redes') {
    const socials = formatSocials(config?.social_links || {});
    if (socials) {
      client.say(channel, `🌐 Redes de ${channelName}: ${socials} 🕷️♥`);
    } else if (config?.commands?.['!redes']) {
      const cmd = config.commands['!redes'];
      const response = typeof cmd === 'object' ? cmd.response : cmd;
      client.say(channel, response);
    } else {
      client.say(channel, `@${username} No hay redes configuradas aún~ 🕷️`);
    }
    return;
  }

  if (firstWord === '!ask' || firstWord === '!pregunta') {
    if (!config.ai_enabled) { client.say(channel, `@${username} ¡La IA está descansando, dearie! 🕷️`); return; }
    const question = message.trim().slice(firstWord.length).trim();
    if (!question) { client.say(channel, `¡${username}, dearie! Escribe: !ask ¿tu pregunta? 🕷️`); return; }
    client.say(channel, `@${username} ${await getMuffetResponse(channelName, question, username)}`);
    return;
  }

  // ── Comandos dinámicos ──
  if (config.commands?.[firstWord]) {
    trackCommandUse(channelName, firstWord);
    const cmd = config.commands[firstWord];
    const response = typeof cmd === 'object' ? cmd.response : cmd;
    const perms = typeof cmd === 'object' && cmd.perms ? cmd.perms : ['everyone'];

    const isBroadcaster = tags.badges?.broadcaster === '1' || tags.username?.toLowerCase() === channelName;
    const isModUser     = tags.mod || isBroadcaster;
    const isVIP         = !!tags.badges?.vip;
    const isSub         = !!tags.subscriber || !!tags.badges?.subscriber;

    const canUse = perms.includes('everyone') || isModUser ||
      (perms.includes('broadcaster') && isBroadcaster) ||
      (perms.includes('vip') && isVIP) ||
      (perms.includes('sub') && isSub);

    if (!canUse) return;

    const args = message.trim().split(' ').slice(1);
    const touser = args[0] ? args[0].replace('@', '') : username;
    const resolved = await resolveVariables(response, channelName, username, touser);
    client.say(channel, resolved);
    return;
  }

  // ── Menciones al bot directamente ──
  const botUsername = (channelConfigs[channelName]?.custom_bot_username || TWITCH_BOT_USERNAME).toLowerCase();
  if (msgLower.includes(`@${botUsername}`) && !msgLower.startsWith('!')) {
    if (!config.ai_enabled) return;
    const question = message.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim();
    client.say(channel, `@${username} ${await getMuffetResponse(channelName, question || '¡Hola!', username)}`);
    return;
  }
}

// ══════════════════════════════════════════
//  EVENTOS ESPECIALES
// ══════════════════════════════════════════
function setupEvents(client) {
  client.on('message', (channel, tags, message, self) => handleMessage(client, channel, tags, message, self));

  client.on('raided', (channel, username, viewers) => {
    client.say(channel, `¡¡RAID!! 🕷️👑 ¡${username} trae ${viewers} almas nuevas! ¡BIENVENIDOS, DEARIES! ♥♥♥`);
  });
  client.on('subscription', (channel, username) => {
    client.say(channel, `¡¡${username} se suscribió!! 🕷️ ¡Gracias dearie! 👑♥`);
  });
  client.on('resub', (channel, username, months) => {
    client.say(channel, `¡¡${username} lleva ${months} meses!! 🕷️ ¡Eres de los más leales, dearie! 👑♥`);
  });
  client.on('subgift', (channel, username, recipient) => {
    client.say(channel, `¡¡${username} le regaló sub a ${recipient}!! 🕷️ ¡Qué generoso/a! 👑♥`);
  });
}

// ══════════════════════════════════════════
//  CLIENTES PERSONALIZADOS POR CANAL (Plan Pro)
// ══════════════════════════════════════════
let customClients = {}; // { 'canal': tmiClient }

async function setupCustomBots() {
  for (const [ch, config] of Object.entries(channelConfigs)) {
    if (config.plan === 'pro' && config.custom_bot_username && config.custom_bot_token) {
      // Si ya tiene cliente y es el mismo bot, skip
      if (customClients[ch]) continue;
      try {
        const client = new tmi.Client({
          options: { debug: false },
          identity: { username: config.custom_bot_username, password: config.custom_bot_token },
          channels: [`#${ch}`],
        });
        setupEvents(client);
        await client.connect();
        customClients[ch] = client;
        console.log(`🤖 Bot personalizado conectado: ${config.custom_bot_username} → #${ch}`);
        // Salir del canal principal para no duplicar mensajes
        try { await mainClient.part(`#${ch}`); } catch(e) {}
      } catch (err) {
        console.error(`Error conectando bot personalizado para ${ch}:`, err.message);
      }
    }
  }
}

// ══════════════════════════════════════════
//  ARRANQUE PRINCIPAL
// ══════════════════════════════════════════
async function start() {
  console.log('🐻🕷️ MuffetBot Multi-Canal iniciando...');

  const channels = await loadAllChannels();

  if (channels.length === 0) {
    console.log('⚠️ No hay canales aprobados. Esperando...');
  }

  // Asegurar que el canal principal siempre esté
  const mainChannel = process.env.TWITCH_CHANNEL || 'elosoking1';
  if (!channels.includes(mainChannel)) channels.push(mainChannel);

  mainClient = createMainClient(channels);
  setupEvents(mainClient);

  await mainClient.connect();
  console.log(`🐻🕷️ Conectado a ${channels.length} canales: ${channels.join(', ')}`);

  // Configurar bots personalizados para usuarios Pro
  await setupCustomBots();

  // Auto mensajes por canal con timer individual por mensaje
  const autoMsgIntervals = {};

  function scheduleAutoMessages() {
    for (const [ch, config] of Object.entries(channelConfigs)) {
      if (!config.auto_messages?.length) continue;
      if (autoMsgIntervals[ch]?.length) continue; // Ya tiene timers activos, no recrear
      autoMsgIntervals[ch] = [];

      config.auto_messages.forEach(msg => {
        // Soportar formato antiguo (string) y nuevo (objeto)
        const text     = typeof msg === 'object' ? msg.text     : msg;
        const type     = typeof msg === 'object' ? msg.type     : 'fixed';
        const interval = typeof msg === 'object' ? msg.interval : (config.auto_message_interval || 20);
        const intervalMs = Math.max(interval, 5) * 60 * 1000;
        console.log(`⏰ Timer: #${ch} → "${text.substring(0,30)}..." cada ${Math.max(interval,5)} min`);

        const timer = setInterval(async () => {
          if (muffetActiveMap[ch] === false) return;
          const client = customClients[ch] || mainClient;
          try {
            if (type === 'ai') {
              const chConfig = channelConfigs[ch];
              const aiMsg = await groq.chat.completions.create({
                model: 'llama-3.1-8b-instant',
                messages: [
                  { role: 'system', content: chConfig.bot_prompt },
                  { role: 'user', content: `Escribe un mensaje corto para el chat de Twitch sobre este tema: "${text}". Máximo 1 oración, con tu personalidad característica.` }
                ],
                max_tokens: 100,
                temperature: 0.9,
              });
              const aiText = aiMsg.choices[0]?.message?.content || text;
              console.log(`📨 Auto msg IA → #${ch}: ${aiText.substring(0,50)}`);
              client.say(`#${ch}`, aiText).catch(e => console.error(`❌ Error say #${ch}:`, e.message));
            } else {
              console.log(`📨 Auto msg → #${ch}: ${text.substring(0,50)}`);
              client.say(`#${ch}`, text).catch(e => console.error(`❌ Error say #${ch}:`, e.message));
            }
          } catch(e) {
            console.error(`❌ Error auto msg #${ch}:`, e.message);
            client.say(`#${ch}`, text).catch(e2 => console.error(`❌ Fallback error:`, e2.message));
          }
        }, intervalMs);

        autoMsgIntervals[ch].push(timer);
      });
    }
  }

  scheduleAutoMessages();

  // Recargar config cada 2 minutos
  setInterval(async () => {
    await loadAllChannels();
    await setupCustomBots();
    scheduleAutoMessages();
    const currentChannels = mainClient.getChannels().map(c => c.replace('#',''));
    const allChannels = Object.keys(channelConfigs);
    for (const ch of allChannels) {
      if (!currentChannels.includes(ch) && !customClients[ch]) {
        try { await mainClient.join(ch); console.log(`✅ Nuevo canal unido: ${ch}`); } catch(e) {}
      }
    }
  }, 2 * 60 * 1000);
}

start().catch(console.error);
