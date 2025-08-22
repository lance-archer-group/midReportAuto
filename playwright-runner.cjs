#!/usr/bin/env node
/* eslint-disable no-console */

// ===== Imports & Setup =======================================================
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
require('dotenv').config();
const http = require('http');
// Optional IMAP for 2FA
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
}
// ===== Env helpers ===========================================================
function bool(v, d = true) {
  if (v == null || v === '') return d;
  return /^(true|1|yes|on)$/i.test(String(v));
}
function env(key, fallback) {
  const v = process.env[key];
  return v == null || v === '' ? fallback : v;
}
function numEnv(key, fallback) {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
}
// ===== Email helper ==========================================================
const nodemailer = require('nodemailer');

/**
 * Email a file attachment (the single combined export).
 * Respects EMAIL_ENABLED=false to noop in dev.
 */

async function emailReport(fileArg, overrides = {}) {
  try {
    const to = env('EMAIL_TO', '');
    if (!to) {
      console.log('[EMAIL] EMAIL_TO not set — skipping send.');
      return;
    }

    // Prefer explicit SMTP_*; fall back to IMAP_* you already use for 2FA
    const host = env(
      'SMTP_HOST',
      env('IMAP_HOST', 'smtp.gmail.com').replace(/^imap\./i, 'smtp.')
    );
    const port = numEnv('SMTP_PORT', 465);
    const secure = bool(env('SMTP_SECURE', 'true'), true);
    const user = env('SMTP_USER', env('IMAP_USER'));
    const pass = env('SMTP_PASS', env('IMAP_PASS'));
    const from = env('EMAIL_FROM', user);

    // ---- normalize attachment input ----
    let filePath = null;
    if (typeof fileArg === 'string') {
      filePath = fileArg;
    } else if (
      fileArg &&
      typeof fileArg === 'object' &&
      typeof fileArg.path === 'string'
    ) {
      filePath = fileArg.path;
    } else {
      throw new Error(
        'emailReport() expected a string file path or { path: string }'
      );
    }

    // ensure it exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`Attachment not found on disk: ${filePath}`);
    }

    const filename = overrides.filename || path.basename(filePath);
    const subject =
      overrides.subject ||
      env(
        'EMAIL_SUBJECT',
        `Net ACH Export ${new Date().toISOString().slice(0, 10)}`
      );
    const text =
      overrides.text || env('EMAIL_BODY', 'Attached is the Net ACH export.');
    const contentType =
      path.extname(filename).toLowerCase() === '.xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : undefined;

    console.log('[EMAIL] preparing send', {
      host,
      port,
      secure,
      to,
      from,
      filename,
    });

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });

    const info = await transporter.sendMail({
      from,
      to,
      subject,
      text,
      attachments: [{ filename, path: filePath, contentType }],
    });

    console.log(`[EMAIL] sent ok: messageId=${info.messageId}`);
  } catch (err) {
    console.error('[EMAIL] send failed:', err.message || err);
  }
}
// ===== Paths / Project files (env-driven) ====================================
const ROOT = __dirname;
const OUTPUT_DIR = env('OUTPUT_DIR', 'reports');
const ERROR_DIR = env('ERROR_DIR', 'error_shots');
const OUT_ROOT = path.join(ROOT, OUTPUT_DIR);
const ERROR_SHOTS = path.join(ROOT, ERROR_DIR);

const MERCHANTS_FILE = env('MERCHANTS_FILE', 'merchants.json');
const SELECTORS_FILE = env('SELECTORS_FILE', 'selectors.json');

const MERCHANTS_PATH = path.join(ROOT, MERCHANTS_FILE);
const SELECTORS_PATH = path.join(ROOT, SELECTORS_FILE);

if (!fs.existsSync(SELECTORS_PATH)) {
  console.error(`Missing selectors file: ${SELECTORS_PATH}`);
  process.exit(1);
}
const SELECTORS = require(SELECTORS_PATH);

// ===== Utilities =============================================================
function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9_.-]/g, '_');
}

// --- Timezone-aware date helpers (daily EST/EDT) ----------------------------
const DATE_TZ = env('DATE_TZ', 'America/New_York');
const DATE_MODE = env('DATE_MODE', 'yesterday'); // yesterday | today | custom

function nyParts(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: DATE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [y, m, d] = fmt.format(date).split('-').map(Number);
  return { y, m, d };
}
function nyStartOfDay(date) {
  const { y, m, d } = nyParts(date);
  return new Date(Date.UTC(y, m - 1, d, 5, 0, 0)); // anchor; display uses TZ
}
function formatDateForPortal(date) {
  const fmt = env('DATE_FORMAT', 'YMD').toUpperCase();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DATE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const obj = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const ymd = `${obj.year}-${obj.month}-${obj.day}`;
  return fmt === 'YMD' ? ymd : `${obj.month}/${obj.day}/${obj.year}`;
}
function getDateRange() {
  const startEnv = process.env.START;
  const endEnv = process.env.END;
  if (startEnv || endEnv) {
    const s = startEnv ? new Date(startEnv) : new Date();
    const e = endEnv ? new Date(endEnv) : s;
    if (isNaN(s)) throw new Error(`Invalid START date: ${startEnv}`);
    if (isNaN(e)) throw new Error(`Invalid END date: ${endEnv}`);
    return { start: s, end: e };
  }
  const now = new Date();
  const todayNY = nyStartOfDay(now);
  let startBase = todayNY;
  if (DATE_MODE.toLowerCase() === 'yesterday') {
    startBase = new Date(todayNY);
    startBase.setUTCDate(startBase.getUTCDate() - 1);
  }
  return { start: startBase, end: startBase };
}

// merchants.json → array of { id, name }
function loadMerchants() {
  if (!fs.existsSync(MERCHANTS_PATH)) {
    console.error(`Missing merchants file: ${MERCHANTS_PATH}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(MERCHANTS_PATH, 'utf-8'));

  if (raw && typeof raw === 'object' && Array.isArray(raw.merchant_ids)) {
    const ids = raw.merchant_ids.map(String);
    return Array.from(new Set(ids)).map((id) => ({ id, name: null }));
  }
  if (Array.isArray(raw)) {
    const idKeys = ['merchant id', 'merchant_id', 'mid', 'id'];
    const nameKeys = ['dba name', 'name', 'merchant name'];
    const list = [];
    for (const item of raw) {
      if (item == null) continue;
      if (typeof item === 'string') {
        list.push({ id: String(item), name: null });
        continue;
      }
      const keys = Object.keys(item);
      let id = null,
        name = null;
      for (const k of keys) {
        const kl = k.toLowerCase().trim();
        if (id == null && idKeys.includes(kl)) id = String(item[k]).trim();
        if (name == null && nameKeys.includes(kl))
          name = String(item[k]).trim();
      }
      if (id) list.push({ id, name: name || null });
    }
    const seen = new Set();
    const out = [];
    for (const m of list) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
    return out;
  }
  throw new Error(
    'Unsupported merchants.json structure: expected { merchant_ids: [...] } or an array of { id/name } objects'
  );
}
// Robust "Load report" click with retries and readiness wait
async function clickLoadReport(page) {
  const tries = numEnv('LOAD_CLICK_RETRIES', 3);
  const backoff = numEnv('LOAD_CLICK_BACKOFF_MS', 600);
  const readyT = numEnv('LOAD_READY_TIMEOUT_MS', 20000);
  const postMs = numEnv('POST_RUN_PAUSE_MS', 800);

  // 1) Prefer selectors.json -> reporting.run_button; else fall back to #load and text
  const candidates = []
    .concat(SELECTORS.reporting?.run_button || [])
    .concat(['#load', "button:has-text('Load report')"])
    .flat()
    .filter(Boolean);

  let lastErr = null;

  for (let i = 1; i <= tries; i++) {
    try {
      // click the first visible candidate
      let clicked = false;
      for (const q of candidates) {
        const btn = page.locator(q).first();
        const n = await btn.count().catch(() => 0);
        if (!n) continue;
        try {
          await btn.scrollIntoViewIfNeeded().catch(() => {});
          await btn
            .waitFor({ state: 'visible', timeout: 1000 })
            .catch(() => {});
          await Promise.all([
            page
              .waitForLoadState(env('LOAD_STATE', 'networkidle'))
              .catch(() => {}),
            btn.click({ timeout: numEnv('NAV_TIMEOUT_MS', 15000) }),
          ]);
          clicked = true;
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!clicked) throw lastErr || new Error('Load button not found/visible');

      // 2) Wait for report body to hydrate (useful for export button to appear)
      // Heuristic: wait for any export candidate to attach OR for main content to get longer.
      const beforeHTML = await page.content();
      await Promise.race([
        page
          .locator(
            "button.btn.green.export, button.export, button:has-text('Export'), a:has-text('Export')"
          )
          .waitFor({ state: 'attached', timeout: readyT })
          .catch(() => {}),
        (async () => {
          for (let k = 0; k < Math.ceil(readyT / 500); k++) {
            await page.waitForTimeout(500);
            const afterHTML = await page.content();
            if (afterHTML.length > beforeHTML.length + 2000) break; // crude growth check
          }
        })(),
      ]);

      // 3) small post pause
      await page.waitForTimeout(postMs);
      return; // success
    } catch (e) {
      lastErr = e;
      if (i < tries) await page.waitForTimeout(backoff * i);
    }
  }
  throw lastErr || new Error('Failed to click "Load report" after retries');
}



// STRICT: only take mail that arrived after `anchorMs` (±15s slack), using UIDNEXT.
// Uses ONLY your existing env vars: IMAP_* listed in your .env (no new ones).
// ===== IMAP 2FA Helper (bulletproof) =========================================
async function waitFor2faCode() {
  const maxWaitMs = numEnv('MFA_MAX_WAIT_MS', 90000); // default 90s
  const pollMs    = numEnv('IMAP_POLL_MS', 3000);     // default 3s
  const deadline  = Date.now() + maxWaitMs;

  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const code = await get2faCodeFromImap();
      if (code) return code; // success
    } catch (e) {
      // log and keep trying
      if (process.env.IMAP_DEBUG) {
        console.warn('[IMAP] attempt', attempt, 'failed:', e?.message || e);
      }
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error('Timed out waiting for 2FA email');
}

async function get2faCodeFromImap() {
  const debug = bool(env('IMAP_DEBUG', 'false'));
  const log   = (...a) => debug && console.log('[IMAP]', ...a);

  const host        = env('IMAP_HOST', 'imap.gmail.com');
  const port        = numEnv('IMAP_PORT', 993);
  const secure      = bool(env('IMAP_SECURE', 'true'), true);
  const user        = env('IMAP_USER', '');
  const pass        = env('IMAP_PASS', '');

  const mailboxCsv  = env('IMAP_MAILBOXES', env('IMAP_MAILBOX', 'INBOX'));
  const altMailbox  = env('IMAP_ALT_MAILBOX', '');
  const mailboxes   = mailboxCsv.split(',').map(s => s.trim()).filter(Boolean);
  if (altMailbox) mailboxes.push(altMailbox);

  const fromFilter  = (env('IMAP_FROM_FILTER', '') || '').trim();
  const subjectFilt = (env('IMAP_SUBJECT_FILTER', 'Elevate MFA Code') || '').trim();
  const lookbackMin = numEnv('IMAP_LOOKBACK_MINUTES', 60);
  const onlyUnseen  = bool(env('IMAP_ONLY_UNSEEN', 'false'));
  const codeRxStr   = env('IMAP_CODE_REGEX', '(?<!\\d)\\d{6}(?!\\d)');
  const timeSkewMs  = numEnv('IMAP_TIME_SKEW_MS', 0);
  const uidFudge    = Math.max(5, numEnv('IMAP_UID_FUDGE', 25));

  const since = new Date(Date.now() - lookbackMin * 60 * 1000);

  const client = new ImapFlow({
    host, port, secure,
    auth: { user, pass },
    logger: false,
    socketTimeout: numEnv('IMAP_SOCKET_TIMEOUT_MS', 30000),
    greetingTimeout: numEnv('IMAP_CONN_TIMEOUT_MS', 15000),
    authTimeout: numEnv('IMAP_AUTH_TIMEOUT_MS', 15000),
    tls: { servername: env('IMAP_TLS_SERVERNAME', host), minVersion: 'TLSv1.2' }
  });

  client.on('error', e => console.warn('[IMAP error]', e?.message || e));

  // robust extractor: custom regex → spaced/hyphen → raw source (qp unwrapped)
  const extractCode = (subject, text, html, rawBuf) => {
    const stripHtml = s => String(s || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>');
    const rawStr = rawBuf ? rawBuf.toString('utf8') : '';

    const qpUnwrap = rawStr.replace(/=\r?\n/g, ''); // quoted-printable soft breaks

    const haystack = [
      subject || '',
      text || '',
      stripHtml(html || ''),
      qpUnwrap
    ].join('  ').replace(/[\u200B-\u200D\uFEFF]/g, '');

    // 1) user regex
    try {
      const rx = new RegExp(codeRxStr, 'g');
      const m = haystack.match(rx);
      if (m && m[0]) return m[0];
    } catch {}

    // 2) 6 digits with spaces/hyphens in between (handles templated spans fairly well once HTML is stripped)
    const m2 = haystack.match(/(?<!\d)(?:\d[\s-]*){6}(?!\d)/);
    if (m2 && m2[0]) {
      const only = m2[0].replace(/[^\d]/g, '');
      if (only.length === 6) return only;
    }
    return null;
  };

  const processBox = async (box) => {
    log('open', box);
    const boxInfo = await client.mailboxOpen(box);

    // Primary search (fast): subject/from/seen + since
    const q = { since };
    if (fromFilter)   q.from    = fromFilter;
    if (subjectFilt)  q.subject = subjectFilt;
    if (onlyUnseen)   q.seen    = false;

    let uids = [];
    try {
      uids = await client.search(q);
      log('search', q, '->', uids.length);
    } catch (e) {
      log('search error:', e?.message || e);
    }

    // Fallback A: if none, relax search (subject only)
    if (!uids.length && subjectFilt) {
      try {
        uids = await client.search({ subject: subjectFilt });
        log('fallback subject-only ->', uids.length);
      } catch {}
    }

    // Fallback B: if still none, scan last N UIDs via UIDNEXT
    if (!uids.length) {
      const startUid = Math.max(1, (boxInfo.uidNext || 1) - 1);
      const tailUids = [];
      for (let u = startUid; u > 0 && tailUids.length < uidFudge; u--) {
        tailUids.push(u);
      }
      uids = tailUids;
      log('fallback UIDNEXT tail ->', uids.length);
    }

    // newest first
    const uniq = Array.from(new Set(uids)).sort((a,b)=>b-a);

    for (const uid of uniq) {
      const m = await client.fetchOne(uid, {
        uid: true, internalDate: true, envelope: true, flags: true, source: true
      }).catch(() => null);
      if (!m) continue;

      // honor onlyUnseen if requested
      if (onlyUnseen && Array.isArray(m.flags) && m.flags.includes('\\Seen')) continue;

      // time gate (internalDate >= since - skew)
      if (m.internalDate) {
        const idMs = new Date(m.internalDate).getTime();
        if (Number.isFinite(idMs) && idMs < (since.getTime() - timeSkewMs)) continue;
      }

      const subj = m.envelope?.subject || '';
      let parsed = null;
      try { parsed = await simpleParser(m.source); } catch {}
      const code = extractCode(
        parsed?.subject ?? subj,
        parsed?.text,
        parsed?.html,
        m.source
      );
      if (code) {
        console.log('[IMAP] ✅ 2FA code found.');
        return code;
      }
    }
    return null;
  };

  try {
    await client.connect();
    for (const box of mailboxes) {
      const code = await processBox(box);
      if (code) return code;
    }
    throw new Error('2FA code not found via IMAP');
  } finally {
    try { await client.logout(); } catch {}
  }
}
// ===== Portal Actions ========================================================
async function login(page) {
  const base = env('ELEVATE_BASE', 'https://portal.elevateqs.com');
  const navState = env('LOAD_STATE', 'networkidle'); // may be networkidle or domcontentloaded
  const navTimeout = numEnv('NAV_TIMEOUT_MS', 15000);

  console.log('[login] goto base:', base, 'waitUntil=', navState);
  try {
    await page.goto(base, { waitUntil: navState, timeout: navTimeout });
  } catch (e) {
    console.warn('[login] base goto timed out with', navState, '— retrying with domcontentloaded');
    try {
      await page.goto(base, { waitUntil: 'domcontentloaded', timeout: navTimeout });
    } catch (e2) {
      console.warn('[login] fallback domcontentloaded also failed:', e2.message);
    }
  }
  console.log('[login] after base goto URL:', page.url());

  const loginPaths = env('LOGIN_PATHS', '/Account/Login,/login,/Login.aspx,/Account/LogOn,/Account/SignIn')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!/login/i.test(page.url())) {
    for (const suffix of loginPaths) {
      const u = base.replace(/\/$/, '') + suffix;
      console.log('[login] try goto', u);
      try {
        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: navTimeout });
        const title = await page.title().catch(() => '');
        console.log('[login] at', page.url(), 'title=', title);
        if (/login|signin|account/i.test(title) || /login/i.test(page.url())) break;
      } catch (e) {
        console.warn('[login] path goto failed:', u, e.message);
      }
    }
  }

  const sel = SELECTORS.login;
  const username = env('ELEVATE_USERNAME');
  const password = env('ELEVATE_PASSWORD');
  if (!username || !password) throw new Error('Missing ELEVATE_USERNAME or ELEVATE_PASSWORD in .env');

  console.log('[login] filling creds…');
  await page.locator(sel.username).first().fill(username, { timeout: navTimeout });
  await page.locator(sel.password).first().fill(password, { timeout: navTimeout });

  console.log('[login] submitting…');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: navTimeout }).catch(() => {}),
    page.locator(sel.submit).first().click({ timeout: navTimeout }),
  ]);
  console.log('[login] submit done. URL:', page.url());
}
async function loginWithRetries(page) {
  const attempts = numEnv('LOGIN_RETRIES', 3);
  const backoff = numEnv('LOGIN_BACKOFF_MS', 2000);
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      if (i > 1) await page.waitForTimeout(backoff);
      await login(page);
      return;
    } catch (e) {
      lastErr = e;
      console.warn(`Login attempt ${i}/${attempts} failed:`, e?.message || e);
    }
  }
  throw lastErr || new Error('Login failed after retries');
}

async function twofaScreenPresent(page) {
  if (SELECTORS.twofa?.code_input) {
    const c = await page
      .locator(SELECTORS.twofa.code_input)
      .count()
      .catch(() => 0);
    if (c > 0) return true;
  }
  if (SELECTORS.twofa?.digit_inputs) {
    const c = await page
      .locator(SELECTORS.twofa.digit_inputs)
      .count()
      .catch(() => 0);
    if (c >= 4) return true;
  }
  const guess =
    'input[autocomplete="one-time-code"], input[name*="code" i], input[id*="code" i], input[aria-label*="code" i]';
  const gcount = await page
    .locator(guess)
    .count()
    .catch(() => 0);
  return gcount > 0;
}
async function submitTwofaCode(page, code) {
  const navState = env('LOAD_STATE', 'domcontentloaded');
  const navTimeout = numEnv('NAV_TIMEOUT_MS', 15000);

  const twofaSel = SELECTORS.twofa || {};
  const submitSel =
    twofaSel.submit ||
    'button:has-text("Verify"), button:has-text("Continue"), input[type="submit"]';

  if (twofaSel.code_input) {
    const input = page.locator(twofaSel.code_input).first();
    if ((await input.count()) > 0) {
      await input.fill(code);
      await Promise.all([
        page
          .waitForNavigation({ waitUntil: navState, timeout: navTimeout })
          .catch(() => {}),
        page
          .locator(submitSel)
          .first()
          .click()
          .catch(() => input.press('Enter').catch(() => {})),
      ]);
      return;
    }
  }

  if (twofaSel.digit_inputs) {
    const digits = page.locator(twofaSel.digit_inputs);
    const count = await digits.count();
    if (count > 1 && code && code.length >= count) {
      for (let i = 0; i < count; i++) await digits.nth(i).fill(code[i]);
      await Promise.all([
        page
          .waitForNavigation({ waitUntil: navState, timeout: navTimeout })
          .catch(() => {}),
        page
          .locator(submitSel)
          .first()
          .click()
          .catch(() =>
            digits
              .last()
              .press('Enter')
              .catch(() => {})
          ),
      ]);
      return;
    }
  }

  const guess = page
    .locator(
      'input[autocomplete="one-time-code"], input[name*="code" i], input[id*="code" i], input[aria-label*="code" i]'
    )
    .first();
  if ((await guess.count()) > 0) {
    await guess.fill(code);
    await Promise.all([
      page
        .waitForNavigation({ waitUntil: navState, timeout: navTimeout })
        .catch(() => {}),
      page
        .locator(submitSel)
        .first()
        .click()
        .catch(() => guess.press('Enter').catch(() => {})),
    ]);
  } else {
    throw new Error(
      '2FA code input not found (configure SELECTORS.twofa in selectors.json)'
    );
  }
}

// --- Advanced Reporting / Net ACH ---
function originOf(urlLike) {
  try {
    return new URL(urlLike).origin;
  } catch {
    return 'https://portal.elevateqs.com';
  }
}
async function gotoAdvancedReporting(page) {
  const navState = env('LOAD_STATE', 'domcontentloaded');
  const navTimeout = numEnv('NAV_TIMEOUT_MS', 15000);

  const sel = SELECTORS.reporting || {};
  const adv =
    sel.advanced_link ||
    "a[href='/Reporting/ReportSelect.aspx'], a:has-text('Advanced Reporting')";
  const queryMenu =
    sel.query_menu ||
    "a:has-text('Query System'), button:has-text('Query System')";

  const tryClick = async (locator) => {
    const count = await locator.count().catch(() => 0);
    if (!count) return false;
    const first = locator.first();
    try {
      await first.scrollIntoViewIfNeeded().catch(() => {});
      await first.waitFor({ state: 'visible', timeout: 1000 }).catch(() => {});
      await Promise.all([
        page.waitForLoadState(navState).catch(() => {}),
        first.click({ timeout: navTimeout }),
      ]);
      return true;
    } catch {
      try {
        await Promise.all([
          page.waitForLoadState(navState).catch(() => {}),
          first.click({ timeout: navTimeout, force: true }),
        ]);
        return true;
      } catch {
        return false;
      }
    }
  };

  if (await tryClick(page.locator(adv))) return;

  if (await tryClick(page.locator(queryMenu))) {
    await page.waitForTimeout(300);
    if (await tryClick(page.locator(adv))) return;
  }

  await page.waitForTimeout(800);
  if (await tryClick(page.locator(adv))) return;

  const base = env('ELEVATE_BASE', 'https://portal.elevateqs.com');
  const baseOrigin = originOf(base);
  const reportSelectPath = env(
    'REPORT_SELECT_PATH',
    '/Reporting/ReportSelect.aspx'
  );
  await page.goto(baseOrigin + reportSelectPath, {
    waitUntil: navState,
    timeout: navTimeout,
  });
}
async function gotoNetAchDetails(page) {
  const navState = env('LOAD_STATE', 'domcontentloaded');
  const navTimeout = numEnv('NAV_TIMEOUT_MS', 15000);

  if (SELECTORS.reporting?.net_ach_button) {
    try {
      await Promise.all([
        page
          .waitForNavigation({ waitUntil: navState, timeout: navTimeout })
          .catch(() => {}),
        page
          .locator(SELECTORS.reporting.net_ach_button)
          .first()
          .click({ timeout: navTimeout }),
      ]);
      return;
    } catch {}
  }
  const achPath = process.env.ACH_PATH || '/Reporting/Report.aspx?reportID=25';
  const base = env('ELEVATE_BASE', 'https://portal.elevateqs.com');
  const baseOrigin = originOf(base);
  await page.goto(baseOrigin + achPath, {
    waitUntil: navState,
    timeout: navTimeout,
  });
}

// Robust multiselect adder for Net ACH MID input (with explicit pauses)
async function addMidsToAchReport(page, mids) {
  const sel = SELECTORS.reporting;
  if (!sel?.mid_input)
    throw new Error('selectors.reporting.mid_input is required');

  // Tunables
  const navTimeout = numEnv('NAV_TIMEOUT_MS', 15000);
  const debounceMs = numEnv('RESULT_DEBOUNCE_MS', 350); // wait after typing before checking results
  const resultTimeout = numEnv('RESULT_TIMEOUT_MS', 10000); // max wait for dropdown to populate
  const betweenAdds = numEnv('MID_ADD_PAUSE_MS', 100); // pause after each successful add
  const retries = numEnv('MID_ADD_RETRIES', 2); // retries per MID
  const retryBackoff = numEnv('MID_RETRY_BACKOFF_MS', 400); // additional wait per retry
  const jitterMax = numEnv('MID_ADD_JITTER_MS', 120); // tiny randomness to avoid racing
  const warnOnly = bool(env('MID_FINAL_WARN_ONLY', 'false'));

  const input = page.locator(sel.mid_input).first();
  const resultsBox = sel.mid_results_container
    ? page.locator(sel.mid_results_container)
    : null;
  const resultItemsQ =
    sel.mid_result_item || '#MID-catmultiselect-resultbox .catMSResultList li';
  const chipsQ = sel.mid_chip || '.catMSValueList li';

  const chipForMid = (mid) =>
    page.locator(chipsQ, { hasText: String(mid) }).first();
  const resultForMid = (mid) =>
    page
      .locator(
        `${resultItemsQ}:has-text("${String(
          mid
        )} -"), ${resultItemsQ}:has-text("${String(mid)}")`
      )
      .first();

  const ensureChip = async (mid, timeout = 1500) => {
    const chip = chipForMid(mid);
    try {
      await chip.waitFor({ state: 'visible', timeout });
      return true;
    } catch {
      return false;
    }
  };

  const clearInputHard = async () => {
    await input.fill('');
    try {
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
    } catch {}
  };

  const tinyJitter = async () => {
    if (jitterMax > 0)
      await page.waitForTimeout(Math.floor(Math.random() * jitterMax));
  };

  // Type MID, wait for dropdown to show the matching row, click it, then confirm chip appears.
  const typeWaitClick = async (mid) => {
    await input.click();
    await clearInputHard();
    await input.type(String(mid), { delay: 18 });
    await page.waitForTimeout(debounceMs); // <-- deliberate pause after typing
    await tinyJitter(); // <-- small jitter helps avoid edge timing

    // Wait for list to appear (best-effort)
    if (resultsBox) {
      try {
        await resultsBox.waitFor({
          state: 'visible',
          timeout: Math.min(resultTimeout, 2000),
        });
      } catch {}
    }

    // Wait specifically for the row that includes this MID
    const row = resultForMid(mid);
    try {
      await row.waitFor({ state: 'visible', timeout: resultTimeout });
    } catch {
      // If no row showed up, try committing with Enter/Tab as a fallback
      try {
        await input.press('Enter');
      } catch {}
      try {
        await input.press('Tab');
      } catch {}
      await page.waitForTimeout(150);
      return ensureChip(mid);
    }

    // Click the row to turn it into a chip
    try {
      await row.scrollIntoViewIfNeeded().catch(() => {});
      await row.click({ timeout: navTimeout });
    } catch {
      try {
        await row.click({ timeout: navTimeout, force: true });
      } catch {}
    }

    // Give the chip a moment to render
    await page.waitForTimeout(150);
    return ensureChip(mid);
  };

  await input.waitFor({ state: 'visible', timeout: navTimeout });

  // Avoid double-adding if some are already present
  const existing = new Set(
    (
      await page
        .locator(chipsQ)
        .allTextContents()
        .catch(() => [])
    )
      .map((t) => (t || '').match(/\b(\d{6,})\b/)?.[1])
      .filter(Boolean)
  );

  const misses = [];

  for (const mid of mids) {
    if (existing.has(mid)) continue;

    let ok = false;
    for (let attempt = 0; attempt <= retries; attempt++) {
      ok = await typeWaitClick(mid);
      if (ok) break;
      await page.waitForTimeout(retryBackoff * (attempt + 1)); // backoff before retrying
    }

    if (!ok) {
      // Nudge focus; occasionally forces the chip render
      try {
        await input.blur();
        await page.waitForTimeout(80);
        await input.focus();
      } catch {}
      ok = await ensureChip(mid, 800);
    }

    if (!ok) {
      misses.push(mid); // don’t throw yet; we’ll do a recovery sweep
    } else {
      existing.add(mid);
    }

    await page.waitForTimeout(betweenAdds); // <-- pause between adds
  }

  // Recovery sweep: retry any misses (try the last MID first—often the flaky one)
  if (misses.length) {
    const order = [...misses];
    const last = mids[mids.length - 1];
    const lastIdx = order.indexOf(last);
    if (lastIdx > 0) {
      order.splice(lastIdx, 1);
      order.unshift(last);
    }

    const stillMissing = [];
    for (const mid of order) {
      let ok = false;
      for (let attempt = 0; attempt <= retries + 1; attempt++) {
        ok = await typeWaitClick(mid);
        if (ok) break;
        await page.waitForTimeout((retryBackoff + 150) * (attempt + 1));
      }
      if (!ok) stillMissing.push(mid);
      else await page.waitForTimeout(betweenAdds);
    }

    if (stillMissing.length) {
      const msg = `Some MIDs were not added as chips: ${stillMissing.join(
        ', '
      )}`;
      if (warnOnly) console.warn(msg);
      else throw new Error(msg);
    }
  }
}

// Export (bulk) with deep diagnostics
// replace your entire exportCurrentAch() with this version
async function exportCurrentAch(page, outDir, tag = '') {
  const navTimeout    = numEnv('NAV_TIMEOUT_MS', 15000);
  const appearTimeout = numEnv('EXPORT_BUTTON_APPEAR_MS', 8000);
  const exportTimeout = numEnv('EXPORT_TIMEOUT_MS', 60000);
  const diagDir       = path.join(ERROR_SHOTS, 'export_diag');
  const tagName       = tag ? `net-ach${tag}` : 'net-ach';

  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(diagDir, { recursive: true });

  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
  const saveArtifacts = async (frame, label) => {
    try {
      const sPath = path.join(diagDir, `${stamp()}-${label}.png`);
      const hPath = path.join(diagDir, `${stamp()}-${label}.html`);
      await frame.page().screenshot({ path: sPath, fullPage: true }).catch(() => {});
      await fs.promises.writeFile(hPath, await frame.page().content()).catch(() => {});
      console.log('[EXPORT] artifacts:', sPath, '|', hPath);
    } catch {}
  };

  // Preferred selectors (ordered from strict to loose)
  const buttonSelectors = [
    "button:has-text('Export')",
    "a:has-text('Export')",
    ".btn-success:has-text('Export')",
    ".btn:has-text('Export')",
    "button:has(i.fa-table)"
  ];
  const scopeSelectors = [
    "section:has-text('REPORT RESULTS')",
    "div.card:has-text('REPORT RESULTS')",
    "div.panel:has-text('REPORT RESULTS')",
    "main",
    "body"
  ];

  const frames = [page.mainFrame(), ...page.frames()];
  console.log('[EXPORT] frame list:',
    frames.map(f => ({ name: f.name(), url: f.url() })));

  for (const frame of frames) {
    for (const scopeSel of scopeSelectors) {
      const scope = frame.locator(scopeSel);

      for (const sel of buttonSelectors) {
        const loc = scope.locator(sel).first();

        // attach quickly; don't block on visibility if it's in an off-screen container
        try {
          await loc.waitFor({ state: 'attached', timeout: appearTimeout });
        } catch {
          continue; // not in this scope/selector -> next
        }

        // skip disabled controls
        const disabled = await loc.getAttribute('disabled').catch(() => null);
        if (disabled) continue;

        try {
          await loc.scrollIntoViewIfNeeded().catch(() => {});
          const [download] = await Promise.all([
            frame.page().waitForEvent('download', { timeout: exportTimeout }),
            loc.click({ timeout: navTimeout }),
          ]);

          let suggested = null;
          try { suggested = await download.suggestedFilename(); } catch {}
          const ext = suggested ? path.extname(suggested) || '.xlsx' : '.xlsx';
          const outPath = path.join(outDir, `${tagName}${ext}`);
          await download.saveAs(outPath);
          console.log('[EXPORT] downloaded →', outPath);
          return outPath;
        } catch (e) {
          console.warn('[EXPORT] click/download attempt failed:', e?.message || e);
          await saveArtifacts(frame, `export-failed-${frames.indexOf(frame)}`);
          // try next selector/scope/frame
        }
      }
    }
  }

  // Nothing matched anywhere
  await saveArtifacts(page.mainFrame(), 'export-not-found');
  throw new Error('Export control not found in any frame/scope.');
}

async function searchAndDownloadACH(page, merchant, start, end, outDir) {
  const ach = SELECTORS.ach || {};
  if (!ach.merchant_id)
    throw new Error('ACH merchant_id selector not configured');

  const navTimeout = numEnv('NAV_TIMEOUT_MS', 15000);
  const exportTimeout = numEnv('EXPORT_TIMEOUT_MS', 60000);

  if (ach.start_date)
    await page.locator(ach.start_date).first().fill(formatDateForPortal(start));
  if (ach.end_date)
    await page.locator(ach.end_date).first().fill(formatDateForPortal(end));

  await page
    .locator(ach.merchant_id)
    .first()
    .fill(String(merchant.id), { timeout: navTimeout });

  await Promise.all([
    page.waitForLoadState(env('LOAD_STATE', 'networkidle')).catch(() => {}),
    page.locator(ach.search_button).first().click({ timeout: navTimeout }),
  ]);
  await page.waitForLoadState(env('LOAD_STATE', 'networkidle')).catch(() => {});

  for (const expSel of ach.export_buttons || []) {
    const expLoc = page.locator(expSel);
    if ((await expLoc.count()) > 0) {
      try {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: exportTimeout }),
          expLoc.first().click({ timeout: navTimeout }),
        ]);
        const suggested = await download.suggestedFilename();
        const ext = path.extname(suggested) || '.xlsx';
        const prefix = env('MID_PREFIX', 'merchant-');
        const suffix = env('ACH_SUFFIX', '-ach');
        const outPath = path.join(
          outDir,
          `${prefix}${safeName(merchant.id)}${suffix}${ext}`
        );
        await download.saveAs(outPath);
        return outPath;
      } catch (e) {}
    }
  }
  throw new Error('ACH export/download button not matched.');
}

// Helper: date fill (now properly closed)
async function fillDateInput(page, selector, value) {
  const loc = page.locator(selector).first();
  await loc.click();
  await loc.fill('');
  try {
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
  } catch {}
  await loc.fill(value);
}

// Helper: count selected MID chips (optional)
async function countSelectedMids(page) {
  const sel = SELECTORS.reporting;
  if (!sel?.mid_chip) return null;
  try {
    return await page.locator(sel.mid_chip).count();
  } catch {
    return null;
  }
}

// ANCHOR: main
// ===== Main ==================================================================
// ===== Main ==================================================================
// ===== Main ==================================================================
// ===== Main ==================================================================
async function runNetAchOnce() {
  console.log('▶️  Playwright Runner starting');
  console.log(`Node: ${process.version} (${process.platform} ${process.arch})`);
  console.log(`CWD: ${process.cwd()}`);
  console.log(`Start: ${new Date().toISOString()}`);

  const runningInDocker = fs.existsSync('/.dockerenv');
  const hasDisplay = !!process.env.DISPLAY;

  // One authoritative headless flag
  const effectiveHeadless =
    process.env.HEADLESS != null && process.env.HEADLESS !== ''
      ? /^(true|1|yes|on)$/i.test(String(process.env.HEADLESS))
      : runningInDocker || !hasDisplay;

  console.log('Config:', {
    HEADLESS: String(effectiveHeadless),
    SLOWMO_MS: numEnv('SLOWMO_MS', 0),
    NAV_TIMEOUT_MS: numEnv('NAV_TIMEOUT_MS', 15000),
    POST_RUN_PAUSE_MS: numEnv('POST_RUN_PAUSE_MS', 800),
    LOAD_STATE: env('LOAD_STATE', 'networkidle'),
  });

  // Dates & output folders
  const { start, end } = getDateRange();
  const dayFolderName = new Intl.DateTimeFormat('en-CA', {
    timeZone: DATE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(start);
  const dayDir = path.join(OUT_ROOT, dayFolderName);
  fs.mkdirSync(dayDir, { recursive: true });
  fs.mkdirSync(ERROR_SHOTS, { recursive: true });

  // Merchants
  const merchants = loadMerchants();
  const mids = merchants.map((m) => m.id);
  if (!mids.length) {
    console.error('No merchant IDs found from merchants file.');
    process.exit(1);
  }

  // Summary scaffold
  const summary = {
    date: dayFolderName,
    timezone: DATE_TZ,
    portal: env('ELEVATE_BASE', 'https://portal.elevateqs.com'),
    range: { start: formatDateForPortal(start), end: formatDateForPortal(end) },
    totals: { requested: merchants.length, succeeded: 0, failed: 0, files: 0, unique_files: 0 },
    merchants: merchants.map((m) => ({ id: m.id, name: m.name, status: 'pending', files: [], error: null })),
    artifacts: { folder: dayDir, screenshots: ERROR_SHOTS },
  };
  const summarize = () => {
    const ok = summary.merchants.filter((m) => m.status === 'ok').length;
    const files = summary.merchants.reduce((n, m) => n + (m.files ? m.files.length : 0), 0);
    const uf = new Set();
    summary.merchants.forEach((m) => (m.files || []).forEach((f) => uf.add(f)));
    summary.totals.succeeded = ok;
    summary.totals.failed = summary.totals.requested - ok;
    summary.totals.files = files;
    summary.totals.unique_files = uf.size;
  };

  // Browser
  console.log('[main] launching Chromium…');
  const browser = await chromium.launch({
    headless: effectiveHeadless,
    slowMo: Number(process.env.SLOWMO_MS ?? 0) || 0,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  console.log('[main] Chromium launched');

  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(numEnv('NAV_TIMEOUT_MS', 15000));
  page.setDefaultNavigationTimeout(numEnv('NAV_TIMEOUT_MS', 15000));
  console.log('[main] Page created; starting login…');

  try {
    // --- Login (+retries) ---
    await loginWithRetries(page);
    console.log('[main] login complete. URL:', page.url());

    // --- 2FA (IMAP) if present ---
  try {
  await page.waitForTimeout(numEnv('MFA_READY_WAIT_MS', 1000));

  const has2fa = await twofaScreenPresent(page);
  if (!has2fa) {
    console.log('[2FA] screen not detected; continuing.');
  } else {
    console.log('[2FA] screen detected — fetching code via IMAP…');

    // Wait for a code (waitFor2faCode must throw if it can’t find one)
    const code = await waitFor2faCode(); // <- uses your existing get2faCodeFromImap()
    await submitTwofaCode(page, code);
    await page.waitForTimeout(numEnv('POST_2FA_PAUSE_MS', 800));

    // Verify we actually cleared the gate
    if (await twofaScreenPresent(page)) {
      throw new Error('2FA screen still visible after submitting code');
    }

    summary.mfa = {
      via: 'imap',
      subject: env('IMAP_SUBJECT_FILTER', ''),
      from: env('IMAP_FROM_FILTER', ''),
    };
    console.log('[2FA] done.');
  }
} catch (e) {
  console.error('[2FA] failed:', e?.message || e);
  summary.mfa = { error: e?.message || String(e) };
  throw e; // hard-fail: do NOT continue to reporting if 2FA required and failed
}

    // --- Navigate to report ---
    console.log('[nav] goto Advanced Reporting…');
    if (SELECTORS.reporting?.advanced_link) await gotoAdvancedReporting(page);

    console.log('[nav] goto Net ACH details…');
    await gotoNetAchDetails(page);

    // --- Add MIDs ---
    console.log('[mids] adding', mids.length, 'MIDs…');
    await addMidsToAchReport(page, mids);

    if (bool(env('REQUIRE_ALL_MIDS', 'true')) && SELECTORS.reporting?.mid_chip) {
      const chipCount = await countSelectedMids(page);
      if (chipCount != null && chipCount < mids.length) {
        throw new Error(`Only ${chipCount} of ${mids.length} MIDs appear selected in the UI`);
      }
    }

    // --- Dates ---
    console.log('[dates] setting range…');
    if (SELECTORS.ach?.start_date) await fillDateInput(page, SELECTORS.ach.start_date, formatDateForPortal(start));
    if (SELECTORS.ach?.end_date)   await fillDateInput(page, SELECTORS.ach.end_date,   formatDateForPortal(end));

    // --- Run report ---
    console.log('[report] click Load report…');
    await clickLoadReport(page);
const RESULTS_TIMEOUT = numEnv('RESULTS_TIMEOUT_MS', 30000);
const EXPORT_TIMEOUT  = numEnv('EXPORT_TIMEOUT_MS', 90000);
const NAV_TIMEOUT     = numEnv('NAV_TIMEOUT_MS', 15000);

const results = page.locator(
  "div.portlet:has(.portlet-title .caption:has-text('REPORT RESULTS'))"
);
await results.waitFor({ state: 'attached', timeout: RESULTS_TIMEOUT });

// (Optional) also wait for the table body/rows to attach
await results
  .locator(".tableScrollWrap table, .tableScrollWrap .table, table")
  .first()
  .waitFor({ state: 'attached', timeout: RESULTS_TIMEOUT })
  .catch(() => {});

// Resolve Export inside the results portlet (covers button, link, icon, dropdown)
const exportLoc = results.locator([
  "button.btn.green.export",
  "a.btn.green.export",
  "button:has-text('Export')",
  "a:has-text('Export')",
  "button:has(i.fa-table)",
  "a:has(i.fa-table)",
  "ul.inline-dropdown a:has-text('Export')"
].join(", ")).first();

// Don’t require visibility — attach is enough; scroll then click
await exportLoc.waitFor({ state: 'attached', timeout: RESULTS_TIMEOUT });
await exportLoc.scrollIntoViewIfNeeded().catch(() => {});

const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: EXPORT_TIMEOUT }),
  exportLoc.click({ timeout: NAV_TIMEOUT })
]);

const suggested = await download.suggestedFilename().catch(() => null);
const outPath = path.join(dayDir, `net-ach-${Date.now()}${suggested ? path.extname(suggested) || '.xlsx' : '.xlsx'}`);
await download.saveAs(outPath);
    // --- Export (combined) ---
    console.log('[export] exporting combined file…');
    const bulkTag  = `-${mids.length}-mids`;
    const bulkPath = await exportCurrentAch(page, dayDir, bulkTag);

    for (const m of summary.merchants) {
      m.status = 'ok';
      m.files = [bulkPath];
    }

    // --- Email report (best-effort) ---
    try {
      await emailReport(bulkPath, {
        subject: env('EMAIL_SUBJECT', `Net ACH Export ${summary.date} (${mids.length} MIDs)`),
        text:    env('EMAIL_BODY',   `Attached is the Net ACH export for ${summary.range.start} to ${summary.range.end}.`),
      });
    } catch (e) {
      console.warn('[EMAIL] send failed:', e?.message || e);
    }
  } finally {
    // Summary & teardown
    summarize();
    const summaryName = env('SUMMARY_NAME', 'run-summary.json');
    const summaryPath = path.join(dayDir, summaryName);
    try {
      fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
      console.log(`Summary written: ${summaryPath}`);
    } catch (e) {
      console.error('Failed to write summary:', e?.message || e);
    }
    await context.close();
    await browser.close();
    console.log('[main] done.');
  }
}

if (require.main === module) {
  const mode = (process.argv[2] || env('MODE', 'server')).toLowerCase();

  if (mode === 'run' || bool(env('RUN_ON_START', 'false'))) {
    // one-shot CLI mode (keeps your old behavior)
    (async () => {
      try {
        await runNetAchOnce();
        // optional exit for CI/cron
        if (bool(env('EXIT_AFTER_RUN', 'true'))) process.exit(0);
      } catch (err) {
        console.error(err);
        process.exit(1);
      }
    })();
  } else {
    // default: idle trigger server
    startTriggerServer();
  }
}
module.exports = { runNetAchOnce };

function startTriggerServer() {
  const port = Number(process.env.JOB_PORT) || 3889;
  const requiredKey = process.env.JOB_API_KEY || '';

  // singleton state (no redeclare)
  const state = (globalThis.__TRIGGER_STATE__ ||= {
    running: false,
    lastRun: null,
    lastErr: null,
  });

  const server = http.createServer((req, res) => {
    const rawPath = req.url || '/';
    const pathOnly = rawPath.split('?')[0].replace(/\/+$/, '') || '/';
    const method = req.method || 'GET';
    console.log(`[idle] ${method} ${rawPath} → ${pathOnly}`);

    // Health
    if (method === 'GET' && (pathOnly === '/health' || pathOnly === '/status')) {
      return json(res, 200, {
        ok: true,
        running: state.running,
        lastRun: state.lastRun,
        lastErr: state.lastErr,
      });
    }

    // Last run info (optional but handy)
    if (method === 'GET' && pathOnly === '/last') {
      return json(res, 200, {
        running: state.running,
        lastRun: state.lastRun,
        lastErr: state.lastErr,
      });
    }

    // Fire-and-forget run
    if (method === 'POST' && pathOnly === '/run') {
      const key = req.headers['x-api-key'] || '';
      if (requiredKey && key !== requiredKey) {
        return json(res, 401, { error: 'unauthorized' });
      }
      if (state.running) {
        // don't error—ack so your task finishes fast
        return json(res, 200, { ok: true, message: 'already running' });
      }

      state.running = true;
      state.lastErr = null;
      const startedAt = new Date().toISOString();

      // ✅ ACK immediately so your Coolify "task" completes
      json(res, 202, { ok: true, accepted: true, startedAt });

      // do the work in the background
      (async () => {
        try {
          await runNetAchOnce();
          state.lastRun = { ok: true, startedAt, finishedAt: new Date().toISOString() };
        } catch (e) {
          state.lastErr = String(e?.message || e);
          state.lastRun = { ok: false, startedAt, finishedAt: new Date().toISOString(), error: state.lastErr };
          console.error('[run] failed:', state.lastErr);
        } finally {
          state.running = false;
        }
      })();

      return; // important: do not fall through
    }

    // 404
    return json(res, 404, { error: 'not found', path: pathOnly, method });
  });

  server.listen(port, () => {
    console.log(`[idle] Trigger server listening on :${port}`);
    console.log(`[idle] POST /run (x-api-key required) -> 202 Accepted`);
    console.log(`[idle] GET  /health or /status`);
    console.log(`[idle] GET  /last`);
  });

  return server;
}
