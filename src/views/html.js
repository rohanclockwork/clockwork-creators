// Server-rendered pages. Clockwork look: lab black, ice white, one mint accent. No emoji, no exclamation marks.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const rupees = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export function page(title, body, { narrow = true } = {}) {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Clockwork Creators</title>
<style>
:root{--ink:#0B0D0C;--ice:#EEF4F2;--mint:#8ACDB2;--grey:#5b6360;--line:#dfe5e3}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Helvetica,Arial,sans-serif;background:var(--ice);color:var(--ink);line-height:1.55}
header{background:var(--ink);color:var(--ice);padding:18px 24px;font-size:12px;letter-spacing:4px}
header a{color:var(--ice);text-decoration:none}
main{max-width:${narrow ? 560 : 900}px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:28px;line-height:1.2;margin:0 0 12px}h2{font-size:18px;margin:32px 0 8px}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:20px;margin:16px 0}
label{display:block;font-size:14px;font-weight:600;margin:16px 0 6px}
input[type=text],input[type=email],input[type=tel],select{width:100%;padding:11px 12px;border:1px solid #c9d1ce;border-radius:6px;font-size:16px;background:#fff}
.hint{font-size:13px;color:var(--grey);margin-top:4px}
.btn{display:inline-block;background:var(--ink);color:#fff;border:0;border-radius:6px;padding:13px 22px;font-size:16px;text-decoration:none;cursor:pointer}
.btn.mint{background:var(--mint);color:var(--ink)}
.err{background:#fdecea;border:1px solid #f1b8b2;border-radius:6px;padding:12px 14px;margin:12px 0}
.ok{background:#e8f5ef;border:1px solid #b6dfcb;border-radius:6px;padding:12px 14px;margin:12px 0}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line)}td.r,th.r{text-align:right}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.stat{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px}.stat b{display:block;font-size:24px}.stat span{font-size:13px;color:var(--grey)}
.hp{position:absolute;left:-9999px}
code{background:#fff;border:1px solid var(--line);padding:2px 6px;border-radius:4px}
</style></head><body><header><a href="/">CLOCKWORK CREATORS</a></header><main>${body}</main></body></html>`;
}
