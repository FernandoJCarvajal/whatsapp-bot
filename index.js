// index.js — Pro Campo Bot (menú + precios + fichas + asesor + panel admin)
import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true })); // para formularios del panel

// === ENV: usa exactamente los nombres que tienes en Render ===
const {
  PORT = 3000,
  WHATSAPP_VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  KHUMIC_PDF_ID,
  SEAWEED_PDF_ID,
  TZ = "America/Guayaquil",
  BOT_NAME = "PRO CAMPO BOT",
  ADMIN_PHONE,                      // 5939XXXXXXXX (sin +)
  ADMIN_TEMPLATE = "hello_world",   // p.ej. "hello_world" para test o "lead_alert_util" cuando esté aprobada
  ADMIN_TEMPLATE_LANG = "es",       // "es" (Spanish) o "es_EC" (Spanish ECU)
  ADMIN_PANEL_URL,                  // https://tu-app.onrender.com
  ADMIN_SECRET,                     // clave simple para proteger el panel
} = process.env;

// ===== Textos de precios (fijos) =====
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

// ===== Diagnóstico en arranque =====
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
    ADMIN_PHONE,
    ADMIN_TEMPLATE,
    ADMIN_TEMPLATE_LANG,
    ADMIN_PANEL_URL,
    ADMIN_SECRET: ADMIN_SECRET ? "SET" : "MISSING",
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
  const d = now.getDay(); // 0=Dom ... 6=Sáb
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
  if (!PHONE_NUMBER_ID) return console.error("PHONE_NUMBER_ID vacío.");
  try {
    await waFetch("messages", { messaging_product: "whatsapp", to, type: "text", text: { body } });
  } catch (e) {
    console.error("WA TEXT ERR:", e.message);
  }
}

async function enviarDocumentoPorId(to, { mediaId, filename, caption }) {
  if (!PHONE_NUMBER_ID) return console.error("PHONE_NUMBER_ID vacío.");
  if (!mediaId) {
    console.error("MEDIA_ID vacío:", filename);
    return enviarTexto(to, "No encuentro la ficha ahora. Intenta en unos minutos 🙏");
  }
  try {
    await waFetch("messages", {
      messaging_product: "whatsapp",
      to,
      type: "document",
      document: { id: mediaId, filename, caption },
    });
  } catch (e) {
    console.error("WA DOC ERR:", e.message);
  }
}

// ===== Notificación al ADMIN por PLANTILLA =====
// - Si ADMIN_TEMPLATE === "hello_world": se envía SIN parámetros (no tiene variables).
// - Si usas "lead_alert_util" (o similar aprobado con 5 variables), se envía CON parámetros.
async function notificarAdmin({ clienteNombre, clienteNumeroSinPlus, mensaje }) {
  if (!ADMIN_PHONE) {
    console.warn("ADMIN_PHONE no definido. No se enviará notificación.");
    return;
  }

  const replyLink =
    ADMIN_PANEL_URL && ADMIN_SECRET
      ? `${ADMIN_PANEL_URL}/admin/reply?to=${encodeURIComponent(clienteNumeroSinPlus)}&name=${encodeURIComponent(clienteNombre || "Cliente")}&t=${encodeURIComponent(ADMIN_SECRET)}`
      : "";

  const templatePayload = {
    name: ADMIN_TEMPLATE,
    language: { code: ADMIN_TEMPLATE_LANG }, // "es" o "es_EC"
  };

  // Solo añadimos variables si la plantilla las tiene (no para hello_world)
  if (ADMIN_TEMPLATE !== "hello_world") {
    templatePayload.components = [{
      type: "body",
      parameters: [
        { type: "text", text: BOT_NAME },
        { type: "text", text: clienteNombre || "Cliente" },
        { type: "text", text: `+${clienteNumeroSinPlus}` },
        { type: "text", text: `${mensaje || "(sin mensaje)"}${replyLink ? `\nResponder desde el bot: ${replyLink}` : ""}` },
        { type: "text", text: clienteNumeroSinPlus },
      ]
    }];
  }

  try {
    await waFetch("messages", {
      messaging_product: "whatsapp",
      to: ADMIN_PHONE, // 5939XXXXXXXX (sin +)
      type: "template",
      template: templatePayload,
    });
  } catch (e) {
    console.error("ADMIN TEMPLATE ERR:", e.message);
  }
}

// ===== Anti-duplicados (reintentos Meta) =====
const processed = new Set();
function yaProcesado(id) {
  if (!id) return false;
  if (processed.has(id)) return true;
  processed.add(id);
  setTimeout(() => processed.delete(id), 5 * 60 * 1000);
  return false;
}

// ===== Webhook verify (GET) =====
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
    const value = change?.value;
    const msg = value?.messages?.[0];
    if (!msg) return;

    const msgId = msg.id;
    if (yaProcesado(msgId)) return;

    const from = msg.from; // número del cliente (sin +)
    const texto = msg.text?.body || "";
    const clienteNombre = value?.contacts?.[0]?.profile?.name || "";
    const intent = detectarIntent(texto);
    const enHorario = esHorarioLaboral();

    if (intent === "inicio") return enviarTexto(from, menuPrincipal(enHorario));
    if (intent === "op1") return enviarTexto(from, MSG_PRECIOS_KHUMIC);
    if (intent === "op2") return enviarTexto(from, MSG_PRECIOS_SEAWEED);
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
        : "Gracias por escribir. Un asesor te contactará en horario laboral. Puedo ayudarte por aquí mientras tanto. 🕗";
      await enviarTexto(from, msj);

      await notificarAdmin({
        clienteNombre,
        clienteNumeroSinPlus: from,
        mensaje: texto,
      });
      return;
    }

    if (intent === "gracias") return enviarTexto(from, "¡Con mucho gusto! 😊 ¿Algo más en lo que te apoye?");
    return enviarTexto(from, menuPrincipal(enHorario)); // fallback
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

// ===== Panel admin: responder desde el número del BOT =====
app.get("/admin/reply", (req, res) => {
  const { to, name, t } = req.query;
  if (!ADMIN_SECRET || t !== ADMIN_SECRET) return res.status(403).send("Forbidden");
  const html = `
<!doctype html><meta charset="utf-8"/>
<title>Responder como ${BOT_NAME}</title>
<style>
  body{font-family:sans-serif;max-width:720px;margin:30px auto;padding:0 16px}
  input,textarea,button{width:100%;padding:10px;margin:8px 0;font-size:16px}
  .muted{color:#666}
</style>
<h2>Responder como <b>${BOT_NAME}</b></h2>
<p class="muted">Al cliente: <b>${name || "Cliente"}</b> — <code>${to}</code></p>
<form method="POST" action="/admin/reply">
  <input type="hidden" name="to" value="${to}"/>
  <input type="hidden" name="t" value="${t}"/>
  <textarea name="message" rows="6" placeholder="Escribe tu respuesta..." required></textarea>
  <button type="submit">Enviar desde el bot</button>
</form>`;
  res.status(200).send(html);
});

app.post("/admin/reply", async (req, res) => {
  const { to, message, t } = req.body || {};
  if (!ADMIN_SECRET || t !== ADMIN_SECRET) return res.status(403).send("Forbidden");
  if (!to || !message) return res.status(400).send("Faltan datos");
  try {
    await enviarTexto(to, message);
    res.status(200).send("<p>✅ Enviado. Puedes cerrar esta pestaña.</p>");
  } catch (e) {
    res.status(500).send(`<pre>Error: ${String(e)}</pre>`);
  }
});

// Healthcheck
app.get("/", (_req, res) => res.send("OK"));
app.listen(PORT, () => console.log(`Bot listo en puerto ${PORT}`));
