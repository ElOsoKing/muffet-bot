const tmi = require('tmi.js');
const Groq = require('groq-sdk');

// ══════════════════════════════════════════
//  CONFIGURACIÓN
// ══════════════════════════════════════════
const TWITCH_BOT_USERNAME = process.env.TWITCH_BOT_USERNAME;
const TWITCH_OAUTH_TOKEN  = process.env.TWITCH_OAUTH_TOKEN;
const TWITCH_CHANNEL      = process.env.TWITCH_CHANNEL;
const GROQ_API_KEY        = process.env.GROQ_API_KEY;
const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_KEY        = process.env.SUPABASE_KEY;

const groq = new Groq({ apiKey: GROQ_API_KEY });

// ══════════════════════════════════════════
//  CONFIG EN MEMORIA (se actualiza desde Supabase)
// ══════════════════════════════════════════
let config = {
  bot_prompt: `Eres Muffet, la araña de Undertale y guardiana de la cueva del Rey Oso. Los viewers son "súbditos del reino". Hablas en español, eres coqueta y misteriosa. Usas emojis 🕷️ 🐻 👑 ♥. Respuestas cortas (máximo 2 oraciones).`,
  commands: {
    '!miel': '🍯🐻 ¡El Rey Oso tiene miel fresca para todos sus súbditos! ♥',
    '!té': '☕🕷️ ¡Aquí tienes tu té de araña con miel especial, dearie! 🐻♥',
    '!redes': '🐻👑 Síguenos en Twitch y redes sociales! 🕷️♥',
    '!cueva': '🐻🕷️ ¡Bienvenido a la Cueva del Rey! 👑♥',
    '!muffet': '🕷️ ¡Soy Muffet, la guardiana de la cueva del Rey Oso! 🐻👑♥',
    '!comandos': '🕷️👑 Comandos: !miel !té !redes !cueva !muffet !ask 🐻♥',
  },
  auto_messages: [
    '🐻👑 ¡Recuerden seguir el canal, súbditos! 🕷️♥',
    '🍯🕷️ ¡Escribe !miel o !té para recibir tu regalo! 🐻',
    '👑🕷️ ¿Preguntas? ¡Usa !ask y Muffet responde! 🐻♥',
  ],
  ai_enabled: true,
  mod_enabled: false,
  banned_words: [],
  warn_message: '⚠️ Cuidado, dearie~ 🕷️ Esa palabra no se usa en la cueva del Rey.',
};

// ══════════════════════════════════════════
//  CARGAR CONFIG DESDE SUPABASE
// ══════════════════════════════════════════
async function loadConfig() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${TWITCH_CHANNEL}&limit=1`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        }
      }
    );
    const data = await res.json();
    if (data && data[0]) {
      const row = data[0];
      if (row.bot_prompt)    config.bot_prompt    = row.bot_prompt;
      if (row.commands)      config.commands      = row.commands;
      if (row.auto_messages) config.auto_messages = row.auto_messages;
      if (row.ai_enabled     !== undefined) config.ai_enabled   = row.ai_enabled;
      if (row.mod_enabled    !== undefined) config.mod_enabled  = row.mod_enabled;
      if (row.banned_words)  config.banned_words  = row.banned_words;
      if (row.warn_message)  config.warn_message  = row.warn_message;
      console.log('🐻🕷️ Config cargada desde Supabase para:', TWITCH_CHANNEL);
    } else {
      console.log('⚠️ No se encontró config en Supabase, usando defaults');
    }
  } catch (err) {
    console.error('Error cargando config:', err.message);
  }
}

// Recargar config cada 2 minutos
setInterval(loadConfig, 2 * 60 * 1000);

// ══════════════════════════════════════════
//  IA DE MUFFET
// ══════════════════════════════════════════
async function getMuffetResponse(userMessage, username) {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama3-8b-8192',
      messages: [
        { role: 'system', content: config.bot_prompt },
        { role: 'user', content: `El usuario "${username}" dice: ${userMessage}` }
      ],
      max_tokens: 150,
      temperature: 0.85,
    });
    return completion.choices[0]?.message?.content || '¡Dearie, algo salió mal en la cueva! 🐻🕷️';
  } catch (err) {
    console.error('Error Groq:', err.message);
    return '¡Las telarañas de la cueva se enredaron, dearie! 🕷️';
  }
}

// ══════════════════════════════════════════
//  SALUDOS
// ══════════════════════════════════════════
const greeted = new Set();
const welcomePhrases = [
  (u) => `¡${u} ha llegado a la cueva del Rey Oso! 🐻🕷️ ¡Bienvenido/a al reino, dearie! ♥`,
  (u) => `¡Oh, una nueva alma! ¡Bienvenid@ ${u}! 👑🕷️ ¡El Rey Oso te saluda! 🐻♥`,
  (u) => `¡${u} entró a la cueva! 🐻 ¡Aquí nadie se va sin disfrutar, dearie! 🕷️♥`,
  (u) => `¡Mmmm, ${u}! ¡Un nuevo súbdito del reino! 👑 ¡Tengo té con miel, dearie! 🐻🕷️♥`,
  (u) => `¡${u} fue atrapado/a por las telarañas! 🕷️🐻 ¡Bienvenid@ para siempre, dearie! 👑♥`,
];

// ══════════════════════════════════════════
//  CLIENTE DE TWITCH
// ══════════════════════════════════════════
const client = new tmi.Client({
  options: { debug: true },
  identity: {
    username: TWITCH_BOT_USERNAME,
    password: TWITCH_OAUTH_TOKEN,
  },
  channels: [TWITCH_CHANNEL],
});

client.connect().then(async () => {
  console.log(`🐻🕷️ MuffetBot conectada a #${TWITCH_CHANNEL}`);
  await loadConfig();

  // Auto mensajes
  setInterval(() => {
    if (config.auto_messages && config.auto_messages.length > 0) {
      const msg = config.auto_messages[Math.floor(Math.random() * config.auto_messages.length)];
      client.say(TWITCH_CHANNEL, msg);
    }
  }, 20 * 60 * 1000);

}).catch(console.error);

// ══════════════════════════════════════════
//  MENSAJES DEL CHAT
// ══════════════════════════════════════════
client.on('message', async (channel, tags, message, self) => {
  if (self) return;

  const username = tags['display-name'] || tags.username;
  const msgLower = message.trim().toLowerCase();
  const firstWord = msgLower.split(' ')[0];

  // Saludo nuevo viewer
  if (!greeted.has(username.toLowerCase())) {
    greeted.add(username.toLowerCase());
    const phrase = welcomePhrases[Math.floor(Math.random() * welcomePhrases.length)];
    setTimeout(() => client.say(channel, phrase(username)), 2000);
  }

  // Moderación
  if (config.mod_enabled && config.banned_words && config.banned_words.length > 0) {
    const hasBadWord = config.banned_words.some(w => msgLower.includes(w.toLowerCase()));
    if (hasBadWord) {
      client.say(channel, `@${username} ${config.warn_message}`);
      return;
    }
  }

  // Comando !ask / !pregunta
  if (firstWord === '!ask' || firstWord === '!pregunta') {
    if (!config.ai_enabled) {
      client.say(channel, `@${username} ¡La IA está descansando, dearie! 🕷️ Inténtalo más tarde~ 🐻`);
      return;
    }
    const question = message.trim().slice(firstWord.length).trim();
    if (!question) {
      client.say(channel, `¡${username}, dearie! Escribe así: !ask ¿Cuánta miel tiene el Rey Oso? 🐻🕷️`);
      return;
    }
    const response = await getMuffetResponse(question, username);
    client.say(channel, `@${username} ${response}`);
    return;
  }

  // Comandos dinámicos desde Supabase
  if (config.commands && config.commands[firstWord]) {
    client.say(channel, config.commands[firstWord]);
    return;
  }

  // Responder menciones
  if ((msgLower.includes('muffet') || msgLower.includes('rey oso') || msgLower.includes('elosoking')) && !msgLower.startsWith('!')) {
    if (!config.ai_enabled) return;
    const response = await getMuffetResponse(message, username);
    client.say(channel, `@${username} ${response}`);
    return;
  }

  // Responder si le hablan directamente
  if (msgLower.startsWith('@muffet')) {
    if (!config.ai_enabled) return;
    const question = message.replace(/@muffet\w*/i, '').trim();
    const response = await getMuffetResponse(question || '¡Hola!', username);
    client.say(channel, `@${username} ${response}`);
    return;
  }
});

// ══════════════════════════════════════════
//  EVENTOS
// ══════════════════════════════════════════
client.on('raided', (channel, username, viewers) => {
  client.say(channel, `¡¡RAID!! 🐻👑 ¡${username} trae ${viewers} súbditos a la cueva! ¡BIENVENIDOS AL REINO, DEARIES! 🕷️♥♥♥`);
});

client.on('subscription', (channel, username) => {
  client.say(channel, `¡¡${username} se unió al reino!! 🐻👑 ¡Ahora eres súbdito oficial, dearie! ¡El Rey te lo agradece! 🕷️♥`);
});

client.on('resub', (channel, username, months) => {
  client.say(channel, `¡¡${username} lleva ${months} meses en la cueva!! 🐻🕷️ ¡Eres de los más leales, dearie! 👑♥`);
});

client.on('subgift', (channel, username, recipient) => {
  client.say(channel, `¡¡${username} le regaló el reino a ${recipient}!! 🐻👑 ¡Qué generoso/a, dearie! 🕷️♥`);
});

console.log('🐻🕷️ MuffetBot — Guardiana de la Cueva del Rey Oso iniciando...');
