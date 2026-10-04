// ═══ Login page HTML (self-contained, served before auth wall) ═══

import { DASHBOARD_VERSION } from "./version";

/**
 * Platform phase (2026-10-04): the page is now rendered per-request so the
 * "Continue with GitHub/Google" buttons appear ONLY when the instance has
 * that provider configured (src/platform/instance.ts oauth block). With no
 * OAuth configured the output is the pre-platform page (plus the hidden
 * ?error= handler) — routes/auth.ts decides, this module just renders.
 * No CDN assets: the provider icons are inline SVG.
 */
export interface LoginPageOptions {
  github?: boolean;
  google?: boolean;
}

const GITHUB_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;
const GOOGLE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.57c2.08-1.92 3.27-4.74 3.27-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84z"/><path fill="#EA4335" d="M12 5.36c1.62 0 3.06.56 4.21 1.64l3.16-3.16A11 11 0 0 0 12 1 11 11 0 0 0 2.18 7.05l3.66 2.84C6.71 7.29 9.14 5.36 12 5.36z"/></svg>`;

function oauthButtonsHtml(opts: LoginPageOptions): string {
  const buttons: string[] = [];
  if (opts.github) buttons.push(`<a class="oauth-btn" href="/auth/oauth/github/start">${GITHUB_ICON}<span>Continue with GitHub</span></a>`);
  if (opts.google) buttons.push(`<a class="oauth-btn" href="/auth/oauth/google/start">${GOOGLE_ICON}<span>Continue with Google</span></a>`);
  if (buttons.length === 0) return "";
  return `
    <div class="oauth-divider" aria-hidden="true"><span>or</span></div>
    <div class="oauth-row">${buttons.join("\n    ")}</div>`;
}

export function renderLoginPage(opts: LoginPageOptions = {}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Uncle Carl — Login</title>
<!-- Same inline trend-up logo favicon as the dashboard (index.html) so the
     browser tab is consistent across the login → dashboard transition. -->
<link rel="icon" href="data:image/svg+xml,&lt;svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%235ba8ff%22 stroke-width=%222.5%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22&gt;&lt;path d=%22M3 17l6-6 4 4 8-8%22/&gt;&lt;path d=%22M14 7h7v7%22/&gt;&lt;/svg&gt;">
<meta name="theme-color" content="#060a13">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=Plus+Jakarta+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
/* ════════════════════════════════════════════════════════════════════
   Phase 5B — login page redesigned to track the dashboard design system.
   Decision (Option C from the brief): keep ONE gradient moment on the
   wordmark so the login is still a distinctive "first impression", and
   align everything else (surfaces, inputs, button, toggle, error state)
   to the dashboard tokens. Killed: orb blur background, card backdrop-
   filter, submit-button gradient (now flat solid blue), Syne uppercase
   wordmark gradient kept.
   ════════════════════════════════════════════════════════════════════ */

 /* Tokens mirror the v4 dashboard styles (kept inline since this page is served
   before the dashboard bundle and must work fully standalone). */
:root{
  --bg:#060a13;
  --bg-elev:#0e1a33;
  --card-solid:#0e1a33;
  --border:rgba(148,163,184,.14);
  --border-hover:rgba(148,163,184,.28);
  --text:#f0f4fc;
  --text-secondary:#c8d4e8;
  --muted:#6f87a8;
  --blue:#5ba8ff;
  --red:#f16b6b;
  --radius-sm:6px;
  --radius-md:10px;
  --radius-lg:16px;
  --text-xs:11px;
  --text-sm:13px;
  --text-md:15px;
  --text-lg:18px;
  --space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-5:24px;
  --dur-fast:.15s;
  --shadow-1:0 4px 12px rgba(0,0,0,.18);
  --shadow-2:0 8px 32px rgba(0,0,0,.32);
}

*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:var(--bg)}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;
  font-family:'Plus Jakarta Sans',system-ui,-apple-system,sans-serif;
  color:var(--text);-webkit-font-smoothing:antialiased;
  /* Single subtle radial accent instead of three blurred orbs — keeps the
     "premium" feel without GPU compositing or backdrop-filter. */
  background:
    radial-gradient(ellipse 600px 400px at 50% -10%, rgba(91,168,255,.06), transparent 70%),
    var(--bg);
}

/* Grid overlay — same texture density as the dashboard's subtle backdrop. */
.bg-grid{position:fixed;inset:0;pointer-events:none;
  background-image:linear-gradient(rgba(148,163,184,.025) 1px,transparent 1px),
                   linear-gradient(90deg,rgba(148,163,184,.025) 1px,transparent 1px);
  background-size:48px 48px}

/* ── Card ── solid surface, no backdrop-filter. */
.wrap{position:relative;z-index:10;width:100%;max-width:400px;padding:0 var(--space-4)}
.card{
  background:var(--card-solid);
  border-radius:var(--radius-lg);
  padding:40px 36px 36px;
  border:1px solid var(--border);
  box-shadow:var(--shadow-2);
  position:relative;overflow:hidden;
}
/* Single accent stripe (no gradient) — same width/treatment as kpi-bar accent. */
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;
  background:var(--blue);opacity:.6}

/* ── Logo (the ONE branded moment) ── */
.logo{text-align:center;margin-bottom:32px}
.logo-mark{display:inline-flex;align-items:center;justify-content:center;
  width:48px;height:48px;border-radius:12px;
  background:rgba(91,168,255,.1);border:1px solid rgba(91,168,255,.25);
  color:var(--blue);margin-bottom:14px}
.logo-mark svg{width:24px;height:24px;stroke:currentColor;fill:none;
  stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.logo-title{font-family:'Syne',system-ui,sans-serif;font-size:1.5rem;font-weight:800;
  letter-spacing:-.02em;text-transform:uppercase;
  /* The single gradient moment — kept per Option C as the brand surface. */
  background:linear-gradient(135deg,var(--text) 30%,var(--blue));
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
  display:block;margin-bottom:4px}
.logo-sub{color:var(--muted);font-size:var(--text-xs);font-weight:500;
  letter-spacing:.15em;text-transform:uppercase}

 /* ── Form — matches the v4 slideover input styling ── */
.field{margin-bottom:var(--space-4)}
.field label{display:block;font-size:var(--text-xs);font-weight:600;color:var(--muted);
  margin-bottom:var(--space-1);text-transform:uppercase;letter-spacing:.06em}
.field input{width:100%;padding:11px 14px;
  background:var(--bg);
  border:1px solid var(--border);
  border-radius:var(--radius-sm);
  color:var(--text);font-size:var(--text-sm);
  font-family:'Plus Jakarta Sans',system-ui,sans-serif;
  outline:none;transition:border-color var(--dur-fast),box-shadow var(--dur-fast)}
.field input:focus{border-color:var(--blue);
  box-shadow:0 0 0 3px rgba(91,168,255,.12)}
.field input::placeholder{color:var(--muted);opacity:.5}

/* Password eye toggle */
.pw-wrap{position:relative}
.pw-wrap input{padding-right:42px}
.eye-btn{position:absolute;right:0;top:0;bottom:0;width:40px;display:flex;align-items:center;
  justify-content:center;background:none;border:none;cursor:pointer;color:var(--muted);
  transition:color var(--dur-fast);-webkit-tap-highlight-color:transparent;padding:0;
  font-family:inherit}
.eye-btn:hover{color:var(--text-secondary)}
.eye-btn:focus-visible{outline:2px solid var(--blue);outline-offset:-2px;border-radius:var(--radius-sm)}
.eye-btn svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.8;
  stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}

/* ── Remember me — kept the toggle pattern (it's clean), retokenised colours ── */
.remember{display:flex;align-items:center;gap:10px;margin-bottom:22px;cursor:pointer;user-select:none}
.remember input[type=checkbox]{position:absolute;opacity:0;width:0;height:0}
.toggle-track{width:36px;height:20px;border-radius:10px;background:var(--bg);
  border:1px solid var(--border);flex-shrink:0;position:relative;
  transition:background var(--dur-fast),border-color var(--dur-fast);cursor:pointer}
.toggle-track::after{content:'';position:absolute;width:14px;height:14px;border-radius:50%;
  background:var(--muted);top:2px;left:2px;transition:transform var(--dur-fast),background var(--dur-fast)}
.remember input:checked+.toggle-track{background:rgba(91,168,255,.18);border-color:var(--blue)}
.remember input:checked+.toggle-track::after{transform:translateX(16px);background:var(--blue)}
.remember input:focus-visible+.toggle-track{outline:2px solid var(--blue);outline-offset:2px}
.remember span{font-size:var(--text-sm);color:var(--text-secondary);font-weight:500}

/* ── Submit btn — flat solid blue, NO gradient (dashboard .btn-p uses gradient
     in a small accent context; the full-width submit is a stronger affordance
     so it stays solid, matching the rest of the modal submit buttons). ── */
.btn{width:100%;padding:13px;background:var(--blue);
  color:var(--bg);border:none;border-radius:var(--radius-sm);font-size:var(--text-sm);
  font-family:'Plus Jakarta Sans',system-ui,sans-serif;
  font-weight:700;cursor:pointer;letter-spacing:.01em;
  transition:background var(--dur-fast),transform var(--dur-fast),box-shadow var(--dur-fast);
  box-shadow:0 4px 14px rgba(91,168,255,.25)}
.btn:hover:not(:disabled){background:#7ab8ff;transform:translateY(-1px);
  box-shadow:0 6px 20px rgba(91,168,255,.35)}
.btn:active:not(:disabled){transform:translateY(0)}
.btn:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.btn:disabled{opacity:.45;cursor:not-allowed}

/* ── Error — uses the same red token + alpha pattern as dashboard inline errors ── */
.error{display:none;background:rgba(241,107,107,.08);border:1px solid rgba(241,107,107,.25);
  color:var(--red);padding:10px 14px;border-radius:var(--radius-sm);font-size:var(--text-xs);
  margin-bottom:var(--space-4);line-height:1.4}
.error.show{display:block;animation:errIn .2s ease-out}
@keyframes errIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}

.footer{text-align:center;margin-top:var(--space-5);color:var(--muted);
  font-size:var(--text-xs);letter-spacing:.03em;opacity:.7}

/* ── OAuth (shown only when the instance has a provider configured) ── */
.oauth-divider{display:flex;align-items:center;gap:10px;margin:18px 0 14px;
  color:var(--muted);font-size:var(--text-xs);text-transform:uppercase;letter-spacing:.1em}
.oauth-divider::before,.oauth-divider::after{content:'';flex:1;height:1px;background:var(--border)}
.oauth-row{display:flex;flex-direction:column;gap:10px}
.oauth-btn{display:flex;align-items:center;justify-content:center;gap:10px;
  padding:11px 14px;background:var(--bg);border:1px solid var(--border);
  border-radius:var(--radius-sm);color:var(--text-secondary);text-decoration:none;
  font-size:var(--text-sm);font-weight:600;
  transition:border-color var(--dur-fast),color var(--dur-fast)}
.oauth-btn:hover{border-color:var(--border-hover);color:var(--text)}
.oauth-btn:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.oauth-btn svg{width:18px;height:18px;flex-shrink:0}

@media(max-width:440px){.card{padding:32px 24px 28px}.wrap{padding:0 12px}}
@media(prefers-reduced-motion:reduce){.error.show{animation:none}}
</style>
</head>
<body>
<div class="bg-grid"></div>

<div class="wrap">
  <div class="card">
    <div class="logo">
      <!-- Phase 5B: replaced 🤖 emoji with the dashboard's chart-line brand
           mark (same SVG path used by the header logo). Inline so the page
           remains a single self-contained file. -->
      <span class="logo-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>
      </span>
      <span class="logo-title">Uncle Carl</span>
       <span class="logo-sub">Trading System &nbsp;·&nbsp; ${DASHBOARD_VERSION}</span>
    </div>

    <div class="error" id="err" role="alert" aria-live="polite"></div>

    <form id="form" autocomplete="on">
      <div class="field">
        <label for="user">Username</label>
        <input type="text" id="user" name="username" placeholder="your username"
               autocomplete="username" autofocus required>
      </div>
      <div class="field">
        <label for="pass">Password</label>
        <div class="pw-wrap">
          <input type="password" id="pass" name="password" placeholder="••••••••"
                 autocomplete="current-password" required>
          <button type="button" class="eye-btn" id="eyeBtn" aria-label="Show password" tabindex="-1">
            <svg id="eyeIcon" viewBox="0 0 24 24">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
        </div>
      </div>

      <label class="remember">
        <input type="checkbox" id="rememberMe">
        <span class="toggle-track" role="switch" aria-checked="false" id="toggleTrack" aria-hidden="true"></span>
        <span>Stay signed in for 30 days</span>
      </label>

      <button type="submit" class="btn" id="btn">Sign In</button>
    </form>
${oauthButtonsHtml(opts)}
    <div class="footer">Secured access &nbsp;·&nbsp; Session encrypted</div>
  </div>
</div>

<script>
const form=document.getElementById('form'),
      err=document.getElementById('err'),
      btn=document.getElementById('btn'),
      cb=document.getElementById('rememberMe'),
      track=document.getElementById('toggleTrack');

// Sync toggle aria state
cb.addEventListener('change',()=>track.setAttribute('aria-checked',cb.checked));

// OAuth failures come back as a redirect to /login?error=oauth (details in
// the server log only — never leaked to the URL).
if(new URLSearchParams(location.search).get('error')==='oauth'){
  err.textContent='Sign-in with the external provider failed or was not allowed.';
  err.className='error show';
}

// Password eye toggle
const passEl=document.getElementById('pass'),
      eyeBtn=document.getElementById('eyeBtn'),
      eyeIcon=document.getElementById('eyeIcon');
const EYE_OPEN='<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
const EYE_SHUT='<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';
eyeBtn.addEventListener('click',()=>{
  const show=passEl.type==='password';
  passEl.type=show?'text':'password';
  eyeIcon.innerHTML=show?EYE_SHUT:EYE_OPEN;
  eyeBtn.setAttribute('aria-label',show?'Hide password':'Show password');
});

form.onsubmit=async e=>{
  e.preventDefault();
  err.className='error';
  btn.disabled=true;
  const orig=btn.textContent;
  btn.textContent='Signing in\u2026';
  try{
    const r=await fetch('/api/auth/login',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        username:document.getElementById('user').value,
        password:document.getElementById('pass').value,
        rememberMe:cb.checked
      })
    });
    const d=await r.json();
    if(!r.ok){
      err.textContent=d.error||'Login failed';
      err.className='error show';
      btn.disabled=false;
      btn.textContent=orig;
      return;
    }
    window.location.href='/';
  }catch(ex){
    err.textContent='Connection error — check the server';
    err.className='error show';
    btn.disabled=false;
    btn.textContent=orig;
  }
};
</script>
</body>
</html>`;
}

/** Pre-rendered page with no OAuth providers — the pre-platform export. */
export const LOGIN_PAGE = renderLoginPage();
