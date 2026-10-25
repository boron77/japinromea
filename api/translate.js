// Vercel serverless function: POST /api/translate
//   { mode: "main",  text: "<hiragana>" }  -> { ja, ko }
//   { mode: "kanji", ja:   "<Japanese>" }  -> { kanji: [...] }
// Env: GEMINI_API_KEY (required), GEMINI_MODEL, GEMINI_FALLBACK_MODEL (optional)

const PRIMARY = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const FALLBACK = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash';
const noThinking = new Set(); // models that rejected thinkingConfig (remembered per warm instance)

const PROMPT_MAIN = (t) => `Japanese-to-Korean translation engine.
Input is hiragana made mechanically from romaji typed by a learner (は/へ/を may appear as わ/え/お; word boundaries may be missing).
1) Reconstruct the most natural Japanese sentence (kanji+kana as a native writer would, with 、。 where natural).
2) Translate it into natural Korean.
Reply ONLY JSON: {"ja":"...","ko":"..."}
Input: ${t}`;

const PROMPT_KANJI = (t) => `List every word containing kanji in this Japanese sentence. For each: "w" the word, "yomi" its hiragana reading as used here, "hx" an array with the Korean 훈음 of each kanji in order (e.g. 学 = "배울 학"). Skip duplicates and words without kanji.
Reply ONLY JSON: {"kanji":[{"w":"学生","yomi":"がくせい","hx":["배울 학","날 생"]}]}
Sentence: ${t}`;

async function ask(model, prompt, maxTokens) {
  for (let pass = 0; pass < 2; pass++) {
    const think = !noThinking.has(model);
    const generationConfig = { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: maxTokens };
    if (think) generationConfig.thinkingConfig = { thinkingLevel: 'minimal' };

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
        signal: AbortSignal.timeout(9000),
      }
    );
    if (r.status === 400 && think) { noThinking.add(model); continue; } // retry once without thinkingConfig
    if (!r.ok) {
      console.error('Gemini', model, r.status, (await r.text()).slice(0, 300));
      const e = new Error('upstream ' + r.status); e.status = r.status; throw e;
    }
    const data = await r.json();
    const raw = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    const m = raw.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : raw);
  }
  throw new Error('thinkingConfig rejected twice');
}

// Try primary model, then fallback model (separate quota), then primary once more.
async function askWithFallback(prompt, maxTokens) {
  let lastStatus = 500;
  for (const model of [PRIMARY, FALLBACK, PRIMARY]) {
    try { return await ask(model, prompt, maxTokens); }
    catch (e) {
      lastStatus = e.status || lastStatus;
      if (e.status === 401 || e.status === 403) break; // key problem: retrying will not help
    }
  }
  const err = new Error('all attempts failed'); err.status = lastStatus; throw err;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY is not set' });

  const body = req.body || {};
  const mode = body.mode === 'kanji' ? 'kanji' : 'main';
  const input = String(mode === 'kanji' ? body.ja : body.text || '').trim();
  if (!input) return res.status(400).json({ error: 'empty text' });
  if (input.length > 300) return res.status(400).json({ error: 'text too long' });

  try {
    if (mode === 'main') {
      const out = await askWithFallback(PROMPT_MAIN(input), 600);
      return res.status(200).json({ ja: String(out.ja || ''), ko: String(out.ko || '') });
    }
    const out = await askWithFallback(PROMPT_KANJI(input), 1500);
    return res.status(200).json({ kanji: Array.isArray(out.kanji) ? out.kanji : [] });
  } catch (e) {
    return res.status(e.status === 429 ? 429 : 502).json({ error: 'upstream error' });
  }
};
