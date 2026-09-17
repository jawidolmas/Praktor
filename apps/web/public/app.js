async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function timeAgo(ts) {
  if (!ts) return "-";
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function badge(status) {
  return `<span class="badge status-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

function formatUsd(n) {
  if (n === undefined || n === null || Number.isNaN(n)) return "–";
  if (n === 0) return "$0.00";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function formatTokens(n) {
  if (n === undefined || n === null) return "–";
  return `${Math.round(n).toLocaleString()} tok`;
}

function modelBadge(model) {
  if (!model) return "";
  return `<span class="model-badge mono">${escapeHtml(model)}</span>`;
}

// `answeredBy` is a free-text, convention-based field written by whichever
// channel actually recorded the answer (telegram-bridge.ts writes
// "telegram:<user>", the CLI writes "cli-operator" or a --by override,
// apps/cli/src/decide.ts writes "terminal-operator", the dashboard defaults
// to "dashboard") — there's no structured column for it, so this is the one
// place that convention gets turned into something a person can scan at a
// glance instead of reading a raw string.
function channelInfo(answeredBy) {
  const s = (answeredBy || "").trim();
  if (!s) return { label: "Unanswered", cls: "channel-none" };
  if (s.startsWith("telegram:")) return { label: "Telegram", detail: s.slice("telegram:".length), cls: "channel-telegram" };
  if (s === "cli-operator") return { label: "CLI", detail: "", cls: "channel-cli" };
  if (s.startsWith("cli")) return { label: "CLI", detail: s, cls: "channel-cli" };
  if (s === "terminal-operator") return { label: "Terminal", detail: "", cls: "channel-terminal" };
  if (s === "dashboard") return { label: "Dashboard", detail: "", cls: "channel-dashboard" };
  return { label: "Human", detail: s, cls: "channel-other" };
}

function channelBadge(answeredBy) {
  const info = channelInfo(answeredBy);
  const detail = info.detail ? ` <span class="channel-detail mono">${escapeHtml(info.detail)}</span>` : "";
  return `<span class="channel-badge ${info.cls}">${escapeHtml(info.label)}</span>${detail}`;
}

// Persisted per-viewer only (localStorage never reaches the server or other
// tabs) — purely "remember which tab I was looking at" convenience.
function initTabs() {
  const bar = document.getElementById("tabbar");
  if (!bar) return;
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab-btn");
    if (!btn) return;
    activateTab(btn.dataset.tab);
    history.replaceState(null, "", `#${btn.dataset.tab}`);
    try {
      localStorage.setItem("praktor-tab", btn.dataset.tab);
    } catch {
      /* private window / blocked storage — tab still switches, just isn't remembered */
    }
  });
  // The hash wins over the remembered tab — it's what makes a tab
  // deep-linkable (share a URL straight to "#decisions") rather than only
  // reachable by clicking, and it's what a headless check can drive without
  // simulating a click.
  let initial = location.hash.replace(/^#/, "") || "overview";
  if (!document.querySelector(`.tab-btn[data-tab="${initial}"]`)) {
    try {
      initial = localStorage.getItem("praktor-tab") || "overview";
    } catch {
      initial = "overview";
    }
  }
  activateTab(document.querySelector(`.tab-btn[data-tab="${initial}"]`) ? initial : "overview");
}

function activateTab(tab) {
  const bar = document.getElementById("tabbar");
  if (!bar) return;
  for (const b of bar.querySelectorAll(".tab-btn")) b.classList.toggle("active", b.dataset.tab === tab);
  for (const page of document.querySelectorAll(".tab-page")) page.hidden = page.dataset.tab !== tab;
}

initTabs();

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body — treated as {} */
  }
  return { ok: res.ok, status: res.status, data };
}

async function answerDecisionOption(key, optionId) {
  const byInput = document.getElementById(`by-${key}`);
  const answeredBy = (byInput && byInput.value.trim()) || "dashboard";
  const { ok, data } = await postJSON(`/api/decisions/${encodeURIComponent(key)}/answer`, {
    answer: optionId,
    answeredBy,
  });
  if (!ok) {
    alert(data.error || "Could not record that answer — it may already have been answered elsewhere.");
  }
  window.dispatchEvent(new CustomEvent("decision-answered"));
}

// Buttons are rendered with data-key/data-option (never inline onclick) so an
// option id coming from a worker's own decision request — arbitrary string,
// not restricted to safe characters — can never break out of a JS-string
// context the way interpolating it into an onclick="..." attribute could.
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".option-btn");
  if (!btn) return;
  answerDecisionOption(btn.dataset.key, btn.dataset.option);
});

function renderDecisionCard(d, options) {
  const opts = options || {};
  const isOpen = d.status === undefined || d.status === "open";
  const decisionOptions = d.options || [];
  const objectiveLink = opts.showObjectiveLink
    ? ` · <a href="/objective.html?id=${encodeURIComponent(d.objectiveId)}">${escapeHtml(d.objectiveTitle || d.objectiveId)}</a>`
    : "";

  const body = isOpen
    ? `
      ${d.context ? `<div class="decision-context">${escapeHtml(d.context)}</div>` : ""}
      <div class="decision-options">
        ${decisionOptions
          .map((o) => {
            const recommended = o.id === d.recommendation;
            return `
          <div class="decision-option">
            <button class="option-btn${recommended ? " recommended" : ""}" data-key="${escapeHtml(d.key)}" data-option="${escapeHtml(o.id)}">
              [${escapeHtml(o.id)}] ${escapeHtml(o.label)}${recommended ? " — recommended" : ""}
            </button>
            ${(o.pros || []).map((p) => `<div class="pro">+ ${escapeHtml(p)}</div>`).join("")}
            ${(o.cons || []).map((c) => `<div class="con">- ${escapeHtml(c)}</div>`).join("")}
          </div>`;
          })
          .join("")}
      </div>
      <div class="decision-answer-row">
        <input type="text" id="by-${escapeHtml(d.key)}" class="by-input" placeholder="answered by (optional)" />
      </div>`
    : `
      <div class="decision-context">
        Answered "${escapeHtml(d.answer ?? "")}" by ${channelBadge(d.answeredBy)}
        ${d.answeredAt ? `<span class="muted">${timeAgo(d.answeredAt)}</span>` : ""}
      </div>
      ${d.rationale ? `<div class="decision-context muted">${escapeHtml(d.rationale)}</div>` : ""}`;

  return `
    <div class="decision-card">
      <div class="title">${escapeHtml(d.key)} — ${escapeHtml(d.title)} ${isOpen ? badge("open") : badge(d.status)}</div>
      <div class="meta">${escapeHtml(d.level)} · risk ${escapeHtml(d.risk)}${objectiveLink} · ${timeAgo(d.createdAt)}</div>
      ${body}
    </div>`;
}
