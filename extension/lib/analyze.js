// AI Visibility Checker — analysis pipeline (runs inside the extension, no backend)
//
// analyze(env, page) where env = { ANTHROPIC_API_KEY, SERANKING_API_KEY, GEN_MODEL?, CHECK_MODEL?, WEB_SEARCH_TOOL?, SER_LIMIT? }
//   1. Claude generates 5 prompts a user could ask where this page should be a source.
//   2. In parallel, SE Ranking Data API returns real prompts whose AI answers already cite this exact URL
//      (ChatGPT, AI Mode, AI Overview, Gemini, Perplexity).
//   3. Each generated prompt is checked LIVE in Claude with the web search tool (sync, no queue).
//   4. Claude matches generated prompts to the real database prompts (same search intent).
//
// Keys are stored locally in chrome.storage.local and sent only to api.anthropic.com and api.seranking.com.

const SER_ENGINES = [
  { id: "chatgpt", label: "ChatGPT" },
  { id: "ai-mode", label: "AI Mode" },
  { id: "ai-overview", label: "AI Overview" },
  { id: "gemini", label: "Gemini" },
  { id: "perplexity", label: "Perplexity" },
];

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function analyze(env, body) {
  const startedAt = Date.now();
  const page = {
    url: stripHash(body.url),
    title: clip(body.title, 300),
    description: clip(body.description, 500),
    headings: Array.isArray(body.headings) ? body.headings.slice(0, 40).map((h) => clip(String(h), 200)) : [],
    text: clip(body.text, 10000),
    lang: clip(body.lang, 10),
  };
  const country = /^[a-z]{2}$/i.test(body.country || "") ? body.country.toLowerCase() : "us";
  const limit = clampInt(env.SER_LIMIT, 1, 100, 10);

  // Step 1 + 2 in parallel
  const [gen, dbResults] = await Promise.all([
    generatePrompts(env, page),
    Promise.all(SER_ENGINES.map((e) => fetchPromptsByTarget(env, e.id, page.url, country, limit))),
  ]);

  // Step 3 + 4 in parallel
  const [claudeChecks, matches] = await Promise.all([
    Promise.all(gen.prompts.map((p) => safe(() => checkClaudeLive(env, p.text, page.url, country)))),
    safe(() => matchPrompts(env, gen.prompts, dbResults), []),
  ]);

  const engines = [
    { id: "claude", label: "Claude", mode: "live" },
    ...SER_ENGINES.map((e) => ({ ...e, mode: "database" })),
  ];

  const prompts = gen.prompts.map((p, i) => {
    const results = { claude: claudeChecks[i] };
    for (const db of dbResults) {
      if (!db.ok) {
        results[db.engine] = { status: "error", error: db.error };
        continue;
      }
      const m = (Array.isArray(matches) ? matches : []).find((x) => x.g === i && x.engine === db.engine);
      const matched = m ? db.prompts[m.db] : null;
      results[db.engine] = matched
        ? {
            status: "cited",
            strength: m.strength === "strong" ? "strong" : "partial",
            matchedPrompt: matched.prompt,
            answerSnippet: matched.answerSnippet,
          }
        : { status: "not_found", citedPromptsForUrl: db.total };
    }
    return { text: p.text, type: p.type, results };
  });

  const serankingPromptsReturned = dbResults.reduce((s, d) => s + (d.ok ? d.prompts.length : 0), 0);

  return {
    url: page.url,
    country,
    topic: gen.topic,
    language: gen.language,
    engines,
    prompts,
    database: dbResults.map((d) => ({
      engine: d.engine,
      label: SER_ENGINES.find((e) => e.id === d.engine)?.label || d.engine,
      ok: d.ok,
      error: d.error,
      total: d.total,
      date: d.date,
      prompts: d.prompts,
    })),
    usage: {
      serankingPromptsReturned,
      serankingCreditsEstimate: serankingPromptsReturned * 200,
      tookMs: Date.now() - startedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Step 1 — prompt generation (Claude)
// ---------------------------------------------------------------------------

async function generatePrompts(env, page) {
  const system = `You are a GEO (generative engine optimization) analyst. Given a web page, you write the prompts real people would type into ChatGPT, Gemini, Perplexity, Google AI Mode or Claude, where a good AI answer would plausibly cite THIS page as a source.

Rules:
- Exactly 5 prompts, each with a different intent type: "informational", "how-to", "comparison", "best-for", "problem".
- Write prompts in the page's language, the way a real user talks to a chatbot (natural, 6–20 words).
- Do NOT include the site's brand or domain name in the prompts. We want to know if the page wins on merit.
- Prompts must be answerable using this page's actual content, not just its general topic.
- Return ONLY a JSON object, no markdown:
{"language":"<ISO 639-1>","topic":"<page topic in 3-8 words>","prompts":[{"type":"informational","text":"..."}]}`;

  const user = `URL: ${page.url}
Declared lang: ${page.lang || "unknown"}
Title: ${page.title}
Meta description: ${page.description}
Headings:
${page.headings.join("\n")}

Main text (truncated):
${page.text}`;

  const res = await anthropic(env, {
    model: env.GEN_MODEL || "claude-sonnet-5-5",
    max_tokens: 1200,
    system,
    messages: [{ role: "user", content: user }],
  });

  const parsed = parseJsonObject(textOf(res));
  const prompts = Array.isArray(parsed?.prompts)
    ? parsed.prompts.filter((p) => p && typeof p.text === "string" && p.text.trim()).slice(0, 5)
    : [];
  if (!prompts.length) throw new Error("Claude did not return valid prompts")
  return {
    language: parsed.language || page.lang || null,
    topic: parsed.topic || page.title,
    prompts: prompts.map((p) => ({ type: String(p.type || "other"), text: p.text.trim() })),
  };
}

// ---------------------------------------------------------------------------
// Step 2 — SE Ranking Data API: prompts whose AI answer cites this exact URL
// Docs: https://seranking.com/api/data/ai-search#get-prompts-by-target
// Cost: 200 credits per returned prompt
// ---------------------------------------------------------------------------

async function fetchPromptsByTarget(env, engine, url, country, limit) {
  const qs = new URLSearchParams({ engine, target: url, scope: "url", source: country, limit: String(limit) });
  try {
    const r = await fetch(`https://api.seranking.com/v1/ai-search/prompts-by-target?${qs}`, {
      headers: { Authorization: `Token ${env.SERANKING_API_KEY}` },
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = data?.message || data?.error || (typeof data === "string" ? data : `HTTP ${r.status}`);
      return { engine, ok: false, error: `SE Ranking ${r.status}: ${msg}`, total: 0, prompts: [] };
    }
    const list = Array.isArray(data?.prompts) ? data.prompts : [];
    return {
      engine,
      ok: true,
      total: Number(data?.total) || list.length,
      date: data?.date || null,
      prompts: list.map((p) => ({
        prompt: p.prompt,
        volume: p.volume || null,
        type: p.type || null,
        answerSnippet: clip(p.answer?.text || "", 400),
        links: Array.isArray(p.answer?.links) ? p.answer.links.slice(0, 15) : [],
      })),
    };
  } catch (err) {
    return { engine, ok: false, error: `SE Ranking request failed: ${err.message}`, total: 0, prompts: [] };
  }
}

// ---------------------------------------------------------------------------
// Step 3 — live check in Claude with the web search server tool
// ---------------------------------------------------------------------------

export async function checkClaudeLive(env, prompt, pageUrl, country) {
  const tool = {
    type: env.WEB_SEARCH_TOOL || "web_search_20250305",
    name: "web_search",
    max_uses: 3,
    user_location: { type: "approximate", country: country.toUpperCase() },
  };

  let messages = [{ role: "user", content: prompt }];
  const content = [];
  for (let turn = 0; turn < 3; turn++) {
    const res = await anthropic(env, {
      model: env.CHECK_MODEL || "claude-sonnet-5-5",
      max_tokens: 1500,
      tools: [tool],
      messages,
    });
    content.push(...(res.content || []));
    if (res.stop_reason !== "pause_turn") break;
    messages = [...messages, { role: "assistant", content: res.content }];
  }

  const cited = new Set();
  const retrieved = new Set();
  for (const block of content) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) if (r?.url) retrieved.add(r.url);
    }
    if (block.type === "text" && Array.isArray(block.citations)) {
      for (const c of block.citations) if (c?.url) cited.add(c.url);
    }
  }

  const answer = content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  return { ...classify(pageUrl, [...cited], [...retrieved]), answerSnippet: clip(answer, 600) };
}

export function classify(pageUrl, cited, retrieved) {
  const target = normUrl(pageUrl);
  const host = hostOf(pageUrl);
  const citedSet = cited.map(normUrl);
  const retrievedSet = retrieved.map(normUrl);

  if (citedSet.includes(target)) return { status: "cited", citedUrls: cited.length }
  if (retrievedSet.includes(target)) return { status: "retrieved", citedUrls: cited.length }
  const sameDomain = [...cited, ...retrieved].find((u) => hostOf(u) === host);
  if (sameDomain) return { status: "domain", domainUrl: sameDomain, citedUrls: cited.length }
  return { status: "not_found", citedUrls: cited.length, topSources: cited.slice(0, 5) };
}

// ---------------------------------------------------------------------------
// Step 4 — match generated prompts to real database prompts (same intent)
// ---------------------------------------------------------------------------

async function matchPrompts(env, generated, dbResults) {
  const withData = dbResults.filter((d) => d.ok && d.prompts.length);
  if (!withData.length) return [];

  const dbBlock = withData
    .map((d) => `ENGINE ${d.engine}:\n` + d.prompts.map((p, j) => `  [${j}] ${p.prompt}`).join("\n"))
    .join("\n\n");
  const genBlock = generated.map((p, i) => `[${i}] ${p.text}`).join("\n");

  const res = await anthropic(env, {
    model: env.GEN_MODEL || "claude-sonnet-5-5",
    max_tokens: 1500,
    system: `You match search intents. For each GENERATED prompt and each ENGINE, find the database prompt with the same search intent (an answer to one would satisfy the other). "strong" = same question in other words. "partial" = clearly overlapping intent. Skip weak topical similarity. Return ONLY JSON: {"matches":[{"g":0,"engine":"chatgpt","db":3,"strength":"strong"}]}`,
    messages: [{ role: "user", content: `GENERATED:\n${genBlock}\n\nDATABASE (prompts whose AI answer already cites the page):\n${dbBlock}` }],
  });

  const parsed = parseJsonObject(textOf(res));
  const out = [];
  for (const m of parsed?.matches || []) {
    const d = withData.find((x) => x.engine === m.engine);
    if (!d || !Number.isInteger(m.g) || !Number.isInteger(m.db)) continue;
    if (m.g < 0 || m.g >= generated.length || m.db < 0 || m.db >= d.prompts.length) continue;
    if (out.some((x) => x.g === m.g && x.engine === m.engine)) continue;
    out.push({ g: m.g, engine: m.engine, db: m.db, strength: m.strength });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function anthropic(env, payload) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${data?.error?.message || "request failed"}`);
  return data;
}

async function safe(fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    return fallback !== undefined ? fallback : { status: "error", error: err.message || String(err) };
  }
}

function textOf(res) {
  return (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

export function parseJsonObject(s) {
  if (!s) return null;
  const cleaned = s.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function normUrl(u) {
  try {
    const x = new URL(u);
    const host = x.hostname.replace(/^www\./, "").toLowerCase();
    // drop tracking params, keep meaningful ones
    for (const k of [...x.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid|yclid|mc_|ref$|srsltid)/i.test(k)) x.searchParams.delete(k);
    }
    const qs = x.searchParams.toString();
    const path = x.pathname.replace(/\/+$/, "") || "";
    return `${host}${path}${qs ? "?" + qs : ""}`;
  } catch {
    return String(u || "").toLowerCase();
  }
}

export function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function stripHash(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    return x.toString();
  } catch {
    return u;
  }
}

function clip(s, n) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

// ---------------------------------------------------------------------------
// Key checks for the settings screen
// ---------------------------------------------------------------------------

export async function testAnthropicKey(key) {
  const r = await fetch("https://api.anthropic.com/v1/models?limit=1", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
  });
  if (r.ok) return { ok: true };
  const d = await r.json().catch(() => ({}));
  return { ok: false, error: d?.error?.message || `HTTP ${r.status}` };
}

export async function testSerankingKey(key) {
  const r = await fetch("https://api.seranking.com/v1/account/subscription", { headers: { Authorization: `Token ${key}` } });
  if (r.ok) return { ok: true, data: await r.json().catch(() => null) };
  const d = await r.json().catch(() => ({}));
  return { ok: false, error: d?.message || d?.error || `HTTP ${r.status}` };
}
