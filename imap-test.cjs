#!/usr/bin/env node
const dotenv = require('dotenv'); dotenv.config();
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const bool = (v, d=true)=> (v==null||v==='')?d:/^(true|1|yes|on)$/i.test(String(v));
const num  = (v, d)=> Number.isFinite(Number(v)) ? Number(v) : d;
const env  = (k,d)=> (process.env[k]==null||process.env[k]==='')?d:process.env[k];

const DEBUG = bool(env('IMAP_DEBUG','false'), false);
const log = (...a)=> DEBUG && console.log('[IMAP]', ...a);

(async () => {
  const host = env('IMAP_HOST');
  const port = num(env('IMAP_PORT'), 993);
  const secure = bool(env('IMAP_SECURE'), true);
  const user = env('IMAP_USER');
  const pass = env('IMAP_PASS');
  const mailbox = env('IMAP_MAILBOX', 'INBOX');
  const altMailbox = env('IMAP_ALT_MAILBOX'); // e.g. [Gmail]/All Mail
  const fromFilter = (env('IMAP_FROM_FILTER','')||'').trim();
  const subjectFilter = (env('IMAP_SUBJECT_FILTER','')||'').trim() || 'Elevate MFA Code';
  const codeRegex = new RegExp(env('IMAP_CODE_REGEX', '(?<!\\d)\\d{6}(?!\\d)'));

  // Wider + more forgiving while we debug timeouts
  const lookbackMinutes = num(env('IMAP_LOOKBACK_MINUTES'), 60);
  const onlyUnseen = bool(env('IMAP_ONLY_UNSEEN'), true);

  if (!host || !user || !pass) {
    console.error('Missing IMAP_HOST/IMAP_USER/IMAP_PASS in .env');
    process.exit(1);
  }

  const client = new ImapFlow({
    host, port, secure,
    auth: { user, pass },
    logger: false,
    // --- Harden timeouts (bump way up) ---
    socketTimeout: num(env('IMAP_SOCKET_TIMEOUT_MS'), 120000),
    greetingTimeout: num(env('IMAP_CONN_TIMEOUT_MS'), 30000),
    authTimeout: num(env('IMAP_AUTH_TIMEOUT_MS'), 30000),
    // --- Some networks need SNI and TLSv1.2+ ---
    tls: {
      servername: env('IMAP_TLS_SERVERNAME', host),
      minVersion: 'TLSv1.2'
    },
    // --- Keep the connection alive so Gmail doesn't drop it mid-fetch ---
    keepalive: { interval: 15000, idleInterval: 300000, forceNoop: true, startAfterIdle: true }
  });

  client.on('error', (e)=> console.error('[IMAP client error]', e?.message || e));

  const sinceDate = new Date(Date.now() - lookbackMinutes*60*1000);

  async function openAndGetCode(box) {
    log('Opening mailbox:', box);
    await client.mailboxOpen(box);

    // Build a tolerant search in steps
    const queries = [];
    // 1) unread + from + subject
    const q1 = { since: sinceDate };
    if (fromFilter) q1.from = fromFilter;
    if (subjectFilter) q1.subject = subjectFilter;
    if (onlyUnseen) q1.seen = false;
    queries.push(q1);

    // 2) unread + subject
    const q2 = { since: sinceDate, subject: subjectFilter, seen: false };
    queries.push(q2);

    // 3) any seen state + subject
    const q3 = { since: sinceDate, subject: subjectFilter };
    queries.push(q3);

    // 4) broad newest few
    const q4 = { since: sinceDate };
    queries.push(q4);

    let uids = [];
    for (const q of queries) {
      try {
        const found = await client.search(q);
        log('search', q, '->', found.length);
        if (found.length) { uids = found; break; }
      } catch (e) {
        log('search error:', e?.message || e);
      }
    }
    if (!uids.length) return null;

    // newest first, check top N
    uids.sort((a,b)=> b-a);
    const top = uids.slice(0, 5);

    // SUBJECT first (fast, avoids body fetch on Gmail)
    for (const uid of top) {
      const envlp = await client.fetchOne(uid, { envelope: true, headers: true }).catch(e=> (log('fetchOne env err', e?.message||e), null));
      const subject = envlp?.envelope?.subject || envlp?.headers?.get('subject') || '';
      const m = subject && subject.match(codeRegex);
      if (m) {
        return { code: m[0], where: 'subject', uid, box, subject };
      }
    }

    // Then BODY (single-message fetch to avoid long streams)
    for (const uid of top) {
      const msg = await client.fetchOne(uid, { source: true, envelope: true }).catch(e=> (log('fetchOne src err', e?.message||e), null));
      if (!msg?.source) continue;
      const parsed = await simpleParser(msg.source).catch(e=> (log('parse err', e?.message||e), null));
      if (!parsed) continue;
      const body = `${parsed.subject||''}\n${parsed.text||''}\n${parsed.html||''}`;
      const m = body.match(codeRegex);
      if (m) {
        return { code: m[0], where: 'body', uid, box, subject: parsed.subject||'' };
      }
    }

    return null;
  }

  try {
    await client.connect();

    let res = await openAndGetCode(mailbox);
    if (!res && altMailbox) res = await openAndGetCode(altMailbox);

    if (!res) {
      console.log(JSON.stringify({ ok:false, reason:'not_found', mailbox, altMailbox, since: sinceDate.toISOString() }, null, 2));
      process.exit(1);
    }

    console.log(JSON.stringify({
      ok: true,
      result: {
        code: res.code,
        code_masked: res.code.replace(/^(\d{4})(\d{2})$/, '****$2'),
        where: res.where,
        mailbox: res.box,
        uid: res.uid,
        subject: res.subject
      }
    }, null, 2));
    process.exit(0);
  } catch (e) {
    console.error(JSON.stringify({ ok:false, error: e?.message || String(e) }, null, 2));
    process.exit(1);
  } finally {
    try { await client.logout(); } catch {}
  }
})();
