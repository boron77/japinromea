// Vercel serverless function: POST /api/translate  { text: "<hiragana>" }
// Needs the environment variable GEMINI_API_KEY (set in the Vercel dashboard).
// Optional: GEMINI_MODEL (default below).

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY is not set' });

  const text = String((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ error: 'empty text' });
  if (text.length > 300) return res.status(400).json({ error: 'text too long' });

  const prompt = `You are a Japanese-to-Korean translation engine.
The input is hiragana produced mechanically from romaji typed by a learner. It may use は/へ/を incorrectly as particles (wa→わ, e→え), and word boundaries may be missing. Reconstruct the most natural Japanese sentence (use kanji and kana as a native writer would, add 、。 where natural), then translate it into natural Korean.
Also list every word in the Japanese sentence that contains kanji. For each, give its reading in hiragana as used in this sentence, and the Korean 훈음 (hun-eum, e.g. 学 = "배울 학") of each kanji character in the word, in order. Skip duplicates and words without kanji.
Reply with ONLY a JSON object, no markdown: {"ja":"<Japanese>","ko":"<Korean>","kanji":[{"w":"学生","yomi":"がくせい","hx":["배울 학","날 생"]}]}
Input: ${text}`;

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
        }),
      }
    );

    if (!r.ok) {
      const detail = await r.text();
      console.error('Gemini error', r.status, detail);
      return res.status(r.status === 429 ? 429 : 502).json({ error: 'upstream error' });
    }

    const data = await r.json();
    const raw = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    const m = raw.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
    const out = JSON.parse(m ? m[0] : raw);
    return res.status(200).json({
      ja: String(out.ja || ''),
      ko: String(out.ko || ''),
      kanji: Array.isArray(out.kanji) ? out.kanji : [],
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server error' });
  }
};
