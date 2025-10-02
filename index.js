import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const {
  PORT = 3000,
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  KHUMIC_PDF_ID,        // 852677735604299
  SEAWEED_PDF_ID,       // 10792914807712453
  TZ = "America/Guayaquil",
} = process.env;

// ====== Diagnóstico en arranque ======
(function bootCheck() {
  const mask = (s) => (s ? s.slice(0, 4) + "***" : "MISSING");
  console.log("ENV CHECK:", {
    VERIFY_TOKEN: !!VERIFY_TOKEN,
    WHATSAPP_TOKEN: mask(WHATSAPP_TOKEN),
    PHONE_NUMBER_ID,
    KHUMIC_PDF_ID,
    SEAWEED_PDF_ID,
    TZ,
  });
})();

// ====== Utilidades ======
function normalizarTexto(t = "") {
  return (t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function esHorarioLaboral(date = new Date()) {
  // Convertir a zona horaria local
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const parsed = new Date(fmt.format(date));
  const d = parsed.getDay(); // 0 dom, 1 lun ... 6 sab
  const h = parsed.getHours(), m = parsed.getMinutes();
  const hm = h * 60 + m;

  const LV = d >= 1 && d <= 5 && hm >= 8 * 60 && hm <= 17 * 60 + 30;
  const SAB = d === 6 && hm >= 8 * 60 && hm <= 13 * 60;
  return LV || SAB;
}

function detectarIntent(texto) {
  const t = normalizarTexto(texto);

  if (/^(hola|buen[oa]s?|menu|men[uú]|inicio|start)$/i.test(t)) return "inicio";
  if (/^(6|ficha|fichas)$/i.test(t)) return "menu_fichas";
  if (/\bficha\b/.test(t) && /\b(100|khumic|humic)\b/.test(t)) return "ficha_khumic";
  if (/\bficha\b/.test(t) && /\b(seaweed|800|algas)\b/.test(t)) return "ficha_seaweed";

  if (/^(7|asesor|agente|humano|hablar con( un)? asesor|contactar)$/i.test(t)) return "asesor";
  if (/gracias|muchas gracias|mil gracias|thank/i.test(t)) return "gracias";

  if (/volver( al)? inicio|menu|men[uú]|inicio/i.test(t)) return "inicio";
  return "fallback";
}

async function enviarTexto(to, body) {
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
  if (!mediaId || `${mediaId}`.toLowerCase() === "undefined") {
    console.error("MEDIA_ID VACÍO:", filename);
    await enviarTexto(to, "Lo siento, no encuentro la ficha ahora. Intenta de nuevo en unos minutos 🙏");
    return;
  }
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "document",
    document: { id: mediaId, filename, caption },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) console.error("WA DOC ERR:", await r.text());
}

function textoMenuPrincipal(enHorario) {
  const nota = enHorario
    ? "Estamos en horario de atención. ¿Qué deseas hacer?"
    : "Fuera de horario: puedo darte info y dejamos la *compra* para el horario laboral (L–V 08:00–17:30, Sáb 08:00–13:00).";
  return (
    "🧭 *Menú principal*\n" +
    `${nota}\n\n` +
    "1) Precios y promociones de *Khumic-100*\n" +
    "2) Precios y promociones de *Khumic – Seaweed 800*\n" +
    "3) Beneficios de *Khumic-100*\n" +
    "4) Beneficios de *Khumic – Seaweed 800*\n" +
    "5) Envíos y cómo encontrarnos\n" +
    "6) *Fichas técnicas (PDF)*\n" +
    "7) *Hablar con un asesor* 👨‍💼\n" +
    "8) Volver al inicio\n\n" +
    "Escribe el número o la opción."
  );
}

function textoMenuFichas() {
  return (
    "📑 *Fichas técnicas disponibles*\n" +
    "Escribe:\n\n" +
    "• *ficha 100* → Khumic-100\n" +
    "• *ficha seaweed* → Seaweed 800"
  );
}

// ====== Anti-duplicados (reintentos de Meta) ======
const processed = new Set();
function yaProcesado(id) {
  if (!id) return false;
  if (processed.has(id)) return true;
  processed.add(id);
  setTimeout(() => processed.delete(id), 5 * 60 * 1000);
  return false;
}

// ====== Webhook verify (GET) ======
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// ====== Webhook receive (POST) ======
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // responder rápido a Meta

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const msg = change?.value?.messages?.[0];
    if (!msg) return;

    const msgId = msg.id;
    if (yaProcesado(msgId)) return;

    const from = msg.from;
    const texto = msg.text?.body || "";
    const enHorario = esHorarioLaboral();
    const intent = detectarIntent(texto);

    // --- Rutas de intent ---
    if (intent === "inicio" || intent === "fallback") {
      await enviarTexto(from, textoMenuPrincipal(enHorario));
      return;
    }

    if (intent === "menu_fichas") {
      await enviarTexto(from, textoMenuFichas());
      return;
    }

    if (intent === "ficha_khumic") {
      await enviarDocumentoPorId(from, {
        mediaId: KHUMIC_PDF_ID,
        filename: "Khumic-100-ficha.pdf",
        caption: "📄 Ficha técnica de Khumic-100 (ácidos húmicos + fúlvicos).",
      });
      return;
    }

    if (intent === "ficha_seaweed") {
      await enviarDocumentoPorId(from, {
        mediaId: SEAWEED_PDF_ID,
        filename: "Seaweed-800-ficha.pdf",
        caption: "📄 Ficha técnica de Seaweed 800 (algas marinas).",
      });
      return;
    }

    if (intent === "asesor") {
      const msj = enHorario
        ? "¡Perfecto! Te conecto con un asesor ahora mismo. 👨‍💼📲"
        : "Gracias por escribir. Un asesor te contactará en el horario laboral. Yo puedo ayudarte por aquí y la *compra* la dejamos para el horario de atención. 🕗";
      await enviarTexto(from, msj);
      // Aquí podrías disparar una notificación interna a tu equipo
      return;
    }

    if (intent === "gracias") {
      await enviarTexto(from, "¡Con mucho gusto! 😊 Estamos muy gustosos de ayudarte. ¿Algo más en lo que te apoye?");
      return;
    }
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

// Salud
app.get("/", (_req, res) => res.send("OK"));
app.listen(PORT, () => console.log(`Bot listo en puerto ${PORT}`));
