const tmi  = require('tmi.js');
const Groq = require('groq-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');

// ══════════════════════════════════════════
//  CONFIGURACIÓN GLOBAL
// ══════════════════════════════════════════
const TWITCH_BOT_USERNAME = process.env.TWITCH_BOT_USERNAME;
const TWITCH_OAUTH_TOKEN  = process.env.TWITCH_OAUTH_TOKEN;
const GROQ_API_KEY        = process.env.GROQ_API_KEY;
const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_KEY        = process.env.SUPABASE_KEY;
const BOT_SECRET          = process.env.BOT_SECRET || 'muffetbot-internal-2026';
const BOT_PORT            = process.env.PORT || process.env.BOT_PORT || 3001;

const groq = new Groq({ apiKey: GROQ_API_KEY });
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// ══════════════════════════════════════════
//  CONFIG POR CANAL (cargada desde Supabase)
// ══════════════════════════════════════════
let channelConfigs = {}; // { 'elosoking1': { bot_prompt, commands, ... } }
let muffetActiveMap = {}; // { 'elosoking1': true/false }
let muffetSilentMap = {}; // { 'elosoking1': true/false } — modo silencio
let muffetSilentTimers = {}; // auto-desactivar silencio tras 6h por si se olvida
let emojiAutoTimers = {}; // { 'elosoking1': intervalId } — reto automático cada X minutos
let raidSuppressGreetings = {}; // { 'elosoking1': timestamp } — suprimir saludos individuales tras una raid
let greetedMap = {}; // { 'elosoking1': Set() }
let activeEmojiGames = {}; // { 'elosoking1': { emojis, title, startedAt, hintsUsed } }
let emojiGameCooldowns = {}; // { 'elosoking1': timestamp } — evitar spam del comando
let emojiGameTimers = {}; // { 'elosoking1': timeoutId } — tiempo límite para revelar respuesta
let emojiGameStreaks = {}; // { 'elosoking1': { 'username': count } } — racha de victorias consecutivas
const BOT_START_TIME = Date.now(); // Para ignorar saludos al arrancar
const chatViewers = {}; // { 'elosoking1': Set() } — viewers que han escrito en el chat

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
        mod_config:    s.mod_config    || {},
        banned_words:  s.banned_words  || [],
        warn_message:  s.warn_message  || '⚠️ Cuidado, dearie~ 🕷️',
        plan:          s.plan          || 'free',
        on_off_ai:     s.on_off_ai     !== false,
        on_message:    s.on_message    || null,
        off_message:   s.off_message   || null,
        counters:           s.counters           || {},
        points_config:      s.points_config      || {},
        viewer_points:      (() => {
          const vp = s.viewer_points || {};
          const levels = s.points_config?.levels || [{level:1,xp:0},{level:2,xp:100},{level:3,xp:300},{level:4,xp:600},{level:5,xp:1000}];
          // Preservar _level guardados en memoria (no sobreescribir con reload)
          const existing = channelConfigs[ch]?.viewer_points || {};
          Object.keys(existing).filter(k => k.endsWith('_level')).forEach(k => {
            vp[k] = existing[k];
          });
          // Inicializar _level para usuarios que no lo tengan
          Object.keys(vp).filter(k => !k.endsWith('_level')).forEach(user => {
            if (!vp[user + '_level']) {
              const xp = vp[user] || 0;
              const lvl = levels.filter(l => xp >= l.xp).pop();
              if (lvl) vp[user + '_level'] = lvl.level;
            }
          });
          return vp;
        })(),
        social_links:       s.social_links       || {},
        raffle_settings:    s.raffle_settings    || {},
        system_commands:    s.system_commands    || {},
        primerin_config:    s.primerin_config    || {},
        live_announcement:  s.live_announcement  || { enabled: false },
        youtube_music_config: s.youtube_music_config || {},
        custom_bot_username: s.custom_bot_username || null,
        custom_bot_token:    s.custom_bot_token    || null,
      };
      if (muffetActiveMap[ch] === undefined) muffetActiveMap[ch] = s.on_off_ai !== false;
      if (!greetedMap[ch]) {
        // Restaurar lista de saludados desde Supabase — sobrevive reinicios del bot
        greetedMap[ch] = new Set(Array.isArray(s.greeted_users) ? s.greeted_users : []);
      }
      // Pre-marcar al broadcaster para que nunca lo salude
      greetedMap[ch].add(ch.toLowerCase());
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
  } catch (err) {
    
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
    .filter(([k,v]) => v && k !== 'accent_color')
    .map(([k,v]) => `${icons[k]||'🔗'} ${labels[k]||k}: ${v}`)
    .join(' | ');
}

// ── Resolver variables dinámicas ──
// ── TWITCH APP TOKEN ──
let twitchAppToken = null;
let twitchAppTokenExpiry = 0;

async function getTwitchAppToken() {
  if (twitchAppToken && Date.now() < twitchAppTokenExpiry) return twitchAppToken;
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`
    });
    const data = await res.json();
    twitchAppToken = data.access_token;
    twitchAppTokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
    console.log('[Twitch] App token obtenido ✅');
    return twitchAppToken;
  } catch(e) {
    console.error('[Twitch] Error obteniendo app token:', e.message);
    return null;
  }
}

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

  // Variable {randomuser} — viewer aleatorio del chat
  if (result.includes('{randomuser}')) {
    const viewers = Array.from(chatViewers[channelName] || [])
      .filter(v => v !== username.toLowerCase() && v !== TWITCH_BOT_USERNAME?.toLowerCase());
    const randomViewer = viewers.length > 0
      ? viewers[Math.floor(Math.random() * viewers.length)]
      : 'alguien';
    result = result.replace(/\{randomuser\}/g, randomViewer);
  }

  // Variable {randomlist[op1;op2;op3]} — elige una opción aleatoria
  if (result.includes('{randomlist[')) {
    result = result.replace(/\{randomlist\[([^\]]+)\]\}/g, (match, list) => {
      const options = list.split(';').map(o => o.trim()).filter(Boolean);
      if (!options.length) return match;
      return options[Math.floor(Math.random() * options.length)];
    });
  }
  // Variable {game:usuario} — juego que está jugando otro canal
  // Primero resolver {touser} dentro de {game:}
  if (result.includes('{game:')) {
    result = result.replace(/\{game:\{touser\}\}/g, `{game:${touser || username}}`);
    const matches = [...result.matchAll(/\{game:([^}]+)\}/g)];
    for (const match of matches) {
      const targetUser = match[1].toLowerCase().replace('@','').replace(/\s+/g,'').trim();
      try {
        const token = await getTwitchAppToken();
        if (token) {
          const userRes = await fetch(
            `https://api.twitch.tv/helix/users?login=${targetUser}`,
            { headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': process.env.TWITCH_CLIENT_ID || '' } }
          );
          const userData2 = await userRes.json();
          const userId = userData2?.data?.[0]?.id;
          let game = 'un juego';
          if (userId) {
            const channelRes = await fetch(
              `https://api.twitch.tv/helix/channels?broadcaster_id=${userId}`,
              { headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': process.env.TWITCH_CLIENT_ID || '' } }
            );
            const channelData = await channelRes.json();
            game = channelData?.data?.[0]?.game_name || 'un juego';
          }
          result = result.replace(match[0], game);
        } else {
          result = result.replace(match[0], 'un juego');
        }
      } catch(e) {
        console.error('[game:var] error:', e.message); // mantener este
        result = result.replace(match[0], 'un juego');
      }
    }
  }

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
// ── Sistema de cooldowns y anti-spam ──
const userCooldowns    = {}; // { 'channel_user': timestamp } — cooldown por usuario en comandos
const botMsgCount      = {}; // { channelName: [timestamps] } — mensajes por minuto
const GLOBAL_COOLDOWN  = 3000;  // 3s entre respuestas automáticas
const CMD_COOLDOWN     = 30000; // 30s por usuario en comandos IA
const MAX_PER_MINUTE   = 8;     // máximo mensajes del bot por minuto
let lastBotMsg         = {};    // { channelName: timestamp } — último mensaje global

function canBotSpeak(channelName, isConversation = false) {
  const now = Date.now();
  // Limpiar mensajes viejos
  if (!botMsgCount[channelName]) botMsgCount[channelName] = [];
  botMsgCount[channelName] = botMsgCount[channelName].filter(t => now - t < 60000);

  // Conversaciones directas — solo verificar límite por minuto
  if (isConversation) {
    return botMsgCount[channelName].length < MAX_PER_MINUTE;
  }

  // Cooldown global entre respuestas automáticas
  if (lastBotMsg[channelName] && now - lastBotMsg[channelName] < GLOBAL_COOLDOWN) return false;
  // Límite por minuto
  return botMsgCount[channelName].length < MAX_PER_MINUTE;
}

function registerBotMsg(channelName) {
  const now = Date.now();
  if (!botMsgCount[channelName]) botMsgCount[channelName] = [];
  botMsgCount[channelName].push(now);
  lastBotMsg[channelName] = now;
}

function hasUserCooldown(channelName, username) {
  const key = `${channelName}_${username}`;
  return userCooldowns[key] && Date.now() - userCooldowns[key] < CMD_COOLDOWN;
}

function setUserCooldown(channelName, username) {
  userCooldowns[`${channelName}_${username}`] = Date.now();
}

function getCooldownRemaining(channelName, username) {
  const key = `${channelName}_${username}`;
  if (!userCooldowns[key]) return 0;
  return Math.ceil((CMD_COOLDOWN - (Date.now() - userCooldowns[key])) / 1000);
}

// Wrapper para client.say con registro
function botSay(client, channel, message, isConversation = false) {
  const ch = channel.replace('#','');
  if (!canBotSpeak(ch, isConversation)) return false;
  client.say(channel, message).catch(() => {});
  registerBotMsg(ch);
  return true;
}
function isSysCmdEnabled(channelName, cmdId) {
  const sys = channelConfigs[channelName]?.system_commands || {};
  return sys[cmdId] !== false; // activo por defecto
}

function isPro(channelName) {
  return channelConfigs[channelName]?.plan === 'pro';
}

function proOnly(client, channel, username) {
  client.say(channel, `@${username} Este comando es exclusivo del plan Pro~ Visita muffet-dashboard.onrender.com/plans para más info 🕷️⭐`);
}

// ── Bots conocidos a ignorar ──
const KNOWN_BOTS = new Set([
  'streamelements','nightbot','fossabot','moobot','streamlabs','wizebot',
  'botisimo','coebot','deepbot','phantombot','stay_hydrated_bot','sery_bot',
  'electricallongboard','commanderroot','anotherttvviewer','logviewer',
  'streamholics','kofistreambot','lurxx','twitchprimereminder','streamlootsbot',
]);

function isKnownBot(tags, username) {
  const user = username.toLowerCase();
  if (KNOWN_BOTS.has(user)) return true;
  // Bots del ecosistema MuffetBot
  if (Object.values(channelConfigs).some(c => c.custom_bot_username?.toLowerCase() === user)) return true;
  // Bot principal de MuffetBot
  if (user === TWITCH_BOT_USERNAME?.toLowerCase()) return true;
  return false;
}

// ── Historial de conversación por canal ──
const chatHistory = {}; // { channelName: [{role, content}] }
const MAX_HISTORY = 10;

function addToHistory(channelName, role, content) {
  if (!chatHistory[channelName]) chatHistory[channelName] = [];
  chatHistory[channelName].push({ role, content });
  if (chatHistory[channelName].length > MAX_HISTORY) {
    chatHistory[channelName].shift();
  }
}

// ── Generar reto de Emoji Game con IA — llamada aislada, sin tocar el historial de chat ──
const usedEmojiAnswers = {}; // { channelName: Set(títulos ya usados en esta sesión) } — evitar repetir

async function generateEmojiChallenge(channelName, category, _isRetry = false) {
  // El bot elige al azar el subgénero y la época — evita que la IA repita siempre los mismos títulos famosos
  const generosPelicula = ['acción', 'terror', 'comedia', 'ciencia ficción', 'animada (cualquier estudio)', 'fantasía', 'aventura', 'crimen/thriller', 'romance', 'superhéroes', 'anime (película)'];
  const generosSerie = ['drama', 'comedia/sitcom', 'ciencia ficción', 'anime', 'crimen', 'fantasía', 'animada para adultos', 'thriller', 'teen/juvenil'];
  const generosJuego = ['plataformas retro', 'shooter', 'RPG', 'aventura', 'terror', 'deportes/carreras', 'indie famoso', 'mundo abierto', 'peleas', 'battle royale/multijugador', 'nintendo clásico'];
  const epocas = ['de los 80s o 90s', 'de los 2000s', 'de los 2010s', 'reciente (últimos 5 años)', 'de cualquier época'];

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const epoca = pick(epocas);

  const categoryPrompts = {
    pelicula:   `una película muy conocida del género ${pick(generosPelicula)}, ${epoca}`,
    serie:      `una serie de TV muy conocida del género ${pick(generosSerie)}, ${epoca}`,
    videojuego: `un videojuego muy conocido del tipo ${pick(generosJuego)}, ${epoca}`,
  };
  const resolvedCategory = category === 'random' || !categoryPrompts[category]
    ? pick(['pelicula', 'serie', 'videojuego'])
    : category;
  const categoryText = categoryPrompts[resolvedCategory];

  if (!usedEmojiAnswers[channelName]) usedEmojiAnswers[channelName] = new Set();
  const usedList = Array.from(usedEmojiAnswers[channelName]).slice(-25).join(', ');

  const prompt = `Vas a generar un reto de adivinanza con emojis para un juego de chat de Twitch.

PASO 1 (no lo muestres en la respuesta): Piensa en ${categoryText}. Debe ser popular y reconocible, pero NO elijas la opción más obvia y famosa del género — elige entre las 20 más conocidas, no siempre la #1.

PASO 2 (no lo muestres): Identifica 4-6 elementos ÚNICOS y DISTINTIVOS de ESE título específico — pueden ser objetos icónicos de la trama, personajes reconocibles, el escenario particular, o eventos clave de la historia. NO uses elementos genéricos que aplican a cualquier película del mismo género (ej. para una película de princesas, NO uses corona/diamante/princesa genéricos — en su lugar usa el elemento ÚNICO de esa historia: para Frozen serían ❄️🧊⛄, para Cenicienta sería 👠🎃🕛, para La Bella y la Bestia sería 🌹🕯️).
PROHIBIDO usar como relleno genérico: 👑💎🔥 a menos que sean literalmente el objeto central de la trama (ej. el anillo en El Señor de los Anillos).

PASO 3: Verifica que cada emoji elegido sea EXACTO — el objeto/animal/color correcto, no uno similar.

Responde ÚNICAMENTE con esta última línea, sin explicar tu razonamiento, sin comillas, sin texto antes ni después:
EMOJIS|||TÍTULO

${usedList ? `NO repitas estos títulos ya usados, y evita el mismo estilo/franquicia de ellos: ${usedList}.` : ''}`;

  try {
    let raw;
    if (anthropic) {
      console.log('[emojigame] Generando con Claude Haiku...');
      const completion = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      });
      raw = (completion.content?.[0]?.text || '').trim();
      console.log('[emojigame] Respuesta de Claude:', raw.slice(0, 100));
    } else {
      console.log('[emojigame] ANTHROPIC_API_KEY no configurada — usando Groq de respaldo');
      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'system', content: prompt }],
        max_tokens: 300,
        temperature: 0.9,
      });
      raw = (completion.choices[0]?.message?.content || '').trim();
    }
    // El modelo puede pensar antes de responder — tomar solo la última línea con el formato EMOJIS|||TITULO
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l.includes('|||'));
    const lastValidLine = lines[lines.length - 1] || raw;
    const [emojis, title] = lastValidLine.split('|||').map(s => s?.trim().replace(/^["']|["']$/g, ''));

    // Validaciones anti-bug: formato correcto, título razonable, sin texto sobrante, no repetido
    const emojiCount = Array.from(emojis || '').filter(c => c.codePointAt(0) > 0x2000).length;
    const isValid = emojis && title
      && emojiCount >= 2
      && title.length >= 2 && title.length <= 60
      && !title.includes('\n') && !emojis.includes('PASO')
      && !usedEmojiAnswers[channelName].has(title.toLowerCase());

    if (!isValid) {
      console.log('[emojigame] Resultado inválido o repetido, reintentando...', { emojis, title });
      if (!_isRetry) return generateEmojiChallenge(channelName, category, true);
      return null;
    }

    usedEmojiAnswers[channelName].add(title.toLowerCase());
    if (usedEmojiAnswers[channelName].size > 40) {
      // Limpiar los más viejos para no acumular infinito
      const arr = Array.from(usedEmojiAnswers[channelName]);
      usedEmojiAnswers[channelName] = new Set(arr.slice(-30));
    }
    return { emojis, title };
  } catch (err) {
    console.error('[emojigame] Error generando reto:', err.message, err.stack?.slice(0,300));
    if (!_isRetry) return generateEmojiChallenge(channelName, category, true);
    return null;
  }
}

async function getMuffetResponse(channel, userMessage, username) {
  try {
    const config = channelConfigs[channel] || defaultConfig(channel);
    const history = chatHistory[channel] || [];

    // Agregar mensaje del usuario al historial
    addToHistory(channel, 'user', `${username}: ${userMessage}`);

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: config.bot_prompt },
        ...history.map(h => ({ role: h.role, content: h.content })),
      ],
      max_tokens: 150,
      temperature: 0.85,
    });

    const response = completion.choices[0]?.message?.content || '¡Algo salió mal en la cueva! 🕷️';

    // Agregar respuesta al historial
    addToHistory(channel, 'assistant', response);

    return response;
  } catch (err) {
    console.error('Error Groq:', err.message);
    return '¡Las telarañas se enredaron, dearie! 🕷️';
  }
}

// ── Procesar victoria de Primerin (usado por el comando !primerin) ──
async function processPrimerinWin(channelName, channel, client, username, pConfig) {
  const today = new Date().toISOString().split('T')[0];
  const usedToday = pConfig.used_today || {};

  if (usedToday.date === today) {
    client.say(channel, `🥇 @${usedToday.winner} fue el primero hoy~ 🕷️`);
    return;
  }

  const ranking = pConfig.ranking || {};
  ranking[username.toLowerCase()] = (ranking[username.toLowerCase()] || 0) + 1;

  const newConfig = { ...pConfig, ranking, used_today: { date: today, winner: username } };
  channelConfigs[channelName].primerin_config = newConfig;

  await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ primerin_config: newConfig })
  }).catch(() => {});

  const wins = ranking[username.toLowerCase()];
  const customMsg = pConfig.message || '';
  let msg;
  if (customMsg) {
    msg = customMsg.replace(/\{user\}/g, `@${username}`).replace(/\{wins\}/g, wins);
  } else {
    msg = await getMuffetResponse(channelName,
      `¡@${username} llegó primero al stream hoy! Lleva ${wins} vez${wins>1?'es':''} siendo el primero. Anúncialo emocionado con tu personalidad.`,
      username);
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
  if (isKnownBot(tags, tags.username || '')) return;

  const channelName = channel.replace('#', '').toLowerCase();

  // Solo responder en canales registrados en MuffetBot
  if (!channelConfigs[channelName]) return;

  // ── Chat compartido (Shared Chat) — ignorar mensajes que no son del propio canal ──
  // Twitch envía 'source-room-id' cuando el mensaje viene de OTRO canal participante
  // del shared chat. Si no coincide con el room-id de este canal, el mensaje no es
  // realmente de aquí y no debe disparar comandos, saludos ni respuestas de IA.
  if (tags['source-room-id'] && tags['room-id'] && tags['source-room-id'] !== tags['room-id']) {
    return;
  }

  const config = channelConfigs[channelName];
  const username = tags['display-name'] || tags.username;
  const msgLower = message.trim().toLowerCase();
  const firstWord = msgLower.split(' ')[0];
  const botName = TWITCH_BOT_USERNAME.toLowerCase();

  // Ignorar al bot
  if (username.toLowerCase() === botName) return;

  // Registrar viewer activo para {randomuser}
  if (!chatViewers[channelName]) chatViewers[channelName] = new Set();
  chatViewers[channelName].add(username.toLowerCase());

  // ── Detección de canjes de puntos de canal (Channel Point Redemptions) ──
  // NOTA: El canje real se procesa vía EventSub en server.js (handleRewardRedemption).
  // Este bloque solo queda como respaldo si llega vía chat tags (no garantizado).
  if (tags['custom-reward-id']) {
    const configuredRewardId = channelConfigs[channelName]?.raffle_settings?.reward_id;
    console.log(`[canje-chat] ${username} canjeó reward_id: ${tags['custom-reward-id']} | configurado: ${configuredRewardId || 'ninguno'}`);
  }

  // ── Comandos de control (solo mods) ──
  if (firstWord === '!muffetsilencio' || firstWord === '!muffetsilent') {
    if (!isMod(tags, channelName)) return;
    muffetSilentMap[channelName] = true;
    // Auto-desactivar después de 6 horas por si se olvidan (ej. chat compartido que termina)
    if (muffetSilentTimers[channelName]) clearTimeout(muffetSilentTimers[channelName]);
    muffetSilentTimers[channelName] = setTimeout(() => {
      muffetSilentMap[channelName] = false;
    }, 6 * 60 * 60 * 1000);
    client.say(channel, '🤫 Modo silencio activado — no responderé a raids, subs, regalos, bits ni mensajes automáticos. Ideal para chats compartidos~ 🕷️');
    return;
  }

  if (firstWord === '!muffethabla' || firstWord === '!muffetspeak') {
    if (!isMod(tags, channelName)) return;
    muffetSilentMap[channelName] = false;
    if (muffetSilentTimers[channelName]) { clearTimeout(muffetSilentTimers[channelName]); delete muffetSilentTimers[channelName]; }
    client.say(channel, '🗣️ ¡Estoy de vuelta, dearies! Ya puedo hablar libremente~ 🕷️👑♥');
    return;
  }

  if (firstWord === '!muffeton') {
    if (!isMod(tags, channelName)) return;
    muffetActiveMap[channelName] = true;
    fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
      method: 'PATCH', headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ on_off_ai: true })
    }).catch(() => {});
    let onMsg;
    const streamerName = channelName.replace('#','');
    onMsg = await getMuffetResponse(channelName, 
      `Acabo de activarme en el chat de ${streamerName}. Saluda al chat con energía usando tu personalidad única. Sé breve, máximo 2 oraciones. No uses comillas.`, 
      username);
    if (!onMsg) onMsg = config.on_message || '¡La guardiana ha despertado! 🕷️ ¡Estoy de vuelta, dearies! 👑♥';
    client.say(channel, onMsg);
    return;
  }
  if (firstWord === '!muffetoff') {
    if (!isMod(tags, channelName)) return;
    muffetActiveMap[channelName] = false;
    fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
      method: 'PATCH', headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ on_off_ai: false })
    }).catch(() => {});
    let offMsg;
    const streamerNameOff = channelName.replace('#','');
    offMsg = await getMuffetResponse(channelName, 
      `Me voy a descansar del chat de ${streamerNameOff}. Despídete del chat con tu personalidad única. Sé breve, máximo 2 oraciones. No uses comillas.`, 
      username);
    if (!offMsg) offMsg = config.off_message || '¡La guardiana se va a descansar~ 🕷️ ¡Hasta pronto, dearies! ♥';
    client.say(channel, offMsg);
    return;
  }
  if (firstWord === '!muffetstatus') {
    const active = muffetActiveMap[channelName] !== false;
    const silent = muffetSilentMap[channelName] === true;
    let statusMsg;
    if (!active) {
      statusMsg = `🔴 La guardiana está descansando~ 🕷️ Usa !muffeton para despertarla`;
    } else if (silent) {
      statusMsg = `🤫 Activa pero en modo silencio (no responde raids/subs/regalos/bits) — usa !muffethabla para que vuelva a hablar~ 🕷️`;
    } else {
      statusMsg = `🟢 La guardiana está activa y hablando con todos~ 🕷️♥`;
    }
    client.say(channel, statusMsg);
    return;
  }

  // ── Saludo al chatear por primera vez en el stream actual ──
  // greetedMap se reinicia cada vez que el canal empieza un nuevo stream (ver checkStreamsLive),
  // así cada viewer recibe un saludo una vez por stream, no una vez para siempre.
  if (!greetedMap[channelName]) greetedMap[channelName] = new Set();
  const userLowerGreet = username.toLowerCase();
  const alreadyGreetedThisStream = greetedMap[channelName].has(userLowerGreet);

  if (!alreadyGreetedThisStream) {
    greetedMap[channelName].add(userLowerGreet);
    // Persistir en Supabase (fire-and-forget) — sobrevive reinicios del bot
    fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ greeted_users: Array.from(greetedMap[channelName]) })
    }).catch(() => {});
    const isReturningViewer = (channelConfigs[channelName]?.viewer_points || {})[userLowerGreet] !== undefined;

    // Durante los 90s tras una raid: se marcan como saludados (arriba) pero sin mensaje individual — el saludo de raid ya los recibió a todos
    const raidSuppressed = Date.now() < (raidSuppressGreetings[channelName] || 0);

    if (!raidSuppressed && muffetActiveMap[channelName] !== false && !muffetSilentMap[channelName] && Date.now() - BOT_START_TIME > 30000) {
      const isViewbot = /https?:\/\//i.test(message) ||
        /buy\s*(followers|viewers|views|subs)/i.test(message) ||
        /get\s*(views|viewers|followers)/i.test(message) ||
        /increase.*viewers/i.test(message) ||
        /cheap.*follow/i.test(message) ||
        /t\.me\//i.test(message) ||
        /bit\.ly\//i.test(message);
      const isCommand = message.trim().startsWith('!');
      const isBroadcaster = (tags.username || '').toLowerCase() === channelName.toLowerCase() ||
                            tags.badges?.broadcaster === '1';

      if (!isViewbot && !isCommand && !isBroadcaster) {
        setTimeout(async () => {
          try {
            if (!canAiRespond(channelName)) return;
            const welcomeMsg = await getMuffetResponse(channelName,
              isReturningViewer
                ? `Saluda brevemente a ${username} que ya es parte del chat y acaba de escribir en este stream. Sé breve y usa tu personalidad.`
                : `Saluda brevemente a ${username} que acaba de llegar al canal por primera vez. Sé breve y usa tu personalidad.`,
              username);
            botSay(client, channel, welcomeMsg, true);
          } catch(e) {
            client.say(channel, `¡Bienvenid@ ${username}! 🎉`);
          }
        }, 2000);
      }
    }
  }

  // ── Si está en silencio ──
  if (muffetActiveMap[channelName] === false) return;

  // ── Moderación ──
  if (config.mod_enabled) {
    const isModOrBroadcaster = isMod(tags, channelName);
    const isSub = !!tags.subscriber || !!tags.badges?.subscriber;
    const isVIP = !!tags.badges?.vip;
    const modCfg = config.mod_config || {};
    const warnMsg = config.warn_message || '⚠️ Cuidado, dearie~ 🕷️';

    if (!isModOrBroadcaster) {

      // ── Modo lento ──
      if (modCfg.slow_mode && modCfg.slow_seconds > 0) {
        if (!slowModeTracker[channelName]) slowModeTracker[channelName] = {};
        const lastTime = slowModeTracker[channelName][username.toLowerCase()] || 0;
        const elapsed = (Date.now() - lastTime) / 1000;
        if (elapsed < modCfg.slow_seconds) {
          helixDeleteMessage(client, channelName, tags['room-id'], tags.id);
          return;
        }
        slowModeTracker[channelName][username.toLowerCase()] = Date.now();
      }

      // ── Bloqueo de links ──
      if (modCfg.block_links) {
        const linkRegex = /https?:\/\/|www\.|\.com|\.net|\.org|\.gg|\.tv|\.io|\.ly/i;
        if (linkRegex.test(message)) {
          const whitelist = modCfg.link_whitelist || [];
          const isWhitelisted = whitelist.some(domain => message.toLowerCase().includes(domain.toLowerCase()));
          if (!isWhitelisted && !isSub && !isVIP) {
            helixDeleteMessage(client, channelName, tags['room-id'], tags.id);
            client.say(channel, `@${username} Los links no están permitidos~ 🕷️`);
            if (modCfg.timeout_links) helixTimeout(client, channelName, tags['room-id'], tags['user-id'], modCfg.timeout_duration || 60, 'Link no permitido');
            return;
          }
        }
      }

      // ── Anti-spam (mensajes repetidos) ──
      if (modCfg.anti_spam) {
        if (!spamTracker[channelName]) spamTracker[channelName] = {};
        if (!spamTracker[channelName][username.toLowerCase()]) spamTracker[channelName][username.toLowerCase()] = { msgs: [], lastMsg: '' };
        const tracker = spamTracker[channelName][username.toLowerCase()];
        const now = Date.now();
        tracker.msgs = tracker.msgs.filter(t => now - t < 10000); // últimos 10s
        tracker.msgs.push(now);
        const isRepeat = msgLower === tracker.lastMsg;
        tracker.lastMsg = msgLower;
        const maxMsgs = modCfg.spam_max_msgs || 5;
        if (tracker.msgs.length > maxMsgs || (isRepeat && tracker.msgs.length > 2)) {
          helixDeleteMessage(client, channelName, tags['room-id'], tags.id);
          client.say(channel, `@${username} ¡No hagas spam, dearie~ 🕷️`);
          if (modCfg.timeout_spam) helixTimeout(client, channelName, tags['room-id'], tags['user-id'], modCfg.timeout_duration || 60, 'Spam detectado');
          tracker.msgs = [];
          return;
        }
      }

      // ── Palabras prohibidas ──
      if (config.banned_words?.length > 0) {
        if (config.banned_words.some(w => msgLower.includes(w.toLowerCase()))) {
          helixDeleteMessage(client, channelName, tags['room-id'], tags.id);
          client.say(channel, `@${username} ${warnMsg}`);
          if (modCfg.timeout_banned) helixTimeout(client, channelName, tags['room-id'], tags['user-id'], modCfg.timeout_duration || 60, 'Palabra prohibida');
          return;
        }
      }

      // ── Moderación con IA (solo Pro) ──
      if (modCfg.ai_mod && isPro(channelName) && !isSub && !isVIP) {
        const check = await checkMessageWithAI(message);
        if (check.flagged) {
          helixDeleteMessage(client, channelName, tags['room-id'], tags.id);
          client.say(channel, `@${username} ${warnMsg}`);
          if (modCfg.timeout_ai) helixTimeout(client, channelName, tags['room-id'], tags['user-id'], modCfg.timeout_duration || 60, 'Moderación IA');
          return;
        }
      }
    }
  }

// ══════════════════════════════════════════
//  MODERACIÓN VÍA HELIX API
//  (Twitch eliminó /timeout y /delete de IRC en 2023 — tmi.js ya no puede moderar)
// ══════════════════════════════════════════
const botUserIdCache = {}; // { token: userId } — cache del ID de cada cuenta de bot

function getModTokenForChannel(channelName, client) {
  // Si este client es el bot personalizado del canal, usar su token; sino el del bot principal
  const cfg = channelConfigs[channelName];
  if (customClients[channelName] && customClients[channelName] === client && cfg?.custom_bot_token) {
    return cfg.custom_bot_token.replace(/^oauth:/, '');
  }
  return (TWITCH_OAUTH_TOKEN || '').replace(/^oauth:/, '');
}

async function getBotUserId(token) {
  if (botUserIdCache[token]) return botUserIdCache[token];
  try {
    const res = await fetch('https://api.twitch.tv/helix/users', {
      headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': process.env.TWITCH_CLIENT_ID }
    });
    const data = await res.json();
    const id = data.data?.[0]?.id;
    if (id) botUserIdCache[token] = id;
    return id || null;
  } catch(e) { return null; }
}

async function helixDeleteMessage(client, channelName, roomId, messageId) {
  try {
    const token = getModTokenForChannel(channelName, client);
    const modId = await getBotUserId(token);
    if (!modId || !roomId || !messageId) return false;
    const res = await fetch(`https://api.twitch.tv/helix/moderation/chat?broadcaster_id=${roomId}&moderator_id=${modId}&message_id=${messageId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': process.env.TWITCH_CLIENT_ID }
    });
    if (res.status === 401 || res.status === 403) console.error(`[mod] Sin permisos para borrar en #${channelName} — el bot debe ser MOD y su token necesita el scope moderator:manage:chat_messages (status ${res.status})`);
    return res.ok;
  } catch(e) { console.error('[mod] delete error:', e.message); return false; }
}

async function helixTimeout(client, channelName, roomId, targetUserId, durationSec, reason) {
  try {
    const token = getModTokenForChannel(channelName, client);
    const modId = await getBotUserId(token);
    if (!modId || !roomId || !targetUserId) return false;
    const res = await fetch(`https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${roomId}&moderator_id=${modId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': process.env.TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { user_id: targetUserId, duration: durationSec, reason: (reason || '').slice(0, 100) } })
    });
    if (res.status === 401 || res.status === 403) console.error(`[mod] Sin permisos para timeout en #${channelName} — el bot debe ser MOD y su token necesita el scope moderator:manage:banned_users (status ${res.status})`);
    return res.ok;
  } catch(e) { console.error('[mod] timeout error:', e.message); return false; }
}

  // ── Refresh token de Spotify ──
async function getSpotifyToken(channelName) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const data = await res.json();
    const streamer = data?.[0];
    if (!streamer?.spotify_token) return null;

    // Probar el token actual
    const test = await fetch('https://api.spotify.com/v1/me', {
      headers: { 'Authorization': `Bearer ${streamer.spotify_token}` }
    });

    if (test.status === 401 && streamer.spotify_refresh) {
      // Token expirado — refrescar
      const clientId = streamer.spotify_client_id || process.env.SPOTIFY_CLIENT_ID;
      const clientSecret = streamer.spotify_client_secret || process.env.SPOTIFY_CLIENT_SECRET;
      const refreshRes = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
        },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: streamer.spotify_refresh }).toString()
      });
      const refreshData = await refreshRes.json();
      if (refreshData.access_token) {
        // Guardar nuevo token
        await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
          method: 'PATCH',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ spotify_token: refreshData.access_token })
        });
        console.log(`🎵 Token de Spotify renovado para ${channelName}`);
        return refreshData.access_token;
      } else if (refreshData.error === 'invalid_grant') {
        // Refresh token expirado/revocado — descartar credenciales y marcar desconectado
        console.log(`🎵 Refresh token inválido para ${channelName} — desconectando Spotify`);
        await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
          method: 'PATCH',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            spotify_token: null,
            spotify_refresh: null,
            spotify_disconnected_reason: 'invalid_grant',
            spotify_disconnected_at: new Date().toISOString()
          })
        });
        return null;
      }
      // Otro tipo de error — no descartar credenciales, solo fallar esta vez
      return null;
    }
    return streamer.spotify_token;
  } catch(e) { return null; }
}

  // ── Spotify ──
// Mutex — evita race conditions en !cancion
const activeSongRequests = new Set();

// Cooldown global de IA por canal — evita spam en raids y eventos masivos
const aiGlobalCooldown = {}; // { channelName: lastResponseTime }
const AI_GLOBAL_COOLDOWN_MS = 4000; // 4 segundos entre respuestas de IA

function canAiRespond(channelName) {
  const now = Date.now();
  const last = aiGlobalCooldown[channelName] || 0;
  if (now - last < AI_GLOBAL_COOLDOWN_MS) return false;
  aiGlobalCooldown[channelName] = now;
  return true;
}

// ── Monitor — Spotify como fuente de verdad (Gemini approach) ──
// Caché local de song_limits — evita consultar Supabase en cada tick
const songLimitsCache = {}; // { channelName: { limits, lastSync } }
const LIMITS_CACHE_TTL = 60000; // 1 minuto

async function getSongLimitsFromCache(channelName) {
  const cached = songLimitsCache[channelName];
  if (cached && Date.now() - cached.lastSync < LIMITS_CACHE_TTL) {
    return cached;
  }
  // Cache expiró — recargar desde Supabase
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}&select=spotify_config&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const data = await res.json();
    const spotConfig = data?.[0]?.spotify_config || {};
    songLimitsCache[channelName] = { limits: spotConfig.song_limits || {}, spotConfig, lastSync: Date.now() };
    return songLimitsCache[channelName];
  } catch(e) { return cached || { limits: {}, spotConfig: {} }; }
}

// Canales con song_limits activos — solo procesar estos
const activeSpotifyChannels = new Set();

async function trackNowPlaying() {
  // Solo procesar canales que tienen song_limits activos en cache
  if (activeSpotifyChannels.size === 0) return;

  for (const channelName of activeSpotifyChannels) {
    try {
      const cached = await getSongLimitsFromCache(channelName);
      const limits = cached.limits;
      if (Object.keys(limits).length === 0) {
        activeSpotifyChannels.delete(channelName);
        continue;
      }

      const token = await getSpotifyToken(channelName);
      if (!token) continue;

      const [qRes, nowRes] = await Promise.all([
        fetch('https://api.spotify.com/v1/me/player/queue', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('https://api.spotify.com/v1/me/player/currently-playing', { headers: { 'Authorization': `Bearer ${token}` } })
      ]);

      const qData = qRes.ok ? await qRes.json() : null;
      const nowData = nowRes.status === 200 ? await nowRes.json() : null;

      const spotifyUris = [
        ...(nowData?.item?.uri ? [nowData.item.uri] : []),
        ...(qData?.queue || []).map(t => t.uri)
      ];

      let needsUpdate = false;
      const newLimits = {};

      for (const [user, userSongs] of Object.entries(limits)) {
        if (!Array.isArray(userSongs)) continue;
        const validSongs = [];
        for (const song of userSongs) {
          const idx = spotifyUris.indexOf(song.uri);
          if (idx !== -1) {
            validSongs.push(song);
            spotifyUris.splice(idx, 1);
          } else if (Date.now() - song.addedAt < 30000) {
            validSongs.push(song);
          }
        }
        if (validSongs.length !== userSongs.length) needsUpdate = true;
        if (validSongs.length > 0) newLimits[user] = validSongs;
      }

      if (needsUpdate) {
        await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
          method: 'PATCH',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ spotify_config: { ...cached.spotConfig, song_limits: newLimits } })
        });
        // Actualizar cache local
        songLimitsCache[channelName] = { ...cached, limits: newLimits, lastSync: Date.now() };
        if (Object.keys(newLimits).length === 0) activeSpotifyChannels.delete(channelName);
        console.log(`[music] Límites actualizados para #${channelName}`);
      }
    } catch(e) { console.error('[trackNowPlaying]', e.message); }
  }
}

setInterval(trackNowPlaying, 20000); // Aumentado a 20s
const skipVotes = {}; // { channelName: Set() } — votos para saltar canción


// El límite se libera automáticamente con setTimeout en cada canción — no necesita monitor
const spamTracker = {}; // { channelName: { username: { msgs: [], lastMsg: '' } } }
const slowModeTracker = {}; // { channelName: { username: lastMsgTime } }

  if (firstWord === '!cola' || firstWord === '!queue') {
    try {
      const token = await getSpotifyToken(channelName);
      if (!token) return;
      const r = await fetch('https://api.spotify.com/v1/me/player/queue', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!r.ok) { client.say(channel, `@${username} No se pudo obtener la cola~ 🎵`); return; }
      const data = await r.json();
      const queue = data.queue?.slice(0, 5) || [];
      if (!queue.length) { client.say(channel, '🎵 La cola está vacía~ 🎵'); return; }
      const list = queue.map((t, i) => `${i+1}. ${t.name} — ${t.artists[0].name}`).join(' | ');
      client.say(channel, `🎵 Cola: ${list} 🎵`);
    } catch(e) { client.say(channel, `@${username} Error al obtener la cola~ 🎵`); }
    return;
  }


  if (firstWord === '!cancion' || firstWord === '!canción' || firstWord === '!song' || firstWord === '!sr') {
    if (!isSysCmdEnabled(channelName, 'cancion')) return;
    if (!isPro(channelName)) { proOnly(client, channel, username); return; }
    // Mutex — bloquear al usuario antes de cualquier await
    const chKeyMutex = channelName.replace('#','').toLowerCase();
    const lockKey = `${chKeyMutex}_${username.toLowerCase()}`;
    if (activeSongRequests.has(lockKey)) return;
    activeSongRequests.add(lockKey);
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      const data = await res.json();
      const streamer = data?.[0];
      const spotifyConfig = streamer?.spotify_config || {};

      if (!spotifyConfig.enabled) { client.say(channel, `@${username} Las peticiones de canciones están desactivadas ahora mismo~ 🎵`); return; }

      const token = await getSpotifyToken(channelName);
      if (!token) { client.say(channel, `@${username} Spotify no está conectado — el streamer debe reconectar su cuenta en el dashboard~ 🎵`); return; }

      // Verificar permisos
      const allowed = spotifyConfig.allowed || ['everyone'];
      if (!allowed.includes('everyone')) {
        const isSub = !!tags.subscriber || !!tags.badges?.subscriber;
        const isVIP = !!tags.badges?.vip;
        const isModUser = isMod(tags, channelName);
        const canUse = (allowed.includes('sub') && isSub) || (allowed.includes('vip') && isVIP) || (allowed.includes('mod') && isModUser) || isModUser;
        if (!canUse) {
          const reqLabels = { sub:'suscriptores', vip:'VIPs', mod:'moderadores' };
          client.say(channel, `@${username} Solo ${allowed.map(p=>reqLabels[p]||p).join(' y ')} pueden pedir canciones~ 🎵`);
          return;
        }
      }

      const query = message.trim().slice(firstWord.length).trim();

      // !cancion actual — ver qué suena
      if (!query || query === 'actual' || query === 'now') {
        const r = await fetch('https://api.spotify.com/v1/me/player/currently-playing',
          { headers: { 'Authorization': `Bearer ${token}` } });
        if (r.status === 204) { client.say(channel, `🎵 No hay nada reproduciéndose ahora~ 🎵`); return; }
        const trackData = await r.json();
        const track = trackData.item;
        if (track) client.say(channel, `🎵 Sonando: ${track.name} — ${track.artists[0].name} 🎵`);
        return;
      }

      // ── Límite por usuario — Spotify como fuente de verdad ──
      const maxPerUser = spotifyConfig.max_per_user || 3;
      const chKey = channelName.replace('#','').toLowerCase();
      const userKey = username.toLowerCase();
      const limitsObj = spotifyConfig.song_limits || {};
      const userSongs = Array.isArray(limitsObj[userKey]) ? limitsObj[userKey] : [];
      const userPending = userSongs.length;

      if (userPending >= maxPerUser) {
        client.say(channel, `@${username} Tienes ${userPending}/${maxPerUser} canciones en cola~ Espera a que suene una 🎵`);
        return;
      }

      // ── Buscar track ──
      const spotifyLinkMatch = query.match(/open\.spotify\.com\/track\/([a-zA-Z0-9]+)/);
      let track;

      if (spotifyLinkMatch) {
        const trackId = spotifyLinkMatch[1];
        const trackRes = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`,
          { headers: { 'Authorization': `Bearer ${token}` } });
        if (!trackRes.ok) { client.say(channel, `@${username} No pude obtener esa canción~ 🎵`); return; }
        track = await trackRes.json();
      } else {
        let searchQuery = query;
        let fallbackQuery = query;
        if (query.includes(' - ')) {
          const parts = query.split(' - ');
          searchQuery = `track:${parts[0].trim()} artist:${parts.slice(1).join(' - ').trim()}`;
          fallbackQuery = `${parts[0].trim()} ${parts.slice(1).join(' - ').trim()}`;
        }
        let tracks = [];
        const searchRes = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(searchQuery)}&type=track&limit=5&market=ES`,
          { headers: { 'Authorization': `Bearer ${token}` } });
        const searchData = await searchRes.json();
        tracks = searchData.tracks?.items || [];
        if (!tracks.length && searchQuery !== fallbackQuery) {
          const fallRes = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(fallbackQuery)}&type=track&limit=5&market=ES`,
            { headers: { 'Authorization': `Bearer ${token}` } });
          tracks = (await fallRes.json()).tracks?.items || [];
        }
        if (!tracks.length) { client.say(channel, `@${username} No encontré esa canción~ 🎵`); return; }
        const queryLower = query.toLowerCase().replace(' - ', ' ');
        track = tracks.reduce((best, t) => {
          const combined = `${t.name} ${t.artists[0].name}`.toLowerCase();
          const score = queryLower.split(' ').filter(w => w.length > 1 && combined.includes(w)).length;
          return score > (best._score || 0) ? { ...t, _score: score } : best;
        }, { ...tracks[0], _score: 0 });
      }

      // Blacklist
      const blacklist = spotifyConfig.blacklist || [];
      const isBlocked = blacklist.some(b => {
        const bl = b.toLowerCase();
        return track.name.toLowerCase().includes(bl) || track.artists[0].name.toLowerCase().includes(bl);
      });
      if (isBlocked) {
        client.say(channel, `@${username} Esa canción o artista está en la lista negra~ 🕷️`);
        return;
      }

      // Agregar a Spotify
      const queueRes = await fetch(`https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(track.uri)}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (queueRes.status === 204 || queueRes.status === 200) {
        // Guardar en song_limits con URI para que el monitor pueda liberar el slot
        userSongs.push({ uri: track.uri, addedAt: Date.now() });
        limitsObj[userKey] = userSongs;
        const remaining = maxPerUser - userSongs.length;
        const remainingMsg = remaining > 0 ? ` (puedes pedir ${remaining} más)` : ` (llegaste al límite)`;
        client.say(channel, `🎵 ¡@${username} agregó "${track.name}" de ${track.artists[0].name}!${remainingMsg} 🎶`);
        console.log(`[limit] ${chKey}:${userKey}: ${userSongs.length}/${maxPerUser}`);
        // Activar monitoreo para este canal
        activeSpotifyChannels.add(chKey);
        if (songLimitsCache[chKey]) songLimitsCache[chKey].limits = limitsObj;

        // Guardar en Supabase (límites + historial en una sola llamada)
        try {
          const histRes = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}&limit=1`,
            { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
          const histData = await histRes.json();
          const freshConfig = histData?.[0]?.spotify_config || {};
          const history = freshConfig.history || [];
          history.unshift({ name: track.name, artist: track.artists[0].name, image: track.album?.images?.[1]?.url || '', requester: username.toLowerCase(), requestedAt: new Date().toISOString() });
          if (history.length > 20) history.pop();
          await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
            method: 'PATCH',
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ spotify_config: { ...freshConfig, song_limits: limitsObj, history } })
          });
        } catch(e) {}
      } else {
        client.say(channel, `@${username} No se pudo agregar — ¿Spotify está reproduciendo? 🎵`);
      }
    } catch(e) { client.say(channel, `@${username} Error con Spotify~ 🎵`); }
    finally { activeSongRequests.delete(lockKey); }
    return;
  }

  // ── !yt — solicitar canción de YouTube ──
  if (firstWord === '!yt' || firstWord === '!youtube') {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      const data = await res.json();
      const streamer = data?.[0];
      const ytConfig = streamer?.youtube_config || {};

      if (!ytConfig.enabled) { client.say(channel, `@${username} Las peticiones de YouTube están desactivadas ahora mismo~ 🎵`); return; }

      // Permisos
      const allowed = ytConfig.allowed || ['everyone'];
      if (!allowed.includes('everyone')) {
        const isSub = !!tags.subscriber || !!tags.badges?.subscriber;
        const isVIP = !!tags.badges?.vip;
        const isModerator = isMod(tags, channelName);
        const canUse = (allowed.includes('sub') && isSub) || (allowed.includes('vip') && isVIP) || (allowed.includes('mod') && isModerator) || isModerator;
        if (!canUse) { client.say(channel, `@${username} No tienes permiso para pedir canciones de YouTube~ 🕷️`); return; }
      }

      const query = message.trim().slice(firstWord.length).trim();
      if (!query) { client.say(channel, `@${username} Escribe el nombre de la canción: !yt nombre de la canción~ 🎵`); return; }

      // Límite por usuario
      const maxPerUser = ytConfig.max_per_user || 3;
      const chKey = channelName.replace('#','').toLowerCase();
      const userKey = username.toLowerCase();
      const ytLimits = ytConfig.song_limits || {};
      const userSongs = Array.isArray(ytLimits[userKey]) ? ytLimits[userKey] : [];
      if (userSongs.length >= maxPerUser) {
        client.say(channel, `@${username} Tienes ${userSongs.length}/${maxPerUser} canciones en cola~ Espera a que suene una 🎵`);
        return;
      }

      // Buscar en YouTube (link directo o búsqueda por nombre)
      const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
      if (!YOUTUBE_API_KEY) { client.say(channel, `@${username} YouTube no está configurado~ 🕷️`); return; }

      let videoId, title, channelTitle;

      // Rechazar links de playlists
      if (query.includes('list=') && !query.includes('watch?v=')) {
        client.say(channel, `@${username} Ese es un link de playlist — por favor pon el link de una canción individual 🎵`);
        return;
      }

      // Detectar si es un link de YouTube
      const ytLinkMatch = query.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
      if (ytLinkMatch) {
        videoId = ytLinkMatch[1];
        // Obtener info del video por ID
        const infoRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${YOUTUBE_API_KEY}`);
        const infoData = await infoRes.json();
        const video = infoData.items?.[0];
        if (!video) { client.say(channel, `@${username} No encontré ese video~ 🎵`); return; }
        title = video.snippet.title;
        channelTitle = video.snippet.channelTitle;
      } else {
        // Búsqueda por nombre
        const searchRes = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=5&key=${YOUTUBE_API_KEY}`);
        const searchData = await searchRes.json();
        const items = searchData.items || [];
        if (!items.length) { client.say(channel, `@${username} No encontré esa canción en YouTube~ 🎵`); return; }
        const video = items[0];
        videoId = video.id.videoId;
        title = video.snippet.title;
        channelTitle = video.snippet.channelTitle;
      }

      // Verificar duración máxima
      const maxDurationMin = ytConfig.max_duration_min || 10;
      try {
        const detailRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoId}&key=${YOUTUBE_API_KEY}`);
        const detailData = await detailRes.json();
        const duration = detailData.items?.[0]?.contentDetails?.duration || '';
        // Parsear ISO 8601 duration (PT1H2M3S)
        const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
        if (match) {
          const totalMin = (parseInt(match[1]||0) * 60) + parseInt(match[2]||0) + (parseInt(match[3]||0) > 0 ? 1 : 0);
          if (totalMin > maxDurationMin) {
            client.say(channel, `@${username} Ese video dura ${totalMin} min — el máximo es ${maxDurationMin} min~ 🎵`);
            return;
          }
        }
      } catch(e) {}

      // Blacklist
      const blacklist = ytConfig.blacklist || [];
      const isBlocked = blacklist.some(b => title.toLowerCase().includes(b.toLowerCase()) || channelTitle.toLowerCase().includes(b.toLowerCase()));
      if (isBlocked) { client.say(channel, `@${username} Esa canción está en la lista negra~ 🕷️`); return; }

      // Agregar a la cola en Supabase
      const queue = ytConfig.queue || [];
      queue.push({ videoId, title, channelTitle, requestedBy: userKey, addedAt: Date.now() });

      // Actualizar límite
      userSongs.push({ uri: videoId, addedAt: Date.now(), durationMs: 240000 });
      ytLimits[userKey] = userSongs;

      const remaining = maxPerUser - userSongs.length;
      const remainingMsg = remaining > 0 ? ` (puedes pedir ${remaining} más)` : ` (llegaste al límite)`;

      await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtube_config: { ...ytConfig, queue, song_limits: ytLimits } })
      });

      client.say(channel, `🎵 ¡@${username} agregó "${title}"!${remainingMsg} 🎶`);
    } catch(e) { client.say(channel, `@${username} Error al buscar en YouTube~ 🎵`); }
    return;
  }

  if (firstWord === '!skip') {
    if (!isMod(tags, channelName)) return;
    if (!isPro(channelName)) { proOnly(client, channel, username); return; }
    try {
      const token = await getSpotifyToken(channelName);
      if (!token) return;
      await fetch('https://api.spotify.com/v1/me/player/next', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      skipVotes[channelName] = new Set(); // Resetear votos al saltar
      client.say(channel, `⏭️ Canción saltada~ 🎵`);
    } catch(e) { client.say(channel, `@${username} No se pudo saltar — ¿Spotify está reproduciendo? 🎵`); }
    return;
  }

  // ── !vskip — votar para saltar canción ──
  if (firstWord === '!vskip') {
    if (!isSysCmdEnabled(channelName, 'cancion')) return;
    if (!isPro(channelName)) { proOnly(client, channel, username); return; }
    const spotConfig = channelConfigs[channelName]?.spotify_config || {};
    const votesNeeded = spotConfig.skip_votes || 5;
    if (!skipVotes[channelName]) skipVotes[channelName] = new Set();
    if (skipVotes[channelName].has(username.toLowerCase())) {
      client.say(channel, `@${username} Ya votaste para saltar~ 🎵`);
      return;
    }
    skipVotes[channelName].add(username.toLowerCase());
    const votes = skipVotes[channelName].size;
    if (votes >= votesNeeded) {
      skipVotes[channelName] = new Set();
      const token = await getSpotifyToken(channelName);
      if (token) {
        await fetch('https://api.spotify.com/v1/me/player/next', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
        client.say(channel, `⏭️ ¡El chat votó para saltar! ${votes}/${votesNeeded} votos~ 🎵`);
      }
    } else {
      client.say(channel, `⏭️ @${username} votó para saltar (${votes}/${votesNeeded})~ 🎵`);
    }
    return;
  }

  // ── !uptime ──
  if (firstWord === '!uptime') {
    if (!isSysCmdEnabled(channelName, 'uptime')) return;
    try {
      const token = await getTwitchAppToken();
      if (!token) { client.say(channel, `@${username} No pude obtener el uptime~ 🕷️`); return; }
      const streamRes = await fetch(`https://api.twitch.tv/helix/streams?user_login=${channelName}`,
        { headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': process.env.TWITCH_CLIENT_ID } });
      const streamData = await streamRes.json();
      const stream = streamData.data?.[0];
      if (!stream) { client.say(channel, `@${username} El canal no está en vivo~ 🕷️`); return; }
      const start = new Date(stream.started_at);
      const diff = Math.floor((Date.now() - start.getTime()) / 1000);
      const h = Math.floor(diff / 3600);
      const m = Math.floor((diff % 3600) / 60);
      const uptime = h > 0 ? `${h}h ${m}m` : `${m}m`;
      client.say(channel, `⏱️ Llevamos ${uptime} en vivo~ 🕷️`);
    } catch(e) { client.say(channel, `@${username} No pude obtener el uptime~ 🕷️`); }
    return;
  }

  // ── !titulo — cambiar título del stream ──
  if (firstWord === '!titulo' || firstWord === '!title') {
    if (!isSysCmdEnabled(channelName, 'titulo')) return;
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
    if (!isSysCmdEnabled(channelName, 'game')) return;
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

  // ── !apostar ──
  if (firstWord === '!apostar' || firstWord === '!bet') {
    if (!isSysCmdEnabled(channelName, 'apostar')) return;
    const pointsConfig = config.points_config || {};
    if (!pointsConfig.enabled) { client.say(channel, `@${username} El sistema de puntos no está activo~ 🕷️`); return; }
    const amount = parseInt(message.trim().split(' ')[1]);
    const maxBet = pointsConfig.max_bet || 500;
    const emoji = pointsConfig.emoji || '🏆';
    const name = pointsConfig.name || 'puntos';
    if (!amount || amount < 1) { client.say(channel, `@${username} Uso: !apostar 100 🕷️`); return; }
    if (amount > maxBet) { client.say(channel, `@${username} Máximo ${maxBet} ${name} por apuesta~ 🕷️`); return; }
    const viewerPoints = channelConfigs[channelName].viewer_points || {};
    const userLower = username.toLowerCase();
    const current = viewerPoints[userLower] || 0;
    if (current < amount) { client.say(channel, `@${username} No tienes suficientes ${name}! Tienes ${current} ${emoji} 🕷️`); return; }
    // 50/50
    const won = Math.random() < 0.5;
    const newTotal = won ? current + amount : current - amount;
    viewerPoints[userLower] = Math.max(0, newTotal);
    channelConfigs[channelName].viewer_points = viewerPoints;
    if (won) {
      client.say(channel, `🎰 ¡@${username} ganó la apuesta! +${amount} ${emoji} → Total: ${newTotal} ${name} 🎉🕷️`);
    } else {
      client.say(channel, `🎰 @${username} perdió la apuesta... -${amount} ${emoji} → Total: ${newTotal} ${name} 😢🕷️`);
    }
    fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewer_points: viewerPoints })
    }).catch(() => {});
    return;
  }

  // ── !canjear ──
  if (firstWord === '!canjear' || firstWord === '!redeem') {
    if (!isSysCmdEnabled(channelName, 'canjear')) return;
    const pointsConfig = config.points_config || {};
    if (!pointsConfig.enabled) return;
    const rewards = pointsConfig.rewards || [];
    const emoji = pointsConfig.emoji || '🏆';
    const name = pointsConfig.name || 'puntos';
    const query = message.trim().slice(firstWord.length).trim().toLowerCase();

    // !canjear sin argumento → mostrar lista
    if (!query) {
      if (!rewards.length) { client.say(channel, `@${username} No hay premios configurados aún~ 🕷️`); return; }
      const list = rewards.map(r => `${r.name} (${r.cost} ${emoji})`).join(' | ');
      client.say(channel, `🎁 Premios: ${list} — Usa !canjear [nombre] 🕷️`);
      return;
    }

    // Buscar el premio
    const reward = rewards.find(r => r.name.toLowerCase() === query || r.name.toLowerCase().includes(query));
    if (!reward) { client.say(channel, `@${username} Premio no encontrado. Escribe !canjear para ver la lista~ 🕷️`); return; }

    const viewerPoints = channelConfigs[channelName].viewer_points || {};
    const userLower = username.toLowerCase();
    const current = viewerPoints[userLower] || 0;
    if (current < reward.cost) {
      client.say(channel, `@${username} Necesitas ${reward.cost} ${emoji} para canjear "${reward.name}". Tienes ${current} ${emoji} 🕷️`);
      return;
    }

    // Descontar puntos y guardar solicitud
    viewerPoints[userLower] = current - reward.cost;
    channelConfigs[channelName].viewer_points = viewerPoints;

    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      const data = await res.json();
      const requests = data?.[0]?.redeem_requests || [];
      requests.push({ id: Date.now(), username, reward: reward.name, cost: reward.cost, status: 'pending', date: new Date().toISOString() });
      await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewer_points: viewerPoints, redeem_requests: requests })
      });
      client.say(channel, `✅ @${username} canjeó "${reward.name}" por ${reward.cost} ${emoji}! El streamer revisará tu solicitud~ 🕷️`);
    } catch(e) {
      client.say(channel, `@${username} Error al procesar el canje~ 🕷️`);
    }
    return;
  }

  // ── Sistema de puntos y niveles ──
  const pointsConfig = config.points_config || {};
  const pointsEnabled = pointsConfig.enabled !== false;

  if (pointsEnabled && !self) {
    // No dar XP al broadcaster en su propio canal
    const isBroadcasterXP = (tags.username || '').toLowerCase() === channelName.toLowerCase() || tags.badges?.broadcaster === '1';
    if (!isBroadcasterXP) {
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

    // Solo anunciar si realmente subió de nivel — comparar con nivel guardado
    const savedLevel = viewerPoints[userLower + '_level'] || 1;
    if (newLevel && newLevel.level > savedLevel) {
      const emoji = pointsConfig.emoji || '🏆';
      setTimeout(() => client.say(channel, `🎉 ¡@${username} subió al nivel ${newLevel.level} — ${newLevel.name}! ${emoji}`), 1000);
      viewerPoints[userLower + '_level'] = newLevel.level;
    } else if (newLevel && !viewerPoints[userLower + '_level']) {
      // Inicializar nivel guardado sin anunciar
      viewerPoints[userLower + '_level'] = newLevel.level;
    }

    // Guardar XP
    viewerPoints[userLower] = newXP;
    channelConfigs[channelName].viewer_points = viewerPoints;

    // Flush a Supabase cada 60 segundos
    if (!channelConfigs[channelName]._pointsFlushTimer) {
      channelConfigs[channelName]._pointsFlushTimer = setTimeout(async () => {
        channelConfigs[channelName]._pointsFlushTimer = null;
        try {
          // Filtrar keys internas (_level, etc) antes de guardar en Supabase
          const pointsToSave = Object.fromEntries(
            Object.entries(channelConfigs[channelName].viewer_points || {})
              .filter(([k]) => !k.endsWith('_level') && !k.startsWith('_'))
          );
          await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
            method: 'PATCH',
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ viewer_points: pointsToSave })
          });
        } catch(e) {}
      }, 60000);
    }
    } // fin isBroadcasterXP
  }

  // ── Comandos de puntos ──
  if (firstWord === '!puntos' || firstWord === '!xp' || firstWord === '!nivel' || firstWord === '!level') {
    if (!isSysCmdEnabled(channelName, 'puntos')) return;
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
    if (!isSysCmdEnabled(channelName, 'top')) return;
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
    if (!isSysCmdEnabled(channelName, 'dar')) return;
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
    if (!isSysCmdEnabled(channelName, 'clip')) return;
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

      if (clipData.data?.[0]?.id) {
        const clipId = clipData.data[0].id;
        client.say(channel, `✂️ @${username} Creando el clip... 🕷️`);

        // Verificar hasta 5 veces cada 3 segundos si el clip ya está listo
        let clipUrl = null;
        for (let i = 0; i < 5; i++) {
          await new Promise(r => setTimeout(r, 3000));
          try {
            const checkRes = await fetch(`https://api.twitch.tv/helix/clips?id=${clipId}`, {
              headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': process.env.TWITCH_CLIENT_ID || '' }
            });
            const checkData = await checkRes.json();
            if (checkData.data?.[0]?.url) {
              clipUrl = checkData.data[0].url;
              break;
            }
          } catch(e) {}
        }

        if (clipUrl) {
          client.say(channel, `✅ ¡Clip listo! ${clipUrl} 🕷️`);
        } else {
          client.say(channel, `@${username} El clip se está procesando, revísalo en tu canal de Twitch 🕷️`);
        }
      } else if (clipData.error) {
        console.log(`[clip] Error para ${channelName}:`, JSON.stringify(clipData));
        if (clipData.status === 401 || clipData.error === 'Unauthorized') {
          client.say(channel, `@${username} Sin permisos para crear clips — ZuuRdj necesita reconectar su cuenta en el dashboard 🕷️`);
        } else if (clipData.status === 404) {
          client.say(channel, `@${username} No se pudo crear el clip — ¿el stream está en vivo? 🕷️`);
        } else {
          client.say(channel, `@${username} No se pudo crear el clip (${clipData.message || clipData.error}) 🕷️`);
        }
      } else {
        console.log(`[clip] Respuesta inesperada para ${channelName}:`, JSON.stringify(clipData));
        client.say(channel, `@${username} No se pudo crear el clip — ¿el stream está en vivo? 🕷️`);
      }
    } catch(e) {
      client.say(channel, `@${username} Error al crear el clip~ 🕷️`);
    }
    return;
  }

  // ── !random ──
  if (firstWord === '!random' || firstWord === '!dado' || firstWord === '!ruleta') {
    if (!isSysCmdEnabled(channelName, 'random')) return;
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
    const sys = config.system_commands || {};

    // Comandos del sistema activos
    const sysActive = [
      ['game', '!game'], ['titulo', '!titulo'], ['uptime', '!uptime'],
      ['clip', '!clip'], ['redes', '!redes'], ['puntos', '!puntos'],
      ['top', '!top'], ['apostar', '!apostar'], ['canjear', '!canjear'], ['duelo', '!duelo'],
      ['sorteo', '!sorteo'], ['random', '!random'], ['ask', '!ask'],
      ['bola8', '!8ball'], ['poll', '!poll'], ['cancion', '!cancion'],
      ['primerin', '!' + (channelConfigs[channelName]?.primerin_config?.command || 'primerin')],
      ['primerin', '!toprimerin'],
    ].filter(([id]) => sys[id] !== false).map(([, cmd]) => cmd);

    // Comandos personalizados
    const custom = Object.keys(config.commands || {});

    const all = [...sysActive, ...custom];
    client.say(channel, all.length ? `📋 Comandos: ${all.join(' • ')} 🕷️` : `No hay comandos configurados~ 🕷️`);
    return;
  }

  // ── Encuestas ──
  // Uso: !poll ¿Qué jugamos? Minecraft Fortnite Valorant
  if (firstWord === '!poll' || firstWord === '!encuesta') {
    if (!isSysCmdEnabled(channelName, 'poll')) return;
    if (!isPro(channelName)) { proOnly(client, channel, username); return; }
    if (!isMod(tags, channelName)) return;
    const parts = message.trim().slice(firstWord.length).trim().split('?');
    if (parts.length < 2) { client.say(channel, `@${username} Uso: !poll ¿Pregunta? Opcion1 Opcion2 Opcion3 🕷️`); return; }
    const question = parts[0].trim().replace(/^¿/, '');
    const options = parts[1].trim().split(' ').filter(Boolean);
    if (options.length < 2) { client.say(channel, `@${username} Necesitas al menos 2 opciones~ 🕷️`); return; }
    if (options.length > 5) { client.say(channel, `@${username} Máximo 5 opciones~ 🕷️`); return; }

    // Guardar encuesta activa
    if (!channelConfigs[channelName].activePoll) channelConfigs[channelName].activePoll = null;
    channelConfigs[channelName].activePoll = { question, options, votes: {}, started: Date.now() };

    const optList = options.map((o, i) => `${i+1}. ${o}`).join(' | ');
    client.say(channel, `📊 ¡Encuesta! ${question} → ${optList} — Vota con el número 🕷️`);

    // Cerrar automáticamente en 2 minutos
    setTimeout(async () => {
      const poll = channelConfigs[channelName].activePoll;
      if (!poll || poll.started !== channelConfigs[channelName].activePoll?.started) return;
      const results = poll.options.map((o, i) => {
        const count = Object.values(poll.votes).filter(v => v === i+1).length;
        return `${o}: ${count}`;
      }).join(' | ');
      const winner = poll.options.reduce((best, o, i) => {
        const count = Object.values(poll.votes).filter(v => v === i+1).length;
        return count > best.count ? { name: o, count } : best;
      }, { name: '', count: -1 });
      client.say(channel, `📊 Encuesta cerrada! ${results} ${winner.count > 0 ? `— Ganó: ${winner.name} 🏆` : ''} 🕷️`);
      channelConfigs[channelName].activePoll = null;
    }, 2 * 60 * 1000);
    return;
  }

  // Votar en encuesta activa
  if (/^[1-5]$/.test(firstWord) && channelConfigs[channelName]?.activePoll) {
    const poll = channelConfigs[channelName].activePoll;
    const vote = parseInt(firstWord);
    if (vote <= poll.options.length) {
      poll.votes[username.toLowerCase()] = vote;
    }
    return;
  }

  // Cerrar encuesta manualmente
  if (firstWord === '!endpoll' || firstWord === '!cerrarencuesta') {
    if (!isMod(tags, channelName)) return;
    const poll = channelConfigs[channelName]?.activePoll;
    if (!poll) { client.say(channel, `@${username} No hay encuesta activa~ 🕷️`); return; }
    const results = poll.options.map((o, i) => {
      const count = Object.values(poll.votes).filter(v => v === i+1).length;
      return `${o}: ${count}`;
    }).join(' | ');
    const winner = poll.options.reduce((best, o, i) => {
      const count = Object.values(poll.votes).filter(v => v === i+1).length;
      return count > best.count ? { name: o, count } : best;
    }, { name: '', count: -1 });
    client.say(channel, `📊 Resultados: ${results} ${winner.count > 0 ? `— Ganó: ${winner.name} 🏆` : ''} 🕷️`);
    channelConfigs[channelName].activePoll = null;
    return;
  }

  // ── Dados RPG ──
  // !d6, !d20, !2d6, !dado, etc.
  const diceMatch = firstWord.match(/^!(\d*)d(\d+)$/i);
  if (diceMatch || firstWord === '!dado') {
    const num = diceMatch ? (parseInt(diceMatch[1]) || 1) : 1;
    const sides = diceMatch ? parseInt(diceMatch[2]) : 6;
    if (num > 10 || sides > 1000) { client.say(channel, `@${username} ¡Ese dado es demasiado grande, dearie! 🕷️`); return; }
    const rolls = Array.from({length: num}, () => Math.floor(Math.random() * sides) + 1);
    const total = rolls.reduce((a, b) => a + b, 0);
    const rollStr = num > 1 ? `[${rolls.join(', ')}] = ${total}` : `${total}`;
    client.say(channel, `🎲 @${username} tiró ${num}d${sides}: ${rollStr} 🕷️`);
    return;
  }

  // ── Acciones sociales ──
  const socialActions = {
    '!hug':    (u, t) => `🤗 @${u} le da un abrazo a @${t}! ♥`,
    '!pat':    (u, t) => `👋 @${u} le da palmaditas en la cabeza a @${t}! ☺️`,
    '!wave':   (u, t) => `👋 @${u} le saluda a @${t}!`,
    '!poke':   (u, t) => `👉 @${u} le da un toque a @${t}!`,
    '!kiss':   (u, t) => `💋 @${u} le manda un beso a @${t}! ♥`,
    '!slap':   (u, t) => `👋 @${u} le da una bofetada a @${t}! 💥`,
    '!bite':   (u, t) => `😈 @${u} le muerde a @${t}! 🕷️`,
    '!highfive':(u, t) => `🙌 @${u} le choca los cinco a @${t}!`,
  };
  if (socialActions[firstWord]) {
    const target = message.trim().split(' ')[1]?.replace('@','') || username;
    client.say(channel, socialActions[firstWord](username, target));
    return;
  }

  // ── Sorteo ──
  if (firstWord === '!sorteo') {
    if (!isSysCmdEnabled(channelName, 'sorteo')) return;
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
        const winnerMsg = await getMuffetResponse(channelName, `Anuncia que @${winner} ganó el sorteo. El premio es: ${raffle.prize}. IMPORTANTE: menciona el nombre @${winner} explícitamente.`, winner);
        client.say(channel, `@${winner} ${winnerMsg}`);
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
      } catch(e) { client.say(channel, `@${username} Error al consultar el sorteo~ 🕷️`); }
      return;
    }
  }

  // ── Entrar al sorteo ──
  const raffleConfig = channelConfigs[channelName];
  const joinCmd = (raffleConfig?.raffle_settings?.join_cmd || '!entrar').toLowerCase().trim();
  if (firstWord.toLowerCase() === joinCmd) {
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
      const participantWord = uniqueCount === 1 ? 'participante' : 'participantes';
      client.say(channel, `✅ @${username} ¡Entraste al sorteo!${entryMsg} Somos ${uniqueCount} ${participantWord} 🎉🕷️`);
    } catch(e) { client.say(channel, `@${username} Error al entrar al sorteo~ 🕷️`); }
    return;
  }

  // ── !redes automático ──
  if (firstWord === '!redes') {
    if (!isSysCmdEnabled(channelName, 'redes')) return;
    if (isPro(channelName)) {
      const BASE = process.env.BASE_URL || 'https://muffet-dashboard.onrender.com';
      client.say(channel, `🌐 Encuentra todas las redes de ${channelName} aquí: ${BASE}/canal/${channelName} 🕷️♥`);
    } else {
      const socials = formatSocials(config?.social_links || {});
      client.say(channel, socials ? `🌐 Redes de ${channelName}: ${socials} 🕷️♥` : `@${username} No hay redes configuradas aún~ 🕷️`);
    }
    return;
  }

  // ── !toprimerin ──
  if (firstWord === '!toprimerin') {
    if (!isSysCmdEnabled(channelName, 'primerin')) return;
    if (!isPro(channelName)) { proOnly(client, channel, username); return; }
    const ranking = Object.entries(config.primerin_config?.ranking || {})
      .sort(([,a],[,b]) => b-a).slice(0,5);
    if (!ranking.length) { client.say(channel, '🥇 Nadie ha ganado el primerin aún~ 🕷️'); return; }
    const medals = ['🥇','🥈','🥉','4️⃣','5️⃣'];
    const list = ranking.map(([user, wins], i) => `${medals[i]} ${user} (${wins}x)`).join(' | ');
    client.say(channel, `🏆 Top Primerin: ${list} 🕷️`);
    return;
  }

  // ── !emojigame — adivina la película/serie/videojuego con emojis ──
  if (firstWord === '!emojigame' || firstWord === '!emoji') {
    if (!isSysCmdEnabled(channelName, 'emojigame')) return;
    if (!isPro(channelName)) { proOnly(client, channel, username); return; }
    const egConfig = config.emojigame_config || {};
    if (egConfig.enabled === false) return;

    if (activeEmojiGames[channelName]) {
      client.say(channel, `🎮 Ya hay un reto activo: ${activeEmojiGames[channelName].emojis} — ¡adivínalo en el chat! 🕷️`);
      return;
    }

    const cooldownMs = (egConfig.cooldown_sec ?? 20) * 1000;
    const lastUsed = emojiGameCooldowns[channelName] || 0;
    if (Date.now() - lastUsed < cooldownMs) return;

    emojiGameCooldowns[channelName] = Date.now();

    const args = message.trim().split(' ');
    const categoryArg = (args[1] || '').toLowerCase();
    const configuredCategory = egConfig.category || 'random';
    const category = ['pelicula', 'serie', 'videojuego'].includes(categoryArg) ? categoryArg : configuredCategory;

    client.say(channel, `🎮 Pensando un reto de emojis~ 🕷️`);
    const challenge = await generateEmojiChallenge(channelName, category);
    if (!challenge) {
      client.say(channel, `@${username} No pude generar el reto, intenta de nuevo~ 🕷️`);
      return;
    }

    activeEmojiGames[channelName] = {
      emojis: challenge.emojis,
      title: challenge.title,
      startedAt: Date.now(),
      hintsUsed: 0,
    };

    const letterCount = challenge.title.replace(/\s/g, '').length;
    const wordCount = challenge.title.split(' ').length;
    const timeoutMin = (config.emojigame_config?.timeout_min ?? 2);
    const timeoutMs = timeoutMin * 60 * 1000;

    // Timer de tiempo límite — si nadie adivina, Muffet revela la respuesta
    if (emojiGameTimers[channelName]) clearTimeout(emojiGameTimers[channelName]);
    emojiGameTimers[channelName] = setTimeout(() => {
      if (!activeEmojiGames[channelName]) return;
      const game = activeEmojiGames[channelName];
      delete activeEmojiGames[channelName];
      delete emojiGameTimers[channelName];
      const cl = customClients[channelName] || mainClient;
      cl.say(`#${channelName}`, `⏰ ¡Se acabó el tiempo! La respuesta era: "${game.title}" 🕷️`);
    }, timeoutMs);

    client.say(channel, `🎬 ¡Adivina con emojis! ${challenge.emojis} — ${wordCount} palabra${wordCount>1?'s':''}, ${letterCount} letras. Tienen ${timeoutMin} minuto${timeoutMin>1?'s':''} ⏱️ (!emojihint para pista, !emojiskip para saltar) 🕷️`);
    return;
  }

  // ── !emojihint — dar una pista (cuesta puntos del saldo del usuario) ──
  if (firstWord === '!emojihint') {
    if (!isSysCmdEnabled(channelName, 'emojigame')) return;
    const game = activeEmojiGames[channelName];
    if (!game) { client.say(channel, `@${username} No hay ningún reto activo~ 🎮`); return; }

    const egConfigHint = config.emojigame_config || {};
    const hintCost = egConfigHint.hint_cost ?? 10;
    const userKeyHint = username.toLowerCase();

    if (hintCost > 0) {
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}&limit=1`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
        const data = await res.json();
        const pointsConfig = data?.[0]?.points_config || {};
        const ranking = pointsConfig.ranking || {};
        const currentPoints = ranking[userKeyHint] || 0;

        if (currentPoints < hintCost) {
          client.say(channel, `@${username} Necesitas ${hintCost} puntos para una pista — tienes ${currentPoints}~ 🕷️`);
          return;
        }

        ranking[userKeyHint] = currentPoints - hintCost;
        await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
          method: 'PATCH',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ points_config: { ...pointsConfig, ranking } })
        });
      } catch(e) {
        client.say(channel, `@${username} Error al cobrar la pista~ 🕷️`);
        return;
      }
    }

    game.hintsUsed++;
    const words = game.title.split(' ');
    const revealCount = game.hintsUsed; // cada pista revela una letra más por palabra
    const hint = words.map(w => {
      if (w.length <= 2) return w; // palabras muy cortas (de, la, el...) se muestran completas
      const visible = Math.min(revealCount, w.length - 1);
      return w.slice(0, visible) + '_'.repeat(w.length - visible);
    }).join(' ');
    client.say(channel, `💡 @${username} usó ${hintCost} puntos por una pista: ${hint} (${words.length} palabra${words.length>1?'s':''}) 🕷️`);
    return;
  }

  // ── !emojiskip — saltar el reto actual (mods) ──
  if (firstWord === '!emojiskip') {
    if (!isSysCmdEnabled(channelName, 'emojigame')) return;
    if (!isMod(tags, channelName)) return;
    const game = activeEmojiGames[channelName];
    if (!game) { client.say(channel, `@${username} No hay ningún reto activo~ 🎮`); return; }
    client.say(channel, `⏭️ Reto saltado — era "${game.title}" 🕷️`);
    delete activeEmojiGames[channelName];
    if (emojiGameTimers[channelName]) { clearTimeout(emojiGameTimers[channelName]); delete emojiGameTimers[channelName]; }
    return;
  }

  // ── Verificar si el mensaje es una respuesta correcta al emoji game activo ──
  if (activeEmojiGames[channelName] && !firstWord.startsWith('!')) {
    const game = activeEmojiGames[channelName];
    const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '').trim();
    const guess = normalize(message);
    const answer = normalize(game.title);

    if (guess === answer || (guess.length > 3 && answer.includes(guess) && guess.length >= answer.length * 0.7)) {
      delete activeEmojiGames[channelName];
      if (emojiGameTimers[channelName]) { clearTimeout(emojiGameTimers[channelName]); delete emojiGameTimers[channelName]; }
      const egConfig2 = config.emojigame_config || {};
      const points = egConfig2.base_points ?? 30;

      // Manejo de racha
      if (!emojiGameStreaks[channelName]) emojiGameStreaks[channelName] = {};
      const streaks = emojiGameStreaks[channelName];
      const userKeyStreak = username.toLowerCase();
      streaks[userKeyStreak] = (streaks[userKeyStreak] || 0) + 1;
      // Resetear racha de los demás usuarios
      Object.keys(streaks).forEach(u => { if (u !== userKeyStreak) streaks[u] = 0; });
      const currentStreak = streaks[userKeyStreak];

      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}&limit=1`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
        const data = await res.json();
        const pointsConfig = data?.[0]?.points_config || {};
        const ranking = pointsConfig.ranking || {};
        const userKey = username.toLowerCase();
        ranking[userKey] = (ranking[userKey] || 0) + points;
        await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
          method: 'PATCH',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ points_config: { ...pointsConfig, ranking } })
        });
      } catch(e) {}
      let winMsg = `🎉 ¡@${username} adivinó "${game.title}"! +${points} puntos~ 🕷️🎬`;
      if (currentStreak === 3) winMsg += ` 🔥 ¡Lleva 3 seguidas!`;
      else if (currentStreak === 5) winMsg += ` 🔥🔥 ¡5 seguidas! ¡Imparable!`;
      else if (currentStreak > 5) winMsg += ` 🔥🔥🔥 ¡${currentStreak} seguidas! ¡Campeón de emojis!`;
      client.say(channel, winMsg);
      return;
    }
  }

  // ── !primerin (comando configurable) — solo si el modo es 'command' ──
  const pConfig = config.primerin_config || {};
  const pMode = pConfig.mode || 'command';
  const pCmd = '!' + (pConfig.command || 'primerin').toLowerCase();
  if (pMode === 'command' && firstWord.toLowerCase() === pCmd) {
    if (!isSysCmdEnabled(channelName, 'primerin')) return;
    if (!isPro(channelName)) { proOnly(client, channel, username); return; }
    await processPrimerinWin(channelName, channel, client, username, pConfig);
    return;
  }

  // ── !duelo ──
  if (firstWord === '!duelo' || firstWord === '!duel') {
    if (!isSysCmdEnabled(channelName, 'duelo')) return;
    if (!isPro(channelName)) { proOnly(client, channel, username); return; }
    const pointsConfig = config.points_config || {};
    if (!pointsConfig.enabled) { client.say(channel, `@${username} El sistema de puntos no está activo~ 🕷️`); return; }

    const parts = message.trim().split(' ');
    const target = parts[1]?.replace('@','').toLowerCase();
    const amount = parseInt(parts[2]);
    const emoji = pointsConfig.emoji || '🏆';
    const name = pointsConfig.name || 'puntos';

    if (!target || !amount || amount < 1) {
      client.say(channel, `@${username} Uso: !duelo @usuario cantidad — Ej: !duelo @wolf 100 🕷️`);
      return;
    }
    if (target === username.toLowerCase()) {
      client.say(channel, `@${username} ¡No puedes retarte a ti mismo, dearie! 🕷️`);
      return;
    }

    const viewerPoints = channelConfigs[channelName].viewer_points || {};
    const challengerPoints = viewerPoints[username.toLowerCase()] || 0;
    const targetPoints = viewerPoints[target] || 0;

    if (challengerPoints < amount) {
      client.say(channel, `@${username} No tienes suficientes ${name}! Tienes ${challengerPoints} ${emoji} 🕷️`);
      return;
    }
    if (targetPoints < amount) {
      client.say(channel, `@${username} @${target} no tiene suficientes ${name} para el duelo~ 🕷️`);
      return;
    }

    // Duelo — 50/50
    const challengerWins = Math.random() < 0.5;
    const winner = challengerWins ? username : target;
    const loser = challengerWins ? target : username;

    viewerPoints[winner.toLowerCase()] = (viewerPoints[winner.toLowerCase()] || 0) + amount;
    viewerPoints[loser.toLowerCase()] = Math.max(0, (viewerPoints[loser.toLowerCase()] || 0) - amount);
    channelConfigs[channelName].viewer_points = viewerPoints;

    fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewer_points: viewerPoints })
    }).catch(() => {});

    const prompt = `¡Duelo de puntos! @${username} retó a @${target} por ${amount} ${name}. ¡Ganó @${winner}! Anúncialo emocionado con tu personalidad en máximo 2 oraciones.`;
    const msg = await getMuffetResponse(channelName, prompt, username);
    client.say(channel, `⚔️ ${msg}`);
    return;
  }

  // ── !8ball ──
  if (firstWord === '!8ball' || firstWord === '!bola8') {
    if (!isSysCmdEnabled(channelName, 'bola8')) return;
    const question = message.trim().slice(firstWord.length).trim();
    if (!question) { client.say(channel, `@${username} ¡Hazme una pregunta! Ej: !8ball ¿Ganaré hoy? 🎱🕷️`); return; }
    const response = await getMuffetResponse(channelName,
      `El usuario @${username} pregunta a la bola mágica: "${question}". Da una respuesta corta y misteriosa de la bola 8 mágica. Puede ser positiva, negativa o ambigua. Usa tu personalidad. Máximo 1 oración.`,
      username);
    client.say(channel, `🎱 @${username} ${response}`);
    return;
  }

  // ── !yt ──

  // ── !ytskip ──
  // ── !ytactual — ver qué suena ahora ──
  if (firstWord === '!ytactual' || firstWord === '!ytnow') {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      const data = await res.json();
      const ytConfig = data?.[0]?.youtube_config || {};
      if (!ytConfig.enabled) { client.say(channel, `@${username} YouTube está desactivado ahora mismo~ 🎵`); return; }
      const queue = ytConfig.queue || [];
      const playlist = ytConfig.playlist_url;
      if (queue.length > 0) {
        const current = queue[0];
        client.say(channel, `▶ Sonando: "${current.title}" pedido por @${current.requestedBy||'?'} 🎵`);
      } else if (playlist) {
        client.say(channel, `▶ Sonando la playlist base del streamer 🎵`);
      } else {
        client.say(channel, `🎵 No hay nada sonando ahora~ 🎵`);
      }
    } catch(e) { client.say(channel, `@${username} Error al consultar la música~ 🎵`); }
    return;
  }

  // ── !ytnext — forzar canción del viewer inmediatamente ──
  if (firstWord === '!ytnext') {
    if (!isMod(tags, channelName)) { client.say(channel, `@${username} Solo los mods pueden usar !ytnext~ 🎵`); return; }
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      const data = await res.json();
      const ytConfig = data?.[0]?.youtube_config || {};
      const queue = ytConfig.queue || [];
      if (!queue.length) { client.say(channel, `🎵 No hay canciones de viewers en cola~ 🎵`); return; }
      await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtube_config: { ...ytConfig, force_next: true } })
      });
      client.say(channel, `⏭️ @${username} activó la próxima canción — "${queue[0].title}" sonará ahora~ 🎵`);
    } catch(e) { client.say(channel, `@${username} Error al cambiar canción~ 🎵`); }
    return;
  }

  if (firstWord === '!ytskip') {
    if (!isMod(tags, channelName)) { client.say(channel, `@${username} Solo los mods pueden saltar canciones~ 🎵`); return; }
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      const data = await res.json();
      const ytConfig = data?.[0]?.youtube_config || {};
      const queue = ytConfig.queue || [];
      if (!queue.length) { client.say(channel, `🎵 La cola de YouTube está vacía~ 🎵`); return; }
      const removed = queue.shift();
      // Liberar el slot del límite del usuario que pidió la canción
      const limits = ytConfig.song_limits || {};
      const requester = removed.requestedBy;
      if (requester && limits[requester]) {
        limits[requester] = limits[requester].filter(s => s.uri !== removed.videoId);
        if (limits[requester].length === 0) delete limits[requester];
      }
      await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}`, {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtube_config: { ...ytConfig, queue, song_limits: limits } })
      });
      client.say(channel, `⏭️ @${username} saltó "${removed.title}"~ 🎵`);
    } catch(e) { client.say(channel, `@${username} Error al saltar~ 🎵`); }
    return;
  }

  // ── !ytcola ──
  if (firstWord === '!ytcola' || firstWord === '!ytqueue') {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${channelName}&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      const data = await res.json();
      const queue = data?.[0]?.youtube_config?.queue || [];
      if (!queue.length) { client.say(channel, `🎵 La cola de YouTube está vacía~ 🎵`); return; }
      const list = queue.slice(0,5).map((v,i) => `${i+1}. ${v.title} (@${v.requestedBy||'?'})`).join(' | ');
      client.say(channel, `▶ Cola YouTube (${queue.length}): ${list} 🎵`);
    } catch(e) { client.say(channel, `@${username} Error al obtener la cola~ 🎵`); }
    return;
  }



  if (firstWord === '!ask' || firstWord === '!pregunta') {
    if (!isSysCmdEnabled(channelName, 'ask')) return;
    if (!config.ai_enabled) { client.say(channel, `@${username} ¡La IA está descansando, dearie! 🕷️`); return; }
    const question = message.trim().slice(firstWord.length).trim();
    if (!question) { client.say(channel, `¡${username}, dearie! Escribe: !ask ¿tu pregunta? 🕷️`); return; }
    // Cooldown por usuario — 30 segundos
    if (hasUserCooldown(channelName, username) && !isMod(tags, channelName)) {
      const secs = getCooldownRemaining(channelName, username);
      client.say(channel, `@${username} Espera ${secs}s antes de volver a preguntar~ 🕷️`);
      return;
    }
    setUserCooldown(channelName, username);
    const response = await getMuffetResponse(channelName, question, username);
    botSay(client, channel, `@${username} ${response}`);
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

    const args = message.trim().split(/\s+/).slice(1).filter(Boolean);
    const touser = args[0] ? args[0].replace('@', '').trim() : username;
    const resolved = await resolveVariables(response, channelName, username, touser);
    client.say(channel, resolved);
    return;
  }

  // ── Menciones al bot directamente — sin cooldown, es conversación ──
  const botUsername = (channelConfigs[channelName]?.custom_bot_username || TWITCH_BOT_USERNAME).toLowerCase();
  if (msgLower.includes(`@${botUsername}`) && !msgLower.startsWith('!')) {
    if (!config.ai_enabled) return;
    const question = message.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim();
    const response = await getMuffetResponse(channelName, question || '¡Hola!', username);
    botSay(client, channel, `@${username} ${response}`, true); // conversación = sin cooldown
    return;
  }
}

// ══════════════════════════════════════════
//  EVENTOS ESPECIALES
// ══════════════════════════════════════════
function setupEvents(client) {
  client.on('message', (channel, tags, message, self) => handleMessage(client, channel, tags, message, self));

  client.on('raided', async (channel, username, viewers) => {
    const ch = channel.replace('#','');
    if (customClients[ch] && customClients[ch] !== client) return; // el bot propio del canal maneja sus eventos
    if (muffetActiveMap[ch] === false || muffetSilentMap[ch]) return;
    // Suprimir saludos individuales por 90s — que Muffet reciba a la raid en conjunto, no raider por raider
    raidSuppressGreetings[ch] = Date.now() + 90000;
    // El saludo de raid NO usa canAiRespond — es un evento importante y no debe perderse por el cooldown
    const msg = await getMuffetResponse(ch, `¡${username} acaba de hacer raid con ${viewers} personas! Recíbelos con mucha energía.`, username);
    botSay(client, channel, msg, true);
  });

  client.on('subscription', async (channel, username, methods) => {
    const ch = channel.replace('#','');
    if (customClients[ch] && customClients[ch] !== client) return;
    if (muffetActiveMap[ch] === false || muffetSilentMap[ch]) return;
    const tier = methods?.plan === '3000' ? 'Tier 3' : methods?.plan === '2000' ? 'Tier 2' : 'Tier 1';
    // Sin canAiRespond — las subs son eventos importantes y no deben perderse por el cooldown
    const msg = await getMuffetResponse(ch, `@${username} acaba de suscribirse al canal (${tier}). Agradécele con entusiasmo.`, username);
    botSay(client, channel, msg, true);
  });

  client.on('resub', async (channel, username, months) => {
    const ch = channel.replace('#','');
    if (customClients[ch] && customClients[ch] !== client) return;
    if (muffetActiveMap[ch] === false || muffetSilentMap[ch]) return;
    const msg = await getMuffetResponse(ch, `@${username} lleva ${months} meses suscrito al canal. Agradécele su lealtad.`, username);
    botSay(client, channel, msg, true);
  });

  // Sub gift individual
  // Buffer para ignorar subgift individuales cuando son parte de un mystery gift
  const mysteryGiftBuffer = {}; // { 'ch_username': timestamp }

  client.on('submysterygift', async (channel, username, numbOfSubs) => {
    const ch = channel.replace('#','');
    if (customClients[ch] && customClients[ch] !== client) return;
    if (muffetActiveMap[ch] === false || muffetSilentMap[ch]) return;
    // Marcar que este usuario está haciendo mystery gift — ignorar subgifts individuales por 10s
    mysteryGiftBuffer[`${ch}_${username}`] = Date.now();
    const msg = await getMuffetResponse(ch, `@${username} acaba de regalar ${numbOfSubs} suscripcion${numbOfSubs>1?'es':''} al canal. Menciona su nombre y el número exacto (${numbOfSubs}), y agradécele efusivamente.`, username);
    botSay(client, channel, msg, true);
  });

  client.on('subgift', async (channel, username, recipient, methods) => {
    const ch = channel.replace('#','');
    if (customClients[ch] && customClients[ch] !== client) return;
    if (muffetActiveMap[ch] === false || muffetSilentMap[ch]) return;
    if (username === 'ananonymousgifter') return;
    // Si es parte de un mystery gift reciente, ignorar
    const bufferKey = `${ch}_${username}`;
    if (mysteryGiftBuffer[bufferKey] && Date.now() - mysteryGiftBuffer[bufferKey] < 10000) return;
    // Si recipient es inválido ignorar
    if (!recipient || recipient === '0' || recipient === 'anonymous') return;
    const msg = await getMuffetResponse(ch, `@${username} le acaba de regalar una suscripción a @${recipient}. Menciona los dos nombres y agradécele lo generoso que es.`, username);
    botSay(client, channel, msg, true);
  });

  // Bits
  client.on('cheer', async (channel, tags, message) => {
    const ch = channel.replace('#','');
    if (customClients[ch] && customClients[ch] !== client) return;
    if (muffetActiveMap[ch] === false || muffetSilentMap[ch]) return;
    const username = tags.username;
    const bits = tags.bits;
    const msg = await getMuffetResponse(ch, `@${username} acaba de donar ${bits} bits al canal. Agradécele con entusiasmo.`, username);
    botSay(client, channel, msg, true);
  });
}

// ══════════════════════════════════════════
//  CLIENTES PERSONALIZADOS POR CANAL (Plan Pro)
// ══════════════════════════════════════════
let customClients = {}; // { 'canal': tmiClient }

async function setupCustomBots() {
  for (const [ch, config] of Object.entries(channelConfigs)) {
    if (config.plan === 'pro' && config.custom_bot_username && config.custom_bot_token) {
      if (customClients[ch]) {
        // Ya conectado — asegurarse que mainClient salió
        try { await mainClient.part(`#${ch}`); } catch(e) {}
        continue;
      }
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
        setTimeout(async () => {
          try { await mainClient.part(`#${ch}`); console.log(`👋 muffet_osoking salió de #${ch}`); } catch(e) {}
        }, 2000);
      } catch (err) {
        console.error(`Error conectando bot personalizado para ${ch}:`, err.message);
      }
    }
  }
}

// ══════════════════════════════════════════
//  ARRANQUE PRINCIPAL
// ══════════════════════════════════════════
// ── CHECK PLANES EXPIRADOS — cada 6 horas ──
async function checkExpiredPlans() {
  try {
    const now = new Date().toISOString();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/streamers?plan=eq.pro&plan_expires_at=lt.${now}&select=twitch_username,twitch_id`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const expired = await res.json();
    if (!Array.isArray(expired) || !expired.length) return;
    for (const s of expired) {
      await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_id=eq.${s.twitch_id}`, {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'free', plan_expires_at: null, lemon_subscription_id: null })
      });
      console.log(`[Plans] ❌ Plan expirado y desactivado para ${s.twitch_username}`);
    }
  } catch(e) { console.error('[Plans] Error checking expired:', e.message); }
}

setInterval(checkExpiredPlans, 6 * 60 * 60 * 1000); // cada 6 horas
checkExpiredPlans(); // al iniciar

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

  // Iniciar polling de ganadores de sorteo
  setInterval(checkRaffleWinners, 10000);

  // Iniciar polling de stream en vivo (cada 60s)
  setInterval(checkStreamsLive, 60000);

  // Rastrear última actividad del chat por canal
  const lastChatActivity = {};

  // Cola anti-spam para auto mensajes
  const autoMsgQueue = {};
  const lastAutoMsgSentAt = {}; // { ch: timestamp } — para evitar que varios mensajes coincidan
  const MIN_GAP_BETWEEN_AUTO_MSGS = 5 * 60 * 1000; // 5 minutos mínimo entre cualquier mensaje automático

  async function processAutoMsgQueue(ch) {
    if (autoMsgQueue[ch]?.processing) return;
    if (!autoMsgQueue[ch]?.items?.length) return;
    autoMsgQueue[ch].processing = true;
    while (autoMsgQueue[ch].items.length > 0) {
      const { text, channelName } = autoMsgQueue[ch].items.shift();
      const client = customClients[channelName] || mainClient;
      try {
        client.say(`#${channelName}`, text).catch(() => {});
      } catch(e) {
        client.say(`#${channelName}`, text).catch(() => {});
      }
      lastAutoMsgSentAt[ch] = Date.now();
      if (autoMsgQueue[ch].items.length > 0) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    autoMsgQueue[ch].processing = false;
  }

  // Auto mensajes por canal con timer individual por mensaje
  const autoMsgIntervals = {};

  const autoMsgSignatures = {}; // { ch: 'json de auto_messages' } para detectar cambios

  // ── Reto automático de Emoji Game ──
  function scheduleEmojiAutoGames() {
    for (const [ch, config] of Object.entries(channelConfigs)) {
      const egConfig = config.emojigame_config || {};
      const autoMin = egConfig.auto_interval_min;
      const enabled = egConfig.enabled !== false && egConfig.auto_enabled && autoMin > 0;

      if (emojiAutoTimers[ch]) { clearInterval(emojiAutoTimers[ch]); delete emojiAutoTimers[ch]; }
      if (!enabled || !isPro(ch)) continue;

      emojiAutoTimers[ch] = setInterval(async () => {
        if (muffetActiveMap[ch] === false || muffetSilentMap[ch]) return;
        if (activeEmojiGames[ch]) return; // ya hay un reto activo
        const lastActivity = lastChatActivity[ch];
        if (!lastActivity || Date.now() - lastActivity > 10 * 60 * 1000) return; // chat inactivo
        const client2 = customClients[ch] || mainClient;
        const category = egConfig.category || 'random';
        client2.say(`#${ch}`, `🎮 Pensando un reto de emojis~ 🕷️`);
        const challenge = await generateEmojiChallenge(ch, category);
        if (!challenge) return;
        const timeoutMin = egConfig.timeout_min ?? 2;
        const letterCount = challenge.title.replace(/\s/g, '').length;
        const wordCount = challenge.title.split(' ').length;
        activeEmojiGames[ch] = { emojis: challenge.emojis, title: challenge.title, startedAt: Date.now(), hintsUsed: 0 };
        if (emojiGameTimers[ch]) clearTimeout(emojiGameTimers[ch]);
        emojiGameTimers[ch] = setTimeout(() => {
          if (!activeEmojiGames[ch]) return;
          const game = activeEmojiGames[ch];
          delete activeEmojiGames[ch]; delete emojiGameTimers[ch];
          client2.say(`#${ch}`, `⏰ ¡Se acabó el tiempo! La respuesta era: "${game.title}" 🕷️`);
        }, timeoutMin * 60 * 1000);
        client2.say(`#${ch}`, `🎬 ¡Adivina con emojis! ${challenge.emojis} — ${wordCount} palabra${wordCount>1?'s':''}, ${letterCount} letras. Tienen ${timeoutMin} minuto${timeoutMin>1?'s':''} ⏱️ (!emojihint para pista, !emojiskip para saltar) 🕷️`);
      }, autoMin * 60 * 1000);
    }
  }

  function scheduleAutoMessages() {
    for (const [ch, config] of Object.entries(channelConfigs)) {
      const signature = JSON.stringify(config.auto_messages || []);

      // Solo recrear timers si la config cambió
      if (autoMsgSignatures[ch] === signature) continue;
      autoMsgSignatures[ch] = signature;

      // Limpiar timers anteriores
      if (autoMsgIntervals[ch]?.length) {
        autoMsgIntervals[ch].forEach(t => clearInterval(t));
      }
      autoMsgIntervals[ch] = [];

      if (!config.auto_messages?.length) continue;

      config.auto_messages.forEach((msg, idx) => {
        const text     = typeof msg === 'object' ? msg.text     : msg;
        const interval = typeof msg === 'object' ? msg.interval : (config.auto_message_interval || 20);
        const intervalMs = Math.max(interval, 5) * 60 * 1000;
        // Escalonar el inicio de cada mensaje para que no coincidan todos al mismo tiempo
        const staggerDelay = idx * 45 * 1000; // 45s de diferencia entre cada uno al iniciar

        const startTimer = setTimeout(() => {
          const timer = setInterval(async () => {
            if (muffetActiveMap[ch] === false) return;
            if (muffetSilentMap[ch]) return;
            const lastActivity = lastChatActivity[ch];
            if (lastActivity && Date.now() - lastActivity > 10 * 60 * 1000) return;
            // Respetar gap mínimo entre cualquier mensaje automático de este canal
            const lastSent = lastAutoMsgSentAt[ch] || 0;
            if (Date.now() - lastSent < MIN_GAP_BETWEEN_AUTO_MSGS) return;
            if (!autoMsgQueue[ch]) autoMsgQueue[ch] = { items: [], processing: false };
            autoMsgQueue[ch].items.push({ text, channelName: ch });
            processAutoMsgQueue(ch);
          }, intervalMs);
          autoMsgIntervals[ch].push(timer);
        }, staggerDelay);

        autoMsgIntervals[ch].push(startTimer);
      });
    }
  }

  // Registrar actividad del chat
  mainClient.on('message', (channel) => {
    const ch = channel.replace('#','');
    lastChatActivity[ch] = Date.now();
  });
  Object.values(customClients).forEach(c => {
    c.on('message', (channel) => {
      lastChatActivity[channel.replace('#','')] = Date.now();
    });
  });

  scheduleAutoMessages();
  scheduleEmojiAutoGames();

  // Recargar config cada 30 segundos
  setInterval(async () => {
    await loadAllChannels();
    await setupCustomBots();
    scheduleAutoMessages();
    scheduleEmojiAutoGames();
    const currentChannels = mainClient.getChannels().map(c => c.replace('#',''));
    const allChannels = Object.keys(channelConfigs);
    for (const ch of allChannels) {
      if (!currentChannels.includes(ch) && !customClients[ch]) {
        try { await mainClient.join(ch); console.log(`✅ Nuevo canal unido: ${ch}`); } catch(e) {}
      }
    }
  }, 30 * 1000);
}

// ── Handler de eventos de Twitch (follows, subs, bits) ──
async function handleTwitchEvent(type, event) {
  // ── Ganador del sorteo desde el dashboard ──
  if (type === 'raffle.redemption') {
    const { channel, username, count } = event;
    if (!channel) return;
    const client2 = customClients[channel] || mainClient;
    client2.say(`#${channel}`, `✅ @${username} ¡Canjeaste tu entrada al sorteo! Somos ${count} participantes 🎉🕷️`);
    return;
  }

  // ── Ganador de Primerin por canje ──
  if (type === 'primerin.redemption') {
    const { channel, username, wins, message } = event;
    if (!channel) return;
    const client2 = customClients[channel] || mainClient;
    let msg;
    if (message) {
      msg = message.replace(/\{user\}/g, `@${username}`).replace(/\{wins\}/g, wins);
    } else {
      try {
        msg = await getMuffetResponse(channel, `¡@${username} llegó primero al stream hoy! Lleva ${wins} vez${wins>1?'es':''} siendo el primero. Anúncialo emocionado con tu personalidad.`, username);
      } catch(e) {
        msg = `🥇 ¡@${username} fue el primero! Lleva ${wins} victoria${wins>1?'s':''} 🕷️`;
      }
    }
    client2.say(`#${channel}`, msg);
    return;
  }

  if (type === 'raffle.winner') {
    const channelName = event.broadcaster_user_login?.toLowerCase();
    if (!channelName) return;
    const client = customClients[channelName] || mainClient;
    try {
      const winnerMsg = await getMuffetResponse(channelName, `¡Anuncia emocionado que @${event.winner} ganó el sorteo! El premio es: ${event.prize}. Sé entusiasta y usa tu personalidad.`, event.winner);
      client.say(`#${channelName}`, `@${event.winner} ${winnerMsg}`);
    } catch(e) {
      client.say(`#${channelName}`, `🎉 ¡El ganador del sorteo es @${event.winner}! Premio: ${event.prize} 🏆🕷️`);
    }
    return;
  }
  const channelName = event.broadcaster_user_login?.toLowerCase();
  if (!channelName || !channelConfigs[channelName]) return;

  const client = customClients[channelName] || mainClient;
  if (muffetActiveMap[channelName] === false) return;

  try {
    let prompt = '';
    if (type === 'channel.follow') {
      const user = event.user_name;
      prompt = `@${user} acaba de seguir el canal. Agradécele brevemente con tu personalidad.`;
    } else if (type === 'channel.subscribe') {
      const user = event.user_name;
      const tier = event.tier === '3000' ? 'Tier 3' : event.tier === '2000' ? 'Tier 2' : 'Tier 1';
      prompt = `@${user} se acaba de suscribir al canal (${tier}). Agradécele emocionado con tu personalidad.`;
    } else if (type === 'channel.subscription.gift') {
      const user = event.user_name || 'Alguien anónimo';
      const total = event.total || 1;
      prompt = `@${user} regaló ${total} suscripcion${total>1?'es':''} al canal. Agradécele efusivamente con tu personalidad.`;
    } else if (type === 'channel.cheer') {
      const user = event.user_name;
      const bits = event.bits;
      prompt = `@${user} donó ${bits} bits al canal. Agradécele con entusiasmo con tu personalidad.`;
    }

    if (prompt) {
      const response = await getMuffetResponse(channelName, prompt, 'sistema');
      client.say(`#${channelName}`, response);
    }
  } catch(e) {}
}

// ── Polling de ganadores de sorteo ──
const announcedWinners = {};

async function checkRaffleWinners() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/streamers?approved=eq.true&select=twitch_username,raffle_active`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const streamers = await res.json();
    if (!Array.isArray(streamers)) return;
    for (const s of streamers) {
      const ch = s.twitch_username?.toLowerCase();
      const raffle = s.raffle_active;
      if (!ch || !raffle?.winner || raffle.active) continue;
      const winnerId = `${ch}_${raffle.winner}_${raffle.ended_at||''}`;
      if (announcedWinners[ch] === winnerId) continue;
      announcedWinners[ch] = winnerId;
      if (!channelConfigs[ch]) continue;
      const client = customClients[ch] || mainClient;
      try {
        const msg = await getMuffetResponse(ch, `Anuncia que @${raffle.winner} ganó el sorteo. El premio es: ${raffle.prize}. IMPORTANTE: menciona el nombre @${raffle.winner} explícitamente en tu respuesta.`, raffle.winner);
        client.say(`#${ch}`, `@${raffle.winner} ${msg}`);
      } catch(e) {
        client.say(`#${ch}`, `🎉 ¡El ganador del sorteo es @${raffle.winner}! Premio: ${raffle.prize} 🏆🕷️`);
      }
    }
  } catch(e) {}
}

// ── Polling de stream en vivo ──
const streamLiveMap = {}; // { channelName: true/false } — si estaba en vivo

async function checkStreamsLive() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/streamers?approved=eq.true&select=twitch_username,live_announcement,plan`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const streamers = await res.json();
    if (!Array.isArray(streamers) || !streamers.length) return;

    const appToken = await getTwitchAppToken();
    if (!appToken) return;

    // Helix permite hasta 100 user_login por consulta — una sola llamada para todos los canales
    const channels = streamers.map(s => s.twitch_username?.toLowerCase()).filter(Boolean);
    const liveByChannel = {};
    for (let i = 0; i < channels.length; i += 100) {
      const batch = channels.slice(i, i + 100);
      const query = batch.map(ch => `user_login=${ch}`).join('&');
      try {
        const streamRes = await fetch(`https://api.twitch.tv/helix/streams?${query}`, {
          headers: { 'Authorization': `Bearer ${appToken}`, 'Client-Id': process.env.TWITCH_CLIENT_ID }
        });
        const data = await streamRes.json();
        (data.data || []).forEach(stream => { liveByChannel[stream.user_login.toLowerCase()] = stream; });
      } catch(e) {}
    }

    for (const s of streamers) {
      const ch = s.twitch_username?.toLowerCase();
      if (!ch) continue;
      const stream = liveByChannel[ch];
      const isLive = !!stream;
      if (!isLive) continue;

      const liveConfig = s.live_announcement || {};
      // Comparar con la fecha de inicio guardada en Supabase — sobrevive a reinicios del bot.
      // Si started_at es el mismo de la última vez, NO es un stream nuevo (solo el bot se reinició).
      if (liveConfig.last_seen_started_at === stream.started_at) continue;

      // Stream genuinamente nuevo — actualizar Supabase para no repetir tras el próximo reinicio
      await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${ch}`, {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ live_announcement: { ...liveConfig, last_seen_started_at: stream.started_at } })
      }).catch(() => {});
      if (channelConfigs[ch]) channelConfigs[ch].live_announcement = { ...liveConfig, last_seen_started_at: stream.started_at };

      greetedMap[ch] = new Set([ch.toLowerCase()]); // nuevo stream — reiniciar saludos (broadcaster pre-marcado)
      fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${ch}`, {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ greeted_users: [ch.toLowerCase()] })
      }).catch(() => {});

      // El anuncio en chat solo se manda si tiene la función Pro activada
      if (liveConfig.enabled && s.plan === 'pro') {
        const client = customClients[ch] || mainClient;
        const game = stream.game_name || '?';
        const title = stream.title || '';
        const customMsg = liveConfig.message || '';
        const msg = customMsg
          ? customMsg.replace(/\{game\}/g, game).replace(/\{title\}/g, title).replace(/\{channel\}/g, ch)
          : `🔴 ¡@${ch} está en vivo! 🎮 ${game}${title ? ` — ${title}` : ''} 🕷️👑`;
        client.say(`#${ch}`, msg);
      }
    }
  } catch(e) {}
}
// ── Servidor HTTP para recibir eventos del dashboard ──
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/event') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.secret !== BOT_SECRET) { console.log(`[event] Secret incorrecto — recibido: "${data.secret}" esperado: "${BOT_SECRET}"`); res.writeHead(403); res.end(); return; }
        console.log(`[event] Evento recibido: ${data.type}`);
        handleTwitchEvent(data.type, data.event).catch(e => console.error('[event]', e.message));
        res.writeHead(200); res.end('ok');
      } catch(e) { res.writeHead(400); res.end(); }
    });
  } else if (req.url === '/health') {
    res.writeHead(200); res.end('ok');
  } else {
    res.writeHead(404); res.end();
  }
});

server.listen(BOT_PORT, () => console.log(`🌐 Bot HTTP server en puerto ${BOT_PORT}`));

start().catch(console.error);
