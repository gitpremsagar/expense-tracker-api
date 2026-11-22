import { env } from "../config/env.js";

function isEmailConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}

export async function sendPasswordResetEmail(
  to: string,
  resetUrl: string,
  name: string,
): Promise<boolean> {
  if (!isEmailConfigured()) {
    if (env.NODE_ENV === "production") {
      console.error(
        "[password reset] Email is not configured. Set RESEND_API_KEY and EMAIL_FROM; the reset email cannot be delivered.",
      );
    } else {
      console.info(
        `[password reset] Email is not configured. Reset link for ${to}: ${resetUrl}`,
      );
    }
    return false;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [to],
      subject: "Reset your Money Tracker 365 password",
      html: `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5;color:#18181b">
          <h2 style="margin:0 0 12px">Reset your password</h2>
          <p>Hi ${escapeHtml(name)},</p>
          <p>We received a request to reset the password for your Money Tracker 365 account.</p>
          <p style="margin:24px 0">
            <a href="${resetUrl}" style="display:inline-block;background:#047857;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">
              Choose a new password
            </a>
          </p>
          <p>This link expires in ${env.PASSWORD_RESET_TTL_MINUTES} minutes. If you did not ask for this, you can ignore this email.</p>
          <p style="color:#71717a;font-size:13px">If the button does not work, copy this link into your browser:<br/>${resetUrl}</p>
        </div>
      `,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error("Password reset email failed", response.status, body);
    return false;
  }

  return true;
}

export function isPasswordResetEmailConfigured(): boolean {
  return isEmailConfigured();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
