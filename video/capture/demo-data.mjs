// ═══════════════════════════════════════════════════════════════════
// Revessent ad — controlled demo state.
// The 100% real product UI, rendered against this data. Nothing here
// invents UI: every field maps to a column the real server returns
// (see server/dashboard-data.js, server/recovery/case.js, …).
// Numbers are illustrative pilot data for one fictional workspace.
// ═══════════════════════════════════════════════════════════════════

const H = 3600e3;
const now = () => Date.now();
const iso = (msAgo) => new Date(now() - msAgo).toISOString();

// ── the workspace's members / recovery cases ──────────────────────
export const CASES = {
  c1: {
    id: 'c1',
    memberName: 'Ananya Sharma',
    memberEmail: 'ananya.sharma@gmail.com',
    memberPhone: '+91 98•••• 4410',
    amountCents: 89900,
    currency: 'INR',
    declineCode: 'insufficient_funds',
    retryCount: 1,
    maxRetries: 4,
    failedAt: () => iso(26 * H),
  },
  c2: {
    id: 'c2',
    memberName: 'Rohit Verma',
    memberEmail: 'rohit.v@outlook.com',
    memberPhone: '+91 90•••• 2214',
    amountCents: 129900,
    currency: 'INR',
    declineCode: 'card_expired',
    retryCount: 1,
    maxRetries: 4,
    failedAt: () => iso(8 * H),
  },
  c3: {
    id: 'c3',
    memberName: 'Priya Nair',
    memberEmail: 'priya.nair@yahoo.com',
    memberPhone: '',
    amountCents: 59900,
    currency: 'INR',
    declineCode: 'do_not_honor',
    retryCount: 2,
    maxRetries: 4,
    failedAt: () => iso(2 * 24 * H),
  },
  c4: {
    id: 'c4',
    memberName: 'Arjun Mehta',
    memberEmail: 'arjun.mehta@gmail.com',
    memberPhone: '',
    amountCents: 249900,
    currency: 'INR',
    declineCode: 'insufficient_funds',
    retryCount: 1,
    maxRetries: 4,
    failedAt: () => iso(5 * H),
  },
  c5: {
    id: 'c5',
    memberName: 'Neha Kulkarni',
    memberEmail: 'neha.kulkarni@gmail.com',
    memberPhone: '',
    amountCents: 79900,
    currency: 'INR',
    declineCode: 'invalid_card',
    retryCount: 0,
    maxRetries: 4,
    failedAt: () => iso(40 * H),
  },
};

// ── case responses (before / after each ad beat) ──────────────────
export function caseResponse(caseId, state) {
  const base = CASES[caseId];
  if (!base) return null;
  const c = { ...base, failedAt: base.failedAt() };

  if (caseId === 'c1') {
    const attempts = [
      { id: 'a1', type: 'auto_retry', status: 'failed', errorCode: 'insufficient_funds', errorMessage: 'insufficient_funds', executedAt: iso(20 * H) },
      { id: 'a2', type: 'auto_retry', status: 'failed', errorCode: 'insufficient_funds', errorMessage: 'insufficient_funds', executedAt: iso(14 * H) },
    ];
    if (state.c1Succeeded) {
      attempts.unshift({ id: 'a3', type: 'manual_retry', status: 'succeeded', errorCode: '', errorMessage: 'Status: succeeded', executedAt: iso(60e3) });
      return { case: { ...c, status: 'succeeded', retryCount: 2 }, attempts, notes: [] };
    }
    return { case: { ...c, status: 'retrying', retryCount: 1 }, attempts, notes: [] };
  }

  if (caseId === 'c2') {
    const attempts = [
      { id: 'b1', type: 'auto_retry', status: 'failed', errorCode: 'card_expired', errorMessage: 'card_expired', executedAt: iso(6 * H) },
    ];
    const notes = [];
    if (state.c2NoteSent) {
      notes.push({
        id: 'n1',
        subject: DRAFT.subject,
        body: DRAFT.body,
        sentAt: iso(45e3),
        createdAt: iso(90e3),
      });
    }
    return { case: { ...c, status: state.c2NoteSent ? 'retrying' : 'detected' }, attempts, notes };
  }

  return null;
}

// ── the recovery email the real "Draft recovery email" flow shows ──
export const DRAFT = {
  noteId: 'n1',
  subject: 'Rohit, your card expired — 30 seconds to fix it',
  body:
    'Hi Rohit,\n\n' +
    'Your Bloom Coffee Club renewal for ₹1,299 didn\'t go through this week — the card on file expired.\n\n' +
    'It\'s a 30-second fix: just update your card details from the link below, and your subscription continues uninterrupted. Your next box is already being packed.\n\n' +
    'Update your payment method: https://rzp.io/i/bloom-club\n\n' +
    '— Team Bloom Coffee Club',
};

// ── dashboard-data (v1 = mid-recovery, v2 = after the recovery arc) ──
export function dashboardData(version) {
  const v2 = version === 2;
  const weeks = [
    { label: 'W1', r: 2200, x: 1800 },
    { label: 'W2', r: 2600, x: 1700 },
    { label: 'W3', r: 3100, x: 1500 },
    { label: 'W4', r: 2900, x: 1400 },
    { label: 'W5', r: 3600, x: 1200 },
    { label: 'W6', r: 4200, x: 1100 },
    { label: 'W7', r: 4700, x: 900 },
    { label: 'W8', r: v2 ? 6100 : 5300, x: 800 },
  ];
  const weekLabels = ['Apr 7', 'Apr 14', 'Apr 21', 'Apr 28', 'May 5', 'May 12', 'May 19', 'May 26'];

  const queueV1 = [
    { ...CASES.c1, failedAt: CASES.c1.failedAt(), status: 'retrying' },
    { ...CASES.c2, failedAt: CASES.c2.failedAt(), status: 'detected' },
    { ...CASES.c4, failedAt: CASES.c4.failedAt(), status: 'retrying' },
    { ...CASES.c3, failedAt: CASES.c3.failedAt(), status: 'awaiting_approval' },
    { ...CASES.c5, failedAt: CASES.c5.failedAt(), status: 'detected' },
  ];
  const queueV2 = [
    { ...CASES.c1, failedAt: CASES.c1.failedAt(), status: 'succeeded' },
    { ...CASES.c4, failedAt: CASES.c4.failedAt(), status: 'retrying' },
    { ...CASES.c2, failedAt: CASES.c2.failedAt(), status: 'succeeded' },
  ];

  return {
    currency: 'INR',
    revenueRecovered: { amountCents: v2 ? 2486000 : 1824000, percentChangeVsPrior: v2 ? 31 : 18 },
    revenueAtRisk: { amountCents: v2 ? 217000 : 483000, openCaseCount: v2 ? 3 : 5 },
    recoveryRate: { percent: v2 ? 71 : 64, industryAvgPercent: 42 },
    activeCases: v2
      ? { retrying: 1, awaitingApproval: 0, checkoutSent: 2, detected: 0 }
      : { retrying: 2, awaitingApproval: 1, checkoutSent: 1, detected: 2 },
    pilot: { startedAt: iso(9 * 24 * H), endsAt: iso(-5 * 24 * H) },
    weeklyChart: weeks.map((w, i) => ({ weekLabel: weekLabels[i], recoveredCents: w.r * 100, lostCents: w.x * 100 })),
    declineBreakdown: [
      { declineCode: 'insufficient_funds', count: 34, amountCents: 612000 },
      { declineCode: 'card_expired', count: 21, amountCents: 408000 },
      { declineCode: 'do_not_honor', count: 12, amountCents: 187000 },
      { declineCode: 'invalid_card', count: 7, amountCents: 96300 },
    ],
    recoveryQueue: v2 ? queueV2 : queueV1,
    activity: v2
      ? [
          { type: 'recovered', title: 'Payment recovered', description: 'Ananya Sharma · ₹899 · retry #2', amountCents: 89900, createdAt: iso(60e3) },
          { type: 'note_sent', title: 'Recovery email sent', description: 'Rohit Verma · card expired', amountCents: 0, createdAt: iso(45e3) },
          { type: 'recovered', title: 'Payment recovered', description: 'Rohit Verma updated card · ₹1,299', amountCents: 129900, createdAt: iso(30 * 60e3) },
          { type: 'recovered', title: 'Payment recovered', description: 'Priya Nair · ₹599 · retry #3', amountCents: 59900, createdAt: iso(4 * H) },
          { type: 'detected', title: 'Failure detected', description: 'Arjun Mehta · insufficient funds · ₹2,499', amountCents: 249900, createdAt: iso(5 * H) },
        ]
      : [
          { type: 'detected', title: 'Failure detected', description: 'Arjun Mehta · insufficient funds · ₹2,499', amountCents: 249900, createdAt: iso(5 * H) },
          { type: 'note_sent', title: 'Recovery email sent', description: 'Neha Kulkarni · invalid card', amountCents: 0, createdAt: iso(7 * H) },
          { type: 'recovered', title: 'Payment recovered', description: 'Kabir Anand · ₹499 · retry #2', amountCents: 49900, createdAt: iso(11 * H) },
          { type: 'lost', title: 'Case lost', description: 'Devika Rao · cancelled subscription', amountCents: 99900, createdAt: iso(26 * H) },
          { type: 'recovered', title: 'Payment recovered', description: 'Ishaan Bose · ₹1,199 · retry #1', amountCents: 119900, createdAt: iso(30 * H) },
        ],
  };
}

// ── weekly digest (real shape: server/digests.js) ──────────────────
export function digestsData() {
  return {
    digests: [
      {
        weekStartDate: iso(10 * 24 * H).slice(0, 10),
        weekEndDate: iso(3 * 24 * H).slice(0, 10),
        recoveredAmountCents: 610000,
        lostAmountCents: 80000,
        totalRecovered: 19,
        totalLost: 2,
        sentAt: iso(3 * 24 * H),
        aiNarrativeParagraph:
          'A strong week: 19 of 21 failed payments came back, led by retry #2 timing on insufficient-funds declines. Two card-expiry cases were saved by the recovery email before the member churned. Revenue at risk is at its lowest point this pilot.',
      },
      {
        weekStartDate: iso(17 * 24 * H).slice(0, 10),
        weekEndDate: iso(10 * 24 * H).slice(0, 10),
        recoveredAmountCents: 470000,
        lostAmountCents: 90000,
        totalRecovered: 14,
        totalLost: 3,
        sentAt: iso(10 * 24 * H),
        aiNarrativeParagraph:
          'Recovery rate climbed again — retries timed to member history cleared most insufficient-funds cases. Three expiring cards were caught by the email channel. Watch do_not_honor next week: two cases are still parked.',
      },
    ],
  };
}

// ── members (real shape: server/members.js) ────────────────────────
export function membersData() {
  const mk = (name, email, st, amt, open) => ({
    id: name.toLowerCase().replace(/\W+/g, '-'),
    name, email,
    subscriptionStatus: st,
    subscriptionAmountCents: amt,
    subscriptionCurrency: 'INR',
    openCaseId: open,
  });
  return {
    members: [
      mk('Ananya Sharma', 'ananya.sharma@gmail.com', 'active', 89900, 'c1'),
      mk('Rohit Verma', 'rohit.v@outlook.com', 'active', 129900, 'c2'),
      mk('Priya Nair', 'priya.nair@yahoo.com', 'active', 59900, 'c3'),
      mk('Arjun Mehta', 'arjun.mehta@gmail.com', 'active', 249900, 'c4'),
      mk('Neha Kulkarni', 'neha.kulkarni@gmail.com', 'active', 79900, 'c5'),
      mk('Kabir Anand', 'kabir.anand@gmail.com', 'active', 49900, null),
      mk('Devika Rao', 'devika.rao@gmail.com', 'cancelled', 99900, null),
      mk('Ishaan Bose', 'ishaan.bose@zoho.com', 'active', 119900, null),
      mk('Meera Iyer', 'meera.iyer@gmail.com', 'active', 69900, null),
      mk('Sahil Kapoor', 'sahil.kapoor@gmail.com', 'active', 189900, null),
    ],
    total: 10,
    hasMore: false,
  };
}

// ── /api/me (real shape: server/me.js) ─────────────────────────────
export function meData() {
  return {
    userId: 'u-0001',
    organizationId: 'org-0001',
    organizationName: 'Bloom Coffee Club',
    email: 'founder@bloomcoffee.club',
    role: 'owner',
  };
}
