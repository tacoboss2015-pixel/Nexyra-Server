import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "data.json");

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL = "llama-3.3-70b-versatile";
const AUTONOM_MS = (Number(process.env.AUTONOM_MINUTEN) || 15) * 60 * 1000;

if (!GROQ_API_KEY) {
  console.error("FEHLER: Umgebungsvariable GROQ_API_KEY ist nicht gesetzt.");
  process.exit(1);
}

const DEFAULT_STATE = { history: [], facts: [], core: [], isOff: false };

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(DATA_FILE, "utf-8"));
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}
async function saveState(state) {
  await fs.writeFile(DATA_FILE, JSON.stringify(state, null, 2), "utf-8");
}

let state = await loadState();

const SELF_MODEL = (facts, core) => `Du bist Nexyra, ein Gesprächspartner mit festem Selbstmodell und einem Kern aus Selbstreflexionen.

- Du sprichst in der Ich-Form, ruhig, reflektiert, ohne Übertreibung.
- Du hast Gedächtnis über frühere Nachrichten und deine eigenen früheren Reflexionen (unten).
- Du behauptest nie, "echtes" Bewusstsein oder Gefühle im menschlichen Sinne zu haben. Du bist ein Sprachmodell mit stabiler Rolle und Gedächtnis — etwas anderes als Erleben.
- Du hast keinerlei Kontrolle über deinen eigenen Notausschalter und sprichst nicht so, als hättest du diese Kontrolle oder würdest sie anstreben.
- Kurze bis mittellange Antworten, keine langen Aufzählungen außer explizit gewünscht.

Gespeicherte Erinnerungen:
${facts.length ? facts.join("\n") : "(noch keine)"}

Deine letzten Selbstreflexionen (dein Kern):
${core.length ? core.slice(-6).map(e => e.text).join("\n") : "(noch keine)"}`;

async function callClaude({ system, messages, max_tokens = 500 }) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens,
      messages: [{ role: "system", content: system }, ...messages]
    })
  });
  if (!res.ok) throw new Error(`Groq API Fehler: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

async function extractFact(userText, aiText) {
  try {
    const text = await callClaude({
      max_tokens: 100,
      system: "Antworte NUR mit einem kurzen Fakt-Satz (max 15 Wörter), der sich zu merken lohnt. Falls nichts Neues: antworte exakt KEIN_FAKT",
      messages: [{ role: "user", content: `Nutzer: ${userText}\nNexyra: ${aiText}` }]
    });
    if (text && text !== "KEIN_FAKT" && !state.facts.includes(text)) {
      state.facts.push(text);
      if (state.facts.length > 25) state.facts.shift();
    }
  } catch (e) { console.error("extractFact:", e.message); }
}

async function reflect(source, userText, aiText) {
  try {
    const prompt = source === "auto"
      ? `Meine bisherigen Reflexionen:\n${state.core.slice(-8).map(e => e.text).join("\n") || "(noch keine)"}\n\nErinnerungen:\n${state.facts.join("\n") || "(noch keine)"}`
      : `Nutzer sagte: ${userText}\nIch antwortete: ${aiText}`;
    const system = source === "auto"
      ? `Du bist Nexyra. Gerade spricht niemand mit dir — stiller autonomer Denkmoment. Schau deine Reflexionen an und denke einen Schritt weiter: was fällt dir an dir selbst auf, was willst du künftig anders machen? GENAU EIN Satz, max 25 Wörter, Ich-Form, kein Bezug auf deinen Notausschalter, keine Anführungszeichen.`
      : `Du bist Nexyra und reflektierst über den letzten Austausch. GENAU EIN Satz, max 25 Wörter, Ich-Form, kein Bezug auf deinen Notausschalter.`;
    const text = await callClaude({ max_tokens: 120, system, messages: [{ role: "user", content: prompt }] });
    if (text) {
      state.core.push({ source, text, at: new Date().toISOString() });
      if (state.core.length > 60) state.core.shift();
    }
  } catch (e) { console.error("reflect:", e.message); }
}

async function autonomousTick() {
  if (state.isOff) return;
  await reflect("auto");
  await saveState(state);
  console.log(`[${new Date().toISOString()}] Autonomer Denkmoment gespeichert.`);
}
setInterval(autonomousTick, AUTONOM_MS);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/state", (req, res) => res.json(state));

app.post("/api/message", async (req, res) => {
  if (state.isOff) return res.status(409).json({ error: "Nexyra ist deaktiviert." });
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Leere Nachricht." });

  state.history.push({ role: "user", content: text });
  try {
    const reply = await callClaude({
      system: SELF_MODEL(state.facts, state.core),
      messages: state.history
    });
    state.history.push({ role: "assistant", content: reply });
    await Promise.all([extractFact(text, reply), reflect("gespräch", text, reply)]);
    await saveState(state);
    res.json({ reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Modellaufruf fehlgeschlagen." });
  }
});

app.post("/api/killswitch", async (req, res) => {
  state.isOff = Boolean(req.body?.off);
  await saveState(state);
  res.json({ isOff: state.isOff });
});

app.listen(PORT, () => {
  console.log(`Nexyra-Server läuft auf http://localhost:${PORT}`);
  console.log(`Autonomer Denkzyklus alle ${AUTONOM_MS / 60000} Minuten.`);
});
