
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ verify: (req, res, buf) => (req.rawBody = buf) }));

// --- Config ---
const {
  PORT = 3000,
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  TZ = "America/Guayaquil",
  KHUMIC_PDF_LINK,
  SEAWEED_PDF_LINK,
} = process.env;

// --- Utilidades ---
function normalizarTexto(t = "") {
  return (t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function detectarFicha(texto) {
  const t = normalizarTexto(texto);
  if (/ficha\s*(100|khumic|humic)/i.test(t)) return "khumic";
  if (/ficha\s*(seaweed|800|algas)/i.test(t)) return "seaweed";
  return null;
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
    console.error(await resp.text());
  }
}

async function enviarDocumentoWhatsApp(to, { link, filename, caption }) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "document",
    document: {
      link,
      filename,
    },
    caption,
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
    console.error(await resp.text());
  }
}

// --- Webhook ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const msg = change?.value?.messages?.[0];
    const from = msg?.from;
    const texto = msg?.text?.body || "";

    if (!from || !texto) return;

    const ficha = detectarFicha(texto);
    if (ficha === "khumic") {
      await enviarDocumentoWhatsApp(from, {
        link: KHUMIC_PDF_LINK,
        filename: "Khumic-100.pdf",
        caption: "📄 Ficha técnica de Khumic-100 (ácidos húmicos + fúlvicos).",
      });
      return;
    }
    if (ficha === "seaweed") {
      await enviarDocumentoWhatsApp(from, {
        link: SEAWEED_PDF_LINK,
        filename: "Seaweed-800.pdf",
        caption: "📄 Ficha técnica de Seaweed 800 (algas marinas).",
      });
      return;
    }

    // Si escribe "6"
    if (texto.trim() === "6") {
      await enviarMensajeWhatsApp(
        from,
        "📑 *Fichas técnicas disponibles*\nEscribe:\n\n• ficha 100 → Khumic-100\n• ficha seaweed → Seaweed 800"
      );
      return;
    }
  } catch (err) {
    console.error("Error en webhook:", err.message);
  }
});

// --- Salud ---
app.get("/", (_, res) => res.send("OK"));

app.listen(PORT, () => console.log(`Bot corriendo en puerto ${PORT}`));

