// index.js — Pro Campo Bot (menú completo + fichas PDF + asesor + horario)
import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ====== ENV ======
const {
  PORT = 3000,
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  KHUMIC_PDF_ID,        // p.ej. 852677735604299
  SEAWEED_PDF_ID,       // p.ej. 10792914807712453
  TZ = "America/Guayaquil",

  // (Opcional) Mensajes personalizables sin redeploy de código
  KHUMIC_PRICE_MSG,     // texto para opción 1
  SEAWEED_PRICE_MSG,    // texto para opción 2
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

// ====== Utils ======
function normalizarTexto(t = "") {
  return (t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function esHorarioLaboral(date = new Date()) {
  // Adaptar a zona horaria de Ecuador
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).format(date);
  const now = new Date(f);
  const d = now.getDay(); // 0 dom, 1 lun, ... 6 sáb
  const m = now.getHours() * 60 + now.getMinutes();
  const LV = d >= 1 && d <= 5 && m >= 8 * 60 && m <= 17 * 60 + 30;
  const SAB = d === 6 && m >= 8 * 60 && m <= 13 * 60;
  return LV || SAB;
}

// ====== Menús ======
function menuPrincipal(enHorario) {
  const saludo =
    "🤖🌱 *¡Hola! Soy PRO CAMPO BOT* y estoy aquí para ayudarte.\n" +
    "Elige una opción escribiendo el número:\n\n";
  const nota = enHorario
    ? ""
    : "_Fuera de horario: puedo darte información y dejamos la *compra* para el horario laboral (L–V 08:00–17:30, Sáb 08:00–13:00)._ \n\n";

  return (
    saludo +
    nota +
    "1️⃣  *Precios y promociones de Khumic-100* (ácidos húmicos + fúlvicos)\n" +
    "2️⃣  *Precios y promociones de Khumic – Seaweed 800* (algas marinas)\n" +
    "3️⃣  *Beneficios de Khumic-100* (ácidos húmicos + fúlvicos)\n" +
    "4️⃣  *Beneficios de Khumic – Seaweed 800* (algas marinas)\n" +
    "5️⃣  *Envíos y cómo encontrarnos*\n" +
    "6️⃣  *Fichas técnicas (PDF)*\n" +
    "7️⃣  *Hablar con un asesor* 👨‍💼\n" +
    "0️⃣  *Volver al inicio*"
  );
}

function menuFichas() {
  return (
    "📑 *Fichas técnicas disponibles*\n" +
    "Escribe:\n\n" +
    "• *ficha 100*  → Khumic-100\n" +
    "• *ficha seaweed* → Seaweed 800"
  );
}

// ====== Intents ======
function detectarIntent(texto) {
  const t = normalizarTexto(texto);

  // Menú / inicio
  if (/^(hola|buen[oa]s?|menu|men[uú]|inicio|start|0)$/i.test(t)) return "inicio";

  // Opción numérica directa
  if (/^1$/.test(t)) return "op1";
  if (/^2$/.test(t)) return "op2";
  if (/^3$/.test(t)) return "op3";
  if (/^4$/.test(t)) return "op4";
  if (/^5$/.test(t)) return "op5";
  if (/^6$/.test(t) || /^fichas?$/.test(t)) return "menu_fichas";
  if (/^7$/.test(t)) return "asesor";

  // Fichas concretas
  if (/\bficha\b/.test(t) && /\b(100|khumic|humic)\b/.test(t)) return "ficha_khumic";
  if (/\bficha\b/.test(t) && /\b(seaweed|800|algas)\b/.test(t)) return "ficha_seaweed";

  if (/asesor|agente|humano|hablar con( un)? asesor|contactar/i.test(t)) return "asesor";
  if (/gracias|muchas gracias|mil gracias|thank/i.test(t)) return "gracias";

  return "fallback";
}

// ====== WhatsApp helpers ======
async function enviarTexto(to, body) {
  if (!PHONE_NUMBER_ID) {
    console.error("PHONE_NUMBER_ID vacío; no puedo enviar.");
    return;
  }
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
  if (!PHONE_NUMBER_ID) {
    console.error("PHONE_NUMBER_ID vacío; no puedo enviar.");
    return;
  }
  if (!mediaId) {
    console.error("MEDIA_ID vacío:", filename);
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

// ====== Anti-duplicados (reintentos Meta) ======
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
    const intent = detectarIntent(texto);
    const enHorario = esHorarioLaboral();

    // ---- Rutas ----
    if (intent === "inicio") {
      await enviarTexto(from, menuPrincipal(enHorario));
      return;
    }

    if (intent === "op1") {
      const body =
        KHUMIC_PRICE_MSG ||
        "💰 *Precios y promociones de Khumic-100*\n" +
          "Escríbenos *asesor* para cotización actualizada y promociones vigentes. También puedo enviarte la ficha técnica con *ficha 100*.";
      await enviarTexto(from, body);
      return;
    }

    if (intent === "op2") {
      const body =
        SEAWEED_PRICE_MSG ||
        "💰 *Precios y promociones de Khumic – Seaweed 800*\n" +
          "Escríbenos *asesor* para cotización actualizada y promociones vigentes. También puedo enviarte la ficha técnica con *ficha seaweed*.";
      await enviarTexto(from, body);
      return;
    }

    if (intent === "op3") {
      await enviarTexto(
        from,
        "🌿 *Beneficios de Khumic-100*\n" +
          "• Mejora estructura del suelo y retención de agua.\n" +
          "• Aumenta disponibilidad de nutrientes (quelatación natural).\n" +
          "• Estimula raíces y actividad microbiana.\n" +
          "• Favorece la absorción de N-P-K y microelementos."
      );
      return;
    }

    if (intent === "op4") {
      await enviarTexto(
        from,
        "🌊 *Beneficios de Khumic – Seaweed 800*\n" +
          "• Bioestimulante de origen marino (algas).\n" +
          "• Mayor brotación, floración y amarre de fruto.\n" +
          "• Tolerancia al estrés (sequía, salinidad, temperatura).\n" +
          "• Mejor calidad y rendimiento del cultivo."
      );
      return;
    }

    if (intent === "op5") {
      await enviarTexto(
        from,
        "🚚 *Envíos y cómo encontrarnos*\n" +
          "Hacemos envíos en Ecuador. Dime tu *ciudad* para calcular costo y tiempo de entrega.\n" +
          "Horario de atención: L–V 08:00–17:30, Sáb 08:00–13:00.\n" +
          "Si prefieres, escribe *asesor* y te contactamos."
      );
      return;
    }

    if (intent === "menu_fichas") {
      await enviarTexto(from, menuFichas());
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
        caption: "📄 Ficha técnica de Khumic – Seaweed 800 (algas marinas).",
      });
      return;
    }

    if (intent === "asesor") {
      const msj = enHorario
        ? "¡Perfecto! Te conecto con un asesor ahora mismo. 👨‍💼📲"
        : "Gracias por escribir. Un asesor te contactará en el horario laboral. Puedo ayudarte por aquí y dejamos la *compra* para el horario de atención. 🕗";
      await enviarTexto(from, msj);
      return;
    }

    if (intent === "gracias") {
      await enviarTexto(from, "¡Con mucho gusto! 😊 ¿Necesitas algo más?");
      return;
    }

    // fallback
    await enviarTexto(from, menuPrincipal(enHorario));
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

// Healthcheck
app.get("/", (_req, res) => res.send("OK"));
app.listen(PORT, () => console.log(`Bot listo en puerto ${PORT}`));
