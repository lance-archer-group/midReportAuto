#!/usr/bin/env node
/*
  Smoke test (ESM): validates .env + selectors + MFA email retrieval for Elevate portal
  Steps:
    1) Validate .env and selectors.json
    2) Optional IMAP TLS preflight (fast diagnose of ETIMEOUT)
    3) Open login page and submit creds (with retries)
    4) If 2FA screen is detected, fetch newest unread MFA code via IMAP
    5) Write env-smoke-summary.json and exit non‑zero on failure

  Usage:
    node env-smoke.test.js
*/

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { chromium } from 'playwright';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import tls from 'tls';

dotenv.config();

// ===== ESM __dirname polyfill ==============================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== Helpers ===============================================================
function bool(v, d = true) { if (v == null || v === '') return d; return /^(true|1|yes|on)$/i.test(String(v)); }
function env(key, fallback) { const v = process.env[key]; return v == null || v === '' ? fallback : v; }
function num(key, fallback) { const v = Number(process.env[key]); return Number.isFinite(v) ? v : fallback; }

function fail(msg, extra = {}) { return { ok: false, msg, ...extra }; }
function ok(msg, extra = {}) { return { ok: true, msg, ...extra }; }
async function countSelectedMids(page) {
  const sel = SELECTORS.reporting;
  if (!sel?.mid_chip) return null; // can’t count
  return page.locator(sel.mid_chip).count().catch(() => null);
}

const ROOT = __dirname;
const SELECTORS_FILE = env('SELECTORS_FILE', 'selectors.json');
const SELECTORS_PATH = path.join(ROOT, SELECTORS_FILE);

// ===== Validate .env & selectors ============================================
function validateEnv() {
  const problems = [];
  const required = [
    'ELEVATE_BASE', 'ELEVATE_USERNAME', 'ELEVATE_PASSWORD',
    'IMAP_HOST', 'IMAP_USER', 'IMAP_PASS', 'IMAP_MAILBOX',
    'IMAP_FROM_FILTER', 'IMAP_SUBJECT_FILTER', 'IMAP_CODE_REGEX'
  ];
  for (const k of required) if (!process.env[k] || String(process.env[k]).trim() === '') problems.push(`Missing ${k}`);

  const numericDefaults = {
    NAV_TIMEOUT_MS: 15000,
    LOGIN_RETRIES: 3,
    LOGIN_BACKOFF_MS: 2000,
    MFA_READY_WAIT_MS: 1000,
    IMAP_PORT: 993,
    IMAP_LOOKBACK_MINUTES: 20,
    IMAP_POLL_MS: 3000,
    IMAP_MAX_POLLS: 40,
    IMAP_CONN_TIMEOUT_MS: 15000,
    IMAP_SOCKET_TIMEOUT_MS: 30000,
    IMAP_AUTH_TIMEOUT_MS: 15000,
    SLOWMO_MS: 0
  };
  for (const [k] of Object.entries(numericDefaults)) {
    const v = process.env[k];
    if (v != null && v !== '' && !Number.isFinite(Number(v))) problems.push(`Invalid number for ${k}: ${v}`);
  }

  // Selectors file present and has login selectors
  if (!fs.existsSync(SELECTORS_PATH)) problems.push(`Missing selectors file: ${SELECTORS_PATH}`);
  let loginSel = null;
  let selectors = null;
  if (fs.existsSync(SELECTORS_PATH)) {
    try {
      const raw = fs.readFileSync(SELECTORS_PATH, 'utf-8');
      selectors = JSON.parse(raw);
      loginSel = selectors.login;
      if (!loginSel || !loginSel.username || !loginSel.password || !loginSel.submit) {
        problems.push('selectors.json must include login.username, login.password, login.submit');
      }
    } catch (e) {
      problems.push(`selectors.json parse error: ${e.message}`);
    }
  }

  return { problems, loginSel, selectors };
}

// ===== TLS preflight (diagnose ETIMEOUT early) ===============================
async function preflightImap(host, port, servername, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername: servername || host,
      rejectUnauthorized: true,
      timeout: timeoutMs
    }, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', reject);
    socket.on('timeout', () => reject(new Error('TLS preflight timeout')));
  });
}

// ===== IMAP newest-unread MFA code ==========================================
async function fetchNewestMfaCode() {
  const client = new ImapFlow({
    host: env('IMAP_HOST'),
    port: num('IMAP_PORT', 993),
    secure: bool(env('IMAP_SECURE'), true),
    auth: { user: env('IMAP_USER'), pass: env('IMAP_PASS') },
    logger: false,
    // harden timeouts
    socketTimeout: num('IMAP_SOCKET_TIMEOUT_MS', 30000),
    greetingTimeout: num('IMAP_CONN_TIMEOUT_MS', 15000),
    authTimeout: num('IMAP_AUTH_TIMEOUT_MS', 15000),
    // TLS tweaks
    tls: { servername: env('IMAP_TLS_SERVERNAME', env('IMAP_HOST')) }
  });
  const mailbox = env('IMAP_MAILBOX', 'INBOX');
  const fromFilter = env('IMAP_FROM_FILTER');
  const subjectFilter = env('IMAP_SUBJECT_FILTER');
  const codeRegex = new RegExp(env('IMAP_CODE_REGEX', '(?<!\\d)\\d{6}(?!\\d)'));
  const lookbackMinutes = num('IMAP_LOOKBACK_MINUTES', 20);
  const pollMs = num('IMAP_POLL_MS', 3000);
  const maxPolls = num('IMAP_MAX_POLLS', 40);
  const onlyUnseen = bool(env('IMAP_ONLY_UNSEEN'), true);

  const sinceDate = new Date(Date.now() - lookbackMinutes * 60 * 1000);
  try {
    await client.connect();
  } catch (e) {
    const hint = (e?.code === 'ETIMEDOUT' || /timeout/i.test(e?.message || ''))
      ? 'Timed out connecting to IMAP. Check firewall/VPN, host/port, and that IMAP is enabled.'
      : 'IMAP connect failed. Verify IMAP_HOST/PORT/SECURE and credentials/app password.';
    throw new Error(`${hint} (${e?.code || 'ERR'})`);
  }

  try {
    for (let attempt = 1; attempt <= maxPolls; attempt++) {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const query = { since: sinceDate };
        if (fromFilter) query.from = fromFilter;
        if (subjectFilter) query.subject = subjectFilter;
        if (onlyUnseen) query.seen = false;

        let uids = await client.search(query);
        if (onlyUnseen && uids.length === 0) { const q2 = { ...query }; delete q2.seen; uids = await client.search(q2); }
        uids.sort((a, b) => b - a);
        const toCheck = uids.slice(0, 20);
        for await (const msg of client.fetch(toCheck, { envelope: true, source: true, flags: true })) {
          const parsed = await simpleParser(msg.source);
          const body = `${parsed.subject || ''}\n${parsed.text || ''}\n${parsed.html || ''}`;
          const m = body.match(codeRegex);
          if (m) {
            return {
              code: m[0],
              envelope: {
                from: parsed.from?.text || null,
                subject: parsed.subject || null,
                date: parsed.date ? new Date(parsed.date).toISOString() : null,
                messageId: parsed.messageId || null
              }
            };
          }
        }
      } finally {
        await lock.release();
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
    throw new Error('2FA code not found via IMAP');
  } finally {
    try { await client.logout(); } catch {}
  }
}

// ===== Playwright login w/ retries (no 2FA submit in this smoke) ============
async function twofaScreenPresent(page, selectors) {
  if (selectors.twofa?.code_input) {
    const c = await page.locator(selectors.twofa.code_input).count().catch(()=>0);
    if (c > 0) return true;
  }
  if (selectors.twofa?.digit_inputs) {
    const c = await page.locator(selectors.twofa.digit_inputs).count().catch(()=>0);
    if (c >= 4) return true;
  }
  const guess = 'input[autocomplete="one-time-code"], input[name*="code" i], input[id*="code" i], input[aria-label*="code" i]';
  const gcount = await page.locator(guess).count().catch(()=>0);
  return gcount > 0;
}

async function loginOnce(page, selectors) {
  const base = env('ELEVATE_BASE', 'https://portal.elevateqs.com');
  const navState = env('LOAD_STATE', 'domcontentloaded');
  const navTimeout = num('NAV_TIMEOUT_MS', 15000);

  await page.goto(base, { waitUntil: navState }).catch(()=>{});
  const loginPaths = env('LOGIN_PATHS', '/Account/Login,/login,/Login.aspx,/Account/LogOn,/Account/SignIn')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!/login/i.test(page.url())) {
    for (const suffix of loginPaths) {
      const u = base.replace(/\/$/, '') + suffix;
      try {
        await page.goto(u, { waitUntil: navState, timeout: navTimeout });
        const title = await page.title().catch(()=> '');
        if (/login|signin|account/i.test(title) || /login/i.test(page.url())) break;
      } catch {}
    }
  }

  const username = env('ELEVATE_USERNAME');
  const password = env('ELEVATE_PASSWORD');
  await page.locator(selectors.login.username).first().fill(username, { timeout: navTimeout });
  await page.locator(selectors.login.password).first().fill(password, { timeout: navTimeout });
  await Promise.all([
    page.waitForNavigation({ waitUntil: navState, timeout: navTimeout }).catch(()=>{}),
    page.locator(selectors.login.submit).first().click({ timeout: navTimeout })
  ]);
}

async function loginWithRetries(selectors, browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const attempts = num('LOGIN_RETRIES', 3);
  const backoff = num('LOGIN_BACKOFF_MS', 2000);
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      if (i > 1) await page.waitForTimeout(backoff);
      await loginOnce(page, selectors);
      return { context, page };
    } catch (e) {
      lastErr = e;
      console.warn(`Login attempt ${i}/${attempts} failed:`, e?.message || e);
    }
  }
  await context.close();
  throw lastErr || new Error('Login failed after retries');
}

// ===== Main =================================================================
(async function main() {
  const summary = { steps: [], ok: true };
  const { problems, loginSel, selectors } = validateEnv();
  if (problems.length) {
    summary.ok = false;
    summary.steps.push(fail('Environment/selector validation failed', { problems }));
    console.log(JSON.stringify(summary, null, 2));
    process.exit(1);
  } else {
    summary.steps.push(ok('Environment/selector validation passed'));
  }

  // Optional IMAP TLS preflight to catch ETIMEOUT early
  try {
    await preflightImap(
      env('IMAP_HOST'),
      num('IMAP_PORT', 993),
      env('IMAP_TLS_SERVERNAME', env('IMAP_HOST')),
      num('IMAP_CONN_TIMEOUT_MS', 15000)
    );
    summary.steps.push(ok('IMAP TLS preflight passed'));
  } catch (e) {
    summary.steps.push(fail('IMAP TLS preflight failed', { error: e?.message || String(e) }));
    // continue so you can still observe the browser flow
  }

  // Browser open & login (allow visual debug with HEADLESS=false and SLOWMO_MS)
  const browser = await chromium.launch({ headless: bool(env('HEADLESS', 'true')), slowMo: num('SLOWMO_MS', 0) });
  let ctx, page;
  try {
    ({ context: ctx, page } = await loginWithRetries({ login: loginSel, twofa: selectors.twofa || {} }, browser));
    summary.steps.push(ok('Login form submitted; navigation occurred'));

    // Brief wait for 2FA prompt
    const mfaWait = num('MFA_READY_WAIT_MS', 1000);
    await page.waitForTimeout(mfaWait);
    const has2fa = await twofaScreenPresent(page, selectors);
    summary.steps.push(ok('2FA screen present check complete', { detected: has2fa }));

    // If 2FA required, verify we can fetch a code
    if (has2fa) {
      const { code, envelope } = await fetchNewestMfaCode();
      if (!code) throw new Error('No MFA code extracted');
      const masked = code.replace(/^(.*)(..)$/, '******$2');
      summary.steps.push(ok('MFA code fetched from IMAP', { code_masked: masked, envelope }));
    }

    summary.ok = true;
  } catch (e) {
    summary.ok = false;
    summary.steps.push(fail('Smoke test error', { error: e?.message || String(e) }));
  } finally {
    if (ctx) await ctx.close();
    await browser.close();
  }

  // Write summary file + stdout
  const outPath = path.join(ROOT, 'env-smoke-summary.json');
  try { fs.writeFileSync(outPath, JSON.stringify(summary, null, 2)); } catch {}
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? 0 : 1);
})();
