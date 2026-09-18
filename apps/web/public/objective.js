const objectiveId = qs("id");
const logEl = document.getElementById("log");
let logHasContent = false;

function usageTotal(u) {
  return (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheCreation ?? 0);
}

// Events arriving over the live SSE stream are the only source of the
// judge/diagnoser's per-attempt verdict this page has — there's no separate
// "give me the judge's verdict for run X" endpoint, because the event log is
// already the source of truth for it (see events.ts's own doc comment: every
// other table is a projection of this log). Keyed by event id so the same
// event arriving twice (a backlog delivery followed by a reconnect) never
// double-counts.
const eventById = new Map();

function ingestEvents(list) {
  for (const e of list) eventById.set(e.id, e);
}

/** The latest event of `type` raised against a specific run — a run is
 *  reviewed/diagnosed at most once, but "latest" is a safe tie-breaker if
 *  that ever isn't true. */
function findRunEvent(runId, type) {
  let found;
  for (const e of eventById.values()) {
    if (e.runId === runId && e.type === type && (!found || e.id > found.id)) found = e;
  }
  return found;
}

function pipelineStage(label, cls, bodyHtml) {
  return `<div class="stage ${cls}"><div class="stage-label">${escapeHtml(label)}</div><div class="stage-body">${bodyHtml}</div></div>`;
}

/** One attempt's full pipeline: which model did the work, what the
 *  independent judge decided about it, and — only reached on a non-accept —
 *  what the failure diagnoser concluded and recommended next. This is the
 *  "who did the work, and where did it go wrong" view: previously all three
 *  facts existed only as separate, easy-to-miss lines buried in the live log. */
function renderRunPipeline(r) {
  const workerBody = `
    ${modelBadge(r.model)} ${badge(r.status === "running" ? "running" : r.exitReason ?? r.status)}
    <div class="stage-detail muted">${r.turns} turns · ${formatTokens(usageTotal(r.usage))} · ${formatUsd(r.costUsdEstimate)}</div>
    <div class="stage-detail muted">started ${timeAgo(r.startedAt)}</div>`;

  const reviewEvent = findRunEvent(r.id, "review.result");
  const judgeCls = reviewEvent ? `stage-${reviewEvent.kind}` : "stage-pending";
  const judgeBody = reviewEvent
    ? `${reviewEvent.model ? modelBadge(reviewEvent.model) : ""}<div class="stage-detail">${escapeHtml(reviewEvent.text)}</div>`
    : `<div class="stage-detail muted">${r.status === "running" ? "in progress…" : "not reached (acceptance failed before review)"}</div>`;

  const diagnoseEvent = findRunEvent(r.id, "diagnose.result");
  const diagnoseCls = diagnoseEvent ? `stage-${diagnoseEvent.kind}` : "stage-pending";
  const diagnoseBody = diagnoseEvent
    ? `${diagnoseEvent.model ? modelBadge(diagnoseEvent.model) : ""}<div class="stage-detail">${escapeHtml(diagnoseEvent.text)}</div>`
    : `<div class="stage-detail muted">${reviewEvent?.text === "Judge: accepted" ? "not needed — accepted" : "not reached"}</div>`;

  return `
    <div class="pipeline">
      <div class="pipeline-attempt muted">Attempt ${r.attempt}</div>
      <div class="pipeline-row">
        ${pipelineStage("Worker", "stage-worker", workerBody)}
        <div class="stage-arrow">→</div>
        ${pipelineStage("Judge", judgeCls, judgeBody)}
        <div class="stage-arrow">→</div>
        ${pipelineStage("Diagnoser", diagnoseCls, diagnoseBody)}
      </div>
    </div>`;
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
      const pipelines = taskRuns.map((r) => renderRunPipeline(r)).join("");
      return `
        <div class="task-block">
          <div class="task-block-head">
            <span class="mono">${escapeHtml(task.key)}</span>
            <span class="task-block-title">${escapeHtml(task.title)}</span>
            ${badge(task.status)}
            <span class="muted mono">${escapeHtml(task.taskClass)} · ${task.attempts}/${task.maxAttempts} attempts</span>
          </div>
          ${pipelines || '<div class="empty">No runs yet.</div>'}
        </div>`;
    })
    .join("");
}

// Same reasoning as renderReports' guard below: this only changes when a new
// attempt rebuilds the graph, so an unconditional re-render on every
// event-triggered poll would re-snap the confidence bar's width transition
// for no reason.
let lastGraphKey;

function confidenceSegment(cls, label, count, total) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  const width = total > 0 ? (count / total) * 100 : 0;
  return {
    seg: `<div class="confidence-seg ${cls}" style="width:${width}%"></div>`,
    legend: `<span><span class="dot ${cls}"></span>${escapeHtml(label)} ${count.toLocaleString()} (${pct}%)</span>`,
  };
}

function renderGraphStats(stats) {
  const key = JSON.stringify(stats);
  if (key === lastGraphKey) return;
  lastGraphKey = key;

  const el = document.getElementById("graph");
  if (!stats.available) {
    el.innerHTML =
      '<div class="empty">No knowledge graph yet for this repo — built automatically before the next attempt runs.</div>';
    return;
  }

  const c = stats.confidence;
  const totalEdges = c.extracted + c.inferred + c.ambiguous;
  const extracted = confidenceSegment("extracted", "Extracted", c.extracted, totalEdges);
  const inferred = confidenceSegment("inferred", "Inferred", c.inferred, totalEdges);
  const ambiguous = confidenceSegment("ambiguous", "Ambiguous", c.ambiguous, totalEdges);

  const maxDegree = Math.max(...stats.topNodes.map((n) => n.degree), 1);
  const topNodesHtml = stats.topNodes.length
    ? `<div class="model-cost-list">
        ${stats.topNodes
          .map(
            (n) => `
          <div class="model-cost-row">
            <div class="model-cost-head">
              <span class="mono">${escapeHtml(n.label)}</span>
              ${n.sourceFile ? `<span class="muted">${escapeHtml(n.sourceFile)}</span>` : ""}
              <span class="model-cost-value">${n.degree.toLocaleString()}</span>
            </div>
            <div class="model-cost-track"><div class="model-cost-fill" style="width:${(n.degree / maxDegree) * 100}%"></div></div>
          </div>`,
          )
          .join("")}
      </div>`
    : '<div class="empty">No connections yet.</div>';

  el.innerHTML = `
    <div class="kpi-row">
      <div class="kpi-card"><div class="kpi-label">Nodes</div><div class="kpi-value">${stats.nodeCount.toLocaleString()}</div></div>
      <div class="kpi-card"><div class="kpi-label">Edges</div><div class="kpi-value">${stats.edgeCount.toLocaleString()}</div></div>
      <div class="kpi-card"><div class="kpi-label">Communities</div><div class="kpi-value">${stats.communityCount.toLocaleString()}</div></div>
      <div class="kpi-card"><div class="kpi-label">Files</div><div class="kpi-value">${stats.fileCount.toLocaleString()}</div></div>
    </div>
    <div style="padding: 0 18px 16px;">
      <div class="confidence-bar">${extracted.seg}${inferred.seg}${ambiguous.seg}</div>
      <div class="confidence-legend">${extracted.legend}${inferred.legend}${ambiguous.legend}</div>
    </div>
    ${topNodesHtml}
    <div class="stat-row">
      <div class="stat"><span class="label">Updated</span><span class="value">${timeAgo(stats.builtAt)}</span></div>
      <div class="stat"><span class="label">Cache</span><span class="value mono">${escapeHtml(stats.graphPath)}</span></div>
    </div>
  `;
}

/** The rich prose report artifact — full judge reasoning, full diagnosis,
 *  failing-check output — kept separate from the pipeline cards above
 *  (which show the structured, at-a-glance verdict) since this is the
 *  "I want the whole story" escape hatch, not something to dump inline by
 *  default. */
// Same reasoning as the decisions/approval panels below: reports arrive on
// every poll (a live run triggers a refresh per event), and rebuilding
// unconditionally would collapse a `<details>` the moment someone opened it
// to actually read a report.
let lastReportsKey;

function renderReports(reports, tasks) {
  const key = JSON.stringify(reports);
  if (key === lastReportsKey) return;
  lastReportsKey = key;

  const panel = document.getElementById("reportsPanel");
  const el = document.getElementById("reports");
  const taskEntries = Object.entries(reports.taskReports || {});
  const hasAny = Boolean(reports.objectiveReport) || taskEntries.length > 0;
  panel.hidden = !hasAny;
  if (!hasAny) return;

  const taskLabelById = new Map(tasks.map((t) => [t.id, `${t.key} — ${t.title}`]));
  const parts = [];
  if (reports.objectiveReport) {
    parts.push(`
      <details class="report-entry">
        <summary>Objective summary</summary>
        <pre class="report-body">${escapeHtml(reports.objectiveReport)}</pre>
      </details>`);
  }
  for (const [taskId, content] of taskEntries) {
    parts.push(`
      <details class="report-entry">
        <summary>${escapeHtml(taskLabelById.get(taskId) || taskId)}</summary>
        <pre class="report-body">${escapeHtml(content)}</pre>
      </details>`);
  }
  el.innerHTML = parts.join("");
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

// The result of the last merge attempt, shown as an inline banner rather
// than a native alert() — a native dialog reads as an error even when it
// isn't one (confirmed live: "merged locally, but push failed" is often a
// harmless no-remote message, but a modal popup makes it look catastrophic),
// and it can't show which specific branch did or didn't make it in. Cleared
// whenever a fresh merge attempt starts, or once the objective actually
// reaches "already merged".
let lastMergeResult;

function renderMergeResultBanner(result) {
  if (!result) return "";
  const rows = (result.branches || [])
    .map(
      (b) => `<div class="merge-result-row ${b.merged ? "ok" : "fail"}">
        <span class="mono">${escapeHtml(b.branch)}</span> — ${escapeHtml(b.message)}
      </div>`,
    )
    .join("");
  return `
    <div class="merge-result-banner ${result.ok ? "ok" : "fail"}">
      <div class="merge-result-summary">${escapeHtml(result.message)}</div>
      ${rows}
    </div>`;
}

async function mergeApproved() {
  const btn = document.getElementById("mergeBtn");
  const byInput = document.getElementById("approvedBy");
  const approvedBy = (byInput && byInput.value.trim()) || "dashboard";
  btn.disabled = true;
  btn.textContent = "Merging…";
  const { ok, data } = await postJSON(`/api/objectives/${encodeURIComponent(objectiveId)}/approve`, { approvedBy });
  lastMergeResult = { ok, message: data.message || (ok ? "Merged." : "Merge failed."), branches: data.branches };
  // Force a rebuild even if the fetched /approval status looks unchanged
  // from before (same branches, still eligible) — otherwise the guard below
  // would skip re-rendering and this result would never actually show.
  lastApprovalKey = undefined;
  if (!ok) {
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
    lastMergeResult = undefined;
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
    ${renderMergeResultBanner(lastMergeResult)}
    ${branchesHtml}
    <div class="decision-answer-row" id="mergeActionRow" style="padding: 14px 18px;">
      <input type="text" id="approvedBy" class="by-input" placeholder="approved by (optional)" />
      <button class="option-btn recommended" id="mergeBtn">Merge ${branches.length} branch(es) &amp; push</button>
    </div>
  `;
  document.getElementById("mergeBtn").addEventListener("click", () => showMergeConfirm(status));
}

// A native confirm() reads as a generic browser warning, not a considered
// "yes" specific to what's about to happen — and it can't be styled to match
// what it's actually confirming. This replaces it with an in-panel step:
// the merge button gives way to an explicit warning plus a real Confirm/
// Cancel pair, in the same visual language as everything else on this page.
function showMergeConfirm(status) {
  const row = document.getElementById("mergeActionRow");
  if (!row) return;
  const branchCount = (status.branches || []).length;
  row.innerHTML = `
    <div class="merge-confirm">
      <div class="merge-confirm-text">
        Merge ${branchCount} branch(es) into <span class="mono">${escapeHtml(status.repoPath)}</span> and push? This writes to your real repo.
      </div>
      <div class="merge-confirm-actions">
        <input type="text" id="approvedBy" class="by-input" placeholder="approved by (optional)" />
        <button class="option-btn" id="mergeCancelBtn">Cancel</button>
        <button class="option-btn recommended" id="mergeConfirmBtn">Yes, merge &amp; push</button>
      </div>
    </div>
  `;
  document.getElementById("mergeCancelBtn").addEventListener("click", () => renderApprovalForced(status));
  document.getElementById("mergeConfirmBtn").addEventListener("click", () => mergeApproved().catch((err) => console.error(err)));
}

/** Re-renders the panel even though `status` hasn't changed — used only to
 *  back out of the confirm step, since `renderApproval`'s own memoization
 *  would otherwise see the identical status and skip rebuilding the row. */
function renderApprovalForced(status) {
  lastApprovalKey = undefined;
  renderApproval(status);
}

async function refreshApproval() {
  const status = await fetchJSON(`/api/objectives/${encodeURIComponent(objectiveId)}/approval`);
  renderApproval(status);
}

// Promise.all previously meant one failing fetch (e.g. the repo's graph.json
// being briefly mid-write, or any other single endpoint hiccup) blocked
// every panel on the page from ever rendering, including ones with no
// dependency on the failing endpoint — every panel just sat on its static
// "Loading…" forever, with no error surfaced anywhere. Promise.allSettled
// plus per-result handling means one endpoint's failure only ever affects
// that one panel.
async function refreshDetail() {
  const [detailResult, reportsResult, graphResult] = await Promise.allSettled([
    fetchJSON(`/api/objectives/${encodeURIComponent(objectiveId)}`),
    fetchJSON(`/api/objectives/${encodeURIComponent(objectiveId)}/reports`),
    fetchJSON(`/api/objectives/${encodeURIComponent(objectiveId)}/graph`),
  ]);

  if (detailResult.status === "fulfilled") {
    const detail = detailResult.value;
    renderHeader(detail.objective);
    renderTasks(detail.tasks, detail.runs);
    renderDecisions(detail.decisions);
    if (reportsResult.status === "fulfilled") {
      renderReports(reportsResult.value, detail.tasks);
    } else {
      console.error("Failed to load reports:", reportsResult.reason);
    }
  } else {
    console.error("Failed to load objective detail:", detailResult.reason);
    document.getElementById("headerPanel").innerHTML =
      '<div class="empty">Could not load this objective — check the dashboard server log, then reload.</div>';
  }

  if (graphResult.status === "fulfilled") {
    renderGraphStats(graphResult.value);
  } else {
    console.error("Failed to load graph stats:", graphResult.reason);
    renderGraphStats({ available: false });
  }

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
    if (data.backlog) {
      appendLogLines(data.backlog);
      ingestEvents(data.backlog);
    }
    if (data.events) {
      appendLogLines(data.events);
      ingestEvents(data.events);
    }
    // Re-render the pipeline cards (not just the raw log) once the judge or
    // diagnoser's verdict for this attempt actually lands — scheduleRefresh
    // already debounces this, so a burst of turns doesn't refetch per event.
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
