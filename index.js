console.log('[STARTUP] Loading scraper...');

require('dotenv').config({ override: true });
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const https = require('https');
const querystring = require('querystring');

console.log('[STARTUP] Modules loaded');

const LISTING_URL = 'https://order.mandarake.co.jp/order/listPage/list?categoryCode=1002';
const PUSHOVER_URL = 'https://order.mandarake.co.jp/order/listPage/list?categoryCode=1002&lang=en';
const STORAGE_FILE = path.join(__dirname, 'last_listing.json');
const CHECK_INTERVAL_MIN_MS = 46 * 1000;
const CHECK_INTERVAL_MAX_MS = 90 * 1000;
const USE_LOCAL_HTML = process.env.USE_LOCAL_HTML === 'true'; // For testing
const SHOW_BROWSER = process.env.SHOW_BROWSER === 'true'; // Visual debug mode
const MANUAL_LIVE_MODE = process.env.MANUAL_LIVE_MODE === 'true'; // Let user navigate live browser manually
const VISUAL_PAUSE_MS = Number(process.env.VISUAL_PAUSE_MS || 8000);
const MANUAL_WAIT_MS = Number(process.env.MANUAL_WAIT_MS || 300000);
const BROWSER_PROFILE_DIR = path.join(__dirname, '.chrome-profile');
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

const PUSHOVER_USER = process.env.PUSHOVER_USER;
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN;

console.log('[STARTUP] PUSHOVER_USER set:', !!PUSHOVER_USER);
console.log('[STARTUP] PUSHOVER_TOKEN set:', !!PUSHOVER_TOKEN);
console.log('[STARTUP] USE_LOCAL_HTML:', USE_LOCAL_HTML);
console.log('[STARTUP] SHOW_BROWSER:', SHOW_BROWSER);

if (!PUSHOVER_USER || !PUSHOVER_TOKEN) {
  console.error('Missing PUSHOVER_USER or PUSHOVER_TOKEN environment variables. See .env.example');
  process.exit(1);
}

let browser = null;
let livePage = null;

async function initBrowser() {
  if (!browser) {
    console.log('[BROWSER] Launching browser with stealth mode...');
    console.log('[BROWSER] Visible window:', SHOW_BROWSER);
    console.log('[BROWSER] Chromium path:', CHROMIUM_PATH);
    browser = await puppeteer.launch({ 
      headless: SHOW_BROWSER ? false : 'new',
      executablePath: CHROMIUM_PATH,
      userDataDir: BROWSER_PROFILE_DIR,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check'
      ],
      defaultViewport: { width: 1280, height: 720 }
    });
    console.log('[BROWSER] Browser launched');
  }
  return browser;
}

async function getLivePage() {
  if (livePage && !livePage.isClosed()) {
    return livePage;
  }

  const br = await initBrowser();
  const pages = await br.pages();
  livePage = pages.length > 0 ? pages[0] : await br.newPage();
  await livePage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  return livePage;
}

async function fetchFirstListing() {
  try {
    let html;
    
    if (USE_LOCAL_HTML) {
      // Load from sample HTML for testing
      const sampleFile = path.join(__dirname, 'japanese html.html');
      console.log('[FETCH] Reading from local file:', sampleFile);
      html = fs.readFileSync(sampleFile, 'utf8');
      console.log('[FETCH] Loaded local HTML, length:', html.length);
    } else {
      // Fetch from live site
      console.log('[FETCH] Starting fetch from', LISTING_URL);
      const page = await getLivePage();

      try {
        if (SHOW_BROWSER && MANUAL_LIVE_MODE) {
          console.log('[FETCH] Manual live mode enabled. Use the open browser to navigate to the Japanese listings page.');
          console.log('[FETCH] Waiting up to', MANUAL_WAIT_MS, 'ms for the listings page to appear...');

          if (page.url() === 'about:blank') {
            await page.goto('https://order.mandarake.co.jp/', { waitUntil: 'domcontentloaded', timeout: 40000 });
          }

          try {
            await page.waitForFunction(
              (targetUrl) => window.location.href.includes(targetUrl) || document.querySelector('[data-itemidx]') !== null,
              { timeout: MANUAL_WAIT_MS },
              '/order/listPage/list?categoryCode=1002'
            );
          } catch (e) {
            console.log('[FETCH] Manual live mode timed out before listings appeared.');
            return null;
          }

          console.log('[FETCH] Manual live mode detected URL:', page.url());
        } else {
          const response = await page.goto(LISTING_URL, { waitUntil: 'networkidle2', timeout: 40000 });
          console.log('[FETCH] Page response status:', response.status());
          console.log('[FETCH] Current page URL:', page.url());
        }

        console.log('[FETCH] Waiting for listings to load...');

        // Wait for the listing container to appear
        try {
          await page.waitForSelector('.thumlarge .block[data-itemidx]', { timeout: 30000 });
          await page.waitForFunction(
            () => document.querySelectorAll('.thumlarge .block[data-itemidx]').length > 0,
            { timeout: 30000 }
          );
          console.log('[FETCH] Listings detected, waiting for render...');
        } catch (e) {
          console.log('[FETCH] Timeout waiting for listings, continuing anyway...');
        }

        await page.evaluate(() => window.scrollTo(0, 0));

        // Wait extra time for any dynamic content
        await new Promise(resolve => setTimeout(resolve, 5000));
        console.log('[FETCH] Render wait complete');

        html = await page.content();
        console.log('[FETCH] Content length:', html.length);

        // Save to file for debugging
        try {
          fs.writeFileSync(path.join(__dirname, 'debug-fetch.html'), html, 'utf8');
          console.log('[FETCH] Saved HTML to debug-fetch.html');
        } catch (e) {
          console.log('[FETCH] Could not save debug HTML');
        }

        if (SHOW_BROWSER) {
          console.log('[FETCH] Visual mode pause (ms):', VISUAL_PAUSE_MS);
          await new Promise(resolve => setTimeout(resolve, VISUAL_PAUSE_MS));
        }
      } finally {
        if (page && !page.isClosed()) {
          await page.close();
          livePage = null;
          console.log('[FETCH] Closed live browser tab');
        }
      }
    }
    
    const $ = cheerio.load(html);
    
    // Log what we can find
    const allDataItems = $('[data-itemidx]');
    console.log('[FETCH] [data-itemidx] elements found:', allDataItems.length);
    
    const allThum = $('.thumlarge');
    console.log('[FETCH] .thumlarge elements found:', allThum.length);

    // Try the original selector
    let first = $('.thumlarge .block[data-itemidx]').first();
    console.log('[FETCH] Found .thumlarge .block[data-itemidx]:', first.length > 0);
    
    if (!first || first.length === 0) {
      first = $('[data-itemidx]').first();
      console.log('[FETCH] Fallback to [data-itemidx]:', first.length > 0);
    }
    
    if (!first || first.length === 0) {
      console.log('[FETCH] No listings found');
      return null;
    }

    const id = first.attr('data-itemidx') || null;
    const title = first.find('.title a').text().trim();
    const price = first.find('.price p').text().trim();
    const href = first.find('.title a').attr('href') || '';

    console.log('[FETCH] Extracted - ID:', id, 'Title:', title.substring(0, 60), 'Price:', price);
    
    return { id, title, price, href };
  } catch (err) {
    console.error('[FETCH] Error:', err.message);
    return null;
  }
}

function loadLast() {
  try {
    if (!fs.existsSync(STORAGE_FILE)) return null;
    const data = fs.readFileSync(STORAGE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading storage:', err.message);
    return null;
  }
}

function saveLast(listing) {
  try {
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(listing, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing storage:', err.message);
  }
}

async function sendPushover(listing) {
  try {
    const payload = querystring.stringify({
      token: PUSHOVER_TOKEN,
      user: PUSHOVER_USER,
      title: 'New Mandarake Listings',
      message: 'New listings have been found at Mandarake',
      url: PUSHOVER_URL,
      url_title: 'View Mandarake Listings'
    });

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.pushover.net',
        port: 443,
        path: '/1/messages.json',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          console.log('Pushover sent for:', listing.title || listing.id);
          resolve();
        });
      });

      req.on('error', (err) => {
        console.error('Pushover error:', err.message);
        reject(err);
      });

      req.write(payload);
      req.end();
    });
  } catch (err) {
    console.error('Pushover error:', err.message);
  }
}

async function checkOnce() {
  const current = await fetchFirstListing();
  if (!current) {
    console.log('[CHECK] Failed to fetch listing');
    return;
  }

  console.log('[CHECK] First listing: ' + current.title + ' (' + current.price + ')');

  const last = loadLast();

  // Compare by item id when available, otherwise compare title+price
  const changed = !last || (current.id && last.id && current.id !== last.id) || (!current.id && !last.id && (current.title !== last.title || current.price !== last.price));

  if (changed) {
    console.log('Change detected. Previous:', last ? (last.id || last.title) : 'none', 'Current:', current.id || current.title);
    await sendPushover(current);
    saveLast(current);
  } else {
    console.log('No change. First listing unchanged.');
  }
}

function getNextCheckDelayMs() {
  return Math.floor(
    CHECK_INTERVAL_MIN_MS + Math.random() * (CHECK_INTERVAL_MAX_MS - CHECK_INTERVAL_MIN_MS)
  );
}

async function runCheckLoop() {
  await checkOnce();

  const nextDelay = getNextCheckDelayMs();
  console.log(`[SCHEDULE] Next check in ${Math.round(nextDelay / 1000)}s`);
  setTimeout(runCheckLoop, nextDelay);
}

// Run immediately once, then at a random interval between 46 and 90 seconds
(async () => {
  try {
    console.log('[STARTUP] Starting Mandarake scraper — checking every 46-90s');
    
    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('[SHUTDOWN] Closing browser...');
      if (livePage && !livePage.isClosed()) await livePage.close();
      if (browser) await browser.close();
      process.exit(0);
    });
    
    await runCheckLoop();
  } catch (err) {
    console.error('[STARTUP ERROR] Uncaught error:', err);
    process.exit(1);
  }
})();
