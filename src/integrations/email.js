// Transactional email through Resend. Clockwork style: British spelling, no emoji, no exclamation marks.
import { config } from '../config.js';

const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export { rupees };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f4f5f4;font-family:Helvetica,Arial,sans-serif;color:#0B0D0C">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px">
<tr><td style="padding:28px 32px 8px;font-size:12px;letter-spacing:3px;color:#5b6360">CLOCKWORK CREATORS</td></tr>
<tr><td style="padding:0 32px 8px;font-size:22px;font-weight:600">${esc(title)}</td></tr>
<tr><td style="padding:8px 32px 32px;font-size:15px;line-height:1.6">${bodyHtml}</td></tr>
</table>
<p style="font-size:12px;color:#5b6360;max-width:560px">Clockwork Rituals Pvt. Ltd., Gurugram. Questions: ${esc(config.email.replyTo)}. Programme terms: ${esc(config.storeUrl)}/pages/creator-terms</p>
</td></tr></table></body></html>`;
}

const button = (href, label) => `<p style="margin:24px 0"><a href="${esc(href)}" style="background:#0B0D0C;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">${esc(label)}</a></p>`;

export async function send({ to, subject, title, html, attachments }) {
  if (!config.email.resendKey) {
    console.log(`[email not sent: RESEND_API_KEY missing] to=${to} subject=${subject}`);
    return { skipped: true };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.email.resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.email.from, to: [to], reply_to: config.email.replyTo, subject, html: layout(title || subject, html),
      ...(attachments ? { attachments: attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') })) } : {}) }),
  });
  if (!res.ok) throw new Error(`Resend: ${res.status} ${await res.text()}`);
  return res.json();
}

const CLAIMS = `<p><strong>What you can say</strong><br>Clockwork Daily helps remineralise enamel. It contains 10% nanoXIM·CarePaste, made by FLUIDINOVA. Our toothpastes are fluoride-free and SLS-free.</p>
<p><strong>What you must not say</strong><br>Repairs, rebuilds, heals, reverses or cures; non-toxic, chemical free, 100% natural, completely safe, safe to swallow; clinically proven, dentist recommended, patented; best, India's #1 or first; any nano-hydroxyapatite percentage; anything against fluoride; any mineral claim for Kids.</p>
<p><strong>Disclosure</strong><br>Every post about Clockwork needs Instagram's Paid partnership label, or #ad or #sponsored in the first lines of the caption.</p>`;

export const emails = {
  verify: (to, link) => send({ to, subject: 'Confirm your email for Clockwork Creators', title: 'Confirm your email',
    html: `<p>One step left. Confirm this is your email address and we will set up your code.</p>${button(link, 'Confirm my email')}<p>This link works for 24 hours.</p>` }),

  welcome: (to, { name, code, links, dashboard, spotlight }) => send({ to, subject: `Your Clockwork code is ${code}`, title: `Welcome, ${name}`,
    html: `<p>You are in. Your code is <strong>${esc(code)}</strong>. It gives your audience 10% off, once each.</p>
<p><strong>What you earn</strong><br>₹300 for every new customer who orders through your code or link until 30 June 2027. Repeat orders earn 10%, rising to 15% and 20% as your monthly orders grow.</p>
<p><strong>Your links</strong><br>Clockwork Daily: ${esc(links.daily)}<br>The whole range: ${esc(links.shop)}</p>
${spotlight ? '<p>Your reach puts you in our Spotlight group, so a tube of Clockwork Daily is on its way to you.</p>' : ''}
${CLAIMS}${button(dashboard, 'Open your dashboard')}<p>Orders count once delivered and past the 7-day window. During the launch we pay every Monday.</p>` }),

  rejected: (to, { reasons, reapplyAfter }) => send({ to, subject: 'Your Clockwork Creators application', title: 'Not this time',
    html: `<p>Thank you for applying. Your account does not meet our criteria yet:</p><ul>${reasons.map((r) => `<li>${esc(r.message)}</li>`).join('')}</ul>
<p>You can apply again from ${esc(reapplyAfter)}.</p>` }),

  magicLink: (to, link) => send({ to, subject: 'Your Clockwork Creators sign-in link', title: 'Sign in',
    html: `${button(link, 'Open my dashboard')}<p>This link works for 15 minutes. If you did not ask for it, you can ignore this email.</p>` }),

  statement: (to, { name, periodLabel, rows, gross, adjustments, carryIn, tds, net, carryOut, dryRun, testMode }) => send({ to,
    subject: `Your Clockwork statement, ${periodLabel}`, title: `Statement, ${periodLabel}`,
    html: `<p>Hello ${esc(name)}, here is your statement.</p>
<table width="100%" cellpadding="6" style="border-collapse:collapse;font-size:14px">
<tr style="text-align:left;border-bottom:1px solid #ddd"><th>Order</th><th>Basis</th><th style="text-align:right">Earned</th></tr>
${rows.map((r) => `<tr style="border-bottom:1px solid #eee"><td>${esc(r.order_name)}</td><td>${r.basis === 'flat' ? 'New customer' : `${r.rate_bps / 100}%`}</td><td style="text-align:right">${rupees(r.commission_paise)}</td></tr>`).join('')}
</table>
<p>Earned: ${rupees(gross)}<br>Adjustments: ${rupees(adjustments)}<br>Brought forward: ${rupees(carryIn)}<br>Tax deducted at source: ${rupees(tds)}<br><strong>${carryOut ? 'Carried forward' : 'Paid to you'}: ${rupees(carryOut || net)}</strong></p>
${carryOut ? '<p>Balances under ₹500 carry forward to your next statement.</p>' : ''}
${dryRun || testMode ? '<p style="color:#5b6360">Test statement: no money has been sent.</p>' : carryOut ? '' : '<p>Your payment is on its way to your registered account. Bank transfers usually arrive within a few hours.</p>'}` }),

  postProblem: (to, { permalink, problems }) => send({ to, subject: 'A Clockwork post needs a change', title: 'One of your posts needs a change',
    html: `<p>We checked ${esc(permalink)} and found:</p><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
<p>Please edit the caption. Your payments are on hold until it is fixed, then they are released automatically.</p>` }),

  paused: (to, { reason }) => send({ to, subject: 'Your Clockwork payments are on hold', title: 'Payments on hold',
    html: `<p>${esc(reason)}</p><p>Held money is paid automatically once our check clears. Reply to this email if you think we have got it wrong.</p>` }),

  rateChanged: (to, { name }) => send({ to, subject: 'A change to how you earn with Clockwork', title: 'Your earnings basis has changed',
    html: `<p>Hello ${esc(name)}. Fewer than 30% of the customers you brought, who should have run out by now, have ordered again. Under section 3 of the Creator Terms, new orders now earn your tier percentage instead of ₹300. Money already paid to you is unaffected.</p>` }),

  tierChanged: (to, { name, tierLabel, up }) => send({ to, subject: `You are now ${tierLabel}`, title: up ? `You have reached ${tierLabel}` : `Your tier is now ${tierLabel}`,
    html: `<p>Hello ${esc(name)}. From the 1st of this month your tier is ${esc(tierLabel)}. It applies to orders placed from that day.</p>` }),

  ownerDigest: (subject, html) => send({ to: config.email.ownerDigest, subject, title: subject, html }),

  ownerDigestWithAttachment: (subject, html, attachment) => send({ to: config.email.ownerDigest, subject, title: subject, html, attachments: [attachment] }),

  payoutFailed: (to, { name, reason }) => send({ to, subject: 'We could not pay you this week', title: 'Your payment did not go through',
    html: `<p>Hello ${esc(name)}. Your payment was returned by the bank: ${esc(reason || 'the account details were not accepted')}. The amount is safe and carried forward.</p>
<p>Please write to partners@clockworkrituals.com from your registered email with your correct UPI ID or bank account, and we will pay it in the next run.</p>` }),

  payoutDetailsChanged: (to, { name, last4 }) => send({ to, subject: 'Your Clockwork payout details were changed', title: 'Payout details changed',
    html: `<p>Hello ${esc(name)}. Your payout account was changed to one ending ${esc(last4)}. For your security, we wait 72 hours before paying to a new account.</p>
<p>If you did not make this change, reply to this email straight away.</p>` }),
};
