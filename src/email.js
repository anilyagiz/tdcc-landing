// Transactional email for the marketplace (verification, password reset,
// request notifications). Sent through Resend when RESEND_API_KEY and
// EMAIL_FROM are configured; without them email features report themselves
// as unavailable instead of failing silently.
//
// Tests set env.EMAIL_OUTBOX to an array to capture messages instead.

export function emailEnabled(env) {
  return Array.isArray(env.EMAIL_OUTBOX) || (!!env.RESEND_API_KEY && !!env.EMAIL_FROM);
}

export function siteUrl(env, request) {
  return (env.SITE_URL || new URL(request.url).origin).replace(/\/+$/, "");
}

export async function sendEmail(env, { to, subject, text }) {
  if (Array.isArray(env.EMAIL_OUTBOX)) {
    env.EMAIL_OUTBOX.push({ to, subject, text });
    return true;
  }
  if (!emailEnabled(env)) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text }),
      // A slow mail API must never hold up a marketplace request.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error("email send failed", res.status, await res.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (err) {
    console.error("email send failed", err && err.message);
    return false;
  }
}

const SIGNATURE = "\n\n-- \nThe Decentralized Compute Company\nYou get this email because of activity on your TDCC marketplace account.";

export const templates = {
  verify: (name, link) => ({
    subject: "Confirm your email for the TDCC marketplace",
    text: `Hi ${name},\n\nConfirm your email address to start listing and renting GPUs:\n\n${link}\n\nThe link works for 48 hours. If you did not create this account, ignore this email.${SIGNATURE}`,
  }),
  reset: (name, link) => ({
    subject: "Reset your TDCC marketplace password",
    text: `Hi ${name},\n\nSomeone (hopefully you) asked to reset your password. Choose a new one here:\n\n${link}\n\nThe link works for one hour and only once. If you did not ask for this, ignore this email; your password stays the same.${SIGNATURE}`,
  }),
  newRequest: (host, r, link) => ({
    subject: `New rental request: ${r.gpu_count} × ${r.gpu_model} for ${r.hours} h`,
    text: `Hi ${host},\n\n${r.renter_name} sent a request for ${r.gpu_count} × ${r.gpu_model} for ${r.hours} hours (total $${(r.total_cents / 100).toFixed(2)}).\n\nAccept or decline it here:\n${link}${SIGNATURE}`,
  }),
  emailChange: (name, link) => ({
    subject: "Confirm your new email for the TDCC marketplace",
    text: `Hi ${name},\n\nConfirm that this is your new sign-in address:\n\n${link}\n\nThe link works for 48 hours. If you did not ask for this, ignore this email.${SIGNATURE}`,
  }),
  emailChangeNotice: (name, next) => ({
    subject: "Your TDCC marketplace email is about to change",
    text: `Hi ${name},\n\nSomeone signed in to your account asked to change its email address to ${next}. Nothing changes until the new address is confirmed.\n\nIf this was not you, change your password now and sign out all other devices from your account settings.${SIGNATURE}`,
  }),
  message: (to, from, r, body, link) => ({
    subject: `New message from ${from.split(/\s+/)[0]} about ${r.gpu_count} × ${r.gpu_model}`,
    text: `Hi ${to},\n\n${from.split(/\s+/)[0]} wrote:\n\n${body.length > 1500 ? body.slice(0, 1500) + "…" : body}\n\nReply on your account page:\n${link}${SIGNATURE}`,
  }),
  accepted: (renter, r, link) => ({
    subject: `Accepted: ${r.gpu_count} × ${r.gpu_model}`,
    text: r.access === "tdcc"
      ? `Hi ${renter},\n\n${r.host_name} accepted your request for ${r.gpu_count} × ${r.gpu_model}. Your ${r.hours} hours of tdcc access start now.${r.host_note ? `\n\nTheir note: ${r.host_note}` : ""}\n\nOpen your account page for the one command that connects you:\n${link}${SIGNATURE}`
      : `Hi ${renter},\n\n${r.host_name} accepted your request for ${r.gpu_count} × ${r.gpu_model} for ${r.hours} hours, starting ${new Date((r.access_starts_at || Date.now() / 1000) * 1000).toUTCString()}.${r.payment_status === "captured" ? ` Your card was charged $${(r.total_cents / 100).toFixed(2)}.` : ""}${r.host_note ? `\n\nTheir note: ${r.host_note}` : ""}\n\n${r.payment_status === "captured" ? "You can now message the host and see their email address" : "You can now see their email address and agree on payment"}:\n${link}${SIGNATURE}`,
  }),
  declined: (renter, r, link) => ({
    subject: `Declined: ${r.gpu_count} × ${r.gpu_model}`,
    text: `Hi ${renter},\n\n${r.host_name} could not take your request for ${r.gpu_count} × ${r.gpu_model}.${r.host_note ? `\n\nTheir note: ${r.host_note}` : ""}\n\nOther GPUs are listed here:\n${link}${SIGNATURE}`,
  }),
  cancelled: (name, r, by, link) => ({
    subject: `Cancelled: ${r.gpu_count} × ${r.gpu_model}`,
    text: `Hi ${name},\n\n${by} cancelled the rental of ${r.gpu_count} × ${r.gpu_model} for ${r.hours} hours.\n\n${link}${SIGNATURE}`,
  }),
};
