import express from "express";
import { chromium } from "playwright";

const app = express();

/**
 * === Config via env ===
 * CRON_SECRET      required: shared secret for /run
 * TARGET_URL       optional: default target if not passed as ?url=
 * STAY_MINUTES     optional: default 14
 * LAUNCH_TIMEOUT_MS optional: default 0 (no timeout) for stability
 * PORT             optional: default 8080
 * DEBUG            optional: set to 'pw:browser*' for Playwright startup logs
 */
const CRON_SECRET = process.env.CRON_SECRET || "";
const DEFAULT_TARGET_URL = process.env.TARGET_URL || "";
const STAY_MINUTES = Number(process.env.STAY_MINUTES ?? 14);
const LAUNCH_TIMEOUT_MS = Number(process.env.LAUNCH_TIMEOUT_MS ?? 0);
const PORT = Number(process.env.PORT || 8080);

// Robust flags for containerized headless Chromium
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

    // Optional visibility into page logs
    page.on("console", (msg) =>
      console.log(`[page] ${msg.type()}: ${msg.text()}`)
    );

    console.log(`[headless-visitor] navigating to ${url} ...`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });

    // Stay on page
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

async function startJob(url, stayMinutes) {
  if (state.running) {
    throw new Error("Job already running");
  }
  state.running = true;
  state.lastError = null;
  state.lastUrl = url;
  state.lastRunAt = new Date();
  console.log(`[headless-visitor] starting visit: ${url} for ${stayMinutes} min`);

  try {
    await visitAndStay(url, stayMinutes);
  } catch (err) {
    state.lastError = err?.message || String(err);
    console.error("[headless-visitor] Error:", err);
  } finally {
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
 *
 * Responds immediately (202 Accepted) so the cron service doesn't time out.
 * The long-running headless session continues in-process.
 */
app.get("/run", async (req, res) => {
  const token = String(req.query.token || "");
  if (!CRON_SECRET || token !== CRON_SECRET) {
    console.warn("[headless-visitor] /run unauthorized");
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const url = String(req.query.url || DEFAULT_TARGET_URL || "");
  if (!url) {
    return res.status(400).json({ ok: false, error: "Missing url" });
  }

  if (state.running) {
    console.log("[headless-visitor] /run received but a job is already running");
    return res
      .status(202)
      .json({ ok: true, accepted: false, message: "already running" });
  }

  console.log(`[headless-visitor] /run accepted for ${url}`);
  inFlight = startJob(url, STAY_MINUTES);
  res.status(202).json({ ok: true, accepted: true, url, stayMinutes: STAY_MINUTES });
});

app.listen(PORT, () => {
  console.log(`[headless-visitor] listening on :${PORT}`);
});

// Graceful shutdown
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    console.log(`[headless-visitor] received ${sig}, shutting down...`);
    await inFlight.catch(() => {});
    process.exit(0);
  });
}

// Make sure unhandled rejections don’t bring the process down silently
process.on("unhandledRejection", (err) => {
  console.error("[headless-visitor] UnhandledRejection:", err);
});
