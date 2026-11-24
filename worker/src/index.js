// AI Visibility Checker — backend (Cloudflare Worker)
//
// GET /card?url=<page url>&source=<country>   header X-Client-Id: <random id per install>
//
// Builds a domain-level AI visibility card from the SE Ranking Data API (AI Search):
//   - page:        is this exact URL cited, per engine          (prompts-by-target, scope=url, limit=1)
//   - domain:      prompts citing the domain, per engine        (prompts-by-target, scope=base_domain, limit=1)
//                  prompts mentioning the brand, per engine     (discover-brand + prompts-by-brand, limit=1)
//   - topPrompts:  best citing prompt per engine                (comes with the domain calls above)
//   - competitors: 3 organic competitors, cited per engine      (domain/competitors + prompts-by-target, limit=1)
//
// Cost: prompts-by-* charge 200 credits per RETURNED prompt (limit=1 → max 200 per call, 0 if nothing found).
//       discover-brand and domain/competitors cost 100 each. Worst case ≈ 5,200 credits per new domain.
// Cache: results are kept in KV for 30 days (AI Search data is a monthly snapshot).
// Limits: per-client daily new-domain checks and a global daily credit budget protect the account.
//
// Secret:  SERANKING_API_KEY
// KV:      CACHE
// Vars:    DAILY_CREDIT_BUDGET, DOMAINS_PER_CLIENT_PER_DAY, PAGES_PER_CLIENT_PER_DAY

export const ENGINES = [
  { id: "ai-overview", label: "AIO" },
  { id: "ai-mode", label: "AI Mode" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "gemini", label: "Gemini" },
  { id: "perplexity", label: "Perplexity" },
];

const API = "https://api.seranking.com/v1";
const TTL = 30 * 24 * 3600;
const SOURCES = ["us", "uk", "gb", "ca", "au", "de", "fr", "es", "it", "nl", "br", "in", "ua", "pl"];

// Domains that show up as "organic competitors" for almost everyone and are useless as AI competitors
const GENERIC = new Set([
  "google.com", "youtube.com", "wikipedia.org", "reddit.com", "facebook.com", "instagram.com", "linkedin.com",
  "twitter.com", "x.com", "quora.com", "medium.com", "amazon.com", "pinterest.com", "tiktok.com", "apple.com",
  "microsoft.com", "github.com", "yelp.com", "indeed.com", "glassdoor.com", "forbes.com", "nytimes.com",
  "ebay.com", "walmart.com", "imdb.com", "tripadvisor.com", "wikihow.com", "britannica.com", "blogspot.com",
  "wordpress.com", "substack.com", "yahoo.com", "bing.com", "support.google.com", "play.google.com",
]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "X-Client-Id",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const u = new URL(request.url);

    if (u.pathname === "/health") return json({ ok: true, key: Boolean(env.SERANKING_API_KEY), kv: Boolean(env.CACHE) });
    if (u.pathname !== "/card" || request.method !== "GET") return json({ error: "Not found" }, 404);
    if (!env.SERANKING_API_KEY || !env.CACHE) return json({ error: "Backend is not configured yet" }, 500);

    const pageUrl = u.searchParams.get("url") || "";
    const source = (u.searchParams.get("source") || "us").toLowerCase();
    const clientId = (request.headers.get("X-Client-Id") || "").slice(0, 64);
    if (!/^https?:\/\//i.test(pageUrl)) return json({ error: "Open a regular web page (http/https)." }, 400);
    if (!SOURCES.includes(source)) return json({ error: `Unsupported market: ${source}` }, 400);
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(clientId)) return json({ error: "Missing client id" }, 400);

    try {
      return json(await buildCard(env, pageUrl, source, clientId));
    } catch (err) {
      const status = err.status || 500;
      return json({ error: err.message || String(err), code: err.code }, status);
    }
  },
};

// ---------------------------------------------------------------------------

export async function buildCard(env, pageUrl, source, clientId) {
  const host = hostOf(pageUrl);
  if (!host) throw httpError(400, "Can't read the site address.");
  const page = normPage(pageUrl);
  const meter = { credits: 0 };

  const domainKey = `domain:${source}:${host}`;
  const pageKey = `page:${source}:${page.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "")}`;

  let domain = await env.CACHE.get(domainKey, "json");
  let pageRes = await env.CACHE.get(pageKey, "json");
  const fromCache = { domain: Boolean(domain), page: Boolean(pageRes) };

  if (!domain) {
    await guard(env, clientId, "domains", Number(env.DOMAINS_PER_CLIENT_PER_DAY || 5), 5200);
    domain = await fetchDomain(env, host, source, meter);
    await env.CACHE.put(domainKey, JSON.stringify(domain), { expirationTtl: TTL });
  }

  if (!pageRes) {
    // Page checks only charge when the page IS cited, so they are cheap. Still capped per client.
    await guard(env, clientId, "pages", Number(env.PAGES_PER_CLIENT_PER_DAY || 100), 1000);
    pageRes = await fetchPage(env, page, pageUrl, source, meter);
    await env.CACHE.put(pageKey, JSON.stringify(pageRes), { expirationTtl: TTL });
  }

  if (meter.credits) await addSpent(env, meter.credits);

  return {
    host,
    source,
    url: pageUrl,
    engines: ENGINES,
    page: pageRes,
    ...domain,
    cache: fromCache,
    creditsSpent: meter.credits,
  };
}

async function fetchDomain(env, host, source, meter) {
  // Step 1: brand + competitors (independent)
  const [brandRes, compRes] = await Promise.all([
    seranking(env, "/ai-search/discover-brand", { target: host, source, scope: "base_domain" }, meter, 100).catch(() => null),
    seranking(env, "/domain/competitors", { domain: host, source, type: "organic" }, meter, 100).catch(() => null),
  ]);
  const brand = Array.isArray(brandRes?.brands) && brandRes.brands[0] ? String(brandRes.brands[0]) : null;
  const competitors = pickCompetitors(compRes, host, 3);

  // Step 2: per-engine calls
  const tasks = [];
  for (const e of ENGINES) {
    tasks.push(() => promptsBy(env, "target", { target: host, scope: "base_domain" }, e.id, source, meter).then((r) => ({ kind: "cited", e: e.id, r })));
    if (brand) tasks.push(() => promptsBy(env, "brand", { brand }, e.id, source, meter).then((r) => ({ kind: "mentioned", e: e.id, r })));
    for (const c of competitors) {
      tasks.push(() => promptsBy(env, "target", { target: c, scope: "base_domain" }, e.id, source, meter).then((r) => ({ kind: "comp", c, e: e.id, r })));
    }
  }
  const results = await pool(tasks, 5);

  const stats = {};
  const topPrompts = [];
  const comp = Object.fromEntries(competitors.map((c) => [c, {}]));
  let date = null;
  for (const { kind, e, c, r } of results) {
    date = date || r.date;
    if (kind === "cited") {
      stats[e] = { ...(stats[e] || {}), cited: r.ok ? r.total : null };
      if (r.ok && r.top) topPrompts.push({ engine: e, prompt: r.top });
    } else if (kind === "mentioned") {
      stats[e] = { ...(stats[e] || {}), mentioned: r.ok ? r.total : null };
    } else {
      comp[c][e] = r.ok ? r.total : null;
    }
  }
  for (const e of ENGINES) stats[e.id] = { cited: null, mentioned: brand ? null : undefined, ...stats[e.id] };

  return {
    brand,
    date,
    domain: stats,
    topPrompts: ENGINES.map((e) => topPrompts.find((t) => t.engine === e.id)).filter(Boolean),
    competitors: [
      { domain: host, isYou: true, engines: Object.fromEntries(ENGINES.map((e) => [e.id, stats[e.id].cited])) },
      ...competitors.map((c) => ({ domain: c, isYou: false, engines: comp[c] })),
    ],
    insight: buildInsight(stats, brand),
    checkedAt: new Date().toISOString(),
  };
}

async function fetchPage(env, page, pageUrl, source, meter) {
  const tasks = ENGINES.map((e) => () => promptsBy(env, "target", { target: page, scope: "url" }, e.id, source, meter).then((r) => [e.id, r]));
  const res = await pool(tasks, 5);
  return {
    url: page,
    engines: Object.fromEntries(res.map(([id, r]) => [id, r.ok ? { cited: r.total > 0, prompts: r.total, top: r.top } : { error: r.error }])),
    checkedAt: new Date().toISOString(),
  };
}

async function promptsBy(env, by, params, engine, source, meter) {
  try {
    const d = await seranking(env, `/ai-search/prompts-by-${by}`, { ...params, engine, source, limit: 1 }, meter, 0);
    const list = Array.isArray(d?.prompts) ? d.prompts : [];
    meter.credits += 200 * list.length;
    return { ok: true, total: Number(d?.total) || 0, top: list[0]?.prompt || null, date: d?.date || null };
  } catch (err) {
    return { ok: false, error: err.message, total: 0 };
  }
}

// ---------------------------------------------------------------------------
// SE Ranking client with one retry on 5xx / 429

async function seranking(env, path, params, meter, flatCost) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const url = `${API}${path}?${qs}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(url, { headers: { Authorization: `Token ${env.SERANKING_API_KEY}` } });
    if ((r.status >= 500 || r.status === 429) && attempt === 0) {
      await sleep(1200);
      continue;
    }
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const e = new Error(`SE Ranking ${r.status}: ${data?.message || data?.error || "request failed"}`);
      e.status = 502;
      throw e;
    }
    meter.credits += flatCost;
    return data;
  }
}

// ---------------------------------------------------------------------------
// Limits

async function guard(env, clientId, kind, perClient, worstCost) {
  const day = new Date().toISOString().slice(0, 10);
  const budget = Number(env.DAILY_CREDIT_BUDGET || 60000);
  const spent = Number((await env.CACHE.get(`spent:${day}`)) || 0);
  if (spent + worstCost > budget) {
    throw httpError(429, "Today's check limit is reached. Try again tomorrow.", "global_budget");
  }
  const key = `rl:${kind}:${day}:${clientId}`;
  const used = Number((await env.CACHE.get(key)) || 0);
  if (used >= perClient) {
    throw httpError(429, `You've reached today's limit of ${perClient} new ${kind === "domains" ? "sites" : "pages"}. Sites you've already checked still open.`, "client_limit");
  }
  await env.CACHE.put(key, String(used + 1), { expirationTtl: 2 * 24 * 3600 });
}

async function addSpent(env, credits) {
  const day = new Date().toISOString().slice(0, 10);
  const spent = Number((await env.CACHE.get(`spent:${day}`)) || 0);
  await env.CACHE.put(`spent:${day}`, String(spent + credits), { expirationTtl: 40 * 24 * 3600 });
}

// ---------------------------------------------------------------------------
// Helpers

export function pickCompetitors(list, host, n) {
  if (!Array.isArray(list)) return [];
  const base = baseOf(host);
  return list
    .filter((c) => c && typeof c.domain === "string")
    .map((c) => ({ ...c, d: c.domain.toLowerCase().replace(/^www\./, "") }))
    .filter((c) => baseOf(c.d) !== base && !GENERIC.has(c.d) && !GENERIC.has(baseOf(c.d)))
    .sort((a, b) => (b.common_keywords || 0) - (a.common_keywords || 0))
    .slice(0, n)
    .map((c) => c.d);
}

export function buildInsight(stats, brand) {
  const cited = sum(Object.values(stats).map((s) => s.cited));
  const mentioned = sum(Object.values(stats).map((s) => s.mentioned));
  if (!cited && !mentioned) return { kind: "invisible", cited, mentioned };
  if (!brand) return { kind: "no_brand", cited, mentioned };
  if (cited >= 3 * Math.max(1, mentioned)) return { kind: "cited_not_named", cited, mentioned, ratio: Math.round(cited / Math.max(1, mentioned)) };
  if (mentioned >= 3 * Math.max(1, cited)) return { kind: "named_not_cited", cited, mentioned, ratio: Math.round(mentioned / Math.max(1, cited)) };
  return { kind: "balanced", cited, mentioned };
}

async function pool(tasks, size) {
  const out = new Array(tasks.length);
  let i = 0;
  const worker = async () => {
    while (i < tasks.length) {
      const idx = i++;
      out[idx] = await tasks[idx]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, worker));
  return out;
}

export function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function baseOf(host) {
  const p = host.split(".");
  const twoPart = /^(co|com|org|net|gov|ac|edu)$/.test(p[p.length - 2] || "") && p.length > 2;
  return p.slice(twoPart ? -3 : -2).join(".");
}

export function normPage(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|gclid|fbclid|yclid|mc_|srsltid)/i.test(k)) x.searchParams.delete(k);
    return x.toString();
  } catch {
    return u;
  }
}

const sum = (a) => a.reduce((s, v) => s + (Number(v) || 0), 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });
}
