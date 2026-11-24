import { WORKER_URL } from "./config.js";

const $ = (id) => document.getElementById(id);
const LOCAL_TTL = 30 * 24 * 3600 * 1000;

let clientId = null;
let source = "us";
let currentTab = null;
let busy = false;

// ---------------------------------------------------------------- init
async function init() {
  const s = await chrome.storage.local.get(["clientId", "source"]);
  clientId = s.clientId || crypto.randomUUID();
  if (!s.clientId) await chrome.storage.local.set({ clientId });
  source = s.source || "us";
  $("source").value = source;
  await refreshTab();
}

$("source").onchange = async () => {
  source = $("source").value;
  await chrome.storage.local.set({ source });
  await refreshTab();
};

chrome.tabs.onActivated.addListener(() => refreshTab());
chrome.tabs.onUpdated.addListener((_, info) => info.status === "complete" && refreshTab());

async function refreshTab() {
  if (busy) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  $("status").classList.add("hidden");
  if (!tab?.url || !/^https?:/.test(tab.url)) {
    $("host").textContent = "AI Visibility Checker";
    $("path").textContent = "Open any website to check it.";
    $("run").disabled = true;
    $("results").innerHTML = "";
    return;
  }
  const u = new URL(tab.url);
  $("host").textContent = u.hostname.replace(/^www\./, "");
  $("path").textContent = u.pathname === "/" ? "Homepage" : u.pathname;
  $("run").disabled = false;

  const saved = await getLocal(tab.url);
  if (saved) {
    render(saved);
    $("run").textContent = "Refresh";
  } else {
    $("results").innerHTML = "";
    $("run").textContent = "Check this site";
  }
}

// ---------------------------------------------------------------- run
$("run").onclick = async () => {
  if (!currentTab?.url || busy) return;
  if (WORKER_URL.startsWith("__")) return setStatus("This build has no backend address. Download the extension from the Releases page.", true);
  busy = true;
  $("run").disabled = true;
  const started = Date.now();
  const tick = () => setStatus(`<span class="spinner"></span>Collecting AI answers from SE Ranking… <span class="muted">${Math.round((Date.now() - started) / 1000)} s</span>`);
  tick();
  const timer = setInterval(tick, 1000);
  try {
    const qs = new URLSearchParams({ url: currentTab.url, source });
    const r = await fetch(`${WORKER_URL}/card?${qs}`, { headers: { "X-Client-Id": clientId } });
    const data = await r.json().catch(() => ({ error: `Server error ${r.status}` }));
    if (!r.ok || data.error) throw new Error(data.error || `Server error ${r.status}`);
    await setLocal(currentTab.url, data);
    $("status").classList.add("hidden");
    render(data);
    $("run").textContent = "Refresh";
  } catch (e) {
    setStatus(esc(e.message), true);
  } finally {
    clearInterval(timer);
    busy = false;
    $("run").disabled = false;
  }
};

function setStatus(html, isError = false) {
  const el = $("status");
  el.classList.remove("hidden");
  el.classList.toggle("error", isError);
  el.innerHTML = html;
}

// ---------------------------------------------------------------- local cache (per page + market)
const localKey = (url) => {
  const u = new URL(url);
  u.hash = "";
  return `card:${source}:${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}${u.search}`;
};
async function getLocal(url) {
  const k = localKey(url);
  const { [k]: e } = await chrome.storage.local.get(k);
  return e && Date.now() - e.at < LOCAL_TTL ? e.data : null;
}
async function setLocal(url, data) {
  await chrome.storage.local.set({ [localKey(url)]: { at: Date.now(), data } });
}

// ---------------------------------------------------------------- render
export function render(d) {
  const E = d.engines;
  const cols = `grid-template-columns: 74px repeat(${E.length}, minmax(0, 1fr))`;
  let html = "";

  // 1. This page
  html += `<section class="card">
    <div class="sec">This page in AI answers <span>${monthOf(d.date)}</span></div>
    <div class="grid" style="grid-template-columns: repeat(${E.length}, minmax(0, 1fr))">
      ${E.map((e) => {
        const p = d.page.engines[e.id] || {};
        const cls = p.error ? "err" : p.cited ? "yes" : "no";
        const mark = p.error ? "?" : p.cited ? "✓" : "✕";
        const title = p.error ? "Couldn't check" : p.cited ? `Cited in ${p.prompts} prompt${p.prompts === 1 ? "" : "s"}${p.top ? `, e.g. “${p.top}”` : ""}` : "Not cited in this engine";
        return `<div class="cell page-cell ${cls}" title="${esc(title)}"><div class="eng">${esc(e.label)}</div><div class="mark">${mark}</div></div>`;
      }).join("")}
    </div>
  </section>`;

  // 2. Domain per engine
  const hasBrand = Boolean(d.brand);
  html += `<section class="card">
    <div class="sec">${esc(d.host)} in AI answers <span>prompts per engine</span></div>
    <div class="grid" style="${cols}">
      <div></div>${E.map((e) => `<div class="cell head">${esc(e.label)}</div>`).join("")}
      <div class="cell lbl" title="AI answers that link to this site">Cited</div>
      ${E.map((e) => `<div class="cell cited-bg">${num(d.domain[e.id]?.cited)}</div>`).join("")}
      ${hasBrand ? `<div class="cell lbl" title="AI answers that name ${esc(d.brand)}">Mentioned</div>
      ${E.map((e) => `<div class="cell ment-bg">${num(d.domain[e.id]?.mentioned)}</div>`).join("")}` : ""}
    </div>
    ${hasBrand ? `<div class="muted small" style="margin-top:6px">Brand detected as “${esc(d.brand)}”.</div>` : ""}
  </section>`;

  // 3. Insight
  html += insight(d);

  // 4. Competitors
  if (d.competitors.length > 1) {
    const max = E.map((e) => Math.max(1, ...d.competitors.map((c) => Number(c.engines[e.id]) || 0)));
    html += `<section class="card">
      <div class="sec">Competitors · cited <span>darker = more within engine</span></div>
      <div class="grid" style="grid-template-columns: 90px repeat(${E.length}, minmax(0, 1fr))">
        <div></div>${E.map((e) => `<div class="cell head">${esc(e.label)}</div>`).join("")}
        ${d.competitors.map((c) => `
          <div class="cell lbl ${c.isYou ? "you" : "dom"}" title="${esc(c.domain)}">${esc(c.domain)}</div>
          ${E.map((e, i) => {
            const v = c.engines[e.id];
            const a = v == null ? 0 : 0.1 + 0.8 * (Number(v) / max[i]);
            return `<div class="cell" style="background: rgba(42,120,214,${a.toFixed(2)}); color: ${a > 0.55 ? "#fff" : "inherit"}">${num(v)}</div>`;
          }).join("")}`).join("")}
      </div>
      <div class="muted small" style="margin-top:6px">Competitors are the site's top organic rivals in ${esc(d.source.toUpperCase())}.</div>
    </section>`;
  }

  // 5. Top prompts
  html += `<section class="card"><div class="sec">Top prompt per engine</div>
    ${d.topPrompts.length
      ? d.topPrompts.map((t) => `<div class="prompt"><span>${esc(t.prompt)}</span><span class="tag">${esc(labelOf(E, t.engine))}</span></div>`).join("")
      : `<div class="empty">No prompts in SE Ranking's sample cite this site yet.</div>`}
  </section>`;

  html += `<div class="muted small">${d.cache?.domain ? "Site data from cache" : "Fresh site data"} · checked ${new Date(d.checkedAt || Date.now()).toLocaleDateString()}</div>`;
  $("results").innerHTML = html;
}

function insight(d) {
  const i = d.insight || {};
  const box = (t, p) => `<div class="insight"><b>${t}</b><p>${p}</p></div>`;
  switch (i.kind) {
    case "cited_not_named":
      return box(`Cited ${i.ratio}x more than named`, `AI answers link to ${esc(d.host)} ${num(i.cited)} times but name ${esc(d.brand)} only ${num(i.mentioned)} times.`);
    case "named_not_cited":
      return box(`Named ${i.ratio}x more than cited`, `AI knows ${esc(d.brand)} but rarely uses ${esc(d.host)} as a source.`);
    case "invisible":
      return box("Not visible in AI answers yet", `No prompts in SE Ranking's sample cite or name this site in ${esc(d.source.toUpperCase())}.`);
    default:
      return "";
  }
}

// ---------------------------------------------------------------- utils
function num(v) {
  if (v == null) return "–";
  v = Number(v);
  if (v >= 10000) return Math.round(v / 1000) + "k";
  if (v >= 1000) return (Math.round(v / 100) / 10) + "k";
  return String(v);
}
const labelOf = (E, id) => E.find((e) => e.id === id)?.label || id;
const monthOf = (date) => (date ? new Date(date + "T00:00:00Z").toLocaleDateString("en", { month: "short", year: "numeric", timeZone: "UTC" }) : "");
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

init();
