const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// Salud
app.get('/', (_req, res) => res.send('WhatsApp bot activo'));

// Verificación (GET)
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'mi_token_123';
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WEBHOOK_VERIFIED OK');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Recepción y respuesta (POST)
app.post('/webhook', async (req, res) => {
  try {
    console.log('POST /webhook body:\n', JSON.stringify(req.body, null, 2));

    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (Array.isArray(messages)) {
      for (const message of messages) {
        const from = message.from;                          // número del cliente
        const text = message.text?.body || '';              // texto recibido
        const reply = `Hola! Recibí: "${text}". Soy tu bot de ${process.env.BOT_NAME || 'la empresa'}.`;

        await axios.post(
          `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: 'whatsapp',
            to: from,
            text: { body: reply }
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
            }
          }
        );
        console.log('✓ Respuesta enviada a', from);
      }
    }
    return res.sendStatus(200);
  } catch (e) {
    console.error('Error en POST /webhook:', e?.response?.data || e.message);
    return res.sendStatus(200); // siempre 200 para que Meta no reintente
  }
});

app.listen(3000, () => console.log('Servidor escuchando en puerto 3000'));


