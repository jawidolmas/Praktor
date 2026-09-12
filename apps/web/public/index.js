function renderDaemonStatus(data) {
  const el = document.getElementById("daemon-status");
  const runningBadge = data.running
    ? `<span class="badge status-running">running${data.pid ? ` (pid ${data.pid})` : ""}</span>`
    : `<span class="badge status-failed">not running</span>`;

  const auto = data.autostart;
  const autostartBadge = auto.installed
    ? `<span class="badge status-done">autostart: ${escapeHtml(auto.mode || "registered")}</span>`
    : `<span class="badge status-failed">autostart: not installed</span>`;

  const hint = auto.installed
    ? ""
    : `<div class="muted">Won't come back after a reboot. Set it up with: <code>exec-agent daemon install-autostart --mode logon|boot</code></div>`;

  el.innerHTML = `<div>${runningBadge} ${autostartBadge}</div>${hint}`;
}

function renderObjectives(rows) {
  const el = document.getElementById("objectives");
  if (rows.length === 0) {
    el.innerHTML = '<div class="empty">No objectives yet. Run <code>exec-agent do "…"</code> to start one.</div>';
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
            <td class="mono muted">${escapeHtml(o.repoPath)}</td>
            <td>${o.doneTaskCount}/${o.taskCount}</td>
            <td class="muted">${timeAgo(o.lastEventAt ?? o.updatedAt)}</td>
          </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

// This panel polls every few seconds; rebuilding it unconditionally would
// wipe out an in-progress "answered by" field the moment someone started
// typing into it. Only touch the DOM when the open decisions actually changed.
let lastDecisionsKey;

function renderDecisions(rows) {
  const key = JSON.stringify(rows);
  if (key === lastDecisionsKey) return;
  lastDecisionsKey = key;

  const el = document.getElementById("decisions");
  if (rows.length === 0) {
    el.innerHTML = '<div class="empty">Nothing open.</div>';
    return;
  }
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

async function refresh() {
  const [daemon, objectives, decisions, policies] = await Promise.all([
    fetchJSON("/api/daemon"),
    fetchJSON("/api/objectives"),
    fetchJSON("/api/decisions"),
    fetchJSON("/api/policies"),
  ]);
  renderDaemonStatus(daemon);
  renderObjectives(objectives);
  renderDecisions(decisions);
  renderPolicies(policies);
}

function tickClock() {
  document.getElementById("clock").textContent = new Date().toLocaleTimeString();
}

tickClock();
setInterval(tickClock, 1000);
refresh().catch((err) => console.error(err));
setInterval(() => refresh().catch((err) => console.error(err)), 3000);
window.addEventListener("decision-answered", () => refresh().catch((err) => console.error(err)));
