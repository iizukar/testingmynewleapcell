import express from "express";
import { chromium } from "playwright";

const app = express();

/**
 * === Config via env ===
 * CRON_SECRET          required: shared secret for /run
 * TARGET_URL           optional: default target if not provided via ?url=
 * STAY_MINUTES         optional: default 14
 * LAUNCH_TIMEOUT_MS    optional: default 0 (no timeout)
 * PORT                 optional: default 8080
 * KEEPALIVE_URL        optional: full URL to ping during a run (defaults to https://<host>/healthz)
 * KEEPALIVE_INTERVAL_MS optional: default 45000 (45s)
 * DEBUG                optional: set to 'pw:browser*' for Playwright startup logs
 */
const CRON_SECRET = process.env.CRON_SECRET || "";
const DEFAULT_TARGET_URL = process.env.TARGET_URL || "";
const STAY_MINUTES = Number(process.env.STAY_MINUTES ?? 14);
const LAUNCH_TIMEOUT_MS = Number(process.env.LAUNCH_TIMEOUT_MS ?? 0);
const PORT = Number(process.env.PORT || 8080);
const KEEPALIVE_INTERVAL_MS = Number(process.env.KEEPALIVE_INTERVAL_MS ?? 45000);

const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-zygote",
  "--disable-software-rasterizer",
];

let state = {
  running: false,
  lastRunAt: null,
  lastFinishedAt: null,
  lastUrl: null,
  lastError: null,
};

// --- keepalive helper: ping our own service while a job runs ---
function startKeepAlive(url) {
  if (!url) return () => {};
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
    } catch (e) {
      console.log(`[keepalive] ping failed: ${e?.message || e}`);
    } finally {
      if (!stopped) setTimeout(tick, KEEPALIVE_INTERVAL_MS);
    }
  };
  tick();
  return () => { stopped = true; };
}

async function visitAndStay(url, stayMinutes) {
  const stayMs = stayMinutes * 60 * 1000;
  const started = new Date();
  console.log(`[headless-visitor] launching browser (timeout=${LAUNCH_TIMEOUT_MS}ms) ...`);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: BROWSER_ARGS,
      timeout: LAUNCH_TIMEOUT_MS, // 0 = no timeout
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();
    page.on("console", (msg) =>
      console.log(`[page] ${msg.type()}: ${msg.text()}`)
    );

    console.log(`[headless-visitor] navigating to ${url} ...`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });

    console.log(`[headless-visitor] staying on page ~${stayMinutes} min ...`);
    await page.waitForTimeout(stayMs);

    console.log(`[headless-visitor] done staying on page.`);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    state.lastFinishedAt = new Date();
    console.log(
      `[headless-visitor] Stayed on ${url} for ~${stayMinutes} min (started ${started.toISOString()})`
    );
  }
}

let inFlight = Promise.resolve();

async function startJob(url, stayMinutes, keepaliveUrl) {
  if (state.running) throw new Error("Job already running");
  state.running = true;
  state.lastError = null;
  state.lastUrl = url;
  state.lastRunAt = new Date();
  console.log(`[headless-visitor] starting visit: ${url} for ${stayMinutes} min`);

  // keep the instance from being considered "idle" while we work
  const stopKeepAlive = startKeepAlive(keepaliveUrl);

  try {
    await visitAndStay(url, stayMinutes);
  } catch (err) {
    state.lastError = err?.message || String(err);
    console.error("[headless-visitor] Error:", err);
  } finally {
    stopKeepAlive();
    state.running = false;
  }
}

// Health endpoint for platform probes
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Human/status endpoint
app.get("/status", (_req, res) => {
  res.json({
    running: state.running,
    lastRunAt: state.lastRunAt,
    lastFinishedAt: state.lastFinishedAt,
    lastUrl: state.lastUrl,
    lastError: state.lastError,
    stayMinutes: STAY_MINUTES,
  });
});

/**
 * Trigger endpoint for cron-job.org:
 *   GET /run?token=YOUR_SECRET[&url=https://example.com]
 * Responds 202 immediately; headless work continues in-process.
 */
app.get("/run", async (req, res) => {
  const token = String(req.query.token || "");
  if (!CRON_SECRET || token !== CRON_SECRET) {
    console.warn("[headless-visitor] /run unauthorized");
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const url = String(req.query.url || DEFAULT_TARGET_URL || "");
  if (!url) return res.status(400).json({ ok: false, error: "Missing url" });

  if (state.running) {
    console.log("[headless-visitor] /run received but a job is already running");
    return res.status(202).json({ ok: true, accepted: false, message: "already running" });
  }

  // Build keepalive target: explicit env wins, else derive from Host header
  const host = req.get("x-forwarded-host") || req.get("host");
  const scheme = (req.headers["x-forwarded-proto"] || req.protocol || "https");
  const derivedKeepalive = host ? `${scheme}://${host}/healthz` : "";
  const keepaliveUrl = process.env.KEEPALIVE_URL || derivedKeepalive;

  console.log(`[headless-visitor] /run accepted for ${url}`);
  if (keepaliveUrl) console.log(`[keepalive] will ping ${keepaliveUrl} every ${KEEPALIVE_INTERVAL_MS}ms`);

  inFlight = startJob(url, STAY_MINUTES, keepaliveUrl);
  res.status(202).json({ ok: true, accepted: true, url, stayMinutes: STAY_MINUTES });
});

app.listen(PORT, () => {
  console.log(`[headless-visitor] listening on :${PORT}`);
});

// Graceful shutdown: finish current job if possible
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    console.log(`[headless-visitor] received ${sig}, shutting down...`);
    await inFlight.catch(() => {});
    process.exit(0);
  });
}

process.on("unhandledRejection", (err) => {
  console.error("[headless-visitor] UnhandledRejection:", err);
});
