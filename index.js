// index.js — Handoff humano bidireccional (reenviar mensajes del cliente al admin)
const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// ===== Config =====
const WABA_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'mi_token_123';
const ADMIN_NUMBER = process.env.ADMIN_NUMBER; // E.164 sin +

async function sendText(to, body) {
  const url = `https://graph.facebook.com/v20.0/${WABA_ID}/messages`;
  const payload = { messaging_product: 'whatsapp', to, text: { body } };
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
  return axios.post(url, payload, { headers });
}

function normalize(txt = '') {
  return txt.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').trim();
}

const sessions = new Map(); // number -> {handoff:boolean, since:number, ticket:string}
const pending = [];         // [{number, ticket, createdAt}]

function setState(number, state) { sessions.set(number, { ...(sessions.get(number) || {}), ...state }); }
function getState(number) { return sessions.get(number) || {}; }
function newTicket() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }

// ----- Respuestas básicas -----
function mainMenu() {
  const name = process.env.BUSINESS_NAME || process.env.BOT_NAME || 'Nuestra empresa';
  const prod = process.env.PRODUCT_NAME || 'nuestro producto';
  return `¡Bienvenido a ${name}! 👋
Elige una opción:
1️⃣ Información de ${prod}
2️⃣ Promociones
3️⃣ Hablar con un asesor

También puedes escribir: precio, promo, horario, ubicacion, catalogo.`;
}
function productInfo() {
  const prod = process.env.PRODUCT_NAME || 'nuestro producto';
  const price = process.env.PRODUCT_PRICE ? `USD ${process.env.PRODUCT_PRICE}` : 'Consulta precio';
  return `ℹ️ ${prod}
• Beneficios: mejora rendimiento y salud del cultivo 🌱
• Presentación: 1 L
• Precio: ${price}

¿Deseas comprar o hablar con un asesor? Responde: "asesor" o "comprar".`;
}
function promosInfo() {
  return `🎁 Promociones
• 2x1 en tu primera compra esta semana.
• Envío gratis desde 3 unidades.
¿Te contacto con un asesor? Escribe "asesor".`;
}
function hoursInfo() { return `🕒 Horarios: ${process.env.HOURS || 'Lun–Sáb 9:00–18:00'}`; }
function locationInfo() { return `📍 Atendemos en ${process.env.CITY || 'nuestra ciudad'}. Envíos a nivel nacional.`; }
function thanksInfo() { return `✅ Listo, te conecto con un asesor humano. Por favor espera un momento.`; }

// ----- Notificaciones admin -----
async function notifyAdminNew(from, text, ticket) {
  if (!ADMIN_NUMBER) return;
  const msg = `⚠️ Nueva solicitud de ASESOR
Ticket: #${ticket}
Cliente: +${from}
Mensaje: "${text}"

Responde con:
• R <mensaje>          (responde al ticket más reciente)
• R #${ticket} <mensaje>  (responde a este ticket)
• LIST | END #${ticket}`;
  await sendText(ADMIN_NUMBER, msg);
}
async function notifyAdmin(text) {
  if (!ADMIN_NUMBER) return;
  await sendText(ADMIN_NUMBER, text);
}

// ----- Comandos admin -----
async function handleAdminCommand(adminTextRaw) {
  const adminText = adminTextRaw.trim();
  const t = normalize(adminText);

  if (t === 'list') {
    if (!pending.length) return 'No hay tickets pendientes.';
    const lines = pending.map(p => `• #${p.ticket} +${p.number}`);
    return `Pendientes:\n${lines.join('\n')}`;
  }
  if (/^end\s+#/i.test(adminText)) {
    const id = adminText.match(/^end\s+#([a-z0-9]+)/i)?.[1]?.toUpperCase();
    if (!id) return 'Formato: END #TICKET';
    const idx = pending.findIndex(x => x.ticket === id);
    if (idx >= 0) pending.splice(idx, 1);
    for (const [num, st] of sessions.entries()) {
      if (st.ticket === id) { setState(num, { handoff: false }); }
    }
    return `✓ Ticket #${id} cerrado. Bot reactivado.`;
  }
  if (/^r\s+#/i.test(adminText)) {
    const m = adminText.match(/^r\s+#([a-z0-9]+)\s+([\s\S]+)/i);
    if (!m) return 'Formato: R #TICKET <mensaje>';
    const id = m[1].toUpperCase();
    const reply = m[2].trim();
    let target = null;
    for (const [num, st] of sessions.entries()) if (st.ticket === id) target = num;
    if (!target) return `No encontré el ticket #${id}.`;
    await sendText(target, reply);
    return `→ Enviado a +${target} (ticket #${id}).`;
  }
  if (/^r\s+/i.test(adminText)) {
    const reply = adminText.replace(/^r\s+/i, '').trim();
    let target = pending.length ? pending[pending.length - 1].number : null;
    if (!target) {
      let latestNum = null, latestTime = 0;
      for (const [num, st] of sessions.entries()) if (st.handoff && st.since > latestTime) {
        latestTime = st.since; latestNum = num;
      }
      target = latestNum;
    }
    if (!target) return 'No hay chats pendientes para responder.';
    await sendText(target, reply);
    return `→ Enviado a +${target}.`;
  }
  if (t === 'help' || t === 'ayuda') {
    return `Comandos:
• LIST
• R <mensaje>
• R #TICKET <mensaje>
• END #TICKET`;
  }
  return `No entendí el comando. Escribe HELP.`;
}

// ====== Webhook Verify (GET) ======
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ====== Webhook Messages (POST) ======
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;

    if (Array.isArray(messages)) {
      for (const m of messages) {
        if (m.type !== 'text') continue;

        const from = m.from;                  // número de quien envía
        const text = (m.text?.body || '').trim();
        const t = normalize(text);

        // 1) Mensajes del ADMIN (tú)
        if (ADMIN_NUMBER && from === ADMIN_NUMBER) {
          const out = await handleAdminCommand(text);
          if (out) await sendText(ADMIN_NUMBER, out);
          continue;
        }

        // 2) Mensajes del CLIENTE
        const st = getState(from);

        // Si está en handoff: reenviar TODO lo que escribe el cliente al admin
        if (st.handoff) {
          // reenvía al admin cada mensaje del cliente
          await notifyAdmin(`👤 Cliente +${from} (#${st.ticket || 'S/T'}):\n"${text}"`);
          // el bot no responde al cliente en este modo, salvo si pide salir al menú
          if (['menu','menú','inicio','hola','hi','start','0','volver'].includes(t)) {
            setState(from, { handoff: false });
            await sendText(from, mainMenu());
          }
          continue;
        }

        // Bot normal
        if (['hola','buenas','menu','menú','inicio','start','0'].includes(t)) {
          await sendText(from, mainMenu());
        } else if (t === '1' || /producto|khumic|info|informacion|información/.test(t)) {
          await sendText(from, productInfo());
        } else if (t === '2' || /promo|promocion|promoción|oferta/.test(t)) {
          await sendText(from, promosInfo());
        } else if (t === '3' || /asesor|humano|contacto|vendedor|whatsapp/.test(t)) {
          const tk = st.ticket || newTicket();
          setState(from, { handoff: true, since: Date.now(), ticket: tk });
          pending.push({ number: from, ticket: tk, createdAt: Date.now() });
          await sendText(from, thanksInfo());
          await notifyAdminNew(from, text, tk);
        } else if (/precio|costo|vale|cuanto/.test(t)) {
          await sendText(from, productInfo());
        } else if (/horario|hora|abren|cierran/.test(t)) {
          await sendText(from, hoursInfo());
        } else if (/ubicacion|ubicación|direccion|dirección|donde/.test(t)) {
          await sendText(from, locationInfo());
        } else if (/comprar|pedido|orden|pagar/.test(t)) {
          const tk = newTicket();
          setState(from, { handoff: true, since: Date.now(), ticket: tk });
          pending.push({ number: from, ticket: tk, createdAt: Date.now() });
          await sendText(from, '🛒 ¡Genial! Te conecto con un asesor para completar tu pedido.');
          await notifyAdminNew(from, text, tk);
        } else {
          await sendText(from, `No entendí tu mensaje 🤔.\n${mainMenu()}`);
        }
      }
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error('Error en POST /webhook:', e?.response?.data || e.message);
    return res.sendStatus(200);
  }
});

app.get('/', (_req, res) => res.send('WhatsApp bot activo'));

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, '0.0.0.0', () => console.log(`Servidor escuchando en puerto ${PORT}`));



