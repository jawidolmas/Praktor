// The mode names ("logon" / "boot") come from the daemon's own autostart
// vocabulary (@exec/db, via /api/daemon's autostartModes) rather than being
// hardcoded here, so this can never say something the CLI itself disagrees
// with about what a mode does.
function autostartOption(mode, explanation) {
  return `
    <div class="autostart-option">
      <code>exec-agent daemon install-autostart --mode ${escapeHtml(mode)}</code>
      <div class="hint">${escapeHtml(explanation)}</div>
    </div>`;
}

function renderDaemonStatus(data) {
  const el = document.getElementById("daemon-status");
  const runningBadge = data.running
    ? `<span class="badge status-running">running${data.pid ? ` (pid ${data.pid})` : ""}</span>`
    : `<span class="badge status-failed">not running</span>`;

  const auto = data.autostart;
  const modes = data.autostartModes || {};

  if (auto.installed) {
    const mode = auto.mode && modes[auto.mode] ? auto.mode : undefined;
    const autostartBadge = `<span class="badge status-done">autostart: ${escapeHtml(mode || "registered")}</span>`;
    const hint = mode ? `<div class="hint">${escapeHtml(modes[mode])}</div>` : "";
    el.innerHTML = `<div class="panel-body">${runningBadge} ${autostartBadge}${hint}</div>`;
    return;
  }

  // Not installed: don't just point at "--mode logon|boot" — that "|" reads
  // like a shell pipe to anyone who copies it into PowerShell (confirmed
  // live: it does exactly that, piping into a nonexistent "boot" command).
  // Show each mode as its own complete, copy-pasteable command instead.
  const autostartBadge = `<span class="badge status-failed">autostart: not installed</span>`;
  const options = Object.entries(modes)
    .map(([mode, explanation]) => autostartOption(mode, explanation))
    .join("");
  el.innerHTML = `
    <div class="panel-body">
      ${runningBadge} ${autostartBadge}
      <div class="hint">Won't come back after a reboot until one of these is set up — pick one:</div>
    </div>
    <div class="autostart-options">${options}</div>`;
}

// "Needs attention" is the default view on purpose: the whole point of a
// supervisor you can walk away from is coming back to "what needs me," not
// re-scanning a flat wall of everything it has ever run. draft/active/
// blocked/parked are all still in-progress in some sense — a draft objective
// hasn't even been planned yet, so it belongs here too, not in "done."
const ATTENTION_STATUSES = new Set(["draft", "active", "blocked", "parked"]);
const DONE_STATUSES = new Set(["done"]);
const FAILED_STATUSES = new Set(["failed", "cancelled"]);

let allObjectives = [];
let currentFilter = "attention";
let currentSearch = "";

function repoName(repoPath) {
  return repoPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || repoPath;
}

function matchesFilter(o, filter) {
  if (filter === "all") return true;
  if (filter === "attention") return ATTENTION_STATUSES.has(o.status);
  if (filter === "done") return DONE_STATUSES.has(o.status);
  if (filter === "failed") return FAILED_STATUSES.has(o.status);
  return true;
}

function renderSummary(rows) {
  const el = document.getElementById("objective-summary");
  const attention = rows.filter((o) => ATTENTION_STATUSES.has(o.status)).length;
  const done = rows.filter((o) => DONE_STATUSES.has(o.status)).length;
  const failed = rows.filter((o) => FAILED_STATUSES.has(o.status)).length;
  el.innerHTML = `
    <span class="badge status-active">${rows.length} total</span>
    ${attention ? `<span class="badge status-blocked">${attention} needs attention</span>` : ""}
    ${done ? `<span class="badge status-done">${done} done</span>` : ""}
    ${failed ? `<span class="badge status-failed">${failed} failed</span>` : ""}
  `;
}

function renderObjectives() {
  renderSummary(allObjectives);

  const search = currentSearch.trim().toLowerCase();
  const rows = allObjectives
    .filter((o) => matchesFilter(o, currentFilter))
    .filter((o) => !search || o.title.toLowerCase().includes(search) || o.repoPath.toLowerCase().includes(search))
    .sort((a, b) => (b.lastEventAt ?? b.updatedAt) - (a.lastEventAt ?? a.updatedAt));

  const el = document.getElementById("objectives");
  if (allObjectives.length === 0) {
    el.innerHTML = '<div class="empty">No objectives yet. Run <code>exec-agent do "…"</code> to start one.</div>';
    return;
  }
  if (rows.length === 0) {
    el.innerHTML =
      currentFilter === "attention" && !search
        ? '<div class="empty">Nothing needs you right now — everything is done, failed, or not yet started. Switch to “All” to see the full history.</div>'
        : '<div class="empty">Nothing matches. Try a different filter or clear the search.</div>';
    return;
  }
  el.innerHTML = `
    <table>
      <thead><tr><th>Title</th><th>Status</th><th>Repo</th><th>Tasks</th><th>Last activity</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (o) => `
          <tr class="row-link" onclick="location.href='/objective.html?id=${encodeURIComponent(o.id)}'">
            <td>${escapeHtml(o.title)}</td>
            <td>${badge(o.status)}</td>
            <td class="mono muted" title="${escapeHtml(o.repoPath)}">${escapeHtml(repoName(o.repoPath))}</td>
            <td>${o.doneTaskCount}/${o.taskCount}</td>
            <td class="muted">${timeAgo(o.lastEventAt ?? o.updatedAt)}</td>
          </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

document.getElementById("statusFilter").addEventListener("click", (e) => {
  const btn = e.target.closest(".filter-tab");
  if (!btn) return;
  currentFilter = btn.dataset.filter;
  for (const tab of document.querySelectorAll(".filter-tab")) tab.classList.toggle("active", tab === btn);
  renderObjectives();
});

document.getElementById("objectiveSearch").addEventListener("input", (e) => {
  currentSearch = e.target.value;
  renderObjectives();
});

// This panel polls every few seconds; rebuilding it unconditionally would
// wipe out an in-progress "answered by" field the moment someone started
// typing into it. Only touch the DOM when the open decisions actually changed.
let lastDecisionsKey;

function renderDecisions(rows) {
  const key = JSON.stringify(rows);
  if (key === lastDecisionsKey) return;
  lastDecisionsKey = key;

  // Hidden entirely when there's nothing open, rather than a permanent
  // "Nothing open" panel taking up space above the thing you actually came
  // to look at — this is the most time-sensitive panel on the page (someone,
  // somewhere, is blocked on you), so it only shows up when that's true.
  document.getElementById("decisionsPanel").hidden = rows.length === 0;
  const el = document.getElementById("decisions");
  el.innerHTML = rows.map((d) => renderDecisionCard(d, { showObjectiveLink: true })).join("");
}

function renderPolicies(rows) {
  const el = document.getElementById("policies");
  if (rows.length === 0) {
    el.innerHTML = '<div class="empty">No policies loaded.</div>';
    return;
  }
  el.innerHTML = `
    <table>
      <thead><tr><th>Key</th><th>Title</th><th>Severity</th><th>Action</th><th>Scope</th><th></th></tr></thead>
      <tbody>
        ${rows
          .map(
            (p) => `
          <tr>
            <td class="mono">${escapeHtml(p.key)}</td>
            <td>${escapeHtml(p.title)}</td>
            <td>${escapeHtml(p.severity)}</td>
            <td>${escapeHtml(p.action)}</td>
            <td class="muted">${escapeHtml(p.scope)}</td>
            <td>${p.enabled ? "" : '<span class="badge status-cancelled">disabled</span>'}</td>
          </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

function renderProfile(rows) {
  const el = document.getElementById("profile");
  if (rows.length === 0) {
    el.innerHTML =
      '<div class="empty">No engineering profile set yet. Add one with ' +
      '<code>exec-agent profile set --title "Architecture" --value "Prefer simple systems."</code></div>';
    return;
  }
  el.innerHTML = rows
    .map(
      (entry) => `
    <div class="profile-entry">
      <div class="profile-title">${escapeHtml(entry.title)}</div>
      <div class="profile-content">${escapeHtml(entry.content)}</div>
    </div>`,
    )
    .join("");
}

async function refresh() {
  const [daemon, objectives, decisions, policies, profile] = await Promise.all([
    fetchJSON("/api/daemon"),
    fetchJSON("/api/objectives"),
    fetchJSON("/api/decisions"),
    fetchJSON("/api/policies"),
    fetchJSON("/api/profile"),
  ]);
  renderDaemonStatus(daemon);
  allObjectives = objectives;
  renderObjectives();
  renderDecisions(decisions);
  renderPolicies(policies);
  renderProfile(profile);
}

function tickClock() {
  document.getElementById("clock").textContent = new Date().toLocaleTimeString();
}

tickClock();
setInterval(tickClock, 1000);
refresh().catch((err) => console.error(err));
setInterval(() => refresh().catch((err) => console.error(err)), 3000);
window.addEventListener("decision-answered", () => refresh().catch((err) => console.error(err)));
