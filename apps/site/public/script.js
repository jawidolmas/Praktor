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
  const outs = ["heroOut1", "heroOut2", "heroOut3"].map((id) => document.getElementById(id));
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

async function runDemo() {
  if (!demoBody || demoRunning) return;
  demoRunning = true;
  if (replayBtn) replayBtn.disabled = true;
  demoBody.innerHTML = "";

  for (const step of DEMO_SCRIPT) {
    const { el, span, isCmd } = demoLine(step.type, step.text);
    demoBody.appendChild(el);
    demoBody.scrollTop = demoBody.scrollHeight;
    if (isCmd) {
      await new Promise((resolve) => typeInto(span, step.text, 22, resolve));
      await new Promise((r) => setTimeout(r, 250));
    } else {
      span.textContent = step.text;
      await new Promise((r) => setTimeout(r, 420));
    }
  }

  demoRunning = false;
  if (replayBtn) replayBtn.disabled = false;
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
