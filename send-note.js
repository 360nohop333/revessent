// Revessent /api/recovery/send-note
// Drafts and optionally sends a warm AI-written recovery email for a failed
// payment case. Drafting uses Anthropic Claude; sending uses Resend.

const { Pool } = require('pg');
const crypto = require('crypto');

const SUPABASE_URL = 'https://zujmouzzqiovgbnanrvv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7JoawOBwMZ-ZIFmDrjkHSA_AdIWlCi3';
const CLOSED_STATUSES = new Set(['recovered', 'lost', 'canceled']);
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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
  const email = (supabaseUser && supabaseUser.email ? String(supabaseUser.email) : '').trim().toLowerCase();

  if (!email) {
    const error = new Error('Supabase user has no email address.');
    error.statusCode = 401;
    throw error;
  }

  return { email };
}

async function findNeonUserByEmail(client, email) {
  const result = await client.query(
    `select id, organization_id, email, role
       from users
      where lower(email) = lower($1)
      limit 1`,
    [email]
  );

  return result.rows[0] || null;
}

async function authenticateRequest(req, client) {
  const token = getBearerToken(req);
  const { email } = await verifySupabaseToken(token);
  const user = await findNeonUserByEmail(client, email);

  if (!user) {
    const error = new Error('No Revessent user found for this Supabase account.');
    error.statusCode = 401;
    throw error;
  }

  return { token, email, user };
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (typeof req.body === 'string') {
    return req.body ? JSON.parse(req.body) : {};
  }

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
  const paragraphs = cleanString(body)
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!paragraphs.length) return '<p></p>';

  return paragraphs
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
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
       sm.stripe_customer_id as member_customer_id,
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

async function draftWithClaude(context, voice) {
  if (!process.env.GEMINI_API_KEY) {
    const error = new Error('AI drafting not configured.');
    error.statusCode = 500;
    throw error;
  }

  const customerFirstName = firstName(context.member_name || context.member_email);
  const amount = amountLabel(context.amount_cents, context.currency);

  const promptText = [
    'You write concise subscription-payment recovery emails. Return only the email body text. No subject line, no markdown, no commentary, no preamble.',
    '',
    'Write a short payment recovery email under 120 words.',
    `Tone: ${voice.toneDescription}.`,
    `Brand: ${voice.brandName}.`,
    `Sender: ${voice.senderName}.`,
    customerFirstName ? `Customer first name: ${customerFirstName}.` : 'No customer first name is available.',
    `Failed amount: ${amount}.`,
    context.decline_code ? `Decline reason code: ${context.decline_code}.` : '',
    'Requirements: warm but not desperate, no guilt-tripping, mention the amount naturally, one clear call to action to update their payment method, sign from the sender at the brand.',
    'Return ONLY the email body text.',
  ].filter(Boolean).join('\n');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }],
        generationConfig: { maxOutputTokens: 600, temperature: 0.7 },
      }),
    }
  );

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = cleanString(body && body.error && body.error.message) || 'AI drafting failed.';
    const error = new Error(message);
    error.statusCode = 502;
    throw error;
  }

  const candidate = Array.isArray(body.candidates) ? body.candidates[0] : null;
  const parts = candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  const text = parts.map((part) => (part && part.text ? part.text : '')).join('\n').trim();

  if (!text) {
    const error = new Error('AI drafting returned an empty email.');
    error.statusCode = 502;
    throw error;
  }

  return text;
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

async function sendWithResend({ fromName, fromEmail, toEmail, subject, body }) {
  if (!process.env.RESEND_API_KEY) {
    const error = new Error('Email sending not configured.');
    error.statusCode = 500;
    throw error;
  }

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
      html: bodyToHtml(body),
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
        'Recovery note sent',
        `Email sent to ${values.toEmail}.`,
        values.memberId || null,
        values.caseId,
        asJson({ source: 'resend', resend_email_id: values.resendEmailId }),
      ]
    );

    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Revessent send-note rollback failed:', rollbackError);
    }
    throw error;
  }
}

module.exports = async (req, res) => {
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

  if (!caseId && !noteId) {
    return sendJson(res, 400, { error: 'caseId or noteId is required.' });
  }

  try {
    client = await pool.connect();
    const { user } = await authenticateRequest(req, client);
    const organizationId = user.organization_id;

    let note;
    let voice;

    if (noteId) {
      note = await loadExistingNote(client, organizationId, noteId);
      voice = await loadVoiceProfile(client, organizationId, note.organization_name);
    } else {
      const context = await loadCaseContext(client, organizationId, caseId);
      voice = await loadVoiceProfile(client, organizationId, context.organization_name);
      const subject = `Quick update on your ${voice.brandName} subscription`;
      const draftBody = await draftWithClaude(context, voice);
      const insertedNoteId = await insertRecoveryNote(client, {
        caseId: context.id,
        organizationId,
        subject,
        body: draftBody,
        requiresApproval: !autoSend,
      });

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
        fromName: voice.senderName,
        fromEmail: voice.senderEmail,
        toEmail: note.member_email,
        subject: note.subject,
        body: note.body,
      });
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
};
