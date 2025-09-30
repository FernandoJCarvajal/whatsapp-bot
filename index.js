// index.js — PRO CAMPO BOT: precios, beneficios, contacto/envíos, PDFs, imágenes, handoff humano y horario laboral
const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// ===== Config obligatoria =====
const WABA_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'mi_token_123';
const ADMIN_NUMBER = process.env.ADMIN_NUMBER; // E.164 sin + (ej. 59398XXXXXXX)

// ===== Config opcional (imágenes y PDFs) =====
const KHUMIC100_IMG  = process.env.KHUMIC100_IMG  || ''; // https://...
const SEAWEED800_IMG = process.env.SEAWEED800_IMG || ''; // https://...
const KHUMIC100_PDF  = process.env.KHUMIC100_PDF  || ''; // https://...
const SEAWEED800_PDF = process.env.SEAWEED800_PDF || ''; // https://...

// ===== Utilidades envío =====
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
  return "⏰ Nuestro horario de atención es *Lunes a Viernes de 08h00 a 17h30* y *Sábados de 08h00 a 13h00* (UTC-5).";
}
function isBusinessHours() {
  const now = new Date();
  // Convertimos a hora local Ecuador (UTC-5)
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const localMinutes = (utcMinutes - 5 * 60 + 24 * 60) % (24 * 60); // UTC-5
  const day = now.getUTCDay(); // 0=Dom,1=Lun,...,6=Sab

  // Lunes-Viernes 08:00–17:30
  if (day >= 1 && day <= 5) {
    return localMinutes >= (8 * 60) && localMinutes <= (17 * 60 + 30);
  }
  // Sábado 08:00–13:00
  if (day === 6) {
    return localMinutes >= (8 * 60) && localMinutes <= (13 * 60);
  }
  // Domingo: cerrado
  return false;
}

// ===== Textos del bot =====
function mainMenu() {
  return (
`🤖🌱 ¡Hola! Soy *PRO CAMPO BOT* y estoy aquí para ayudarte en lo que necesites.
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

// Producto 1: Khumic-100 (ácidos húmicos + fúlvicos) — PRECIOS
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

📦 *Nota*: El envío es gratuito en *todas las promociones (más de 1 Kg)* mediante nuestro aliado *Cita Express*.

¿Deseas aprovechar alguna promoción?
Escribe *asesor* y te conecto con un humano.`
  );
}

// Producto 2: Seaweed 800 — PRECIOS
function productInfoSeaweed() {
  return (
`🌊 *Khumic – Seaweed 800* (algas marinas)
🌿 Bioestimulante para vigor, enraizamiento y resistencia.

💲 *Precios y Promociones*:
• 1 Kg → $16.00
• 3 Kg → $39.68  ✅ *Envío GRATIS (Cita Express)*

📄 Escribe *ficha seaweed* para recibir la ficha técnica (PDF).

📦 *Nota*: El envío es gratuito en *todas las promociones (más de 1 Kg)* mediante nuestro aliado *Cita Express*.

¿Deseas aprovechar alguna promoción?
Escribe *asesor* y te conecto con un humano.`
  );
}

// Beneficios: Khumic-100
function benefitsKhumic100() {
  return (
`🌱 *Beneficios de Khumic-100 (ácidos húmicos + fúlvicos)* 🌿

*Beneficios para las plantas:*
1. Mejora la absorción de nutrientes 💪.
2. Estimula el crecimiento y desarrollo 🌱 (más vigor y resistencia).
3. Mejora la tolerancia a la sequía ☀️ (retiene humedad).
4. Aumenta frutos y flores 🌼 (mejor rendimiento y calidad).
5. Refuerza la resistencia a enfermedades 🌿 (menos pesticidas).

*Beneficios para el suelo:*
1. Mejora la estructura del suelo 🌿 (retención de agua y nutrientes).
2. Aumenta la biodiversidad 🌸.
3. Reduce la contaminación del suelo 🚮 (mejor calidad de agua y aire).

*Beneficios para el medio ambiente:*
1. Menos fertilizantes químicos 🌿.
2. Mejora la calidad del agua 🌊.
3. Menos gases de efecto invernadero 🌟.`
  );
}

// Beneficios: Seaweed 800
function benefitsSeaweed800() {
  return (
`🌿🌊 *Beneficios de Khumic – Seaweed 800 (algas marinas)* 🌊🌿

✨ Mejora la estructura del suelo (retención de agua/nutrientes).
✨ Estimula el crecimiento (micro y macronutrientes).
✨ Incrementa la resistencia a enfermedades (compuestos naturales).
✨ Mejora la calidad y sabor de la fruta (más antioxidantes).
✨ Reduce el estrés abiótico (sequía/calor).
✨ Fertilizante natural y orgánico (no contamina).`
  );
}

// Envíos y cómo encontrarnos (política real)
function contactInfo() {
  const city = process.env.CITY || 'Ibarra';
  return (
`📍 *Envíos y cómo encontrarnos*

🏬 *Bodega principal de importación*: ${city}
🚫 *Sin atención al cliente presencial.*
📦 *Despachos con previo aviso* únicamente para *cantidades de distribuidor*.

🚚 *Envíos*: 
• *GRATIS* en *todas las promociones (más de 1 Kg)* mediante nuestro aliado *Cita Express*.
• Cobertura a *nivel nacional*.

¿Deseas coordinar un despacho o una compra mayorista?
Escribe *asesor* y te conecto con un humano.`
  );
}

function thanksInfoNow() {
  return `✅ Te conecto con un asesor humano ahora mismo. Por favor espera un momento.`;
}
function thanksInfoLater() {
  return `${businessHoursText()}

No te preocupes 🤗, puedo responder *todas tus dudas* ahora, y tu *compra* quedará *pendiente* para confirmación con un asesor en horario laboral.`;
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

// ===== Comandos del admin (tú) =====
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
        if (m.type !== 'text') continue; // manejamos texto (se puede ampliar a media)

        const from = m.from;
        const text = (m.text?.body || '').trim();
        const t = normalize(text);
        const st = getState(from);

        // Mensajes del ADMIN
        if (ADMIN_NUMBER && from === ADMIN_NUMBER) {
          const out = await handleAdminCommand(text);
          if (out) await sendText(ADMIN_NUMBER, out);
          continue;
        }

        // Si está en handoff: reenvía TODO al admin y no responde el bot
        if (st.handoff) {
          await notifyAdmin(`👤 Cliente +${from} (#${st.ticket || 'S/T'}):\n"${text}"`);
          if (['menu','menú','inicio','hola','hi','start','0','volver'].includes(t)) {
            setState(from, { handoff: false });
            await sendText(from, mainMenu());
          }
          continue;
        }

        // Flujo bot (menú y keywords)
        if (['hola','buenas','menu','menú','inicio','start','0'].includes(t)) {
          await sendText(from, mainMenu());

        // 1) Precios Khumic-100
        } else if (t === '1' || /khumic-?100|humico|húmico|fulvico|fúlvico|precio khumic/.test(t)) {
          if (KHUMIC100_IMG) { try { await sendImage(from, KHUMIC100_IMG, 'Khumic-100 🌱 (ácidos húmicos + fúlvicos)'); } catch {} }
          await sendText(from, productInfoKhumic100());

        // 2) Precios Seaweed 800
        } else if (t === '2' || /seaweed|alga|algas|800|precio seaweed/.test(t)) {
          if (SEAWEED800_IMG) { try { await sendImage(from, SEAWEED800_IMG, 'Khumic – Seaweed 800 🌊 (algas marinas)'); } catch {} }
          await sendText(from, productInfoSeaweed());

        // 3) Asesor humano (con horario)
        } else if (t === '3' || /asesor|humano|contacto|vendedor/.test(t)) {
          const tk = st.ticket || newTicket();
          setState(from, { handoff: true, since: Date.now(), ticket: tk });
          pending.push({ number: from, ticket: tk, createdAt: Date.now() });

          if (isBusinessHours()) {
            await sendText(from, thanksInfoNow());
            await notifyAdminNew(from, text, tk);
          } else {
            await sendText(from, thanksInfoLater());
            // No notificamos al admin de inmediato para no interrumpir fuera de horario,
            // pero si quieres que igual te llegue aviso, descomenta:
            // await notifyAdminNew(from, text, tk);
          }

        // 4) Beneficios Khumic-100
        } else if (t === '4' || /beneficio.+khumic-?100|beneficios humicos|beneficios húmicos|beneficios fulvicos|beneficios fúlvicos/.test(t)) {
          await sendText(from, benefitsKhumic100());

        // 5) Beneficios Seaweed 800
        } else if (t === '5' || /beneficio.+seaweed|beneficios algas|beneficios alga/.test(t)) {
          await sendText(from, benefitsSeaweed800());

        // 6) Envíos y cómo encontrarnos
        } else if (t === '6' || /direccion|dirección|ubicacion|ubicación|como llegar|envio|envío|envios|envíos|cita express/.test(t)) {
          await sendText(from, contactInfo());

        // 7) Fichas técnicas (PDF)
        } else if (t === '7' || /ficha|pdf|ficha tecnica|ficha técnica/.test(t)) {
          await sendText(from, `📄 *Fichas técnicas disponibles*\nEscribe:\n• *ficha 100* → Khumic-100\n• *ficha seaweed* → Seaweed 800`);

        // Enviar ficha específica Khumic-100
        } else if (/^ficha\s*100$/.test(t) || /pdf\s*100/.test(t) || /ficha khumic/.test(t)) {
          if (KHUMIC100_PDF) {
            await sendDocument(from, KHUMIC100_PDF, 'Khumic-100_Ficha_Tecnica.pdf', 'Ficha técnica Khumic-100');
          } else {
            await sendText(from, 'No tengo el enlace del PDF de Khumic-100 configurado. Pide *asesor* para que te lo envíe.');
          }

        // Enviar ficha específica Seaweed 800
        } else if (/^ficha\s*seaweed$/.test(t) || /pdf\s*seaweed/.test(t) || /ficha 800/.test(t)) {
          if (SEAWEED800_PDF) {
            await sendDocument(from, SEAWEED800_PDF, 'Seaweed_800_Ficha_Tecnica.pdf', 'Ficha técnica Khumic – Seaweed 800');
          } else {
            await sendText(from, 'No tengo el enlace del PDF de Seaweed 800 configurado. Pide *asesor* para que te lo envíe.');
          }

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
