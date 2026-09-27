// revessent/apps/web/src/app/c/[token]/checkout-client.tsx
"use client";

import { useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";

interface Props {
  token: string;
  caseId: string;
  memberName: string;
  memberEmail: string;
  amountFormatted: string;
  brandName: string;
  stripePublishableKey: string;
}

export function CheckoutClient(props: Props) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stripePromise = loadStripe(props.stripePublishableKey);

  const handleStart = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/checkout/${props.token}/setup-intent`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to start checkout");
      setClientSecret(data.clientSecret);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  if (clientSecret) {
    return (
      <PageShell brandName={props.brandName} amountFormatted={props.amountFormatted} memberName={props.memberName}>
        <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: "stripe" } }}>
          <PaymentForm token={props.token} amountFormatted={props.amountFormatted} />
        </Elements>
      </PageShell>
    );
  }

  return (
    <PageShell brandName={props.brandName} amountFormatted={props.amountFormatted} memberName={props.memberName}>
      <div style={{ textAlign: "center" }}>
        <p style={{ color: "#374151", marginBottom: 24, lineHeight: 1.6 }}>
          Update your payment details to restore access to your{" "}
          <strong>{props.brandName}</strong> subscription.
        </p>
        {error && (
          <p style={{ color: "#dc2626", marginBottom: 16, fontSize: 14 }}>{error}</p>
        )}
        <button
          onClick={handleStart}
          disabled={loading}
          style={{
            width: "100%",
            padding: "14px",
            background: loading ? "#93c5fd" : "#2563eb",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            fontSize: 16,
            fontWeight: 600,
            cursor: loading ? "not-allowed" : "pointer",
            transition: "background 0.2s",
          }}
        >
          {loading ? "Loading..." : `Update payment — ${props.amountFormatted}`}
        </button>
        <p style={{ marginTop: 16, fontSize: 12, color: "#9ca3af" }}>
          🔒 Secured by Stripe · We never store your card number
        </p>
      </div>
    </PageShell>
  );
}

// ─── Payment form inside Stripe Elements ──────────────────────────────────────

function PaymentForm({ token, amountFormatted }: { token: string; amountFormatted: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;

    setStatus("loading");
    setErrorMsg(null);

    const { error } = await stripe.confirmSetup({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/c/${token}/success`,
      },
      redirect: "if_required",
    });

    if (error) {
      setStatus("error");
      setErrorMsg(error.message ?? "Payment failed. Please try again.");
      return;
    }

    // Setup intent confirmed — now pay the invoice server-side
    try {
      const res = await fetch(`/api/v1/checkout/${token}/pay`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setStatus("success");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Payment failed");
    }
  };

  if (status === "success") {
    return (
      <div style={{ textAlign: "center", padding: "32px 0" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
        <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Payment updated</h2>
        <p style={{ color: "#6b7280" }}>Your subscription has been restored. Thank you!</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <PaymentElement />
      {errorMsg && (
        <p style={{ color: "#dc2626", marginTop: 12, fontSize: 14 }}>{errorMsg}</p>
      )}
      <button
        type="submit"
        disabled={status === "loading" || !stripe}
        style={{
          width: "100%",
          marginTop: 20,
          padding: "14px",
          background: status === "loading" ? "#93c5fd" : "#2563eb",
          color: "#fff",
          border: "none",
          borderRadius: 8,
          fontSize: 16,
          fontWeight: 600,
          cursor: status === "loading" ? "not-allowed" : "pointer",
        }}
      >
        {status === "loading" ? "Processing..." : `Confirm payment — ${amountFormatted}`}
      </button>
      <p style={{ marginTop: 12, fontSize: 12, color: "#9ca3af", textAlign: "center" }}>
        🔒 Secured by Stripe
      </p>
    </form>
  );
}

// ─── Page shell ───────────────────────────────────────────────────────────────

function PageShell({
  brandName,
  amountFormatted,
  memberName,
  children,
}: {
  brandName: string;
  amountFormatted: string;
  memberName: string;
  children: React.ReactNode;
}) {
  return (
    <main style={{
      minHeight: "100vh",
      background: "#f9fafb",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "24px",
    }}>
      <div style={{
        background: "#fff",
        borderRadius: 12,
        padding: "40px 32px",
        maxWidth: 440,
        width: "100%",
        boxShadow: "0 1px 3px rgba(0,0,0,0.1), 0 4px 16px rgba(0,0,0,0.06)",
      }}>
        <div style={{ marginBottom: 32 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>{brandName}</h1>
          <p style={{ color: "#6b7280", fontSize: 14 }}>Hi {memberName} 👋</p>
        </div>

        <div style={{
          background: "#fef3c7",
          border: "1px solid #fde68a",
          borderRadius: 8,
          padding: "12px 16px",
          marginBottom: 24,
          fontSize: 14,
        }}>
          <strong style={{ color: "#92400e" }}>Payment of {amountFormatted} is past due</strong>
          <p style={{ color: "#78350f", margin: "4px 0 0", fontSize: 13 }}>
            Update your payment details below to restore access.
          </p>
        </div>

        {children}
      </div>
    </main>
  );
}
