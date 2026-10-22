/* =========================================================================
   DIGITAL LEGACY MANAGER — front-end
   Talks to a real Express + PostgreSQL backend (see /server) for every
   piece of app data — accounts, OTP verification, assets, beneficiaries,
   instructions, messages, audit log and security settings. The only thing
   this file keeps in localStorage is the JWT login token (js/api.js) and
   the light/dark theme preference, both normal things for a browser app to
   remember locally.
   ========================================================================= */
const LS_THEME = 'dlm_theme_v1';

const CATEGORIES = [
  { key:'social',    label:'Social Media',       icon:'share',  color:'var(--cat-1)' },
  { key:'email',     label:'Email',              icon:'mail',   color:'var(--cat-2)' },
  { key:'cloud',     label:'Cloud Storage',      icon:'cloud',  color:'var(--cat-3)' },
  { key:'financial', label:'Financial Accounts', icon:'bank',   color:'var(--cat-4)' },
  { key:'documents', label:'Documents',          icon:'file',   color:'var(--cat-5)' },
  { key:'crypto',    label:'Crypto & Wallets',   icon:'crypto', color:'var(--cat-6)' },
];
const ACTIONS = ['Transfer to beneficiary','Delete permanently','Notify only'];
const TRIGGERS = ['Inactivity period','Verified death certificate','Manual release by executor'];

function uid(p){ return p+'_'+Math.random().toString(36).slice(2,9); }
function catMeta(key){ return CATEGORIES.find(c=>c.key===key) || CATEGORIES[0]; }
function initials(name){ return (name||'?').trim().split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase(); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function fmtDate(ts){ const d=new Date(ts); return d.toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})+', '+d.toLocaleTimeString('en-IN',{hour:'numeric',minute:'2-digit'}); }
function timeAgo(ts){
  const s = Math.floor((Date.now()-ts)/1000);
  if(s<60) return 'just now';
  const m=Math.floor(s/60); if(m<60) return m+'m ago';
  const h=Math.floor(m/60); if(h<24) return h+'h ago';
  const d=Math.floor(h/24); if(d<30) return d+'d ago';
  return fmtDate(ts);
}

/* ---------- app state ----------
   `state` is an in-memory cache of what the backend holds — it's rebuilt
   from the API on login/signup and after every mutation, never invented
   locally. Its shape matches what the render*() functions below expect:
   state.user, state.security, state.sessions, state.beneficiaries,
   state.assets, state.instructions, state.messages, state.auditLog. */
let state = null;
let auth = { loggedIn:false };

function emptyState(){
  return {
    user:null, isDemo:false,
    security:{ twoFA:false, alerts:true, bio:false, inactivityDays:90, passwordLastChangedTs:null },
    sessions:[], beneficiaries:[], assets:[], instructions:[], messages:[], auditLog:[],
  };
}

/** Pulls every resource list fresh from the API into `state`. */
async function loadAllData(){
  const [assetsRes, benefRes, instrRes, msgRes, auditRes, sessRes] = await Promise.all([
    api.getAssets(), api.getBeneficiaries(), api.getInstructions(),
    api.getMessages(), api.getAudit(), api.getSessions(),
  ]);
  state.assets = assetsRes.assets;
  state.beneficiaries = benefRes.beneficiaries;
  state.instructions = instrRes.instructions;
  state.messages = msgRes.messages;
  state.auditLog = auditRes.auditLog;
  state.sessions = sessRes.sessions;
}

/** Re-fetches just the audit log — call after any action that logs one
    server-side, so the Audit page and dashboard feed stay accurate. */
async function refreshAudit(){
  try{ state.auditLog = (await api.getAudit()).auditLog; }catch(e){ /* non-fatal */ }
}
async function refreshSessions(){
  try{ state.sessions = (await api.getSessions()).sessions; }catch(e){ /* non-fatal */ }
}

/** On page load: if a token is already stored, try to resume that session
    (rehydrating state from the API) before showing the landing page. */
async function bootstrapSession(){
  const token = getToken();
  if(!token) return false;
  try{
    const { user, security } = await api.me();
    state = emptyState();
    state.user = { name:user.name, email:user.email };
    state.isDemo = user.isDemo;
    state.security = security;
    await loadAllData();
    auth.loggedIn = true;
    return true;
  }catch(e){
    setToken(null); // stale/expired/revoked token
    return false;
  }
}

/* ---------- toast ---------- */
function toast(msg){
  const host = document.getElementById('toastHost');
  const el = document.createElement('div');
  el.className='toast';
  el.innerHTML = '<svg class="icon"><use href="#i-check"/></svg><span>'+esc(msg)+'</span>';
  host.appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; el.style.transition='opacity .25s'; setTimeout(()=>el.remove(),250); }, 2600);
}

/* ---------- navigation: landing / auth / app ---------- */
function isValidEmail(str){
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(str||'').trim());
}

/* ---------- inline field validation helper ---------- */
function setFieldError(inputId, message){
  const input = document.getElementById(inputId);
  if(!input) return;
  const field = input.closest('.field');
  if(!field) return;
  field.classList.add('invalid');
  let err = field.querySelector('.field-error');
  if(!err){
    err = document.createElement('div');
    err.className = 'field-error';
    err.innerHTML = '<svg class="icon"><use href="#i-alert"/></svg><span></span>';
    field.appendChild(err);
  }
  err.querySelector('span').textContent = message;
}
function clearFieldError(inputId){
  const input = document.getElementById(inputId);
  if(!input) return;
  const field = input.closest('.field');
  if(!field) return;
  field.classList.remove('invalid');
}
function clearFieldErrors(...inputIds){
  inputIds.forEach(clearFieldError);
}
function goAuth(tab){
  document.getElementById('landing').hidden = true;
  document.getElementById('authScreen').hidden = false;
  otpCancel('auth'); otpCancel('reset');
  pendingAuth = null; forgotEmail = null; forgotUserId = null; pendingResetToken = null;
  document.getElementById('forgotStep').hidden = true;
  setAuthTab(tab||'login');
  window.scrollTo(0,0);
}
function goLanding(){
  document.getElementById('authScreen').hidden = true;
  document.getElementById('app').hidden = true;
  document.getElementById('landing').hidden = false;
  otpCancel('auth'); otpCancel('reset');
  pendingAuth = null; forgotEmail = null; forgotUserId = null; pendingResetToken = null;
  document.getElementById('forgotStep').hidden = true;
  window.scrollTo(0,0);
}
function setAuthTab(tab){
  const isLogin = tab==='login';
  document.getElementById('authTabs').hidden = false;
  document.getElementById('authFootNote').hidden = false;
  document.getElementById('otpStep').hidden = true;
  document.getElementById('forgotStep').hidden = true;
  document.getElementById('tabLogin').classList.toggle('active', isLogin);
  document.getElementById('tabSignup').classList.toggle('active', !isLogin);
  document.getElementById('loginForm').hidden = !isLogin;
  document.getElementById('signupForm').hidden = isLogin;
  hideAuthError();
}
function showAuthError(msg){
  document.getElementById('authErrorText').textContent = msg;
  document.getElementById('authErrorBox').hidden = false;
}
function hideAuthError(){ document.getElementById('authErrorBox').hidden = true; }
function fillDemo(){
  document.getElementById('loginEmail').value = 'demo@vault.app';
  document.getElementById('loginPass').value = 'demo1234';
}
async function handleLogin(ev){
  ev.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const pass = document.getElementById('loginPass').value;
  if(!isValidEmail(email)){ showAuthError('Enter a valid email address (e.g. name@example.com).'); return false; }
  if(pass.length<4){ showAuthError('Password must be at least 4 characters.'); return false; }
  hideAuthError();
  try{
    const { userId, devOtp } = await api.login(email, pass);
    startOtp('login', userId, email, devOtp);
  }catch(e){
    showAuthError(e.message);
  }
  return false;
}
async function handleSignup(ev){
  ev.preventDefault();
  const name = document.getElementById('suName').value.trim();
  const email = document.getElementById('suEmail').value.trim();
  const pass = document.getElementById('suPass').value;
  if(!name){ showAuthError('Enter your name.'); return false; }
  if(!isValidEmail(email)){ showAuthError('Enter a valid email address (e.g. name@example.com).'); return false; }
  if(pass.length<4){ showAuthError('Password must be at least 4 characters.'); return false; }
  hideAuthError();
  try{
    const { userId, devOtp } = await api.signup(name, email, pass);
    startOtp('signup', userId, email, devOtp);
  }catch(e){
    showAuthError(e.message);
  }
  return false;
}
async function logout(){
  try{ await api.logout(); }catch(e){ /* best-effort — clear local state either way */ }
  setToken(null);
  auth.loggedIn = false;
  state = null;
  document.getElementById('app').hidden = true;
  goLanding();
}
function enterApp(){
  document.getElementById('authScreen').hidden = true;
  document.getElementById('landing').hidden = true;
  document.getElementById('app').hidden = false;
  document.getElementById('sbAvatar').textContent = initials(state.user.name);
  document.getElementById('sbName').textContent = state.user.name + (state.isDemo ? ' (Demo)' : '');
  document.getElementById('sbEmail').textContent = state.user.email;
  setView('dashboard');
  window.scrollTo(0,0);
}

/* =========================================================================
   GENERIC VERIFICATION-CODE (OTP) WIDGET
   Reused by: login/signup email verification, forgot-password, beneficiary
   email verification, and two-factor-authentication setup. Each caller gets
   its own independent "scope" string so multiple widgets never collide.
   ========================================================================= */
const otpFlows = {};   // scope -> { resendSeconds, timerHandle, ids, verifyFn, resendFn, onSuccess, busy }

function otpIds(scope){
  return {
    err: 'otp_err_'+scope,
    demo: 'otp_demo_'+scope,
    resendBtn: 'otp_resend_'+scope,
    resendTimer: 'otp_timer_'+scope,
  };
}
function otpBoxesHTML(scope){
  let inputs = '';
  for(let i=0;i<6;i++){
    inputs += `<input class="otp-box" maxlength="1" inputmode="numeric" pattern="[0-9]*" ${i===0?'autocomplete="one-time-code"':''} oninput="otpBoxInput(this,'${scope}')" onkeydown="otpBoxKeydown(event,this)" onpaste="otpBoxPaste(event,'${scope}')">`;
  }
  return `<div class="otp-inputs" data-otp-scope="${scope}" style="margin:18px 0 6px;">${inputs}</div>`;
}
function otpBoxesOf(scope){ return document.querySelectorAll('[data-otp-scope="'+scope+'"] .otp-box'); }
function otpValueOf(scope){ return Array.from(otpBoxesOf(scope)).map(b=>b.value).join(''); }
function otpClearValues(scope){ otpBoxesOf(scope).forEach(b=>b.value=''); }
function otpFocusFirst(scope){ const b = otpBoxesOf(scope); if(b[0]) b[0].focus(); }

function otpBoxInput(el, scope){
  el.value = el.value.replace(/[^0-9]/g,'').slice(0,1);
  if(el.value && el.nextElementSibling && el.nextElementSibling.classList.contains('otp-box')){
    el.nextElementSibling.focus();
  }
  if(otpValueOf(scope).length===6) otpAttemptVerify(scope);
}
function otpBoxKeydown(e, el){
  if(e.key==='Backspace' && !el.value && el.previousElementSibling && el.previousElementSibling.classList.contains('otp-box')){
    el.previousElementSibling.focus();
  }
}
function otpBoxPaste(e, scope){
  const text = (e.clipboardData || window.clipboardData).getData('text').replace(/[^0-9]/g,'').slice(0,6);
  if(!text) return;
  e.preventDefault();
  const boxes = otpBoxesOf(scope);
  boxes.forEach((b,i)=>{ b.value = text[i] || ''; });
  const next = boxes[Math.min(text.length, boxes.length-1)];
  if(next) next.focus();
  if(text.length===6) otpAttemptVerify(scope);
}
function otpShowError(scope, msg){
  const ids = otpIds(scope);
  const box = document.getElementById(ids.err);
  if(!box) return;
  const span = box.querySelector('span') || box;
  span.textContent = msg;
  box.hidden = false;
}
function otpHideError(scope){
  const box = document.getElementById(otpIds(scope).err);
  if(box) box.hidden = true;
}
function otpUpdateResendUI(scope){
  const f = otpFlows[scope]; if(!f) return;
  const btn = document.getElementById(f.ids.resendBtn);
  const timer = document.getElementById(f.ids.resendTimer);
  if(btn) btn.disabled = f.resendSeconds>0;
  if(timer) timer.textContent = f.resendSeconds>0 ? ' · wait ' + f.resendSeconds + 's' : '';
}
function otpStartCountdown(scope){
  const f = otpFlows[scope]; if(!f) return;
  f.resendSeconds = 30;
  otpUpdateResendUI(scope);
  if(f.timerHandle) clearInterval(f.timerHandle);
  f.timerHandle = setInterval(()=>{
    f.resendSeconds -= 1;
    otpUpdateResendUI(scope);
    if(f.resendSeconds<=0){ clearInterval(f.timerHandle); f.timerHandle=null; }
  }, 1000);
}
function otpStopCountdown(scope){
  const f = otpFlows[scope]; if(!f) return;
  if(f.timerHandle){ clearInterval(f.timerHandle); f.timerHandle=null; }
  f.resendSeconds = 0;
}
/** Begin a real, server-backed verification-code flow.
    devCode   — the plaintext code the backend just issued (dev-mode convenience,
                shown on screen instead of emailed, per the prototype's design).
    verifyFn  — async(code) => result; called against the real API, should
                throw an ApiError (with a user-facing .message) on a wrong/expired code.
    resendFn  — async() => newDevCode; asks the backend to issue a fresh code.
    onSuccess — async(result) => void; runs once the backend accepts the code. */
function otpStart(scope, devCode, verifyFn, resendFn, onSuccess){
  const ids = otpIds(scope);
  otpFlows[scope] = { resendSeconds:0, timerHandle:null, ids, verifyFn, resendFn, onSuccess, busy:false };
  const demoEl = document.getElementById(ids.demo);
  if(demoEl) demoEl.textContent = devCode;
  otpClearValues(scope);
  otpHideError(scope);
  otpFocusFirst(scope);
  otpStartCountdown(scope);
}
async function otpResend(scope){
  const f = otpFlows[scope];
  if(!f || f.resendSeconds>0 || f.busy) return;
  try{
    const newCode = await f.resendFn();
    const demoEl = document.getElementById(f.ids.demo);
    if(demoEl) demoEl.textContent = newCode;
    otpClearValues(scope);
    otpHideError(scope);
    otpFocusFirst(scope);
    otpStartCountdown(scope);
    toast('New code sent.');
  }catch(e){
    otpShowError(scope, e.message || 'Could not send a new code.');
  }
}
async function otpAttemptVerify(scope){
  const f = otpFlows[scope];
  if(!f || f.busy) return;
  const val = otpValueOf(scope);
  if(val.length<6){ otpShowError(scope, 'Enter all 6 digits.'); return; }
  f.busy = true;
  try{
    const result = await f.verifyFn(val);
    otpHideError(scope);
    otpStopCountdown(scope);
    const onSuccess = f.onSuccess;
    delete otpFlows[scope];
    if(onSuccess) await onSuccess(result);
  }catch(e){
    otpShowError(scope, e.message || 'That code doesn’t match. Check the demo code below and try again.');
    otpClearValues(scope);
    otpFocusFirst(scope);
    f.busy = false;
  }
}
function otpCancel(scope){
  otpStopCountdown(scope);
  delete otpFlows[scope];
}

/* ---------- login / signup email verification (scope: 'auth') ---------- */
let pendingAuth = null;   // { type:'login'|'signup', userId, email }

function startOtp(type, userId, email, devOtp){
  pendingAuth = { type, userId, email };
  document.getElementById('authTabs').hidden = true;
  document.getElementById('authFootNote').hidden = true;
  document.getElementById('loginForm').hidden = true;
  document.getElementById('signupForm').hidden = true;
  document.getElementById('forgotStep').hidden = true;
  document.getElementById('otpStep').hidden = false;
  hideAuthError();
  document.getElementById('otpEmailDisplay').textContent = email;
  otpStart('auth', devOtp,
    (code) => type==='signup' ? api.verifySignup(userId, code) : api.verifyLogin(userId, code),
    async () => (await api.resendOtp(userId, type)).devOtp,
    finishAuth);
}
function backToAuthForm(){
  const wasSignup = pendingAuth && pendingAuth.type==='signup';
  otpCancel('auth');
  pendingAuth = null;
  setAuthTab(wasSignup ? 'signup' : 'login');
}
async function finishAuth(result){
  const wasSignup = pendingAuth && pendingAuth.type==='signup';
  pendingAuth = null;
  const { token, user, security } = result;
  setToken(token);
  state = emptyState();
  state.user = { name:user.name, email:user.email };
  state.isDemo = user.isDemo;
  state.security = security;
  try{
    await loadAllData();
  }catch(e){
    toast(e.message || 'Signed in, but could not load your vault data.');
  }
  auth.loggedIn = true;
  enterApp();
  if(wasSignup) toast('Vault created — start by adding your first asset.');
  else toast('Email verified — welcome back.');
}

/* ---------- forgot password flow (scope: 'reset') ---------- */
let forgotEmail = null;
let forgotUserId = null;
let pendingResetToken = null;

function startForgotPassword(){
  document.getElementById('authTabs').hidden = true;
  document.getElementById('authFootNote').hidden = true;
  document.getElementById('loginForm').hidden = true;
  document.getElementById('signupForm').hidden = true;
  document.getElementById('otpStep').hidden = true;
  document.getElementById('forgotStep').hidden = false;
  showForgotSubstep('email');
  hideAuthError();
  clearFieldErrors('fpEmail', 'fpNewPass', 'fpNewPass2');
  document.getElementById('fpEmail').value = document.getElementById('loginEmail').value || '';
}
function showForgotSubstep(step){
  document.getElementById('fpEmailStep').hidden = step!=='email';
  document.getElementById('fpOtpStep').hidden = step!=='otp';
  document.getElementById('fpNewPassStep').hidden = step!=='newpass';
}
function cancelForgotPassword(){
  otpCancel('reset');
  forgotEmail = null; forgotUserId = null; pendingResetToken = null;
  document.getElementById('forgotStep').hidden = true;
  setAuthTab('login');
}
async function submitForgotEmail(){
  clearFieldErrors('fpEmail');
  const email = document.getElementById('fpEmail').value.trim();
  if(!isValidEmail(email)){
    setFieldError('fpEmail', 'Enter a valid email address (e.g. name@example.com).');
    document.getElementById('fpEmail').focus();
    return;
  }
  try{
    const { userId, devOtp } = await api.forgotPassword(email);
    forgotEmail = email;
    forgotUserId = userId;
    document.getElementById('fpEmailDisplay').textContent = email;
    showForgotSubstep('otp');
    otpStart('reset', devOtp,
      (code) => api.verifyReset(userId, code),
      async () => (await api.resendOtp(userId, 'reset')).devOtp,
      ({ resetToken }) => { pendingResetToken = resetToken; showForgotSubstep('newpass'); });
  }catch(e){
    setFieldError('fpEmail', e.message);
    document.getElementById('fpEmail').focus();
  }
}
async function submitNewPassword(){
  clearFieldErrors('fpNewPass', 'fpNewPass2');
  const p1 = document.getElementById('fpNewPass').value;
  const p2 = document.getElementById('fpNewPass2').value;
  if(p1.length<4){
    setFieldError('fpNewPass', 'Password must be at least 4 characters.');
    document.getElementById('fpNewPass').focus();
    return;
  }
  if(p1 !== p2){
    setFieldError('fpNewPass2', 'Passwords don’t match.');
    document.getElementById('fpNewPass2').focus();
    return;
  }
  try{
    await api.resetPassword(pendingResetToken, p1);
  }catch(e){
    setFieldError('fpNewPass', e.message);
    return;
  }
  const emailToPrefill = forgotEmail;
  forgotEmail = null; forgotUserId = null; pendingResetToken = null;
  document.getElementById('forgotStep').hidden = true;
  setAuthTab('login');
  document.getElementById('loginEmail').value = emailToPrefill || '';
  document.getElementById('loginPass').value = '';
  toast('Password reset — log in with your new password.');
}

/* ---------- view routing ---------- */
const VIEW_META = {
  dashboard:{ title:'Dashboard', sub:'Your digital estate at a glance' },
  vault:{ title:'Digital Vault', sub:'Every account, subscription and file you’ve catalogued' },
  beneficiaries:{ title:'Beneficiaries', sub:'People you trust to receive access or instructions' },
  will:{ title:'Digital Will', sub:'Instructions and messages locked until your conditions are met' },
  audit:{ title:'Audit Log', sub:'Every action on your vault, time-stamped' },
  security:{ title:'Security', sub:'Authentication, access control and sessions' },
};
let currentView = 'dashboard';
function setView(name){
  currentView = name;
  document.querySelectorAll('.view').forEach(v=>v.hidden = (v.id !== 'view-'+name));
  document.querySelectorAll('.side-link').forEach(l=>l.classList.toggle('active', l.dataset.view===name));
  document.querySelectorAll('.mobile-tab').forEach(l=>l.classList.toggle('active', l.dataset.mtab===name));
  document.getElementById('topbarTitle').textContent = VIEW_META[name].title;
  document.getElementById('topbarSub').textContent = VIEW_META[name].sub;
  document.getElementById('globalSearch').value='';
  renderView(name);
}
function renderView(name){
  if(name==='dashboard') renderDashboard();
  else if(name==='vault') renderVault();
  else if(name==='beneficiaries') renderBeneficiaries();
  else if(name==='will') renderWill();
  else if(name==='audit') renderAudit();
  else if(name==='security') renderSecurity();
}
function renderSidebarReadiness(){
  const r = computeReadiness();
  document.getElementById('sbReadinessPct').textContent = r.pct+'%';
  document.getElementById('sbReadinessBar').style.width = r.pct+'%';
}

/* ---------- readiness ---------- */
function computeReadiness(){
  const items = [
    { label:'Add at least one digital asset', done: state.assets.length>0 },
    { label:'Assign a trusted beneficiary', done: state.beneficiaries.length>0 },
    { label:'Create a digital will instruction', done: state.instructions.length>0 },
    { label:'Enable two-factor authentication', done: !!state.security.twoFA },
    { label:'Schedule a legacy message', done: state.messages.length>0 },
  ];
  const done = items.filter(i=>i.done).length;
  return { items, done, total: items.length, pct: Math.round(done/items.length*100) };
}

/* ---------- dashboard ---------- */
function renderDashboard(){
  renderSidebarReadiness();
  const assets = state.assets;
  const catsUsed = new Set(assets.map(a=>a.category)).size;
  document.getElementById('statAssets').textContent = assets.length;
  document.getElementById('statAssetsSub').textContent = assets.length ? `across ${catsUsed} categor${catsUsed===1?'y':'ies'}` : 'your vault is empty';

  document.getElementById('statBenef').textContent = state.beneficiaries.length;
  const primaryCount = state.beneficiaries.filter(b=>b.trust==='Primary').length;
  document.getElementById('statBenefSub').textContent = state.beneficiaries.length ? `${primaryCount} primary nominee${primaryCount===1?'':'s'}` : 'none assigned yet';

  const r = computeReadiness();
  document.getElementById('statReadiness').textContent = r.pct+'%';
  document.getElementById('statReadinessSub').textContent = `${r.done} of ${r.total} steps done`;

  const last = state.auditLog[0];
  document.getElementById('statLastEvent').textContent = last ? last.action : 'No activity';
  document.getElementById('statLastEventSub').textContent = last ? timeAgo(last.ts)+' · '+last.detail : '—';

  renderDonut();
  renderFeed('dashFeed', state.auditLog.slice(0,5));
  renderChecklist();
}

function renderDonut(){
  const counts = CATEGORIES.map(c => ({ ...c, count: state.assets.filter(a=>a.category===c.key).length }));
  const total = counts.reduce((s,c)=>s+c.count,0);
  const chart = document.getElementById('donutChart');
  const legend = document.getElementById('donutLegend');
  if(total===0){
    chart.innerHTML = '<div style="width:132px;height:132px;border-radius:50%;border:14px dashed var(--line);display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:.74rem;text-align:center;padding:14px;">Add an asset to see the breakdown</div>';
    legend.innerHTML = '<div style="color:var(--muted); font-size:.85rem;">No assets catalogued yet.</div>';
    return;
  }
  const r = 48, C = 2*Math.PI*r, gap = 3;
  let offset = 0, segs = '';
  counts.filter(c=>c.count>0).forEach(c=>{
    const len = (c.count/total)*C;
    const dash = Math.max(len-gap,0);
    segs += `<circle cx="65" cy="65" r="${r}" fill="none" stroke="${c.color}" stroke-width="17" stroke-dasharray="${dash} ${C-dash}" stroke-dashoffset="${-offset}" stroke-linecap="round"/>`;
    offset += len;
  });
  chart.innerHTML = `
    <div style="position:relative; width:130px; height:130px; flex:none;">
      <svg width="130" height="130" viewBox="0 0 130 130" style="transform:rotate(-90deg)">${segs}</svg>
      <div style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center;">
        <div style="font-family:var(--font-display); font-size:1.5rem; font-weight:700; line-height:1;">${total}</div>
        <div style="font-size:.68rem; color:var(--muted); margin-top:3px;">total assets</div>
      </div>
    </div>`;
  legend.innerHTML = counts.filter(c=>c.count>0).map(c=>`
    <div class="legend-row">
      <span class="sw" style="background:${c.color}"></span>
      <span class="lbl">${esc(c.label)}</span>
      <span class="val">${c.count}</span>
    </div>`).join('');
}

function renderFeed(hostId, entries){
  const host = document.getElementById(hostId);
  if(!entries.length){ host.innerHTML = '<div style="color:var(--muted); font-size:.85rem;">No activity recorded yet.</div>'; return; }
  host.innerHTML = entries.map(e=>`
    <div class="feed-row">
      <span class="feed-dot ${e.status}"></span>
      <div>
        <div class="fb"><b>${esc(e.action)}</b></div>
        <div class="fm">${esc(e.detail)} · ${timeAgo(e.ts)}</div>
      </div>
    </div>`).join('');
}

function renderChecklist(){
  const r = computeReadiness();
  document.getElementById('readinessChecklist').innerHTML = r.items.map(i=>`
    <div class="check-row ${i.done?'done':''}">
      <span class="cb">${i.done ? '<svg class="icon"><use href="#i-check"/></svg>' : ''}</span>
      <span>${esc(i.label)}</span>
    </div>`).join('');
}

/* ---------- vault ---------- */
let vaultFilter = 'all';
let searchTerm = '';
function onGlobalSearch(){
  searchTerm = document.getElementById('globalSearch').value.trim().toLowerCase();
  if(currentView==='vault') renderVault();
  else if(currentView==='beneficiaries') renderBeneficiaries();
}
function setVaultFilter(key){ vaultFilter = key; renderVault(); }
function beneficiaryName(id){ const b = state.beneficiaries.find(b=>b.id===id); return b ? b.name : null; }
function statusBadge(status){
  const map = { 'Active':'badge-success', 'Pending Review':'badge-warning', 'Draft':'badge-muted', 'Fulfilled':'badge-muted', 'Locked':'badge-muted', 'Ready to Send':'badge-warning', 'Delivered':'badge-success', 'Success':'badge-success', 'Info':'badge-muted', 'Warning':'badge-warning', 'Critical':'badge-danger' };
  return `<span class="badge ${map[status]||'badge-muted'}"><span class="dot" style="background:currentColor"></span>${esc(status)}</span>`;
}
function renderVault(){
  const chipsHost = document.getElementById('vaultFilterChips');
  const counts = CATEGORIES.map(c=>({...c, n: state.assets.filter(a=>a.category===c.key).length}));
  chipsHost.innerHTML = `<button class="chip ${vaultFilter==='all'?'active':''}" onclick="setVaultFilter('all')">All · ${state.assets.length}</button>` +
    counts.filter(c=>c.n>0 || vaultFilter===c.key).map(c=>`<button class="chip ${vaultFilter===c.key?'active':''}" onclick="setVaultFilter('${c.key}')">${esc(c.label)} · ${c.n}</button>`).join('');

  let rows = state.assets;
  if(vaultFilter!=='all') rows = rows.filter(a=>a.category===vaultFilter);
  if(searchTerm) rows = rows.filter(a => (a.name+' '+a.identifier).toLowerCase().includes(searchTerm));

  const body = document.getElementById('vaultTableBody');
  document.getElementById('vaultEmpty').hidden = rows.length>0;
  if(!rows.length){ body.innerHTML=''; return; }
  body.innerHTML = rows.slice().sort((a,b)=>b.added-a.added).map(a=>{
    const cm = catMeta(a.category);
    const bName = beneficiaryName(a.beneficiaryId);
    return `<tr>
      <td><div class="cell-main">${esc(a.name)}</div><div class="cell-sub mono">${esc(a.identifier||'')}</div></td>
      <td><span class="cat-chip"><span class="sw" style="background:${cm.color}"></span>${esc(cm.label)}</span></td>
      <td>${bName ? esc(bName) : '<span style="color:var(--muted)">Unassigned</span>'}</td>
      <td style="font-size:.83rem; color:var(--ink-soft)">${esc(a.action)}</td>
      <td>${statusBadge(a.status)}</td>
      <td><div class="row-actions">
        <button class="btn-icon" title="Edit" onclick="openAssetModal('${a.id}')"><svg class="icon"><use href="#i-edit"/></svg></button>
        <button class="btn-icon" title="Delete" onclick="confirmAction('Remove &ldquo;${esc(a.name)}&rdquo; from your vault?', () => deleteAsset('${a.id}'))"><svg class="icon"><use href="#i-trash"/></svg></button>
      </div></td>
    </tr>`;
  }).join('');
}
async function deleteAsset(id){
  try{
    await api.deleteAsset(id);
    state.assets = state.assets.filter(x=>x.id!==id);
    await refreshAudit();
    closeModal(); renderVault(); renderDashboard(); toast('Asset removed.');
  }catch(e){
    toast(e.message || 'Could not remove asset.');
  }
}

/* ---------- beneficiaries ---------- */
function assetCountFor(benefId){ return state.assets.filter(a=>a.beneficiaryId===benefId).length; }
function renderBeneficiaries(){
  let rows = state.beneficiaries;
  if(searchTerm) rows = rows.filter(b => (b.name+' '+b.relationship+' '+b.contact).toLowerCase().includes(searchTerm));
  const body = document.getElementById('benefTableBody');
  document.getElementById('benefEmpty').hidden = rows.length>0;
  if(!rows.length){ body.innerHTML=''; return; }
  body.innerHTML = rows.map(b=>`
    <tr>
      <td><div class="cell-main">${esc(b.name)}</div></td>
      <td>${esc(b.relationship)}</td>
      <td style="font-size:.85rem; color:var(--ink-soft)">${esc(b.contact)}</td>
      <td><span class="badge ${b.trust==='Primary'?'badge-success':'badge-muted'}">${esc(b.trust)}</span></td>
      <td>${assetCountFor(b.id)}</td>
      <td>${b.verified
        ? '<span class="badge badge-success"><span class="dot" style="background:currentColor"></span>Verified</span>'
        : `<button class="badge badge-warning" style="border:none; cursor:pointer;" onclick="openBeneficiaryVerifyModal('${b.id}')" title="Send a verification code"><span class="dot" style="background:currentColor"></span>Pending · Verify</button>`}</td>
      <td><div class="row-actions">
        <button class="btn-icon" title="Edit" onclick="openBeneficiaryModal('${b.id}')"><svg class="icon"><use href="#i-edit"/></svg></button>
        <button class="btn-icon" title="Delete" onclick="confirmAction('Remove &ldquo;${esc(b.name)}&rdquo; as a beneficiary? Assets assigned to them will become unassigned.', () => deleteBeneficiary('${b.id}'))"><svg class="icon"><use href="#i-trash"/></svg></button>
      </div></td>
    </tr>`).join('');
}
async function openBeneficiaryVerifyModal(id){
  const b = state.beneficiaries.find(x=>x.id===id);
  if(!b) return;
  const scope = 'benef_'+id;
  let devOtp = '';
  try{
    devOtp = (await api.sendBeneficiaryVerification(id)).devOtp;
  }catch(e){
    toast(e.message || 'Could not send verification code.');
    return;
  }
  modalShell('Verify beneficiary email', `
    <p class="modal-lead">We'll send a 6-digit verification code to confirm <strong style="color:var(--ink)">${esc(b.name)}</strong>'s email address before they can be released any assets.</p>
    <p class="mono" style="font-size:.82rem; color:var(--ink-soft); margin-top:8px;">${esc(b.contact)}</p>
    ${otpBoxesHTML(scope)}
    <div id="otp_err_${scope}" class="auth-error" hidden><svg class="icon"><use href="#i-alert"/></svg><span></span></div>
    <div class="auth-demo" style="margin-top:16px;"><svg class="icon"><use href="#i-key"/></svg><span>Prototype demo — no real email sent. Code: <b class="mono" id="otp_demo_${scope}">000000</b></span></div>
  `, `
    <button class="btn btn-ghost btn-sm" id="otp_resend_${scope}" onclick="otpResend('${scope}')">Resend code<span id="otp_timer_${scope}" class="mono"></span></button>
    <div class="r"><button class="btn btn-ghost" onclick="otpCancel('${scope}'); closeModal()">Cancel</button><button class="btn btn-primary" onclick="otpAttemptVerify('${scope}')">Verify</button></div>
  `);
  otpStart(scope, devOtp,
    (code) => api.verifyBeneficiary(id, code),
    async () => (await api.sendBeneficiaryVerification(id)).devOtp,
    async ({ beneficiary }) => {
      const bb = state.beneficiaries.find(x=>x.id===id);
      if(bb) Object.assign(bb, beneficiary);
      await refreshAudit();
      closeModal(); renderBeneficiaries(); renderDashboard();
      toast(b.name+' is now verified.');
    });
}
async function deleteBeneficiary(id){
  const b = state.beneficiaries.find(x=>x.id===id);
  try{
    await api.deleteBeneficiary(id);
    // The backend unassigns this beneficiary from any assets/instructions/
    // messages that referenced them (ON DELETE SET NULL) — reload everything
    // rather than trying to patch every affected list by hand.
    await loadAllData();
    closeModal(); renderBeneficiaries(); renderVault(); renderWill(); renderDashboard();
    toast('Beneficiary removed.');
  }catch(e){
    toast(e.message || 'Could not remove beneficiary.');
  }
}

/* ---------- will & messages ---------- */
function verificationBadge(v){
  const map = {
    not_started: ['badge-muted', 'Not started'],
    pending:     ['badge-warning', 'Pending review'],
    approved:    ['badge-success', 'Verified'],
    rejected:    ['badge-danger', 'Rejected'],
  };
  const [cls, label] = map[v && v.status] || map.not_started;
  return `<span class="badge ${cls}"><span class="dot" style="background:currentColor"></span>${label}</span>`;
}
function renderWill(){
  const iBody = document.getElementById('instrTableBody');
  document.getElementById('instrEmpty').hidden = state.instructions.length>0;
  iBody.innerHTML = state.instructions.map(i=>`
    <tr>
      <td><div class="cell-main">${esc(i.title)}</div><div class="cell-sub">${esc(i.details||'')}</div></td>
      <td style="font-size:.85rem;">${esc(i.trigger)}</td>
      <td>${beneficiaryName(i.beneficiaryId) ? esc(beneficiaryName(i.beneficiaryId)) : '<span style="color:var(--muted)">Unassigned</span>'}</td>
      <td>${statusBadge(i.status)}</td>
      <td>${verificationBadge(i.verification)}</td>
      <td><div class="row-actions">
        ${i.status!=='Fulfilled' ? `<button class="btn-icon" title="Verify trigger" onclick="openInstructionVerifyModal('${i.id}')"><svg class="icon"><use href="#i-shield"/></svg></button>` : ''}
        <button class="btn-icon" title="Edit" onclick="openInstructionModal('${i.id}')"><svg class="icon"><use href="#i-edit"/></svg></button>
        <button class="btn-icon" title="Delete" onclick="confirmAction('Delete instruction &ldquo;${esc(i.title)}&rdquo;?', () => deleteInstruction('${i.id}'))"><svg class="icon"><use href="#i-trash"/></svg></button>
      </div></td>
    </tr>`).join('');

  const mBody = document.getElementById('msgTableBody');
  document.getElementById('msgEmpty').hidden = state.messages.length>0;
  mBody.innerHTML = state.messages.map(m=>`
    <tr>
      <td><div class="cell-main">${esc(m.subject)}</div><div class="cell-sub">${esc((m.body||'').slice(0,60))}${(m.body||'').length>60?'…':''}</div></td>
      <td>${beneficiaryName(m.to) ? esc(beneficiaryName(m.to)) : '<span style="color:var(--muted)">Unassigned</span>'}</td>
      <td style="font-size:.85rem;">${esc(m.condition)}</td>
      <td>${statusBadge(m.status)}</td>
      <td><div class="row-actions">
        <button class="btn-icon" title="Edit" onclick="openMessageModal('${m.id}')"><svg class="icon"><use href="#i-edit"/></svg></button>
        <button class="btn-icon" title="Delete" onclick="confirmAction('Delete message &ldquo;${esc(m.subject)}&rdquo;?', () => deleteMessage('${m.id}'))"><svg class="icon"><use href="#i-trash"/></svg></button>
      </div></td>
    </tr>`).join('');
}
async function deleteInstruction(id){
  try{
    await api.deleteInstruction(id);
    state.instructions = state.instructions.filter(x=>x.id!==id);
    await refreshAudit();
    closeModal(); renderWill(); renderDashboard(); toast('Instruction deleted.');
  }catch(e){
    toast(e.message || 'Could not delete instruction.');
  }
}
async function deleteMessage(id){
  try{
    await api.deleteMessage(id);
    state.messages = state.messages.filter(x=>x.id!==id);
    await refreshAudit();
    closeModal(); renderWill(); renderDashboard(); toast('Message deleted.');
  }catch(e){
    toast(e.message || 'Could not delete message.');
  }
}

/* ---------- trigger verification (death certificate / executor / inactivity) ---------- */
function openInstructionVerifyModal(id){
  const i = state.instructions.find(x=>x.id===id);
  if(!i) return;
  if(!i.verification) i.verification = { status:'not_started', ref:null };
  const v = i.verification;
  const benef = i.beneficiaryId ? state.beneficiaries.find(b=>b.id===i.beneficiaryId) : null;
  let body = '', foot = '';

  if(i.trigger === 'Verified death certificate'){
    if(v.status==='not_started' || v.status==='rejected'){
      body = `<p class="modal-lead">${v.status==='rejected' ? 'Verification was rejected last time. ' : ''}Request a death-certificate verification reference. In a live deployment this would route to a verification service or legal partner rather than a self-serve button.</p>`;
      foot = `<span></span><div class="r"><button class="btn btn-ghost" onclick="closeModal()">Close</button><button class="btn btn-primary" onclick="requestInstructionVerification('${id}')">Request verification</button></div>`;
    }else if(v.status==='pending'){
      body = `<p class="modal-lead">Verification requested. Reference:</p>
        <p class="mono" style="font-size:1.15rem; font-weight:700; margin-top:6px;">${esc(v.ref)}</p>
        <p style="font-size:.85rem; color:var(--ink-soft); margin-top:12px;">Awaiting executor review of the submitted certificate. Prototype: use the buttons below to simulate the outcome.</p>`;
      foot = `<button class="btn btn-danger" onclick="resolveInstructionVerification('${id}',false)">Reject</button><div class="r"><button class="btn btn-ghost" onclick="closeModal()">Close</button><button class="btn btn-primary" onclick="resolveInstructionVerification('${id}',true)">Approve &amp; release</button></div>`;
    }else{
      body = `<p class="modal-lead">Verified. Reference <span class="mono">${esc(v.ref)}</span>.</p><p style="font-size:.85rem; color:var(--ink-soft); margin-top:8px;">This instruction is fulfilled — ${benef?esc(benef.name):'the assigned beneficiary'} has been granted the access it specifies.</p>`;
      foot = `<span></span><button class="btn btn-ghost" onclick="closeModal()">Close</button>`;
    }
  } else if(i.trigger === 'Manual release by executor'){
    if(!benef){
      body = `<p class="modal-lead">This instruction has no executor assigned. Edit the instruction and assign a beneficiary to act as executor first.</p>`;
      foot = `<span></span><button class="btn btn-ghost" onclick="closeModal()">Close</button>`;
    }else if(v.status==='not_started' || v.status==='rejected'){
      body = `<p class="modal-lead">${v.status==='rejected' ? 'The previous request was declined. ' : ''}Send an approval request to <strong style="color:var(--ink)">${esc(benef.name)}</strong> (${esc(benef.relationship)}) to release this instruction.</p>`;
      foot = `<span></span><div class="r"><button class="btn btn-ghost" onclick="closeModal()">Close</button><button class="btn btn-primary" onclick="requestInstructionVerification('${id}')">Send approval request</button></div>`;
    }else if(v.status==='pending'){
      body = `<p class="modal-lead">Awaiting confirmation from <strong style="color:var(--ink)">${esc(benef.name)}</strong>.</p><p style="font-size:.85rem; color:var(--ink-soft); margin-top:8px;">Prototype: simulate their response below.</p>`;
      foot = `<button class="btn btn-danger" onclick="resolveInstructionVerification('${id}',false)">Simulate decline</button><div class="r"><button class="btn btn-ghost" onclick="closeModal()">Close</button><button class="btn btn-primary" onclick="resolveInstructionVerification('${id}',true)">Simulate approval</button></div>`;
    }else{
      body = `<p class="modal-lead">${esc(benef.name)} approved this release.</p>`;
      foot = `<span></span><button class="btn btn-ghost" onclick="closeModal()">Close</button>`;
    }
  } else { // Inactivity period
    const loginEntry = state.auditLog.find(e => e.action==='Logged in' || e.action==='Verified email via OTP');
    const lastLoginTs = loginEntry ? loginEntry.ts : Date.now();
    const simulatedExtra = v.simulatedDays || 0;
    const daysSince = Math.floor((Date.now() - lastLoginTs)/86400000) + simulatedExtra;
    const required = state.security.inactivityDays;
    const pct = Math.max(0, Math.min(100, Math.round(daysSince/required*100)));
    const met = daysSince >= required;
    body = `
      <p class="modal-lead">Releases automatically once your vault sees ${required} days of inactivity.</p>
      <div style="margin:16px 0;">
        <div class="rl-bar" style="background:var(--surface-2); height:8px;"><i style="display:block; height:100%; width:${pct}%; background:${met?'var(--success)':'var(--accent)'}; border-radius:99px;"></i></div>
        <div style="display:flex; justify-content:space-between; margin-top:8px; font-size:.8rem; color:var(--muted);"><span>${daysSince} days since last login</span><span>${required} days required</span></div>
      </div>
      ${met
        ? '<p style="font-size:.85rem; color:var(--success); font-weight:600;">Condition met — ready to release.</p>'
        : `<div class="field"><label>Prototype only — simulate additional days of inactivity</label><input type="number" min="0" id="simDays_${id}" placeholder="e.g. 30" value="${simulatedExtra||''}"></div>`}
    `;
    foot = met
      ? `<span></span><div class="r"><button class="btn btn-ghost" onclick="closeModal()">Close</button><button class="btn btn-primary" onclick="resolveInstructionVerification('${id}',true)">Confirm &amp; release</button></div>`
      : `<span></span><div class="r"><button class="btn btn-ghost" onclick="closeModal()">Close</button><button class="btn btn-primary" onclick="applySimulatedInactivity('${id}')">Apply simulation</button></div>`;
  }

  modalShell('Verify trigger — ' + i.title, body, foot);
}
async function requestInstructionVerification(id){
  try{
    const { instruction } = await api.requestInstructionVerification(id);
    const i = state.instructions.find(x=>x.id===id);
    if(i) Object.assign(i, instruction);
    await refreshAudit();
    renderWill(); openInstructionVerifyModal(id);
  }catch(e){
    toast(e.message || 'Could not request verification.');
  }
}
async function resolveInstructionVerification(id, approved){
  try{
    const { instruction } = await api.resolveInstructionVerification(id, approved);
    const i = state.instructions.find(x=>x.id===id);
    if(i) Object.assign(i, instruction);
    await refreshAudit();
    closeModal(); renderWill(); renderDashboard();
    toast(approved ? 'Instruction fulfilled.' : 'Verification rejected.');
  }catch(e){
    toast(e.message || 'Could not update verification.');
  }
}
async function applySimulatedInactivity(id){
  const input = document.getElementById('simDays_'+id);
  const val = input ? Math.max(0, Number(input.value)||0) : 0;
  try{
    const { instruction } = await api.simulateInactivity(id, val);
    const i = state.instructions.find(x=>x.id===id);
    if(i) Object.assign(i, instruction);
    openInstructionVerifyModal(id);
  }catch(e){
    toast(e.message || 'Could not update the simulation.');
  }
}

/* ---------- audit log ---------- */
let auditFilter='all';
function setAuditFilter(f){ auditFilter=f; renderAudit(); }
function renderAudit(){
  const chipsHost = document.getElementById('auditFilterChips');
  const statuses = ['all','success','info','warning','critical'];
  chipsHost.innerHTML = statuses.map(s=>`<button class="chip ${auditFilter===s?'active':''}" onclick="setAuditFilter('${s}')">${s==='all'?'All':s[0].toUpperCase()+s.slice(1)} · ${s==='all'?state.auditLog.length:state.auditLog.filter(e=>e.status===s).length}</button>`).join('');
  let rows = state.auditLog;
  if(auditFilter!=='all') rows = rows.filter(e=>e.status===auditFilter);
  document.getElementById('auditTableBody').innerHTML = rows.map(e=>`
    <tr>
      <td class="mono" style="font-size:.8rem; white-space:nowrap;">${fmtDate(e.ts)}</td>
      <td>${esc(e.actor)}</td>
      <td class="cell-main" style="font-weight:600;">${esc(e.action)}</td>
      <td style="color:var(--ink-soft); font-size:.85rem;">${esc(e.detail)}</td>
      <td>${statusBadge(e.status.charAt(0).toUpperCase()+e.status.slice(1))}</td>
    </tr>`).join('');
}
async function exportAuditLog(){
  const rows = [['Timestamp','Actor','Action','Detail','Status']].concat(state.auditLog.map(e=>[fmtDate(e.ts), e.actor, e.action, e.detail, e.status]));
  const csv = rows.map(r => r.map(v => '"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');
  try{
    const downloads = (window.claude && window.claude.use) ? await window.claude.use('downloads') : null;
    if(downloads){
      await downloads.save({ filename:'digital-legacy-audit-log.csv', data:new Blob([csv], {type:'text/csv'}) });
    }else{
      const blob = new Blob([csv], {type:'text/csv'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'digital-legacy-audit-log.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url), 1000);
    }
    toast('Audit log exported.');
  }catch(e){
    if(e && e.code==='declined') return;
    toast('Export isn’t available in this preview.');
  }
}

/* ---------- security ---------- */
function renderSecurity(){
  clearFieldErrors('cpCurrent', 'cpNew', 'cpConfirm');
  document.getElementById('switch2fa').classList.toggle('on', state.security.twoFA);
  document.getElementById('switchAlerts').classList.toggle('on', state.security.alerts);
  document.getElementById('switchBio').classList.toggle('on', state.security.bio);
  document.getElementById('inactivitySlider').value = state.security.inactivityDays;
  document.getElementById('inactivityVal').textContent = state.security.inactivityDays+' days';
  const pwEl = document.getElementById('pwLastChanged');
  if(pwEl){
    pwEl.textContent = state.security.passwordLastChangedTs
      ? 'Last changed '+timeAgo(state.security.passwordLastChangedTs)+'.'
      : 'Not changed this session.';
  }
  const host = document.getElementById('sessionList');
  host.innerHTML = state.sessions.map(s=>`
    <div class="session-row">
      <div class="si"><svg class="icon"><use href="#i-fingerprint"/></svg></div>
      <div style="flex:1; min-width:0;">
        <div style="font-size:.87rem; font-weight:600;">${esc(s.device)} ${s.current?'<span class="badge badge-success" style="margin-left:6px;"><span class="dot" style="background:currentColor"></span>This device</span>':''}</div>
        <div style="font-size:.78rem; color:var(--muted); margin-top:2px;">${esc(s.location)} · ${timeAgo(s.ts)}</div>
      </div>
      ${s.current ? '' : `<button class="btn btn-ghost btn-sm" onclick="revokeSession('${s.id}')">Sign out</button>`}
    </div>`).join('');
}
async function toggleSwitch(elId, label){
  const map = { switchAlerts:'alerts', switchBio:'bio' };
  const key = map[elId];
  try{
    const { security } = await api.toggleSecurity(key);
    state.security = security;
    document.getElementById(elId).classList.toggle('on', state.security[key]);
    await refreshAudit();
    renderDashboard();
    toast(label+' '+(state.security[key]?'enabled.':'disabled.'));
  }catch(e){
    toast(e.message || 'Could not update setting.');
  }
}
function onInactivityChange(val){ document.getElementById('inactivityVal').textContent = val+' days'; }
document.addEventListener('change', async function(e){
  if(e.target && e.target.id==='inactivitySlider'){
    const days = Number(e.target.value);
    try{
      const { security } = await api.setInactivityDays(days);
      state.security = security;
      await refreshAudit();
    }catch(err){
      toast(err.message || 'Could not update inactivity trigger.');
      renderSecurity(); // revert the slider to the last known-good server value
    }
  }
});
async function revokeSession(id){
  try{
    await api.revokeSession(id);
    state.sessions = state.sessions.filter(x=>x.id!==id);
    await refreshAudit();
    renderSecurity(); toast('Session signed out.');
  }catch(e){
    toast(e.message || 'Could not sign out that session.');
  }
}

/* ---------- two-factor authentication ---------- */
function on2faToggleClick(){
  if(state.security.twoFA){
    confirmAction('Turn off two-factor authentication? Your account will rely on your password alone.', async () => {
      try{
        const { security } = await api.disable2fa();
        state.security = security;
        document.getElementById('switch2fa').classList.toggle('on', false);
        await refreshAudit();
        closeModal(); renderDashboard();
        toast('Two-factor authentication disabled.');
      }catch(e){
        toast(e.message || 'Could not disable two-factor authentication.');
      }
    });
  }else{
    open2faSetupModal();
  }
}
function fakeSecretKey(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ234567';
  let out = '';
  for(let i=0;i<16;i++){
    out += chars[Math.floor(Math.random()*chars.length)];
    if(i%4===3 && i!==15) out += ' ';
  }
  return out;
}
function qrPlaceholderSvg(){
  // Decorative, non-scannable QR-style pattern — not a real code, just visual flavor.
  let seed = 42;
  const rand = () => { seed = (seed*1103515245 + 12345) % 2147483648; return (seed/2147483648); };
  const cells = 9;
  const size = 132, pad = 6, cell = (size - pad*2)/cells;
  // 3x3 finder-square outline used in the corners, drawn as a fixed 3x3 mini-pattern.
  const finder = [[1,1,1],[1,0,1],[1,1,1]];
  const isFinderCell = (r,c) => (r<3&&c<3) || (r<3&&c>=cells-3) || (r>=cells-3&&c<3);
  const finderOn = (r,c) => {
    const fr = r<3 ? r : r-(cells-3);
    const fc = c<3 ? c : c-(cells-3);
    return finder[fr][fc] === 1;
  };
  let rects = '';
  for(let r=0;r<cells;r++){
    for(let c=0;c<cells;c++){
      const on = isFinderCell(r,c) ? finderOn(r,c) : rand() > 0.52;
      if(on){
        rects += `<rect x="${(pad+c*cell).toFixed(1)}" y="${(pad+r*cell).toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" fill="var(--ink)"/>`;
      }
    }
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="display:block;">
    <rect x="0" y="0" width="${size}" height="${size}" fill="var(--surface)"/>
    ${rects}
  </svg>`;
}
async function open2faSetupModal(){
  const scope = '2fa_setup';
  let devOtp = '';
  try{
    devOtp = (await api.setup2fa()).devOtp;
  }catch(e){
    toast(e.message || 'Could not start two-factor setup.');
    return;
  }
  const secret = fakeSecretKey();
  modalShell('Set up two-factor authentication', `
    <p class="modal-lead">Scan this code with an authenticator app (or just note the key), then enter the 6-digit code it generates to confirm setup.</p>
    <div style="display:flex; gap:16px; align-items:flex-start; margin-top:14px; flex-wrap:wrap;">
      <div style="border:1px solid var(--line); border-radius:12px; padding:10px; background:var(--surface);">${qrPlaceholderSvg()}</div>
      <div style="flex:1; min-width:180px;">
        <div style="font-size:.75rem; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; margin-bottom:6px;">Setup key</div>
        <div class="mono" style="font-size:.92rem; background:var(--surface); border:1px solid var(--line); border-radius:8px; padding:8px 10px; word-break:break-all;">${secret}</div>
        <div style="font-size:.78rem; color:var(--ink-soft); margin-top:10px;">Prototype demo — this QR code and key aren't linked to a real authenticator.</div>
      </div>
    </div>
    <div style="margin-top:18px;">
      ${otpBoxesHTML(scope)}
      <div id="otp_err_${scope}" class="auth-error" hidden><svg class="icon"><use href="#i-alert"/></svg><span></span></div>
      <div class="auth-demo" style="margin-top:16px;"><svg class="icon"><use href="#i-key"/></svg><span>Prototype demo — code: <b class="mono" id="otp_demo_${scope}">000000</b></span></div>
    </div>
  `, `
    <button class="btn btn-ghost btn-sm" id="otp_resend_${scope}" onclick="otpResend('${scope}')">Resend code<span id="otp_timer_${scope}" class="mono"></span></button>
    <div class="r"><button class="btn btn-ghost" onclick="otpCancel('${scope}'); closeModal()">Cancel</button><button class="btn btn-primary" onclick="otpAttemptVerify('${scope}')">Confirm & enable</button></div>
  `);
  otpStart(scope, devOtp,
    (code) => api.confirm2fa(code),
    async () => (await api.setup2fa()).devOtp,
    async ({ security }) => {
      state.security = security;
      document.getElementById('switch2fa').classList.toggle('on', true);
      await refreshAudit();
      closeModal(); renderDashboard();
      toast('Two-factor authentication enabled.');
    });
}

/* ---------- change password ---------- */
async function changePassword(){
  clearFieldErrors('cpCurrent', 'cpNew', 'cpConfirm');
  const cur = document.getElementById('cpCurrent').value;
  const p1 = document.getElementById('cpNew').value;
  const p2 = document.getElementById('cpConfirm').value;
  let firstInvalid = null;
  if(!cur){
    setFieldError('cpCurrent', 'Enter your current password.');
    firstInvalid = firstInvalid || 'cpCurrent';
  }
  if(p1.length<4){
    setFieldError('cpNew', 'New password must be at least 4 characters.');
    firstInvalid = firstInvalid || 'cpNew';
  }else if(p1 !== p2){
    setFieldError('cpConfirm', 'New passwords don’t match.');
    firstInvalid = firstInvalid || 'cpConfirm';
  }
  if(firstInvalid){ document.getElementById(firstInvalid).focus(); return; }
  try{
    const { security } = await api.changePassword(cur, p1);
    state.security = security;
    document.getElementById('cpCurrent').value = '';
    document.getElementById('cpNew').value = '';
    document.getElementById('cpConfirm').value = '';
    await refreshAudit();
    renderSecurity();
    toast('Password changed.');
  }catch(e){
    setFieldError('cpCurrent', e.message);
    document.getElementById('cpCurrent').focus();
  }
}

/* ---------- generic modal ---------- */
function closeModal(){ document.getElementById('modalHost').innerHTML = ''; }
function modalShell(title, bodyHtml, footHtml){
  document.getElementById('modalHost').innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this) closeModal()">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head"><h3>${esc(title)}</h3><button class="btn-icon" onclick="closeModal()"><svg class="icon"><use href="#i-x"/></svg></button></div>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-foot">${footHtml}</div>
      </div>
    </div>`;
}
function beneficiaryOptions(selected){
  const opts = ['<option value="">Unassigned</option>'].concat(
    state.beneficiaries.map(b=>`<option value="${b.id}" ${b.id===selected?'selected':''}>${esc(b.name)} — ${esc(b.relationship)}</option>`)
  );
  return opts.join('');
}
function confirmAction(message, onConfirm){
  window.__confirmCb = onConfirm;
  modalShell('Please confirm', `<p style="font-size:.92rem; color:var(--ink-soft); line-height:1.55;">${message}</p>`,
    `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-danger" onclick="window.__confirmCb && window.__confirmCb()">Confirm</button>`);
}

/* ---------- asset modal ---------- */
function openAssetModal(id){
  const a = id ? state.assets.find(x=>x.id===id) : null;
  const catOpts = CATEGORIES.map(c=>`<option value="${c.key}" ${a&&a.category===c.key?'selected':''}>${esc(c.label)}</option>`).join('');
  const actOpts = ACTIONS.map(x=>`<option ${a&&a.action===x?'selected':''}>${esc(x)}</option>`).join('');
  modalShell(a ? 'Edit asset' : 'Add digital asset', `
    <div class="field"><label>Asset name</label><input id="fAssetName" maxlength="60" placeholder="e.g. Personal Gmail" value="${a?esc(a.name):''}"></div>
    <div class="field-row">
      <div class="field"><label>Category</label><select id="fAssetCat" onchange="onAssetCategoryChange()">${catOpts}</select></div>
      <div class="field"><label>Status</label><select id="fAssetStatus"><option ${a&&a.status==='Active'?'selected':''}>Active</option><option ${a&&a.status==='Pending Review'?'selected':''}>Pending Review</option></select></div>
    </div>
    <div class="field"><label id="fAssetIdentLabel">Account reference / identifier</label><input id="fAssetIdent" maxlength="100" placeholder="e.g. handle, account no., or file location" value="${a?esc(a.identifier):''}"></div>
    <div class="field"><label>Assign beneficiary</label><select id="fAssetBenef">${beneficiaryOptions(a?a.beneficiaryId:null)}</select></div>
    <div class="field"><label>Action on trigger</label><select id="fAssetAction">${actOpts}</select></div>
  `, `
    ${a?`<button class="btn btn-danger" onclick="confirmAction('Remove &ldquo;${esc(a.name)}&rdquo; from your vault?', () => deleteAsset('${a.id}'))">Delete</button>`:'<span></span>'}
    <div class="r"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveAsset(${a?`'${a.id}'`:'null'})">${a?'Save changes':'Add asset'}</button></div>
  `);
  document.getElementById('fAssetName').focus();
  onAssetCategoryChange();
}
function onAssetCategoryChange(){
  const cat = document.getElementById('fAssetCat').value;
  const label = document.getElementById('fAssetIdentLabel');
  const input = document.getElementById('fAssetIdent');
  if(!label || !input) return;
  if(cat==='email'){
    label.textContent = 'Email address';
    input.type = 'email';
    input.placeholder = 'name@example.com';
  }else{
    label.textContent = 'Account reference / identifier';
    input.type = 'text';
    input.placeholder = 'e.g. handle, account no., or file location';
  }
}
async function saveAsset(id){
  clearFieldErrors('fAssetName', 'fAssetIdent');
  const name = document.getElementById('fAssetName').value.trim();
  const category = document.getElementById('fAssetCat').value;
  const identifier = document.getElementById('fAssetIdent').value.trim();
  let firstInvalid = null;
  if(!name){
    setFieldError('fAssetName', 'Give the asset a name first.');
    firstInvalid = firstInvalid || 'fAssetName';
  }
  if(!identifier){
    setFieldError('fAssetIdent', category==='email' ? 'Enter an email address.' : 'Enter an account reference or identifier.');
    firstInvalid = firstInvalid || 'fAssetIdent';
  }else if(category==='email' && !isValidEmail(identifier)){
    setFieldError('fAssetIdent', 'Enter a valid email address (e.g. name@example.com).');
    firstInvalid = firstInvalid || 'fAssetIdent';
  }
  if(firstInvalid){ document.getElementById(firstInvalid).focus(); return; }
  const data = {
    name,
    category,
    status: document.getElementById('fAssetStatus').value,
    identifier,
    beneficiaryId: document.getElementById('fAssetBenef').value || null,
    action: document.getElementById('fAssetAction').value,
  };
  try{
    if(id){
      const { asset } = await api.updateAsset(id, data);
      Object.assign(state.assets.find(a=>a.id===id), asset);
      toast('Asset updated.');
    }else{
      const { asset } = await api.createAsset(data);
      state.assets.push(asset);
      toast('Asset added to vault.');
    }
    await refreshAudit();
    closeModal(); renderVault(); renderDashboard();
  }catch(e){
    const fieldMap = { name:'fAssetName', identifier:'fAssetIdent' };
    if(e.field && fieldMap[e.field]){
      setFieldError(fieldMap[e.field], e.message);
      document.getElementById(fieldMap[e.field]).focus();
    }else{
      toast(e.message || 'Could not save asset.');
    }
  }
}

/* ---------- beneficiary modal ---------- */
function openBeneficiaryModal(id){
  const b = id ? state.beneficiaries.find(x=>x.id===id) : null;
  modalShell(b?'Edit beneficiary':'Add beneficiary', `
    <div class="field"><label>Full name</label><input id="fBName" maxlength="60" placeholder="e.g. Ravi Kapoor" value="${b?esc(b.name):''}"></div>
    <div class="field-row">
      <div class="field"><label>Relationship</label><input id="fBRel" maxlength="40" placeholder="e.g. Spouse, Sibling, Executor" value="${b?esc(b.relationship):''}"></div>
      <div class="field"><label>Trust level</label><select id="fBTrust"><option ${b&&b.trust==='Primary'?'selected':''}>Primary</option><option ${b&&b.trust==='Secondary'?'selected':''}>Secondary</option></select></div>
    </div>
    <div class="field"><label>Email address</label><input id="fBContact" type="email" maxlength="100" placeholder="name@email.com" value="${b?esc(b.contact):''}"></div>
    ${b ? `<p style="font-size:.8rem; color:var(--ink-soft); margin-top:-4px;">Verification is handled by the real code-based check in the beneficiaries table — changing the email will require re-verification.</p>` : ''}
  `, `
    ${b?`<button class="btn btn-danger" onclick="confirmAction('Remove &ldquo;${esc(b.name)}&rdquo; as a beneficiary?', () => deleteBeneficiary('${b.id}'))">Delete</button>`:'<span></span>'}
    <div class="r"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveBeneficiary(${b?`'${b.id}'`:'null'})">${b?'Save changes':'Add beneficiary'}</button></div>
  `);
  document.getElementById('fBName').focus();
}
async function saveBeneficiary(id){
  clearFieldErrors('fBName', 'fBContact');
  const name = document.getElementById('fBName').value.trim();
  const contact = document.getElementById('fBContact').value.trim();
  let firstInvalid = null;
  if(!name){
    setFieldError('fBName', 'Give the beneficiary a name first.');
    firstInvalid = firstInvalid || 'fBName';
  }
  if(!contact){
    setFieldError('fBContact', 'Enter an email address.');
    firstInvalid = firstInvalid || 'fBContact';
  }else if(!isValidEmail(contact)){
    setFieldError('fBContact', 'Enter a valid email address (e.g. name@example.com).');
    firstInvalid = firstInvalid || 'fBContact';
  }
  if(firstInvalid){ document.getElementById(firstInvalid).focus(); return; }
  const data = {
    name,
    relationship: document.getElementById('fBRel').value.trim() || 'Not specified',
    trust: document.getElementById('fBTrust').value,
    contact,
  };
  try{
    if(id){
      const { beneficiary, emailChanged } = await api.updateBeneficiary(id, data);
      Object.assign(state.beneficiaries.find(b=>b.id===id), beneficiary);
      toast(emailChanged ? 'Email changed — re-verification required.' : 'Beneficiary updated.');
    }else{
      const { beneficiary } = await api.createBeneficiary(data);
      state.beneficiaries.push(beneficiary);
      toast('Beneficiary added.');
    }
    await refreshAudit();
    closeModal(); renderBeneficiaries(); renderDashboard();
  }catch(e){
    const fieldMap = { name:'fBName', contact:'fBContact' };
    if(e.field && fieldMap[e.field]){
      setFieldError(fieldMap[e.field], e.message);
      document.getElementById(fieldMap[e.field]).focus();
    }else{
      toast(e.message || 'Could not save beneficiary.');
    }
  }
}

/* ---------- instruction modal ---------- */
function openInstructionModal(id){
  const i = id ? state.instructions.find(x=>x.id===id) : null;
  const trigOpts = TRIGGERS.map(t=>`<option ${i&&i.trigger===t?'selected':''}>${esc(t)}</option>`).join('');
  modalShell(i?'Edit instruction':'New digital will instruction', `
    <div class="field"><label>Instruction title</label><input id="fIName" maxlength="80" placeholder="e.g. Transfer social accounts to Sanjana" value="${i?esc(i.title):''}"></div>
    <div class="field-row">
      <div class="field"><label>Trigger condition</label><select id="fITrig">${trigOpts}</select></div>
      <div class="field"><label>Status</label><select id="fIStatus"><option ${i&&i.status==='Draft'?'selected':''}>Draft</option><option ${i&&i.status==='Active'?'selected':''}>Active</option><option ${i&&i.status==='Fulfilled'?'selected':''}>Fulfilled</option></select></div>
    </div>
    <div class="field"><label>Beneficiary</label><select id="fIBenef">${beneficiaryOptions(i?i.beneficiaryId:null)}</select></div>
    <div class="field"><label>Details</label><textarea id="fIDetails" maxlength="400" placeholder="What should happen, and how it should be verified">${i?esc(i.details):''}</textarea></div>
  `, `
    ${i?`<button class="btn btn-danger" onclick="confirmAction('Delete instruction &ldquo;${esc(i.title)}&rdquo;?', () => deleteInstruction('${i.id}'))">Delete</button>`:'<span></span>'}
    <div class="r"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveInstruction(${i?`'${i.id}'`:'null'})">${i?'Save changes':'Create instruction'}</button></div>
  `);
  document.getElementById('fIName').focus();
}
async function saveInstruction(id){
  clearFieldErrors('fIName', 'fIBenef');
  const title = document.getElementById('fIName').value.trim();
  const trigger = document.getElementById('fITrig').value;
  const beneficiaryId = document.getElementById('fIBenef').value || null;
  let firstInvalid = null;
  if(!title){
    setFieldError('fIName', 'Give the instruction a title first.');
    firstInvalid = firstInvalid || 'fIName';
  }
  if(!beneficiaryId && (trigger==='Manual release by executor' || trigger==='Verified death certificate')){
    setFieldError('fIBenef', 'This trigger needs a beneficiary assigned to release to.');
    firstInvalid = firstInvalid || 'fIBenef';
  }
  if(firstInvalid){ document.getElementById(firstInvalid).focus(); return; }
  const data = {
    title,
    trigger,
    status: document.getElementById('fIStatus').value,
    beneficiaryId,
    details: document.getElementById('fIDetails').value.trim(),
  };
  try{
    if(id){
      const { instruction } = await api.updateInstruction(id, data);
      Object.assign(state.instructions.find(x=>x.id===id), instruction);
      toast('Instruction updated.');
    }else{
      const { instruction } = await api.createInstruction(data);
      state.instructions.push(instruction);
      toast('Instruction created.');
    }
    await refreshAudit();
    closeModal(); renderWill(); renderDashboard();
  }catch(e){
    const fieldMap = { title:'fIName', beneficiaryId:'fIBenef' };
    if(e.field && fieldMap[e.field]){
      setFieldError(fieldMap[e.field], e.message);
      document.getElementById(fieldMap[e.field]).focus();
    }else{
      toast(e.message || 'Could not save instruction.');
    }
  }
}

/* ---------- message modal ---------- */
function openMessageModal(id){
  const m = id ? state.messages.find(x=>x.id===id) : null;
  const condOpts = TRIGGERS.map(t=>`<option ${m&&m.condition===t?'selected':''}>${esc(t)}</option>`).join('');
  modalShell(m?'Edit legacy message':'Schedule a legacy message', `
    <div class="field"><label>Subject</label><input id="fMSubject" maxlength="80" placeholder="e.g. For Ravi, whenever you need this" value="${m?esc(m.subject):''}"></div>
    <div class="field-row">
      <div class="field"><label>To (beneficiary)</label><select id="fMTo">${beneficiaryOptions(m?m.to:null)}</select></div>
      <div class="field"><label>Release condition</label><select id="fMCond">${condOpts}</select></div>
    </div>
    <div class="field"><label>Message</label><textarea id="fMBody" maxlength="600" placeholder="Write what you'd like them to read">${m?esc(m.body):''}</textarea></div>
  `, `
    ${m?`<button class="btn btn-danger" onclick="confirmAction('Delete message &ldquo;${esc(m.subject)}&rdquo;?', () => deleteMessage('${m.id}'))">Delete</button>`:'<span></span>'}
    <div class="r"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveMessage(${m?`'${m.id}'`:'null'})">${m?'Save changes':'Schedule message'}</button></div>
  `);
  document.getElementById('fMSubject').focus();
}
async function saveMessage(id){
  clearFieldErrors('fMSubject', 'fMTo', 'fMBody');
  const subject = document.getElementById('fMSubject').value.trim();
  const to = document.getElementById('fMTo').value || null;
  const body = document.getElementById('fMBody').value.trim();
  let firstInvalid = null;
  if(!subject){
    setFieldError('fMSubject', 'Give the message a subject first.');
    firstInvalid = firstInvalid || 'fMSubject';
  }
  if(!to){
    setFieldError('fMTo', 'Choose who this message is for.');
    firstInvalid = firstInvalid || 'fMTo';
  }
  if(!body){
    setFieldError('fMBody', 'Write the message before scheduling it.');
    firstInvalid = firstInvalid || 'fMBody';
  }
  if(firstInvalid){ document.getElementById(firstInvalid).focus(); return; }
  const data = { subject, to, condition: document.getElementById('fMCond').value, body };
  try{
    if(id){
      const { message } = await api.updateMessage(id, data);
      Object.assign(state.messages.find(x=>x.id===id), message);
      toast('Message updated.');
    }else{
      const { message } = await api.createMessage(data);
      state.messages.push(message);
      toast('Message scheduled.');
    }
    await refreshAudit();
    closeModal(); renderWill(); renderDashboard();
  }catch(e){
    const fieldMap = { subject:'fMSubject', to:'fMTo', body:'fMBody' };
    if(e.field && fieldMap[e.field]){
      setFieldError(fieldMap[e.field], e.message);
      document.getElementById(fieldMap[e.field]).focus();
    }else{
      toast(e.message || 'Could not save message.');
    }
  }
}

/* ---------- theme ---------- */
function setTheme(mode){
  document.documentElement.setAttribute('data-theme', mode);
  try{ localStorage.setItem(LS_THEME, mode); }catch(e){}
  document.getElementById('themeBtnLight').classList.toggle('active', mode==='light');
  document.getElementById('themeBtnDark').classList.toggle('active', mode==='dark');
}
function initTheme(){
  let saved = null;
  try{ saved = localStorage.getItem(LS_THEME); }catch(e){}
  if(saved==='light' || saved==='dark') setTheme(saved);
}

/* ---------- boot ---------- */
document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeModal(); });
initTheme();
(async () => {
  const restored = await bootstrapSession();
  if(restored) enterApp();
})();
