const { chromium } = require('playwright');
const { Hono } = require('hono');
const { serve } = require('@hono/node-server');

const app = new Hono();

app.get('/', async (c) => {
  // Authorization check
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || authHeader !== `Bearer ${cronSecret}`) {
      return c.text('Unauthorized', 401);
    }
  }

  const targetUrl = process.env.TARGET_URL || 'https://example.com';
  const stayTime = parseInt(process.env.STAY_TIME || '840000'); // 14 mins in ms
  
  // Launch browser in background
  (async () => {
    let browser;
    try {
      browser = await chromium.launch({ 
        args: ['--single-process', '--no-sandbox'] 
      });
      const page = await browser.newPage();
      
      // Configure timeout and navigation
      await page.setDefaultNavigationTimeout(900000); // 15 mins
      await page.goto(targetUrl, { 
        waitUntil: 'domcontentloaded',
        timeout: 900000 
      });
      
      // Stay on page for 14 minutes
      await page.waitForTimeout(stayTime);
      
      console.log(`Visited ${targetUrl} for ${stayTime/1000}s`);
    } catch (error) {
      console.error('Execution failed:', error);
    } finally {
      if (browser) await browser.close();
    }
  })();

  return c.text('Headless browser task started');
});

const port = process.env.PORT || 8080;
serve({ fetch: app.fetch, port }).on('listening', () => {
  console.log(`Server running on port ${port}`);
});
