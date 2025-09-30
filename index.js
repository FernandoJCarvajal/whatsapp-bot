// index.js — PRO CAMPO BOT (menú 7 opciones, horario, imágenes, PDFs y handoff)
const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// ===== Config obligatoria =====
const WABA_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'mi_token_123';
const ADMIN_NUMBER = process.env.ADMIN_NUMBER; // E.164 sin + (ej.: 593980499767)
const CITY = process.env.CITY || 'Ibarra';

// ===== Config opcional (imágenes y PDFs) =====
// Si no pones variables en environment, usamos por defecto tus enlaces de Drive:
const KHUMIC100_IMG  = process.env.KHUMIC100_IMG  || 'https://drive.google.com/uc?export=view&id=1Ku4ghoo2F4Ek7phymx1IOAGb8jXyLngn';
const SEAWEED800_IMG = process.env.SEAWEED800_IMG || 'https://drive.google.com/uc?export=view&id=11TceWyjbPAC7kZQVVs9tzgIxPuWW4tQa';
const KHUMIC100_PDF  = process.env.KHUMIC100_PDF  || 'https://drive.google.com/uc?export=download&id=1Tyn6ElcglBBE8Skd_G5wHb0U4XDF9Jfu';
const SEAWEED800_PDF = process.env.SEAWEED800_PDF || 'https://drive.google.com/uc?export=download&id=1HuBBJ5tadjD8FGowCTCqPbZuWgxlgU9Y';

// ===== Utilidades de envío =====
async function sendText(to, body) {
  const url = `https://graph.facebook.com/v20.0/${WABA_ID}/messages`;
  const payload = { messaging_product: 'whatsapp', to, text: { body } };
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
  return axios.post(url, payload, { headers });
}
async function sendImage(to, urlImage, caption = '') {
  const url = `https://graph.facebook.com/v20.0/${WABA_ID}/messages`;
  const payload = { messaging_product: 'whatsapp', to, type: 'image', image: { link: urlImage, caption } };
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
  return axios.post(url, payload, { headers });
}
async function sendDocument(to, urlDoc, filename = 'ficha.pdf', caption = '') {
  const url = `https://graph.facebook.com/v20.0/${WABA_ID}/messages`;
  const payload = { messaging_product: 'whatsapp', to, type: 'document', document: { link: urlDoc, filename, caption } };
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
  return axios.post(url, payload, { headers });
}

function normalize(txt = '') {
  return txt.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').trim();
}

// ===== Estado simple en memoria =====
const sessions = new Map(); // number -> {handoff:boolean, since:number, ticket:string}
const pending = [];         // [{number, ticket, createdAt}]

function setState(number, state) { sessions.set(number, { ...(sessions.get(number) || {}), ...state }); }
function getState(number) { return sessions.get(number) || {}; }
function newTicket() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }

// ===== Horario laboral (Ecuador UTC-5) =====
function businessHoursText() {
  return '⏰ Nuestro horario es *Lunes a Viernes de 08h00 a 17h30* y *Sábados de 08h00 a 13h00* (UTC-5).';
}
function isBusinessHours() {
  const now = new Date();
  // a minutos UTC y convertimos a UTC-5 (Ecuador)
  const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const localMins = (utcMins - 5 * 60 + 24 * 60) % (24 * 60);
  const day = now.getUTCDay(); // 0=Dom,1=Lun,...,6=Sab

  // Lunes–Viernes 08:00–17:30
  if (day >= 1 && day <= 5) return localMins >= 8*60 && localMins <= 17*60 + 30;
  // Sábado 08:00–13:00
  if (day === 6) return localMins >= 8*60 && localMins <= 13*60;
  // Domingo cerrado
  return false;
}

// ===== Textos del bot =====
function mainMenu() {
  return (
`🤖🌱 ¡Hola! Soy *PRO CAMPO BOT* y estoy aquí para ayudarte.
Elige una opción escribiendo el número:

1️⃣ Precios y promociones de *Khumic-100* (ácidos húmicos + fúlvicos)
2️⃣ Precios y promociones de *Khumic – Seaweed 800* (algas marinas)
3️⃣ Hablar con un asesor 👨‍💼
4️⃣ Beneficios de *Khumic-100* (ácidos húmicos + fúlvicos)
5️⃣ Beneficios de *Khumic – Seaweed 800* (algas marinas)
6️⃣ 📍 Envíos y cómo encontrarnos
7️⃣ 📄 Fichas técnicas (PDF)
0️⃣ Volver al inicio`
  );
}

function productInfoKhumic100() {
  return (
`💚 *Khumic-100* (ácidos húmicos + fúlvicos)
✨ El mejor aliado para tus cultivos.

💲 *Precios y Promociones*:
• 1 Kg → $13.96
• 3 Kg → $34.92  ✅ *Envío GRATIS (Cita Express)*
• 25 Kg → $226.98 ✅ *Envío GRATIS (Cita Express)*
• 50 Kg → $436.50 ✅ *Envío GRATIS (Cita Express)*

📄 Escribe *ficha 100* para recibir la ficha técnica (PDF).

📦 *Envío GRATIS* en *todas las promociones (más de 1 Kg)* mediante *Cita Express*.`
  );
}
function productInfoSeaweed() {
  return (
`🌊 *Khumic – Seaweed 800* (algas marinas)
🌿 Bioestimulante para vigor, enraizamiento y resistencia.

💲 *Precios y Promociones*:
• 1 Kg → $16.00
• 3 Kg → $39.68  ✅ *Envío GRATIS (Cita Express)*

📄 Escribe *ficha seaweed* para recibir la ficha técnica (PDF).

📦 *Envío GRATIS* en *todas las promociones (más de 1 Kg)* mediante *Cita Express*.`
  );
}

function benefitsKhumic100() {
  return (
`🌱 *Beneficios de Khumic-100 (ácidos húmicos + fúlvicos)* 🌿
*Plantas*: mejor absorción de nutrientes 💪, más crecimiento 🌱, tolerancia a sequía ☀️, más frutos y flores 🌼, mayor resistencia 🌿.
*Suelo*: mejor estructura 🌿, más biodiversidad 🌸, menos contaminación 🚮.
*Ambiente*: menos fertilizantes químicos 🌿, mejor calidad del agua 🌊, menos GEI 🌟.`
  );
}
function benefitsSeaweed800() {
  return (
`🌿🌊 *Beneficios de Khumic – Seaweed 800 (algas marinas)* 🌊🌿
Mejora estructura del suelo, estimula crecimiento, aumenta resistencia a enfermedades, mejora calidad de fruto, reduce estrés abiótico y es fertilizante natural.`
  );
}

function contactInfo() {
  return (
`📍 *Envíos y cómo encontrarnos*

🏬 *Bodega principal de importación*: ${CITY}
🚫 *Sin atención al cliente presencial.*
📦 *Despachos con previo aviso* solo para *cantidades de distribuidor*.

🚚 *Envíos*:
• *GRATIS* en *todas las promociones (más de 1 Kg)* con *Cita Express* (cobertura nacional).

¿Deseas coordinar despacho o compra mayorista?
Escribe *asesor* y te conecto con un humano.`
  );
}

function thanksInfoNow() { return '✅ Te conecto con un asesor ahora mismo. Por favor espera un momento.'; }
function thanksInfoLater() {
  return `${businessHoursText()}

No te preocupes 🤗, *puedo responder todas tus dudas ahora*, y tu *compra* quedará *pendiente para confirmación* con un asesor en horario laboral.`;
}

// ===== Notificaciones al admin =====
async function notifyAdminNew(from, text, ticket) {
  if (!ADMIN_NUMBER) return;
  const msg =
`⚠️ Nueva solicitud de ASESOR
Ticket: #${ticket}
Cliente: +${from}
Mensaje: "${text}"

Responde con:
• R <mensaje>
• R #${ticket} <mensaje>
• LIST | END #${ticket}`;
  await sendText(ADMIN_NUMBER, msg);
}
async function notifyAdmin(text) { if (ADMIN_NUMBER) await sendText(ADMIN_NUMBER, text); }

// ===== Comandos del admin =====
async function handleAdminCommand(raw) {
  const adminText = raw.trim();
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
    for (const [num, st] of sessions.entries()) if (st.ticket === id) setState(num, { handoff: false });
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

// ===== Webhook Verify (GET) =====
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
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
        if (m.type !== 'text') continue;

        const from = m.from;
        const text = (m.text?.body || '').trim();
        const t = normalize(text);
        const st = getState(from);

        // Mensaje del admin
        if (ADMIN_NUMBER && from === ADMIN_NUMBER) {
          const out = await handleAdminCommand(text);
          if (out) await sendText(ADMIN_NUMBER, out);
          continue;
        }

        // En handoff → reenviar al admin
        if (st.handoff) {
          await notifyAdmin(`👤 Cliente +${from} (#${st.ticket || 'S/T'}):\n"${text}"`);
          if (['menu','menú','inicio','hola','hi','start','0','volver'].includes(t)) {
            setState(from, { handoff: false });
            await sendText(from, mainMenu());
          }
          continue;
        }

        // Flujo del bot
        if (['hola','buenas','menu','menú','inicio','start','0'].includes(t)) {
          await sendText(from, mainMenu());

        } else if (t === '1' || /khumic-?100|humico|húmico|fulvico|fúlvico|precio khumic/.test(t)) {
          if (KHUMIC100_IMG) { try { await sendImage(from, KHUMIC100_IMG, 'Khumic-100 🌱 (ácidos húmicos + fúlvicos)'); } catch {} }
          await sendText(from, productInfoKhumic100());

        } else if (t === '2' || /seaweed|alga|algas|800|precio seaweed/.test(t)) {
          if (SEAWEED800_IMG) { try { await sendImage(from, SEAWEED800_IMG, 'Khumic – Seaweed 800 🌊 (algas marinas)'); } catch {} }
          await sendText(from, productInfoSeaweed());

        } else if (t === '3' || /asesor|humano|contacto|vendedor/.test(t)) {
          const tk = st.ticket || newTicket();
          setState(from, { handoff: true, since: Date.now(), ticket: tk });
          pending.push({ number: from, ticket: tk, createdAt: Date.now() });

          if (isBusinessHours()) {
            await sendText(from, thanksInfoNow());
            await notifyAdminNew(from, text, tk);
          } else {
            await sendText(from, thanksInfoLater());
            // Si quieres avisarte siempre aunque sea fuera de horario, descomenta:
            // await notifyAdminNew(from, text, tk);
          }

        } else if (t === '4' || /beneficio.+khumic-?100|beneficios humicos|beneficios húmicos|beneficios fulvicos|beneficios fúlvicos/.test(t)) {
          await sendText(from, benefitsKhumic100());

        } else if (t === '5' || /beneficio.+seaweed|beneficios algas|beneficios alga/.test(t)) {
          await sendText(from, benefitsSeaweed800());

        } else if (t === '6' || /direccion|dirección|ubicacion|ubicación|como llegar|envio|envío|envios|envíos|cita express/.test(t)) {
          await sendText(from, contactInfo());

        } else if (t === '7' || /ficha|pdf|ficha tecnica|ficha técnica/.test(t)) {
          await sendText(from, '📄 *Fichas técnicas disponibles*\nEscribe:\n• *ficha 100* → Khumic-100\n• *ficha seaweed* → Seaweed 800');

        } else if (/^ficha\s*100$/.test(t) || /pdf\s*100/.test(t) || /ficha khumic/.test(t)) {
          if (KHUMIC100_PDF) await sendDocument(from, KHUMIC100_PDF, 'Khumic-100_Ficha_Tecnica.pdf', 'Ficha técnica Khumic-100');
          else await sendText(from, 'No tengo el PDF de Khumic-100 configurado. Pide *asesor*.');

        } else if (/^ficha\s*seaweed$/.test(t) || /pdf\s*seaweed/.test(t) || /ficha 800/.test(t)) {
          if (SEAWEED800_PDF) await sendDocument(from, SEAWEED800_PDF, 'Seaweed_800_Ficha_Tecnica.pdf', 'Ficha técnica Khumic – Seaweed 800');
          else await sendText(from, 'No tengo el PDF de Seaweed 800 configurado. Pide *asesor*.');

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

// Puerto
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, '0.0.0.0', () => console.log(`Servidor escuchando en puerto ${PORT}`));
