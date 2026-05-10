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
        custom_bot_username: s.custom_bot_username || null,
        custom_bot_token:    s.custom_bot_token    || null,
      };
      if (muffetActiveMap[ch] === undefined) muffetActiveMap[ch] = true;
      if (!greetedMap[ch]) greetedMap[ch] = new Set();
    });

    console.log(`🐻🕷️ Config cargada para ${streamers.length} canales:`, streamers.map(s => s.twitch_username).join(', '));
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

// ── Resolver variables dinámicas ──
async function resolveVariables(text, channelName, username, touser) {
  let result = text;
  result = result.replace(/\{user\}/g, username);
  result = result.replace(/\{touser\}/g, touser || username);
  result = result.replace(/\{channel\}/g, channelName);

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
const welcomePhrases = [
  (u) => `¡${u} llegó al canal! 🕷️ ¡Bienvenido/a, dearie! ♥`,
  (u) => `¡Una nueva alma! ¡Bienvenid@ ${u}! 🕷️♥`,
  (u) => `¡${u} entró al chat! 🕷️ ¡Aquí nadie se va sin disfrutar, dearie! ♥`,
  (u) => `¡${u}, un nuevo súbdito! 👑 ¡Tengo té para ti! 🕷️♥`,
];

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
    client.say(channel, `¡La guardiana ha despertado! 🕷️ ¡Estoy de vuelta, dearies! 👑♥`);
    return;
  }
  if (firstWord === '!muffetoff') {
    if (!isMod(tags, channelName)) return;
    muffetActiveMap[channelName] = false;
    client.say(channel, `¡La guardiana se va a descansar~ 🕷️ ¡Hasta pronto, dearies! ♥`);
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
    const phrase = welcomePhrases[Math.floor(Math.random() * welcomePhrases.length)];
    setTimeout(() => client.say(channel, phrase(username)), 2000);
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

  // ── Menciones ──
  if ((msgLower.includes('rey oso') || msgLower.includes('elosoking')) && !msgLower.startsWith('!')) {
    if (!config.ai_enabled) return;
    client.say(channel, `@${username} ${await getMuffetResponse(channelName, message, username)}`);
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
    // Limpiar timers existentes
    for (const timers of Object.values(autoMsgIntervals)) {
      timers.forEach(t => clearInterval(t));
    }
    for (const ch of Object.keys(autoMsgIntervals)) delete autoMsgIntervals[ch];

    for (const [ch, config] of Object.entries(channelConfigs)) {
      if (!config.auto_messages?.length) continue;
      autoMsgIntervals[ch] = [];

      config.auto_messages.forEach(msg => {
        // Soportar formato antiguo (string) y nuevo (objeto)
        const text     = typeof msg === 'object' ? msg.text     : msg;
        const type     = typeof msg === 'object' ? msg.type     : 'fixed';
        const interval = typeof msg === 'object' ? msg.interval : (config.auto_message_interval || 20);
        const intervalMs = Math.max(interval, 5) * 60 * 1000;

        const timer = setInterval(async () => {
          if (muffetActiveMap[ch] === false) return;
          const client = customClients[ch] || mainClient;
          try {
            if (type === 'ai') {
              // Muffet inventa el mensaje basado en el tema
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
              client.say(`#${ch}`, aiText).catch(() => {});
            } else {
              client.say(`#${ch}`, text).catch(() => {});
            }
          } catch(e) {
            client.say(`#${ch}`, text).catch(() => {});
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
