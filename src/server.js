import express from "express";
import { chromium } from "playwright";

const app = express();

// ---- Config (env) ----
// REQUIRED: shared secret to authenticate /run calls from your cron service
const CRON_SECRET = process.env.CRON_SECRET || "";
// OPTIONAL: default URL to visit if not provided via query param
const DEFAULT_TARGET_URL = process.env.TARGET_URL || "";
// Minutes to "stay" on the page
const STAY_MINUTES = Number(process.env.STAY_MINUTES || 14);
// Headless browser flags recommended for CI/serverless
const BROWSER_ARGS = [
  "--single-process",
  "--no-sandbox",
  "--disable-setuid-sandbox",
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

  let browser;
  try {
    // Launch headless Chromium
    browser = await chromium.launch({
      headless: true,
      args: BROWSER_ARGS,
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    // Go to target page; be lenient about slow sites
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });

    // Optional: small interaction to ensure the page is really "active"
    // await page.mouse.move(200, 200);

    // Stay on the page for the requested time
    await page.waitForTimeout(stayMs);

    // Done
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    state.lastFinishedAt = new Date();
    console.log(
      `[headless-visitor] Stayed on ${url} for ~${stayMinutes} min (started ${started.toISOString()})`,
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

  try {
    await visitAndStay(url, stayMinutes);
  } catch (err) {
    state.lastError = err?.message || String(err);
    console.error("[headless-visitor] Error:", err);
  } finally {
    state.running = false;
  }
}

// Health endpoint for Leapcell
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
 * It replies immediately (202) so cron-job.org doesn't hit its 30s timeout.
 * The headless work continues in the background for ~14 minutes.
 */
app.get("/run", async (req, res) => {
  const token = String(req.query.token || "");
  if (!CRON_SECRET || token !== CRON_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const url = String(req.query.url || DEFAULT_TARGET_URL || "");
  if (!url) return res.status(400).json({ ok: false, error: "Missing url" });

  // throttle: if a previous job is still running, don’t start a new one
  if (state.running) {
    return res
      .status(202)
      .json({ ok: true, accepted: false, message: "already running" });
  }

  // Kick off the work but respond fast
  inFlight = startJob(url, STAY_MINUTES);
  res.status(202).json({ ok: true, accepted: true, url, stayMinutes: STAY_MINUTES });
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`[headless-visitor] listening on :${port}`);
});

// Graceful shutdown
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    console.log(`[headless-visitor] received ${sig}, shutting down...`);
    await inFlight.catch(() => {});
    process.exit(0);
  });
}
