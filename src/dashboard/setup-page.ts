// ═══ First-run setup page (served ONLY while no owner/user exists) ═══
//
// Mirrors the login page's design tokens; fully self-contained, no CDN
// scripts (CSP-compatible: the page's inline script is allowed by the
// existing 'unsafe-inline'). The form posts to /api/setup with the
// one-time token printed in the server log at startup — proof of host
// access, so a stranger who merely reaches an exposed port cannot claim
// the installation.

import { DASHBOARD_VERSION } from "./version";

export const SETUP_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Uncle Carl — First-run setup</title>
<meta name="theme-color" content="#060a13">
<style>
:root{
  --bg:#060a13;--bg-elev:#0e1a33;--card-solid:#0e1a33;
  --border:rgba(148,163,184,.14);--text:#f0f4fc;--text-secondary:#c8d4e8;
  --muted:#6f87a8;--blue:#5ba8ff;--red:#f16b6b;--green:#3ddc97;
  --radius-sm:6px;--radius-lg:16px;--text-xs:11px;--text-sm:13px;
}
*{margin:0;padding:0;box-sizing:border-box}
html,body{min-height:100%;background:var(--bg)}
body{display:flex;align-items:center;justify-content:center;padding:24px 0;
  font-family:system-ui,-apple-system,sans-serif;color:var(--text)}
.wrap{width:100%;max-width:440px;padding:0 16px}
.card{background:var(--card-solid);border-radius:var(--radius-lg);padding:36px 32px;
  border:1px solid var(--border);box-shadow:0 8px 32px rgba(0,0,0,.32)}
h1{font-size:18px;margin-bottom:6px}
.sub{color:var(--muted);font-size:var(--text-sm);margin-bottom:20px;line-height:1.5}
.field{margin-bottom:14px}
.field label{display:block;font-size:var(--text-xs);font-weight:600;color:var(--muted);
  margin-bottom:4px;text-transform:uppercase;letter-spacing:.06em}
.field input{width:100%;padding:11px 14px;background:var(--bg);border:1px solid var(--border);
  border-radius:var(--radius-sm);color:var(--text);font-size:var(--text-sm);outline:none}
.field input:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(91,168,255,.12)}
.hint{color:var(--muted);font-size:var(--text-xs);margin-top:4px;line-height:1.4}
.btn{width:100%;padding:13px;background:var(--blue);color:var(--bg);border:none;
  border-radius:var(--radius-sm);font-size:var(--text-sm);font-weight:700;cursor:pointer;margin-top:6px}
.btn:disabled{opacity:.45;cursor:not-allowed}
.msg{display:none;padding:10px 14px;border-radius:var(--radius-sm);font-size:var(--text-xs);
  margin-bottom:14px;line-height:1.4}
.msg.err{display:block;background:rgba(241,107,107,.08);border:1px solid rgba(241,107,107,.25);color:var(--red)}
.msg.ok{display:block;background:rgba(61,220,151,.08);border:1px solid rgba(61,220,151,.25);color:var(--green)}
.footer{text-align:center;margin-top:18px;color:var(--muted);font-size:var(--text-xs);opacity:.7}
</style>
</head>
<body>
<div class="wrap"><div class="card">
  <h1>First-run setup</h1>
  <p class="sub">No owner is configured yet. Paste the <b>setup token printed in the
  server log</b> (proof you control this host) and create the owner account.
  You can also run <code>bun run setup</code> on the host instead.</p>

  <div class="msg" id="msg" role="alert" aria-live="polite"></div>

  <form id="form">
    <div class="field">
      <label for="token">Setup token (from the server log)</label>
      <input id="token" name="token" autocomplete="off" required>
      <div class="hint">Printed at startup as: FIRST-RUN SETUP TOKEN</div>
    </div>
    <div class="field">
      <label for="user">Owner username</label>
      <input id="user" name="username" autocomplete="username" required>
    </div>
    <div class="field">
      <label for="pass">Password (min 8 chars)</label>
      <input id="pass" type="password" name="password" autocomplete="new-password" required>
    </div>
    <div class="field">
      <label for="pass2">Repeat password</label>
      <input id="pass2" type="password" autocomplete="new-password" required>
    </div>
    <button type="submit" class="btn" id="btn">Create owner account</button>
  </form>

  <div class="footer">Uncle Carl &nbsp;·&nbsp; ${DASHBOARD_VERSION} &nbsp;·&nbsp; self-hosted</div>
</div></div>

<script>
const form=document.getElementById('form'),msg=document.getElementById('msg'),btn=document.getElementById('btn');
function show(kind,text){msg.textContent=text;msg.className='msg '+kind}
form.onsubmit=async e=>{
  e.preventDefault();
  msg.className='msg';
  const password=document.getElementById('pass').value;
  if(password!==document.getElementById('pass2').value){show('err','Passwords do not match');return}
  btn.disabled=true;
  try{
    const r=await fetch('/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token:document.getElementById('token').value.trim(),
        username:document.getElementById('user').value.trim(),password})});
    const d=await r.json();
    if(!r.ok){show('err',d.error||'Setup failed');btn.disabled=false;return}
    show('ok','Owner created — redirecting to login\\u2026');
    setTimeout(()=>{window.location.href='/login'},900);
  }catch(ex){show('err','Connection error — check the server');btn.disabled=false}
};
</script>
</body>
</html>`;
