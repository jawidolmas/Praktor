const objectiveId = qs("id");
const logEl = document.getElementById("log");
let logHasContent = false;

function usageTotal(u) {
  return (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheCreation ?? 0);
}

function renderHeader(objective) {
  document.getElementById("crumb").textContent = `/ ${objective.title}`;
  document.title = `${objective.title} — Praktor Dashboard`;
  document.getElementById("headerPanel").innerHTML = `
    <h2>${escapeHtml(objective.title)}</h2>
    <div class="stat-row">
      <div class="stat"><span class="label">Status</span><span class="value">${badge(objective.status)}</span></div>
      <div class="stat"><span class="label">Repo</span><span class="value mono">${escapeHtml(objective.repoPath)}</span></div>
      <div class="stat"><span class="label">Base ref</span><span class="value mono">${escapeHtml(objective.baseRef)}</span></div>
      <div class="stat"><span class="label">Created</span><span class="value">${timeAgo(objective.createdAt)}</span></div>
      <div class="stat"><span class="label">Updated</span><span class="value">${timeAgo(objective.updatedAt)}</span></div>
      <div class="stat"><span class="label">Max attempts</span><span class="value">${objective.budget?.maxTurns ?? "-"} turns/attempt</span></div>
    </div>
    <div style="padding: 0 18px 16px; color: var(--text-muted); font-size: 13px;">${escapeHtml(objective.brief)}</div>
  `;
}

function renderTasks(tasks, runs) {
  const el = document.getElementById("tasks");
  if (tasks.length === 0) {
    el.innerHTML = '<div class="empty">No tasks yet.</div>';
    return;
  }
  el.innerHTML = tasks
    .map((task) => {
      const taskRuns = runs.filter((r) => r.taskId === task.id).sort((a, b) => a.attempt - b.attempt);
      const runRows = taskRuns
        .map(
          (r) => `
        <tr>
          <td class="muted">attempt ${r.attempt}</td>
          <td>${badge(r.status === "running" ? "running" : r.exitReason ?? r.status)}</td>
          <td class="mono">${r.model}</td>
          <td>${r.turns}</td>
          <td class="mono">${usageTotal(r.usage).toLocaleString()} tok</td>
          <td>$${r.costUsdEstimate.toFixed(4)}</td>
          <td class="muted">${timeAgo(r.startedAt)}</td>
        </tr>`,
        )
        .join("");
      return `
        <table>
          <thead>
            <tr>
              <th colspan="7">
                ${escapeHtml(task.key)} — ${escapeHtml(task.title)}
                ${badge(task.status)}
                <span class="muted mono">(${task.taskClass}, ${task.attempts}/${task.maxAttempts} attempts)</span>
              </th>
            </tr>
          </thead>
          <tbody>
            ${runRows || '<tr><td colspan="7" class="empty">No runs yet.</td></tr>'}
          </tbody>
        </table>`;
    })
    .join("");
}

function renderDecisions(decisions) {
  const el = document.getElementById("decisions");
  if (decisions.length === 0) {
    el.innerHTML = '<div class="empty">None yet.</div>';
    return;
  }
  el.innerHTML = decisions.map((d) => renderDecisionCard(d)).join("");
}

async function refreshDetail() {
  const detail = await fetchJSON(`/api/objectives/${encodeURIComponent(objectiveId)}`);
  renderHeader(detail.objective);
  renderTasks(detail.tasks, detail.runs);
  renderDecisions(detail.decisions);
}

function appendLogLines(events) {
  if (events.length === 0) return;
  const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  if (!logHasContent) {
    logEl.innerHTML = "";
    logHasContent = true;
  }
  for (const e of events) {
    const div = document.createElement("div");
    div.className = `log-line kind-${e.kind}`;
    div.innerHTML = `<span class="ts">${new Date(e.ts).toLocaleTimeString()}</span><span class="text">${escapeHtml(e.text)}</span>`;
    logEl.appendChild(div);
  }
  if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
}

function connectStream() {
  const dot = document.getElementById("liveDot");
  const label = document.getElementById("liveLabel");
  const source = new EventSource(`/api/objectives/${encodeURIComponent(objectiveId)}/stream`);

  source.onopen = () => {
    dot.classList.add("on");
    label.textContent = "live";
  };
  source.onerror = () => {
    dot.classList.remove("on");
    label.textContent = "reconnecting…";
  };
  source.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.backlog) appendLogLines(data.backlog);
    if (data.events) appendLogLines(data.events);
  };
}

if (!objectiveId) {
  document.getElementById("headerPanel").innerHTML = '<div class="empty">No objective id in the URL.</div>';
} else {
  refreshDetail().catch((err) => console.error(err));
  setInterval(() => refreshDetail().catch((err) => console.error(err)), 2000);
  connectStream();
  window.addEventListener("decision-answered", () => refreshDetail().catch((err) => console.error(err)));
}
