// server.js
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();
const PORT = process.env.PORT || 5000;
const CHAT_MODEL = process.env.CHAT_MODEL || "gpt-4o-mini";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Please set OPENAI_API_KEY in .env");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const app = express();
app.use(bodyParser.json());

/**
 * Utility: wrapper to call chat completions and log tokens
 * Accepts options: { messages, temperature, top_p, top_k, stop, max_tokens }
 * Returns an object { raw, parsed (if JSON), usage }
 */
async function callChat({ messages, temperature = 0.3, top_p = 0.95, top_k = null, stop = null, max_tokens = 512 }) {
  try {
    // Build request payload
    const payload = {
      model: CHAT_MODEL,
      messages,
      temperature,
      top_p,
      max_tokens
      // note: some providers accept top_k; include only if provided
    };
    if (top_k !== null) payload.top_k = top_k;
    if (stop !== null) payload.stop = Array.isArray(stop) ? stop : [stop];

    // call chat completions
    const res = await openai.chat.completions.create(payload);

    // Token logging (usage)
    const usage = res.usage || {};
    console.log(`[TOKENS] prompt=${usage.prompt_tokens ?? 0} completion=${usage.completion_tokens ?? 0} total=${usage.total_tokens ?? 0}`);

    // Extract text / content
    const choice = res.choices?.[0];
    const message = choice?.message;
    const content = message?.content;

    // try to parse JSON if it looks like JSON
    let parsed = null;
    if (typeof content === "string") {
      const trimmed = content.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try { parsed = JSON.parse(trimmed); } catch (e) { parsed = null; }
      }
    }

    return { raw: res, content, parsed, usage };
  } catch (err) {
    console.error("Chat call error:", err);
    throw err;
  }
}

/**
 * RTFC System prompt (Role, Task, Format, Constraints)
 * This is a clean system prompt for the Career Bot use case.
 */
const SYSTEM_PROMPT_RTFC = `ROLE: You are the AI Career Guide Bot.
TASK: Given a user's Interests, Skills, and Education, recommend 1-3 career options and short next steps.
FORMAT: Return valid JSON only with keys: careers (array of strings), why (array of short reasons), next_steps (array of short actionable steps).
CONSTRAINTS: Keep answers concise (max 3 careers). If unsure, provide alternatives and mention assumptions. Use India-relevant colleges or online course names where possible.`;

/* ===========================
/* 3) Multi-shot prompt
   - Two or three short examples (contrasting). Then user input.
*/
const MULTI_SHOT_PROMPT = (userInfo) => {
  const ex1 = {
    input: { interests: "design, psychology", skills: "Figma, research", education: "B.Des" },
    output: {
      careers: ["UX Designer"],
      why: ["Design + psychology = user-centred design fit."],
      next_steps: ["Build UX case studies and a portfolio using Figma."]
    }
  };
  const ex2 = {
    input: { interests: "data, storytelling", skills: "SQL, Excel", education: "BCom" },
    output: {
      careers: ["Data Analyst"],
      why: ["Data + storytelling fits analyst role translating numbers to insights."],
      next_steps: ["Learn SQL advanced, make dashboards with PowerBI or Tableau."]
    }
  };

  return [
    { role: "system", content: SYSTEM_PROMPT_RTFC },
    { role: "user", content: `Example 1 Input: ${JSON.stringify(ex1.input)}\nExample 1 Output: ${JSON.stringify(ex1.output)}\n\nExample 2 Input: ${JSON.stringify(ex2.input)}\nExample 2 Output: ${JSON.stringify(ex2.output)}\n\nNow Input: ${JSON.stringify(userInfo)}\nProduce the JSON response as described in the system prompt.\n###END` }
  ];
};

/* ===========================
   Routes
   =========================== */

/**
 * General single endpoint where you can pass style param:
 * style = zero|one|multi
 * body: { userInfo: {interests, skills, education}, temperature, top_p, top_k }
 * returns JSON output from model (and token usage logged)
 */
app.post("/ask", async (req, res) => {
  try {
    const { style = "zero", userInfo = {}, temperature = 0.3, top_p = 0.95, top_k = null } = req.body;

    let messages;
    if (style === "zero") messages = ZERO_SHOT_PROMPT(userInfo);
    else if (style === "one") messages = ONE_SHOT_PROMPT(userInfo);
    else if (style === "multi") messages = MULTI_SHOT_PROMPT(userInfo);
    else return res.status(400).json({ error: "Invalid style. Use zero|one|multi" });

    // Append a short user follow-up to enforce JSON-only answer and stop sequence sentinel
    messages.push({ role: "user", content: "Return only the JSON object. Stop when done. END" });

    const chatRes = await callChat({
      messages,
      temperature,
      top_p,
      top_k,
      stop: "END",
      max_tokens: 400
    });

    // return parsed if parsed, else content
    res.json({
      ok: true,
      style,
      input: userInfo,
      output: chatRes.parsed ?? chatRes.content,
      usage: chatRes.usage
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

/**
 * Individual endpoints for testing each prompt type separately (optional)
 */
app.post("/zero-shot", async (req, res) => {
  const { userInfo = {}, temperature = 0.3, top_p = 0.95, top_k = null } = req.body;
  try {
    const messages = ZERO_SHOT_PROMPT(userInfo);
    const r = await callChat({ messages, temperature, top_p, top_k, stop: "END", max_tokens: 400 });
    res.json({ ok: true, output: r.parsed ?? r.content, usage: r.usage });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/one-shot", async (req, res) => {
  const { userInfo = {}, temperature = 0.35, top_p = 0.95, top_k = null } = req.body;
  try {
    const messages = ONE_SHOT_PROMPT(userInfo);
    const r = await callChat({ messages, temperature, top_p, top_k, stop: "END", max_tokens: 400 });
    res.json({ ok: true, output: r.parsed ?? r.content, usage: r.usage });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/multi-shot", async (req, res) => {
  const { userInfo = {}, temperature = 0.25, top_p = 0.9, top_k = null } = req.body;
  try {
    const messages = MULTI_SHOT_PROMPT(userInfo);
    const r = await callChat({ messages, temperature, top_p, top_k, stop: "END", max_tokens: 400 });
    res.json({ ok: true, output: r.parsed ?? r.content, usage: r.usage });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

/**
 * A utility endpoint to demo Temperature, Top-P, Top-K behavior quickly:
 * POST /generate-variants
 * body: { userInfo, temps: [0.1,0.5,0.9], top_ps: [0.8,0.95], top_ks: [null,50] }
 */
app.post("/generate-variants", async (req, res) => {
  const { userInfo = {}, temps = [0.1, 0.5, 0.9], top_ps = [0.9], top_ks = [null] } = req.body;
  const results = [];
  for (const t of temps) {
    for (const tp of top_ps) {
      for (const tk of top_ks) {
        const messages = ZERO_SHOT_PROMPT(userInfo);
        const r = await callChat({ messages, temperature: t, top_p: tp, top_k: tk, stop: "END", max_tokens: 200 });
        results.push({ temperature: t, top_p: tp, top_k: tk, output: r.parsed ?? r.content, usage: r.usage });
      }
    }
  }
  res.json({ ok: true, results });
});

/**
 * Info route: shows effective defaults and describes RTFC system prompt
 */
app.get("/", (req, res) => {
  res.send({
    service: "Career Bot (single server.js)",
    model: CHAT_MODEL,
    defaults: { temperature: 0.3, top_p: 0.95, stop_sequence: "END" },
    rtfc_system_prompt: SYSTEM_PROMPT_RTFC,
    endpoints: {
      ask: { method: "POST", body: "{ style: 'zero|one|multi', userInfo, temperature, top_p, top_k }" },
      zero_shot: { method: "POST", body: "{ userInfo }" },
      one_shot: { method: "POST", body: "{ userInfo }" },
      multi_shot: { method: "POST", body: "{ userInfo }" },
      generate_variants: { method: "POST", body: "{ userInfo, temps, top_ps, top_ks }" }
    },
    notes: [
      "Top-K support depends on your model/provider. If your model rejects top_k, omit it.",
      "Stop sequence 'END' is appended and used in callChat to stop the model from continuing past the JSON.",
      "Token usage is logged in the server console for every call (see '[TOKENS]' lines)."
    ]
  });
});

/* ============ Start server ============ */
app.listen(PORT, () => {
  console.log(`Career Bot server running on http://localhost:${PORT}`);
  console.log(`Model: ${CHAT_MODEL}  |  Default stop sequence: "END"`);
  console.log("Make POST requests to /ask, /zero-shot, /one-shot, /multi-shot");
});
