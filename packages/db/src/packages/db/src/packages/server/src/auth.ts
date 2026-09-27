// revessent/packages/server/src/auth.ts
// Authentication — Better Auth with email/password + email verification

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@revessent/db";
import * as schema from "@revessent/db/schema";
import { organizations } from "@revessent/db/schema";
import { eq } from "drizzle-orm";
import { sendEmail } from "./email";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.users,
      session: schema.sessions,
    },
  }),

  secret: process.env.BETTER_AUTH_SECRET!,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 8,

    // Hash passwords with argon2id
    password: {
      hash: async (password) => {
        const { hash } = await import("@node-rs/argon2");
        return hash(password, {
          memoryCost: Number(process.env.ARGON2_MEMORY_KIB ?? 65536),
          timeCost: Number(process.env.ARGON2_TIME ?? 3),
          parallelism: Number(process.env.ARGON2_PARALLELISM ?? 4),
        });
      },
      verify: async ({ hash, password }) => {
        const { verify } = await import("@node-rs/argon2");
        return verify(hash, password);
      },
    },
  },

  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "Verify your Revessent email",
        html: verifyEmailHtml(url, user.name ?? user.email),
      });
    },
    autoSignInAfterVerification: true,
  },

  // After signup → create org + start pilot
  hooks: {
    after: [
      {
        matcher: (ctx) => ctx.path === "/sign-up/email",
        handler: async (ctx) => {
          if (ctx.context.newSession?.user?.id) {
            const userId = ctx.context.newSession.user.id;
            const email = ctx.context.newSession.user.email;
            const name = ctx.context.newSession.user.name ?? email.split("@")[0];

            // Create organization for the new user
            const slug = generateSlug(name);
            const pilotStart = new Date();
            const pilotEnd = new Date(pilotStart.getTime() + 14 * 24 * 60 * 60 * 1000);

            const [org] = await db
              .insert(organizations)
              .values({
                name: `${name}'s workspace`,
                slug,
                plan: "ember",
                trustLevel: "approval_required",
                pilotStartedAt: pilotStart,
                pilotEndsAt: pilotEnd,
              })
              .returning();

            // Update user with org and owner role
            await db
              .update(schema.users)
              .set({ organizationId: org.id, role: "owner" })
              .where(eq(schema.users.id, userId));
          }
        },
      },
    ],
  },

  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24,       // refresh if older than 1 day
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes client-side cache
    },
  },

  advanced: {
    cookiePrefix: "rv",
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base}-${suffix}`;
}

function verifyEmailHtml(url: string, name: string): string {
  return `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 40px auto; color: #111;">
  <h2 style="font-size: 20px; font-weight: 600;">Verify your email</h2>
  <p>Hi ${name},</p>
  <p>Click the button below to verify your email and start your 14-day free pilot.</p>
  <a href="${url}" style="display: inline-block; margin: 24px 0; padding: 12px 24px;
     background: #2563eb; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500;">
    Verify email
  </a>
  <p style="color: #666; font-size: 13px;">Link expires in 24 hours. If you didn't sign up for Revessent, ignore this email.</p>
</body>
</html>`;
}

export type Auth = typeof auth;
