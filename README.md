<div align="center">

# 🕷️ MuffetBot

**Un chatbot de Twitch multi-canal con personalidad propia, IA conversacional, minijuegos, gambling, subatones y más.**

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![tmi.js](https://img.shields.io/badge/tmi.js-1.8-9147FF?logo=twitch&logoColor=white)](https://github.com/tmijs/tmi.js)
[![Supabase](https://img.shields.io/badge/Database-Supabase-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com)
[![License](https://img.shields.io/badge/License-Todos_los_derechos_reservados-red.svg)](LICENSE)

[Panel de control](https://muffet-dashboard.onrender.com) · [Repo del Dashboard](https://github.com/ElOsoKing/muffet-dashboard) · [Reportar un bug](../../issues)

</div>

---

## 🎬 ¿Qué es MuffetBot?

MuffetBot es un bot de chat de Twitch inspirado en **Muffet**, la araña tejedora de repostería de *Undertale*. No es solo un bot de comandos genéricos: tiene personalidad propia (configurable por cada streamer), conversa usando IA, y trae un ecosistema completo de funciones pensadas para hacer crecer el chat — desde minijuegos y sistemas de apuestas hasta subatones con contador en pantalla.

Corre como **servicio multi-canal**: un solo bot atiende a decenas de streamers a la vez, cada uno con su propia configuración, personalidad y overlays, todo administrado desde un [dashboard web](https://github.com/ElOsoKing/muffet-dashboard).

## ✨ Funciones principales

| Categoría | Qué incluye |
|---|---|
| 🤖 **IA conversacional** | Personalidad 100% personalizable por canal, responde menciones y modera el chat con IA |
| 🎬 **Emoji Game** | Adivina películas, series y videojuegos a partir de emojis generados por IA, con pistas, racha y ranking |
| 🎰 **Puntos y gambling** | `!apostar` con niveles de riesgo, `!slots`, `!duelo` (con aceptar/rechazar), sistema de niveles y XP |
| ⏱️ **Subatón** | Contador en pantalla que suma tiempo con cada sub, gift sub y bits — con ranking de contribuidores |
| 🔊 **Alertas multimedia** | Los canjes de puntos del canal disparan audio o video (memes) directo en el stream |
| 🥇 **Primerin** | Sistema de "quién llega primero" al stream, por comando o por canje de puntos de Twitch |
| 🎵 **Música** | Cola de canciones vía Spotify o YouTube con límites configurables por usuario |
| 🛡️ **Moderación** | Filtros de palabras, links, spam y moderación asistida por IA (vía Helix API) |
| 🎉 **Eventos de Twitch** | Agradece subs, resubs, regalos de subs y bits automáticamente, con personalidad |
| 📢 **Sorteos, encuestas, shoutouts** | Todo configurable y automatizable desde el dashboard |

Son más de **45 comandos** distintos, todos activables/desactivables por canal desde el panel de control.

## 🧠 Cómo funciona

```
Twitch Chat (IRC)  ──tmi.js──▶  MuffetBot (Node.js)  ──▶  Supabase (config + datos)
                                       │
                                       ├──▶ Groq / Claude (respuestas de IA)
                                       ├──▶ Twitch Helix API (moderación, clips, categoría)
                                       ├──▶ Spotify / YouTube API (música)
                                       └──▶ EventSub (canjes, follows) ◀── Dashboard (Express + Render)
```

- El bot mantiene **una conexión IRC por canal**, incluyendo soporte para que cada streamer use su propio bot personalizado con nombre e identidad propios.
- Toda la configuración vive en **Supabase** (Postgres) y se sincroniza cada 30 segundos.
- Los eventos de canje de puntos y follows llegan vía **EventSub** al servidor del dashboard, que se los reenvía al bot.
- Las respuestas de IA usan **Groq** (rápido, para chat general) y **Claude** (para tareas más creativas como el Emoji Game).

## 🛠️ Stack técnico

- **Runtime:** Node.js 18+
- **Chat:** [tmi.js](https://github.com/tmijs/tmi.js) (cliente IRC de Twitch)
- **Base de datos:** [Supabase](https://supabase.com) (Postgres + Storage)
- **IA:** [Groq](https://groq.com) (`openai/gpt-oss-20b`) y [Claude](https://www.anthropic.com/claude) (Haiku)
- **APIs externas:** Twitch Helix, Spotify Web API, YouTube Data API v3
- **Hosting:** [Railway](https://railway.app)

## 🚀 Este bot es un servicio, no un self-host

MuffetBot corre como servicio multi-canal — no está pensado para clonar y correr tu propia instancia. Si quieres usarlo en tu canal, regístrate directamente en el **[dashboard](https://muffet-dashboard.onrender.com)**.

Este repositorio es público para que otros desarrolladores puedan ver cómo está construido, aprender, o contribuir con ideas.

## 📄 Licencia

Este código se comparte públicamente por transparencia — no está bajo una licencia de código abierto. **Todos los derechos reservados.** Ver [LICENSE](LICENSE) para más detalles.

---

<div align="center">
<sub>Hecho con 🕷️ y demasiado café por <a href="https://github.com/ElOsoKing">ElOsoKing</a></sub>
</div>
