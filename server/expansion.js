// Revessent /api/expansion
// GET: lists expansion opportunities for the authenticated organization.
// POST: approves (and sends via Resend) or declines an expansion opportunity.

const { Pool } = require('pg');
const crypto = require('crypto');
const { authenticateRequest } = require('./_lib/supabase-auth'); // audit #66: shared auth
const { createUnsubscribeToken, appBaseUrl } = require('./_lib/unsubscribe-token');
const { logAudit } = require('./_lib/audit');

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

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
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

async function sendExpansionEmail({ organizationId, memberId, fromName, fromEmail, toEmail, subject, body }) {
  if (!process.env.RESEND_API_KEY) {
    const error = new Error('Resend is not configured.');
    error.statusCode = 500;
    throw error;
  }

  const unsubUrl = organizationId
    ? `${appBaseUrl()}/api/unsubscribe?token=${createUnsubscribeToken(organizationId, memberId, toEmail)}`
    : '';
  const footerText = unsubUrl
    ? `\n\n—\nYou're receiving this because you're a valued customer. Don't want these emails? Unsubscribe: ${unsubUrl}`
    : '';
  const footerHtml = unsubUrl
    ? `<p style="margin-top:24px;font-size:12px;color:#8E8C86;border-top:1px solid #eee;padding-top:12px">You're receiving this because you're a valued customer. <a href="${unsubUrl}" style="color:#35608f">Unsubscribe</a></p>`
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
      tags: ['org:' + organizationId, memberId ? 'member:' + memberId : null, 'expansion'].filter(Boolean),
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

async function handleGet(req, res, client, user) {
  const organizationId = user.organization_id;

  const result = await client.query(
    `select eo.id, eo.organization_id, eo.member_id, eo.signal_type, eo.status,
            eo.draft_subject, eo.draft_body, eo.sent_at, eo.responded_at, eo.created_at,
            sm.name as member_name, sm.email as member_email, sm.phone as member_phone
       from expansion_opportunities eo
       left join stripe_members sm on sm.id = eo.member_id
      where eo.organization_id = $1
      order by eo.created_at desc
      limit 100`,
    [organizationId]
  );

  return sendJson(res, 200, {
    opportunities: result.rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      memberId: row.member_id,
      signalType: row.signal_type,
      status: row.status,
      draftSubject: row.draft_subject,
      draftBody: row.draft_body,
      sentAt: row.sent_at,
      respondedAt: row.responded_at,
      createdAt: row.created_at,
      memberName: row.member_name || '',
      memberEmail: row.member_email || '',
      memberPhone: row.member_phone || '',
    })),
  });
}

async function handlePost(req, res, client, user) {
  // Only owners and admins can approve or decline expansion opportunities
  if (!['owner', 'admin'].includes(String((user && user.role) || '').toLowerCase())) {
    return sendJson(res, 403, { error: 'Only workspace owners and admins can change this.' });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (_) {
    return sendJson(res, 400, { error: 'Invalid JSON body.' });
  }

  const opportunityId = cleanString(body && body.opportunityId);
  const action = cleanString(body && body.action).toLowerCase();

  if (!opportunityId) {
    return sendJson(res, 400, { error: 'opportunityId is required.' });
  }

  if (action !== 'approve' && action !== 'decline') {
    return sendJson(res, 400, { error: "action must be 'approve' or 'decline'." });
  }

  const organizationId = user.organization_id;

  const result = await client.query(
    `select eo.*, sm.name as member_name, sm.email as member_email, org.name as organization_name
       from expansion_opportunities eo
       left join stripe_members sm on sm.id = eo.member_id
       left join organizations org on org.id = eo.organization_id
      where eo.id = $1
      limit 1`,
    [opportunityId]
  );

  const opp = result.rows[0];
  if (!opp) {
    return sendJson(res, 404, { error: 'Expansion opportunity not found.' });
  }

  if (String(opp.organization_id) !== String(organizationId)) {
    return sendJson(res, 403, { error: 'You do not have access to this opportunity.' });
  }

  if (opp.status !== 'drafted') {
    return sendJson(res, 400, { error: `Opportunity already ${opp.status}.` });
  }

  if (action === 'decline') {
    await client.query(
      `update expansion_opportunities
          set status = 'declined',
              responded_at = now()
        where id = $1`,
      [opp.id]
    );

    await client.query(
      `insert into activity_feed
         (id, organization_id, type, title, description, member_id, metadata, created_at)
       values
         ($1, $2, 'expansion_declined', 'Expansion opportunity declined', $3, $4, $5::jsonb, now())`,
      [
        crypto.randomUUID(),
        organizationId,
        `Declined expansion outreach for ${opp.member_name || opp.member_email || 'subscriber'}.`,
        opp.member_id,
        JSON.stringify({ opportunity_id: opp.id }),
      ]
    );

    await logAudit(client, { organizationId, userId: user.id, action: 'expansion.declined', detail: { opportunityId: opp.id } });

    return sendJson(res, 200, { success: true, status: 'declined', opportunityId: opp.id });
  }

  // action === 'approve'
  if (!opp.member_email) {
    return sendJson(res, 400, { error: 'Customer email is missing for this opportunity.' });
  }

  // Check suppression
  const suppressed = await client.query(
    `select 1 from suppression_list where organization_id = $1 and lower(email) = lower($2) limit 1`,
    [organizationId, opp.member_email]
  );
  if (suppressed.rows[0]) {
    return sendJson(res, 409, { error: 'Recipient has unsubscribed from outreach.' });
  }

  const voice = await loadVoiceProfile(client, organizationId, opp.organization_name);
  const subject = opp.draft_subject || `Exclusive update on your ${voice.brandName} subscription`;
  const draftBody = opp.draft_body || `Hi ${opp.member_name || 'there'},\n\nThank you for being a loyal customer of ${voice.brandName}!`;

  let resendResult;
  try {
    resendResult = await sendExpansionEmail({
      organizationId,
      memberId: opp.member_id,
      fromName: voice.senderName,
      fromEmail: voice.senderEmail,
      toEmail: opp.member_email,
      subject,
      body: draftBody,
    });
  } catch (sendError) {
    console.error('Revessent expansion email send failed:', sendError);
    return sendJson(res, sendError.statusCode || 502, { error: sendError.message || 'Could not send expansion email.' });
  }

  await client.query(
    `update expansion_opportunities
        set status = 'sent',
            sent_at = now()
      where id = $1`,
    [opp.id]
  );

  await client.query(
    `insert into activity_feed
       (id, organization_id, type, title, description, member_id, metadata, created_at)
     values
       ($1, $2, 'expansion_sent', 'Expansion appreciation email sent', $3, $4, $5::jsonb, now())`,
    [
      crypto.randomUUID(),
      organizationId,
      `Sent upgrade appreciation email to ${opp.member_email}.`,
      opp.member_id,
      JSON.stringify({ opportunity_id: opp.id, resend_email_id: cleanString(resendResult && resendResult.id) }),
    ]
  );

  await logAudit(client, { organizationId, userId: user.id, action: 'expansion.approved', detail: { opportunityId: opp.id } });

  return sendJson(res, 200, { success: true, status: 'sent', opportunityId: opp.id });
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  let client;

  try {
    client = await pool.connect();
    const { user } = await authenticateRequest(req, client);

    if (req.method === 'POST') {
      return await handlePost(req, res, client, user);
    }

    return await handleGet(req, res, client, user);
  } catch (error) {
    if (error.statusCode && [400, 401, 403, 404, 409].includes(error.statusCode)) {
      return sendJson(res, error.statusCode, { error: error.message });
    }
    console.error('Revessent /api/expansion failed:', error);
    return sendJson(res, 500, { error: 'Expansion request failed.' });
  } finally {
    if (client) client.release();
  }
};
