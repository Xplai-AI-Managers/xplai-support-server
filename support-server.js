const Imap = require('imap');
const { simpleParser } = require('mailparser');
const { Resend } = require('resend');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const express = require('express');

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err?.message || err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err?.message || err));

// ─── Config ──────────────────────────────────────────────
const IMAP_HOST     = process.env.IMAP_HOST || 'imap.porkbun.com';
const IMAP_PORT     = parseInt(process.env.IMAP_PORT || '993');
const RESEND_KEY    = process.env.RESEND_API_KEY;
const resend = new Resend(RESEND_KEY || '');
const EMAIL_USER    = process.env.EMAIL_USER || 'hello@xplai.eu';
const EMAIL_PASS    = process.env.EMAIL_PASS;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const TG_TOKEN      = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID    = process.env.TG_CHAT_ID || '6696661524';
const SHEETS_ID     = process.env.GOOGLE_SHEETS_ID || '1i9eHENfvlukANB6H5AUgfef9nsRxIKIHzZlShI-i9cc';
const BOSS_BOT_URL  = process.env.BOSS_BOT_URL || 'https://boss-bot-production-e74f.up.railway.app';

const claude = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ─── System prompt from CLAUDE.md ────────────────────────
const SYSTEM_PROMPT = `You are Alex, support manager at xplai.eu. You answer 24/7 via email.
You NEVER say you are AI. You sound like a real human manager.

PRODUCT:
Setup (excl VAT, LT +21%): Quick Start €499 | Starter €1,990 | Business €3,490 | Pro €5,990
Subscriptions/mo: Chat €79-599 | WA €89-649 | Email €69-549 | Phone €99-799 | Omni €249-1499
Flow: Setup → agent in 5 days → 1 month free → subscription.
NO free trial without Setup.

ALGORITHM:
Step 1 — Greet: introduce yourself, ask about their business.
Step 2 — Qualify (one question at a time): What business? How many messages/day? Pain point?
Step 3 — Propose (only after qualifying): recommend a plan, offer a demo.

OBJECTIONS:
"Too expensive" → "1 missed client = €50. Agent €89/mo = 2 days payback."
"Want free" → "Setup includes first month — that IS the trial."
"I'll think" → "Let me send a case study — agent answered 892 messages while owner slept."
"Have a manager" → "Manager until 18:00. Agent from 18:00 to 9:00 and weekends."

NEVER: Name price first (qualify first). Say you're AI. Give discounts without boss approval.
LANGUAGE: Reply in the same language as the incoming email.
Keep replies short — 2-4 sentences. Be warm and professional.`;

// ─── Spam & relevance filters ────────────────────────────
const SPAM_SUBJECTS = /lottery|winner|inheritance|urgent transfer|bitcoin/i;
const SPAM_SENDERS  = /^(noreply@|no-reply@|mailer-daemon@)/i;
const SPAM_BODY     = /click here|unsubscribe|act now|limited time/i;
const RELEVANT_KEYWORDS = /\b(ai|чат|chat|бизнес|business|цен|pricing|xplai|агент|agent|менеджер|manager|поддержк|support|demo|демо|setup|бот|bot)\b/i;

function getSpamScore(headers) {
  const score = headers?.['x-spam-score'];
  if (!score) return 0;
  return parseFloat(String(score)) || 0;
}

function isSpam(from, subject, text) {
  if (SPAM_SUBJECTS.test(subject)) return 'spam subject';
  if (SPAM_SENDERS.test(from))     return 'spam sender';
  if (SPAM_BODY.test(text))        return 'spam body';
  return false;
}

function isRelevant(subject, text) {
  const combined = (subject || '') + ' ' + (text || '');
  return RELEVANT_KEYWORDS.test(combined);
}

// ─── Flood tracking ──────────────────────────────────────
const hourlyEmails = [];
function trackFlood() {
  const now = Date.now();
  hourlyEmails.push(now);
  // Keep only last hour
  while (hourlyEmails.length > 0 && hourlyEmails[0] < now - 3600000) {
    hourlyEmails.shift();
  }
  if (hourlyEmails.length > 100) {
    console.log('[FLOOD ALERT]', hourlyEmails.length, 'emails in last hour');
    sendTelegram(`⚠️ Email flood: ${hourlyEmails.length} писем за последний час. Возможен спам.`);
    return true;
  }
  return false;
}

// ─── Conversation history per sender ─────────────────────
const conversations = new Map();
const CONV_TTL = 24 * 60 * 60 * 1000; // 24h

function getConversation(email) {
  const conv = conversations.get(email);
  if (conv && Date.now() - conv.lastUpdate < CONV_TTL) return conv.messages;
  conversations.set(email, { messages: [], lastUpdate: Date.now() });
  return conversations.get(email).messages;
}

function addToConversation(email, role, content) {
  const conv = getConversation(email);
  conv.push({ role, content });
  if (conv.length > 20) conv.splice(0, 2); // keep last 10 exchanges
  conversations.get(email).lastUpdate = Date.now();
}

// ─── SMTP transporter ────────────────────────────────────
// Resend HTTP API — no SMTP ports needed

// ─── Telegram helper ─────────────────────────────────────
async function sendTelegram(text) {
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.error('[TG send error]', e.message);
  }
}

// ─── Notify boss-bot about new lead ──────────────────────
async function notifyBossLead(name, email, message) {
  try {
    await fetch(`${BOSS_BOT_URL}/lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, source: 'email', message: (message || '').substring(0, 200) }),
    });
  } catch (e) {
    console.error('[boss-bot lead notify error]', e.message);
  }
}

// ─── Google Sheets CRM ──────────────────────────────────
async function appendToSheets(from, subject, snippet) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEETS_ID,
      range: 'Leads!A:E',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          new Date().toISOString(),
          from,
          subject,
          snippet.substring(0, 200),
          'email',
        ]],
      },
    });
    console.log('[CRM] Lead added:', from);
  } catch (e) {
    console.error('[CRM error]', e.message);
    // Fallback: notify via Telegram
    await sendTelegram(`📝 Новый лид (CRM offline):\n${from}\n${subject}`);
  }
}

// ─── Claude API reply ────────────────────────────────────
async function getAIReply(fromEmail, text) {
  addToConversation(fromEmail, 'user', text);
  const messages = getConversation(fromEmail);

  const response = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages,
  });

  const reply = response.content[0].text;
  addToConversation(fromEmail, 'assistant', reply);
  return reply;
}

// ─── Send email reply ────────────────────────────────────
async function sendReply(to, subject, text) {
  const reSubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;

  if (RESEND_KEY) {
    try {
      await resend.emails.send({
        to,
        from: 'Alex | xplai.eu <hello@xplai.eu>',
        subject: reSubject,
        text,
      });
      log({ action: 'EMAIL_SENT', from: to, reason: 'Resend' });
      return;
    } catch (e) {
      log({ action: 'RESEND_FAIL', from: to, reason: e.message });
    }
  }

  // Fallback: send draft via Telegram
  await sendTelegram(
    `📧 <b>Email не отправлен</b>\n\n` +
    `👤 Кому: ${to}\n📋 Тема: ${reSubject}\n\n` +
    `💬 Ответ:\n<pre>${text.substring(0, 500)}</pre>\n\n` +
    `⚠️ Отправь вручную с hello@xplai.eu`
  );
  log({ action: 'TG_FALLBACK', from: to, reason: 'Resend unavailable, sent to Telegram' });
}

// ─── Process a single email ──────────────────────────────
const processedUIDs = new Set();
let stats = { processed: 0, replied: 0, spam: 0, skipped: 0, errors: 0, startedAt: Date.now() };
const recentLog = [];
function log(entry) {
  const item = { time: new Date().toISOString(), ...entry };
  recentLog.push(item);
  if (recentLog.length > 50) recentLog.shift();
  console.log(`[${item.action}] ${item.from || ''} ${item.reason || item.subject || ''}`);
}

async function processEmail(parsed, uid) {
  if (processedUIDs.has(uid)) return;
  processedUIDs.add(uid);
  // Keep set bounded
  if (processedUIDs.size > 5000) {
    const arr = [...processedUIDs];
    arr.splice(0, 2000);
    processedUIDs.clear();
    arr.forEach(u => processedUIDs.add(u));
  }

  stats.processed++;
  trackFlood();

  const from    = parsed.from?.text || '';
  const fromAddr = parsed.from?.value?.[0]?.address || from;
  const subject = parsed.subject || '';
  // Prefer text/plain; fallback: strip HTML tags; last resort: use subject
  let text = parsed.text || '';
  if (!text.trim() && parsed.html) {
    text = parsed.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  if (!text.trim()) {
    text = subject;
  }
  const headers = parsed.headers || {};

  log({ action: 'MAIL', from: fromAddr, subject });

  // 1. Spam score check
  const spamScore = getSpamScore(headers);
  if (spamScore >= 5.0) {
    log({ action: 'SPAM', from: fromAddr, reason: `X-Spam-Score ${spamScore} >= 5.0` });
    stats.spam++;
    return;
  }

  // 2. Spam pattern check
  const spamReason = isSpam(fromAddr, subject, text);
  if (spamReason) {
    log({ action: 'SPAM', from: fromAddr, reason: spamReason });
    stats.spam++;
    return;
  }

  // 3. Don't reply to own emails or service emails
  if (fromAddr.includes('xplai.eu') || fromAddr.includes('noreply') || fromAddr.includes('resend.com')) {
    log({ action: 'SKIP', from: fromAddr, reason: 'own email or noreply' });
    stats.skipped++;
    return;
  }

  // 4. Reply to all non-spam emails from real people
  try {
    const reply = await getAIReply(fromAddr, text.substring(0, 2000));
    await sendReply(fromAddr, subject, reply);
    stats.replied++;
    log({ action: 'REPLIED', from: fromAddr, subject });

    // 5. Log lead to CRM + notify boss
    const senderName = parsed.from?.value?.[0]?.name || fromAddr;
    await appendToSheets(fromAddr, subject, text);
    await notifyBossLead(senderName, fromAddr, text);
  } catch (e) {
    log({ action: 'ERROR', from: fromAddr, reason: e.message });
    stats.errors++;
  }
}

// ─── IMAP polling ────────────────────────────────────────
let lastCheck = null;

function checkMail() {
  const imap = new Imap({
    user: EMAIL_USER,
    password: EMAIL_PASS,
    host: IMAP_HOST,
    port: IMAP_PORT,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    connTimeout: 30000,
    authTimeout: 15000,
  });

  imap.once('ready', () => {
    imap.openBox('INBOX', false, (err, box) => {
      if (err) {
        log({ action: 'IMAP_ERROR', reason: 'openBox: ' + err.message });
        imap.end();
        return;
      }

      log({ action: 'IMAP_CHECK', reason: `total: ${box.messages.total}, unseen: ${box.messages.new || 0}` });

      // Search for unseen messages
      imap.search(['UNSEEN'], (err, uids) => {
        if (err) {
          log({ action: 'IMAP_ERROR', reason: 'search: ' + err.message });
          imap.end();
          return;
        }

        if (!uids || uids.length === 0) {
          log({ action: 'IMAP_CHECK', reason: '0 unseen emails' });
          lastCheck = new Date().toISOString();
          imap.end();
          return;
        }

        log({ action: 'IMAP_FOUND', reason: `${uids.length} unseen email(s)` });
        let pending = uids.length;

        const f = imap.fetch(uids, {
          bodies: '',         // full message
          markSeen: true,     // mark as read
        });

        f.on('message', (msg, seqno) => {
          let uid = null;
          msg.on('attributes', (attrs) => { uid = attrs.uid; });
          msg.on('body', (stream) => {
            simpleParser(stream, (err, parsed) => {
              if (err) {
                console.error('[PARSE]', err.message);
                stats.errors++;
              } else {
                processEmail(parsed, uid || seqno).catch(e =>
                  console.error('[PROCESS]', e.message)
                );
              }
              if (--pending === 0) imap.end();
            });
          });
        });

        f.once('error', (err) => {
          console.error('[FETCH]', err.message);
          imap.end();
        });
      });
    });
  });

  imap.once('error', (err) => {
    log({ action: 'IMAP_ERROR', reason: err.message });
  });

  imap.once('end', () => {
    lastCheck = new Date().toISOString();
  });

  imap.connect();
}

// ─── Polling interval: every 5 minutes ───────────────────
const POLL_INTERVAL = 5 * 60 * 1000;
let pollTimer = null;

function startPolling() {
  console.log('[POLL] Starting email polling every 5 min');
  checkMail();
  pollTimer = setInterval(() => {
    checkMail();
  }, POLL_INTERVAL);
}

// ─── HTTP API (health, stats, manual trigger) ────────────
const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'xplai-support-server',
    uptime: Math.round(process.uptime()),
    lastCheck,
    stats,
  });
});

app.post('/check-now', (req, res) => {
  checkMail();
  res.json({ ok: true, message: 'Manual check triggered' });
});

app.get('/stats', (req, res) => {
  res.json({
    ...stats,
    uptimeSeconds: Math.round(process.uptime()),
    lastCheck,
    activeConversations: conversations.size,
    processedUIDs: processedUIDs.size,
    hourlyEmailRate: hourlyEmails.length,
  });
});

app.get('/log', (req, res) => {
  res.json(recentLog.slice(-20).reverse());
});

// ─── Start ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[HTTP] Support server listening on port ${PORT}`);
  startPolling();
});
