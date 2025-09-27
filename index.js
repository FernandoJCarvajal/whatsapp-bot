// index.js — Bot empresarial con menú, keywords y aviso a asesor (CommonJS)
const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// ===== Config =====
const WABA_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'mi_token_123';
const ADMIN_NUMBER = process.env.ADMIN_NUMBER; // número personal (E.164 sin +)

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

// “Estado” simple por usuario en memoria
const sessions = new Map();
function setState(number, state) { sessions.set(number, { ...(sessions.get(number) || {}), ...state }); }
function getState(number) { return sessions.get(number) || {}; }

// ===== Respuestas =====
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
• Envío gratis en pedidos desde 3 unidades.
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
  return `✅ Listo, te contacto con un asesor humano. Por favor espera un momento.`;
}

function notifyAdmin(from, text) {
  if (!ADMIN_NUMBER) return Promise.resolve();
  const msg =
`⚠️ Solicitud de ASESOR
Cliente: +${from}
Mensaje: "${text}"`;
  return sendText(ADMIN_NUMBER, msg);
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
        if (m.type !== 'text') continue; // solo texto

        const from = m.from;                   // número del cliente (E.164 sin +)
        const text = m.text?.body || '';
        const t = normalize(text);

        // Si está en handoff (asesor), no interrumpir salvo que pida menú
        const { handoff } = getState(from);
        if (handoff && !['menu','menú','inicio','hola','hi','start','0','volver'].includes(t)) {
          continue;
        }

        if (['hola','buenas','menu','menú','inicio','start','0'].includes(t)) {
          await sendText(from, mainMenu());
        } else if (t === '1' || /producto|khumic|info|informacion|información/.test(t)) {
          await sendText(from, productInfo());
        } else if (t === '2' || /promo|promocion|promoción|oferta/.test(t)) {
          await sendText(from, promosInfo());
        } else if (t === '3' || /asesor|humano|contacto|vendedor|whatsapp/.test(t)) {
          setState(from, { handoff: true, since: Date.now() });
          await sendText(from, thanksInfo());
          await notifyAdmin(from, text);
        } else if (/precio|costo|vale|cuanto/.test(t)) {
          await sendText(from, productInfo());
        } else if (/horario|hora|abren|cierran/.test(t)) {
          await sendText(from, hoursInfo());
        } else if (/ubicacion|ubicación|direccion|dirección|donde/.test(t)) {
          await sendText(from, locationInfo());
        } else if (/comprar|pedido|orden|pagar/.test(t)) {
          setState(from, { handoff: true, since: Date.now() });
          await sendText(from, '🛒 ¡Genial! Te conecto con un asesor para completar tu pedido.');
          await notifyAdmin(from, text);
        } else if (/volver|menu|menú|inicio|0/.test(t)) {
          setState(from, { handoff: false });
          await sendText(from, mainMenu());
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

// Puerto: local usa PORT; en Render, Render define PORT automáticamente
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, '0.0.0.0', () => console.log(`Servidor escuchando en puerto ${PORT}`));



