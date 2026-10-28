<div align="center">

# 🕷️ SilklyBot

**Un chatbot de Twitch multi-canal con personalidad propia (Muffet, la araña consejera), IA conversacional, minijuegos, apuestas, subatones y más.**

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![tmi.js](https://img.shields.io/badge/tmi.js-1.8-9147FF?logo=twitch&logoColor=white)](https://github.com/tmijs/tmi.js)
[![Supabase](https://img.shields.io/badge/Database-Supabase-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com)
[![License](https://img.shields.io/badge/License-Todos_los_derechos_reservados-red.svg)](LICENSE)

[Panel de control](https://silklybot.com) · [Repo del Dashboard](https://github.com/ElOsoKing/muffet-dashboard) · [Reportar un bug](../../issues)

</div>

---

## 🎬 ¿Qué es SilklyBot?

SilklyBot es un bot de chat para Twitch con personalidad propia: **Muffet**, una araña consejera con corona y mucho carácter. No es solo un bot de comandos genéricos: su personalidad es configurable por cada streamer, conversa con IA y trae un ecosistema completo pensado para hacer crecer el chat, desde minijuegos y apuestas hasta subatones con contador en pantalla.

Corre como **servicio multi-canal**: un solo bot atiende a muchos streamers a la vez, cada uno con su propia configuración, personalidad y overlays, todo administrado desde el [dashboard web](https://github.com/ElOsoKing/muffet-dashboard).

> Proyecto independiente y hecho por un fan. No está afiliado ni respaldado por Twitch.

## ✨ Funciones principales

| Categoría | Qué incluye |
|---|---|
| 🤖 **IA conversacional** | Personalidad personalizable por canal, responde menciones y modera con IA |
| 🎬 **Emoji Game** | Adivina películas, series y videojuegos a partir de emojis generados por IA, con pistas, racha y ranking |
| 🎰 **Puntos y apuestas** | `!apostar` con niveles de riesgo, `!slots`, `!duelo` (con aceptar/rechazar), niveles y XP |
| ⏱️ **Subatón** | Contador en pantalla que suma tiempo con subs, gift subs y bits, con ranking de contribuidores |
| 🔊 **Alertas multimedia** | Los canjes de puntos disparan audio o video directo en el stream |
| 🥇 **Primerin** | "Quién llega primero" al stream, por comando o por canje de puntos |
| 🎵 **Música** | Cola de canciones vía Spotify o YouTube con límites por usuario |
| 🛡️ **Moderación** | Filtros de palabras, links, spam y moderación asistida por IA |
| 🏅 **Insignia de bot** | Los mensajes salen con la insignia oficial de bot de Twitch (Helix Send Chat Message) |
| 🤝 **Bot propio** | Cada streamer puede conectar su propio bot, con nombre e identidad propios |
| 🎉 **Eventos de Twitch** | Agradece subs, resubs, regalos y bits automáticamente |
| 📢 **Sorteos, encuestas, shoutouts** | Configurables desde el dashboard |

Más de **45 comandos**, todos activables o desactivables por canal desde el panel.

## 🧠 Cómo funciona

```
Twitch Chat ──tmi.js (IRC)──▶  SilklyBot (Node.js)  ──▶  Supabase (config + datos)
Twitch Helix (envío con insignia) ◀──┤
                                     ├──▶ Groq / Claude (respuestas de IA)
                                     ├──▶ Twitch Helix API (moderación, clips, categoría)
                                     ├──▶ Spotify / YouTube API (música)
                                     └──▶ EventSub (canjes, follows) ◀── Dashboard (Express + Render)
```

- Mantiene **una conexión de chat por canal**, con soporte para bots personalizados.
- Los mensajes se envían por la API de Twitch (insignia de bot) y, si falla, por IRC como respaldo temporal.
- La configuración vive en **Supabase** (Postgres) y se sincroniza cada 30 segundos.
- Los tokens de bots personalizados creados con "Conectar mi bot" se **renuevan solos**.
- Canjes de puntos y follows llegan por **EventSub** al servidor del dashboard, que los reenvía al bot.
- La IA usa **Groq** (chat general) y **Claude** (tareas creativas como el Emoji Game).

## 🛠️ Stack técnico

- **Runtime:** Node.js 18+
- **Chat:** [tmi.js](https://github.com/tmijs/tmi.js) + Twitch Helix
- **Base de datos:** [Supabase](https://supabase.com) (Postgres + Storage)
- **IA:** [Groq](https://groq.com) y [Claude](https://www.anthropic.com/claude)
- **APIs externas:** Twitch Helix, Spotify Web API, YouTube Data API v3
- **Hosting:** [Railway](https://railway.app)

## 🧭 Hoja de ruta

- [x] Insignia de bot en todos los canales
- [x] Conectar bot propio con un clic y renovación automática de tokens
- [x] Dominio propio: silklybot.com
- [ ] Nuevo logo y mascota original
- [ ] Soporte multiplataforma (Kick, YouTube), con el núcleo separado de cada plataforma

## 🚀 Este bot es un servicio, no un self-host

SilklyBot corre como servicio multi-canal y no está pensado para clonar y correr tu propia instancia. Si lo quieres en tu canal, regístrate en el **[dashboard](https://silklybot.com)**.

Este repositorio es público para que otros desarrolladores puedan ver cómo está construido, aprender o aportar ideas.

## 📄 Licencia

Este código se comparte públicamente por transparencia y no está bajo una licencia de código abierto. **Todos los derechos reservados.** Ver [LICENSE](LICENSE).

---

<div align="center">
<sub>Hecho con 🕷️ y demasiado café por <a href="https://github.com/ElOsoKing">ElOsoKing</a></sub>
</div>
