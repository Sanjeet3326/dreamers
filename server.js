// Simple Express proxy to call Google Generative API (Gemini 2.5 Flash).
// IMPORTANT: Set your API key in the environment variable GOOGLE_API_KEY before running.
// Do NOT embed the API key in client-side code.

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, './')));

// --- Simple local site index (reads your .html files and extracts text) ---
const SITE_FOLDER = path.join(__dirname, './');
const indexedPages = []; // [{ path, text, snippet }]

function stripHtml(html) {
  // Remove script/style blocks first
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  // Replace tags with spaces
  s = s.replace(/<[^>]+>/g, ' ');
  // Decode some common HTML entities roughly
  s = s.replace(/&nbsp;/g, ' ')
       .replace(/&amp;/g, '&')
       .replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function buildIndex() {
  try {
    // reset index
    indexedPages.length = 0;
    const files = fs.readdirSync(SITE_FOLDER);
    for (const f of files) {
      if (!f.toLowerCase().endsWith('.html')) continue;
      try {
        const p = path.join(SITE_FOLDER, f);
        const raw = fs.readFileSync(p, 'utf8');
        const text = stripHtml(raw);
        // Keep a short snippet (first 1000 chars) for context
        const snippet = text.slice(0, 1200);
        indexedPages.push({ path: f, text, snippet });
      } catch (e) {
        console.warn('Failed to read or parse', f, e && e.message);
      }
    }
    console.log('Indexed pages:', indexedPages.map(p => p.path));
  } catch (e) {
    console.warn('Index build failed', e && e.message);
  }
}

// Build index on startup
buildIndex();

function retrieveContext(query, maxPages = 3) {
  if (!query || indexedPages.length === 0) return [];
  const q = query.toLowerCase();
  // Simple scoring: count occurrences of query words in each page
  const qwords = q.split(/\s+/).filter(Boolean);
  const scores = indexedPages.map(p => {
    let score = 0;
    const low = p.text.toLowerCase();
    for (const w of qwords) {
      if (!w) continue;
      const re = new RegExp(w.replace(/[.*+?^${}()|[\\]\\]/g, '\\\$&'), 'g');
      const m = low.match(re);
      score += (m && m.length) || 0;
    }
    // also give slight boost if filename contains words
    if (p.path.toLowerCase().includes(q)) score += 1;
    return { page: p, score };
  });
  scores.sort((a, b) => b.score - a.score);
  const chosen = scores.filter(s => s.score > 0).slice(0, maxPages).map(s => s.page);
  // If no matches, optionally return the homepage snippet as general context
  if (chosen.length === 0 && indexedPages.length > 0) return [indexedPages[0]];
  return chosen;
}

app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server missing GOOGLE_API_KEY env variable' });

  const userMessage = req.body?.message || '';
  if (!userMessage) return res.status(400).json({ error: 'No message provided' });
  // Retrieve top page snippets to include as context
  const contexts = retrieveContext(userMessage, 3);
  // Prepare a human-friendly context block
  const contextText = contexts.map(c => `From ${c.path}: ${c.snippet}`).join('\n\n');

  // Admin: allow reindex via query param ?reindex=true handled below (optional)

  try {
    // Preferred: try the @google/genai SDK first (dynamic import so server still runs if package missing)
    try {
      const genaiPkg = await import('@google/genai').catch(() => null);
      if (genaiPkg && genaiPkg.GoogleGenAI) {
        try {
          const { GoogleGenAI } = genaiPkg;
          // Pass apiKey explicitly; the SDK may also read from env
          const ai = new GoogleGenAI({ apiKey });
          // Compose prompt: system instruction, optional context snippets, then user message
          const systemInstruction = `You are a helpful, polite assistant. When answering, prefer to use the information provided from the website context below when it's relevant. Do NOT say that you personally "don't have a website" or that you are an abstract AI; instead, answer using the site information when appropriate while staying truthful and helpful.`;
          const contentsArr = [];
          contentsArr.push({ type: 'text', text: systemInstruction });
          if (contextText) contentsArr.push({ type: 'text', text: `Website context:\n\n${contextText}` });
          contentsArr.push({ type: 'text', text: `User question: ${userMessage}` });

          // The SDK expects an iterable/array shape for contents; provide the assembled parts
          const sdkResp = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: contentsArr
          });

          // Try a few different extraction strategies depending on SDK response shape
          let replyFromSdk = null;
          if (!replyFromSdk && typeof sdkResp === 'string') replyFromSdk = sdkResp;
          if (!replyFromSdk && sdkResp?.text) replyFromSdk = sdkResp.text;
          if (!replyFromSdk && sdkResp?.response?.text) replyFromSdk = sdkResp.response.text;
          if (!replyFromSdk && sdkResp?.candidates && sdkResp.candidates[0]) {
            const c = sdkResp.candidates[0];
            if (c?.content && Array.isArray(c.content) && c.content[0]?.parts) replyFromSdk = c.content[0].parts[0].text;
            else if (c.text) replyFromSdk = c.text;
          }
          if (!replyFromSdk && sdkResp?.output && sdkResp.output.length) {
            try { replyFromSdk = sdkResp.output.map(o => (o.content || []).map(c => c.text || c).join('\n')).join('\n'); } catch(e){}
          }

          if (replyFromSdk) return res.json({ reply: String(replyFromSdk), sources: contexts.map(c => c.path) });
        } catch (sdkErr) {
          console.warn('genai SDK call failed, falling back to HTTP fetch. SDK error:', sdkErr && (sdkErr.message || sdkErr));
          // continue to HTTP fetch fallback below
        }
      }
    } catch (e) {
      console.warn('Error importing or using @google/genai SDK, falling back to HTTP fetch:', e && e.message);
    }

    // Try multiple endpoint variants in case the API path/version differs.
    const model = 'gemini-2.5-flash';
    const candidateEndpoints = [
      `https://generativelanguage.googleapis.com/v1/models/${model}:generate?key=${apiKey}`,
      `https://generativelanguage.googleapis.com/v1beta2/models/${model}:generate?key=${apiKey}`,
      `https://generativelanguage.googleapis.com/v1beta2/models/${model}:generateText?key=${apiKey}`,
      `https://generativelanguage.googleapis.com/v1/models/${model}:generateText?key=${apiKey}`
    ];

    // Use the Generative Language REST request shape: prompt.text
    const body = {
      prompt: { text: userMessage },
      temperature: 0.7,
      maxOutputTokens: 800
    };

    let lastError = null;
    let json = null;
    let usedEndpoint = null;

    for (const endpoint of candidateEndpoints) {
      try {
        console.log('Attempting endpoint:', endpoint);
        const r = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          timeout: 20000
        });

        const raw = await r.text();
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch (parseErr) {
          console.warn('Failed to parse JSON from endpoint', endpoint, 'status', r.status);
          console.warn('Raw response (truncated):', raw && raw.slice ? raw.slice(0, 1000) : raw);
          lastError = { type: 'parse', endpoint, status: r.status, raw };
          // try next endpoint
          continue;
        }

        if (!r.ok) {
          console.warn('Upstream API returned non-OK status', r.status, r.statusText, json);
          lastError = { type: 'status', endpoint, status: r.status, json };
          // try next endpoint
          continue;
        }

        // if we get here, we have a parsed JSON and OK status
        usedEndpoint = endpoint;
        break;
      } catch (err) {
        console.warn('Request failed for endpoint', endpoint, err && err.message);
        lastError = { type: 'fetch', endpoint, error: err };
        continue;
      }
    }

  if (!json) {
      console.error('All endpoint attempts failed. Last error:', lastError);
      // Provide helpful guidance based on lastError and return a friendly fallback reply
      let help = 'Failed to reach Gemini API.';
      if (lastError && lastError.type === 'status' && lastError.status === 404) {
        help = 'Upstream API returned 404 Not Found. The requested model or endpoint may be incorrect or not available for your API key.';
      } else if (lastError && lastError.type === 'status' && lastError.status === 400) {
        help = 'Upstream API rejected the request (400 Bad Request). The request format may be incompatible with your API version.';
      } else if (lastError && lastError.type === 'fetch') {
        help = 'Network or fetch error when contacting upstream API: ' + (lastError.error && lastError.error.message);
      }

      // Return a clear, actionable message to the frontend user (not exposing secrets)
      return res.json({ reply: `I can’t reach the AI service right now. ${help}\n\nWhat to check: make sure your GOOGLE_API_KEY in the server environment or .env is valid, the Generative AI API is enabled for that key, and the key is not restricted to disallow local requests.`, sources: [] });
    }

    let reply = '';
    console.log('Using endpoint:', usedEndpoint);
    console.log('API Response (parsed):', json);

    // Try multiple possible response shapes from different API versions
    if (json.text) {
      reply = json.text;
    } else if (json.candidates && json.candidates.length) {
      // Newer responses: candidates -> content -> parts
      try {
        const cand = json.candidates[0];
        if (cand.content && Array.isArray(cand.content)) {
          // content may contain parts
          const part = cand.content[0];
          if (part && part.text) reply = part.text;
          else if (cand.output) reply = cand.output;
        } else if (cand.output && cand.output[0] && cand.output[0].content) {
          reply = cand.output[0].content.map(c => c.text || c).join('\n');
        } else if (cand.text) {
          reply = cand.text;
        }
      } catch (e) {
        console.warn('Failed to extract from candidates shape', e);
      }
    } else if (json.output && json.output.length) {
      try {
        reply = json.output.map(o => (o.content || []).map(c => c.text || c).join('\n')).join('\n');
      } catch (e) { reply = String(json.output); }
    } else {
      console.error('Unexpected API response format:', json);
      return res.status(500).json({ error: 'Unexpected API response format', sample: json });
    }

    return res.json({ reply, sources: contexts.map(c => c.path) });
  } catch (err) {
    console.error('Chat proxy error', err);
    return res.status(500).json({ error: 'Proxy request failed' });
  }
});

app.listen(PORT, ()=> console.log(`Server listening on http://localhost:${PORT}`));

// Admin endpoint to reindex site files without restarting
app.post('/api/reindex', (req, res) => {
  try {
    buildIndex();
    return res.json({ ok: true, indexed: indexedPages.map(p => p.path) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message });
  }
});
