// ---------- shared flags ----------
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- reveal-on-scroll ----------
const revealTargets = document.querySelectorAll(".reveal");
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in-view");
          io.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.15 }
  );
  revealTargets.forEach((el) => io.observe(el));
} else {
  revealTargets.forEach((el) => el.classList.add("in-view"));
}

// ---------- copy to clipboard ----------
document.querySelectorAll(".copy-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const text = btn.getAttribute("data-copy") ?? "";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API can be unavailable (insecure context, permissions) —
      // the button label below is the only feedback either way, and doing
      // nothing further is fine since there is no functional fallback.
    }
    const original = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = original; }, 1400);
  });
});

// ---------- node-network canvas (drifting nodes, connecting edges, traveling pulses) ----------
function initNodeNetwork(canvas, opts = {}) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const {
    linkDist = 130,
    repelDist = 110,
    nodeCountDesktop = 30,
    nodeCountMobile = 12,
    rgb = "76, 154, 255",
    linkAlpha = 0.22,
    nodeAlpha = 0.45,
    pulseChance = 0.02,
    interactive = true,
  } = opts;
  const isMobile = () => window.matchMedia("(max-width: 640px)").matches;

  let width = 0;
  let height = 0;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pointer = { x: -9999, y: -9999 };
  let nodes = [];
  let pulses = [];
  let rafId = null;
  let running = false;

  function buildNodes() {
    const count = isMobile() ? nodeCountMobile : nodeCountDesktop;
    nodes = new Array(count).fill(null).map(() => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.25,
      vy: (Math.random() - 0.5) * 0.25,
    }));
    pulses = [];
  }

  function resize() {
    width = canvas.offsetWidth;
    height = canvas.offsetHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildNodes();
  }

  function drawStaticFrame() {
    resize();
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = `rgba(${rgb}, ${(nodeAlpha * 0.8).toFixed(3)})`;
    for (const n of nodes) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function tick() {
    ctx.clearRect(0, 0, width, height);

    for (const n of nodes) {
      const dx = n.x - pointer.x;
      const dy = n.y - pointer.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < repelDist * repelDist) {
        const dist = Math.sqrt(distSq) || 1;
        const force = (1 - dist / repelDist) * 0.06;
        n.vx += (dx / dist) * force;
        n.vy += (dy / dist) * force;
      }

      n.vx *= 0.98;
      n.vy *= 0.98;
      const speed = Math.hypot(n.vx, n.vy);
      const maxSpeed = 0.6;
      if (speed > maxSpeed) {
        n.vx = (n.vx / speed) * maxSpeed;
        n.vy = (n.vy / speed) * maxSpeed;
      }

      n.x += n.vx;
      n.y += n.vy;
      if (n.x < 0 || n.x > width) n.vx *= -1;
      if (n.y < 0 || n.y > height) n.vy *= -1;
      n.x = Math.max(0, Math.min(width, n.x));
      n.y = Math.max(0, Math.min(height, n.y));
    }

    ctx.lineWidth = 1;
    const edges = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < linkDist * linkDist) {
          const dist = Math.sqrt(distSq);
          const alpha = (1 - dist / linkDist) * linkAlpha;
          ctx.strokeStyle = `rgba(${rgb}, ${alpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          edges.push([a, b]);
        }
      }
    }

    if (edges.length && Math.random() < pulseChance && pulses.length < 4) {
      const [a, b] = edges[(Math.random() * edges.length) | 0];
      pulses.push({ a, b, t: 0 });
    }
    ctx.fillStyle = `rgba(${rgb}, ${Math.min(nodeAlpha * 2, 0.9).toFixed(3)})`;
    pulses = pulses.filter((p) => p.t < 1);
    for (const p of pulses) {
      const x = p.a.x + (p.b.x - p.a.x) * p.t;
      const y = p.a.y + (p.b.y - p.a.y) * p.t;
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
      p.t += 0.02;
    }

    ctx.fillStyle = `rgba(${rgb}, ${nodeAlpha.toFixed(3)})`;
    for (const n of nodes) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }

    rafId = requestAnimationFrame(tick);
  }

  function start() {
    if (running || prefersReducedMotion) return;
    running = true;
    rafId = requestAnimationFrame(tick);
  }
  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  if (prefersReducedMotion) {
    drawStaticFrame();
    return;
  }

  resize();
  if ("ResizeObserver" in window) {
    new ResizeObserver(resize).observe(canvas);
  } else {
    window.addEventListener("resize", resize, { passive: true });
  }

  if (interactive) {
    window.addEventListener(
      "pointermove",
      (e) => {
        if (e.pointerType && e.pointerType !== "mouse") return;
        const rect = canvas.getBoundingClientRect();
        pointer.x = e.clientX - rect.left;
        pointer.y = e.clientY - rect.top;
      },
      { passive: true }
    );
    window.addEventListener(
      "pointerleave",
      () => {
        pointer.x = -9999;
        pointer.y = -9999;
      },
      { passive: true }
    );
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else if (canvas.getBoundingClientRect().bottom > 0) start();
  });

  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !document.hidden) start();
          else stop();
        }
      },
      { threshold: 0.05 }
    );
    io.observe(canvas);
  } else {
    start();
  }
}

initNodeNetwork(document.getElementById("heroCanvas"));

// ---------- hero typing ----------
function typeInto(el, text, speed, onDone) {
  let i = 0;
  (function step() {
    if (i <= text.length) {
      el.textContent = text.slice(0, i);
      i++;
      setTimeout(step, speed);
    } else if (onDone) {
      onDone();
    }
  })();
}

function runHero() {
  const target = document.getElementById("heroTyped");
  const cursor = document.getElementById("heroCursor");
  const outs = ["heroOut1", "heroOut2", "heroOut3", "heroOut4", "heroOut5"].map((id) => document.getElementById(id));
  if (!target) return;

  target.textContent = "";
  outs.forEach((o) => { if (o) o.hidden = true; });

  typeInto(target, 'exec-agent do "add a CONTRIBUTING.md in my-project"', 28, () => {
    if (cursor) cursor.style.marginLeft = "2px";
    let delay = 400;
    outs.forEach((o) => {
      if (!o) return;
      setTimeout(() => { o.hidden = false; }, delay);
      delay += 500;
    });
  });
}

const heroSection = document.querySelector(".hero-terminal");
if (heroSection && "IntersectionObserver" in window) {
  const heroIo = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          runHero();
          heroIo.disconnect();
        }
      }
    },
    { threshold: 0.4 }
  );
  heroIo.observe(heroSection);
} else {
  runHero();
}

// ---------- proof card tilt ----------
(function initProofTilt() {
  if (prefersReducedMotion || !window.matchMedia("(hover: hover)").matches) return;
  const cards = document.querySelectorAll(".proof-card");
  cards.forEach((card) => {
    const art = card.querySelector(".proof-art");
    if (!art) return;
    card.addEventListener(
      "pointermove",
      (e) => {
        if (e.pointerType !== "mouse") return;
        const rect = art.getBoundingClientRect();
        const px = (e.clientX - rect.left) / rect.width;
        const py = (e.clientY - rect.top) / rect.height;
        const rx = (0.5 - py) * 12;
        const ry = (px - 0.5) * 12;
        art.style.transform = `perspective(600px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
      },
      { passive: true }
    );
    card.addEventListener("pointerleave", () => {
      art.style.transform = "";
    });
  });
})();

// ---------- hover callouts (reused by the proof illustrations and the how-it-works graph) ----------
function initHoverCallouts(container, opts = {}) {
  if (!container || !window.matchMedia("(hover: hover)").matches) return;
  const callout = container.querySelector(".proof-callout");
  const nodes = container.querySelectorAll(".proof-node");
  if (!callout || !nodes.length) return;
  const titleEl = callout.querySelector(".proof-callout-title");
  const bodyEl = callout.querySelector(".proof-callout-body");
  const avoidBelow = opts.avoidBelowSelector ? container.querySelector(opts.avoidBelowSelector) : null;

  function show(node) {
    const targetId = node.getAttribute("data-target");
    const target = targetId ? container.querySelector("#" + targetId) : null;
    if (target) target.classList.add("proof-active");
    node.__proofTarget = target;

    titleEl.textContent = node.getAttribute("data-callout-title") || "";
    bodyEl.textContent = node.getAttribute("data-callout-body") || "";
    callout.classList.add("visible");

    const containerRect = container.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const cx = nodeRect.left + nodeRect.width / 2 - containerRect.left;
    const cy = nodeRect.top + nodeRect.height / 2 - containerRect.top;
    const cw = callout.offsetWidth || 180;
    const ch = callout.offsetHeight || 70;
    const gap = 16;

    // prefer the side with more room, vertically centered on the node.
    let left = cx + gap;
    if (left + cw > container.clientWidth - 4) left = cx - gap - cw;
    left = Math.max(4, Math.min(left, container.clientWidth - cw - 4));

    // never let it cross into whatever sits below — measured live, not
    // assumed, since wrapped callout height varies with font metrics.
    const avoidRect = avoidBelow ? avoidBelow.getBoundingClientRect() : null;
    const maxBottom = avoidRect ? avoidRect.top - containerRect.top - 14 : container.clientHeight - 4;
    const top = Math.max(4, Math.min(cy - ch / 2, maxBottom - ch));
    callout.style.left = left + "px";
    callout.style.top = top + "px";
  }
  function hide(node) {
    callout.classList.remove("visible");
    if (node && node.__proofTarget) node.__proofTarget.classList.remove("proof-active");
  }

  nodes.forEach((node) => {
    node.addEventListener("pointerenter", (e) => {
      if (e.pointerType !== "mouse") return;
      show(node);
    });
    node.addEventListener("pointerleave", (e) => {
      if (e.pointerType !== "mouse") return;
      hide(node);
    });
  });
}

document.querySelectorAll(".proof-card").forEach((card) => initHoverCallouts(card, { avoidBelowSelector: "h3" }));

// ---------- fig 0.3 world-map dot silhouette ----------
(function initProofMap() {
  const svg = document.querySelector(".proof-map-svg");
  if (!svg) return;
  const clusters = [
    { x: 22, y: 38, w: 42, h: 38, n: 9 }, // N. America
    { x: 40, y: 92, w: 30, h: 42, n: 6 }, // S. America
    { x: 92, y: 30, w: 26, h: 26, n: 5 }, // Europe
    { x: 88, y: 62, w: 32, h: 52, n: 8 }, // Africa
    { x: 122, y: 28, w: 52, h: 40, n: 10 }, // Asia
    { x: 150, y: 108, w: 24, h: 20, n: 4 }, // Australia
  ];
  const ns = "http://www.w3.org/2000/svg";
  const frag = document.createDocumentFragment();
  clusters.forEach((c) => {
    for (let i = 0; i < c.n; i++) {
      const dot = document.createElementNS(ns, "circle");
      dot.setAttribute("cx", (c.x + Math.random() * c.w).toFixed(1));
      dot.setAttribute("cy", (c.y + Math.random() * c.h).toFixed(1));
      dot.setAttribute("r", "1.1");
      dot.setAttribute("class", "proof-map-dot");
      frag.appendChild(dot);
    }
  });
  svg.insertBefore(frag, svg.firstChild);
})();

// ---------- terminal-line script player (drives the demo terminal) ----------
function demoLine(kind, text) {
  const p = document.createElement("p");
  if (kind === "cmd") {
    p.className = "term-line";
    const prompt = document.createElement("span");
    prompt.className = "term-prompt";
    prompt.textContent = "$ ";
    p.appendChild(prompt);
    const span = document.createElement("span");
    p.appendChild(span);
    return { el: p, span, isCmd: true };
  }
  p.className = "term-out term-out-" + kind;
  return { el: p, span: p, isCmd: false, text };
}

async function playScript(container, script, opts = {}) {
  const { onLine, typeSpeed = 22, lineDelay = 420, cmdPause = 250 } = opts;
  container.innerHTML = "";
  for (const step of script) {
    const { el, span, isCmd } = demoLine(step.type, step.text);
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
    if (isCmd) {
      await new Promise((resolve) => typeInto(span, step.text, typeSpeed, resolve));
      await new Promise((r) => setTimeout(r, cmdPause));
    } else {
      span.textContent = step.text;
      if (onLine) onLine(el, step);
      await new Promise((r) => setTimeout(r, lineDelay));
    }
  }
}

// ---------- live demo terminal ----------
const DEMO_SCRIPT = [
  { type: "cmd", text: 'exec-agent do "fix the flaky checkout test"' },
  { type: "dim", text: "→ daemon started (none was running) — driving this in the background" },
  { type: "dim", text: "→ worktree exec/o-9c14-attempt-1 opened" },
  { type: "accent", text: "→ worker editing tests/checkout.spec.ts" },
  { type: "warn", text: "→ decision: test touches CI config — escalated to Telegram" },
  { type: "ok", text: "→ decide o-9c14 allow   (answered from phone)" },
  { type: "dim", text: "→ running check: npm test -- checkout" },
  { type: "ok", text: "→ check passed — attempt accepted" },
  { type: "cmd", text: "exec-agent approve o-9c14" },
  { type: "ok", text: "→ merged into main, pushed. objective complete." },
];

const demoBody = document.getElementById("demoBody");
const replayBtn = document.getElementById("replayBtn");
let demoRunning = false;

async function runDemo() {
  if (!demoBody || demoRunning) return;
  demoRunning = true;
  if (replayBtn) replayBtn.disabled = true;
  const termWindow = demoBody.closest(".term-window-big");
  if (termWindow) termWindow.classList.add("demo-active");

  await playScript(demoBody, DEMO_SCRIPT, {
    onLine: (el, step) => {
      if (step.type === "warn") el.classList.add("flash");
    },
  });

  demoRunning = false;
  if (replayBtn) replayBtn.disabled = false;
  if (termWindow) termWindow.classList.remove("demo-active");
}

if (replayBtn) replayBtn.addEventListener("click", runDemo);

const demoSection = document.querySelector(".demo");
if (demoSection && "IntersectionObserver" in window) {
  const demoIo = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          runDemo();
          demoIo.disconnect();
        }
      }
    },
    { threshold: 0.3 }
  );
  demoIo.observe(demoSection);
}

// ---------- status feed (updates): live clock, data-driven feature/changelog
// lists fetched from data/status.json (the "backend" — edit that file, or have
// it edited, whenever a feature ships), and glitching terminal headers ----------
(function initStatusFeed() {
  const clockEl = document.getElementById("statusClock");
  const bootEl = document.getElementById("statusBoot");
  const featuresEl = document.getElementById("statusFeatures");
  const logEl = document.getElementById("statusLog");

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const mdCode = (s) => s.replace(/`([^`]+)`/g, "<code>$1</code>");

  if (clockEl) {
    const pad = (n) => String(n).padStart(2, "0");
    function tick() {
      const now = new Date();
      clockEl.textContent =
        now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()) +
        " " + pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds());
    }
    tick();
    setInterval(tick, 1000);
  }

  if (bootEl || featuresEl || logEl) {
    fetch("data/status.json")
      .then((res) => res.json())
      .then((data) => {
        if (bootEl) {
          const today = new Date().toISOString().slice(0, 10);
          bootEl.innerHTML =
            "[boot] praktor/exec-agent status daemon\n" +
            '[ok]   version <span class="boot-tag">' + esc(data.version) + "</span> — last shipped " + esc(data.asOf) + "\n" +
            "[ok]   " + data.features.length + " capabilities online\n" +
            "[ok]   " + data.log.length + " days of changelog loaded — reading as of " + today;
        }
        if (featuresEl && Array.isArray(data.features)) {
          featuresEl.innerHTML = data.features.map((f) => "<li>" + mdCode(esc(f)) + "</li>").join("");
        }
        if (logEl && Array.isArray(data.log)) {
          logEl.innerHTML = data.log
            .map(
              (day) =>
                '<div class="statusfeed-log-day"><p class="statusfeed-log-date">' + esc(day.date) + "</p><ul>" +
                day.entries.map((e) => "<li>" + mdCode(esc(e)) + "</li>").join("") +
                "</ul></div>"
            )
            .join("");
        }
      })
      .catch(() => {
        if (bootEl) bootEl.textContent = "[error] status feed unreachable";
      });
  }

  if (prefersReducedMotion) return;
  const GLITCH_CHARS = "!<>-_\\/[]{}=+*^?#$%01";
  function scrambleBurst(el, original) {
    let frame = 0;
    const id = setInterval(() => {
      el.textContent = original
        .split("")
        .map((ch) => (ch === " " ? " " : Math.random() < 0.35 ? GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)] : ch))
        .join("");
      frame++;
      if (frame >= 5) {
        clearInterval(id);
        el.textContent = original;
      }
    }, 45);
  }
  document.querySelectorAll(".glitch-text").forEach((el, i) => {
    const original = el.getAttribute("data-text") || el.textContent;
    const fire = () => {
      el.classList.add("glitching");
      scrambleBurst(el, original);
      setTimeout(() => el.classList.remove("glitching"), 340);
    };
    // stagger the start so multiple headers don't flash in perfect lockstep
    setTimeout(() => {
      fire();
      setInterval(fire, 3000);
    }, i * 260);
  });
})();

// ---------- how it works: radial pipeline graph ----------
// Ported from the Claude Design canvas "Praktor Pipeline Graph" (the .dc.html's
// own <script> block, which ran through its dc-runtime/React). The data and the
// layout/keyframe math below are that same file's Component methods, rewritten
// against plain DOM instead of the runtime's sc-for templating and JSX state.
(function initPipelineGraph() {
  const track = document.getElementById("pk-track");
  const stage = document.getElementById("pk-stage");
  const cam = document.getElementById("pk-cam");
  const bar = document.getElementById("pk-bar");
  const edgesEl = document.getElementById("pk-edges");
  const chordsEl = document.getElementById("pk-chords");
  const leavesEl = document.getElementById("pk-leaves");
  const groupsEl = document.getElementById("pk-groups");
  const phaseNodesEl = document.getElementById("pk-phase-nodes");
  const chordLabelsEl = document.getElementById("pk-chord-labels");
  const counterEl = document.getElementById("pk-counter");
  const toggleBtn = document.getElementById("pk-toggle-overview");
  if (!track || !stage || !cam || !edgesEl) return;

  const C = 1100, R1 = 280, R2 = 530, R3 = 780, SEGS = 8;
  const MONO = "var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace)";

  const PHASES = [
    { n: "01", name: "Intake", meta: "say it in English", kids: [
      { t: "Plain-English intake", leaves: [
        { t: 'exec-agent do "add a CONTRIBUTING.md in my-project"', c: 1 },
        { t: "exec-agent run --repo --intent --check", c: 1 },
        { t: "Target repo resolved under ~/Desktop" } ] },
      { t: "The sentence is routed", leaves: [
        { t: "An obvious single step gets a real, specific check", a: 1 },
        { t: "Anything open-ended goes to the planner instead" } ] },
      { t: "Submitted to the daemon", leaves: [
        { t: "Returns immediately — the daemon owns it" },
        { t: "Ctrl-C stops watching, not the work", a: 1 } ] } ] },

    { n: "02", name: "Plan", meta: "one brain call", kids: [
      { t: "decompose", leaves: [
        { t: "A dependency-ordered task graph, not one task per objective" },
        { t: "T-001 … T-00n, each independently verifiable", c: 1 } ] },
      { t: "Each task carries a contract", leaves: [
        { t: "intent — becomes the worker's prompt", c: 1 },
        { t: "taskClass: investigate · implement · fix · test · refactor · docs", c: 1 },
        { t: "acceptance: at least one real shell command", a: 1 } ] },
      { t: "The scheduler", leaves: [
        { t: "dependencies met → ready", c: 1 },
        { t: "dependencies unmet → pending", c: 1 } ] } ] },

    { n: "03", name: "Isolate", meta: "a worktree per attempt", kids: [
      { t: "A git worktree per attempt", leaves: [
        { t: "branch exec/<id>-attempt-N", c: 1 },
        { t: "Nothing ever runs against your working tree", a: 1 } ] },
      { t: "Which ref it starts from", leaves: [
        { t: "No dependencies → the objective's base ref" },
        { t: "Has dependencies → the integration branch" } ] },
      { t: "The harness is armed", leaves: [
        { t: "PreToolUse hook installed", c: 1 },
        { t: "Tool surface by task class — investigate is read-only" } ] } ] },

    { n: "04", name: "Execute", meta: "the worker runs inside", kids: [
      { t: "A Claude Code worker session", leaves: [
        { t: "run.turn — turns, tokens, notional cost", c: 1 },
        { t: "Context pressure estimated every turn" },
        { t: "One worker per task — EXEC_MAX_WORKERS", c: 1 },
        { t: "Your own Claude login, no API key" } ] },
      { t: "It escalates by calling a tool", leaves: [
        { t: "request_decision", c: 1 },
        { t: "report_progress", c: 1 },
        { t: "check_policy", c: 1 },
        { t: "record_finding", c: 1 } ] },
      { t: "The policy engine — six rules, in the database", leaves: [
        { t: "deny · force-push, or push to a protected branch" },
        { t: "deny · production deploys outside staging" },
        { t: "ask · destructive SQL — drop, truncate, unbounded delete" },
        { t: "deny · committing .env, id_rsa or .pem" },
        { t: "deny · writing the supervisor's own state" },
        { t: "warn · a new dependency install" } ] },
      { t: "Stall detectors", leaves: [
        { t: "no_churn", c: 1 }, { t: "repeat_error", c: 1 }, { t: "context_pressure", c: 1 } ] },
      { t: "A raised decision, answerable anywhere", leaves: [
        { t: "The terminal already watching it" },
        { t: "exec-agent decide <key> <option>", c: 1 },
        { t: "A card in the dashboard, with pros and cons" },
        { t: "Telegram, with one tappable button per option" } ] },
      { t: "A rate limit parks it", leaves: [
        { t: "Parked in place — same worktree, same progress" },
        { t: "Retried the moment the limit clears" },
        { t: "The attempt budget is not spent", a: 1 } ] } ] },

    { n: "05", name: "Verify", meta: "believe the exit code", kids: [
      { t: "The supervisor runs the check itself", leaves: [
        { t: "An exit code is believed", a: 1 },
        { t: "A worker's own “done” is advisory only" } ] },
      { t: "review — did it meet the intent?", leaves: [
        { t: "accept", c: 1 }, { t: "revise", c: 1 }, { t: "reject", c: 1 } ] },
      { t: "diagnose — classify the failure", leaves: [
        { t: "flaky · bug · spec · env" },
        { t: "retry, or retry_with_hint", c: 1 },
        { t: "respawn a fresh session", c: 1 } ] },
      { t: "A checkpoint is written", leaves: [
        { t: "verifiedDone — only what checks confirmed", c: 1 },
        { t: "doNotRepeat — approaches now ruled out", c: 1 },
        { t: "nextHypothesis", c: 1 } ] },
      { t: "Attempts exhausted → --on-failure", leaves: [
        { t: "escalate — raise a decision (the default)", a: 1 },
        { t: "abandon — call the objective off", c: 1 },
        { t: "skip — accept one task's failure", c: 1 } ] } ] },

    { n: "06", name: "Land", meta: "nothing auto-merges", kids: [
      { t: "Folded into the integration branch", leaves: [
        { t: "A dependent task inherits real files, not a description" },
        { t: "A conflict means two tasks disagree — so it asks" } ] },
      { t: "The objective is done", leaves: [
        { t: "Only once every task in its graph is", a: 1 } ] },
      { t: "Human review", leaves: [
        { t: "exec-agent approve <objective-id>", c: 1 },
        { t: "A diff per branch, one Merge button" },
        { t: "On your word: merge, then push", a: 1 } ] },
      { t: "Nothing is ever merged automatically", leaves: [] },
      { t: "The event log is the source of truth", leaves: [
        { t: "exec-agent events <id> — replayable", c: 1 },
        { t: "Worktrees reclaimed once nothing needs them" } ] } ] }
  ];

  const CHORDS = [
    { from: [4, 2], to: [3, 0], t: "retry · respawn" },
    { from: [4, 3], to: [2, 0], t: "seeded into the next attempt" },
    { from: [4, 4], to: [3, 4], t: "escalate" }
  ];

  const pt = (deg, r) => [C + Math.cos(deg * Math.PI / 180) * r, C + Math.sin(deg * Math.PI / 180) * r];
  const rev = (m) => "clamp(0, calc((var(--p,0) - var(--r)) * " + m + "), 1)";
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function angleOf(ref, step) {
    let slotI = 0;
    for (let pi = 0; pi < PHASES.length; pi++) {
      for (let ki = 0; ki < PHASES[pi].kids.length; ki++) {
        const n = Math.max(1, PHASES[pi].kids[ki].leaves.length);
        if (pi === ref[0] && ki === ref[1]) return -90 + slotI * step + (n * step) / 2;
        slotI += n;
      }
    }
    return 0;
  }

  let _lay = null;
  function layout() {
    if (_lay) return _lay;

    let slots = 0;
    PHASES.forEach((p) => p.kids.forEach((k) => { slots += Math.max(1, k.leaves.length); }));
    const step = 360 / slots;

    const edges = [], leaves = [], groups = [], phaseNodes = [];
    let cursor = -90, slotI = 0;

    const elbow = (rp, tp, rc, tc) => {
      const [px, py] = pt(tp, rp), [mx, my] = pt(tc, rp), [cx, cy] = pt(tc, rc);
      let d, len;
      if (Math.abs(tc - tp) < 0.02) {
        d = "M" + px + " " + py + "L" + cx + " " + cy;
        len = Math.abs(rc - rp);
      } else {
        d = "M" + px.toFixed(1) + " " + py.toFixed(1) + "A" + rp + " " + rp + " 0 0 " + (tc > tp ? 1 : 0) + " " + mx.toFixed(1) + " " + my.toFixed(1) + "L" + cx.toFixed(1) + " " + cy.toFixed(1);
        len = Math.abs(tc - tp) * Math.PI / 180 * rp + Math.abs(rc - rp);
      }
      return { d, len: Math.max(1, Math.round(len)) };
    };
    const push = (e, r, c, w) =>
      edges.push({ d: e.d, c, w, s: "--r:" + r.toFixed(4) + ";stroke-dasharray:" + e.len + "px;stroke-dashoffset:calc(" + e.len + "px * (1 - " + rev(11) + "))" });

    PHASES.forEach((ph, pi) => {
      const base = (pi + 1) / SEGS;
      const sStart = cursor + slotI * step;
      const phaseSlots = ph.kids.reduce((a, k) => a + Math.max(1, k.leaves.length), 0);
      const kidAngles = [];
      let leafSeen = 0;

      ph.kids.forEach((kid, ki) => {
        const n = Math.max(1, kid.leaves.length);
        const first = cursor + slotI * step;
        const kidAngle = first + (n * step) / 2;
        kidAngles.push(kidAngle);
        const kidR = base + 0.014 + (ki / ph.kids.length) * 0.032;

        kid.leaves.forEach((lf, li) => {
          const a = first + (li + 0.5) * step;
          const r = base + 0.03 + (leafSeen / phaseSlots) * 0.076;
          leafSeen++;
          push(elbow(R2 + 8, kidAngle, R3, a), Math.max(kidR, r - 0.012), "var(--color-neutral-800)", 1.1);
          const na = ((a % 360) + 360) % 360;
          const left = na > 90 && na < 270;
          const [x, y] = pt(a, R3);
          const tag = /^(deny|ask|warn) ·/.test(lf.t);
          const col = lf.a ? "var(--color-accent-200)" : "var(--color-neutral-300)";
          leaves.push({
            t: lf.t,
            ws: "position:absolute;left:" + x.toFixed(1) + "px;top:" + y.toFixed(1) + "px;width:0;height:0;--r:" + r.toFixed(4) + ";opacity:" + rev(20),
            ds: "position:absolute;left:-3px;top:-3px;width:6px;height:6px;border-radius:2px;background:" + (lf.a || tag ? "var(--color-accent-500)" : "var(--color-neutral-600)"),
            ls: "position:absolute;left:0;top:0;width:296px;transform-origin:0 0;transform:rotate(" + (left ? a + 180 : a).toFixed(2) + "deg) translate(" + (left ? -13 : 13) + "px,-50%)" + (left ? " translateX(-100%)" : "") + ";text-align:" + (left ? "right" : "left") + ";font-family:" + (lf.c ? MONO : "var(--font-body)") + ";font-size:" + (lf.c ? "13px" : "14px") + ";line-height:1.32;letter-spacing:" + (lf.c ? "0" : ".005em") + ";color:" + col + ";text-wrap:pretty"
          });
        });
        slotI += n;

        const gna = ((kidAngle % 360) + 360) % 360;
        const gleft = gna > 90 && gna < 270;
        const [gx, gy] = pt(kidAngle, R2);
        groups.push({
          t: kid.t,
          ws: "position:absolute;left:" + gx.toFixed(1) + "px;top:" + gy.toFixed(1) + "px;width:0;height:0;--r:" + kidR.toFixed(4) + ";opacity:" + rev(26),
          ds: "position:absolute;left:-5px;top:-5px;width:10px;height:10px;transform:rotate(45deg);background:var(--color-accent-400);box-shadow:0 0 12px var(--color-accent-700)",
          ls: "position:absolute;left:0;top:0;width:198px;transform-origin:0 0;transform:rotate(" + (gleft ? kidAngle + 180 : kidAngle).toFixed(2) + "deg) translate(" + (gleft ? 14 : -14) + "px,-50%)" + (gleft ? "" : " translateX(-100%)") + ";text-align:" + (gleft ? "left" : "right") + ";font-family:var(--font-heading);font-weight:500;font-size:16.5px;line-height:1.26;letter-spacing:-.005em;color:var(--color-text);text-wrap:pretty"
        });
      });

      const pa = kidAngles.reduce((a, b) => a + b, 0) / kidAngles.length;
      ph.kids.forEach((kid, ki) => {
        const kidR = base + 0.014 + (ki / ph.kids.length) * 0.032;
        push(elbow(R1 + 40, pa, R2, kidAngles[ki]), kidR - 0.01, "var(--color-neutral-700)", 1.5);
      });
      const [rx, ry] = pt(pa, 132), [ex, ey] = pt(pa, R1 - 34);
      const rlen = Math.round(R1 - 34 - 132);
      edges.push({ d: "M" + rx.toFixed(1) + " " + ry.toFixed(1) + "L" + ex.toFixed(1) + " " + ey.toFixed(1), c: "var(--color-accent-600)", w: 2, s: "--r:" + (base - 0.008).toFixed(4) + ";stroke-dasharray:" + rlen + "px;stroke-dashoffset:calc(" + rlen + "px * (1 - " + rev(16) + "))" });

      const [px2, py2] = pt(pa, R1);
      phaseNodes.push({
        n: ph.n, name: ph.name, meta: ph.meta, a: pa, a0: sStart, a1: cursor + slotI * step,
        ws: "position:absolute;left:" + px2.toFixed(1) + "px;top:" + py2.toFixed(1) + "px;width:0;height:0;--r:" + (base + 0.002).toFixed(4) + ";opacity:" + rev(34) + ";display:flex;align-items:center;justify-content:center"
      });
    });

    phaseNodes.forEach((f) => { f.ws += ";transform:translate(-50%,-50%) scale(clamp(.88, calc(.88 + (var(--p,0) - var(--r)) * 9), 1))"; });

    const chords = [], chordLabels = [];
    CHORDS.forEach((ch, i) => {
      const a1 = angleOf(ch.from, step), a2 = angleOf(ch.to, step);
      const [x1, y1] = pt(a1, R2 - 16), [x2, y2] = pt(a2, R2 - 16);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const cx = C + (mx - C) * 0.18, cy = C + (my - C) * 0.18;
      const r = 0.875 + 0.012 + i * 0.022;
      chords.push({ d: "M" + x1.toFixed(1) + " " + y1.toFixed(1) + "Q" + cx.toFixed(1) + " " + cy.toFixed(1) + " " + x2.toFixed(1) + " " + y2.toFixed(1), s: "--r:" + r.toFixed(4) + ";opacity:calc(" + rev(14) + " * .95);animation:pkMarch 6s linear infinite" });
      const lx = 0.25 * x1 + 0.5 * cx + 0.25 * x2, ly = 0.25 * y1 + 0.5 * cy + 0.25 * y2;
      chordLabels.push({ t: ch.t, ws: "position:absolute;left:" + lx.toFixed(1) + "px;top:" + ly.toFixed(1) + "px;width:0;height:0;--r:" + (r + 0.008).toFixed(4) + ";opacity:" + rev(20) });
    });

    _lay = { edges, leaves, groups, phaseNodes, chords, chordLabels, slots };
    return _lay;
  }

  // Derive the zoom from the real viewport: half the shorter axis has to cover
  // the radial band we are looking at, with a readable floor and ceiling. No
  // side panel to dodge now, so the full width is available (not just 66% of it).
  function keyframes(vw, vh) {
    const L = layout();
    const half = Math.max(160, Math.min(vh, vw) / 2);
    const nearS = Math.max(0.36, Math.min(0.9, half / 300));
    const farS = Math.max(0.38, Math.min(0.95, half / 330));
    const nearR = 360, farR = 790;
    const kf = [{ at: 0, x: C, y: C, s: nearS }, { at: 0.05, x: C, y: C, s: nearS }];
    L.phaseNodes.forEach((f, i) => {
      const w = f.a1 - f.a0;
      const [nx, ny] = pt(f.a, nearR);
      const [ax, ay] = pt(f.a0 + w * 0.26, farR);
      const [bx, by] = pt(f.a0 + w * 0.78, farR);
      kf.push({ at: (i + 1.16) / SEGS, x: nx, y: ny, s: nearS });
      kf.push({ at: (i + 1.5) / SEGS, x: ax, y: ay, s: farS });
      kf.push({ at: (i + 1.9) / SEGS, x: bx, y: by, s: farS });
    });
    kf.push({ at: 0.95, x: C, y: C, s: "fit" });
    kf.push({ at: 1, x: C, y: C, s: "fit" });
    return kf;
  }

  function render() {
    const L = layout();
    edgesEl.innerHTML = L.edges.map((e) =>
      `<path d="${e.d}" fill="none" stroke="${e.c}" stroke-width="${e.w}" stroke-linecap="round" style="${e.s}"></path>`
    ).join("");
    chordsEl.innerHTML = L.chords.map((c) =>
      `<path d="${c.d}" fill="none" stroke="var(--color-accent-500)" stroke-width="1.6" stroke-dasharray="7 7" style="${c.s}"></path>`
    ).join("");
    leavesEl.innerHTML = L.leaves.map((n) =>
      `<div style="${n.ws}"><div style="${n.ds}"></div><div style="${n.ls}">${esc(n.t)}</div></div>`
    ).join("");
    groupsEl.innerHTML = L.groups.map((g) =>
      `<div style="${g.ws}"><div style="${g.ds}"></div><div style="${g.ls}">${esc(g.t)}</div></div>`
    ).join("");
    phaseNodesEl.innerHTML = L.phaseNodes.map((f) =>
      `<div style="${f.ws}"><div style="min-width:150px;max-width:186px;padding:11px 15px 12px;background:var(--color-surface);border:1px solid var(--color-neutral-800);box-shadow:0 0 0 1px var(--color-accent-900),0 10px 28px rgba(0,0,0,.45);border-radius:var(--radius-md,8px);display:flex;flex-direction:column;gap:5px"><span style="font-family:${MONO};font-size:11px;letter-spacing:.14em;color:var(--color-accent-400)">${esc(f.n)}</span><span style="font-family:var(--font-heading);font-weight:500;font-size:23px;line-height:1.05;letter-spacing:-.01em;color:var(--color-text)">${esc(f.name)}</span><span style="font-size:11.5px;letter-spacing:.06em;color:var(--color-neutral-500)">${esc(f.meta)}</span></div></div>`
    ).join("");
    chordLabelsEl.innerHTML = L.chordLabels.map((cl) =>
      `<div style="${cl.ws}"><div style="transform:translate(-50%,-50%);padding:4px 9px;background:var(--color-bg);border:1px solid var(--color-accent-800);border-radius:var(--radius-md,8px);font-family:${MONO};font-size:12px;letter-spacing:.06em;color:var(--color-accent-300);white-space:nowrap">${esc(cl.t)}</div></div>`
    ).join("");
    counterEl.textContent = L.leaves.length ? L.leaves.length + " leaves · 6 phases" : "6 phases · 25 groups";
  }

  const pkCfg = { autoplay: false, overview: false };
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      pkCfg.overview = !pkCfg.overview;
      toggleBtn.textContent = pkCfg.overview ? "Follow the story" : "See it whole";
    });
  }

  render();

  let autoplayT0 = 0;
  function frame(ts) {
    requestAnimationFrame(frame);
    let p;
    if (pkCfg.autoplay) {
      if (!autoplayT0) autoplayT0 = ts;
      p = Math.min(1, (((ts - autoplayT0) / 52000) % 1) * 1.12);
    } else {
      autoplayT0 = 0;
      const sy = window.scrollY || document.documentElement.scrollTop || 0;
      // offsetTop is relative to the nearest positioned ancestor (#how-it-works),
      // not the document — since that section sits partway down the page here
      // (unlike the standalone design canvas, where it was the only content),
      // that would badly undercount real scroll distance. Use an absolute
      // document position instead.
      const trackDocTop = track.getBoundingClientRect().top + sy;
      const span = track.offsetHeight - window.innerHeight;
      p = span > 0 ? Math.max(0, Math.min(1, (sy - trackDocTop) / span)) : 0;
    }
    stage.style.setProperty("--p", p.toFixed(4));
    if (bar) bar.style.height = (p * 100).toFixed(2) + "%";
    const box = stage.getBoundingClientRect();
    const fit = Math.min(box.width / 2260, box.height / 2260);
    const wide = Math.max(fit, 0.4);
    let fx = C, fy = C, s = wide;
    if (pkCfg.overview) {
      s = fit;
    } else {
      const kf = keyframes(box.width, box.height);
      let i = 0;
      while (i < kf.length - 1 && p > kf[i + 1].at) i++;
      const a = kf[i], b = kf[Math.min(i + 1, kf.length - 1)];
      const u = b.at === a.at ? 0 : ((t) => t * t * (3 - 2 * t))(Math.max(0, Math.min(1, (p - a.at) / (b.at - a.at))));
      const sa = a.s === "fit" ? wide : a.s, sb = b.s === "fit" ? wide : b.s;
      fx = a.x + (b.x - a.x) * u; fy = a.y + (b.y - a.y) * u; s = sa + (sb - sa) * u;
    }
    cam.style.transform = "scale(" + s.toFixed(4) + ") translate(" + (C - fx).toFixed(1) + "px," + (C - fy).toFixed(1) + "px)";
  }
  requestAnimationFrame(frame);
})();
