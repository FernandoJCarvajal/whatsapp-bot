// index.js — Pro Campo Bot
// - Saludo PRO-CAMPO BOT + emojis + keycaps
// - Precios con envío incluido
// - Envíos: Cita Express + QR/URL de rastreo
// - Beneficios ampliados (Khumic-100 y Seaweed 800) + Guía rápida de uso
// - Footer en cada apartado: 7 asesor / 0 inicio
// - NUEVO: Opción 8 con sitio web y redes (Web, Facebook, TikTok)
// - Tickets cortos y chat activo para responder sin repetir ticket
// Requiere Node 18+ (fetch nativo) y package.json con { "type": "module" }.

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
  ADMIN_PHONE, // 5939XXXXXXXX (sin +)
} = process.env;

// Nombre visible en el saludo
const DISPLAY_BOT_NAME = "PRO-CAMPO BOT";

/* =================== Utils =================== */
const mask = s => (s ? s.slice(0, 4) + "***" : "MISSING");
console.log("ENV CHECK:", {
  VERIFY: !!WHATSAPP_VERIFY_TOKEN,
  TOKEN: mask(WHATSAPP_TOKEN),
  PHONE_NUMBER_ID,
  KHUMIC_PDF_ID,
  SEAWEED_PDF_ID,
  TZ, BOT_NAME, ADMIN_PHONE
});

function normalizar(t = "") {
  return (t || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").trim();
}
function esHorarioLaboral(date = new Date()) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).format(date);
  const d = new Date(f);
  const w = d.getDay();                         // 0=Dom..6=Sáb
  const m = d.getHours() * 60 + d.getMinutes(); // minutos
  const LV = (w >= 1 && w <= 5) && (m >= 8*60 && m <= 17*60+30);
  const SA = (w === 6) && (m >= 8*60 && m <= 13*60);
  return LV || SA;
}
const processed = new Set();
function yaProcesado(id) {
  if (!id) return false;
  if (processed.has(id)) return true;
  processed.add(id);
  setTimeout(() => processed.delete(id), 5 * 60 * 1000);
  return false;
}

// Ticket corto tipo #MABDE3
function shortTicket(seed = "") {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h.toString(36).slice(-6).toUpperCase(); // 4–6 chars
}

/* =================== WA helpers =================== */
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
  try {
    await waFetch("messages", { messaging_product: "whatsapp", to, type: "text", text: { body } });
    return true;
  } catch (e) {
    console.error("WA TEXT ERR:", e.message);
    if (ADMIN_PHONE && to !== ADMIN_PHONE) {
      try {
        await waFetch("messages", {
          messaging_product: "whatsapp",
          to: ADMIN_PHONE,
          type: "text",
          text: { body: "⚠️ No se pudo entregar un mensaje al cliente (ventana 24 h cerrada)." }
        });
      } catch {}
    }
    return false;
  }
}
async function enviarDocumentoPorId(to, { mediaId, filename, caption }) {
  if (!mediaId) return enviarTexto(to, "No encuentro la ficha ahora. Intenta en unos minutos 🙏");
  try {
    await waFetch("messages", {
      messaging_product: "whatsapp",
      to, type: "document",
      document: { id: mediaId, filename, caption },
    });
  } catch (e) {
    console.error("WA DOC ERR:", e.message);
  }
}

/* =================== Tickets & Chat =================== */
const tickets = new Map();   // ticketId -> { num, name }
const byNumber = new Map();  // num -> ticketId
const recent = [];           // [{ticket, name}]
const adminCtx = { activeTicket: null };

function ensureTicket(num, name, seedForId) {
  let ticket = byNumber.get(num);
  if (!ticket) {
    ticket = shortTicket(seedForId || num);
    let iter = 0;
    while (tickets.has(ticket)) { ticket = shortTicket(ticket + (++iter)); }
    tickets.set(ticket, { num, name: name || "Cliente" });
    byNumber.set(num, ticket);
    recent.unshift({ ticket, name: name || "Cliente" });
    if (recent.length > 10) recent.pop();
  } else {
    const t = tickets.get(ticket);
    if (name && t && !t.name) t.name = name;
  }
  return ticket;
}

function adminHelp() {
  const active = adminCtx.activeTicket
    ? `🎯 Ticket activo: #${adminCtx.activeTicket} • Cliente: ${tickets.get(adminCtx.activeTicket)?.name}`
    : "🎯 Ticket activo: (ninguno)";
  const lista = recent.slice(0, 5).map((x,i)=>`${i+1}) #${x.ticket} — ${x.name}`).join("\n") || "(vacío)";
  return (
`${active}

Comandos:
• *use #ABC123*  → activar ticket por código
• *use 1*        → activar ticket por índice de la lista
• *leads*        → ver últimos tickets
• *who*          → ver ticket activo
• *stop*         → desactivar chat

Con ticket activo, *solo escribe* y tu mensaje se envía al cliente.`
  );
}

/* =================== Textos + Footer =================== */
function withFooter(txt) {
  return (
    txt +
    "\n\n➡️ *Para continuar*, responde con el número:\n" +
    "• 7️⃣ Hablar con un asesor\n" +
    "• 0️⃣ Volver al inicio"
  );
}

const MSG_PRECIOS_KHUMIC = withFooter(
`💰 *Precios y promociones de Khumic-100*
• *1 kg:* $13.96
• *Promo 3 kg (incluye envío):* $34.92
• *Promo 25 kg (incluye envío):* $226.98
• *Promo 50 kg (incluye envío):* $436.50

🚚 *Estas promociones incluyen el envío.*
ℹ️ *Nota:* sujeto a disponibilidad logística y rutas de entrega.`
);

const MSG_PRECIOS_SEAWEED = withFooter(
`💰 *Precios y promociones de Khumic – Seaweed 800*
• *1 kg:* $15.87
• *Promo 3 kg (incluye envío):* $39.68

🚚 *Estas promociones incluyen el envío.*
ℹ️ *Nota:* sujeto a disponibilidad logística y rutas de entrega.`
);

// === Beneficios + Guía rápida de uso (aplica para ambos productos) ===
const GUIA_USO =
`\n\n🧪 *Guía rápida de uso (referencia general)*\n` +
`• *Dosis general:* 3–4 kg/ha/mes.\n` +
`• *Recomendación:* dividir en *2 aplicaciones* de igual parte *cada 15 días*.\n` +
`• *Tanque 200 L:* aplicar *0,5 kg* cada *15 días*.\n` +
`• *Por volumen de agua:* *2,5–3,5 g/L*.\n` +
`• *Vías de aplicación:* edáfico/fertirriego y foliar.\n` +
`• Ajustar según *cultivo, etapa y condiciones*; realizar *prueba de compatibilidad* antes de mezclar.`;

// Beneficios ampliados
const MSG_BENEFICIOS_KHUMIC = withFooter(
`🌿 *Beneficios de Khumic-100* (ácidos húmicos + fúlvicos)
• Mejora la *estructura del suelo* (agregación) y la *aireación*.
• Aumenta la *capacidad de intercambio catiónico (CIC)* y la *retención de agua*.
• *Quelata y moviliza* nutrientes (Fe, Zn, Mn, Cu, etc.).
• Incrementa la *disponibilidad y absorción* de N–P–K y micronutrientes.
• *Estimula el desarrollo radicular* (raíces más largas y con más pelos absorbentes).
• *Activa la microbiología benéfica* y la *actividad enzimática* del suelo.
• *Amortigua pH* y reduce efectos de *salinidad/sodio*; mejora suelos degradados.
• Disminuye *pérdidas por lixiviación* y aumenta la *eficiencia de los fertilizantes*.
• Forma *complejos con metales pesados*, reduciendo su toxicidad para el cultivo.
• Favorece *germinación*, *emergencia uniforme* y *vigor* de plántulas.
• Mejora *rendimiento y calidad*: calibre, uniformidad, firmeza y vida de anaquel.
• *Compatible* con aplicaciones *edáficas, fertirriego y foliar*.` + GUIA_USO
);

const MSG_BENEFICIOS_SEAWEED = withFooter(
`🌊 *Beneficios de Khumic – Seaweed 800* (extracto de algas)
• Aporta *fitohormonas naturales* (citoquininas, auxinas, giberelinas) y oligosacáridos.
• *Estimula brotación, floración y cuaje*; mejora *amarre* y *uniformidad*.
• Promueve *rizogénesis* (raíces nuevas) y mejor establecimiento tras *trasplante*.
• Incrementa *tolerancia a estrés* (sequía, salinidad, altas/bajas temperaturas, viento).
• Acelera *recuperación post-estrés* y disminuye caída de flores/frutos.
• Mejora *fotosíntesis*, *clorofila*, *BRIX* y *coloración*; favorece llenado y calibre.
• Optimiza *cuajes escalonados* y reduce alternancia.
• Reduce *fitotoxicidad* y es *sinérgico* con nutrición y programas fitosanitarios.
• *Compatible* con aplicaciones *foliares, fertirriego y riego*.` + GUIA_USO
);

const MSG_ENVIOS = withFooter(
`📍 *Ubicación y envíos*
• Contamos con *bodega de importación en Ibarra*. Actualmente *no tenemos atención al cliente* en sitio.
• Realizamos *despachos en grandes cantidades* como *distribuidor*, *con previo aviso*.
• Varias *promociones incluyen el envío* 🚚.
• Trabajamos con *Cita Express* y al despachar te enviamos *código QR/URL de rastreo* para que sigas tu paquete — *transparencia total, sin estafas*.`
);

// NUEVO: Sitio y redes
const MSG_LINKS = withFooter(
`🌐 *Sitio web y redes sociales*
• 🌎 Web: https://www.procampoecuador.com
• 👍 Facebook: https://www.facebook.com/profile.php?id=100089832865368
• 🎵 TikTok: https://www.tiktok.com/@procampoecuador?_t=ZM-90MOoBwfgSZ&_r=1

Guárdanos para no perderte promociones y novedades.`
);

const MSG_FICHAS = withFooter(
"📑 *Fichas técnicas disponibles*\nEscribe:\n\n• *ficha 100* → Khumic-100\n• *ficha seaweed* → Seaweed 800"
);

/* =================== Menú / intents =================== */
function menuPrincipal(enHorario) {
  const saludo =
    `🤖🌱✨ *¡Hola! Soy ${DISPLAY_BOT_NAME}* — *estoy aquí para ayudarte* 🤝🌟💬🧑‍🌾.\n` +
    "➡️ *Para seleccionar la opción, responde con el número de lo que necesitas conocer.*\n\n";
  const nota = enHorario
    ? ""
    : "_Fuera de horario: puedo darte info y dejamos la *compra* para el horario laboral (L–V 08:00–17:30, Sáb 08:00–13:00)._ \n\n";
  return (
    saludo + nota +
    "1️⃣ Precios y promociones de *Khumic-100* (ácidos húmicos + fúlvicos)\n" +
    "2️⃣ Precios y promociones de *Khumic – Seaweed 800* (algas marinas)\n" +
    "3️⃣ Beneficios de *Khumic-100* (ácidos húmicos + fúlvicos)\n" +
    "4️⃣ Beneficios de *Khumic – Seaweed 800* (algas marinas)\n" +
    "5️⃣ Envíos y cómo encontrarnos\n" +
    "6️⃣ *Fichas técnicas (PDF)*\n" +
    "7️⃣ Hablar con un asesor 👨‍💼\n" +
    "8️⃣ Sitio web y redes sociales 🌐\n" +
    "0️⃣ Volver al inicio"
  );
}

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
  if (/^8$/.test(t)) return "links";
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
    if (yaProcesado(msg.id)) return;

    const from = msg.from; // número cliente (sin +)
    const texto = msg.text?.body || "";
    const name  = value?.contacts?.[0]?.profile?.name || "Cliente";

    // ===== ADMIN CHAT =====
    if (ADMIN_PHONE && from === ADMIN_PHONE) {
      const t = texto.trim();

      // use #ABC123
      let m = t.match(/^use\s+#([A-Z0-9]{4,8})$/i);
      if (m) {
        const tk = m[1].toUpperCase();
        if (!tickets.has(tk)) return enviarTexto(from, `No encuentro #${tk}. Usa *leads*.`);
        adminCtx.activeTicket = tk;
        const { name } = tickets.get(tk);
        return enviarTexto(from, `✅ Chat activado con #${tk} — ${name}. Escribe tu mensaje.`);
      }

      // use N
      m = t.match(/^use\s+(\d{1,2})$/i);
      if (m) {
        const idx = parseInt(m[1], 10) - 1;
        const item = recent[idx];
        if (!item) return enviarTexto(from, "Índice inválido. Usa *leads*.");
        adminCtx.activeTicket = item.ticket;
        return enviarTexto(from, `✅ Chat activado con #${item.ticket} — ${item.name}.`);
      }

      if (/^leads?$/i.test(t)) {
        const list = recent.slice(0, 5).map((x,i)=>`${i+1}) #${x.ticket} — ${x.name}`).join("\n") || "(vacío)";
        return enviarTexto(from, `📒 Últimos tickets:\n${list}\n\nUsa *use #ABC123* o *use 1*`);
      }

      if (/^who$/i.test(t)) {
        if (!adminCtx.activeTicket) return enviarTexto(from, "No hay ticket activo. Usa *leads* / *use #ID*.");
        const tk = adminCtx.activeTicket;
        const { name } = tickets.get(tk) || {};
        return enviarTexto(from, `🎯 Ticket activo: #${tk} — ${name}`);
      }

      if (/^stop$/i.test(t)) {
        adminCtx.activeTicket = null;
        return enviarTexto(from, "✋ Chat desactivado.");
      }

      // Con ticket activo: cualquier texto se reenvía al cliente
      if (adminCtx.activeTicket) {
        const tk = adminCtx.activeTicket;
        const { num } = tickets.get(tk) || {};
        if (!num) return enviarTexto(from, "Ticket inválido. Usa *leads* / *use #ID*.");
        await enviarTexto(num, t);
        return;
      }

      // Sin ticket activo: mostrar ayuda
      return enviarTexto(from, adminHelp());
    }

    // ===== CLIENTE → reenviar al admin si ese ticket está activo =====
    const ticketId = ensureTicket(from, name, msg.id || from);
    if (ADMIN_PHONE && adminCtx.activeTicket === ticketId) {
      await enviarTexto(ADMIN_PHONE, `[#${ticketId}] ${name}: ${texto}`);
    }

    // ===== Flujo normal del bot =====
    const intent = detectarIntent(texto);
    const enHorario = esHorarioLaboral();

    if (intent === "inicio") return enviarTexto(from, menuPrincipal(enHorario));
    if (intent === "op1") return enviarTexto(from, MSG_PRECIOS_KHUMIC);
    if (intent === "op2") return enviarTexto(from, MSG_PRECIOS_SEAWEED);
    if (intent === "op3") return enviarTexto(from, MSG_BENEFICIOS_KHUMIC);
    if (intent === "op4") return enviarTexto(from, MSG_BENEFICIOS_SEAWEED);
    if (intent === "op5") return enviarTexto(from, MSG_ENVIOS);
    if (intent === "menu_fichas") return enviarTexto(from, MSG_FICHAS);
    if (intent === "links") return enviarTexto(from, MSG_LINKS);
    if (intent === "ficha_khumic")
      return enviarDocumentoPorId(from, { mediaId: KHUMIC_PDF_ID, filename: "Khumic-100-ficha.pdf", caption: "📄 Ficha Khumic-100." });
    if (intent === "ficha_seaweed")
      return enviarDocumentoPorId(from, { mediaId: SEAWEED_PDF_ID, filename: "Seaweed-800-ficha.pdf", caption: "📄 Ficha Seaweed 800." });

    if (intent === "asesor") {
      const msj = enHorario
        ? "¡Perfecto! Te conecto con un asesor ahora mismo. 👨‍💼📲"
        : "Gracias por escribir. Un asesor te contactará en horario laboral. Puedo ayudarte por aquí mientras tanto. 🕗";
      await enviarTexto(from, msj);

      // Crear/asegurar ticket y activarlo para el admin
      const tk = ensureTicket(from, name, msg.id || from);
      adminCtx.activeTicket = tk;

      // Aviso corto al admin
      if (ADMIN_PHONE) {
        await enviarTexto(
          ADMIN_PHONE,
          `🟢 Chat activado #${tk}\nCliente: ${name}\nEscribe tu mensaje aquí para responder.`
        );
      }
      return;
    }

    if (intent === "gracias") return enviarTexto(from, "¡Con gusto! 😊 ¿Algo más?");
    return enviarTexto(from, menuPrincipal(enHorario)); // fallback
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

/* =================== Healthcheck =================== */
app.get("/", (_req, res) => res.send("OK"));
app.listen(PORT, () => console.log(`Bot listo en puerto ${PORT}`));
