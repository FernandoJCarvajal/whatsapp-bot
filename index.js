// index.js — Pro Campo Bot
// Slots 1..20 + recordatorios con preview + cierre auto 30' + plantilla admin (lead_alert_util)
// Node 18+, package.json { "type": "module" }

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
  ADMIN_PHONE,                  // 5939XXXXXXXX (sin +)
  ADMIN_TEMPLATE = "lead_alert_util", // plantilla con 5 parámetros
  REMIND_AFTER_MIN = 5,         // recordatorio si hay msgs pendientes
  AUTO_CLOSE_MIN = 30,          // cierre auto si el cliente no responde al admin
} = process.env;

const DISPLAY_BOT_NAME = "PRO-CAMPO BOT";

/* ===== Utils ===== */
const mask = s => (s ? s.slice(0, 4) + "***" : "MISSING");
console.log("ENV CHECK:", {
  VERIFY: !!WHATSAPP_VERIFY_TOKEN,
  TOKEN: mask(WHATSAPP_TOKEN),
  PHONE_NUMBER_ID,
  KHUMIC_PDF_ID,
  SEAWEED_PDF_ID,
  TZ, BOT_NAME, ADMIN_PHONE, ADMIN_TEMPLATE,
  REMIND_AFTER_MIN, AUTO_CLOSE_MIN
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
  const w = d.getDay();
  const m = d.getHours() * 60 + d.getMinutes();
  const LV = (w >= 1 && w <= 5) && (m >= 8*60 && m <= 17*60+30);
  const SA = (w === 6) && (m >= 8*60 && m <= 13*60);
  return LV || SA;
}
const processed = new Set();
function yaProcesado(id){ if(!id) return false; if(processed.has(id)) return true; processed.add(id); setTimeout(()=>processed.delete(id), 5*60*1000); return false; }
function shortTicket(seed=""){ let h=0; for(const c of seed) h=(h*31+c.charCodeAt(0))>>>0; return h.toString(36).slice(-6).toUpperCase(); }

// Preview bonita del último mensaje
function preview(txt, max=120){
  if(!txt) return "";
  const oneLine = String(txt).replace(/\s+/g," ").trim();
  return oneLine.length > max ? oneLine.slice(0, max-1) + "…" : oneLine;
}

/* ===== WhatsApp helpers ===== */
async function waFetch(path, payload){
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/${path}`;
  const r = await fetch(url, {
    method:"POST",
    headers:{ Authorization:`Bearer ${WHATSAPP_TOKEN}`, "Content-Type":"application/json" },
    body: JSON.stringify(payload)
  });
  if(!r.ok) throw new Error(await r.text());
  return r.json();
}
async function enviarTexto(to, body){
  try { await waFetch("messages",{ messaging_product:"whatsapp", to, type:"text", text:{ body } }); return true; }
  catch(e){ console.error("WA TEXT ERR:", e.message); return false; }
}
async function enviarDocumentoPorId(to, { mediaId, filename, caption }){
  if(!mediaId) return enviarTexto(to,"No encuentro la ficha ahora. Intenta en unos minutos 🙏");
  try { await waFetch("messages",{ messaging_product:"whatsapp", to, type:"document", document:{ id:mediaId, filename, caption } }); }
  catch(e){ console.error("WA DOC ERR:", e.message); }
}

// Notificación al admin con fallback a plantilla (lead_alert_util con 5 parámetros)
async function notificarAdmin({ name="Cliente", num, ticket, slot, texto="Nuevo contacto" }){
  if(!ADMIN_PHONE) return;

  const prefix = slot ? `[${slot}] ` : "";
  const body = `${prefix}#${ticket} — ${name}: ${texto}`;

  // Intento 1: texto normal
  const ok = await enviarTexto(ADMIN_PHONE, body);
  if(ok) return;

  // Intento 2: plantilla (funciona fuera de 24h)
  try {
    await waFetch("messages", {
      messaging_product: "whatsapp",
      to: ADMIN_PHONE,
      type: "template",
      template: {
        name: ADMIN_TEMPLATE,
        language: { code: "es" },
        components: [{
          type: "body",
          parameters: [
            { type: "text", text: DISPLAY_BOT_NAME }, // {{1}}
            { type: "text", text: name },             // {{2}}
            { type: "text", text: `+${num}` },        // {{3}}
            { type: "text", text: `#${ticket}` },     // {{4}}
            { type: "text", text: texto },            // {{5}}
          ],
        }],
      },
    });
  } catch(e){ console.error("WA TEMPLATE ERR:", e.message); }
}

/* ===== Tickets / Handoff / Slots ===== */
const tickets = new Map();          // ticketId -> { num, name, handoff, slot, lastClientAt, lastAdminAt, unread, lastReminderAt, lastClientMsg }
const byNumber = new Map();
const recent = [];
const slots = new Map();            // slot -> ticketId
const slotByTicket = new Map();     // ticketId -> slot
const MAX_SLOTS = 20;
const adminCtx = { activeTicket: null };

function ensureTicket(num, name, seedForId){
  let ticket = byNumber.get(num);
  if(!ticket){
    ticket = shortTicket(seedForId || num);
    let i=0; while(tickets.has(ticket)) ticket = shortTicket(ticket+(++i));
    tickets.set(ticket,{
      num, name: name||"Cliente",
      handoff:false, slot:null,
      lastClientAt:0, lastAdminAt:0,
      unread:0, lastReminderAt:0,
      lastClientMsg:""
    });
    byNumber.set(num, ticket);
    recent.unshift({ ticket, name: name||"Cliente" }); if(recent.length>20) recent.pop();
  } else {
    const t = tickets.get(ticket); if(name && t && !t.name) t.name = name;
  }
  return ticket;
}
function assignSlot(ticketId){
  if(slotByTicket.has(ticketId)) return slotByTicket.get(ticketId);
  for(let s=1; s<=MAX_SLOTS; s++){
    if(!slots.has(s)){ slots.set(s, ticketId); slotByTicket.set(ticketId, s); tickets.get(ticketId).slot = s; return s; }
  }
  return null;
}
function freeSlot(ticketId){
  const s = slotByTicket.get(ticketId);
  if(s){ slots.delete(s); slotByTicket.delete(ticketId); const t=tickets.get(ticketId); if(t) t.slot=null; }
}

/* ===== Contenidos ===== */
function withFooter(txt){ return txt + "\n\n➡️ *Para continuar*, responde con el número:\n• 7️⃣ Hablar con un asesor\n• 0️⃣ Volver al inicio"; }

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

const GUIA_USO =
`\n\n🧪 *Guía rápida de uso (referencia general)*\n• *Dosis general:* 3–4 kg/ha/mes.\n• *Recomendación:* dividir en *2 aplicaciones* cada *15 días*.\n• *Tanque 200 L:* *0,5 kg* cada *15 días*.\n• *Por volumen de agua:* *2,5–3,5 g/L*.\n• *Vías:* edáfico/fertirriego y foliar.\n• Ajustar según cultivo/etapa; *prueba de compatibilidad* antes de mezclar.`;

const MSG_BENEFICIOS_KHUMIC = withFooter(
`🌿 *Beneficios de Khumic-100* (ácidos húmicos + fúlvicos)
• Mejora *estructura del suelo* y *aireación*.
• Mayor *CIC* y *retención de agua*.
• *Quelata/moviliza* micronutrientes.
• Aumenta *absorción* de N–P–K y micros.
• *Estimula raíces* y vigor.
• Activa *microbiología* / *enzimas*.
• Amortigua *pH*, reduce *salinidad/sodio*.
• Menos *lixiviación*, más *eficiencia* de fertilizantes.
• Compleja *metales pesados*.
• Mejor *germinación*, *rendimiento* y *calidad*.` + GUIA_USO
);

const MSG_BENEFICIOS_SEAWEED = withFooter(
`🌊 *Beneficios de Khumic – Seaweed 800* (extracto de algas)
• Aporta *fitohormonas naturales*.
• *Brotación, floración y cuaje*; mejor amarre.
• *Rizogénesis* y mejor trasplante.
• *Tolerancia a estrés* y recuperación.
• Mejor *fotosíntesis*, *BRIX*, *coloración* y *calibre*.
• Menos *fitotoxicidad*; sinergia con nutrición.` + GUIA_USO
);

const MSG_ENVIOS = withFooter(
`📍 *Ubicación y envíos*
• Bodega de importación en *Ibarra* (sin atención al público).
• *Despachos* como *distribuidor*, *con previo aviso*.
• Varias *promociones incluyen el envío* 🚚.
• Operador: *Cita Express* + *QR/URL de rastreo* (transparencia total).`
);

const MSG_FICHAS = withFooter("📑 *Fichas técnicas disponibles*\nEscribe:\n\n• *ficha 100* → Khumic-100\n• *ficha seaweed* → Seaweed 800");

const MSG_LINKS = withFooter(
`🌐 *Sitio web y redes sociales*
• 🌎 Web: https://www.procampoecuador.com
• 👍 Facebook: https://www.facebook.com/profile.php?id=100089832865368
• 🎵 TikTok: https://www.tiktok.com/@procampoecuador?_t=ZM-90MOoBwfgSZ&_r=1`
);

// Mensajes de cierre
const MSG_CIERRE_AUTO   = "⏳ Cerramos este chat por *falta de respuesta*. Si deseas retomar tu pedido, responde *7* para contactar a un asesor. ¡Gracias por preferirnos! 🌱";
const MSG_CIERRE_MANUAL = "🙏 *Gracias por preferirnos*. Si necesitas más ayuda, responde *7* para contactar de nuevo a un asesor. ¡Estamos para ayudarte!";

/* ===== Menú / Intents ===== */
function menuPrincipal(enHorario){
  const saludo =
    `🤖🌱✨ *¡Hola! Soy ${DISPLAY_BOT_NAME}* — *estoy aquí para ayudarte* 🤝🌟💬🧑‍🌾.\n` +
    "➡️ *Para seleccionar la opción, responde con el número de lo que necesitas conocer.*\n\n";
  const nota = enHorario ? "" : "_Fuera de horario: puedo darte info y dejamos la *compra* para el horario laboral (L–V 08:00–17:30, Sáb 08:00–13:00)._ \n\n";
  return saludo + nota +
    "1️⃣ Precios y promociones de *Khumic-100* (ácidos húmicos + fúlvicos)\n" +
    "2️⃣ Precios y promociones de *Khumic – Seaweed 800* (algas marinas)\n" +
    "3️⃣ Beneficios de *Khumic-100* (ácidos húmicos + fúlvicos)\n" +
    "4️⃣ Beneficios de *Khumic – Seaweed 800* (algas marinas)\n" +
    "5️⃣ Envíos y cómo encontrarnos\n" +
    "6️⃣ *Fichas técnicas (PDF)*\n" +
    "7️⃣ Hablar con un asesor 👨‍💼\n" +
    "8️⃣ Sitio web y redes sociales 🌐\n" +
    "0️⃣ Volver al inicio";
}
function detectarNumeroEnFrase(t){
  const m = t.match(/(?:^|\D)([0-8])(?:\D|$)/); if(m) return m[1];
  const map={cero:"0",uno:"1",dos:"2",tres:"3",cuatro:"4",cinco:"5",seis:"6",siete:"7",ocho:"8"};
  for(const [w,n] of Object.entries(map)){ if(new RegExp(`\\b${w}\\b`).test(t)) return n; }
  return null;
}
function detectarIntent(texto){
  const t = normalizar(texto);
  if (/^7$/.test(t) || /asesor|agente|humano|contactar|comprar|necesito comprar/i.test(t)) return "asesor";
  if (/^6$/.test(t) || /^fichas?$/i.test(t)) return "menu_fichas";
  if (/\bficha\b/.test(t) && /\b(100|khumic|humic)\b/.test(t)) return "ficha_khumic";
  if (/\bficha\b/.test(t) && /\b(seaweed|800|algas)\b/.test(t)) return "ficha_seaweed";
  if (/^8$/.test(t) || /web|sitio|redes|facebook|tiktok/i.test(t)) return "links";
  const num = detectarNumeroEnFrase(t); if(num!==null) return ({0:"inicio",1:"op1",2:"op2",3:"op3",4:"op4",5:"op5",6:"menu_fichas",7:"asesor",8:"links"})[num];
  if (/^(hola|buen[oa]s?|menu|men[uú]|inicio|start|0)$/i.test(t)) return "inicio";
  if (/gracias|muchas gracias|mil gracias|thank/i.test(t)) return "gracias";
  return "fallback";
}

/* ===== Webhook verify ===== */
app.get("/webhook",(req,res)=>{
  const mode=req.query["hub.mode"], token=req.query["hub.verify_token"], challenge=req.query["hub.challenge"];
  if(mode==="subscribe" && token===WHATSAPP_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

/* ===== Webhook receive ===== */
app.post("/webhook", async (req,res)=>{
  res.sendStatus(200);
  try{
    const entry=req.body.entry?.[0];
    const value=entry?.changes?.[0]?.value;
    const msg=value?.messages?.[0];
    if(!msg) return;
    if(yaProcesado(msg.id)) return;

    const from=msg.from;
    const texto=msg.text?.body || "";
    const name=value?.contacts?.[0]?.profile?.name || "Cliente";

    /* ----- ADMIN ----- */
    if(ADMIN_PHONE && from===ADMIN_PHONE){
      const t=texto.trim();
      let m;

      if(/^chats?$/i.test(t)){
        const items=[...slots.keys()].sort((a,b)=>a-b).map(s=>{
          const tk=slots.get(s); const info=tickets.get(tk);
          const pend = info?.unread ? ` [${info.unread}]` : "";
          const pv = info?.unread ? ` — “${preview(info.lastClientMsg)}”` : "";
          return `${s}) #${tk} — ${info?.name}${pend}${pv}`;
        }).join("\n") || "(sin chats en handoff)";
        return enviarTexto(from, `📒 Chats activos (slots):\n${items}\n\nResponde: *<slot> mensaje*  (ej. "3 Hola")`);
      }

      if((m=t.match(/^use\s+(\d{1,2})$/i))){
        const s=parseInt(m[1],10);
        let tk=slots.get(s); if(!tk){ const item=recent[s-1]; if(item) tk=item.ticket; }
        if(!tk) return enviarTexto(from,"Índice/slot inválido.");
        adminCtx.activeTicket=tk;
        const inf=tickets.get(tk);
        return enviarTexto(from, `✅ Ticket activo: #${tk} — ${inf?.name}${inf?.handoff?" (handoff)":""}.`);
      }
      if((m=t.match(/^use\s+#([A-Z0-9]{4,8})$/i))){
        const tk=m[1].toUpperCase();
        if(!tickets.has(tk)) return enviarTexto(from,`No encuentro #${tk}.`);
        adminCtx.activeTicket=tk;
        const inf=tickets.get(tk);
        return enviarTexto(from, `✅ Ticket activo: #${tk} — ${inf?.name}${inf?.handoff?" (handoff)":""}.`);
      }
      if(/^who$/i.test(t)){
        if(!adminCtx.activeTicket) return enviarTexto(from,"No hay ticket activo.");
        const tk=adminCtx.activeTicket; const inf=tickets.get(tk); const s=slotByTicket.get(tk);
        return enviarTexto(from, `🎯 Activo: #${tk} — ${inf?.name}${inf?.handoff?" (handoff)":""}${s?` • Slot ${s}`:""}`);
      }
      if(/^stop$/i.test(t)){ adminCtx.activeTicket=null; return enviarTexto(from,"✋ Chat desactivado."); }

      // bot / end  (quitar handoff; end además agradece y libera slot)
      if((m=t.match(/^(bot|end)(?:\s+#([A-Z0-9]{4,8})|\s+(\d{1,2}))?$/i))){
        const cmd=m[1].toLowerCase();
        let tk=null;
        if(m[2]) tk=m[2].toUpperCase();
        else if(m[3]) tk=slots.get(parseInt(m[3],10));
        else tk=adminCtx.activeTicket;

        if(!tk || !tickets.has(tk)) return enviarTexto(from,"No encuentro el ticket.");
        const info=tickets.get(tk);

        if(cmd==="end"){ // mensaje de cierre al cliente
          await enviarTexto(info.num, MSG_CIERRE_MANUAL);
        }

        info.handoff=false; info.unread=0; info.lastReminderAt=0;
        freeSlot(tk);

        return enviarTexto(from, cmd==="end" ? `✅ Cerrado y bot reactivado para #${tk}.` : `🤖 Bot reactivado para #${tk}.`);
      }

      if((m=t.match(/^(\d{1,2})\?$/))){
        const s=parseInt(m[1],10); const tk=slots.get(s);
        if(!tk) return enviarTexto(from,"Slot vacío.");
        const inf=tickets.get(tk);
        const mins = inf?.lastClientAt ? Math.floor((Date.now()-inf.lastClientAt)/60000) : null;
        const pv = inf?.unread ? `\n🗨️ Últ. pendiente (${mins} min): “${preview(inf.lastClientMsg)}”` : "";
        return enviarTexto(from, `Slot ${s}: #${tk} — ${inf?.name}${inf?.unread?` • pendientes: ${inf.unread}`:""}${pv}`);
      }

      // Respuesta rápida: "<slot> mensaje"
      if((m=t.match(/^(\d{1,2})\s+([\s\S]+)/))){
        const s=parseInt(m[1],10); const body=m[2];
        const tk=slots.get(s); if(!tk) return enviarTexto(from,"Slot inválido.");
        const info=tickets.get(tk); const dest=info?.num; if(!dest) return enviarTexto(from,"Ticket inválido.");
        await enviarTexto(dest, body);
        info.unread=0; info.lastReminderAt=0; info.lastAdminAt=Date.now();
        return enviarTexto(from, `📨 Enviado a [${s}] #${tk}.`);
      }

      // Compatibilidad: r #ID / r <slot> / r msg (activo)
      let mm;
      if((mm=t.match(/^r\s+#([A-Z0-9]{4,8})\s+([\s\S]+)/i))){
        const tk=mm[1].toUpperCase(), body=mm[2]; const inf=tickets.get(tk); const dest=inf?.num;
        if(!dest) return enviarTexto(from,"Ticket inválido.");
        await enviarTexto(dest,body); inf.unread=0; inf.lastReminderAt=0; inf.lastAdminAt=Date.now();
        return enviarTexto(from,`📨 Enviado a #${tk}.`);
      }
      if((mm=t.match(/^r\s+(\d{1,2})\s+([\s\S]+)/i))){
        const s=parseInt(mm[1],10), body=mm[2]; const tk=slots.get(s); const inf=tickets.get(tk); const dest=inf?.num;
        if(!dest) return enviarTexto(from,"Slot inválido.");
        await enviarTexto(dest,body); inf.unread=0; inf.lastReminderAt=0; inf.lastAdminAt=Date.now();
        return enviarTexto(from,`📨 Enviado a [${s}] #${tk}.`);
      }
      if((mm=t.match(/^r\s+([\s\S]+)/i))){
        if(!adminCtx.activeTicket) return enviarTexto(from,"No hay ticket activo. Usa *chats* o *use <slot>*.");
        const inf=tickets.get(adminCtx.activeTicket); const dest=inf?.num; if(!dest) return enviarTexto(from,"Ticket inválido.");
        await enviarTexto(dest, mm[1]); inf.unread=0; inf.lastReminderAt=0; inf.lastAdminAt=Date.now();
        return enviarTexto(from,`📨 Enviado a #${adminCtx.activeTicket}.`);
      }

      // Ayuda por defecto
      const items=[...slots.keys()].sort((a,b)=>a-b).map(s=>{
        const tk=slots.get(s); const info=tickets.get(tk);
        const pend = info?.unread ? ` [${info.unread}]` : "";
        const pv = info?.unread ? ` — “${preview(info.lastClientMsg)}”` : "";
        return `${s}) #${tk} — ${info?.name}${pend}${pv}`;
      }).join("\n") || "(sin chats en handoff)";
      return enviarTexto(from,
`📒 Chats activos (slots):
${items}

Responder rápido:
• *<slot> mensaje*   → ej. "3 Hola"
• *3?*               → info del slot 3 (muestra último pendiente)
• *chats*            → lista de slots con preview
• *use <slot|#ID>*   → fijar activo
• *r <slot|#ID> msg* / *r msg (activo)*

Cerrar o volver bot:
• *bot <slot|#ID>*   → reactivar bot
• *end <slot|#ID>*   → reactivar bot y liberar slot (envía agradecimiento)`);
    }

    /* ----- CLIENTE ----- */
    const ticketId = ensureTicket(from, name, msg.id||from);
    const tInfo = tickets.get(ticketId);

    // En handoff: bot en silencio; reenvía SIEMPRE al admin + guarda preview
    if(tInfo?.handoff){
      const s = slotByTicket.get(ticketId) || assignSlot(ticketId);
      tInfo.lastClientAt = Date.now();
      tInfo.unread = (tInfo.unread||0) + 1;
      tInfo.lastClientMsg = texto;
      await notificarAdmin({ name, num: from, ticket: ticketId, slot: `S${s}`, texto });
      return;
    }

    // Flujo normal
    const intent = detectarIntent(texto);
    const enHorario = esHorarioLaboral();

    if(intent==="inicio") return enviarTexto(from, menuPrincipal(enHorario));
    if(intent==="op1")   return enviarTexto(from, MSG_PRECIOS_KHUMIC);
    if(intent==="op2")   return enviarTexto(from, MSG_PRECIOS_SEAWEED);
    if(intent==="op3")   return enviarTexto(from, MSG_BENEFICIOS_KHUMIC);
    if(intent==="op4")   return enviarTexto(from, MSG_BENEFICIOS_SEAWEED);
    if(intent==="op5")   return enviarTexto(from, MSG_ENVIOS);
    if(intent==="menu_fichas") return enviarTexto(from, MSG_FICHAS);
    if(intent==="links") return enviarTexto(from, MSG_LINKS);
    if(intent==="ficha_khumic")
      return enviarDocumentoPorId(from,{ mediaId:KHUMIC_PDF_ID, filename:"Khumic-100-ficha.pdf", caption:"📄 Ficha Khumic-100." });
    if(intent==="ficha_seaweed")
      return enviarDocumentoPorId(from,{ mediaId:SEAWEED_PDF_ID, filename:"Seaweed-800-ficha.pdf", caption:"📄 Ficha Seaweed 800." });

    if(intent==="asesor"){
      tInfo.handoff = true;
      const slot = assignSlot(ticketId);
      // guarda este primer mensaje como pendiente
      tInfo.lastClientAt = Date.now();
      tInfo.unread = 1;
      tInfo.lastClientMsg = texto;

      const msj = enHorario
        ? "¡Perfecto! Te conecto con un asesor ahora mismo. 👨‍💼📲"
        : "Gracias por escribir. Un asesor te contactará en horario laboral. Puedo ayudarte por aquí mientras tanto. 🕗";
      await enviarTexto(from, msj);

      await notificarAdmin({
        name, num: from, ticket: ticketId, slot: `S${slot}`,
        texto: `🟢 Chat activado. Pendiente: “${preview(texto)}” • Responde con: *${slot} Tu mensaje*`
      });
      return;
    }

    if(intent==="gracias") return enviarTexto(from,"¡Con gusto! 😊 ¿Algo más?");
    return enviarTexto(from, menuPrincipal(enHorario));
  }catch(e){ console.error("Webhook error:", e); }
});

/* ===== Recordatorios + Cierre automático ===== */
const CHECK_SEC = 60;
setInterval(async ()=>{
  const now = Date.now();
  for(const [tk, info] of tickets){
    if(!info.handoff) continue;

    // Recordatorio si hay mensajes pendientes del cliente
    if(info.unread && info.lastClientAt){
      const mins = Math.floor((now - info.lastClientAt)/60000);
      if(mins >= Number(REMIND_AFTER_MIN) && now - (info.lastReminderAt||0) >= Number(REMIND_AFTER_MIN)*60000){
        const s = slotByTicket.get(tk) || assignSlot(tk);
        const pv = preview(info.lastClientMsg);
        await notificarAdmin({
          name: info.name, num: info.num, ticket: tk, slot: `S${s}`,
          texto: `⏰ Pendiente hace ${mins} min — “${pv}”. Responde: *${s} <texto>*  • Cerrar: *end ${s}*`
        });
        info.lastReminderAt = now;
      }
    }

    // Cierre automático si el cliente no responde tras mensaje del admin
    if(info.lastAdminAt && info.lastAdminAt > (info.lastClientAt || 0)){
      const minsFromAdmin = Math.floor((now - info.lastAdminAt)/60000);
      if(minsFromAdmin >= Number(AUTO_CLOSE_MIN)){
        await enviarTexto(info.num, MSG_CIERRE_AUTO);
        info.handoff = false; info.unread = 0; info.lastReminderAt = 0;
        freeSlot(tk);
        await notificarAdmin({ name: info.name, num: info.num, ticket: tk, texto: `🔒 Cierre automático por inactividad (${minsFromAdmin} min)` });
      }
    }
  }
}, CHECK_SEC*1000);

/* ===== Healthcheck ===== */
app.get("/", (_req, res) => res.send("OK"));
app.listen(PORT, () => console.log(`Bot listo en puerto ${PORT}`));
