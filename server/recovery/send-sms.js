// Revessent /api/recovery/send-sms
// Drafts and optionally sends a short AI-written recovery SMS for a failed
// payment case. Drafting uses Google Gemini; sending uses Twilio's Messages API.
//
// Mirrors the structure of api/recovery/send-note.js: auth check, case
// ownership check, status eligibility check, voice_profiles lookup, and
// checks that SMS is enabled in workspace settings.

const { Pool } = require('pg');
const crypto = require('crypto');
const { authenticateRequest } = require('../_lib/supabase-auth');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const CLOSED_STATUSES = new Set(['recovered', 'lost', 'canceled']);
const SMS_MAX_CHARS = 300;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  ssl: { rejectUnauthorized: false },
});

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
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

function appBaseUrl() {
  return (
    process.env.PUBLIC_APP_URL ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    'https://revessent-alpha.vercel.app'
  ).replace(/\/+$/, '');
}

async function ensureCheckoutToken(client, caseId, existingToken) {
  if (existingToken) return existingToken;
  const token = crypto.randomUUID();
  try {
    await client.query(
      `update recovery_cases
          set checkout_token = coalesce(checkout_token, $1),
              checkout_expires_at = coalesce(checkout_expires_at, now() + interval '7 days')
        where id = $2`,
      [token, caseId]
    );
  } catch (_) {}
  return token;
}

const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'TWD', 'BHD', 'KWD', 'OMR']);

function amountLabel(amountCents, currency) {
  const code = cleanString(currency || 'INR').toUpperCase();
  const divisor = ZERO_DECIMAL_CURRENCIES.has(code) ? 1 : 100;
  const amount = (Number(amountCents || 0) / divisor).toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  return `${code} ${amount}`;
}

function firstName(nameOrEmail) {
  const text = cleanString(nameOrEmail);
  if (!text) return '';
  const local = text.includes('@') ? text.split('@')[0] : text;
  return cleanString(local.split(/[\s._-]+/)[0]);
}

function requireTwilioConfig() {
  if (
    !cleanString(process.env.TWILIO_ACCOUNT_SID) ||
    !cleanString(process.env.TWILIO_AUTH_TOKEN) ||
    !cleanString(process.env.TWILIO_FROM_NUMBER)
  ) {
    const error = new Error('SMS not configured.');
    error.statusCode = 500;
    throw error;
  }
}

async function loadCaseContext(client, organizationId, caseId) {
  const result = await client.query(
    `select
       rc.*,
       sm.name as member_name,
       sm.email as member_email,
       sm.phone as member_phone,
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
    const error = new Error('Cannot draft or send an SMS for a closed recovery case.');
    error.statusCode = 400;
    throw error;
  }
  if (!cleanString(row.member_phone)) {
    const error = new Error('No phone number on file for this customer.');
    error.statusCode = 400;
    throw error;
  }
  return row;
}

async function loadVoiceProfile(client, organizationId, organizationName) {
  const result = await client.query(
    `select brand_name, sender_name, sender_email, tone_description, sms_enabled
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
  const toneDescription = cleanString(voice.tone_description) || 'Professional';
  const smsEnabled = voice.sms_enabled !== false;
  return { brandName, senderName, toneDescription, smsEnabled };
}

async function draftSmsWithGemini(context, voice, paymentLink) {
  if (!process.env.GEMINI_API_KEY) {
    const error = new Error('AI drafting not configured.');
    error.statusCode = 500;
    throw error;
  }

  const customerFirstName = firstName(context.member_name || context.member_email);
  const amount = amountLabel(context.amount_cents, context.currency);
  const prompt = [
    'Write a very short SMS (under 40 words) about a failed payment, warm tone, one clear link-style call to action, no email-style greeting/signoff, just the message body.',
    'Return ONLY the SMS text. No subject line, no markdown, no commentary, no preamble.',
    'Hard rules (never break): never offer discounts, refunds, fee waivers or extensions; never include URLs or links; never promise the charge was or will be reversed; never ask for card numbers, OTPs, passwords or banking details.',
    `Tone: ${voice.toneDescription}.`,
    `Brand: ${voice.brandName}.`,
    customerFirstName ? `Customer first name: ${customerFirstName}.` : 'No customer first name is available.',
    `Failed amount: ${amount}.`,
    context.decline_code ? `Decline reason code: ${context.decline_code}.` : '',
    paymentLink ? `Payment link: ${paymentLink}` : '',
  ].filter(Boolean).join('\n');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 200, temperature: 0.65 },
      }),
    }
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const rawMsg = cleanString(payload && payload.error && payload.error.message);
    let message = rawMsg || 'AI drafting failed.';
    if (response.status === 404 || /model.*not found|unsupported model|deprecated/i.test(rawMsg)) {
      message = 'AI drafting is misconfigured — check GEMINI_MODEL.';
    }
    const error = new Error(message);
    error.statusCode = 502;
    throw error;
  }

  const text = (((payload.candidates || [])[0] || {}).content || {}).parts || [];
  let body = text.map((part) => part.text || '').join('\n').trim();
  if (!body) {
    const error = new Error('AI drafting returned an empty SMS.');
    error.statusCode = 502;
    throw error;
  }

  if (body.length > SMS_MAX_CHARS) {
    const cut = body.slice(0, SMS_MAX_CHARS);
    body = cut.slice(0, cut.lastIndexOf(' ')).trim() || cut.trim();
  }

  return body;
}

async function insertRecoveryNote(client, values) {
  const noteId = crypto.randomUUID();
  await client.query(
    `insert into recovery_notes
       (id, case_id, organization_id, subject, body, channel, requires_approval, sent_at, created_at, updated_at)
     values
       ($1, $2, $3, $4, $5, 'sms', $6, null, now(), now())`,
    [noteId, values.caseId, values.organizationId, values.subject, values.body, values.requiresApproval]
  );
  return noteId;
}

async function loadExistingNote(client, organizationId, noteId) {
  const result = await client.query(
    `select rn.*, rc.member_id, rc.status as case_status, sm.email as member_email,
            sm.name as member_name, sm.phone as member_phone, org.name as organization_name
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
  if (cleanString(note.channel || 'email') !== 'sms') {
    const error = new Error('This note is not an SMS draft.');
    error.statusCode = 400;
    throw error;
  }
  if (CLOSED_STATUSES.has(note.case_status)) {
    const error = new Error('Cannot send an SMS for a closed recovery case.');
    error.statusCode = 400;
    throw error;
  }
  if (!cleanString(note.member_phone)) {
    const error = new Error('No phone number on file for this customer.');
    error.statusCode = 400;
    throw error;
  }
  return note;
}

async function applyNoteOverrides(client, note, bodyOverride) {
  const body = cleanString(bodyOverride) || note.body;

  if (body !== note.body) {
    await client.query(
      `update recovery_notes
          set body = $2,
              updated_at = now()
        where id = $1`,
      [note.id, body]
    );
  }

  return { ...note, body };
}

async function sendWithTwilio({ toPhone, body }) {
  const accountSid = cleanString(process.env.TWILIO_ACCOUNT_SID);
  const authToken = cleanString(process.env.TWILIO_AUTH_TOKEN);
  const fromNumber = cleanString(process.env.TWILIO_FROM_NUMBER);

  const form = new URLSearchParams();
  form.set('To', toPhone);
  form.set('From', fromNumber);
  form.set('Body', body);

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`, 'utf8').toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    }
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      cleanString(payload && payload.message) || `Twilio could not send this SMS (status ${response.status}).`;
    const error = new Error(message);
    error.statusCode = 502;
    error.twilioPayload = payload;
    throw error;
  }
  return payload;
}

async function markSmsSent(client, values) {
  await client.query('BEGIN');
  try {
    await client.query(
      `update recovery_notes
          set sent_at = now(),
              resend_email_id = $2,
              requires_approval = false,
              updated_at = now()
        where id = $1`,
      [values.noteId, values.twilioMessageSid]
    );

    await client.query(
      `update recovery_cases
          set status = 'note_sent',
              updated_at = now()
        where id = $1`,
      [values.caseId]
    );

    await client.query(
      `insert into activity_feed
         (id, organization_id, type, title, description, amount_cents, currency, member_id, case_id, metadata, created_at)
       values
         ($1, $2, 'note_sent', $3, $4, null, null, $5, $6, $7::jsonb, now())`,
      [
        crypto.randomUUID(),
        values.organizationId,
        'Recovery SMS sent',
        `SMS sent to ${values.toPhone}.`,
        values.memberId || null,
        values.caseId,
        asJson({ source: 'twilio', channel: 'sms', twilio_message_sid: values.twilioMessageSid }),
      ]
    );

    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) { console.error('Revessent send-sms rollback failed:', rollbackError); }
    throw error;
  }
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
  const bodyOverride = cleanString(body && body.body);

  if (!caseId && !noteId) return sendJson(res, 400, { error: 'caseId or noteId is required.' });

  try {
    client = await pool.connect();
    const { user } = await authenticateRequest(req, client);
    if (!['owner', 'admin'].includes(String((user && user.role) || '').toLowerCase())) {
      return sendJson(res, 403, { error: 'Only workspace owners or admins can perform this action.' });
    }

    const organizationId = user.organization_id;

    // Load voice profile and verify SMS is enabled for this workspace (Finding #2)
    const context = caseId ? await loadCaseContext(client, organizationId, caseId) : null;
    const voice = await loadVoiceProfile(client, organizationId, context ? context.organization_name : '');
    if (!voice.smsEnabled) {
      return sendJson(res, 400, { error: 'SMS recovery is disabled for this workspace. Enable it in Settings.' });
    }

    requireTwilioConfig();

    let note;

    if (noteId) {
      note = await loadExistingNote(client, organizationId, noteId);
      note = await applyNoteOverrides(client, note, bodyOverride);
    } else {
      const checkoutToken = await ensureCheckoutToken(client, context.id, context.checkout_token);
      const paymentLink = `${appBaseUrl()}/pay.html?token=${checkoutToken}`;
      const draftBody = await draftSmsWithGemini(context, voice, paymentLink);
      const insertedNoteId = await insertRecoveryNote(client, {
        caseId: context.id,
        organizationId,
        subject: 'SMS recovery message',
        body: draftBody,
        requiresApproval: !autoSend,
      });
      note = {
        id: insertedNoteId,
        case_id: context.id,
        organization_id: organizationId,
        body: draftBody,
        member_phone: context.member_phone,
        member_id: context.member_id,
      };
    }

    if (!autoSend) {
      return sendJson(res, 200, {
        success: true,
        noteId: note.id,
        body: note.body,
        sent: false,
      });
    }

    let twilio;
    try {
      const suppressed = await client.query(
        `select 1 from suppression_list
          where organization_id = $1
            and (lower(email) = lower($2) or phone = $3)
          limit 1`,
        [organizationId, note.member_email || '', note.member_phone || '']
      );
      if (suppressed.rows[0]) {
        const error = new Error('Recipient has opted out of recovery messages.');
        error.statusCode = 409;
        throw error;
      }

      twilio = await sendWithTwilio({
        toPhone: note.member_phone,
        body: note.body,
      });
    } catch (error) {
      return sendJson(res, error.statusCode || 502, {
        success: false,
        error: error.message || 'Could not send the recovery SMS.',
        noteId: note.id,
        body: note.body,
        sent: false,
      });
    }

    await markSmsSent(client, {
      noteId: note.id,
      caseId: note.case_id,
      organizationId,
      twilioMessageSid: cleanString(twilio && twilio.sid),
      toPhone: note.member_phone,
      memberId: note.member_id,
    });

    return sendJson(res, 200, {
      success: true,
      noteId: note.id,
      body: note.body,
      sent: true,
    });
  } catch (error) {
    if (error.statusCode && [400, 401, 403, 404, 409].includes(error.statusCode)) {
      return sendJson(res, error.statusCode, { error: error.message });
    }
    if (error.statusCode === 500 && error.message === 'SMS not configured.') {
      return sendJson(res, 500, { error: 'SMS not configured.' });
    }
    if (error.statusCode === 500 && error.message === 'AI drafting not configured.') {
      return sendJson(res, 500, { error: 'AI drafting not configured.' });
    }
    if (error.statusCode === 502) {
      return sendJson(res, 502, { error: error.message || 'AI drafting failed.' });
    }
    console.error('Revessent /api/recovery/send-sms failed:', error);
    return sendJson(res, 500, { error: 'Could not draft or send this recovery SMS.' });
  } finally {
    if (client) client.release();
  }
}

module.exports = handler;
