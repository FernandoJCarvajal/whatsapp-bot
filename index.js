import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const {
  PORT = 3000,
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  KHUMIC_PDF_ID,
  SEAWEED_PDF_ID,
} = process.env;

// --- Diagnóstico: muestra si las ENV llegaron (sin exponer token completo)
(function bootCheck() {
  const reqEnv = {
    VERIFY_TOKEN: !!VERIFY_TOKEN,
    WHATSAPP_TOKEN: WHATSAPP_TOKEN ? `${WHATSAPP_TOKEN.slice(0,4)}***` : "MISSING",
    PHONE_NUMBER_ID,
    KHUMIC_PDF_ID,
    SEAWEED_PDF_ID,
  };
  console.log("ENV CHECK:", reqEnv);
})();

function normalizarTexto(t = "") {
  return (t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function detectarFicha(texto) {
  const t = normalizarTexto(texto);
  if (/\bficha\b/.test(t) && /\b(100|khumic|humic)\b/.test(t)) return "khumic";
  if (/\bficha\b/.test(t) && /\b(seaweed|800|algas)\b/.test(t)) return "seaweed";
  if (/^\s*ficha\s*$/i.test(t)) return "menu_fichas";
  return null;
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
    console.error("MEDIA_ID VACÍO para", filename);
    await enviarTexto(to, "Lo siento, ahora mismo no encuentro la ficha. Intenta nuevamente en un momento 🙏");
    return;
  }
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "document",
    document: { id: mediaId, filename, caption }
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) console.error("ERROR DE DOCUMENTO DE WA:", await r.text());
}

// Anti-duplicados
const processed = new Set();
function yaProcesado(id) {
  if (!id) return false;
  if (processed.has(id)) return true;
  processed.add(id);
  setTimeout(() => processed.delete(id), 5 * 60 * 1000);
  return false;
}

// Webhook verify (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// Webhook receive (POST)
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

    if (texto.trim() === "6" || detectarFicha(texto) === "menu_fichas") {
      await enviarTexto(
        from,
        "📑 *Fichas técnicas disponibles*\nEscribe:\n\n• *ficha 100* → Khumic-100\n• *ficha seaweed* → Seaweed 800"
      );
      return;
    }

    const ficha = detectarFicha(texto);
    if (ficha === "khumic") {
      await enviarDocumentoPorId(from, {
        mediaId: KHUMIC_PDF_ID,
        filename: "Khumic-100-ficha.pdf",
        caption: "📄 Ficha técnica de Khumic-100 (ácidos húmicos + fúlvicos)."
      });
      return;
    }
    if (ficha === "seaweed") {
      await enviarDocumentoPorId(from, {
        mediaId: SEAWEED_PDF_ID,
        filename: "Seaweed-800-ficha.pdf",
        caption: "📄 Ficha técnica de Seaweed 800 (algas marinas)."
      });
      return;
    }
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

// Salud
app.get("/", (_req, res) => res.send("OK"));
app.listen(PORT, () => console.log(`Bot listo en puerto ${PORT}`));
