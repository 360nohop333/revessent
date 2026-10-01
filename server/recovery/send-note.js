// Revessent /api/recovery/send-note
// Drafts and optionally sends a warm AI-written recovery email for a failed
// payment case. Drafting uses Google Gemini; sending uses Resend.
//
// This file is both an HTTP endpoint and an internal helper. The exported
// sendRecoveryEmail({ client, organizationId, caseId, ... }) function drafts
// AND sends in one call, so the hourly escalation cron
// (api/cron/process-recovery-queue.js) can send outreach without an HTTP
// round-trip to this endpoint.

const { Pool } = require('pg');
const { createUnsubscribeToken, appBaseUrl } = require('../_lib/unsubscribe-token');
const { logAudit } = require('../_lib/audit');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zujmouzzqiovgbnanrvv.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_7JoawOBwMZ-ZIFmDrjkHSA_AdIWlCi3';
// Audit #36: make the model configurable — gemini-2.0-flash was retired
// by Google; set GEMINI_MODEL to whatever is current when deploying.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const CLOSED_STATUSES = new Set(['recovered', 'lost', 'canceled']);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1, // audit #45: single connection per serverless instance
  ssl: { rejectUnauthorized: false },
});

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function getBearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function verifySupabaseToken(token) {
  if (!token) {
    const error = new Error('Missing authorization token.');
    error.statusCode = 401;
    throw error;
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
    },
  });

  if (!response.ok) {
    const error = new Error('Invalid or expired authorization token.');
    error.statusCode = 401;
    throw error;
  }

  const supabaseUser = await response.json();
  const supabaseUserId = (supabaseUser && supabaseUser.id ? String(supabaseUser.id) : '').trim();
  const email = (supabaseUser && supabaseUser.email ? String(supabaseUser.email) : '').trim().toLowerCase();

  if (!supabaseUserId) {
    const error = new Error('Supabase user id is missing.');
    error.statusCode = 401;
    throw error;
  }

  if (!email) {
    const error = new Error('Supabase user has no email address.');
    error.statusCode = 401;
    throw error;
  }

  return { email, supabaseUserId };
}

async function findNeonUserBySupabaseId(client, supabaseUserId) {
  const result = await client.query(
    `select id, organization_id, email, role, supabase_user_id
       from users
      where supabase_user_id = $1
      limit 1`,
    [supabaseUserId]
  );

  return result.rows[0] || null;
}

async function findNeonUserByEmail(client, email) {
  const result = await client.query(
    `select id, organization_id, email, role, supabase_user_id
       from users
      where lower(email) = lower($1)
      limit 1`,
    [email]
  );

  return result.rows[0] || null;
}

async function backfillSupabaseUserId(client, user, supabaseUserId) {
  if (!user || !supabaseUserId || user.supabase_user_id) return user;

  try {
    const result = await client.query(
      `update users
          set supabase_user_id = $1
        where id = $2
          and supabase_user_id is null
      returning id, organization_id, email, role, supabase_user_id`,
      [supabaseUserId, user.id]
    );

    return result.rows[0] || user;
  } catch (error) {
    if (error && error.code === '23505') {
      const boundUser = await findNeonUserBySupabaseId(client, supabaseUserId);
      if (boundUser && String(boundUser.id) === String(user.id)) return boundUser;
    }
    throw error;
  }
}

async function authenticateRequest(req, client) {
  const token = getBearerToken(req);
  const { email, supabaseUserId } = await verifySupabaseToken(token);
  let user = await findNeonUserBySupabaseId(client, supabaseUserId);

  if (!user) {
    user = await findNeonUserByEmail(client, email);

    if (user && user.supabase_user_id && user.supabase_user_id !== supabaseUserId) {
      const error = new Error('Supabase account is already bound to a different Revessent user.');
      error.statusCode = 401;
      throw error;
    }

    if (user) user = await backfillSupabaseUserId(client, user, supabaseUserId);
  }

  if (!user) {
    const error = new Error('No Revessent user found for this Supabase account.');
    error.statusCode = 401;
    throw error;
  }

  return { token, email, supabaseUserId, user };
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
  if (Buffer.isBuffer(req.body)) {
    const raw = req.body.toString('utf8');
    return raw ? JSON.parse(raw) : {};
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function cleanString(value) {
  return value == null ? '' : String(value).trim();
}

function asJson(value) {
  return JSON.stringify(value == null ? {} : value);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function bodyToHtml(body) {
  const paragraphs = cleanString(body).split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  if (!paragraphs.length) return '<p></p>';
  return paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`).join('\n');
}

function amountLabel(amountCents, currency) {
  const amount = (Number(amountCents || 0) / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  return `${cleanString(currency || 'INR').toUpperCase()} ${amount}`;
}

function firstName(nameOrEmail) {
  const text = cleanString(nameOrEmail);
  if (!text) return '';
  const local = text.includes('@') ? text.split('@')[0] : text;
  return cleanString(local.split(/[\s._-]+/)[0]);
}

async function loadCaseContext(client, organizationId, caseId) {
  const result = await client.query(
    `select
       rc.*,
       sm.name as member_name,
       sm.email as member_email,
       org.name as organization_name
     from recovery_cases rc
     left join stripe_members sm on sm.id = rc.member_id
     left join organizations org on org.id = rc.organization_id
     where rc.id = $1
     limit 1`,
    [caseId]
  );

  const row = result.rows[0] || null;
  if (!row) {
    const error = new Error('Recovery case not found.');
    error.statusCode = 404;
    throw error;
  }
  if (String(row.organization_id) !== String(organizationId)) {
    const error = new Error('You do not have access to this recovery case.');
    error.statusCode = 403;
    throw error;
  }
  if (CLOSED_STATUSES.has(row.status)) {
    const error = new Error('Cannot draft or send a note for a closed recovery case.');
    error.statusCode = 400;
    throw error;
  }
  if (!cleanString(row.member_email)) {
    const error = new Error('Customer email is missing for this recovery case.');
    error.statusCode = 400;
    throw error;
  }
  return row;
}

async function loadVoiceProfile(client, organizationId, organizationName) {
  const result = await client.query(
    `select brand_name, sender_name, sender_email, tone_description
       from voice_profiles
      where organization_id = $1
        and is_default = true
      order by updated_at desc nulls last, created_at desc nulls last
      limit 1`,
    [organizationId]
  );

  const voice = result.rows[0] || {};
  const brandName = cleanString(voice.brand_name) || cleanString(organizationName) || 'your workspace';
  const senderName = cleanString(voice.sender_name) || brandName || 'Revessent';
  const senderEmail =
    cleanString(voice.sender_email) ||
    cleanString(process.env.RESEND_FROM_EMAIL) ||
    cleanString(process.env.DEFAULT_SENDER_EMAIL) ||
    'hello@revessent.com';
  const toneDescription = cleanString(voice.tone_description) || 'Professional';
  return { brandName, senderName, senderEmail, toneDescription };
}

async function draftWithGemini(context, voice) {
  if (!process.env.GEMINI_API_KEY) {
    const error = new Error('AI drafting not configured.');
    error.statusCode = 500;
    throw error;
  }

  const customerFirstName = firstName(context.member_name || context.member_email);
  const amount = amountLabel(context.amount_cents, context.currency);
  const prompt = [
    'Write a short payment recovery email under 120 words.',
    'Return ONLY the email body text. No subject line, no markdown, no commentary, no preamble.',
    `Tone: ${voice.toneDescription}.`,
    `Brand: ${voice.brandName}.`,
    `Sender: ${voice.senderName}.`,
    customerFirstName ? `Customer first name: ${customerFirstName}.` : 'No customer first name is available.',
    `Failed amount: ${amount}.`,
    context.decline_code ? `Decline reason code: ${context.decline_code}.` : '',
    'Hard rules (never break): never offer discounts, refunds, fee waivers or extensions; never include URLs or links; never promise the charge was or will be reversed; never ask for card numbers, OTPs, passwords or banking details.',
    'Requirements: warm but not desperate, no guilt-tripping, mention the amount naturally, one clear call to action to update their payment method, signed from the sender at the brand.',
  ].filter(Boolean).join('\n');

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    // Audit #11: auth via header, not ?key= — URL query strings end up in logs.
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 600, temperature: 0.65 },
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = cleanString(payload && payload.error && payload.error.message) || 'AI drafting failed.';
    const error = new Error(message);
    error.statusCode = 502;
    throw error;
  }

  const text = (((payload.candidates || [])[0] || {}).content || {}).parts || [];
  const body = text.map((part) => part.text || '').join('\n').trim();
  if (!body) {
    const error = new Error('AI drafting returned an empty email.');
    error.statusCode = 502;
    throw error;
  }

  return body;
}

async function insertRecoveryNote(client, values) {
  const noteId = crypto.randomUUID();
  await client.query(
    `insert into recovery_notes
       (id, case_id, organization_id, subject, body, requires_approval, sent_at, created_at, updated_at)
     values
       ($1, $2, $3, $4, $5, $6, null, now(), now())`,
    [noteId, values.caseId, values.organizationId, values.subject, values.body, values.requiresApproval]
  );
  return noteId;
}

async function loadExistingNote(client, organizationId, noteId) {
  const result = await client.query(
    `select rn.*, rc.member_id, rc.status as case_status, sm.email as member_email,
            sm.name as member_name, org.name as organization_name
       from recovery_notes rn
       join recovery_cases rc on rc.id = rn.case_id
       left join stripe_members sm on sm.id = rc.member_id
       left join organizations org on org.id = rn.organization_id
      where rn.id = $1
      limit 1`,
    [noteId]
  );

  const note = result.rows[0] || null;
  if (!note) {
    const error = new Error('Recovery note not found.');
    error.statusCode = 404;
    throw error;
  }
  if (String(note.organization_id) !== String(organizationId)) {
    const error = new Error('You do not have access to this recovery note.');
    error.statusCode = 403;
    throw error;
  }
  if (CLOSED_STATUSES.has(note.case_status)) {
    const error = new Error('Cannot send a note for a closed recovery case.');
    error.statusCode = 400;
    throw error;
  }
  if (!cleanString(note.member_email)) {
    const error = new Error('Customer email is missing for this recovery note.');
    error.statusCode = 400;
    throw error;
  }
  return note;
}

async function applyNoteOverrides(client, note, subjectOverride, bodyOverride) {
  const subject = cleanString(subjectOverride) || note.subject;
  const body = cleanString(bodyOverride) || note.body;

  if (subject !== note.subject || body !== note.body) {
    await client.query(
      `update recovery_notes
          set subject = $2,
              body = $3,
              updated_at = now()
        where id = $1`,
      [note.id, subject, body]
    );
  }

  return { ...note, subject, body };
}

async function sendWithResend({ client, organizationId, memberId, fromName, fromEmail, toEmail, subject, body }) {
  if (!process.env.RESEND_API_KEY) {
    const error = new Error('Email sending not configured.');
    error.statusCode = 500;
    throw error;
  }

  // Audit #35/#37: suppression list — never email someone who unsubscribed.
  if (client) {
    const suppressed = await client.query(
      `select 1 from suppression_list
        where organization_id = $1
          and lower(email) = lower($2)
        limit 1`,
      [organizationId, toEmail]
    );
    if (suppressed.rows[0]) {
      const error = new Error('Recipient has unsubscribed from recovery emails.');
      error.statusCode = 409;
      error.suppressed = true;
      throw error;
    }
  }

  // Audit #35: every email carries a one-click unsubscribe link, a plain-text
  // alternative, and a reply-to pointing at the sender.
  const unsubUrl = organizationId
    ? `${appBaseUrl()}/api/unsubscribe?token=${createUnsubscribeToken(organizationId, memberId, toEmail)}`
    : '';
  const footerText = unsubUrl
    ? `\n\n—\nYou're receiving this because a payment didn't go through. Don't want these emails? Unsubscribe: ${unsubUrl}`
    : '';
  const footerHtml = unsubUrl
    ? `<p style="margin-top:24px;font-size:12px;color:#8E8C86;border-top:1px solid #eee;padding-top:12px">You're receiving this because a payment didn't go through. <a href="${unsubUrl}" style="color:#35608f">Unsubscribe</a></p>`
    : '';
  const textPart = (body || '').replace(/<[^>]+>/g, ' ') + footerText;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${fromName} <${fromEmail}>`,
      to: [toEmail],
      subject,
      html: bodyToHtml(body) + footerHtml,
      text: textPart,
      reply_to: fromEmail,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = cleanString(payload && payload.message) || cleanString(payload && payload.error) || 'Resend could not send this email.';
    const error = new Error(message);
    error.statusCode = 502;
    error.resendPayload = payload;
    throw error;
  }
  return payload;
}

async function markNoteSent(client, values) {
  // values.automatic marks the activity as cron-triggered;
  // values.updateCaseStatus=false keeps the case in its current status (used
  // by the escalation cron, which must not move a 'retrying' case to
  // 'note_sent' or the remaining ladder steps would stop running).
  const automatic = Boolean(values.automatic);
  const updateCaseStatus = values.updateCaseStatus !== false;

  await client.query('BEGIN');
  try {
    await client.query(
      `update recovery_notes
          set sent_at = now(),
              resend_email_id = $2,
              requires_approval = false,
              updated_at = now()
        where id = $1`,
      [values.noteId, values.resendEmailId]
    );

    if (updateCaseStatus) {
      await client.query(
        `update recovery_cases
            set status = 'note_sent',
                updated_at = now()
          where id = $1`,
        [values.caseId]
      );
    }

    await client.query(
      `insert into activity_feed
         (id, organization_id, type, title, description, amount_cents, currency, member_id, case_id, metadata, created_at)
       values
         ($1, $2, 'note_sent', $3, $4, null, null, $5, $6, $7::jsonb, now())`,
      [
        crypto.randomUUID(),
        values.organizationId,
        automatic ? 'Automatic recovery email sent' : 'Recovery note sent',
        `Email sent to ${values.toEmail}.`,
        values.memberId || null,
        values.caseId,
        asJson({
          source: automatic ? 'automatic_escalation' : 'resend',
          automatic,
          resend_email_id: values.resendEmailId,
        }),
      ]
    );

    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) { console.error('Revessent send-note rollback failed:', rollbackError); }
    throw error;
  }
}

// Draft-and-send-in-one-call helper for the escalation cron
// (api/cron/process-recovery-queue.js). Mirrors the manual HTTP flow: loads the
// case context and voice profile, drafts with Gemini, inserts the note
// (requires_approval = false — the cron IS the approval), sends via Resend, and
// records the send. Returns { noteId, subject, body, resendEmailId }.
// updateCaseStatus defaults to true; the cron's mid-ladder escalation passes
// false so the case keeps retrying.
async function sendRecoveryEmail({ client, organizationId, caseId, automatic = false, updateCaseStatus = true }) {
  const context = await loadCaseContext(client, organizationId, caseId);
  const voice = await loadVoiceProfile(client, organizationId, context.organization_name);
  const subject = `Quick update on your ${voice.brandName} subscription`;
  const body = await draftWithGemini(context, voice);
  const noteId = await insertRecoveryNote(client, {
    caseId: context.id,
    organizationId,
    subject,
    body,
    requiresApproval: false,
  });

  const resend = await sendWithResend({
    client,
    organizationId,
    memberId: context.member_id,
    fromName: voice.senderName,
    fromEmail: voice.senderEmail,
    toEmail: context.member_email,
    subject,
    body,
  });

  await markNoteSent(client, {
    noteId,
    caseId: context.id,
    organizationId,
    resendEmailId: cleanString(resend && resend.id),
    toEmail: context.member_email,
    memberId: context.member_id,
    automatic,
    updateCaseStatus,
  });

  return { noteId, subject, body, resendEmailId: cleanString(resend && resend.id) };
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  let body;
  let client;
  try {
    body = await readJsonBody(req);
  } catch (_) {
    return sendJson(res, 400, { error: 'Invalid JSON body.' });
  }

  const caseId = cleanString(body && body.caseId);
  const noteId = cleanString(body && body.noteId);
  const autoSend = Boolean(body && body.autoSend);
  const subjectOverride = cleanString(body && body.subject);
  const bodyOverride = cleanString(body && body.body);

  if (!caseId && !noteId) return sendJson(res, 400, { error: 'caseId or noteId is required.' });

  try {
    client = await pool.connect();
    const { user } = await authenticateRequest(req, client);
    // Audit #4: role check — only owners/admins may perform this action.
    if (!['owner', 'admin'].includes(String((user && user.role) || '').toLowerCase())) {
      return sendJson(res, 403, { error: 'Only workspace owners or admins can perform this action.' });
    }

    const organizationId = user.organization_id;

    let note;
    let voice;

    if (noteId) {
      note = await loadExistingNote(client, organizationId, noteId);
      voice = await loadVoiceProfile(client, organizationId, note.organization_name);
      note = await applyNoteOverrides(client, note, subjectOverride, bodyOverride);
    } else {
      const context = await loadCaseContext(client, organizationId, caseId);
      voice = await loadVoiceProfile(client, organizationId, context.organization_name);
      const subject = subjectOverride || `Quick update on your ${voice.brandName} subscription`;
      const draftBody = bodyOverride || await draftWithGemini(context, voice);
      const insertedNoteId = await insertRecoveryNote(client, {
        caseId: context.id,
        organizationId,
        subject,
        body: draftBody,
        requiresApproval: !autoSend,
      });
      // Audit #38: autoSend is only reachable by an authenticated owner/admin
      // (role gate above) — that click IS the approval. Record who approved.
      if (autoSend) {
        await client.query(
          `update recovery_notes set approved_at = now(), approved_by_user_id = $2 where id = $1`,
          [insertedNoteId, user.id]
        );
      }
      note = {
        id: insertedNoteId,
        case_id: context.id,
        organization_id: organizationId,
        subject,
        body: draftBody,
        member_email: context.member_email,
        member_name: context.member_name,
        member_id: context.member_id,
      };
    }

    if (!autoSend) {
      return sendJson(res, 200, {
        success: true,
        noteId: note.id,
        subject: note.subject,
        body: note.body,
        sent: false,
      });
    }

    let resend;
    try {
      resend = await sendWithResend({
        client,
        organizationId,
        memberId: note.member_id,
        fromName: voice.senderName,
        fromEmail: voice.senderEmail,
        toEmail: note.member_email,
        subject: note.subject,
        body: note.body,
      });
      await logAudit(client, { organizationId, userId: user.id, action: 'note.sent', detail: { noteId: note.id, caseId: note.case_id } });
    } catch (error) {
      return sendJson(res, error.statusCode || 502, {
        success: false,
        error: error.message || 'Could not send the recovery note.',
        noteId: note.id,
        subject: note.subject,
        body: note.body,
        sent: false,
      });
    }

    await markNoteSent(client, {
      noteId: note.id,
      caseId: note.case_id,
      organizationId,
      resendEmailId: cleanString(resend && resend.id),
      toEmail: note.member_email,
      memberId: note.member_id,
    });

    return sendJson(res, 200, {
      success: true,
      noteId: note.id,
      subject: note.subject,
      body: note.body,
      sent: true,
    });
  } catch (error) {
    if (error.statusCode && [400, 401, 403, 404].includes(error.statusCode)) {
      return sendJson(res, error.statusCode, { error: error.message });
    }
    if (error.statusCode === 500 && error.message === 'AI drafting not configured.') {
      return sendJson(res, 500, { error: 'AI drafting not configured.' });
    }
    if (error.statusCode === 502) {
      return sendJson(res, 502, { error: error.message || 'AI drafting failed.' });
    }
    console.error('Revessent /api/recovery/send-note failed:', error);
    return sendJson(res, 500, { error: 'Could not draft or send this recovery note.' });
  } finally {
    if (client) client.release();
  }
}

module.exports = handler;
module.exports.sendRecoveryEmail = sendRecoveryEmail;
