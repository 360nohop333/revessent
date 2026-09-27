// revessent/packages/ai/src/index.ts
// AI-powered recovery note and expansion message generation via Claude

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecoveryNoteInput {
  memberName: string;
  memberEmail: string;
  amountCents: number;
  currency: string;
  declineCode: string;
  brandName: string;
  senderName: string;
  toneDescription: string;
  exampleEmail: string | null;
  checkoutUrl: string;
}

export interface RecoveryNoteOutput {
  subject: string;
  body: string;
}

export interface ExpansionMessageInput {
  memberName: string;
  memberEmail: string;
  signal: string;
  currentPlanName: string;
  suggestedPlanName: string;
  priceDeltaCents: number;
  currency: string;
  brandName: string;
  senderName: string;
  toneDescription: string;
}

export interface ExpansionMessageOutput {
  subject: string;
  body: string;
}

// ─── Recovery note ────────────────────────────────────────────────────────────

export async function generateRecoveryNote(
  input: RecoveryNoteInput
): Promise<RecoveryNoteOutput> {
  const amount = formatCurrency(input.amountCents, input.currency);
  const declineReason = humanizeDeclineCode(input.declineCode);

  const systemPrompt = buildSystemPrompt(
    input.brandName,
    input.senderName,
    input.toneDescription,
    input.exampleEmail
  );

  const userPrompt = `Write a short, friendly recovery email for a failed payment.

Context:
- Member name: ${input.memberName}
- Failed amount: ${amount}
- Decline reason: ${declineReason}
- Checkout link to update payment: ${input.checkoutUrl}

Requirements:
- Sound like you're from ${input.brandName}, written by ${input.senderName}
- Never mention "Revessent" — write as if you ARE the brand
- Do NOT say the card was declined in an accusatory way
- Keep it under 120 words total
- Include the checkout link naturally in the body
- Tone: ${input.toneDescription}

Respond ONLY with valid JSON in this exact format:
{"subject": "...", "body": "..."}`;

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  return parseJsonResponse<RecoveryNoteOutput>(text, {
    subject: `Action needed on your ${input.brandName} subscription`,
    body: `Hi ${input.memberName},\n\nWe weren't able to process your recent payment of ${amount}. Please update your payment details to keep your access.\n\n${input.checkoutUrl}\n\n${input.senderName}`,
  });
}

// ─── Expansion message ────────────────────────────────────────────────────────

export async function generateExpansionMessage(
  input: ExpansionMessageInput
): Promise<ExpansionMessageOutput> {
  const delta = formatCurrency(input.priceDeltaCents, input.currency);

  const systemPrompt = buildSystemPrompt(
    input.brandName,
    input.senderName,
    input.toneDescription,
    null
  );

  const userPrompt = `Write a short upgrade suggestion email.

Context:
- Member: ${input.memberName}
- Signal detected: ${input.signal}
- Current plan: ${input.currentPlanName}
- Suggested plan: ${input.suggestedPlanName}
- Price increase: +${delta}/mo

Requirements:
- Sound like ${input.brandName}, written by ${input.senderName}
- Focus on what they GET, not the price
- Under 100 words
- Tone: ${input.toneDescription}

Respond ONLY with valid JSON: {"subject": "...", "body": "..."}`;

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  return parseJsonResponse<ExpansionMessageOutput>(text, {
    subject: `Upgrade your ${input.brandName} plan`,
    body: `Hi ${input.memberName},\n\nYou're getting a lot of value from ${input.currentPlanName}. We think ${input.suggestedPlanName} would serve you even better.\n\n${input.senderName}`,
  });
}

// ─── Weekly forensics narrative ───────────────────────────────────────────────

export async function generateForensicsNarrative({
  orgName,
  recovered,
  lost,
  recoveredAmountCents,
  topDeclines,
}: {
  orgName: string;
  recovered: number;
  lost: number;
  recoveredAmountCents: number;
  topDeclines: Array<{ code: string; count: number; pct: number }>;
}): Promise<string> {
  const topReason = topDeclines[0];
  const amount = formatCurrency(recoveredAmountCents, "usd");

  const prompt = `Write ONE short paragraph (2-3 sentences) summarizing this week's payment recovery results for ${orgName}.

Data:
- Recovered: ${recovered} payments (${amount})
- Lost: ${lost} payments  
- Top decline reason: ${topReason?.code ?? "various"} (${topReason?.pct ?? 0}% of failures)

Make it insightful and specific — mention the top decline trend and what it might mean. 
Professional tone. Plain text only, no markdown.`;

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 200,
    messages: [{ role: "user", content: prompt }],
  });

  return message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("")
    .trim();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildSystemPrompt(
  brandName: string,
  senderName: string,
  tone: string,
  exampleEmail: string | null
): string {
  let prompt = `You write emails for ${brandName}, sent by ${senderName}. 
Tone: ${tone}. 
Never mention Revessent. Write as if you ARE the brand.
Never use corporate jargon. Keep it human and concise.`;

  if (exampleEmail) {
    prompt += `\n\nHere is an example of how ${brandName} writes:\n\n${exampleEmail}`;
  }

  return prompt;
}

function parseJsonResponse<T>(text: string, fallback: T): T {
  try {
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean) as T;
  } catch {
    console.error("Failed to parse AI JSON response:", text);
    return fallback;
  }
}

function humanizeDeclineCode(code: string): string {
  const map: Record<string, string> = {
    expired_card: "expired card",
    insufficient_funds: "insufficient funds",
    card_declined: "card declined",
    do_not_honor: "card declined by bank",
    invalid_account: "invalid account",
    processing_error: "processing error",
    lost_card: "card reported lost",
    stolen_card: "card reported stolen",
  };
  return map[code] ?? "payment failure";
}

function formatCurrency(cents: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}
