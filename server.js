// AI Sales Caller: server + dashboard (Vapi). Run: npm install && node server.js
const express = require("express");
const fs = require("fs");
const app = express();
app.use(express.json({ limit: "5mb" }));

const { VAPI_KEY, VAPI_PHONE_ID, PUBLIC_URL, DASH_PASSWORD = "changeme", VOICE_ID = "21m00Tcm4TlvDq8ikWAM" } = process.env;
const DB_FILE = "data.json";
let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE)) : {
  settings: { company: "", product: "", pricing: "", script: "" }, businesses: [] };
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

// Webhook from Vapi (no password; Vapi can't send one). Registered before auth.
app.post("/webhook", (req, res) => {
  const m = req.body.message || {};
  if (m.type === "end-of-call-report") {
    const id = m.call?.metadata?.businessId || db.businesses.find(b => b.callId === m.call?.id)?.id;
    const b = db.businesses.find(x => x.id === id);
    if (b) {
      const sd = m.analysis?.structuredData || {};
      b.transcript = m.transcript || "";
      b.summary = m.analysis?.summary || m.summary || "";
      b.language = sd.language || b.language;
      b.keypad = sd.keypad_answer || "";
      b.notes = sd.notes || "";
      b.status = ["interested", "callback", "declined"].includes(sd.outcome) ? sd.outcome
        : (m.endedReason || "").includes("voicemail") || (m.endedReason || "").includes("no-answer") ? "no_answer" : "called";
      save();
    }
  }
  res.sendStatus(200);
});

// Password protection for dashboard + API
app.use((req, res, next) => {
  const [, pass] = Buffer.from((req.headers.authorization || "").split(" ")[1] || "", "base64").toString().split(":");
  if (pass === DASH_PASSWORD) return next();
  res.set("WWW-Authenticate", 'Basic realm="Dashboard"').status(401).send("Login required");
});

const score = b => ({ interested: 4, callback: 3, new: 2, no_answer: 1, called: 1, declined: -1 }[b.status] ?? 0);

app.get("/api/data", (req, res) => res.json({ ...db, businesses: [...db.businesses].sort((a, b) => score(b) - score(a)) }));
app.post("/api/settings", (req, res) => { db.settings = req.body; save(); res.json({ ok: true }); });
app.post("/api/businesses", (req, res) => {
  const lines = (req.body.text || "").split("\n").map(l => l.trim()).filter(Boolean);
  for (const l of lines) {
    const [name, phone] = l.split(",").map(s => s.trim());
    if (name && phone) db.businesses.push({ id: Date.now() + Math.random().toString(36).slice(2, 6), name, phone, status: "new" });
  }
  save(); res.json({ ok: true });
});
app.delete("/api/businesses/:id", (req, res) => { db.businesses = db.businesses.filter(b => b.id !== req.params.id); save(); res.json({ ok: true }); });

function buildPrompt(s, name) {
  return `You are a friendly sales caller for ${s.company}. You are calling a business called "${name}". You are an AI assistant; if asked, say so honestly.

LANGUAGE: The call opens with a bilingual menu. If the person presses/says 1 or says English, speak only English. If 2 or Arabic, speak only Arabic (Saudi/Gulf dialect, polite and natural). Default to the language they reply in.

WHAT WE SELL: ${s.product}
PRICING: ${s.pricing}
CALL SCRIPT / GOALS: ${s.script}

Only use the facts above. If you don't know something, say a team member will follow up. Never invent prices or promises.
Keep replies short (1-2 sentences). Be polite; if they're busy or uninterested, thank them and end the call.

KEYPAD MOMENTS (the person can press keys on their phone; presses appear as "1" or "2"):
- After a short pitch, say: "To get more info, press 1. If not interested, press 2." (Arabic: "للمزيد من المعلومات اضغط 1، وإذا غير مهتم اضغط 2.")
- If 1: explain more and ask: "For payment details, press 1. For a callback from our team, press 2."
- If 2: thank them and end the call.`;
}

app.post("/api/call/:id", async (req, res) => {
  const b = db.businesses.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: "Not found" });
  if (!VAPI_KEY || !VAPI_PHONE_ID || !PUBLIC_URL) return res.status(500).json({ error: "Set VAPI_KEY, VAPI_PHONE_ID, PUBLIC_URL env vars" });
  const s = db.settings;
  try {
    const r = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: { Authorization: `Bearer ${VAPI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        phoneNumberId: VAPI_PHONE_ID,
        customer: { number: b.phone, name: b.name },
        metadata: { businessId: b.id },
        assistant: {
          firstMessage: "Hello! Press 1 for English, or say English. مرحباً! اضغط 2 للعربية، أو قل عربي.",
          model: { provider: "openai", model: "gpt-4o", messages: [{ role: "system", content: buildPrompt(s, b.name) }] },
          voice: { provider: "11labs", voiceId: VOICE_ID, model: "eleven_multilingual_v2" },
          transcriber: { provider: "deepgram", model: "nova-3", language: "multi" },
          keypadInputPlan: { enabled: true, timeoutSeconds: 2, delimiters: ["#"] },
          serverUrl: PUBLIC_URL + "/webhook",
          serverMessages: ["end-of-call-report"],
          analysisPlan: {
            summaryPlan: { enabled: true },
            structuredDataPlan: {
              enabled: true,
              schema: { type: "object", properties: {
                language: { type: "string", enum: ["English", "Arabic"] },
                outcome: { type: "string", enum: ["interested", "callback", "declined", "unclear"] },
                keypad_answer: { type: "string", description: "Keys the person pressed and what they meant" },
                notes: { type: "string", description: "Key things the customer said, objections, questions" } } }
            }
          }
        }
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(500).json({ error: JSON.stringify(data) });
    b.status = "calling"; b.callId = data.id; save();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/", (req, res) => res.send(PAGE));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Caller</title><style>
body{font-family:system-ui,sans-serif;margin:0;background:#f5f6f8;color:#1a1a1a}
header{background:#111;color:#fff;padding:14px 20px;font-weight:600}
main{max-width:1000px;margin:20px auto;padding:0 16px;display:grid;gap:16px}
section{background:#fff;border-radius:10px;padding:16px;box-shadow:0 1px 3px #0001}
h2{margin:0 0 10px;font-size:16px}
input,textarea{width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:6px;margin-bottom:8px;font:inherit}
button{background:#111;color:#fff;border:0;border-radius:6px;padding:8px 14px;cursor:pointer;font:inherit}
button.s{background:#e5e7eb;color:#111;padding:5px 10px}
table{width:100%;border-collapse:collapse;font-size:14px}
td,th{padding:8px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
.tag{padding:2px 8px;border-radius:99px;font-size:12px;background:#e5e7eb}
.interested{background:#bbf7d0}.callback{background:#fde68a}.declined{background:#fecaca}.calling{background:#bfdbfe}
pre{white-space:pre-wrap;background:#f5f6f8;padding:8px;border-radius:6px;font-size:13px}
</style></head><body><header>AI Sales Caller</header><main>
<section><h2>1. Your business info (the AI uses only this)</h2>
<input id="company" placeholder="Company name">
<textarea id="product" rows="3" placeholder="What you sell (e.g. websites for small businesses, features, delivery time)"></textarea>
<textarea id="pricing" rows="2" placeholder="Pricing / packages"></textarea>
<textarea id="script" rows="3" placeholder="Goal & script (e.g. offer a free demo, collect best time to call back)"></textarea>
<button onclick="saveSettings()">Save</button> <span id="saved"></span></section>
<section><h2>2. Add businesses (one per line: Name, +9665XXXXXXXX)</h2>
<textarea id="bulk" rows="3" placeholder="Al Noor Restaurant, +966501234567"></textarea><button onclick="addBiz()">Add</button></section>
<section><h2>3. Call list (best prospects first)</h2><button onclick="callNext()" style="margin-bottom:10px">Call next uncalled</button>
<table><thead><tr><th>Business</th><th>Status</th><th>Lang</th><th>Keypad</th><th></th></tr></thead><tbody id="rows"></tbody></table></section>
<section><h2>4. Call details</h2><div id="detail">Click "View" on a business.</div></section>
</main><script>
let D={};
const api=(u,m="GET",b)=>fetch(u,{method:m,headers:{"Content-Type":"application/json"},body:b?JSON.stringify(b):undefined}).then(r=>r.json());
const esc=s=>(s||"").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
async function load(){D=await api("/api/data");
for(const k of ["company","product","pricing","script"])if(document.activeElement.id!==k)document.getElementById(k).value=D.settings[k]||"";
rows.innerHTML=D.businesses.map(b=>'<tr><td><b>'+esc(b.name)+'</b><br>'+esc(b.phone)+'</td><td><span class="tag '+b.status+'">'+b.status+'</span></td><td>'+esc(b.language)+'</td><td>'+esc(b.keypad)+'</td><td><button class="s" onclick="call(\\''+b.id+'\\')">Call</button> <button class="s" onclick="view(\\''+b.id+'\\')">View</button> <button class="s" onclick="del(\\''+b.id+'\\')">✕</button></td></tr>').join("")}
async function saveSettings(){await api("/api/settings","POST",{company:company.value,product:product.value,pricing:pricing.value,script:script.value});saved.textContent="Saved ✓";setTimeout(()=>saved.textContent="",2000)}
async function addBiz(){await api("/api/businesses","POST",{text:bulk.value});bulk.value="";load()}
async function call(id){if(!confirm("Start call?"))return;const r=await api("/api/call/"+id,"POST");if(r.error)alert(r.error);load()}
async function callNext(){const b=D.businesses.find(x=>x.status==="new");if(!b)return alert("No uncalled businesses");call(b.id)}
async function del(id){await api("/api/businesses/"+id,"DELETE");load()}
function view(id){const b=D.businesses.find(x=>x.id===id);detail.innerHTML='<b>'+esc(b.name)+'</b><p><b>Summary:</b> '+esc(b.summary||"—")+'</p><p><b>Notes:</b> '+esc(b.notes||"—")+'</p><p><b>Transcript:</b></p><pre>'+esc(b.transcript||"No transcript yet")+'</pre>'}
load();setInterval(load,8000);
</script></body></html>`;

app.listen(process.env.PORT || 3000, () => console.log("Running on port " + (process.env.PORT || 3000)));
