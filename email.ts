// revessent/packages/server/src/email.ts
// Email sending via Resend

import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY!);

const FROM = process.env.EMAIL_FROM ?? "Revessent <noreply@revessent.com>";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  from?: string;
  replyTo?: string;
}

interface SendEmailResult {
  id: string;
}

// ─── Core send function ───────────────────────────────────────────────────────

export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
  const { data, error } = await resend.emails.send({
    from: opts.from ?? FROM,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    reply_to: opts.replyTo,
  });

  if (error || !data) {
    throw new Error(`Failed to send email: ${error?.message ?? "Unknown error"}`);
  }

  return { id: data.id };
}

// ─── Recovery note email ──────────────────────────────────────────────────────

export function buildRecoveryNoteHtml({
  memberName,
  body,
  senderName,
  brandName,
  checkoutUrl,
  amountFormatted,
}: {
  memberName: string;
  body: string;
  senderName: string;
  brandName: string;
  checkoutUrl: string;
  amountFormatted: string;
}): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
             max-width: 560px; margin: 40px auto; padding: 0 20px; color: #111; line-height: 1.6;">

  <p style="margin-bottom: 20px;">${body.replace(/\n/g, "<br/>")}</p>

  ${checkoutUrl ? `
  <div style="margin: 32px 0;">
    <a href="${checkoutUrl}"
       style="display: inline-block; padding: 13px 26px; background: #2563eb;
              color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500; font-size: 15px;">
      Update payment — ${amountFormatted}
    </a>
  </div>
  <p style="font-size: 13px; color: #666;">
    Or paste this link in your browser:<br/>
    <a href="${checkoutUrl}" style="color: #2563eb;">${checkoutUrl}</a>
  </p>
  ` : ""}

  <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;" />
  <p style="font-size: 13px; color: #888; margin: 0;">
    ${senderName} · ${brandName}
  </p>
</body>
</html>`;
}

// ─── Recovery checkout email ──────────────────────────────────────────────────

export function buildCheckoutEmailHtml({
  memberName,
  checkoutUrl,
  amountFormatted,
  brandName,
}: {
  memberName: string;
  checkoutUrl: string;
  amountFormatted: string;
  brandName: string;
}): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 40px auto; padding: 0 20px; color: #111; line-height: 1.6;">
  <h2 style="font-size: 18px; font-weight: 600; margin-bottom: 4px;">Action needed on your ${brandName} subscription</h2>
  <p>Hi ${memberName},</p>
  <p>We weren't able to process your recent payment of <strong>${amountFormatted}</strong>. To keep your access uninterrupted, please update your payment details.</p>
  <div style="margin: 32px 0;">
    <a href="${checkoutUrl}"
       style="display: inline-block; padding: 13px 26px; background: #2563eb;
              color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500; font-size: 15px;">
      Update payment details
    </a>
  </div>
  <p style="font-size: 13px; color: #666;">
    This link is private and unique to you. It expires in 14 days.<br/>
    <a href="${checkoutUrl}" style="color: #2563eb;">${checkoutUrl}</a>
  </p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;" />
  <p style="font-size: 13px; color: #888;">
    Sent on behalf of ${brandName} — powered by Revessent
  </p>
</body>
</html>`;
}

// ─── Weekly forensics digest email ───────────────────────────────────────────

export function buildDigestEmailHtml({
  orgName,
  weekLabel,
  recovered,
  lost,
  recoveredAmount,
  lostAmount,
  topDeclines,
  narrative,
}: {
  orgName: string;
  weekLabel: string;
  recovered: number;
  lost: number;
  recoveredAmount: string;
  lostAmount: string;
  topDeclines: Array<{ code: string; count: number; pct: number }>;
  narrative: string;
}): string {
  const declineRows = topDeclines
    .map(
      (d) => `<tr>
        <td style="padding: 8px 12px; border-bottom: 1px solid #f0f0f0;">${formatDeclineCode(d.code)}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #f0f0f0; text-align: right;">${d.count}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #f0f0f0; text-align: right;">${d.pct}%</td>
      </tr>`
    )
    .join("");

  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /></head>
<body style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; color: #111;">
  <h2 style="font-size: 18px; font-weight: 600;">Weekly decline forensics — ${weekLabel}</h2>
  <p style="color: #555; font-size: 14px;">${orgName}</p>

  <div style="display: flex; gap: 16px; margin: 24px 0;">
    <div style="flex: 1; padding: 20px; background: #f0fdf4; border-radius: 8px; text-align: center;">
      <div style="font-size: 28px; font-weight: 700; color: #16a34a;">${recovered}</div>
      <div style="font-size: 13px; color: #555; margin-top: 4px;">Recovered · ${recoveredAmount}</div>
    </div>
    <div style="flex: 1; padding: 20px; background: #fef2f2; border-radius: 8px; text-align: center;">
      <div style="font-size: 28px; font-weight: 700; color: #dc2626;">${lost}</div>
      <div style="font-size: 13px; color: #555; margin-top: 4px;">Lost · ${lostAmount}</div>
    </div>
  </div>

  <h3 style="font-size: 14px; font-weight: 600; margin: 24px 0 8px;">Top decline reasons</h3>
  <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
    <thead>
      <tr style="background: #f9f9f9;">
        <th style="padding: 8px 12px; text-align: left; font-weight: 500;">Reason</th>
        <th style="padding: 8px 12px; text-align: right; font-weight: 500;">Count</th>
        <th style="padding: 8px 12px; text-align: right; font-weight: 500;">%</th>
      </tr>
    </thead>
    <tbody>${declineRows}</tbody>
  </table>

  <div style="margin: 24px 0; padding: 20px; background: #f8fafc; border-left: 3px solid #2563eb; border-radius: 4px;">
    <p style="margin: 0; font-size: 14px; line-height: 1.7; color: #334155;">${narrative}</p>
  </div>

  <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;" />
  <p style="font-size: 12px; color: #aaa;">Revessent · Weekly Digest</p>
</body>
</html>`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDeclineCode(code: string): string {
  return code.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatCurrency(amountCents: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amountCents / 100);
}
