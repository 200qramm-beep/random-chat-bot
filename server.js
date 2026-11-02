// Anonim WhatsApp eşləşdirmə botu — bazasız sadə versiya (Render üçün)
// Env: VERIFY_TOKEN, APP_SECRET, WA_TOKEN, PHONE_NUMBER_ID
// Diqqət: məlumat yaddaşda saxlanır, server yenidən başlayanda sıfırlanır.

const http = require("http");
const crypto = require("crypto");

const GRAPH = "https://graph.facebook.com/v21.0";
const WINDOW_MS = 23 * 3600 * 1000;
const MAX_LEN = 1000;
const BAN_AFTER = 3;

const WELCOME =
  "Salam! Bu bot təsadüfi biri ilə anonim yazışmaq üçündür.\n\n" +
  "• Nömrəniz qarşı tərəfə görünmür.\n" +
  "• Öz nömrənizi, ünvanınızı və şəxsi məlumatınızı yazmayın.\n" +
  "• Təhqir və spam qadağandır.\n" +
  "• Yalnız 18 yaşdan yuxarılar istifadə edə bilər.\n\n" +
  "Şərtlərlə razısınızsa və 18+ olduğunuzu təsdiq edirsinizsə, BƏLİ yazın.";

const HELP =
  "Əmrlər:\n" +
  "/start – söhbət axtar\n" +
  "/növbəti – başqası ilə əlaqə qur\n" +
  "/dayan – söhbəti bitir\n" +
  "/şikayət – qarşı tərəfi şikayət et və söhbəti bitir\n" +
  "/kömək – bu mesaj";

const COMMANDS = {
  "/start": "start", "/basla": "start", "/başla": "start",
  "/dayan": "stop",
  "/novbeti": "next", "/növbəti": "next",
  "/sikayet": "report", "/şikayət": "report",
  "/komek": "help", "/kömək": "help",
};

const users = new Map(); // phone -> user
const seen = new Map();  // message id -> ts

function getUser(phone) {
  let u = users.get(phone);
  if (!u) {
    u = { phone, state: "new", partner: null, lastPartner: null, lastIn: 0, waitSince: 0, reports: 0, banned: false };
    users.set(phone, u);
  }
  return u;
}

function setIdle(u, lastPartnerPhone) {
  u.state = "idle";
  u.partner = null;
  if (lastPartnerPhone) u.lastPartner = lastPartnerPhone;
}

function endChat(a, b) {
  setIdle(a, b.phone);
  setIdle(b, a.phone);
}

function validSig(raw, header, secret) {
  if (!header || !header.startsWith("sha256=") || !secret) return false;
  const hex = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(hex);
  const b = Buffer.from(header.slice(7));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function send(to, text) {
  try {
    const r = await fetch(`${GRAPH}/${process.env.PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WA_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text, preview_url: false },
      }),
    });
    if (!r.ok) console.error("send failed", r.status, await r.text());
    return r.ok;
  } catch (e) {
    console.error("send error", e);
    return false;
  }
}

async function handle(m) {
  const now = Date.now();
  if (seen.has(m.id)) return; // Meta eyni mesajı təkrar göndərə bilər
  seen.set(m.id, now);
  if (seen.size > 5000) {
    for (const [id, ts] of seen) if (now - ts > 86400000) seen.delete(id);
  }

  const u = getUser(m.from);
  u.lastIn = now;
  if (u.banned) return void (await send(u.phone, "Hesabınız şikayətlərə görə bloklanıb."));

  const text = m.type === "text" ? (m.text?.body || "").trim() : null;
  const lower = text ? text.toLowerCase() : "";

  if (u.state === "new") {
    if (["bəli", "beli", "yes"].includes(lower)) {
      setIdle(u, null);
      return void (await send(u.phone, "Təşəkkürlər!\n\n" + HELP));
    }
    return void (await send(u.phone, WELCOME));
  }

  const cmd = COMMANDS[lower];

  if (cmd === "help") return void (await send(u.phone, HELP));

  if (cmd === "start") {
    if (u.state === "chatting")
      return void (await send(u.phone, "Artıq söhbətdəsiniz. /növbəti və ya /dayan yaza bilərsiniz."));
    if (u.state === "waiting")
      return void (await send(u.phone, "Hələ axtarılır, bir az gözləyin..."));
    return void (await match(u));
  }

  if (cmd === "stop") {
    if (u.state === "chatting" && u.partner) {
      const p = users.get(u.partner);
      endChat(u, p);
      await send(p.phone, "Qarşı tərəf söhbəti bitirdi. Yenisi üçün /start yazın.");
    } else {
      setIdle(u, null);
    }
    return void (await send(u.phone, "Söhbət bitdi. Yenisi üçün /start yazın."));
  }

  if (cmd === "next") {
    if (u.state === "chatting" && u.partner) {
      const p = users.get(u.partner);
      endChat(u, p);
      await send(p.phone, "Qarşı tərəf söhbəti bitirdi. Yenisi üçün /start yazın.");
    } else if (u.state === "waiting") {
      return void (await send(u.phone, "Artıq axtarılır, bir az gözləyin..."));
    }
    return void (await match(u));
  }

  if (cmd === "report") {
    if (u.state !== "chatting" || !u.partner)
      return void (await send(u.phone, "Şikayət ediləcək aktiv söhbət yoxdur."));
    const p = users.get(u.partner);
    p.reports += 1;
    if (p.reports >= BAN_AFTER) p.banned = true;
    endChat(u, p);
    await send(p.phone, "Söhbət bitdi.");
    return void (await send(u.phone, "Şikayət qeydə alındı, söhbət bitdi. Yenisi üçün /start yazın."));
  }

  if (u.state === "chatting" && u.partner) return void (await relay(u, text));
  if (u.state === "waiting")
    return void (await send(u.phone, "Hələ axtarılır, bir az gözləyin..."));
  return void (await send(u.phone, "Söhbətdə deyilsiniz. Başlamaq üçün /start yazın."));
}

async function relay(u, text) {
  if (text === null)
    return void (await send(u.phone, "Hələlik yalnız mətn mesajları dəstəklənir."));
  if (text.length > MAX_LEN)
    return void (await send(u.phone, `Mesaj çox uzundur (maks. ${MAX_LEN} simvol).`));

  const p = users.get(u.partner);
  const gone =
    !p || p.state !== "chatting" || p.partner !== u.phone || Date.now() - p.lastIn > WINDOW_MS;

  if (!gone && (await send(p.phone, text))) return;

  if (p) endChat(u, p);
  else setIdle(u, null);
  await send(u.phone, "Qarşı tərəfə çatmaq mümkün olmadı, söhbət bitdi. Yenisi üçün /start yazın.");
}

async function match(u) {
  const now = Date.now();
  let best = null;
  for (const c of users.values()) {
    if (c.state !== "waiting" || c.banned || c.phone === u.phone) continue;
    if (now - c.lastIn > WINDOW_MS || c.phone === u.lastPartner) continue;
    if (!best || c.waitSince < best.waitSince) best = c;
  }

  if (best) {
    best.state = "chatting"; best.partner = u.phone;
    u.state = "chatting"; u.partner = best.phone;
    const msg =
      "Biri tapıldı! İndi yaza bilərsiniz. Nömrənizi paylaşmayın.\n/növbəti • /dayan • /şikayət";
    await send(u.phone, msg);
    await send(best.phone, msg);
    return;
  }

  u.state = "waiting"; u.partner = null; u.waitSince = now;
  await send(u.phone, "Axtarılır... Biri tapılan kimi yazacağam.");
}

let queue = Promise.resolve();

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/webhook" && req.method === "GET") {
      if (
        url.searchParams.get("hub.mode") === "subscribe" &&
        url.searchParams.get("hub.verify_token") === process.env.VERIFY_TOKEN
      ) {
        res.writeHead(200);
        return res.end(url.searchParams.get("hub.challenge"));
      }
      res.writeHead(403);
      return res.end("Forbidden");
    }

    if (url.pathname === "/webhook" && req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        if (!validSig(raw, req.headers["x-hub-signature-256"], process.env.APP_SECRET)) {
          res.writeHead(401);
          return res.end("Bad signature");
        }
        res.writeHead(200);
        res.end("OK");
        let body;
        try { body = JSON.parse(raw.toString("utf8")); } catch { return; }
        const msgs = (body.entry || []).flatMap((e) =>
          (e.changes || []).flatMap((c) => c.value?.messages || [])
        );
        for (const m of msgs) {
          queue = queue.then(() => handle(m)).catch((e) => console.error("handle error", e));
        }
      });
      return;
    }

    res.writeHead(200);
    res.end("OK"); // ping üçün
  })
  .listen(process.env.PORT || 3000, () => console.log("Bot işləyir"));
