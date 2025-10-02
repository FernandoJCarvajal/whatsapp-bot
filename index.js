// index.js — Pro Campo Bot (compatible con tus variables de Render)
import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// === ENV: usando exactamente los nombres que tienes en Render ===
const {
  PORT = 3000,
  WHATSAPP_VERIFY_TOKEN,      // <- tu verify token
  WHATSAPP_TOKEN,             // <- tu token EAA…
  PHONE_NUMBER_ID,            // <- 844566595398410
  KHUMIC_PDF_ID,              // <- media_id Khumic-100
  SEAWEED_PDF_ID,             // <- media_id Seaweed 800
  TZ = "America/Guayaquil",
  BOT_NAME = "PRO CAMPO BOT", // <- lo muestras en el saludo
  // (opcionales, para precio)
  KHUMIC_PRICE_MSG,
  SEAWEED_PRICE_MSG,
} = process.env;

// ===== Diagnóstico de arranque =====
(function bootCheck() {
  const mask = (s) => (s ? s.slice(0, 4) + "***" : "MISSING");
  console.log("ENV CHECK:", {
    WHATSAPP_VERIFY_TOKEN: !!WHATSAPP_VERIFY_TOKEN,
    WHATSAPP_TOKEN: mask(WHATSAPP_TOKEN),
    PHONE_NUMBER_ID,
    KHUMIC_PDF_ID,
    SEAWEED_PDF_ID,
    TZ,
    BOT_NAME,
  });
})();

// ===== Utils =====
function normalizarTexto(t = "") {
  return (t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}
function esHorarioLaboral(date = new Date()) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).format(date);
  const now = new Date(f);
  const d = now.getDay();               // 0=Dom ... 6=Sáb
  const m = now.getHours() * 60 + now.getMinutes();
  const LV = d >= 1 && d <= 5 && m >= 8 * 60 && m <= 17 * 60 + 30;
  const SAB = d === 6 && m >= 8 * 60 && m <= 13 * 60;
  return LV || SAB;
}

// ===== Menús =====
function menuPrincipal(enHorario) {
  const saludo =
    `🤖🌱 *¡Hola! Soy ${BOT_NAME.toUpperCase()}* y estoy aquí para ayudarte.\n` +
    "Elige una opción escribiendo el número:\n\n";
  const nota = enHorario ? "" :
    "_Fuera de horario: puedo darte información y dejamos la *compra* para el horario laboral (L–V 08:00–17:30, Sáb 08:00–13:00)._ \n\n";
  return (
    saludo + nota +
    "1) Precios y promociones de *Khumic-100* (ácidos húmicos + fúlvicos)\n" +
    "2) Precios y promociones de *Khumic – Seaweed 800* (algas marinas)\n" +
    "3) Beneficios de *Khumic-100* (ácidos húmicos + fúlvicos)\n" +
    "4) Beneficios de *Khumic – Seaweed 800* (algas marinas)\n" +
    "5) Envíos y cómo encontrarnos\n" +
    "6) *Fichas técnicas (PDF)*\n" +
    "7) Hablar con un asesor 👨‍💼\n" +
    "0) Volver al inicio"
  );
}
function menuFichas() {
  return "📑 *Fichas técnicas disponibles*\nEscribe:\n\n• *ficha 100* → Khumic-100\n• *ficha seaweed* → Seaweed 800";
}

// ===== Intents =====
function detectarIntent(texto) {
  const t = normalizarTexto(texto);
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

// ===== WhatsApp helpers =====
async function enviarTexto(to, body) {
  if (!PHONE_NUMBER_ID) return console.error("PHONE_NUMBER_ID vacío.");
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  const payload = { messaging_product: "whatsapp", to, type: "text", text: { body } };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) console.error("WA TEXT ERR:", await r.text());
}
async function enviarDocumentoPorId(to, { mediaId, filename, caption }) {
  if (!PHONE_NUMBER_ID) return console.error("PHONE_NUMBER_ID vacío.");
  if (!mediaId) {
    console.error("MEDIA_ID vacío:", filename);
    return enviarTexto(to, "No encuentro la ficha ahora. Intenta en unos minutos 🙏");
  }
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to, type: "document",
    document: { id: mediaId, filename, caption },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) console.error("WA DOC ERR:", await r.text());
}

// ===== Anti-duplicados =====
const processed = new Set();
function yaProcesado(id) {
  if (!id) return false;
  if (processed.has(id)) return true;
  processed.add(id);
  setTimeout(() => processed.delete(id), 5 * 60 * 1000);
  return false;
}

// ===== Webhook verify (GET) — usa WHATSAPP_VERIFY_TOKEN =====
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// ===== Webhook receive (POST) =====
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const msg = change?.value?.messages?.[0];
    if (!msg) return;

    const msgId = msg.id;
    if (yaProcesado(msgId)) return;

    const from = msg.from;
    const texto = msg.text?.body || "";
    const intent = detectarIntent(texto);
    const enHorario = esHorarioLaboral();

    if (intent === "inicio") return enviarTexto(from, menuPrincipal(enHorario));
    if (intent === "op1")
      return enviarTexto(
        from,
        KHUMIC_PRICE_MSG ||
          "💰 *Precios y promociones de Khumic-100*\nEscríbenos *asesor* para cotización actualizada y promociones vigentes. También puedo enviarte la ficha con *ficha 100*."
      );
    if (intent === "op2")
      return enviarTexto(
        from,
        SEAWEED_PRICE_MSG ||
          "💰 *Precios y promociones de Khumic – Seaweed 800*\nEscríbenos *asesor* para cotización actualizada y promociones vigentes. También puedo enviarte la ficha con *ficha seaweed*."
      );
    if (intent === "op3")
      return enviarTexto(
        from,
        "🌿 *Beneficios de Khumic-100*\n• Mejora estructura del suelo y retención de agua.\n• Aumenta disponibilidad de nutrientes.\n• Estimula raíces y actividad microbiana.\n• Favorece absorción de N-P-K y microelementos."
      );
    if (intent === "op4")
      return enviarTexto(
        from,
        "🌊 *Beneficios de Khumic – Seaweed 800*\n• Bioestimulante de algas marinas.\n• Mayor brotación, floración y amarre.\n• Tolerancia al estrés (sequía/salinidad/temperatura).\n• Mejor calidad y rendimiento."
      );
    if (intent === "op5")
      return enviarTexto(
        from,
        "🚚 *Envíos y cómo encontrarnos*\nHacemos envíos en Ecuador. Dime tu *ciudad* para calcular costo y tiempo.\nHorario: L–V 08:00–17:30, Sáb 08:00–13:00.\nEscribe *asesor* si deseas atención humana."
      );
    if (intent === "menu_fichas") return enviarTexto(from, menuFichas());
    if (intent === "ficha_khumic")
      return enviarDocumentoPorId(from, {
        mediaId: KHUMIC_PDF_ID,
        filename: "Khumic-100-ficha.pdf",
        caption: "📄 Ficha técnica de Khumic-100 (ácidos húmicos + fúlvicos).",
      });
    if (intent === "ficha_seaweed")
      return enviarDocumentoPorId(from, {
        mediaId: SEAWEED_PDF_ID,
        filename: "Seaweed-800-ficha.pdf",
        caption: "📄 Ficha técnica de Khumic – Seaweed 800 (algas marinas).",
      });
    if (intent === "asesor") {
      const msj = enHorario
        ? "¡Perfecto! Te conecto con un asesor ahora mismo. 👨‍💼📲"
        : "Gracias por escribir. Un asesor te contactará en horario laboral. Yo puedo ayudarte por aquí mientras tanto. 🕗";
      return enviarTexto(from, msj);
    }
    if (intent === "gracias") return enviarTexto(from, "¡Con mucho gusto! 😊 ¿Algo más en lo que te apoye?");

    // Fallback ⇒ mostrar menú
    return enviarTexto(from, menuPrincipal(enHorario));
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

// Healthcheck
app.get("/", (_req, res) => res.send("OK"));
app.listen(PORT, () => console.log(`Bot listo en puerto ${PORT}`));
