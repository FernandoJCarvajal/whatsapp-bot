// index.js — Pro Campo Bot
// Slots 1..20 + pendientes completos + recordatorios con varias líneas + cierre auto 30'
// Plantilla admin: lead_alert_util (5 params)
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
  ADMIN_PHONE,                        // 5939XXXXXXXX (sin +)
  ADMIN_TEMPLATE = "lead_alert_util", // plantilla con 5 parámetros
  REMIND_AFTER_MIN = 5,               // recordatorio si hay msgs pendientes
  AUTO_CLOSE_MIN = 30,                // cierre auto si el cliente no responde al admin
  CHATS_PENDING_MAX = 10,             // cuántas líneas mostrar por slot en 'chats'
  REMIND_PENDING_MAX = 5,             // cuántas líneas incluir en recordatorios
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
  REMIND_AFTER_MIN, AUTO_CLOSE_MIN, CHATS_PENDING_MAX, REMIND_PENDING_MAX
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
function minutesAgo(ts){ return Math.max(0, Math.floor((Date.now()-ts)/60000)); }
function oneLine(s){ return String(s||"").replace(/\s+/g," ").trim(); }
function preview(s, max=120){ const t=oneLine(s); return t.length>max ? t.slice(0,max-1)+"…" : t; }

/* ===== WhatsApp helpers ===== */
async function waFetch(path, payload){
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/${path}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if(!r.ok) throw new Error(await r.text());
  return r.json();
}
async function enviarTexto(to, body){
  try { await waFetch("messages", { messaging_product:"whatsapp", to, type:"text", text:{ body } }); return true; }
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

  const ok = await enviarTexto(ADMIN_PHONE, body);
  if(ok) return;

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
const tickets = new Map();          // ticketId -> info
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
      pending:[]
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
function withFooter(txt){
  return txt + "\n\n➡️ *Para continuar*, responde con el número:\n• 8️⃣ Hablar con un asesor\n• 0️⃣ Volver al inicio";
}
function footerBasico(){
  return "➡️ *Para continuar*, responde con el número:\n• 8️⃣ Hablar con un asesor\n• 0️⃣ Volver al inicio";
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

const GUIA_USO =
`\n\n🧪 *Guía rápida de uso (referencia general)*\n• *Dosis general:* 3–4 kg/ha/mes.\n• *Recomendación:* dividir en *2 aplicaciones* cada *15 días*.\n• *Tanque 200 L:* *500 gr* cada *15 días*.\n• *Por volumen de agua:* *2,5–3,5 g/L*.\n• *Vías:* edáfico/fertirriego y foliar.\n • 🚫 Evita aplicar por vía foliar en cultivos delicados (como rosas 🌹) ya que podrían generar manchas superficiales.\n • Ajustar según cultivo/etapa; *prueba de compatibilidad* antes de mezclar.`;

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
• *Despachos* a *mayorista*, *con previo aviso*.
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
const MSG_CIERRE_AUTO   = "⏳ Cerramos este chat por *falta de respuesta*. Si deseas retomar tu pedido, responde *8* para contactar a un asesor. ¡Gracias por preferirnos! 🌱";
const MSG_CIERRE_MANUAL = " *Gracias por preferirnos*. Si necesitas más ayuda, responde *8* para contactar de nuevo a un asesor. ¡Estamos para ayudarte!";

/* ===== Menús ===== */
function menuPrincipal(enHorario){
  const saludo =
    `🌱 *¡Hola! Soy ${DISPLAY_BOT_NAME}* 🤖 *estoy aquí para ayudarte* 🤝🧑‍🌾.\n` +
    "➡️ *Para seleccionar la opción, responde con el número de lo que necesitas conocer.*\n\n";
  const nota = enHorario ? "" : "_Fuera de horario: puedo darte info y dejamos la *compra* para el horario laboral (L–V 08:00–17:30, Sáb 08:00–13:00)._ \n\n";
  return saludo + nota +
    "1️⃣ Precios y promociones de *Khumic-100* (ácidos húmicos + fúlvicos)\n" +
    "2️⃣ Precios y promociones de *Khumic – Seaweed 800* (algas marinas)\n" +
    "3️⃣ Beneficios de *Khumic-100* (ácidos húmicos + fúlvicos)\n" +
    "4️⃣ Beneficios de *Khumic – Seaweed 800* (algas marinas)\n" +
    "5️⃣ Envíos y cómo encontrarnos\n" +
    "6️⃣ *Fichas técnicas (PDF)*\n" +
    "7️⃣ Sitio web y redes sociales \n" +
    "8️⃣ Hablar con un asesor \n" +
    "0️⃣ Volver al inicio";
}
function menuSoloOpciones(enHorario){
  const nota = enHorario ? "" : "_Fuera de horario: puedo darte info y dejamos la *compra* para el horario laboral (L–V 08:00–17:30, Sáb 08:00–13:00)._ \n\n";
  return nota +
    "1️⃣ Precios y promociones de *Khumic-100* (ácidos húmicos + fúlvicos)\n" +
    "2️⃣ Precios y promociones de *Khumic – Seaweed 800* (algas marinas)\n" +
    "3️⃣ Beneficios de *Khumic-100* (ácidos húmicos + fúlvicos)\n" +
    "4️⃣ Beneficios de *Khumic – Seaweed 800* (algas marinas)\n" +
    "5️⃣ Envíos y cómo encontrarnos\n" +
    "6️⃣ *Fichas técnicas (PDF)*\n" +
    "7️⃣ Sitio web y redes sociales \n" +
    "8️⃣ Hablar con un asesor \n" +
    "0️⃣ Volver al inicio";
}

/* ===== Intents (números + palabras clave) ===== */
function detectarNumeroEnFrase(t){
  const m = t.match(/(?:^|\D)([0-8])(?:\D|$)/); if(m) return m[1];
  const map={cero:"0",uno:"1",dos:"2",tres:"3",cuatro:"4",cinco:"5",seis:"6",siete:"7",ocho:"8"};
  for(const [w,n] of Object.entries(map)){ if(new RegExp(`\\b${w}\\b`).test(t)) return n; }
  return null;
}
const anyIncl = (t, arr) => arr.some(w => t.includes(normalizar(w)));

function detectarIntent(texto){
  const t = normalizar(texto);

  /* ----- A. Asesor / contacto (8) ----- */
  if (/^8$/.test(t) || anyIncl(t, [
    "asesor","agente","humano","contactar","comprar","necesito comprar","vendedor","cotizar",
    "hablar con asesor","hablar con alguien","llamar","soporte","atencion","asesoria","asesoría"
  ])) return "asesor";

  /* ----- B. Fichas técnicas (6) ----- */
  if (/^6$/.test(t) || anyIncl(t, [
    "fichas","ficha tecnica","fichas tecnicas","pdf","documento tecnico","hoja tecnica","datasheet","fichas pdf","informacion tecnica"
  ])) return "menu_fichas";
  if (t.includes("ficha") && (t.includes("100") || t.includes("khumic") || t.includes("humic"))) return "ficha_khumic";
  if (t.includes("ficha") && (t.includes("seaweed") || t.includes("800") || t.includes("algas"))) return "ficha_seaweed";

  /* ----- C. PRECIOS (lógica específica) ----- */
  // 1) Seaweed si menciona algas/seaweed/800
  if (anyIncl(t, ["precio algas","precio seaweed","seaweed","algas","800"])) return "op2";
  // 2) Khumic si menciona humico/ácidos/100/khumic
  if (anyIncl(t, ["precio humic","precio humico","precio humicos","precio acido","precio acidos","precio ácidos",
                  "humic","humico","ácidos","acidos","khumic","khumic 100","100"])) return "op1";
  // 3) Si dice solo "precio"/"precios" sin otros términos → ambos
  if (/^\s*(precio|precios)\s*$/i.test(t)) return "precios_ambos";

  // 4) Detección genérica (mantiene sinónimos regionales)
  if (/^1$/.test(t) || anyIncl(t, [
    "precio","precios","promo","promocion","promoción","oferta","ofertas","cuanto cuesta","cuanto es","cuanto sale",
    "cuanto vale","en cuanto esta","a cuanto esta","a cuanto","tarifa","lista de precios","valores","coste",
    "khumic","khumic 100","humic","humico","fulvico","fúlvico","acidos","ácidos"
  ])) return "op1";
  if (/^2$/.test(t) || anyIncl(t, [
    "seaweed","seaweed 800","algas","algas marinas","precio seaweed","promo seaweed","oferta seaweed",
    "cuanto cuesta seaweed","cuanto vale seaweed","en cuanto esta seaweed","a cuanto esta seaweed","800"
  ])) return "op2";

  /* ----- D. BENEFICIOS (lógica específica) ----- */
  // Seaweed si menciona algas/seaweed/800 junto a "beneficio/para qué sirve"
  if (anyIncl(t, ["beneficio seaweed","beneficios seaweed","beneficios algas","para que sirve seaweed","para que sirve algas","800 beneficios"])) return "op4";
  // Khumic si menciona humic/100/ácidos junto a beneficios
  if (anyIncl(t, ["beneficios humic","beneficios humico","beneficios acidos","beneficios ácidos","beneficios khumic","beneficios 100",
                  "para que sirve khumic","para que sirve humic","para que sirve acidos"])) return "op3";
  // Si dice solo "beneficio(s)" sin especificar → ambos
  if (/^\s*beneficio?s?\s*$/.test(t) || /^\s*para que sirve\s*$/.test(t) || /^\s*para qué sirve\s*$/.test(t)) return "beneficios_ambos";

  // Genéricos
  if (/^3$/.test(t) || anyIncl(t, [
    "beneficios","para que sirve","ventajas","efectos","funcion","por que usar khumic","khumic beneficios","humic beneficios"
  ])) return "op3";
  if (/^4$/.test(t) || anyIncl(t, [
    "beneficios seaweed","seaweed beneficios","para que sirve seaweed","algas beneficios","algas marinas beneficios"
  ])) return "op4";

  /* ----- E. Envíos / ubicación (5) ----- */
  if (/^5$/.test(t) || anyIncl(t, [
    "envio","envíos","enviar","flete","a domicilio","llega a","entregan","retiro","recoger","direccion","ubicacion","donde estan",
    "como los encuentro","demora","cuanto demora","tiempo de entrega","rastrear","rastreo","tracking","courier","cita express","entrega"
  ])) return "op5";

  /* ----- F. Links / redes (7) ----- */
  if (/^7$/.test(t) || anyIncl(t, ["web","sitio","pagina","pagina web","sitio web","redes","facebook","tiktok","instagram","link","links"])) return "links";

  /* ----- G. Inicio / menú (0 o saludo) ----- */
  if (/^(hola|buenos|buenas|menu|menú|inicio|start|empezar)$/i.test(t)) return "inicio";
  if (/^0$/.test(t) || /\bcero\b/.test(t)) return "inicio";

  /* ----- H. Gracias ----- */
  if (/gracias|muchas gracias|mil gracias|thank/i.test(t)) return "gracias";

  // Fallback por número suelto
  const num = detectarNumeroEnFrase(t);
  if(num!==null){
    return ({
      0:"inicio",1:"op1",2:"op2",3:"op3",4:"op4",5:"op5",
      6:"menu_fichas",7:"links",8:"asesor"
    })[num];
  }
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
          const count = info?.pending?.length || 0;
          let lines = "";
          if(count){
            const max = Number(CHATS_PENDING_MAX);
            const arr = info.pending.slice(-max);
            lines = "\n" + arr.map((p,i)=>`   ${i+1}) (${minutesAgo(p.ts)} min) “${preview(p.t, 160)}”`).join("\n");
            if(info.pending.length > max) lines += `\n   …(${info.pending.length - max} más)`;
          }
          return `${s}) #${tk} — ${info?.name}${count?` [${count}]`: ""}${lines}`;
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

      if((m=t.match(/^(bot|end)(?:\s+#([A-Z0-9]{4,8})|\s+(\d{1,2}))?$/i))){
        const cmd=m[1].toLowerCase();
        let tk=null;
        if(m[2]) tk=m[2].toUpperCase();
        else if(m[3]) tk=slots.get(parseInt(m[3],10));
        else tk=adminCtx.activeTicket;
        if(!tk || !tickets.has(tk)) return enviarTexto(from,"No encuentro el ticket.");
        const info=tickets.get(tk);
        if(cmd==="end"){ await enviarTexto(info.num, MSG_CIERRE_MANUAL); }
        info.handoff=false; info.unread=0; info.lastReminderAt=0; info.pending=[];
        freeSlot(tk);
        return enviarTexto(from, cmd==="end" ? `✅ Cerrado y bot reactivado para #${tk}.` : `🤖 Bot reactivado para #${tk}.`);
      }

      if((m=t.match(/^(\d{1,2})\?$/))){
        const s=parseInt(m[1],10); const tk=slots.get(s);
        if(!tk) return enviarTexto(from,"Slot vacío.");
        const inf=tickets.get(tk);
        const count = inf?.pending?.length || 0;
        if(!count) return enviarTexto(from, `Slot ${s}: #${tk} — ${inf?.name}\n(no hay pendientes)`);
        const lines = inf.pending.map((p,i)=>`   ${i+1}) (${minutesAgo(p.ts)} min) “${preview(p.t, 220)}”`).join("\n");
        return enviarTexto(from, `Slot ${s}: #${tk} — ${inf?.name} [${count}]\n${lines}`);
      }

      if((m=t.match(/^(\d{1,2})\s+([\s\S]+)/))){
        const s=parseInt(m[1],10); const body=m[2];
        const tk=slots.get(s); if(!tk) return enviarTexto(from,"Slot inválido.");
        const info=tickets.get(tk); const dest=info?.num; if(!dest) return enviarTexto(from,"Ticket inválido.");
        await enviarTexto(dest, body);
        info.unread=0; info.lastReminderAt=0; info.lastAdminAt=Date.now(); info.pending=[];
        return enviarTexto(from, `📨 Enviado a [${s}] #${tk}.`);
      }

      let mm;
      if((mm=t.match(/^r\s+#([A-Z0-9]{4,8})\s+([\s\S]+)/i))){
        const tk=mm[1].toUpperCase(), body=mm[2]; const inf=tickets.get(tk); const dest=inf?.num;
        if(!dest) return enviarTexto(from,"Ticket inválido.");
        await enviarTexto(dest,body); inf.unread=0; inf.lastReminderAt=0; inf.lastAdminAt=Date.now(); inf.pending=[];
        return enviarTexto(from,`📨 Enviado a #${tk}.`);
      }
      if((mm=t.match(/^r\s+(\d{1,2})\s+([\s\S]+)/i))){
        const s=parseInt(mm[1],10), body=mm[2]; const tk=slots.get(s); const inf=tickets.get(tk); const dest=inf?.num;
        if(!dest) return enviarTexto(from,"Slot inválido.");
        await enviarTexto(dest,body); inf.unread=0; inf.lastReminderAt=0; inf.lastAdminAt=Date.now(); inf.pending=[];
        return enviarTexto(from,`📨 Enviado a [${s}] #${tk}.`);
      }
      if((mm=t.match(/^r\s+([\s\S]+)/i))){
        if(!adminCtx.activeTicket) return enviarTexto(from,"No hay ticket activo. Usa *chats* o *use <slot>*.");
        const inf=tickets.get(adminCtx.activeTicket); const dest=inf?.num; if(!dest) return enviarTexto(from,"Ticket inválido.");
        await enviarTexto(dest, mm[1]); inf.unread=0; inf.lastReminderAt=0; inf.lastAdminAt=Date.now(); inf.pending=[];
        return enviarTexto(from,`📨 Enviado a #${adminCtx.activeTicket}.`);
      }

      const items=[...slots.keys()].sort((a,b)=>a-b).map(s=>{
        const tk=slots.get(s); const info=tickets.get(tk);
        const count = info?.pending?.length || 0;
        let lines = "";
        if(count){
          const max = Number(CHATS_PENDING_MAX);
          const arr = info.pending.slice(-max);
          lines = "\n" + arr.map((p,i)=>`   ${i+1}) (${minutesAgo(p.ts)} min) “${preview(p.t, 160)}”`).join("\n");
          if(info.pending.length > max) lines += `\n   …(${info.pending.length - max} más)`;
        }
        return `${s}) #${tk} — ${info?.name}${count?` [${count}]`: ""}${lines}`;
      }).join("\n") || "(sin chats en handoff)";
      return enviarTexto(from,
`📒 Chats activos (slots):
${items}

Responder rápido:
• *<slot> mensaje*   → ej. "3 Hola"
• *3?*               → info del slot 3 (todas las pendientes)
• *chats*            → lista de slots con pendientes
• *use <slot|#ID>*   → fijar activo
• *r <slot|#ID> msg* / *r msg (activo)*

Cerrar o volver bot:
• *bot <slot|#ID>*   → reactivar bot
• *end <slot|#ID>*   → reactivar bot y liberar slot (envía agradecimiento)`);
    }

    /* ----- CLIENTE ----- */
    const ticketId = ensureTicket(from, name, msg.id||from);
    const tInfo = tickets.get(ticketId);

    // En handoff: bot en silencio; acumula pendientes y notifica
    if(tInfo?.handoff){
      const s = slotByTicket.get(ticketId) || assignSlot(ticketId);
      tInfo.lastClientAt = Date.now();
      tInfo.unread = (tInfo.unread||0) + 1;
      tInfo.pending.push({ t: texto, ts: Date.now() });
      const arr = tInfo.pending.slice(-Number(REMIND_PENDING_MAX));
      const listado = arr.map((p,i)=>`${arr.length>1?`${i+1}) `:""}“${preview(p.t, 120)}”`).join("\n");
      await notificarAdmin({ name, num: from, ticket: ticketId, slot: `S${s}`, texto: listado || texto });
      return;
    }

    // Flujo normal
    const intent = detectarIntent(texto);
    const enHorario = esHorarioLaboral();

    if(intent==="inicio"){
      const soloOpciones = /^\s*(0|cero)\s*$/i.test(texto);
      return enviarTexto(from, soloOpciones ? menuSoloOpciones(enHorario) : menuPrincipal(enHorario));
    }

    // Precios y beneficios — incluir intents “ambos”
    if(intent==="precios_ambos"){
      await enviarTexto(from, MSG_PRECIOS_KHUMIC);
      await enviarTexto(from, MSG_PRECIOS_SEAWEED);
      return;
    }
    if(intent==="beneficios_ambos"){
      await enviarTexto(from, MSG_BENEFICIOS_KHUMIC);
      await enviarTexto(from, MSG_BENEFICIOS_SEAWEED);
      return;
    }

    if(intent==="op1")   return enviarTexto(from, MSG_PRECIOS_KHUMIC);
    if(intent==="op2")   return enviarTexto(from, MSG_PRECIOS_SEAWEED);
    if(intent==="op3")   return enviarTexto(from, MSG_BENEFICIOS_KHUMIC);
    if(intent==="op4")   return enviarTexto(from, MSG_BENEFICIOS_SEAWEED);
    if(intent==="op5")   return enviarTexto(from, MSG_ENVIOS);

    // 6 => enviar ambas fichas directamente + footer básico
    if(intent==="menu_fichas"){
      await enviarDocumentoPorId(from,{ mediaId:KHUMIC_PDF_ID, filename:"Khumic-100-ficha.pdf", caption:"📄 Ficha Khumic-100." });
      await enviarDocumentoPorId(from,{ mediaId:SEAWEED_PDF_ID, filename:"Seaweed-800-ficha.pdf", caption:"📄 Ficha Seaweed 800." });
      await enviarTexto(from, footerBasico());
      return;
    }

    if(intent==="links") return enviarTexto(from, MSG_LINKS);

    if(intent==="ficha_khumic")
      return enviarDocumentoPorId(from,{ mediaId:KHUMIC_PDF_ID, filename:"Khumic-100-ficha.pdf", caption:"📄 Ficha Khumic-100." });
    if(intent==="ficha_seaweed")
      return enviarDocumentoPorId(from,{ mediaId:SEAWEED_PDF_ID, filename:"Seaweed-800-ficha.pdf", caption:"📄 Ficha Seaweed 800." });

    if(intent==="asesor"){
      tInfo.handoff = true;
      const slot = assignSlot(ticketId);
      tInfo.lastClientAt = Date.now();
      tInfo.unread = 1;
      tInfo.pending = [{ t: texto, ts: Date.now() }];

      const msj = enHorario
        ? "¡Perfecto! Te conecto con un asesor ahora mismo. 👨‍💼📲"
        : "Gracias por escribir. Un asesor te contactará en horario laboral. Puedo ayudarte por aquí mientras tanto. 🕗";
      await enviarTexto(from, msj);

      const arr = tInfo.pending.slice(-Number(REMIND_PENDING_MAX));
      const listado = arr.map((p,i)=>`${arr.length>1?`${i+1}) `:""}“${preview(p.t, 120)}”`).join("\n");
      await notificarAdmin({
        name, num: from, ticket: ticketId, slot: `S${slot}`,
        texto: `🟢 Chat activado.\n${listado || preview(texto)}\nResponde: *${slot} <texto>*`
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

    if(info.unread && info.lastClientAt){
      const mins = Math.floor((now - info.lastClientAt)/60000);
      if(mins >= Number(REMIND_AFTER_MIN) && now - (info.lastReminderAt||0) >= Number(REMIND_AFTER_MIN)*60000){
        const s = slotByTicket.get(tk) || assignSlot(tk);
        const arr = info.pending.slice(-Number(REMIND_PENDING_MAX));
        const listado = arr.map((p,i)=>`${arr.length>1?`${i+1}) `:""}“${preview(p.t, 120)}” (${minutesAgo(p.ts)} min)`).join("\n");
        await notificarAdmin({
          name: info.name, num: info.num, ticket: tk, slot: `S${s}`,
          texto: `⏰ Pendientes:\n${listado}\nResponde: *${s} <texto>*  • Cerrar: *end ${s}*`
        });
        info.lastReminderAt = now;
      }
    }

    if(info.lastAdminAt && info.lastAdminAt > (info.lastClientAt || 0)){
      const minsFromAdmin = Math.floor((now - info.lastAdminAt)/60000);
      if(minsFromAdmin >= Number(AUTO_CLOSE_MIN)){
        await enviarTexto(info.num, MSG_CIERRE_AUTO);
        info.handoff = false; info.unread = 0; info.lastReminderAt = 0; info.pending = [];
        freeSlot(tk);
        await notificarAdmin({ name: info.name, num: info.num, ticket: tk, texto: `🔒 Cierre automático por inactividad (${minsFromAdmin} min)` });
      }
    }
  }
}, CHECK_SEC*1000);

/* ===== Healthcheck ===== */
app.get("/", (_req, res) => res.send("OK"));
app.listen(PORT, () => console.log(`Bot listo en puerto ${PORT}`));

