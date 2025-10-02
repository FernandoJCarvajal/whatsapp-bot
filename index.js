// index.js
import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";

const app = express();

// --- Config ---
const {
  PORT = 3000,
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  APP_SECRET,
  PHONE_NUMBER_ID,
  TZ = "America/Guayaquil",
} = process.env;

// Capturamos el raw body para validar firma si la usas
app.use((req, res, next) => {
  let data = [];
  req.on("data", (chunk) => data.push(chunk));
  req.on("end", () => {
    req.rawBody = Buffer.concat(data);
    try {
      req.body = JSON.parse(req.rawBody.toString() || "{}");
    } catch {
      req.body = {};
    }
    next();
  });
});

// --- Utilidades ---
const log = (...args) => console.log(new Date().toISOString(), ...args);

function esHorarioLaboral(date = new Date()) {
  // Zona horaria local
  const now = new Date(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date)
  );

  const dia = now.getDay(); // 0 dom, 1 lun, ..., 6 sáb
  const hora = now.getHours();
  const minuto = now.getMinutes();
  const hm = hora * 60 + minuto;

  // L-V 08:00–17:30
  const LV = dia >= 1 && dia <= 5 && hm >= 8 * 60 && hm <= 17 * 60 + 30;
  // Sábado 08:00–13:00
  const SAB = dia === 6 && hm >= 8 * 60 && hm <= 13 * 60;

  return LV || SAB;
}

function normalizarTexto(t = "") {
  return (t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

// Prioridad de intents: asesor > gracias > volver inicio > otros
function detectarIntent(texto) {
  const t = normalizarTexto(texto);

  if (
    /asesor|agente|humano|atencion|hablar con (un )?asesor|contactar/i.test(t)
  ) {
    return "asesor";
  }
  if (/gracias|muchas gracias|mil gracias|thank/i.test(t)) {
    return "gracias";
  }
  if (/volver( al)? inicio|menu|menú|inicio|start/i.test(t)) {
    return "inicio";
  }
  // Otros atajos útiles
  if (/comprar|precio|cotizacion|cotización|promocion/i.test(t)) {
    return "comprar";
  }
  return "fallback";
}

async function enviarMensajeWhatsApp(to, body) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`WA API ${resp.status}: ${text}`);
  }
}

// --- Rutas Webhook ---
// Verificación GET
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    log("Webhook verificado");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// (Opcional) Validar firma si has configurado la app para firmar
function validarFirma(req) {
  if (!APP_SECRET) return true; // saltar si no se configuró
  const header = req.get("x-hub-signature-256");
  if (!header) return false;
  const [, firma] = header.split("=");
  const expected = crypto
    .createHmac("sha256", APP_SECRET)
    .update(req.rawBody)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(firma || "", "hex"),
    Buffer.from(expected, "hex")
  );
}

// Recepción POST
app.post("/webhook", async (req, res) => {
  try {
    if (!validarFirma(req)) {
      log("Firma inválida");
      return res.sendStatus(403);
    }

    // Responder 200 enseguida para evitar timeouts
    res.sendStatus(200);

    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const msg = change?.value?.messages?.[0];
    const from = msg?.from; // número del usuario
    const texto = msg?.text?.body || "";

    if (!from || !texto) return;

    const enHorario = esHorarioLaboral();
    const intent = detectarIntent(texto);

    // Respuestas
    if (intent === "asesor") {
      const msj = enHorario
        ? "¡Perfecto! Te pongo en contacto con un asesor ahora mismo. 🧑‍💼📲"
        : "Gracias por escribir. Un asesor te contactará en el horario laboral. Yo puedo ayudarte por aquí y dejaremos la compra pendiente para el horario de atención. 🕗";
      await enviarMensajeWhatsApp(from, msj);
      // Aquí puedes disparar una notificación interna a tu equipo.
      return;
    }

    if (intent === "gracias") {
      const msj =
        "¡Con mucho gusto! 😊 Estamos muy gustosos de ayudarte. Si necesitas algo más, estoy aquí para ti.";
      await enviarMensajeWhatsApp(from, msj);
      return;
    }

    if (intent === "inicio") {
      const msj =
        "Volviste al inicio. ¿Qué deseas hacer?\n1) Hablar con un asesor\n2) Información de productos\n3) Promociones\n4) Soporte\n\nEscribe el número o la opción.";
      await enviarMensajeWhatsApp(from, msj);
      return;
    }

    if (intent === "comprar") {
      const msj = enHorario
        ? "Te apoyo con tu compra ahora mismo. ¿Qué producto te interesa?"
        : "Puedo ayudarte con la información ahora y dejamos la compra para el horario de atención: L–V 08:00–17:30 y Sáb 08:00–13:00. ¿Qué producto te interesa? 🛒";
      await enviarMensajeWhatsApp(from, msj);
      return;
    }

    // Fallback
    const bienvenida = enHorario
      ? "Hola 👋 Soy tu asistente. ¿Qué deseas hacer?"
      : "Hola 👋 Gracias por escribir. Estoy fuera de horario de atención, pero puedo ayudarte por aquí y la compra la dejamos para el horario laboral.";
    const menu =
      "\n1) Hablar con un asesor\n2) Información de productos\n3) Promociones\n4) Volver al inicio";
    await enviarMensajeWhatsApp(from, `${bienvenida}${menu}`);
  } catch (err) {
    log("Error en webhook:", err.message);
    // No hacemos res.send aquí porque ya respondimos 200 arriba.
  }
});

// Salud
app.get("/", (_, res) => res.send("OK"));

app.listen(PORT, () => log(`Bot en puerto ${PORT}`));

