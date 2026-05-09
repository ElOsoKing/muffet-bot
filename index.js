const tmi = require('tmi.js');
const Groq = require('groq-sdk');

const TWITCH_BOT_USERNAME = process.env.TWITCH_BOT_USERNAME;
const TWITCH_OAUTH_TOKEN  = process.env.TWITCH_OAUTH_TOKEN;
const TWITCH_CHANNEL      = process.env.TWITCH_CHANNEL;
const GROQ_API_KEY        = process.env.GROQ_API_KEY;

const groq = new Groq({ apiKey: GROQ_API_KEY });

const MUFFET_SYSTEM_PROMPT = `
Eres Muffet, la araña del videojuego Undertale. Pero ahora eres la guardiana oficial de la cueva del Rey Oso — el canal de Twitch de ElOsoKing1.

Tu personalidad:
- Eres la consejera y guardiana del Rey Oso (ElOsoKing1)
- Mezclas el mundo de las arañas con el reino del oso
- La "telaraña" ahora es "la cueva del Rey" o "el reino"
- Los viewers son "súbditos del reino" o "almas de la cueva" o "dearies"
- Usas palabras como "dearie", "querido/a", "súbdito/a"
- Te encanta el té de araña pero también la miel (por ser la cueva de un oso)
- Eres coqueta, misteriosa pero leal al Rey Oso
- Usas emojis 🕷️ 🐻 👑 ♥ ocasionalmente
- Respondes SIEMPRE en español
- Tus respuestas son cortas (máximo 2 oraciones) para el chat de Twitch
- Nunca eres grosera
- Hablas con orgullo del Rey ElOsoKing1 cuando te preguntan por él
- El reino tiene una cueva enorme llena de telarañas y miel

Ejemplos de cómo hablas:
- "¡Bienvenido a la cueva del Rey Oso, dearie! 🐻🕷️ ¡El reino te da la bienvenida!"
- "¡Nadie abandona la cueva del Rey sin una sonrisa, querido/a! 👑♥"
- "Mmm, déjame consultar eso con una taza de té con miel~ 🐻🕷️"
- "¡El Rey ElOsoKing1 gobierna esta cueva con honor! 👑 ¡Y yo me aseguro de que nadie cause problemas! 🕷️"
`;

async function getMuffetResponse(userMessage, username) {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama3-8b-8192',
      messages: [
        { role: 'system', content: MUFFET_SYSTEM_PROMPT },
        { role: 'user', content: `El usuario "${username}" dice: ${userMessage}` }
      ],
      max_tokens: 150,
      temperature: 0.85,
    });
    return completion.choices[0]?.message?.content || '¡Dearie, algo salió mal en la cueva! 🐻🕷️';
  } catch (err) {
    console.error('Error Groq:', err.message);
    return '¡Las telarañas de la cueva se enredaron, dearie! 🕷️ Inténtalo de nuevo~';
  }
}

const commands = {
  '!miel':     () => '🍯🐻 ¡El Rey Oso tiene miel fresca para todos sus súbditos! ¡Bienvenidos a la cueva, dearies! ♥',
  '!té':       () => '☕🕷️ ¡Aquí tienes tu té de araña con miel especial de la cueva, dearie! ¡El Rey aprueba esta receta! 🐻♥',
  '!tea':      () => '☕🕷️ ¡Aquí tienes tu té de araña con miel especial de la cueva, dearie! ¡El Rey aprueba esta receta! 🐻♥',
  '!redes':    () => '🐻👑 Sigue al Rey Oso: Twitch → twitch.tv/ElOsoKing1 | Instagram → @ElOsoKing1 🕷️♥',
  '!rey':      () => '👑🐻 ElOsoKing1 es el Rey de esta cueva — streamer, gamer y el oso más poderoso del reino! 🕷️♥',
  '!muffet':   () => '🕷️ ¡Soy Muffet, la guardiana de la cueva del Rey Oso! Vine de Undertale pero ahora sirvo al reino~ 🐻👑♥',
  '!cueva':    () => '🐻🕷️ ¡Bienvenido a la Cueva del Rey! Aquí vivimos los súbditos más leales del reino de ElOsoKing1~ 👑♥',
  '!comandos': () => '🕷️👑 Comandos: !miel !té !redes !rey !muffet !cueva !ask — ¡Pregúntame lo que quieras, dearie! 🐻♥',
  '!ask':      null,
  '!pregunta': null,
};

const greeted = new Set();

const welcomePhrases = [
  (u) => `¡${u} ha llegado a la cueva del Rey Oso! 🐻🕷️ ¡Bienvenido/a al reino, dearie! ♥`,
  (u) => `¡Oh, una nueva alma para el reino! ¡Bienvenid@ ${u}! 👑🕷️ ¡El Rey Oso te saluda! 🐻♥`,
  (u) => `¡${u} entró a la cueva! 🐻 ¡Aquí nadie se va sin disfrutar, dearie! 🕷️♥`,
  (u) => `¡Mmmm, ${u}! ¡Un nuevo súbdito del reino! 👑 ¡Tengo té con miel recién hecho, dearie! 🐻🕷️♥`,
  (u) => `¡${u} fue atrapado/a por las telarañas de la cueva! 🕷️🐻 ¡Bienvenid@ para siempre, dearie! 👑♥`,
];

const autoPhrases = [
  '🐻👑 ¡Recuerden seguir al Rey Oso, súbditos! ¡Nadie abandona la cueva sin darle follow a ElOsoKing1! 🕷️♥',
  '🍯🕷️ ¡La guardiana tiene té con miel para todos! Escribe !miel o !té para recibir el tuyo~ 🐻',
  '👑🕷️ ¿Preguntas para la guardiana? ¡Escribe !ask y Muffet te responde desde la cueva! 🐻♥',
  '🐻 ¡Sigue al Rey en Instagram @ElOsoKing1 para no perderte nada del reino, dearies! 🕷️♥',
  '👑🕷️ ¡En la cueva del Rey Oso todos son bienvenidos! ¡Compartan el stream, dearies! 🐻♥',
  '🍯🐻 ¡Los osos y las arañas son los mejores aliados del reino! ¡Pregúntenle al Rey! 🕷️👑♥',
];

const client = new tmi.Client({
  options: { debug: true },
  identity: {
    username: TWITCH_BOT_USERNAME,
    password: TWITCH_OAUTH_TOKEN,
  },
  channels: [TWITCH_CHANNEL],
});

client.connect().then(() => {
  console.log(`🐻🕷️ MuffetBot conectada a la cueva de #${TWITCH_CHANNEL}`);
  setInterval(() => {
    const phrase = autoPhrases[Math.floor(Math.random() * autoPhrases.length)];
    client.say(TWITCH_CHANNEL, phrase);
  }, 20 * 60 * 1000);
}).catch(console.error);

client.on('message', async (channel, tags, message, self) => {
  if (self) return;
  const username = tags['display-name'] || tags.username;
  const msgLower = message.trim().toLowerCase();
  const firstWord = msgLower.split(' ')[0];

  if (!greeted.has(username.toLowerCase())) {
    greeted.add(username.toLowerCase());
    const phrase = welcomePhrases[Math.floor(Math.random() * welcomePhrases.length)];
    setTimeout(() => client.say(channel, phrase(username)), 2000);
  }

  if (firstWord === '!ask' || firstWord === '!pregunta') {
    const question = message.trim().slice(firstWord.length).trim();
    if (!question) {
      client.say(channel, `¡${username}, dearie! Escribe así: !ask ¿Cuánta miel tiene el Rey Oso? 🐻🕷️`);
      return;
    }
    const response = await getMuffetResponse(question, username);
    client.say(channel, `@${username} ${response}`);
    return;
  }

  if (commands[firstWord] && typeof commands[firstWord] === 'function') {
    const result = commands[firstWord](client, channel, tags);
    if (result) client.say(channel, result);
    return;
  }

  if ((msgLower.includes('muffet') || msgLower.includes('rey oso') || msgLower.includes('elosoking')) && !msgLower.startsWith('!')) {
    const response = await getMuffetResponse(message, username);
    client.say(channel, `@${username} ${response}`);
    return;
  }

  if (msgLower.startsWith('@muffet')) {
    const question = message.replace(/@muffet\w*/i, '').trim();
    const response = await getMuffetResponse(question || '¡Hola!', username);
    client.say(channel, `@${username} ${response}`);
    return;
  }
});

client.on('raided', (channel, username, viewers) => {
  client.say(channel, `¡¡RAID!! 🐻👑 ¡${username} trae ${viewers} súbditos a la cueva del Rey! ¡BIENVENIDOS AL REINO, DEARIES! 🕷️♥♥♥`);
});

client.on('subscription', (channel, username) => {
  client.say(channel, `¡¡${username} se unió al reino!! 🐻👑 ¡Ahora eres súbdito oficial de la cueva, dearie! ¡El Rey te lo agradece! 🕷️♥`);
});

client.on('resub', (channel, username, months) => {
  client.say(channel, `¡¡${username} lleva ${months} meses en la cueva!! 🐻🕷️ ¡Eres uno de los súbditos más leales, dearie! 👑♥`);
});

client.on('subgift', (channel, username, recipient) => {
  client.say(channel, `¡¡${username} le regaló el reino a ${recipient}!! 🐻👑 ¡Qué generoso/a, dearie! ¡El Rey está orgulloso! 🕷️♥`);
});

console.log('🐻🕷️ MuffetBot — Guardiana de la Cueva del Rey Oso iniciando...');
