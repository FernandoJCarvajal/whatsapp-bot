// index.js — Handoff humano: responder desde el mismo chat del bot (CommonJS)
const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// ===== Config =====
const WABA_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'mi_token_123';
const ADMIN_NUMBER = process.env.ADMIN_NUMBER;// tu WhatsApp personal (E.164, sin +)

if (!WABA_ID || !TOKEN) {
  console.error('Faltan WHATSAPP_PHONE_NUMBER_ID o WHATSAPP_TOKEN en variables de entorno.');
}

// ===== Helpers =====
async function sendText(to, body) {
  const url = `https://graph.facebook.com/v20.0/${WABA_ID}/messages`;
  const payload = { messaging_product: 'whatsapp', to, text: { body } };
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
  return axios.post(url, payload, { headers });
}

function normalize(txt = '') {
  return txt.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').trim();
}

// ===== Estado en memoria =====
/**
 * sessions: Map<number, {
 *   handoff: boolean,        // si está en modo asesor humano
 *   since: number,           // timestamp cuando pasó a handoff
 *   ticket: string,          // id corto
 *   assignedTo?: string      // admin asignado (solo 1 admin por simplicidad)
 * }>
 */
const sessions = new Map();
// cola de pendientes cuando piden asesor:
const pending = []; // [{number, ticket, createdAt}]

// utilidades de estado
function setState(number, state) { sessions.set(number, { ...(sessions.get(number) || {}), ...state }); }
function getState(number) { return sessions.get(number) || {}; }
function newTicket() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }

// ===== Respuestas “robot” =====
function mainMenu() {
  const name = process.env.BUSINESS_NAME || process.env.BOT_NAME || 'Nuestra empresa';
  const prod = process.env.PRODUCT_NAME || 'nuestro producto';
  return (
`¡Bienvenido a ${name}! 👋
Elige una opción:
1️⃣ Información de ${prod}
2️⃣ Promociones
3️⃣ Hablar con un asesor

También puedes escribir: precio, promo, horario, ubicacion, catalogo.`);
}

function productInfo() {
  const prod = process.env.PRODUCT_NAME || 'nuestro producto';
  const price = process.env.PRODUCT_PRICE ? `USD ${process.env.PRODUCT_PRICE}` : 'Consulta precio';
  return (
`ℹ️ ${prod}
• Beneficios: mejora rendimiento y salud del cultivo 🌱
• Presentación: 1 L
• Precio: ${price}

¿Deseas comprar o hablar con un asesor? Responde: "asesor" o "comprar".`);
}

function promosInfo() {
  return `🎁 Promociones
• 2x1 en tu primera compra esta semana.
• Envío gratis desde 3 unidades.
¿Te contacto con un asesor? Escribe "asesor".`;
}

function hoursInfo() {
  const h = process.env.HOURS || 'Lun–Sáb 9:00–18:00';
  return `🕒 Horarios de atención: ${h}`;
}

function locationInfo() {
  const c = process.env.CITY || 'nuestra ciudad';
  return `📍 Atendemos en ${c}. Hacemos envíos a nivel nacional.`;
}

function thanksInfo() {
  return `✅ Listo, te conecto con un asesor humano. Por favor espera un momento.`;
}

// ===== Notificación al admin =====
async function notifyAdminNew(from, text, ticket) {
  if (!ADMIN_NUMBER) return;
  const msg =
`⚠️ Nueva solicitud de ASESOR
Ticket: #${ticket}
Cliente: +${from}
Mensaje: "${text}"

Responde desde este mismo chat con:
• R <tu mensaje>              (responde al último ticket)
• R #${ticket} <tu mensaje>   (responde a este ticket)
• LIST                        (ver pendientes)
• TAKE #${ticket}             (tomar este ticket)
• END #${ticket}              (cerrar ticket)`;
  await sendText(ADMIN_NUMBER, msg);
}

async function notifyAdminInfo(text) {
  if (!ADMIN_NUMBER) return;
  await sendText(ADMIN_NUMBER, text);
}

// ===== Comandos del ADMIN =====
// Admin escribe al MISMO número del bot (el Business). El bot interpreta:
async function handleAdminCommand(adminTextRaw) {
  const adminText = adminTextRaw.trim();
  const t = normalize(adminText);

  // LIST: muestra tickets pendientes
  if (t === 'list') {
    if (!pending.length) return 'No hay tickets pendientes.';
    const lines = pending.map(p => `• #${p.ticket} +${p.number} (${new Date(p.createdAt).toLocaleString()})`);
    return `Tickets pendientes:\n${lines.join('\n')}`;
  }

  // TAKE #TICKET: asigna el ticket a este admin (opcional pero útil si hubiera varios)
  if (t.startsWith('take #')) {
    const id = adminText.match(/take\s+#([a-z0-9]+)/i)?.[1]?.toUpperCase();
    if (!id) return 'Formato: TAKE #TICKET';
    const item = pending.find(x => x.ticket === id);
    if (!item) return `No encontré el ticket #${id}.`;
    setState(item.number, { assignedTo: ADMIN_NUMBER, handoff: true });
    return `✓ Ticket #${id} asignado.`;
  }

  // END #TICKET: cierra ticket y saca de handoff
  if (t.startsWith('end #')) {
    const id = adminText.match(/end\s+#([a-z0-9]+)/i)?.[1]?.toUpperCase();
    if (!id) return 'Formato: END #TICKET';
    const idx = pending.findIndex(x => x.ticket === id);
    if (idx >= 0) pending.splice(idx, 1);
    // buscar cliente por ticket
    for (const [num, st] of sessions.entries()) {
      if (st.ticket === id) {
        setState(num, { handoff: false, assignedTo: undefined });
        return `✓ Ticket #${id} cerrado. El cliente +${num} volvió al menú.`;
      }
    }
    return `✓ Ticket #${id} cerrado (no se encontró cliente en memoria).`;
  }

  // R #TICKET <mensaje>: responde a un ticket específico
  if (/^r\s+#/i.test(adminText)) {
    const m = adminText.match(/^r\s+#([a-z0-9]+)\s+([\s\S]+)/i);
    if (!m) return 'Formato: R #TICKET <mensaje>';
    const id = m[1].toUpperCase();
    const reply = m[2].trim();
    let target = null;
    for (const [num, st] of sessions.entries()) {
      if (st.ticket === id) { target = num; break; }
    }
    if (!target) return `No encontré el ticket #${id}.`;
    await sendText(target, reply);
    return `→ Enviado a +${target} (ticket #${id}).`;
  }

  // R <mensaje>: responde al último ticket pendiente o el último en handoff
  if (/^r\s+/i.test(adminText)) {
    const reply = adminText.replace(/^r\s+/i, '').trim();
    // 1) intenta con el más reciente en pending
    let target = pending.length ? pending[pending.length - 1].number : null;
    // 2) si no hay pending, busca el último en handoff por tiempo
    if (!target) {
      let latestNum = null, latestTime = 0;
      for (const [num, st] of sessions.entries()) {
        if (st.handoff && st.since > latestTime) { latestTime = st.since; latestNum = num; }
      }
      target = latestNum;
    }
    if (!target) return 'No hay chats pendientes para responder.';
    await sendText(target, reply);
    return `→ Enviado a +${target}.`;
  }

  // HELP
  if (t === 'help' || t === 'ayuda') {
    return `Comandos:
• LIST
• TAKE #TICKET
• R <mensaje>
• R #TICKET <mensaje>
• END #TICKET`;
  }

  // Si no coincide con nada:
  return `No entendí el comando. Escribe HELP para ver opciones.`;
}

// ===== Webhook Verify (GET) =====
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WEBHOOK_VERIFIED OK');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===== Webhook Messages (POST) =====
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;

    if (Array.isArray(messages)) {
      for (const m of messages) {
        if (m.type !== 'text') continue; // manejamos texto para este flujo

        const from = m.from;                   // número remitente
        const text = (m.text?.body || '').trim();
        const t = normalize(text);

        // 1) Mensajes del ADMIN → comandos
        if (ADMIN_NUMBER && from === ADMIN_NUMBER) {
          const out = await handleAdminCommand(text);
          if (out) await sendText(ADMIN_NUMBER, out);
          continue;
        }

        // 2) Mensajes de CLIENTES
        const { handoff, ticket } = getState(from);

        // Si el cliente está en handoff (modo humano)
        if (handoff) {
          // por defecto, no responder automático; solo permitir salir con "menu"
          if (['menu','menú','inicio','hola','hi','start','0','volver'].includes(t)) {
            setState(from, { handoff: false });
            await sendText(from, mainMenu());
          } else {
            // silencio del bot; el humano responde con comandos desde el chat del bot
          }
          continue;
        }

        // Flujo bot normal
        if (['hola','buenas','menu','menú','inicio','start','0'].includes(t)) {
          await sendText(from, mainMenu());
        } else if (t === '1' || /producto|khumic|info|informacion|información/.test(t)) {
          await sendText(from, productInfo());
        } else if (t === '2' || /promo|promocion|promoción|oferta/.test(t)) {
          await sendText(from, promosInfo());
        } else if (t === '3' || /asesor|humano|contacto|vendedor|whatsapp/.test(t)) {
          const tk = ticket || newTicket();
          setState(from, { handoff: true, since: Date.now(), ticket: tk, assignedTo: ADMIN_NUMBER });
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
          setState(from, { handoff: true, since: Date.now(), ticket: tk, assignedTo: ADMIN_NUMBER });
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

// Salud
app.get('/', (_req, res) => res.send('WhatsApp bot activo'));

// Puerto (local/Render)
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, '0.0.0.0', () => console.log(`Servidor escuchando en puerto ${PORT}`));



