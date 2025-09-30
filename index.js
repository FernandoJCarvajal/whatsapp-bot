// ===== Config =====
const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const WABA_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "mi_token_123";
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || "593980499767"; // tu WhatsApp personal

// ===== Función para enviar mensajes =====
async function sendMessage(to, message, type = "text", mediaUrl = null) {
  const data =
    type === "text"
      ? { messaging_product: "whatsapp", to, text: { body: message } }
      : {
          messaging_product: "whatsapp",
          to,
          type: "image",
          image: { link: mediaUrl, caption: message },
        };

  try {
    await axios.post(
      `https://graph.facebook.com/v17.0/${WABA_ID}/messages`,
      data,
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );
  } catch (error) {
    console.error("Error enviando mensaje:", error.response?.data || error);
  }
}

// ===== Webhook Verify =====
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ===== Webhook Events =====
app.post("/webhook", async (req, res) => {
  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const message = changes?.value?.messages?.[0];

  if (message) {
    const from = message.from;
    const text = message.text?.body?.toLowerCase() || "";

    if (text.includes("hola")) {
      await sendMessage(
        from,
        "👋 Hola, soy *PRO CAMPO BOT* 🌱 y estoy aquí para ayudarte en lo que necesites.\n\nOpciones disponibles:\n1️⃣ Precios y promociones\n2️⃣ Beneficios de productos\n3️⃣ Cómo encontrarnos\n4️⃣ Fichas técnicas 📑"
      );
    } else if (text.includes("precios") || text.includes("promociones")) {
      await sendMessage(
        from,
        "🌱 *Khumic-100 (Ácidos húmicos + fúlvicos)*:\n- 1kg = $13.96\n- 3kg = $34.92\n- 25kg = $226.98\n- 50kg = $436.50"
      );
      await sendMessage(
        from,
        "🌊 *Khumic-Seaweed 800 (Algas marinas)*:\n- 1kg = $16.00\n- 3kg = $39.68",
      );
      await sendMessage(
        from,
        "Aquí tienes la imagen del producto Khumic-100 📸",
        "image",
        "https://drive.google.com/uc?export=view&id=1Ku4ghoo2F4Ek7phymx1IOAGb8jXyLngn"
      );
      await sendMessage(
        from,
        "Y aquí la imagen de Khumic-Seaweed 800 📸",
        "image",
        "https://drive.google.com/uc?export=view&id=11TceWyjbPAC7kZQVVs9tzgIxPuWW4tQa"
      );
    } else if (text.includes("beneficios")) {
      await sendMessage(
        from,
        "🌱 *Beneficios Khumic-100 (Ácidos húmicos + fúlvicos)*:\n1. Mejora absorción de nutrientes 💪\n2. Estimula crecimiento 🌱\n3. Mejora tolerancia a sequía ☀️\n4. Aumenta frutos y flores 🌼\n5. Mejora resistencia a enfermedades 🌿"
      );
      await sendMessage(
        from,
        "🌊 *Beneficios Khumic-Seaweed 800 (Algas marinas)*:\n1. Mejora estructura del suelo 🌿\n2. Estimula crecimiento ✨\n3. Incrementa resistencia 🌱\n4. Mejora calidad de fruta 🍎\n5. Reduce estrés abiótico ☀️"
      );
    } else if (text.includes("encontrarnos")) {
      await sendMessage(
        from,
        "📍 Nuestra bodega principal está en *Ibarra* (importación). No disponemos de atención al cliente física, únicamente despachos con previo aviso para distribuidores.\n🚚 En compras mayores a 1kg (promociones) el envío es *GRATIS* mediante *Cita Express*."
      );
    } else if (text.includes("ficha")) {
      await sendMessage(
        from,
        "📑 Descarga las fichas técnicas:\n- Khumic-100 👉 https://drive.google.com/file/d/1Tyn6ElcglBBE8Skd_G5wHb0U4XDF9Jfu/view\n- Khumic-Seaweed 800 👉 https://drive.google.com/file/d/1HuBBJ5tadjD8FGowCTCqPbZuWgxlgU9Y/view"
      );
    } else {
      await sendMessage(
        from,
        "🤖 No entendí tu mensaje. Por favor escribe:\n- 'Precios' para promociones\n- 'Beneficios' para conocer ventajas\n- 'Encontrarnos' para dirección\n- 'Ficha' para descargar fichas técnicas"
      );
    }
  }

  res.sendStatus(200);
});

// ===== Servidor =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});

