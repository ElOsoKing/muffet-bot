const tmi = require('tmi.js');
const Groq = require('groq-sdk');

const TWITCH_BOT_USERNAME = process.env.TWITCH_BOT_USERNAME;
const TWITCH_OAUTH_TOKEN  = process.env.TWITCH_OAUTH_TOKEN;
const TWITCH_CHANNEL      = process.env.TWITCH_CHANNEL;
const GROQ_API_KEY        = process.env.GROQ_API_KEY;
const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_KEY        = process.env.SUPABASE_KEY;

const groq = new Groq({ apiKey: GROQ_API_KEY });

let muffetActive = true;

let config = {
  bot_prompt: `Eres Muffet, la araña de Undertale y guardiana de la cueva del Rey Oso. Los viewers son "súbditos del reino". Hablas en español, eres coqueta y misteriosa. Usas emojis 🕷️ 🐻 👑 ♥. Respuestas cortas (máximo 2 oraciones).`,
  commands: {
    '!miel': '🍯🐻 ¡El Rey Oso tiene miel fresca para todos sus súbditos! ♥',
    '!té': '☕🕷️ ¡Aquí tienes tu té de araña con miel especial, dearie! 🐻♥',
    '!redes': '🐻👑 ¡Síguenos en Twitch y redes sociales! 🕷️♥',
    '!cueva': '🐻🕷️ ¡Bienvenido a la Cueva del Rey! 👑♥',
    '!muffet': '🕷️ ¡Soy la guardiana de la cueva del Rey Oso! 🐻👑♥',
    '!comandos': '🕷️👑 Comandos: !miel !té !redes !cueva !ask 🐻♥',
  },
  auto_messages: [
    '🐻👑 ¡Recuerden seguir el canal, súbditos! 🕷️♥',
    '🍯🕷️ ¡Escribe !miel o !té! 🐻',
    '👑🕷️ ¡Usa !ask para preguntarme! 🐻♥',
  ],
  ai_enabled: true,
  mod_enabled: false,
  banned_words: [],
  warn_message: '⚠️ Cuidado, dearie~ 🕷️',
};

async function loadConfig() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${TWITCH_CHANNEL}&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const data = await res.json();
    if (data && data[0]) {
      const row = data[0];
      if (row.bot_prompt)              config.bot_prompt    = row.bot_prompt;
      if (row.commands)                config.commands      = row.commands;
      if (row.auto_messages)           config.auto_messages = row.auto_messages;
      if (row.ai_enabled  !== undefined) config.ai_enabled  = row.ai_enabled;
      if (row.mod_enabled !== undefined) config.mod_enabled = row.mod_enabled;
      if (row.banned_words)            config.banned_words  = row.banned_words;
      if (row.warn_message)            config.warn_message  = row.warn_message;
      console.log('🐻🕷️ Config cargada desde Supabase');
    }
  } catch (err) {
    console.error('Error cargando config:', err.message);
  }
}
setInterval(loadConfig, 2 * 60 * 1000);

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
    return completion.choices[0]?.message?.content || '¡Algo salió mal en la cueva! 🐻🕷️';
  } catch (err) {
    console.error('Error Groq:', err.message);
    return '¡Las telarañas se enredaron, dearie! 🕷️';
  }
}

function isMod(tags, channel) {
  return tags.mod || tags.badges?.broadcaster === '1' || tags.username?.toLowerCase() === channel.replace('#','').toLowerCase();
}

const greeted = new Set();
const welcomePhrases = [
  (u) => `¡${u} llegó a la cueva del Rey Oso! 🐻🕷️ ¡Bienvenido/a al reino, dearie! ♥`,
  (u) => `¡Una nueva alma para el reino! ¡Bienvenid@ ${u}! 👑🕷️ 🐻♥`,
  (u) => `¡${u} entró a la cueva! 🐻 ¡Aquí nadie se va sin disfrutar, dearie! 🕷️♥`,
  (u) => `¡${u}, un nuevo súbdito del reino! 👑 ¡Tengo té con miel para ti! 🐻🕷️♥`,
];

const client = new tmi.Client({
  options: { debug: true },
  identity: { username: TWITCH_BOT_USERNAME, password: TWITCH_OAUTH_TOKEN },
  channels: [TWITCH_CHANNEL],
});

client.connect().then(async () => {
  console.log(`🐻🕷️ MuffetBot conectada a #${TWITCH_CHANNEL}`);
  await loadConfig();
  setInterval(() => {
    if (!muffetActive) return;
    if (config.auto_messages?.length > 0) {
      client.say(TWITCH_CHANNEL, config.auto_messages[Math.floor(Math.random() * config.auto_messages.length)]);
    }
  }, 20 * 60 * 1000);
}).catch(console.error);

client.on('message', async (channel, tags, message, self) => {
  if (self) return;

  const username = tags['display-name'] || tags.username;
  const msgLower = message.trim().toLowerCase();
  const firstWord = msgLower.split(' ')[0];

  // ── Comandos de mod ──
  if (firstWord === '!muffeton') {
    if (!isMod(tags, channel)) return;
    muffetActive = true;
    client.say(channel, `¡La guardiana ha despertado! 🕷️🐻 ¡Estoy de vuelta en la cueva, dearies! 👑♥`);
    return;
  }

  if (firstWord === '!muffetoff') {
    if (!isMod(tags, channel)) return;
    muffetActive = false;
    client.say(channel, `¡La guardiana se va a descansar~ 🕷️ ¡El Rey me dio el día libre! 🐻👑 ¡Hasta pronto, dearies! ♥`);
    return;
  }

  if (firstWord === '!muffetstatus') {
    // Sin mencionar "@muffet" para evitar bucle
    const msg = muffetActive
      ? `🟢 La guardiana está activa y vigilando la cueva~ 🕷️🐻♥`
      : `🔴 La guardiana está descansando~ 🕷️ Usa !muffeton para despertarla 🐻`;
    client.say(channel, msg);
    return;
  }

  // ── Saludo nuevo viewer (siempre activo) ──
  if (!greeted.has(username.toLowerCase())) {
    greeted.add(username.toLowerCase());
    const phrase = welcomePhrases[Math.floor(Math.random() * welcomePhrases.length)];
    setTimeout(() => client.say(channel, phrase(username)), 2000);
  }

  // ── Si está en silencio, no hace más ──
  if (!muffetActive) return;

  // ── Moderación ──
  if (config.mod_enabled && config.banned_words?.length > 0) {
    if (config.banned_words.some(w => msgLower.includes(w.toLowerCase()))) {
      client.say(channel, `@${username} ${config.warn_message}`);
      return;
    }
  }

  // ── !ask / !pregunta ──
  if (firstWord === '!ask' || firstWord === '!pregunta') {
    if (!config.ai_enabled) {
      client.say(channel, `@${username} ¡La IA está descansando, dearie! 🕷️🐻`);
      return;
    }
    const question = message.trim().slice(firstWord.length).trim();
    if (!question) {
      client.say(channel, `¡${username}, dearie! Escribe: !ask ¿tu pregunta? 🐻🕷️`);
      return;
    }
    client.say(channel, `@${username} ${await getMuffetResponse(question, username)}`);
    return;
  }

  // ── Comandos dinámicos ──
  if (config.commands?.[firstWord]) {
    client.say(channel, config.commands[firstWord]);
    return;
  }

  // ── Menciones (sin incluir el nombre del bot para evitar bucles) ──
  const botName = TWITCH_BOT_USERNAME.toLowerCase();
  if (msgLower.startsWith(`@${botName}`)) return; // ignorar menciones al bot mismo

  if ((msgLower.includes('rey oso') || msgLower.includes('elosoking')) && !msgLower.startsWith('!')) {
    if (!config.ai_enabled) return;
    client.say(channel, `@${username} ${await getMuffetResponse(message, username)}`);
    return;
  }
});

client.on('raided', (channel, username, viewers) => {
  client.say(channel, `¡¡RAID!! 🐻👑 ¡${username} trae ${viewers} súbditos a la cueva! ¡BIENVENIDOS AL REINO! 🕷️♥♥♥`);
});
client.on('subscription', (channel, username) => {
  client.say(channel, `¡¡${username} se unió al reino!! 🐻👑 ¡Ahora eres súbdito oficial, dearie! 🕷️♥`);
});
client.on('resub', (channel, username, months) => {
  client.say(channel, `¡¡${username} lleva ${months} meses en la cueva!! 🐻🕷️ ¡Eres de los más leales! 👑♥`);
});
client.on('subgift', (channel, username, recipient) => {
  client.say(channel, `¡¡${username} le regaló el reino a ${recipient}!! 🐻👑 ¡Qué generoso/a! 🕷️♥`);
});

console.log('🐻🕷️ MuffetBot iniciando...');
