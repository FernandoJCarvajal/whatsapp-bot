// index.js — Pro Campo Bot (menú + precios + fichas + notificación admin por plantilla + MODO CHAT + comandos)
import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const {
  PORT = 3000,
  WHATSAPP_VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  KHUMIC_PDF_ID,
  SEAWEED_PDF_ID,
  TZ = "America/Guayaquil",
  BOT_NAME = "PRO CAMPO BOT",
  ADMIN_PHONE,                       // 5939XXXXXXXX (sin +)
  ADMIN_TEMPLATE = "hello_world",    // plantilla para avisar al admin
  ADMIN_TEMPLATE_LANG = "en_US",     // hello_world es en inglés
  // Fallback opcional para cliente fuera de 24h (si creas esta plantilla)
  CUSTOMER_TEMPLATE = "agent_reply",
  CUSTOMER_TEMPLATE_LANG = "es",
} = process.env;

/* =================== Utilidades =================== */
const mask = (s) => (s ? s.slice(0, 4) + "***" : "MISSING");

function normalizarTexto(t = "") {
  return (t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

// Convierte teléfonos a E.164 sin "+". Ecuador: 09xxxxxxxx -> 5939xxxxxxxx.
function toE164NoPlus(input = "") {
  let d = (input || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("0") && d.length === 10 && d[1] === "9") d = "593" + d.slice(1);
  if (d.startsWith("593") && d.length === 12) return d;
  if (/^\d{8,15}$/.test(d)) return d;
  return null;
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

/* =================== Textos =================== */
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

/* =================== WhatsApp helpers =================== */
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
  if (!mediaId) {
    await enviarTexto(to, "No encuentro la ficha ahora. Intenta en unos minutos 🙏");
    return;
  }
  await waFetch("messages", {
    messaging_product: "whatsapp",
    to, type: "document",
    document: { id: mediaId, filename, caption },
  });
}

/* ===== Texto con fallback a plantilla (si ventana 24h cerrada) ===== */
async function enviarTemplateCliente(to, nombreCliente, texto) {
  try {
    await waFetch("messages", {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: CUSTOMER_TEMPLATE,
        language: { code: CUSTOMER_TEMPLATE_LANG }, // "es" o "es_EC"
        components: [{
          type: "body",
          parameters: [
            { type: "text", text: nombreCliente || "Cliente" }, // {{1}}
            { type: "text", text: BOT_NAME },                   // {{2}}
            { type: "text", text: texto || "" },                // {{3}}
          ],
        }],
      },
    });
    return true;
  } catch (e) {
    console.error("TEMPLATE Cliente ERR:", e.message);
    return false;
  }
}

async function enviarTextoConFallback(to, body, nombreCliente) {
  try {
    await enviarTexto(to, body);
    return true;
  } catch (e) {
    const s = (e.message || "").toLowerCase();
    const esVentanaCerrada =
      s.includes("24 hour") || s.includes("24-hour") ||
      s.includes("24 horas") || s.includes("outside the 24") ||
      s.includes('"code":131026') || s.includes('"code":470');
    if (esVentanaCerrada) {
      console.warn("Ventana 24h cerrada → usando plantilla:", CUSTOMER_TEMPLATE);
      return await enviarTemplateCliente(to, nombreCliente, body);
    }
    console.error("WA TEXT ERR:", e.message);
    return false;
  }
}

/* =================== Notificación al admin (PLANTILLA) =================== */
// Siempre por plantilla (hello_world) para que llegue aunque no haya ventana abierta.
async function notificarAdminPorPlantilla() {
  if (!ADMIN_PHONE) return false;
  try {
    await waFetch("messages", {
      messaging_product: "whatsapp",
      to: ADMIN_PHONE, // 5939XXXXXXXX (sin +)
      type: "template",
      template: { name: ADMIN_TEMPLATE, language: { code: ADMIN_TEMPLATE_LANG } },
    });
    return true;
  } catch (e) {
    console.error("ADMIN TEMPLATE ERR:", e.message);
    return false;
  }
}

/* =================== Estado de leads + MODO CHAT + comandos =================== */
const processed = new Set();
const recentLeads = []; // {num, name, at}
const adminCtx = { currentTo: null, currentName: null, chatMode: false };

function yaProcesado(id) {
  if (!id) return false;
  if (processed.has(id)) return true;
  processed.add(id);
  setTimeout(() => processed.delete(id), 5 * 60 * 1000);
  return false;
}

function pushLead(num, name) {
  const idx = recentLeads.findIndex(l => l.num === num);
  const item = { num, name: name || "Cliente", at: new Date().toISOString() };
  if (idx >= 0) recentLeads.splice(idx, 1);
  recentLeads.unshift(item);
  if (recentLeads.length > 10) recentLeads.pop();
  adminCtx.currentTo = num;
  adminCtx.currentName = name || "Cliente";
}

function adminHelp() {
  const who = adminCtx.currentTo ? `→ destino actual: *${adminCtx.currentName}* (${adminCtx.currentTo})` : "→ *sin destino actual*";
  const chat = adminCtx.chatMode ? "🟢 CHAT ACTIVO" : "⚪ CHAT INACTIVO";
  return (
`🛠️ *Comandos admin (responder como BOT)*  ${chat}
${who}

• *r Mensaje...*  → responde al DESTINO ACTUAL.
• *r 5939XXXXXXXX | Mensaje...* → fija destino y envía.
• *rto 5939XXXXXXXX* → fija el destino sin enviar.
• *leads* → últimos 5 leads  • *use N* → fija destino a ese lead.
• *who* → muestra el destino actual.
• *stop* → desactiva el MODO CHAT.

TIP: con CHAT ACTIVO, cualquier mensaje tuyo (sin comando) se manda al cliente.`
  );
}

/* =================== Menús & intents =================== */
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
    "3) Beneficios de *Khumic-100*\n" +
    "4) Beneficios de *Khumic – Seaweed 800*\n" +
    "5) Envíos y cómo encontrarnos\n" +
    "6) *Fichas técnicas (PDF)*\n" +
    "7) Hablar con un asesor 👨‍💼\n" +
    "0) Volver al inicio"
  );
}
function menuFichas() {
  return "📑 *Fichas técnicas disponibles*\nEscribe:\n\n• *ficha 100* → Khumic-100\n• *ficha seaweed* → Seaweed 800";
}

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

/* =================== Webhook verify (GET) =================== */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

/* =================== Webhook receive (POST) =================== */
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

    const from = msg.from; // número del remitente (sin +)
    const texto = msg.text?.body || "";
    const name  = value?.contacts?.[0]?.profile?.name || "Cliente";

    // ===== ADMIN (tu número): MODO CHAT & comandos =====
    if (ADMIN_PHONE && from === ADMIN_PHONE) {
      const t = texto.trim();

      // Comandos primero
      // r 5939... | mensaje
      let m = t.match(/^r\s+(\+?\d[\d\s-]+)\s*\|\s*([\s\S]+)$/i);
      if (m) {
        const num = toE164NoPlus(m[1]); const body = m[2].trim();
        if (!num) return enviarTexto(from, "❌ Número inválido. Usa 5939XXXXXXXX.");
        adminCtx.currentTo = num; adminCtx.currentName = "Cliente"; adminCtx.chatMode = true;
        await enviarTextoConFallback(num, body, adminCtx.currentName);
        return enviarTexto(from, `✅ Enviado a ${num} (chat activo)`);
      }

      // rto 5939...
      m = t.match(/^rto\s+(\+?\d[\d\s-]+)$/i);
      if (m) {
        const num = toE164NoPlus(m[1]);
        if (!num) return enviarTexto(from, "❌ Número inválido. Usa 5939XXXXXXXX.");
        adminCtx.currentTo = num; adminCtx.currentName = "Cliente";
        adminCtx.chatMode = true;
        return enviarTexto(from, `✅ Destino fijado: ${num} (chat activo)`);
      }

      // use N
      m = t.match(/^use\s+(\d{1,2})$/i);
      if (m) {
        const idx = parseInt(m[1], 10) - 1;
        const lead = recentLeads[idx];
        if (!lead) return enviarTexto(from, "Índice inválido.");
        adminCtx.currentTo = lead.num; adminCtx.currentName = lead.name; adminCtx.chatMode = true;
        return enviarTexto(from, `✅ Destino: ${lead.name} (${lead.num}) (chat activo)`);
      }

      // who
      if (/^who$/i.test(t)) {
        if (!adminCtx.currentTo) return enviarTexto(from, "ℹ️ No hay destino actual. Usa *leads* o *rto 5939XXXXXXXX*.");
        return enviarTexto(from, `🎯 Destino actual: ${adminCtx.currentName} (${adminCtx.currentTo}) • Chat: ${adminCtx.chatMode ? "ON" : "OFF"}`);
      }

      // leads
      if (/^leads?$/i.test(t)) {
        if (!recentLeads.length) return enviarTexto(from, "No hay leads recientes.");
        const list = recentLeads.slice(0, 5).map((l, i) => `${i + 1}) ${l.name} — ${l.num}`).join("\n");
        return enviarTexto(from, `📒 Últimos leads:\n${list}\n\nUsa *use N* para fijar destino.`);
      }

      // stop
      if (/^stop$/i.test(t)) {
        adminCtx.chatMode = false;
        return enviarTexto(from, "✋ Chat desactivado. Usa *rto* o *use* para activarlo con un cliente.");
      }

      // r Mensaje...
      m = t.match(/^r\s+([\s\S]+)$/i);
      if (m) {
        if (!adminCtx.currentTo) return enviarTexto(from, "❌ No hay destino actual. Usa *leads* o *rto 5939XXXXXXXX*.");
        const body = m[1].trim(); adminCtx.chatMode = true;
        await enviarTextoConFallback(adminCtx.currentTo, body, adminCtx.currentName);
        return enviarTexto(from, `✅ Enviado a ${adminCtx.currentTo}`);
      }

      // Si CHAT ACTIVO: cualquier texto normal se reenvía al cliente
      if (adminCtx.chatMode && adminCtx.currentTo) {
        await enviarTextoConFallback(adminCtx.currentTo, t, adminCtx.currentName);
        return enviarTexto(from, `↪️ (Tú) ${t}`);
      }

      // Si no hay chat activo ni comandos: mostrar ayuda
      return enviarTexto(from, adminHelp());
    }

    // ===== Cliente → si hay chat activo con este cliente, reenviar al admin =====
    if (adminCtx.chatMode && adminCtx.currentTo === from && ADMIN_PHONE) {
      await enviarTexto(ADMIN_PHONE, `📩 ${name}: ${texto}`);
    }

    // ===== Flujo normal de cliente =====
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
      return enviarDocumentoPorId(from, { mediaId: KHUMIC_PDF_ID, filename: "Khumic-100-ficha.pdf", caption: "📄 Ficha técnica de Khumic-100 (ácidos húmicos + fúlvicos)." });
    if (intent === "ficha_seaweed")
      return enviarDocumentoPorId(from, { mediaId: SEAWEED_PDF_ID, filename: "Seaweed-800-ficha.pdf", caption: "📄 Ficha técnica de Khumic – Seaweed 800 (algas marinas)." });

    if (intent === "asesor") {
      const msj = enHorario
        ? "¡Perfecto! Te conecto con un asesor ahora mismo. 👨‍💼📲"
        : "Gracias por escribir. Un asesor te contactará en horario laboral. Puedo ayudarte por aquí mientras tanto. 🕗";
      await enviarTexto(from, msj);

      // Registrar lead, fijar chat con este cliente y notificar al admin
      pushLead(from, name);
      adminCtx.chatMode = true;
      await notificarAdminPorPlantilla(); // hello_world al admin
      // Intento de texto explicativo al admin (si ventana abierta)
      if (ADMIN_PHONE) {
        try {
          await enviarTexto(ADMIN_PHONE,
            `🟢 CHAT ACTIVADO con ${name} (+${from}). Escribe tu mensaje aquí para responderle. ` +
            `Comandos: *stop*, *leads*, *use N*, *who*, *r*.`);
        } catch {}
      }
      return;
    }

    if (intent === "gracias") return enviarTexto(from, "¡Con mucho gusto! 😊 ¿Algo más en lo que te apoye?");
    return enviarTexto(from, menuPrincipal(enHorario)); // fallback
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

/* =================== Healthcheck y arranque =================== */
app.get("/", (_req, res) => res.send("OK"));

console.log("ENV CHECK:", {
  WHATSAPP_VERIFY_TOKEN: !!WHATSAPP_VERIFY_TOKEN,
  WHATSAPP_TOKEN: mask(WHATSAPP_TOKEN),
  PHONE_NUMBER_ID,
  KHUMIC_PDF_ID,
  SEAWEED_PDF_ID,
  TZ, BOT_NAME, ADMIN_PHONE, ADMIN_TEMPLATE, ADMIN_TEMPLATE_LANG,
  CUSTOMER_TEMPLATE, CUSTOMER_TEMPLATE_LANG
});

app.listen(PORT, () => console.log(`Bot listo en puerto ${PORT}`));
