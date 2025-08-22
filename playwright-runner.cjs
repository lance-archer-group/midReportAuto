#!/usr/bin/env node
/* eslint-disable no-console */

// net-ach-export.js (resilient login+MFA+strict MID add+export)

// ===== Env loading (base .env, then overrides from .env.netach or ENV_FILE) ====
const path = require('path');
require('dotenv').config(); // loads .env



// ===== Imports ================================================================
const fs = require('fs');
const { chromium } = require('playwright');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

// ===== tiny env helpers =======================================================
function bool(v, d = true) { if (v == null || v === '') return d; return /^(true|1|yes|on)$/i.test(String(v)); }
function env(key, fallback = '') { const v = process.env[key]; return v == null || v === '' ? fallback : String(v); }
function numEnv(key, fallback) { const v = Number(process.env[key]); return Number.isFinite(v) ? v : fallback; }

// ===== paths / output =========================================================
const ROOT = __dirname;
const OUT_ROOT = path.join(ROOT, env('OUTPUT_DIR', 'reports'));
const ERROR_SHOTS = path.join(ROOT, env('ERROR_DIR', 'error_shots'));

// ===== date helpers (America/New_York) =======================================
const DATE_TZ = env('DATE_TZ', 'America/New_York');
function nyParts(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: DATE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const [y, m, d] = fmt.format(date).split('-').map(Number);
  return { y, m, d };
}
function nyStartOfDay(date) {
  const { y, m, d } = nyParts(date);
  return new Date(Date.UTC(y, m - 1, d, 5, 0, 0)); // 00:00 NY ≈ 05:00 UTC
}
function defaultRange() {
  const mode = env('DATE_MODE', 'yesterday').toLowerCase();
  const todayNY = nyStartOfDay(new Date());
  const start = new Date(todayNY);
  if (mode === 'yesterday') start.setUTCDate(start.getUTCDate() - 1);
  return { start, end: start };
}
function parseRangeFromEnv() {
  const s = env('START', '');
  const e = env('END', '');
  if (s || e) {
    const S = s ? new Date(s) : new Date();
    const E = e ? new Date(e) : S;
    if (isNaN(+S)) throw new Error(`Invalid START date: ${s}`);
    if (isNaN(+E)) throw new Error(`Invalid END date: ${e}`);
    return { start: S, end: E };
  }
  return defaultRange();
}
function fmtMMDDYYYY(d) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: DATE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
  return `${parts.month}/${parts.day}/${parts.year}`;
}

// ===== nav-race guard helpers ================================================
function isNavRace(err) {
  const s = String(err || '');
  return /Execution context was destroyed|Target closed|Navigation|Most likely because of a navigation/i.test(s);
}
async function withStablePage(page, fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  const retryPause = 200;
  while (true) {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      return await fn();
    } catch (e) {
      if (!isNavRace(e)) throw e;
      if (Date.now() >= deadline) throw e;
      await page.waitForTimeout(retryPause);
    }
  }
}

// ===== IMAP 2FA helpers ======================================================
async function get2faCodeFromImap() {
  const host   = env('IMAP_HOST', 'imap.gmail.com');
  const port   = numEnv('IMAP_PORT', 993);
  const secure = bool(env('IMAP_SECURE', 'true'), true);
  const user   = env('IMAP_USER');
  const pass   = env('IMAP_PASS');
  if (!user || !pass) throw new Error('IMAP_USER/IMAP_PASS not set');

  const mailboxCsv = env('IMAP_MAILBOXES', env('IMAP_MAILBOX', 'INBOX'));
  const mailboxes  = mailboxCsv.split(',').map(s => s.trim()).filter(Boolean);
  const subjectFilt = env('IMAP_SUBJECT_FILTER', 'Elevate MFA Code');
  const fromFilter  = env('IMAP_FROM_FILTER', '');
  const lookbackMin = numEnv('IMAP_LOOKBACK_MINUTES', 60);
  const onlyUnseen  = bool(env('IMAP_ONLY_UNSEEN', 'false'));
  const codeRxStr   = env('IMAP_CODE_REGEX', '(?<!\\d)\\d{6}(?!\\d)');
  const since       = new Date(Date.now() - lookbackMin * 60 * 1000);

  const client = new ImapFlow({ host, port, secure, auth: { user, pass }, logger: false, tls: { minVersion: 'TLSv1.2' }});
  try {
    await client.connect();
    for (const box of mailboxes) {
      await client.mailboxOpen(box).catch(() => {});
      const q = { since };
      if (subjectFilt) q.subject = subjectFilt;
      if (fromFilter)  q.from    = fromFilter;
      if (onlyUnseen)  q.seen    = false;

      let uids = [];
      try { uids = await client.search(q); } catch {}
      if (!uids.length && subjectFilt) {
        try { uids = await client.search({ subject: subjectFilt }); } catch {}
      }
      uids = Array.from(new Set(uids)).sort((a,b)=>b-a).slice(0, 100);

      for (const uid of uids) {
        const m = await client.fetchOne(uid, { source: true, envelope: true, flags: true, internalDate: true }).catch(() => null);
        if (!m) continue;
        if (onlyUnseen && m.flags?.includes('\\Seen')) continue;
        if (m.internalDate && +new Date(m.internalDate) < +since) continue;

        let parsed = null;
        try { parsed = await simpleParser(m.source); } catch {}
        const hay = [
          parsed?.subject ?? m.envelope?.subject ?? '',
          parsed?.text ?? '',
          String(parsed?.html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
        ].join('  ');
        try {
          const rx = new RegExp(codeRxStr, 'g');
          const mm = hay.match(rx);
          if (mm && mm[0]) return mm[0];
        } catch {}
        const spaced = hay.match(/(?<!\d)(?:\d[\s-]*){6}(?!\d)/);
        if (spaced && spaced[0]) {
          const only = spaced[0].replace(/[^\d]/g, '');
          if (only.length === 6) return only;
        }
      }
    }
  } finally {
    try { await client.logout(); } catch {}
  }
  return null;
}
async function waitFor2faCode() {
  const maxWaitMs = numEnv('MFA_MAX_WAIT_MS', 90_000);
  const pollMs    = numEnv('IMAP_POLL_MS', 3000);
  const end = Date.now() + maxWaitMs;
  while (Date.now() < end) {
    const code = await get2faCodeFromImap().catch(() => null);
    if (code) return code;
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error('Timed out waiting for 2FA email');
}

// ===== MFA UI helpers (nav-safe) ============================================
async function twofaScreenPresent(page) {
  if (/\/mfa\b/i.test(page.url())) return true;
  return await withStablePage(page, async () => {
    const a = await page.getByRole('textbox', { name: /passcode|code/i }).count().catch(() => 0);
    if (a > 0) return true;
    const b = await page.locator('input[autocomplete="one-time-code"]').count().catch(() => 0);
    return b > 0;
  }, 4000);
}
async function submitTwofaCode(page, code) {
  const clean = String(code || '').replace(/\D/g, '');
  await withStablePage(page, async () => {
    const single = page.getByRole('textbox', { name: /passcode|code/i }).first();
    if (await single.count()) {
      await single.fill(clean);
    } else {
      const guess = page
        .locator('input[autocomplete="one-time-code"], input[name*="code" i], input[id*="code" i]')
        .first();
      await guess.fill(clean);
    }
  });
  await withStablePage(page, async () => {
    const submit = page.getByRole('button', { name: /verify|continue|submit/i }).first();
    if (await submit.count()) {
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null),
        submit.click().then(() => null).catch(() => null),
      ]);
    } else {
      await page.keyboard.press('Enter').catch(() => {});
    }
  });
}
async function readTwofaErrorHint(page) {
  return await withStablePage(page, async () => {
    const loc = page.locator('.validation-summary-errors, .field-validation-error, [role="alert"], .text-danger, .error');
    const txts = await loc.allInnerTexts().catch(()=>[]);
    return (txts || []).map(s=>s.trim()).filter(Boolean).join(' | ').slice(0,300);
  }, 2000).catch(() => '');
}
async function clickTwofaResend(page) {
  return await withStablePage(page, async () => {
    const btn = page.locator('button:has-text("Resend"), a:has-text("Resend"), button:has-text("Send new code"), a:has-text("Send new code")').first();
    if (await btn.count()) { await btn.click().catch(()=>{}); await page.waitForTimeout(600); return true; }
    return false;
  }, 4000).catch(() => false);
}
async function waitForPostTwofa(page, totalTimeoutMs) {
  const end = Date.now() + totalTimeoutMs;
  while (Date.now() < end) {
    if (!/\/mfa\b/i.test(page.url())) {
      const still = await withStablePage(page, async () => {
        const c1 = await page.getByRole('textbox', { name: /passcode|code/i }).count().catch(() => 0);
        const c2 = await page.locator('input[autocomplete="one-time-code"]').count().catch(() => 0);
        return c1 + c2;
      }, 2000).catch(() => 0);
      if (still === 0) return true;
    }
    await page.waitForTimeout(300);
  }
  return false;
}

// ===== Login page readiness ==================================================
function loginPaths(base) {
  const raw = env('LOGIN_PATHS',
    '/login.aspx?ReturnUrl=%2f,/login.aspx,/Account/Login,/Account/LogOn,/login'
  );
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(p => {
    const rel = p.startsWith('/') ? p : '/' + p;
    return base.replace(/\/$/, '') + rel;
  });
}
async function isUnauthorizedSplash(page) {
  const title = await page.title().catch(() => '');
  if (/401|unauthorized|access is denied/i.test(title)) return true;
  const body = await page.locator('body').innerText().catch(() => '');
  return /401|unauthorized|access is denied/i.test(body || '');
}
async function waitForLoginForm(page, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await isUnauthorizedSplash(page).catch(() => false)) return false;
    const uCount = await page.getByRole('textbox', { name: /username/i }).count().catch(() => 0);
    const pCount = await page.getByRole('textbox', { name: /password/i }).count().catch(() => 0);
    if (uCount > 0 && pCount > 0) {
      try {
        await page.getByRole('textbox', { name: /username/i }).first()
          .waitFor({ state: 'visible', timeout: 2000 });
      } catch {}
      return true;
    }
    await page.waitForTimeout(300);
  }
  return false;
}
async function gotoLoginWithRetries(page, base) {
  const attempts = numEnv('LOGIN_RETRIES', 4);
  const backoff  = numEnv('LOGIN_BACKOFF_MS', 1500);
  const readyT   = numEnv('LOGIN_READY_WAIT_MS', 8000);
  const navState = env('LOAD_STATE', 'domcontentloaded');
  const navTimeout = numEnv('NAV_TIMEOUT_MS', 15000);

  const paths = loginPaths(base);

  for (let i = 1; i <= attempts; i++) {
    if (i === 1 && bool(env('CLEAR_COOKIES_BEFORE_LOGIN', 'false'))) {
      try { await page.context().clearCookies(); } catch {}
    }
    try {
      await page.goto(base.replace(/\/$/, ''), { waitUntil: navState, timeout: navTimeout });
      await page.waitForTimeout(300);
    } catch {}
    for (const url of paths) {
      try {
        await page.goto(url, { waitUntil: navState, timeout: navTimeout });
        const ok = await waitForLoginForm(page, readyT);
        if (ok) return true;
      } catch {}
    }
    await page.waitForTimeout(backoff * i);
  }
  throw new Error('Login form not found (or 401) after retries');
}

// ===== MID add — STRICT (must reach 100%) ====================================
function uniqueMids(arr) {
  const out = [];
  const seen = new Set();
  for (const s of arr.map(String)) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

async function readSelectedMids(page) {
  // 1) Chips text
  const chipTexts = await page.locator('.catMSValueList li').allTextContents().catch(() => []);
  const fromChips = new Set();
  for (const t of chipTexts) {
    const m = String(t || '').match(/\b(\d{6,})\b/);
    if (m) fromChips.add(m[1]);
  }

  // 2) Hidden inputs that may store values
  const fromHidden = await page.evaluate(() => {
    const acc = new Set();
    const add = (v) => {
      const parts = String(v || '').split(/[,\s;]+/);
      for (const p of parts) {
        const m = p.match(/\b(\d{6,})\b/);
        if (m) acc.add(m[1]);
      }
    };
    // try any hidden fields inside the multiselect container
    document.querySelectorAll('input[type="hidden"]').forEach(inp => {
      const nm = (inp.name || inp.id || '').toLowerCase();
      if (nm.includes('mid')) add(inp.value);
    });
    return Array.from(acc);
  }).catch(() => []);

  const all = new Set([...fromChips, ...fromHidden]);
  return Array.from(all);
}

async function addMidsIncremental(page, mids, opts = {}) {
  const input = page.getByRole('textbox', { name: /search by mid\/name/i }).first();
  await input.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
  const resultFor = (mid) =>
    page.locator('#MID-catmultiselect-resultbox .catMSResultList li', { hasText: new RegExp(`^${mid}\\b`) }).first();

  const delay = (ms) => page.waitForTimeout(ms);
  const perTypeDelay = numEnv('MID_PER_TYPE_DELAY_MS', 20);
  const afterTypePause = numEnv('MID_AFTER_TYPE_PAUSE_MS', 280);

  for (const mid of mids) {
    await input.click().catch(()=>{});
    await input.fill('');
    await input.type(String(mid), { delay: perTypeDelay }).catch(()=>{});
    await delay(afterTypePause);

    const row = resultFor(mid);
    if (await row.count()) {
      await row.click().catch(()=>{});
      await delay(100);
    } else {
      // fallback commit
      await input.press('Enter').catch(()=>{});
      await delay(120);
    }
  }
}

// Drop-in replacement
// Drop-in: no SELECTORS dependency
// Drop-in: same method as before, but waits for page/UI to be ready first
// Drop-in: disambiguate MID vs CorpMID and keep previous add method
async function addMidsStrict(page, mids) {
  // ---- Tunables (same as before) ----
  const navTimeout     = numEnv('NAV_TIMEOUT_MS', 15000);
  const debounceMs     = numEnv('RESULT_DEBOUNCE_MS', 350);
  const resultTimeout  = numEnv('RESULT_TIMEOUT_MS', 10000);
  const betweenAdds    = numEnv('MID_ADD_PAUSE_MS', 100);
  const retries        = numEnv('MID_ADD_RETRIES', 2);
  const retryBackoff   = numEnv('MID_RETRY_BACKOFF_MS', 400);
  const jitterMax      = numEnv('MID_ADD_JITTER_MS', 120);
  const warnOnly       = bool(env('MID_FINAL_WARN_ONLY', 'false'));
  const postNavMs      = numEnv('POST_NAV_PAUSE_MS', numEnv('POST_RUN_PAUSE_MS', 1200));

  // ---- Readiness: let the page/UI settle first ----
  await page.waitForLoadState(env('LOAD_STATE', 'networkidle')).catch(() => {});
  await page.waitForTimeout(postNavMs);

  // anchor presence
  const waitForAny = async (selectors, timeoutMs = 12000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (const q of selectors) {
        const loc = page.locator(q).first();
        if (await loc.count().catch(() => 0)) return true;
      }
      await page.waitForTimeout(200);
    }
    return false;
  };
  await waitForAny([
    '#reportParams', '#reportWrap', '#mainRepHead',
    'button:has-text("Load report")', 'text=/Net\\s+ACH\\s+Details/i'
  ], numEnv('MID_READY_WAIT_MS', 12000));

  // ---- Portal selectors: force the *MID* set, exclude CorpMID ----
  // Input: prefer exact id, then fallbacks that *exclude* #CorpMID-catmultiselect
  const inputCandidates = [
    'input#MID-catmultiselect',
    'input[id="MID-catmultiselect"]',
    'input[placeholder="Search by MID/Name"][id^="MID"]',
    'input[placeholder="Search by MID/Name"]:not(#CorpMID-catmultiselect)'
  ];
  const input = (() => {
    for (const q of inputCandidates) {
      const loc = page.locator(q);
      if (loc) return loc.first();
    }
    return page.locator('input#MID-catmultiselect').first();
  })();

  // Result items & chips: pin to MID containers first, then generic
  const resultItemsQPriority = [
    '#MID-catmultiselect-resultbox .catMSResultList li',
    '#MID-catmultiselect .catMSResultList li',
    '.catMSResultList li'
  ];
  const chipsQPriority = [
    '#MID-catmultiselect .catMSValueList li',
    '.catMSValueList li'
  ];
  const resultsBoxQPriority = [
    '#MID-catmultiselect-resultbox',
    '#MID-catmultiselect .catMSResultList',
    '.catMSResultList'
  ];

  const pickFirstExistingQuery = async (queries, fallback) => {
    for (const q of queries) {
      const n = await page.locator(q).count().catch(() => 0);
      if (n > 0) return q;
    }
    return fallback;
  };

  const resultItemsQ = await pickFirstExistingQuery(resultItemsQPriority, resultItemsQPriority.slice(-1)[0]);
  const chipsQ       = await pickFirstExistingQuery(chipsQPriority,      chipsQPriority.slice(-1)[0]);
  const resultsBoxQ  = await pickFirstExistingQuery(resultsBoxQPriority, resultsBoxQPriority.slice(-1)[0]);

  try {
    // Ensure we have a unique input (avoid strict violation)
    const count = await input.count().catch(() => 0);
    if (count !== 1) {
      // last-ditch unique selector
      const unique = page.locator('input#MID-catmultiselect');
      if ((await unique.count()) === 1) {
        await unique.waitFor({ state: 'visible', timeout: navTimeout });
      } else {
        try { await saveArtifacts(page, 'mids-input-ambiguous'); } catch {}
        throw new Error(`MID input ambiguous: matched ${count} nodes`);
      }
    } else {
      await input.waitFor({ state: 'visible', timeout: navTimeout });
    }
  } catch (e) {
    try { await saveArtifacts(page, 'mids-input-not-found'); } catch {}
    throw new Error('MID input not found (Search by MID/Name)');
  }

  const resultsBox = page.locator(resultsBoxQ).first();
  const chipForMid   = (mid) => page.locator(chipsQ,       { hasText: String(mid) }).first();
  const resultForMid = (mid) => page.locator(
    `${resultItemsQ}:has-text("${String(mid)} -"), ${resultItemsQ}:has-text("${String(mid)}")`
  ).first();

  const ensureChip = async (mid, timeout = 1500) => {
    try { await chipForMid(mid).waitFor({ state: 'visible', timeout }); return true; }
    catch { return false; }
  };

  const clearInputHard = async () => {
    await input.fill('');
    try { await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace'); } catch {}
  };
  const tinyJitter = async () => {
    if (jitterMax > 0) await page.waitForTimeout(Math.floor(Math.random() * jitterMax));
  };

  // Same method as before, with guarded Enter fallback
  const typeWaitClick = async (mid) => {
    await input.click();
    await clearInputHard();
    await input.type(String(mid), { delay: 18 });
    await page.waitForTimeout(debounceMs);
    await tinyJitter();

    // Best-effort: make the list appear
    await resultsBox.waitFor({ state: 'visible', timeout: Math.min(resultTimeout, 2000) }).catch(() => {});

    const row = resultForMid(mid);
    try {
      await row.waitFor({ state: 'visible', timeout: resultTimeout });
    } catch {
      // Use Enter only if there are actually items under the results list
      const anyItems = await page.locator(resultItemsQ).count().catch(() => 0);
      if (anyItems > 0) {
        try { await input.press('Enter'); } catch {}
        await page.waitForTimeout(150);
        return ensureChip(mid);
      }
      return false; // avoid triggering "Load report"
    }

    try { await row.scrollIntoViewIfNeeded().catch(() => {}); await row.click({ timeout: navTimeout }); }
    catch { try { await row.click({ timeout: navTimeout, force: true }); } catch {} }

    await page.waitForTimeout(150);
    return ensureChip(mid);
  };

  console.log(`[mids] target total: ${mids.length}`);

  // Skip ones already present
  const existing = new Set(
    (await page.locator(chipsQ).allTextContents().catch(() => []))
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
      await page.waitForTimeout(retryBackoff * (attempt + 1));
    }

    if (!ok) {
      try { await input.blur(); await page.waitForTimeout(80); await input.focus(); } catch {}
      ok = await ensureChip(mid, 800);
    }

    if (!ok) misses.push(mid);
    else existing.add(mid);

    await page.waitForTimeout(betweenAdds);
  }

  if (misses.length) {
    const order = [...misses];
    const last = mids[mids.length - 1];
    const li = order.indexOf(last); if (li > 0) { order.splice(li, 1); order.unshift(last); }

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
      const msg = `Some MIDs were not added as chips: ${stillMissing.join(', ')}`;
      if (warnOnly) console.warn(msg);
      else throw new Error(msg);
    }
  }
}

// ===== Export helpers ========================================================
async function waitAnyDownloadOrNav(page, timeout) {
  const direct = page.waitForEvent('download', { timeout }).then(d => ({ kind: 'download', d })).catch(()=>null);
  const nav    = page.waitForNavigation({ timeout, waitUntil: 'networkidle' }).then(()=>({ kind: 'nav' })).catch(()=>null);
  return Promise.race([direct, nav].filter(Boolean));
}

async function exportCombined(page, outDir, baseName = 'net-ach') {
  // A) use data-url if present
  const frames = [page.mainFrame(), ...page.frames()];
  for (const f of frames) {
    const btn = f.locator('[data-url*="/Reporting/ExportReport.aspx"]').first();
    if (await btn.count()) {
      const rel = await btn.getAttribute('data-url');
      if (rel) {
        const abs = new URL(rel, new URL(f.url()).origin).href;
        const race = waitAnyDownloadOrNav(page, numEnv('EXPORT_TIMEOUT_MS', 60_000));
        await f.evaluate(u => window.location.assign(u), abs);
        const res = await race;
        if (res?.kind === 'download') {
          let suggested = null; try { suggested = res.d.suggestedFilename(); } catch {}
          const out = path.join(outDir, suggested || `${baseName}.xlsx`);
          await res.d.saveAs(out);
          return out;
        }
        const late = await page.waitForEvent('download', { timeout: 1500 }).catch(()=>null);
        if (late) {
          let suggested = null; try { suggested = late.suggestedFilename(); } catch {}
          const out = path.join(outDir, suggested || `${baseName}.xlsx`);
          await late.saveAs(out);
          return out;
        }
      }
    }
  }

  // B) derive from current /Reporting/Report.aspx?... query
  const cur = new URL(page.url());
  if (/\/Reporting\/Report\.aspx$/i.test(cur.pathname)) {
    cur.pathname = '/Reporting/ExportReport.aspx';
    cur.searchParams.set('_', String(Date.now()));
    const href = cur.href;
    const race = waitAnyDownloadOrNav(page, numEnv('EXPORT_TIMEOUT_MS', 60_000));
    await page.evaluate(u => window.location.assign(u), href);
    const res = await race;
    if (res?.kind === 'download') {
      let suggested = null; try { suggested = res.d.suggestedFilename(); } catch {}
      const out = path.join(outDir, suggested || `${baseName}.xlsx`);
      await res.d.saveAs(out);
      return out;
    }
    const late = await page.waitForEvent('download', { timeout: 1500 }).catch(()=>null);
    if (late) {
      let suggested = null; try { suggested = late.suggestedFilename(); } catch {}
      const out = path.join(outDir, suggested || `${baseName}.xlsx`);
      await late.saveAs(out);
      return out;
    }
  }

  // C) last resort: click visible Export
  const expBtn = page.getByRole('button', { name: /export/i }).first();
  if (await expBtn.count()) {
    const race = waitAnyDownloadOrNav(page, numEnv('EXPORT_TIMEOUT_MS', 60_000));
    await expBtn.click().catch(()=>{});
    const res = await race;
    if (res?.kind === 'download') {
      let suggested = null; try { suggested = res.d.suggestedFilename(); } catch {}
      const out = path.join(outDir, suggested || `${baseName}.xlsx`);
      await res.d.saveAs(out);
      return out;
    }
  }
  throw new Error('Export did not yield a downloadable file');
}

// ===== merchants loader (optional) ===========================================
function loadMerchantsMids() {
  const midsEnv = (env('MIDS', '') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (midsEnv.length) return uniqueMids(midsEnv);

  const mf = env('MERCHANTS_FILE', 'merchants.json');
  const mp = path.join(ROOT, mf);
  if (!fs.existsSync(mp)) return [];
  const raw = JSON.parse(fs.readFileSync(mp, 'utf-8'));
  if (raw && typeof raw === 'object' && Array.isArray(raw.merchant_ids)) {
    return uniqueMids(raw.merchant_ids.map(String));
  }
  if (Array.isArray(raw)) {
    const idKeys = ['merchant id', 'merchant_id', 'mid', 'id'];
    const list = [];
    for (const item of raw) {
      if (item == null) continue;
      if (typeof item === 'string') list.push(String(item));
      else {
        for (const k of Object.keys(item)) {
          const kl = k.toLowerCase().trim();
          if (idKeys.includes(kl)) { list.push(String(item[k]).trim()); break; }
        }
      }
    }
    return uniqueMids(list);
  }
  return [];
}

// ===== diagnostics ===========================================================
async function saveArtifacts(page, label, diagDir) {
  try {
    fs.mkdirSync(diagDir, { recursive: true });
    const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
    const sPath = path.join(diagDir, `${stamp()}-${label}.png`);
    const hPath = path.join(diagDir, `${stamp()}-${label}.html`);
    await page.screenshot({ path: sPath, fullPage: true }).catch(()=>{});
    await fs.promises.writeFile(hPath, await page.content()).catch(()=>{});
    console.log('[ARTIFACTS]', sPath, '|', hPath);
  } catch {}
}

// ===== main run ==============================================================
async function main() {
  console.log('▶️  Net ACH Export (Node) starting');
  console.log(`Node: ${process.version} (${process.platform} ${process.arch})`);
  console.log(`CWD: ${process.cwd()}`);
  console.log(`Start: ${new Date().toISOString()}`);

  // output paths
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  fs.mkdirSync(ERROR_SHOTS, { recursive: true });

  const { start, end } = parseRangeFromEnv();
  const dayFolderName = new Intl.DateTimeFormat('en-CA', { timeZone: DATE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(start);
  const dayDir = path.join(OUT_ROOT, dayFolderName);
  fs.mkdirSync(dayDir, { recursive: true });
  const diagDir = path.join(ERROR_SHOTS, 'export_diag');

  const mids = loadMerchantsMids();
  if (!mids.length) console.warn('[mids] none provided (MIDS or merchants.json) — will proceed without MID filter if UI allows');

  const base = env('ELEVATE_BASE', 'https://portal.elevateqs.com');
  const navState = env('LOAD_STATE', 'domcontentloaded');
  const navTimeout = numEnv('NAV_TIMEOUT_MS', 15000);

  const runningInDocker = fs.existsSync('/.dockerenv');
  const hasDisplay = !!process.env.DISPLAY;
  const effectiveHeadless =
    process.env.HEADLESS != null && process.env.HEADLESS !== ''
      ? /^(true|1|yes|on)$/i.test(String(process.env.HEADLESS))
      : runningInDocker || !hasDisplay;

  console.log('Config:', {
    HEADLESS: String(effectiveHeadless),
    SLOWMO_MS: numEnv('SLOWMO_MS', 0),
    NAV_TIMEOUT_MS: navTimeout,
    LOAD_STATE: navState,
    DATE_TZ,
  });

  const browser = await chromium.launch({
    headless: effectiveHeadless,
    slowMo: Number(process.env.SLOWMO_MS ?? 0) || 0,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(navTimeout);
  page.setDefaultNavigationTimeout(navTimeout);

  try {
    // 1) Calm login: navigate and wait for form
    if (!env('ELEVATE_USERNAME') || !env('ELEVATE_PASSWORD')) {
      throw new Error('ELEVATE_USERNAME/ELEVATE_PASSWORD not set');
    }
    console.log('[login] locating login form…');
    await gotoLoginWithRetries(page, base);

    await withStablePage(page, async () => {
      await page.getByRole('textbox', { name: /username/i }).fill(env('ELEVATE_USERNAME'));
      await page.getByRole('textbox', { name: /password/i }).fill(env('ELEVATE_PASSWORD'));
    });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: navTimeout }).catch(()=>{}),
      withStablePage(page, async () => page.getByRole('button', { name: /login/i }).click()),
    ]);

    // 2) MFA (robust & nav-safe)
    await page.waitForTimeout(numEnv('MFA_READY_WAIT_MS', 800));
    let onMfa = false;
    try { onMfa = await twofaScreenPresent(page); } catch { onMfa = /\/mfa\b/i.test(page.url()); }

    if (onMfa) {
      console.log('[2FA] screen detected — fetching code via IMAP…');
      const attempts = numEnv('MFA_SUBMIT_ATTEMPTS', 3);
      let done = false, lastErr = '';

      for (let i = 1; i <= attempts; i++) {
        try {
          if (!/\/mfa\b/i.test(page.url()) && !(await twofaScreenPresent(page).catch(()=>false))) {
            console.log('[2FA] page left MFA before submitting; continuing.');
            done = true; break;
          }
        } catch {}
        const code = await waitFor2faCode();
        await submitTwofaCode(page, code);
        const ok = await waitForPostTwofa(page, numEnv('MFA_POST_SUBMIT_WAIT_MS', 8000));
        if (ok) { done = true; break; }
        lastErr = await readTwofaErrorHint(page);
        console.warn(`[2FA] attempt ${i}/${attempts} did not pass: ${lastErr || 'no hint'}`);
        await clickTwofaResend(page);
        await page.waitForTimeout(800);
      }

      if (!done) {
        await saveArtifacts(page, 'mfa-stuck', diagDir);
        throw new Error(`2FA did not complete after retries: ${lastErr || 'unknown error'}`);
      }
      console.log('[2FA] done.');
    } else {
      console.log('[2FA] screen not detected; continuing.');
    }

    // 3) navigate to Advanced Reporting → Net ACH Details
    const tryClick = async (locator) => {
      return await withStablePage(page, async () => {
        const n = await locator.count().catch(()=>0);
        if (!n) return false;
        const first = locator.first();
        try {
          await first.scrollIntoViewIfNeeded().catch(()=>{});
          await Promise.all([
            page.waitForLoadState(navState).catch(()=>{}),
            first.click({ timeout: navTimeout }),
          ]);
          return true;
        } catch {
          try {
            await Promise.all([
              page.waitForLoadState(navState).catch(()=>{}),
              first.click({ timeout: navTimeout, force: true }),
            ]);
            return true;
          } catch {
            return false;
          }
        }
      });
    };

    if (!(await tryClick(page.getByText(/query system/i)))) { /* ok if missing */ }
    if (!(await tryClick(page.getByRole('link', { name: /advanced reporting/i })))) {
      const reportSelect = base.replace(/\/$/, '') + '/Reporting/ReportSelect.aspx';
      await page.goto(reportSelect, { waitUntil: navState, timeout: navTimeout }).catch(()=>{});
    }
    if (!(await tryClick(page.getByRole('link', { name: /net ach details/i })))) {
      const achPath = '/Reporting/Report.aspx?reportID=25';
      await page.goto(base.replace(/\/$/, '') + achPath, { waitUntil: navState, timeout: navTimeout }).catch(()=>{});
    }

    // 4) add MIDs — STRICT: require all before proceeding
    if (mids.length) {
      console.log('[mids] target total:', mids.length);
      await addMidsStrict(page, mids);
    }

    // 5) dates
    const startStr = fmtMMDDYYYY(start);
    const endStr   = fmtMMDDYYYY(end);
    console.log('[dates]', startStr, '→', endStr);
    await withStablePage(page, async () => {
      await page.locator('#fileDateStart').fill(startStr).catch(()=>{});
      await page.locator('#fileDateEnd').fill(endStr).catch(()=>{});
    });

    // 6) load report — only now that all MIDs are in
    await withStablePage(page, async () => page.getByRole('button', { name: /load report/i }).click().catch(()=>{}));
    await page.locator('#resultsCont #mainRepHead').waitFor({ state: 'visible', timeout: 20_000 }).catch(()=>{});

    // 7) export
    console.log('[export] exporting…');
    const outPath = await exportCombined(page, dayDir, `net-ach-${startStr}-${endStr}`);
    console.log('[export] saved →', outPath);
    // --- Email the export (best-effort) -----------------------------------------
try {
  if (process.env.EMAIL_TO) {
    await emailReport(outPath, {
      subject: process.env.EMAIL_SUBJECT || `Net ACH Export ${dayFolderName}`,
      text: process.env.EMAIL_BODY || `Attached is the Net ACH export for ${startStr} → ${endStr}.`,
      filename: path.basename(outPath),
    });
  } else {
    console.log('[EMAIL] EMAIL_TO not set — skipping send.');
  }
} catch (e) {
  console.warn('[EMAIL] send failed:', e?.message || e);
}
  } catch (e) {
    console.error('[run] failed:', e?.message || e);
    await saveArtifacts(page, 'fatal', path.join(ERROR_SHOTS, 'fatal'));
    process.exitCode = 1;
  } finally {
    await page.waitForTimeout(300); // small grace
    await context.close().catch(()=>{});
    await browser.close().catch(()=>{});
    console.log('[main] done.');
  }
}

if (require.main === module) {
  const mode = (process.argv[2] || process.env.MODE || '').toLowerCase();
  if (mode === 'server' || mode === 'idle') {
    // idle mode: start the small HTTP trigger
    startTriggerServer(main);
  } else {
    // default: one-shot run (keeps existing behavior)
    main();
  }
}
// Minimal idle trigger server (POST /run)
// Env: JOB_PORT (default 3889), JOB_API_KEY (optional)
function startTriggerServer(runOnce = main) {
  const http = require('http');
  const port = Number(process.env.JOB_PORT) || 3889;
  const requiredKey = process.env.JOB_API_KEY || '';

  // simple singleton-ish state for this process
  const state = {
    running: false,
    lastRun: null,
    lastErr: null,
  };

  const json = (res, code, obj) => {
    res.statusCode = code;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer((req, res) => {
    const rawPath = req.url || '/';
    const pathOnly = rawPath.split('?')[0].replace(/\/+$/, '') || '/';
    const method = req.method || 'GET';
    console.log(`[idle] ${method} ${rawPath} → ${pathOnly}`);

    // health/status
    if (method === 'GET' && (pathOnly === '/health' || pathOnly === '/status')) {
      return json(res, 200, {
        ok: true,
        running: state.running,
        lastRun: state.lastRun,
        lastErr: state.lastErr,
      });
    }

    if (method === 'GET' && pathOnly === '/last') {
      return json(res, 200, {
        running: state.running,
        lastRun: state.lastRun,
        lastErr: state.lastErr,
      });
    }

    // trigger run
    if (method === 'POST' && pathOnly === '/run') {
      const key = (req.headers['x-api-key'] || '').toString();
      if (requiredKey && key !== requiredKey) {
        return json(res, 401, { error: 'unauthorized' });
      }
      if (state.running) {
        // don’t error; acknowledge so callers don’t block
        return json(res, 200, { ok: true, message: 'already running' });
      }

      state.running = true;
      state.lastErr = null;
      const startedAt = new Date().toISOString();

      // ACK immediately and do work in background
      json(res, 202, { ok: true, accepted: true, startedAt });

      (async () => {
        try {
          await runOnce();
          state.lastRun = { ok: true, startedAt, finishedAt: new Date().toISOString() };
        } catch (e) {
          const msg = e?.message || String(e);
          state.lastErr = msg;
          state.lastRun = { ok: false, startedAt, finishedAt: new Date().toISOString(), error: msg };
          console.error('[idle/run] failed:', msg);
        } finally {
          state.running = false;
        }
      })();

      return;
    }

    return json(res, 404, { error: 'not found', path: pathOnly, method });
  });

  server.listen(port, () => {
    console.log(`[idle] Trigger server listening on :${port}`);
    console.log(`[idle] POST /run (x-api-key required if JOB_API_KEY is set) -> 202 Accepted`);
    console.log(`[idle] GET  /health or /status`);
    console.log(`[idle] GET  /last`);
  });

  return server;
}
