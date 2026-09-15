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

// Same reasoning as renderApproval's guard below: an unconditional re-render
// on every poll would wipe out an in-progress "answered by" field the moment
// someone started typing into it.
let lastDecisionsKey;

function renderDecisions(decisions) {
  const key = JSON.stringify(decisions);
  if (key === lastDecisionsKey) return;
  lastDecisionsKey = key;

  const el = document.getElementById("decisions");
  if (decisions.length === 0) {
    el.innerHTML = '<div class="empty">None yet.</div>';
    return;
  }
  el.innerHTML = decisions.map((d) => renderDecisionCard(d)).join("");
}

function renderDiff(diff) {
  return diff
    .split("\n")
    .map((line) => {
      let cls = "diff-ctx";
      if (line.startsWith("+++") || line.startsWith("---")) cls = "diff-file";
      else if (line.startsWith("@@")) cls = "diff-hunk";
      else if (line.startsWith("+")) cls = "diff-add";
      else if (line.startsWith("-")) cls = "diff-del";
      return `<div class="${cls}">${escapeHtml(line) || " "}</div>`;
    })
    .join("");
}

async function mergeApproved() {
  const btn = document.getElementById("mergeBtn");
  const byInput = document.getElementById("approvedBy");
  const approvedBy = (byInput && byInput.value.trim()) || "dashboard";
  btn.disabled = true;
  btn.textContent = "Merging…";
  const { ok, data } = await postJSON(`/api/objectives/${encodeURIComponent(objectiveId)}/approve`, { approvedBy });
  if (!ok) {
    alert(data.message || "Merge failed.");
    // A failed merge (e.g. a dirty repo) leaves eligibility unchanged, so the
    // guard below will skip re-rendering the panel — reset the button by hand
    // or it would be stuck saying "Merging…" with no way to retry.
    btn.disabled = false;
    btn.textContent = "Merge & push";
  }
  await refreshApproval();
  await refreshDetail();
}

// The dashboard polls every couple seconds; naively rebuilding this panel's
// innerHTML on every poll would wipe out the "approved by" field mid-keystroke
// (and any focus/selection in it) even though nothing about the underlying
// diff actually changed. Only re-render when the fetched status is genuinely
// different from what's already on screen.
let lastApprovalKey;

function renderApproval(status) {
  const key = JSON.stringify(status);
  if (key === lastApprovalKey) return;
  lastApprovalKey = key;

  const panel = document.getElementById("approvalPanel");
  const el = document.getElementById("approval");

  if (status.alreadyMerged) {
    panel.hidden = false;
    el.innerHTML = `<div class="empty">✓ Approved and merged at ${new Date(status.mergedAt).toLocaleString()}.</div>`;
    return;
  }
  if (!status.eligible) {
    panel.hidden = true;
    return;
  }

  panel.hidden = false;
  const branches = status.branches || [];
  const branchesHtml = branches
    .map(
      (b) => `
    <div style="padding: 10px 18px 4px; font-size: 13px;">
      <span class="mono">${escapeHtml(b.branch)}</span> — ${escapeHtml(b.taskTitle)}
    </div>
    <div class="diff">${b.diff.trim() ? renderDiff(b.diff) : '<div class="diff-ctx">(no diff beyond base)</div>'}</div>`,
    )
    .join("");
  el.innerHTML = `
    <div style="padding: 0 18px 14px; font-size: 13px;">
      ${branches.length} branch(es) against
      <span class="mono">${escapeHtml(status.repoPath)}</span> — review before this touches your real repo.
    </div>
    ${branchesHtml}
    <div class="decision-answer-row" style="padding: 14px 18px;">
      <input type="text" id="approvedBy" class="by-input" placeholder="approved by (optional)" />
      <button class="option-btn recommended" id="mergeBtn">Merge ${branches.length} branch(es) &amp; push</button>
    </div>
  `;
  document.getElementById("mergeBtn").addEventListener("click", () => mergeApproved().catch((err) => console.error(err)));
}

async function refreshApproval() {
  const status = await fetchJSON(`/api/objectives/${encodeURIComponent(objectiveId)}/approval`);
  renderApproval(status);
}

async function refreshDetail() {
  const detail = await fetchJSON(`/api/objectives/${encodeURIComponent(objectiveId)}`);
  renderHeader(detail.objective);
  renderTasks(detail.tasks, detail.runs);
  renderDecisions(detail.decisions);
  await refreshApproval();
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

// The detail panel (header/tasks/decisions) and the approval panel (which
// shells out to `git diff` per branch — a real, non-trivial subprocess cost)
// used to be re-fetched on a blind 2s timer, forever, for as long as the tab
// stayed open — including the long stretches where nothing on this objective
// has changed at all. The event stream already tells us exactly when
// something did (a new event only exists because something happened), so a
// refresh is scheduled from there instead: near-instant on a real change,
// and zero wasted work the rest of the time. Debounced so a burst of events
// (e.g. several turns in quick succession) coalesces into one refresh rather
// than one per event.
let refreshTimer;
function scheduleRefresh(delayMs = 1000) {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    refreshDetail().catch((err) => console.error(err));
  }, delayMs);
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
    if (data.backlog?.length || data.events?.length) scheduleRefresh();
  };
}

if (!objectiveId) {
  document.getElementById("headerPanel").innerHTML = '<div class="empty">No objective id in the URL.</div>';
} else {
  refreshDetail().catch((err) => console.error(err));
  // A long-interval fallback, not the primary mechanism — belt-and-suspenders
  // in case a stream reconnect ever misses something, not a replacement for
  // event-driven refresh above.
  setInterval(() => refreshDetail().catch((err) => console.error(err)), 20_000);
  connectStream();
  window.addEventListener("decision-answered", () => refreshDetail().catch((err) => console.error(err)));
}
