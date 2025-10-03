// index.js — Pro Campo Bot (simple: menú + fichas + alerta corta al admin + respuesta 'r')
import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ====== ENV ======
const {
  PORT = 3000,
  WHATSAPP_VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  KHUMIC_PDF_ID,
  SEAWEED_PDF_ID,
  TZ = "America/Guayaquil",
  BOT_NAME = "PRO CAMPO BOT",

  // Admin (tu número personal, sin "+", p.ej. 5939XXXXXXXX)
  ADMIN_PHONE,

  // Plantilla sólo para abrir conversación si se necesita
  ADMIN_TEMPLATE = "hello_world",
  ADMIN_TEMPLATE_LANG = "en_US",
} = process.env;

const mask = s => (s ? s.slice(0, 4) + "***" : "MISSING");
console.log("ENV CHECK:", {
  VERIFY: !!WHATSAPP_VERIFY_TOKEN,
  TOKEN: mask(WHATSAPP_TOKEN),
  PHONE_NUMBER_ID,
  KHUMIC_PDF_ID,
  SEAWEED_PDF_ID,
  TZ, BOT_NAME, ADMIN_PHONE, ADMIN_TEMPLATE, ADMIN_TEMPLATE_LANG,
});

// ====== Utils ======
function normalizar(t = "") {
  return (t || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").trim();
}
function esHorarioLaboral(date = new Date()) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date);
  const d = new Date(f);
  const w = d.getDay();                // 0=Dom..6=Sáb
  const m = d.getHours() * 60 + d.getMinutes();
  return (w >= 1 && w <= 5 && m >= 480 && m <= 1050) || (w === 6 && m >= 480 && m <= 780);
}
const processed = new Set();
const lastLead = { to: null, name: null };

function yaProcesado(id) {
  if (!id) return false;
  if (processed.has(id)) return true;
  processed.add(id);
  setTimeout(() => processed.delete(id), 5 * 60 * 1000);
  return false;
}

// Tag corto tipo #ABC123 a partir del id del mensaje
function shortTag(str = "") {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h.toString(36).slice(-6).toUpperCase();
}

// ====== WhatsApp helpers ======
async function waFetch(path, payload) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/${path}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function enviarTexto(to, body) {
  await waFetch("messages", { messaging_product: "whatsapp", to, type: "text", text: { body } });
}
async function enviarDocumentoPorId(to, { mediaId, filename, caption }) {
  if (!mediaId) return enviarTexto(to, "No encuentro la ficha ahora. Intenta en unos minutos 🙏");
  await waFetch("messages", {
    messaging_product: "whatsapp",
    to, type: "document",
    document: { id: mediaId, filename, caption },
  });
}

// ====== Notificación simple al admin (con fallback a plantilla) ======
async function notificarAdminSimple({ from, text, tag }) {
  if (!ADMIN_PHONE) return;

  const body = `Cliente +${from} (#${tag}):\n"${text || "(sin mensaje)"}"`;

  try {
    await enviarTexto(ADMIN_PHONE, body);       // 1) intento directo (simple)
  } catch (e) {
    const s = (e.message || "").toLowerCase();
    const ventanaCerrada = s.includes("24") || s.includes('"code":131026') || s.includes('"code":470');
    if (!ventanaCerrada) {
      console.error("ADMIN TEXT ERR:", e.message);
      return;
    }
    // 2) abre conversación con plantilla y luego envía el texto
    try {
      await waFetch("messages", {
        messaging_product: "whatsapp",
        to: ADMIN_PHONE,
        type: "template",
        template: { name: ADMIN_TEMPLATE, language: { code: ADMIN_TEMPLATE_LANG } },
      });
      await enviarTexto(ADMIN_PHONE, body);
    } catch (e2) {
      console.error("ADMIN TEMPLATE/TEXT ERR:", e2.message);
    }
  }
}

// ====== Textos ======
const MSG_PRECIOS_KHUMIC =
`💰 *Precios y promociones de Khumic-100*
• *1 kg:* $13.96
• *Promo 3 kg (incluye envío):* $34.92
• *Promo 25 kg (incluye envío):* $226.98
• *Promo 50 kg (incluye envío):* $436.50

📦 Envíos a todo Ecuador.
Escribe *asesor* para comprar o *ficha 100* para la ficha técnica.`;

const MSG_PRECIOS_SEAWEED =
`💰 *Precios y promociones de Khumic – Seaweed 800*
• *1 kg:* $15.87
• *Promo 3 kg (incluye envío):* $39.68

📦 Envíos a todo Ecuador.
Escribe *asesor* para comprar o *ficha seaweed* para la ficha técnica.`;

// ====== Menú ======
function menuPrincipal(enHorario) {
  const saludo =
    `🤖🌱 *¡Hola! Soy ${BOT_NAME.toUpperCase()}* y estoy aquí para ayudarte.\n` +
    "Elige una opción escribiendo el número:\n\n";
  const nota = enHorario ? "" :
    "_Fuera de horario: puedo darte info y dejamos la *compra* para el horario laboral (L–V 08:00–17:30, Sáb 08:00–13:00)._ \n\n";
  return (
    saludo + nota +
    "1) Precios y promociones de *Khumic-100*\n" +
    "2) Precios y promociones de *Khumic – Seaweed 800*\n" +
    "3) Beneficios de Khumic-100\n" +
    "4) Beneficios de Khumic – Seaweed 800\n" +
    "5) Envíos y cómo encontrarnos\n" +
    "6) *Fichas técnicas (PDF)*\n" +
    "7) Hablar con un asesor 👨‍💼\n" +
    "0) Volver al inicio"
  );
}
const menuFichas = () =>
  "📑 *Fichas técnicas disponibles*\nEscribe:\n\n• *ficha 100* → Khumic-100\n• *ficha seaweed* → Seaweed 800";

// ====== Intents ======
function detectarIntent(texto) {
  const t = normalizar(texto);
  if (/^(hola|buen[oa]s?|menu|men[uú]|inicio|start|0)$/i.test(t)) return "inicio";
  if (/^1$/.test(t)) return "op1";
  if (/^2$/.test(t)) return "op2";
  if (/^3$/.test(t)) return "op3";
  if (/^4$/.test(t)) return "op4";
  if (/^5$/.test(t)) return "op5";
  if (/^6$/.test(t) || /^fichas?$/.test(t)) return "menu_fichas";
  if (/^7$/.test(t)) return "asesor";
  if (/\bficha\b/.test(t) && /\b(100|khumic|humic)\b/.test(t)) return "ficha_khumic";
  if (/\bficha\b/.test(t) && /\b(seaweed|800|algas)\b/.test(t)) return "ficha_seaweed";
  if (/asesor|agente|humano|hablar con( un)? asesor|contactar/i.test(t)) return "asesor";
  if (/gracias|muchas gracias|mil gracias|thank/i.test(t)) return "gracias";
  return "fallback";
}

// ====== Webhook verify ======
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// ====== Webhook receive ======
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    if (!msg) return;
    if (yaProcesado(msg.id)) return;

    const from = msg.from; // número cliente (sin +)
    const texto = msg.text?.body || "";
    const name  = value?.contacts?.[0]?.profile?.name || "Cliente";

    // === Comandos simples del admin en su chat con el bot ===
    if (ADMIN_PHONE && from === ADMIN_PHONE) {
      const t = texto.trim();

      // r 5939... | mensaje
      let m = t.match(/^r\s+(\+?\d[\d\s-]+)\s*\|\s*([\s\S]+)$/i);
      if (m) {
        const num = (m[1] || "").replace(/\D/g, "");
        const body = m[2].trim();
        if (!/^\d{8,15}$/.test(num)) return enviarTexto(from, "❌ Número inválido. Usa 5939XXXXXXXX.");
        lastLead.to = num; lastLead.name = "Cliente";
        await enviarTexto(num, body);
        return enviarTexto(from, `✅ Enviado a ${num}`);
      }

      // r Mensaje... (usa el último lead)
      m = t.match(/^r\s+([\s\S]+)$/i);
      if (m) {
        if (!lastLead.to) return enviarTexto(from, "No hay destino. Usa: r 5939XXXXXXXX | Mensaje");
        await enviarTexto(lastLead.to, m[1].trim());
        return enviarTexto(from, `✅ Enviado a ${lastLead.to}`);
      }

      return enviarTexto(from, "Comandos:\n• r 5939XXXXXXXX | Mensaje\n• r Mensaje (al último lead)");
    }

    // === Cliente normal ===
    const intent = detectarIntent(texto);
    const enHorario = esHorarioLaboral();

    if (intent === "inicio") return enviarTexto(from, menuPrincipal(enHorario));
    if (intent === "op1") return enviarTexto(from, MSG_PRECIOS_KHUMIC);
    if (intent === "op2") return enviarTexto(from, MSG_PRECIOS_SEAWEED);
    if (intent === "op3")
      return enviarTexto(from, "🌿 Beneficios de Khumic-100:\n• Mejora suelo y retención de agua.\n• Aumenta disponibilidad de nutrientes.\n• Estimula raíces y microvida.");
    if (intent === "op4")
      return enviarTexto(from, "🌊 Beneficios de Seaweed 800:\n• Bioestimulante de algas.\n• Mejor brotación y amarre.\n• Mayor tolerancia al estrés.");
    if (intent === "op5")
      return enviarTexto(from, "🚚 Envíos en Ecuador. Dime tu *ciudad* para calcular costo y tiempo.\nHorario: L–V 08:00–17:30, Sáb 08:00–13:00.");
    if (intent === "menu_fichas") return enviarTexto(from, menuFichas());
    if (intent === "ficha_khumic")
      return enviarDocumentoPorId(from, { mediaId: KHUMIC_PDF_ID, filename: "Khumic-100-ficha.pdf", caption: "📄 Ficha Khumic-100." });
    if (intent === "ficha_seaweed")
      return enviarDocumentoPorId(from, { mediaId: SEAWEED_PDF_ID, filename: "Seaweed-800-ficha.pdf", caption: "📄 Ficha Seaweed 800." });

    if (intent === "asesor") {
      const msj = enHorario
        ? "¡Perfecto! Te conecto con un asesor ahora mismo. 👨‍💼📲"
        : "Gracias por escribir. Un asesor te contactará en horario laboral. Puedo ayudarte por aquí mientras tanto. 🕗";
      await enviarTexto(from, msj);

      // Guarda como último lead y notifica
      lastLead.to = from; lastLead.name = name;
      const tag = shortTag(msg.id || from);
      await notificarAdminSimple({ from, text: texto, tag });
      return;
    }

    if (intent === "gracias") return enviarTexto(from, "¡Con gusto! 😊 ¿Algo más?");
    return enviarTexto(from, menuPrincipal(enHorario)); // fallback
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

// ====== Healthcheck ======
app.get("/", (_req, res) => res.send("OK"));
app.listen(PORT, () => console.log(`Bot listo en puerto ${PORT}`));
