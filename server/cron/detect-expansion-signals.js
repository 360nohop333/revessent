// Revessent /api/cron/detect-expansion-signals
// Daily Vercel Cron job that scans for expansion / upsell opportunities:
// Finds subscribers with 90+ days continuous active subscription, ZERO failed
// payments ever, and no expansion opportunity created in the last 60 days.
// Drafts a warm appreciation email via Gemini and inserts with status='drafted'.
// NEVER auto-sends — requires human approval via POST /api/expansion.

const { Pool } = require('pg');
const crypto = require('crypto');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

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

function cleanString(value) {
  return value == null ? '' : String(value).trim();
}

function firstName(nameOrEmail) {
  const text = cleanString(nameOrEmail);
  if (!text) return '';
  const local = text.includes('@') ? text.split('@')[0] : text;
  return cleanString(local.split(/[\s._-]+/)[0]);
}

function verifyCronSecret(req) {
  const secret = cleanString(process.env.CRON_SECRET);

  if (!secret) {
    const error = new Error('Cron secret not configured.');
    error.statusCode = 500;
    throw error;
  }

  const token = getBearerToken(req);
  if (!token) return false;

  const expected = crypto.createHash('sha256').update(secret, 'utf8').digest();
  const actual = crypto.createHash('sha256').update(token, 'utf8').digest();
  return crypto.timingSafeEqual(expected, actual);
}

async function draftExpansionWithGemini(memberName, brandName, senderName) {
  if (!process.env.GEMINI_API_KEY) {
    const fname = firstName(memberName) || 'there';
    return `Hi ${fname},\n\nThank you for being a loyal customer of ${brandName} over the past several months! We appreciate your partnership and would love to show you some of the advanced features and tier upgrades available to help your team get even more value.\n\nBest,\n${senderName || brandName}`;
  }

  const customerFirstName = firstName(memberName);
  const prompt = [
    'Write a short, warm customer appreciation and upgrade preview email under 100 words.',
    'Return ONLY the email body text. No subject line, no markdown, no commentary, no preamble.',
    'Tone: Friendly, appreciative, professional.',
    `Brand: ${brandName}.`,
    `Sender: ${senderName || brandName}.`,
    customerFirstName ? `Customer first name: ${customerFirstName}.` : 'No customer first name is available.',
    'Hard rules (never break): never offer discounts, refunds, fee waivers or extensions; never include URLs or links; never ask for card numbers, OTPs, passwords or banking details.',
    'Requirements: thank them warmly for over 90 days of continuous partnership, invite them to reply if they would like to explore higher-tier capabilities, signed from the brand.',
  ].filter(Boolean).join('\n');

  try {
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
          generationConfig: { maxOutputTokens: 400, temperature: 0.65 },
        }),
      }
    );

    const payload = await response.json().catch(() => ({}));
    if (response.ok) {
      const parts = (((payload.candidates || [])[0] || {}).content || {}).parts || [];
      const body = parts.map((part) => part.text || '').join('\n').trim();
      if (body) return body;
    }
  } catch (err) {
    console.error('Revessent Gemini expansion drafting fallback:', err && err.message);
  }

  const fname = firstName(memberName) || 'there';
  return `Hi ${fname},\n\nThank you for being a loyal customer of ${brandName} over the past several months! We appreciate your partnership and would love to show you some of the advanced features and tier upgrades available to help your team get even more value.\n\nBest,\n${senderName || brandName}`;
}

async function detectExpansionSignals(client) {
  const result = await client.query(
    `select sm.id as member_id, sm.organization_id, sm.name as member_name, sm.email as member_email,
            org.name as organization_name,
            vp.brand_name, vp.sender_name
       from stripe_members sm
       join organizations org on org.id = sm.organization_id
       left join voice_profiles vp on vp.organization_id = org.id and vp.is_default = true
       join stripe_subscriptions ss on ss.member_id = sm.id
      where ss.status = 'active'
        and ss.created_at <= now() - interval '90 days'
        and not exists (
          select 1 from recovery_cases rc where rc.member_id = sm.id
        )
        and not exists (
          select 1 from expansion_opportunities eo
           where eo.member_id = sm.id
             and eo.created_at >= now() - interval '60 days'
        )
      order by ss.created_at asc
      limit 50`
  );

  const candidates = result.rows;
  let detected = 0;

  for (const candidate of candidates) {
    const brandName = cleanString(candidate.brand_name) || cleanString(candidate.organization_name) || 'our team';
    const senderName = cleanString(candidate.sender_name) || brandName;
    const customerFirstName = firstName(candidate.member_name || candidate.member_email);

    const subject = `A quick thank you & exclusive update for ${customerFirstName || 'you'}`;
    const draftBody = await draftExpansionWithGemini(candidate.member_name, brandName, senderName);
    const opportunityId = crypto.randomUUID();

    await client.query(
      `insert into expansion_opportunities
         (id, organization_id, member_id, signal_type, status, draft_subject, draft_body, created_at)
       values
         ($1, $2, $3, 'loyal_subscriber_90d', 'drafted', $4, $5, now())`,
      [opportunityId, candidate.organization_id, candidate.member_id, subject, draftBody]
    );

    await client.query(
      `insert into activity_feed
         (id, organization_id, type, title, description, member_id, metadata, created_at)
       values
         ($1, $2, 'expansion_detected', 'Expansion signal detected', $3, $4, $5::jsonb, now())`,
      [
        crypto.randomUUID(),
        candidate.organization_id,
        `${candidate.member_name || candidate.member_email || 'Customer'} has been an active subscriber for 90+ days with 0 payment failures.`,
        candidate.member_id,
        JSON.stringify({ opportunity_id: opportunityId, signal_type: 'loyal_subscriber_90d' }),
      ]
    );

    detected += 1;
  }

  return detected;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  let authorized;
  try {
    authorized = verifyCronSecret(req);
  } catch (error) {
    return sendJson(res, error.statusCode || 500, { error: error.message });
  }

  if (!authorized) {
    return sendJson(res, 401, { error: 'Unauthorized.' });
  }

  let client;
  try {
    client = await pool.connect();
    const detected = await detectExpansionSignals(client);
    return sendJson(res, 200, { success: true, detected });
  } catch (error) {
    console.error('Revessent cron detect-expansion-signals failed:', error);
    return sendJson(res, 500, { error: 'Could not run expansion signal detection.' });
  } finally {
    if (client) client.release();
  }
};

module.exports.detectExpansionSignals = detectExpansionSignals;
