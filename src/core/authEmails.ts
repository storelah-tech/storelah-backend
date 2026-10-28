// CMS operator auth emails (2026-10-28): invite, password reset, password
// changed, account locked. Same branded shell as the booking emails; sent via
// sendSimpleEmail (never throws, skipped under NODE_ENV=test / no SES).

import { escapeHtml, sendSimpleEmail, type BuiltBookingEmail, type SendResult } from './emails';

const C = {
  olive: '#334437',
  terra: '#BD6B50',
  cream: '#FBF7F1',
  charcoal: '#282B27',
  muted: '#746F66',
  border: '#E1D8CB',
  white: '#FFFFFF',
} as const;

const FONT = 'font-family:Arial,Helvetica,sans-serif;';

function shell(opts: { title: string; greeting: string; paragraphs: string[]; button?: { label: string; url: string }; footnote: string }): string {
  const p = opts.paragraphs
    .map((t) => `<tr><td style="padding:10px 32px 0 32px;${FONT}font-size:15px;line-height:22px;color:${C.charcoal};">${t}</td></tr>`)
    .join('');
  const button = opts.button
    ? `<tr><td style="padding:22px 32px 4px 32px;"><a href="${escapeHtml(opts.button.url)}" style="display:inline-block;background-color:${C.terra};color:${C.white};${FONT}font-size:15px;font-weight:bold;text-decoration:none;padding:12px 22px;border-radius:8px;">${escapeHtml(opts.button.label)}</a></td></tr>
       <tr><td style="padding:10px 32px 0 32px;${FONT}font-size:12px;line-height:18px;color:${C.muted};word-break:break-all;">Or paste this link into your browser:<br>${escapeHtml(opts.button.url)}</td></tr>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:${C.cream};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${C.cream};">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background-color:${C.white};border:1px solid ${C.border};border-radius:12px;overflow:hidden;">
        <tr><td style="background-color:${C.olive};padding:24px 32px;">
          <div style="${FONT}font-size:20px;font-weight:bold;color:${C.white};">StoreLah</div>
          <div style="${FONT}font-size:13px;color:#DFE7DD;padding-top:4px;">Operator CMS</div>
        </td></tr>
        <tr><td style="padding:26px 32px 0 32px;${FONT}font-size:18px;font-weight:bold;color:${C.charcoal};">${escapeHtml(opts.title)}</td></tr>
        <tr><td style="padding:12px 32px 0 32px;${FONT}font-size:15px;line-height:22px;color:${C.charcoal};">${escapeHtml(opts.greeting)}</td></tr>
        ${p}
        ${button}
        <tr><td style="padding:24px 32px 28px 32px;${FONT}font-size:12px;line-height:18px;color:${C.muted};border-top:1px solid ${C.border};">
          <div style="padding-top:16px;">${opts.footnote}</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function hoursLabel(hours: number): string {
  return hours % 24 === 0 && hours >= 48 ? `${hours / 24} days` : `${hours} hour${hours === 1 ? '' : 's'}`;
}

export function buildInviteEmail(d: { name: string; inviterName: string; roleName: string; url: string; expiresHours: number }): BuiltBookingEmail {
  const subject = 'You have been invited to the StoreLah CMS';
  const html = shell({
    title: 'Set up your StoreLah CMS account',
    greeting: `Hi ${d.name},`,
    paragraphs: [
      `${escapeHtml(d.inviterName)} has added you to the StoreLah operator CMS as <b>${escapeHtml(d.roleName)}</b>.`,
      `Choose a password to activate your account. The link works once and expires in ${hoursLabel(d.expiresHours)}.`,
    ],
    button: { label: 'Set your password', url: d.url },
    footnote: "Not expecting this? You can ignore this email — no account is active until a password is set.",
  });
  const text = [
    `Hi ${d.name},`,
    '',
    `${d.inviterName} has added you to the StoreLah operator CMS as ${d.roleName}.`,
    `Choose a password to activate your account (link works once, expires in ${hoursLabel(d.expiresHours)}):`,
    d.url,
    '',
    'Not expecting this? Ignore this email — no account is active until a password is set.',
  ].join('\n');
  return { subject, html, text };
}

export function buildResetEmail(d: { name: string; url: string; expiresHours: number; byOwner: boolean }): BuiltBookingEmail {
  const subject = 'Reset your StoreLah CMS password';
  const why = d.byOwner ? 'An Owner sent you a link to reset your StoreLah CMS password.' : 'We received a request to reset your StoreLah CMS password.';
  const html = shell({
    title: 'Reset your password',
    greeting: `Hi ${d.name},`,
    paragraphs: [escapeHtml(why), `The link works once and expires in ${hoursLabel(d.expiresHours)}. Your current password keeps working until you set a new one.`],
    button: { label: 'Choose a new password', url: d.url },
    footnote: "Didn't ask for this? You can ignore this email. If it keeps happening, tell your Owner.",
  });
  const text = [`Hi ${d.name},`, '', why, `Choose a new password (link works once, expires in ${hoursLabel(d.expiresHours)}):`, d.url, '', "Didn't ask for this? Ignore this email."].join('\n');
  return { subject, html, text };
}

export function buildPasswordChangedEmail(d: { name: string; when: Date; byOwner: boolean }): BuiltBookingEmail {
  const when = d.when.toLocaleString('en-SG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Singapore' });
  const how = d.byOwner ? 'An Owner set a new password for your account' : 'Your password was changed';
  const subject = 'Your StoreLah CMS password was changed';
  const html = shell({
    title: 'Password changed',
    greeting: `Hi ${d.name},`,
    paragraphs: [`${escapeHtml(how)} on ${escapeHtml(when)} (Singapore time). You have been signed out on every other device.`, 'If this was not you, contact your Owner straight away.'],
    footnote: 'This is a security notice. No action is needed if you made this change.',
  });
  const text = [`Hi ${d.name},`, '', `${how} on ${when} (Singapore time). You have been signed out on every other device.`, 'If this was not you, contact your Owner straight away.'].join('\n');
  return { subject, html, text };
}

export function buildLockedEmail(d: { name: string; minutes: number; forgotUrl: string }): BuiltBookingEmail {
  const subject = 'Your StoreLah CMS account was locked';
  const html = shell({
    title: 'Account locked for now',
    greeting: `Hi ${d.name},`,
    paragraphs: [
      `There were several failed sign-in attempts on your account, so it is locked for ${d.minutes} minutes.`,
      'If that was you and you forgot your password, you can reset it. If it was not you, tell your Owner.',
    ],
    button: { label: 'Reset your password', url: d.forgotUrl },
    footnote: 'This is a security notice. The lock lifts by itself, or an Owner can unlock you sooner.',
  });
  const text = [`Hi ${d.name},`, '', `Several failed sign-in attempts locked your account for ${d.minutes} minutes.`, `Forgot your password? ${d.forgotUrl}`, 'If this was not you, tell your Owner.'].join('\n');
  return { subject, html, text };
}

export function sendAuthEmail(to: string, built: BuiltBookingEmail, tag: string): Promise<SendResult> {
  return sendSimpleEmail(to, built, `cms-auth ${tag}`);
}
