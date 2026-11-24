import { analyze, normUrl, testAnthropicKey, testSerankingKey } from "./lib/analyze.js";

const $ = (id) => document.getElementById(id);

const STATUS = {
  cited: { icon: "✓", label: "Page cited" },
  retrieved: { icon: "◐", label: "Found by search, not cited" },
  domain: { icon: "≈", label: "Another page of the site cited" },
  not_found: { icon: "–", label: "Not found" },
  error: { icon: "!", label: "Check failed" },
};

const TYPE_LABELS = {
  informational: "informational",
  "how-to": "how-to",
  comparison: "comparison",
  "best-for": "best for",
  problem: "problem",
};

let settings = { anthropicKey: "", serankingKey: "", country: "us", serLimit: 10, model: "claude-sonnet-5-5" };
const SETTING_KEYS = Object.keys(settings);

// ---------------------------------------------------------------- settings
async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTING_KEYS);
  settings = { ...settings, ...stored };
  $("anthropicKey").value = settings.anthropicKey;
  $("serankingKey").value = settings.serankingKey;
  $("country").value = settings.country;
  $("serLimit").value = settings.serLimit;
  $("model").value = settings.model;
  if (!hasKeys()) {
    $("settings").classList.remove("hidden");
    $("welcome").classList.remove("hidden");
  }
}

const hasKeys = () => Boolean(settings.anthropicKey && settings.serankingKey);

$("toggleSettings").onclick = () => $("settings").classList.toggle("hidden");

$("saveSettings").onclick = async () => {
  settings.anthropicKey = $("anthropicKey").value.trim();
  settings.serankingKey = $("serankingKey").value.trim();
  settings.country = $("country").value;
  settings.serLimit = Math.min(100, Math.max(1, parseInt($("serLimit").value, 10) || 10));
  settings.model = $("model").value.trim() || "claude-sonnet-5-5";
  await chrome.storage.local.set(settings);

  const msg = $("settingsMsg");
  if (!hasKeys()) {
    msg.innerHTML = `<span class="bad">Both keys are required.</span>`;
    return;
  }
  msg.innerHTML = `<span class="spinner"></span>Checking keys…`;
  const [a, s] = await Promise.all([
    testAnthropicKey(settings.anthropicKey).catch((e) => ({ ok: false, error: e.message })),
    testSerankingKey(settings.serankingKey).catch((e) => ({ ok: false, error: e.message })),
  ]);
  msg.innerHTML = [
    a.ok ? `<span class="ok">✓ Anthropic key works</span>` : `<span class="bad">✗ Anthropic: ${esc(a.error)}</span>`,
    s.ok ? `<span class="ok">✓ SE Ranking key works</span>` : `<span class="bad">✗ SE Ranking: ${esc(s.error)}</span>`,
  ].join("<br>");
  if (a.ok && s.ok) {
    $("welcome").classList.add("hidden");
    setTimeout(() => $("settings").classList.add("hidden"), 1500);
  }
};

// ---------------------------------------------------------------- cache (per URL + country, kept 7 days)
const CACHE_TTL = 7 * 24 * 3600 * 1000;
const cacheKey = (url, country) => `cache:${country}:${normUrl(url)}`;

async function getCached(url, country) {
  const k = cacheKey(url, country);
  const { [k]: entry } = await chrome.storage.local.get(k);
  if (!entry || Date.now() - entry.at > CACHE_TTL) return null;
  return entry;
}

async function setCached(url, country, data) {
  await chrome.storage.local.set({ [cacheKey(url, country)]: { at: Date.now(), data } });
}

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

// ---------------------------------------------------------------- page extraction (runs inside the tab)
function extractPage() {
  const meta = (sel) => document.querySelector(sel)?.getAttribute("content") || "";
  const headings = [...document.querySelectorAll("h1, h2, h3")]
    .map((h) => `${h.tagName}: ${(h.innerText || "").replace(/\s+/g, " ").trim()}`)
    .filter((h) => h.length > 4)
    .slice(0, 40);
  const root = document.querySelector("article") || document.querySelector("main, [role=main]") || document.body;
  const clone = root.cloneNode(true);
  clone.querySelectorAll("script, style, noscript, nav, footer, header, aside, form, svg, iframe, button").forEach((n) => n.remove());
  const text = (clone.textContent || "").replace(/\s+/g, " ").trim().slice(0, 12000);
  const url = new URL(location.href);
  url.hash = "";
  return {
    url: url.toString(),
    canonical: document.querySelector('link[rel="canonical"]')?.href || "",
    title: document.title,
    description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
    headings,
    text,
    lang: document.documentElement.lang || "",
  };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function readPage() {
  const tab = await getActiveTab();
  if (!tab || !/^https?:/.test(tab.url || "")) throw new Error("Open a regular web page (http/https).");
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPage });
  return result;
}

async function showPageInfo() {
  try {
    const tab = await getActiveTab();
    if (tab?.url && /^https?:/.test(tab.url)) {
      $("pageInfo").innerHTML = `<b>${esc(tab.title || "")}</b><span>${esc(tab.url)}</span>`;
      if ($("run").disabled) return;
      const cached = await getCached(tab.url, settings.country);
      $("status").classList.add("hidden");
      if (cached) {
        render(cached.data);
        $("cacheInfo").textContent = `Showing a saved result from ${ago(cached.at)}. Click the button to check again.`;
        $("cacheInfo").classList.remove("hidden");
        $("run").textContent = "Check again";
      } else {
        $("results").innerHTML = "";
        $("cacheInfo").classList.add("hidden");
        $("run").textContent = "Check this page";
      }
    }
  } catch {}
}

// ---------------------------------------------------------------- run
let timer = null;

$("run").onclick = async () => {
  if (!hasKeys()) {
    $("settings").classList.remove("hidden");
    $("welcome").classList.remove("hidden");
    return setStatus("Add your API keys in settings first.", true);
  }
  $("run").disabled = true;
  $("results").innerHTML = "";
  $("cacheInfo").classList.add("hidden");
  const started = Date.now();
  const stages = [
    [0, "Reading page content…"],
    [2, "Claude is writing 5 prompts, SE Ranking is looking up where the page is already cited…"],
    [10, "Running each prompt in Claude with web search…"],
    [30, "Matching prompts with real prompts from the database…"],
  ];
  const tick = () => {
    const s = (Date.now() - started) / 1000;
    const stage = stages.filter(([t]) => s >= t).pop()[1];
    setStatus(`<span class="spinner"></span>${stage} <span class="muted">${Math.round(s)} s</span>`);
  };
  tick();
  timer = setInterval(tick, 1000);

  try {
    const page = await readPage();
    const data = await analyze(
      {
        ANTHROPIC_API_KEY: settings.anthropicKey,
        SERANKING_API_KEY: settings.serankingKey,
        GEN_MODEL: settings.model,
        CHECK_MODEL: settings.model,
        SER_LIMIT: settings.serLimit,
      },
      { ...page, country: settings.country }
    );
    await setCached(page.url, settings.country, data);
    clearInterval(timer);
    $("status").classList.add("hidden");
    render(data);
    $("run").textContent = "Check again";
  } catch (e) {
    clearInterval(timer);
    setStatus(`Error: ${esc(e.message)}`, true);
  } finally {
    $("run").disabled = false;
  }
};

function setStatus(html, isError = false) {
  const el = $("status");
  el.classList.remove("hidden");
  el.classList.toggle("error", isError);
  el.innerHTML = html;
}

// ---------------------------------------------------------------- render
function render(data) {
  const engines = data.engines;
  const prompts = data.prompts;

  const foundAnywhere = prompts.filter((p) => engines.some((e) => p.results[e.id]?.status === "cited")).length;
  const cells = prompts.flatMap((p) => engines.map((e) => p.results[e.id]?.status));
  const citedCells = cells.filter((s) => s === "cited").length;
  const checkedCells = cells.filter((s) => s && s !== "error").length;
  const dbTotal = data.database.reduce((s, d) => s + (d.ok ? d.total : 0), 0);

  let html = `
    <section class="card">
      <div class="muted" style="margin-bottom:8px">Topic: <b style="color:var(--text)">${esc(data.topic || "")}</b></div>
      <div class="summary">
        <div class="stat"><b>${foundAnywhere}/${prompts.length}</b><span>prompts where the page was found</span></div>
        <div class="stat"><b>${checkedCells ? Math.round((citedCells / checkedCells) * 100) : 0}%</b><span>of checks with a citation</span></div>
        <div class="stat"><b>${dbTotal}</b><span>real prompts in the database cite this URL</span></div>
      </div>
    </section>

    <section class="card">
      <h2 style="margin-top:0">Generated prompts × AI engines</h2>
      <table class="matrix">
        <thead><tr><th class="p">Prompt</th>${engines
          .map((e) => `<th title="${e.mode === "live" ? "Live check" : "SE Ranking database"}">${esc(e.label)}${e.mode === "live" ? "<br>live" : ""}</th>`)
          .join("")}</tr></thead>
        <tbody>
          ${prompts
            .map(
              (p, i) => `
            <tr data-i="${i}">
              <td class="p"><span class="type">${esc(TYPE_LABELS[p.type] || p.type)}</span>${esc(p.text)}</td>
              ${engines.map((e) => cell(p.results[e.id])).join("")}
            </tr>
            <tr class="details hidden" id="d${i}"><td colspan="${engines.length + 1}">${details(p, engines)}</td></tr>`
            )
            .join("")}
        </tbody>
      </table>
      <div class="legend">${Object.entries(STATUS)
        .map(([k, v]) => `<span><span class="dot s-${k}">${v.icon}</span>${v.label}</span>`)
        .join("")}</div>
      <p class="foot">Click a prompt to see details. Claude is checked live with web search. Other engines use the SE Ranking database: a prompt counts as found when the database has a prompt with the same intent whose AI answer cites this URL.</p>
    </section>

    <section class="card">
      <h2 style="margin-top:0">Real prompts where this page is already cited</h2>
      ${data.database.map(dbBlock).join("")}
    </section>

    <p class="foot">Database country: ${esc(data.country.toUpperCase())} · SE Ranking returned ${data.usage.serankingPromptsReturned} prompts (≈${data.usage.serankingCreditsEstimate.toLocaleString()} credits) · ${Math.round(data.usage.tookMs / 1000)} s</p>
  `;

  $("results").innerHTML = html;
  $("results").querySelectorAll("tr[data-i]").forEach((tr) => {
    tr.onclick = () => $("d" + tr.dataset.i).classList.toggle("hidden");
  });
}

function cell(r) {
  const s = r?.status || "error";
  const meta = STATUS[s] || STATUS.error;
  let title = meta.label;
  if (r?.strength) title += r.strength === "strong" ? " (same query)" : " (similar intent)";
  if (r?.error) title += `: ${r.error}`;
  return `<td><span class="dot s-${s}" title="${esc(title)}">${meta.icon}</span></td>`;
}

function details(p, engines) {
  return engines
    .map((e) => {
      const r = p.results[e.id] || {};
      const meta = STATUS[r.status] || STATUS.error;
      let body = "";
      if (r.error) body = esc(r.error);
      else if (e.mode === "live") {
        if (r.status === "domain") body = `Cited instead: ${esc(r.domainUrl)}<br>`;
        if (r.status === "not_found" && r.topSources?.length) body = `Cites instead: ${r.topSources.map(esc).join(", ")}<br>`;
        body += r.answerSnippet ? `“${esc(r.answerSnippet)}”` : "";
      } else if (r.status === "cited") {
        body = `${r.strength === "strong" ? "Same query" : "Similar intent"}: “${esc(r.matchedPrompt)}”`;
      } else if (r.status === "not_found") {
        body = r.citedPromptsForUrl ? `The database has ${r.citedPromptsForUrl} other prompts citing this URL, but none with this intent.` : "The database has no prompts citing this URL.";
      }
      return `<div class="detail-item"><b>${esc(e.label)} · ${meta.label}</b><p>${body}</p></div>`;
    })
    .join("");
}

function dbBlock(d) {
  if (!d.ok) return `<div class="engine-block"><h3>${esc(d.label)} <span class="muted">error</span></h3><p class="muted">${esc(d.error)}</p></div>`;
  if (!d.prompts.length) return `<div class="engine-block"><h3>${esc(d.label)} <span class="muted">0</span></h3></div>`;
  return `<div class="engine-block"><h3>${esc(d.label)} <span class="muted">${d.total}${d.total > d.prompts.length ? ` (showing ${d.prompts.length})` : ""}</span></h3>
    <ul>${d.prompts.map((p) => `<li>${esc(p.prompt)}${p.volume ? ` <span class="muted">· ${p.volume}</span>` : ""}</li>`).join("")}</ul></div>`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------- init
await loadSettings();
showPageInfo();
chrome.tabs.onActivated.addListener(showPageInfo);
chrome.tabs.onUpdated.addListener((_, info) => info.status === "complete" && showPageInfo());
