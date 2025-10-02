// src/worker.js

const JSONH = { "Content-Type": "application/json" };
const ok = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: JSONH });
const bad = (msg, code=400) => ok({ ok:false, error: msg, code });

function cors(res, env) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", env.ALLOWED_ORIGIN || "*");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Key");
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  return new Response(res.body, { status: res.status, headers: h });
}

async function readJSON(req) { try { return await req.json(); } catch { return null; } }
function isE164(phone) { return /^\+?[1-9]\d{7,14}$/.test(phone); }

async function sendSMS(env, to, text, mediaUrls=null) {
  const body = { from: env.TELNYX_FROM_NUMBER, to, text };
  if (mediaUrls && mediaUrls.length) body.media_urls = mediaUrls;
  const r = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.TELNYX_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return r.ok;
}

async function signR2Url(env, key) {
  const object = await env.PROOF_BUCKET.head(key);
  if (!object) return null;
  const url = await env.PROOF_BUCKET.createPresignedUrl({ key, expiration: 24 * 60 * 60 });
  return url;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return cors(new Response("", { status: 204 }), env);

    if (url.pathname === "/api/lead" && req.method === "POST") {
      const data = await readJSON(req);
      if (!data) return cors(bad("invalid JSON"), env);
      let { phone, handle } = data;
      if (!phone || !isE164(phone)) return cors(bad("phone must be E.164"), env);
      if (!handle || String(handle).length < 3) return cors(bad("handle required"), env);

      const id = env.ROTATOR_DO.idFromName("rotator-singleton");
      const stub = env.ROTATOR_DO.get(id);
      const link = await (await stub.fetch("https://do/assign", { method: "POST", body: JSON.stringify({}) })).json();
      if (!link || !link.id) return cors(bad("no active link available"), env);

      const leadId = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO leads (id, phone, handle, assigned_link_id, state) VALUES (?, ?, ?, ?, 'awaiting_done')"
      ).bind(leadId, phone, handle, link.id).run();

      const intro = (env.TEMPLATE_INTRO || "Here: {{LINK}}").replace("{{LINK}}", link.url);
      await sendSMS(env, phone, intro);
      await env.DB.prepare(
        "INSERT INTO messages (id, phone, direction, text) VALUES (?, ?, 'outbound', ?)"
      ).bind(crypto.randomUUID(), phone, intro).run();

      return cors(ok({ ok:true, leadId }), env);
    }

    if (url.pathname === "/hooks/telnyx" && req.method === "POST") {
      const payload = await readJSON(req);
      const p = payload?.data?.payload || {};
      const from = p?.from?.phone_number;
      const textRaw = (p?.text || "").trim();
      const text = textRaw.toUpperCase();
      const hasMedia = Array.isArray(p?.media) && p.media.length > 0;

      if (!from) return cors(bad("no from"), env);

      const lead = await env.DB.prepare("SELECT * FROM leads WHERE phone=? ORDER BY created_at DESC LIMIT 1").bind(from).first();
      if (!lead) {
        await sendSMS(env, from, "Hi! Please use the signup link first — scan the QR to start.");
        return cors(ok({ ok:true }), env);
      }

      await env.DB.prepare(
        "INSERT INTO messages (id, phone, direction, text, has_media) VALUES (?, ?, 'inbound', ?, ?)"
      ).bind(crypto.randomUUID(), from, textRaw, hasMedia ? 1 : 0).run();

      if (text === "DONE") {
        await env.DB.prepare("UPDATE leads SET state='awaiting_proof', updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .bind(lead.id).run();
        const ask = env.TEMPLATE_ASK_PROOF || "Reply with a screenshot.";
        await sendSMS(env, from, ask);
        return cors(ok({ ok:true }), env);
      }

      if (hasMedia && lead.state === "awaiting_proof") {
        const mediaUrl = p.media[0].url;
        const res = await fetch(mediaUrl, { headers: { "Authorization": `Bearer ${env.TELNYX_API_KEY}` } });
        if (!res.ok) {
          await sendSMS(env, from, "We couldn’t read your image—please resend.");
          return cors(ok({ ok:false }), env);
        }
        const bytes = await res.arrayBuffer();
        const key = `proofs/${from}/${Date.now()}.jpg`;
        await env.PROOF_BUCKET.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
        const signed = await signR2Url(env, key);

        await env.DB.prepare("UPDATE leads SET state='verified', updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .bind(lead.id).run();
        await env.DB.prepare("INSERT INTO verifications (id, lead_id, media_key, media_url) VALUES (?, ?, ?, ?)")
          .bind(crypto.randomUUID(), lead.id, key, signed || "").run();

        const linkRow = await env.DB.prepare("SELECT url FROM links WHERE id=?").bind(lead.assigned_link_id).first();

        const id = env.ROTATOR_DO.idFromName("rotator-singleton");
        const stub = env.ROTATOR_DO.get(id);
        await stub.fetch("https://do/increment", {
          method: "POST",
          body: JSON.stringify({ linkId: lead.assigned_link_id })
        });

        await sendSMS(env, from, env.TEMPLATE_VERIFIED || "Verified. Thanks!");
        const opMsg = (env.TEMPLATE_OPERATOR || "NEW VERIFIED").replace("{{PHONE}}", from)
          .replace("{{HANDLE}}", lead.handle)
          .replace("{{LINK}}", linkRow?.url || "")
          .replace("{{URL}}", signed || "");
        await sendSMS(env, env.OPERATOR_PHONE, opMsg);

        return cors(ok({ ok:true }), env);
      }

      if (lead.state === "awaiting_done") {
        await sendSMS(env, from, "Once you’ve deposited $5, reply DONE.");
      } else if (lead.state === "awaiting_proof") {
        await sendSMS(env, from, "Please reply with an MMS screenshot of your $5 deposit/confirmation.");
      } else {
        await sendSMS(env, from, "You’re all set ✅");
      }
      return cors(ok({ ok:true }), env);
    }

    if (url.pathname === "/admin/status" && req.method === "GET") {
      if (env.ADMIN_KEY && req.headers.get("X-Admin-Key") !== env.ADMIN_KEY) return new Response("Forbidden", { status: 403 });
      const id = env.ROTATOR_DO.idFromName("rotator-singleton");
      const stub = env.ROTATOR_DO.get(id);
      const status = await (await stub.fetch("https://do/status")).json();
      return cors(ok(status), env);
    }

    return env.ASSETS.fetch(req);
  }
};

// Re-export the Durable Object so it’s visible to the runtime bundle
export { Rotator } from "./rotator.js";
