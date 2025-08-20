#!/usr/bin/env node
/* eslint-disable no-console */

// ===== Imports & Setup =======================================================
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
require('dotenv').config();

// Optional IMAP for 2FA
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

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
// ===== IMAP 2FA Helper =======================================================
async function waitFor2faCode() {
  console.log('Waiting for newest unread 2FA email via IMAP…');
  const code = await get2faCodeFromImap();
  console.log('Got 2FA code.');
  return code;
}
// ===== IMAP 2FA Helper (patched) ============================================
// ===== IMAP 2FA Helper (final) ==============================================
// Robust to container/local time skew; HTML-aware code extraction.
//
// ENV (optional):
//   IMAP_HOST, IMAP_PORT=993, IMAP_SECURE=true, IMAP_USER, IMAP_PASS
//   IMAP_MAILBOXES="INBOX,[Gmail]/All Mail,[Gmail]/Spam"
//   IMAP_LOOKBACK_MIN=300        IMAP_WINDOW_FUDGE_MIN=15
//   IMAP_MAX_SCAN=60             IMAP_FROM_FILTER=""         // regex (optional)
//   IMAP_SUBJECT_FILTER="Elevate MFA Code"                   // regex (optional)
//   IMAP_CODE_LEN=6              IMAP_DEBUG=true
//   LOCAL_TZ="America/Boise"     IMAP_USE_GMAIL_RAW=true
//
// NOTE: Do not rely on "unread". We use INTERNALDATE + windows instead.

function fmtTZ(date, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).format(date);
  } catch {
    return '(tz format unavailable)';
  }
}
function maskUser(u) {
  if (!u) return '';
  const [n, h] = String(u).split('@');
  return `${(n || '').slice(0, 2)}***@${h || ''}`;
}
function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/<[^>]+>/g, ' ');
}
function normalizeDigits(s) {
  if (!s) return '';
  return String(s)
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // zero-width
    .replace(/\s+/g, ' ')
    .trim();
}
function findCode(haystack, codeLen) {
  // Accept digits separated by spaces/hyphens: (?<!\d)(?:\d[\s-]*){N}(?!\d)
  const pattern = new RegExp(`(?<!\\d)(?:\\d[\\s-]*){${codeLen}}(?!\\d)`, 'g');
  const text = normalizeDigits(haystack);
  let m;
  while ((m = pattern.exec(text))) {
    const onlyDigits = m[0].replace(/[^\d]/g, '');
    if (onlyDigits.length === codeLen) return onlyDigits;
  }
  return null;
}

async function waitFor2faCode() {
  console.log('[2FA] Waiting for newest 2FA email via IMAP…');
  const code = await get2faCodeFromImap();
  if (typeof code === 'string' && code) {
    console.log('[2FA] Got 2FA code.');
  } else {
    console.log('[2FA] No 2FA code found within window.');
  }
  return code;
}
// ANCHOR: get2fa start
async function get2faCodeFromImap(opts = {}) {
  const debug = /^(1|true|yes|on)$/i.test(String(process.env.IMAP_DEBUG || ''));
  const log = (...a) => debug && console.log('[IMAP]', ...a);

  const host = env('IMAP_HOST', 'imap.gmail.com');
  const port = numEnv('IMAP_PORT', 993);
  const secure = bool(env('IMAP_SECURE', 'true'), true);
  const user = opts.user ?? env('IMAP_USER');
  const pass = opts.pass ?? env('IMAP_PASS');
  if (!user || !pass) throw new Error('IMAP_USER/IMAP_PASS missing');

  const mailboxCsv = env(
    'IMAP_MAILBOXES',
    'INBOX,[Gmail]/All Mail,[Gmail]/Spam'
  );
  const mailboxes = mailboxCsv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const fromFilter = (env('IMAP_FROM_FILTER', '') || '').trim(); // optional regex
  const subjFilter = (
    env('IMAP_SUBJECT_FILTER', 'Elevate MFA Code') || ''
  ).trim(); // optional regex
  const lookbackMin = numEnv('IMAP_LOOKBACK_MIN', 300);
  const fudgeMin = numEnv('IMAP_WINDOW_FUDGE_MIN', 15);
  const maxScan = numEnv('IMAP_MAX_SCAN', 60);
  const codeLen = Math.max(4, Math.min(8, numEnv('IMAP_CODE_LEN', 6)));

  const localTZ = env('LOCAL_TZ', 'America/Boise');
  const now = new Date();
  const cutoffMs = now.getTime() - (lookbackMin + fudgeMin) * 60 * 1000;

  const hostIsGmail = /gmail|googlemail/i.test(host);
  const useGmailRaw = /^(1|true|yes|on)$/i.test(
    String(process.env.IMAP_USE_GMAIL_RAW ?? (hostIsGmail ? 'true' : 'false'))
  );

  log('connect', { host, port, secure, user: maskUser(user) });
  log(
    'time.utc',
    now.toISOString(),
    'time.local',
    fmtTZ(now, localTZ),
    'tzOffsetMin',
    new Date().getTimezoneOffset()
  );
  log('search.setup', {
    mailboxes,
    lookbackMin,
    fudgeMin,
    maxScan,
    fromFilter,
    subjFilter,
    codeLen,
    useGmailRaw,
  });

  const client = new ImapFlow({ host, port, secure, auth: { user, pass } });

  const scanMailbox = async (mbox) => {
    const lock = await client.getMailboxLock(mbox);
    try {
      let uids = [];
      if (useGmailRaw) {
        // precise window, independent of TZ
        const terms = [`newer_than:${lookbackMin + fudgeMin}m`];
        if (subjFilter)
          terms.push(`subject:"${subjFilter.replace(/"/g, '\\"')}"`);
        if (fromFilter) terms.push(`from:"${fromFilter.replace(/"/g, '\\"')}"`);
        const gmailRaw = terms.join(' ');
        log('X-GM-RAW', { mbox, gmailRaw });
        uids = await client.search({ gmailRaw }, { uid: true });
      } else {
        const sinceDate = new Date(cutoffMs);
        uids = await client.search({ since: sinceDate }, { uid: true });
        if (!uids.length) {
          // cross midnight if needed
          const widened = new Date(cutoffMs - 24 * 60 * 60 * 1000);
          log('since.widened', { mbox, widened: widened.toISOString() });
          uids = await client.search({ since: widened }, { uid: true });
        }
      }
      log('uids', { mbox, count: uids.length });
      if (!uids.length) return null;

      // newest first, capped
      const scan = uids.slice(-maxScan).reverse();

      for (const uid of scan) {
        const msg = await client.fetchOne(uid, {
          uid: true,
          envelope: true,
          internalDate: true,
          source: true,
        });
        if (!msg) continue;

        const idate = msg.internalDate ? new Date(msg.internalDate) : null;
        if (idate && idate.getTime() < cutoffMs) {
          log('skip.old', { mbox, uid, idate: idate.toISOString() });
          continue;
        }

        // Parse and build haystacks
        let parsed;
        try {
          parsed = await simpleParser(msg.source);
        } catch (e) {
          log('parse.fail', { mbox, uid, err: e?.message || String(e) });
          continue;
        }

        const subj = parsed.subject || '';
        const from = (parsed.from?.value || [])
          .map((v) => v.address || '')
          .join(', ');

        if (subjFilter && !new RegExp(subjFilter, 'i').test(subj)) {
          log('skip.subj', { mbox, uid, subj: subj.slice(0, 160) });
          continue;
        }
        if (fromFilter && !new RegExp(fromFilter, 'i').test(from)) {
          log('skip.from', { mbox, uid, from });
          continue;
        }

        const hayText = parsed.text || '';
        const hayHtml = stripHtml(parsed.html || '');
        const haySubject = subj;

        // Try text → HTML → subject
        let code =
          findCode(hayText, codeLen) ||
          findCode(hayHtml, codeLen) ||
          findCode(haySubject, codeLen);

        // Last-resort: search raw source quickly (covers odd encodings)
        if (!code && msg.source) {
          try {
            const raw = msg.source.toString('utf8');
            code = findCode(raw, codeLen);
          } catch {}
        }

        log('inspect', {
          mbox,
          uid,
          idate: idate ? idate.toISOString() : null,
          subj: haySubject.slice(0, 160),
          from,
          found: !!code,
          src: code
            ? findCode(hayText, codeLen)
              ? 'text'
              : findCode(hayHtml, codeLen)
              ? 'html'
              : 'subject/raw'
            : 'n/a',
          codeHint: code ? `${code.slice(0, 2)}****` : null,
        });

        if (code) return code;
      }
      return null;
    } finally {
      lock.release();
    }
  };

  try {
    await client.connect();
    for (const mbox of mailboxes) {
      const code = await scanMailbox(mbox);
      if (code) {
        console.log('[IMAP] ✅ 2FA code found.');
        return String(code);
      }
    }
    console.warn(
      '[IMAP] Searched but did not find a matching 2FA code within window.'
    );
    return null;
  } catch (err) {
    console.error('[IMAP] error:', err?.message || err);
    throw err;
  } finally {
    try {
      await client.logout();
    } catch {}
  }
}

// ANCHOR: get2fa:end

// ===== Portal Actions ========================================================
async function login(page) {
  const base = env('ELEVATE_BASE', 'https://portal.elevateqs.com');
  const navState = env('LOAD_STATE', 'domcontentloaded');
  const navTimeout = numEnv('NAV_TIMEOUT_MS', 15000);

  await page.goto(base, { waitUntil: navState }).catch(() => {});

  const loginPaths = env(
    'LOGIN_PATHS',
    '/Account/Login,/login,/Login.aspx,/Account/LogOn,/Account/SignIn'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!/login/i.test(page.url())) {
    for (const suffix of loginPaths) {
      const u = base.replace(/\/$/, '') + suffix;
      try {
        await page.goto(u, { waitUntil: navState, timeout: navTimeout });
        const title = await page.title().catch(() => '');
        if (/login|signin|account/i.test(title) || /login/i.test(page.url()))
          break;
      } catch {}
    }
  }

  const sel = SELECTORS.login;
  const username = env('ELEVATE_USERNAME');
  const password = env('ELEVATE_PASSWORD');
  if (!username || !password)
    throw new Error('Missing ELEVATE_USERNAME or ELEVATE_PASSWORD in .env');

  await page.waitForTimeout(300);
  await page
    .locator(sel.username)
    .first()
    .fill(username, { timeout: navTimeout });
  await page
    .locator(sel.password)
    .first()
    .fill(password, { timeout: navTimeout });

  await Promise.all([
    page
      .waitForNavigation({ waitUntil: navState, timeout: navTimeout })
      .catch(() => {}),
    page.locator(sel.submit).first().click({ timeout: navTimeout }),
  ]);
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
async function exportCurrentAch(page, outDir, tag = '') {
  const navTimeout = numEnv('NAV_TIMEOUT_MS', 15000);
  const exportTimeout = numEnv('EXPORT_TIMEOUT_MS', 60000);
  const appearTimeout = numEnv('EXPORT_BUTTON_APPEAR_MS', 15000);

  // SAFE suggested-filename helper (works for sync or Promise returns)
  const getSuggested = async (download) => {
    try {
      if (!download || typeof download.suggestedFilename !== 'function')
        return null;
      const v = download.suggestedFilename();
      return v && typeof v.then === 'function' ? await v : v;
    } catch {
      return null;
    }
  };

  const expSelList = []
    .concat(SELECTORS.ach?.export_buttons || [])
    .concat(SELECTORS.reporting?.export_buttons || [])
    .concat([
      'button.btn.green.export',
      'button.export',
      "button:has-text('Export')",
      "a:has-text('Export')",
      "a[href*='/Reporting/ExportReport.aspx']",
      'button:has(i.fa-table)',
    ])
    .filter(Boolean);

  // diagnostics dir
  const diagDir = path.join(ERROR_SHOTS, 'export_diag');
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch {}
  try {
    fs.mkdirSync(diagDir, { recursive: true });
  } catch {}

  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
  const tagName = tag ? `net-ach${tag}` : 'net-ach';

  const logx = (...a) => console.log(`[EXPORT]`, ...a);

  const saveArtifacts = async (frame, label) => {
    try {
      const sPath = path.join(diagDir, `${stamp()}-${label}.png`);
      const hPath = path.join(diagDir, `${stamp()}-${label}.html`);
      await frame
        .page()
        .screenshot({ path: sPath, fullPage: true })
        .catch(() => {});
      await fs.promises
        .writeFile(hPath, await frame.page().content())
        .catch(() => {});
      logx(`Saved artifacts for ${label}:`, sPath, ' | ', hPath);
    } catch (e) {
      logx('Artifact save failed:', e?.message || e);
    }
  };

  // Try to “click to download”, or use data-url if present
  const attemptDownload = async (frame, loc, label) => {
    // 1) Normal click → wait for download or export response
    try {
      const [dlOrResp] = await Promise.race([
        Promise.all([
          frame.page().waitForEvent('download', { timeout: exportTimeout }),
          loc.click({ timeout: navTimeout }),
        ]).then(([download]) => [{ kind: 'download', download }]),
        frame
          .page()
          .waitForResponse(
            (r) =>
              /\/Reporting\/ExportReport\.aspx/i.test(r.url()) &&
              r.status() < 400,
            { timeout: exportTimeout }
          )
          .then((resp) => [{ kind: 'response', resp }]),
      ]);
      if (dlOrResp.kind === 'download') {
        const suggested = await getSuggested(dlOrResp.download);
        const ext = suggested ? path.extname(suggested) || '.xlsx' : '.xlsx';
        const outPath = path.join(outDir, `${tagName}${ext}`);
        await dlOrResp.download.saveAs(outPath);
        logx(`Downloaded via normal click → ${outPath}`);
        return outPath;
      } else {
        // Response path → navigate to trigger download
        const url = dlOrResp.resp.url();
        logx(`Got export response (${dlOrResp.resp.status()}): ${url}`);
        const [download] = await Promise.all([
          frame.page().waitForEvent('download', { timeout: exportTimeout }),
          frame
            .page()
            .goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout })
            .catch(() => {}),
        ]);
        const suggested = await getSuggested(download);
        const ext = suggested ? path.extname(suggested) || '.xlsx' : '.xlsx';
        const outPath = path.join(outDir, `${tagName}${ext}`);
        await download.saveAs(outPath);
        logx(`Downloaded after response→goto → ${outPath}`);
        return outPath;
      }
    } catch (e) {
      logx(`${label}: normal click failed:`, e?.message || e);
    }

    // 2) data-url attribute → absolute GET
    try {
      const dataUrl = await loc.getAttribute('data-url').catch(() => null);
      if (dataUrl) {
        const base = env('ELEVATE_BASE', 'https://portal.elevateqs.com');
        const origin = (() => {
          try {
            return new URL(base).origin;
          } catch {
            return 'https://portal.elevateqs.com';
          }
        })();
        const abs = origin + dataUrl;
        logx(`${label}: using data-url → ${abs}`);

        const [download] = await Promise.all([
          frame.page().waitForEvent('download', { timeout: exportTimeout }),
          frame
            .page()
            .goto(abs, { waitUntil: 'domcontentloaded', timeout: navTimeout })
            .catch(() => {}),
        ]);
        const suggested = await getSuggested(download);
        const ext = suggested ? path.extname(suggested) || '.xlsx' : '.xlsx';
        const outPath = path.join(outDir, `${tagName}${ext}`);
        await download.saveAs(outPath);
        logx(`Downloaded via data-url → ${outPath}`);
        return outPath;
      }
    } catch (e) {
      logx(`${label}: data-url path failed:`, e?.message || e);
    }

    // 3) Force click
    try {
      const [download] = await Promise.all([
        frame.page().waitForEvent('download', { timeout: exportTimeout }),
        loc.click({ timeout: navTimeout, force: true }),
      ]);
      const suggested = await getSuggested(download);
      const ext = suggested ? path.extname(suggested) || '.xlsx' : '.xlsx';
      const outPath = path.join(outDir, `${tagName}${ext}`);
      await download.saveAs(outPath);
      logx(`Downloaded via force click → ${outPath}`);
      return outPath;
    } catch (e) {
      logx(`${label}: force click failed:`, e?.message || e);
    }

    // 4) JS click (sometimes helps with shadow/overlay)
    try {
      await loc.evaluate((el) => el.click());
      const download = await frame
        .page()
        .waitForEvent('download', { timeout: exportTimeout });
      const suggested = await getSuggested(download);
      const ext = suggested ? path.extname(suggested) || '.xlsx' : '.xlsx';
      const outPath = path.join(outDir, `${tagName}${ext}`);
      await download.saveAs(outPath);
      logx(`Downloaded via JS click → ${outPath}`);
      return outPath;
    } catch (e) {
      logx(`${label}: JS click failed:`, e?.message || e);
    }

    return null;
  };

  // Attribute & state dump for a locator
  const dumpLocator = async (loc, label) => {
    try {
      const count = await loc.count().catch(() => 0);
      if (!count) {
        logx(`${label}: count=0`);
        return;
      }
      const first = loc.first();
      const vis = await first.isVisible().catch(() => false);
      const ena = await first.isEnabled().catch(() => false);
      const bb = await first.boundingBox().catch(() => null);
      const attrs = await first
        .evaluate((el) => ({
          id: el.id || null,
          class: el.className || null,
          name: el.getAttribute('name'),
          href: el.getAttribute('href'),
          dataUrl: el.getAttribute('data-url'),
          disabled: el.getAttribute('disabled'),
          text: el.textContent?.trim().slice(0, 120) || null,
        }))
        .catch(() => ({}));
      logx(
        `${label}: count=${count}, visible=${vis}, enabled=${ena}, bbox=${
          bb
            ? `${Math.round(bb.x)},${Math.round(bb.y)} ${Math.round(
                bb.width
              )}x${Math.round(bb.height)}`
            : 'n/a'
        }`
      );
      logx(`${label}: attrs=`, attrs);
    } catch (e) {
      logx(`${label}: dump failed:`, e?.message || e);
    }
  };

  const frames = [page.mainFrame(), ...page.frames()];
  logx(`Frames: ${frames.length}, selectors to try:`, expSelList);

  // Pass 1: standard loop
  for (let fi = 0; fi < frames.length; fi++) {
    const frame = frames[fi];
    const flabel = `frame#${fi}${frame === page.mainFrame() ? '(main)' : ''}`;
    logx(`Scanning ${flabel}`);

    for (let si = 0; si < expSelList.length; si++) {
      const sel = expSelList[si];
      const loc = frame.locator(sel).first();
      const label = `${flabel} sel[${si}]=${sel}`;
      try {
        await loc.waitFor({ state: 'attached', timeout: appearTimeout });
      } catch {
        continue;
      }

      await dumpLocator(loc, label);

      try {
        await loc.scrollIntoViewIfNeeded({ timeout: 1000 });
      } catch {}

      const out = await attemptDownload(frame, loc, label);
      if (out) return out;

      await saveArtifacts(frame, `after-fail-${fi}-${si}`);
    }
  }

  // Pass 2: Give it one more chance after a small wait, then full snapshot
  await page.waitForTimeout(1000).catch(() => {});
  await saveArtifacts(page.mainFrame(), 'final-state');

  throw new Error(
    'ACH export/download button not matched (checked all frames and fallbacks).'
  );
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
async function main() {
  console.log('▶️  Playwright Runner starting');
  console.log(`Node: ${process.version} (${process.platform} ${process.arch})`);
  console.log(`CWD: ${process.cwd()}`);
  console.log(`Start: ${new Date().toISOString()}`);

  const runningInDocker = fs.existsSync('/.dockerenv');
  const hasDisplay = !!process.env.DISPLAY;

  // Compute one authoritative headless flag
  const effectiveHeadless =
    process.env.HEADLESS != null && process.env.HEADLESS !== ''
      ? /^(true|1|yes|on)$/i.test(process.env.HEADLESS)
      : runningInDocker || !hasDisplay;

  console.log('Config:', {
    HEADLESS: String(effectiveHeadless),
    SLOWMO_MS: numEnv('SLOWMO_MS', 0),
    NAV_TIMEOUT_MS: numEnv('NAV_TIMEOUT_MS', 15000),
    POST_RUN_PAUSE_MS: numEnv('POST_RUN_PAUSE_MS', 800),
    LOAD_STATE: env('LOAD_STATE', 'networkidle'),
  });

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

  // Load MIDs
  const merchants = loadMerchants();
  const mids = merchants.map((m) => m.id);
  if (!mids.length) {
    console.error('No merchant IDs found from merchants file.');
    process.exit(1);
  }

  // Run summary scaffold
  const summary = {
    date: dayFolderName,
    timezone: DATE_TZ,
    portal: env('ELEVATE_BASE', 'https://portal.elevateqs.com'),
    range: { start: formatDateForPortal(start), end: formatDateForPortal(end) },
    totals: {
      requested: merchants.length,
      succeeded: 0,
      failed: 0,
      files: 0,
      unique_files: 0,
    },
    merchants: merchants.map((m) => ({
      id: m.id,
      name: m.name,
      status: 'pending',
      files: [],
      error: null,
    })),
    artifacts: { folder: dayDir, screenshots: ERROR_SHOTS },
  };
  const summarize = () => {
    const ok = summary.merchants.filter((m) => m.status === 'ok').length;
    const files = summary.merchants.reduce(
      (n, m) => n + (m.files ? m.files.length : 0),
      0
    );
    const uf = new Set();
    summary.merchants.forEach((m) => (m.files || []).forEach((f) => uf.add(f)));
    summary.totals.succeeded = ok;
    summary.totals.failed = summary.totals.requested - ok;
    summary.totals.files = files;
    summary.totals.unique_files = uf.size;
  };

  // Browser
  const browser = await chromium.launch({
    headless: effectiveHeadless,
    slowMo: Number(process.env.SLOWMO_MS ?? 0) || 0,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(numEnv('NAV_TIMEOUT_MS', 15000));

  try {
    // --- Login (+retries) ---
    await loginWithRetries(page);

    // --- 2FA (IMAP) if present ---
    try {
      await page.waitForTimeout(numEnv('MFA_READY_WAIT_MS', 1000));
      if (await twofaScreenPresent(page)) {
        const code = await waitFor2faCode();
        if (!code || typeof code !== 'string') {
          throw new Error(
            '[2FA] No code captured; check IMAP_* filters or set IMAP_DEBUG=true for traces.'
          );
        }
        await submitTwofaCode(page, code);
        await page.waitForTimeout(numEnv('POST_2FA_PAUSE_MS', 800));
        summary.mfa = {
          via: 'imap',
          from: env('IMAP_FROM_FILTER'),
          subject: env('IMAP_SUBJECT_FILTER'),
        };
      }
    } catch (e) {
      console.warn('2FA step skipped or failed:', e.message);
      summary.mfa = { error: e.message };
    }

    // --- Navigate to Advanced Reporting -> Net ACH ---
    if (SELECTORS.reporting?.advanced_link) {
      await gotoAdvancedReporting(page);
    }
    await gotoNetAchDetails(page);

    // --- Add all MIDs (with deliberate pauses) ---
    await addMidsToAchReport(page, mids);

    // Optional sanity check: all MIDs present as chips
    if (
      bool(env('REQUIRE_ALL_MIDS', 'true')) &&
      SELECTORS.reporting?.mid_chip
    ) {
      const chipCount = await countSelectedMids(page);
      if (chipCount != null && chipCount < mids.length) {
        throw new Error(
          `Only ${chipCount} of ${mids.length} MIDs appear selected in the UI`
        );
      }
    }

    // --- Dates ---
    if (SELECTORS.ach?.start_date)
      await fillDateInput(
        page,
        SELECTORS.ach.start_date,
        formatDateForPortal(start)
      );
    if (SELECTORS.ach?.end_date)
      await fillDateInput(
        page,
        SELECTORS.ach.end_date,
        formatDateForPortal(end)
      );

    // --- Run the report ---
    await clickLoadReport(page);

    // --- Single combined export (NOT per-merchant) ---
    const bulkTag = `-${mids.length}-mids`;
    const bulkPath = await exportCurrentAch(page, dayDir, bulkTag);

    // Mark success for every merchant, referencing the same file
    for (const m of summary.merchants) {
      m.status = 'ok';
      m.files = [bulkPath];
    }

    // --- Email report ---
    try {
      await emailReport(bulkPath, {
        subject: env(
          'EMAIL_SUBJECT',
          `Net ACH Export ${summary.date} (${mids.length} MIDs)`
        ),
        text: env(
          'EMAIL_BODY',
          `Attached is the Net ACH export for ${summary.range.start} to ${summary.range.end}.`
        ),
      });
    } catch (e) {
      console.warn('[EMAIL] send failed:', e?.message || e);
    }
  } finally {
    // Write summary & teardown
    summarize();
    const summaryName = env('SUMMARY_NAME', 'run-summary.json');
    const summaryPath = path.join(dayDir, summaryName);
    try {
      fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
      console.log(`Summary written: ${summaryPath}`);
    } catch (e) {
      console.error('Failed to write summary:', e.message);
    }
    await context.close();
    await browser.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
