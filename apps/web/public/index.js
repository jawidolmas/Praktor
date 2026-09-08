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

function renderDecisions(rows) {
  const el = document.getElementById("decisions");
  if (rows.length === 0) {
    el.innerHTML = '<div class="empty">Nothing open.</div>';
    return;
  }
  el.innerHTML = rows
    .map(
      (d) => `
    <div class="decision-card">
      <div class="title">${escapeHtml(d.key)} — ${escapeHtml(d.title)}</div>
      <div class="meta">
        ${escapeHtml(d.level)} · risk ${escapeHtml(d.risk)} · recommends "${escapeHtml(d.recommendation)}" ·
        <a href="/objective.html?id=${encodeURIComponent(d.objectiveId)}">${escapeHtml(d.objectiveTitle ?? d.objectiveId)}</a>
        · ${timeAgo(d.createdAt)}
      </div>
    </div>`,
    )
    .join("");
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
  const [objectives, decisions, policies] = await Promise.all([
    fetchJSON("/api/objectives"),
    fetchJSON("/api/decisions"),
    fetchJSON("/api/policies"),
  ]);
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
