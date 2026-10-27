/* Studio Của Khang – khóa ứng dụng bằng mã PIN (tái sử dụng được).
 * Cách dùng: đặt <script src="js/lock.js"></script> trong <head>, TRƯỚC mọi nội dung.
 * Tuỳ chọn trên thẻ script: data-ns="studio" (khóa dùng chung cho các trang cùng ns),
 *   data-title="Studio Của Khang", data-icon="icons/icon-192.png".
 * Nút bất kỳ có [data-lock-now] sẽ khóa ngay; [data-lock-settings] mở cài đặt khóa.
 * API: window.StudioLock = { ready, lock(), openSettings(), isLocked(), onUnlock(fn), resetLock() }
 * Chỉ lưu mã băm PBKDF2 (SHA-256) + muối trong localStorage, không bao giờ lưu mã PIN.
 */
(function () {
  'use strict';
  if (window.StudioLock) return;
  const me = document.currentScript || {};
  const ds = (me.dataset || {});
  const NS = (ds.ns || 'studio').replace(/[^\w-]/g, '');
  const TITLE = ds.title || document.title || 'Ứng dụng';
  const ICON = ds.icon || '';
  const K = { data: NS + '-lock-v1', fail: NS + '-lock-fail', hidden: NS + '-lock-hiddenAt' };
  const ITER = 150000, MINLEN = 4, MAXLEN = 6, FREE_TRIES = 5, AUTOLOCK_MS = 5 * 60 * 1000;
  const root = document.documentElement;
  root.classList.add('sl-locked');

  /* ---------- CSS (tự chứa, dùng biến màu của app nếu có) ---------- */
  const css = `
html.sl-locked body>*:not(.sl-root){visibility:hidden!important}
html.sl-locked,html.sl-locked body{overflow:hidden!important}
.sl-root{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;align-items:center;justify-content:center;
 background:radial-gradient(120% 80% at 10% 0%,#1d2533 0%,var(--bg,#0e0e10) 60%),var(--bg,#0e0e10);color:var(--tx,#ececef);
 font:15px/1.35 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
 padding:calc(env(safe-area-inset-top,0px) + 16px) 20px calc(env(safe-area-inset-bottom,0px) + 16px);
 -webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation;overscroll-behavior:none}
.sl-root[hidden]{display:none!important}
.sl-box{width:100%;max-width:340px;display:flex;flex-direction:column;align-items:center}
.sl-logo{width:64px;height:64px;border-radius:16px;box-shadow:0 6px 20px rgba(0,0,0,.5);margin-bottom:10px}
.sl-app{font-size:13px;color:var(--tx2,#9a9aa2);margin:0 0 4px}
.sl-title{font-size:20px;font-weight:600;margin:0 0 6px;text-align:center}
.sl-msg{min-height:38px;font-size:13.5px;color:var(--tx2,#9a9aa2);text-align:center;margin:0 0 6px}
.sl-msg.err{color:#ff8a8a}
.sl-dots{display:flex;gap:14px;height:22px;align-items:center;margin:4px 0 22px}
.sl-dots i{width:14px;height:14px;border-radius:50%;border:1.6px solid #8a8a93;transition:background .1s}
.sl-dots i.on{background:var(--tx,#ececef);border-color:var(--tx,#ececef)}
.sl-dots i.opt{border-style:dashed;opacity:.55}
.sl-shake{animation:slsh .38s}
@keyframes slsh{20%,60%{transform:translateX(-9px)}40%,80%{transform:translateX(9px)}}
.sl-pad{display:grid;grid-template-columns:repeat(3,76px);gap:14px 22px;justify-content:center}
.sl-key{width:76px;height:76px;border-radius:50%;background:rgba(255,255,255,.1);color:var(--tx,#ececef);border:0;font:inherit;
 font-size:30px;font-weight:400;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1;cursor:pointer;
 touch-action:manipulation;-webkit-appearance:none;appearance:none;padding:0}
.sl-key small{font-size:9.5px;letter-spacing:2px;color:var(--tx2,#9a9aa2);margin-top:3px;font-weight:600}
.sl-key:active,.sl-key.pr{background:rgba(255,255,255,.32)}
.sl-key.fn{background:none;font-size:15px}
.sl-key.fn:active{background:rgba(255,255,255,.12)}
.sl-key:disabled{opacity:.3}
.sl-key svg{width:30px;height:30px}
.sl-row{display:flex;gap:10px;margin-top:20px;flex-wrap:wrap;justify-content:center}
.sl-btn{background:var(--bg3,#202024);color:var(--tx,#ececef);border:0;border-radius:999px;padding:10px 18px;font:inherit;font-size:14px;font-weight:600;cursor:pointer}
.sl-btn.pri{background:var(--ac2,#2f7fe0);color:#fff}
.sl-btn.danger{background:#5a2328;color:#ffb3b3}
.sl-btn:disabled{opacity:.35}
.sl-link{background:none;border:0;color:var(--ac,#5aa9ff);font:inherit;font-size:14px;padding:8px;cursor:pointer}
.sl-hint{font-size:12px;color:var(--tx2,#9a9aa2);text-align:center;margin-top:14px;max-width:320px}
.sl-set{position:fixed;inset:0;z-index:2147482000;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center;
 font:15px/1.35 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:var(--tx,#ececef)}
.sl-sheet{width:100%;max-width:520px;background:var(--bg2,#17171a);border-radius:18px 18px 0 0;padding:16px 18px calc(18px + env(safe-area-inset-bottom,0px));max-height:90vh;overflow:auto}
.sl-sheet h2{margin:0 0 12px;font-size:17px;display:flex;align-items:center;justify-content:space-between}
.sl-item{display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:var(--bg3,#202024);border:0;color:inherit;font:inherit;
 padding:13px 14px;border-radius:12px;margin-bottom:8px;cursor:pointer}
.sl-item span{flex:1}
.sl-item small{display:block;color:var(--tx2,#9a9aa2);font-size:12.5px;margin-top:2px}
.sl-item.danger{color:#ffb3b3}
.sl-sw{width:44px;height:26px;border-radius:13px;background:#3a3a42;position:relative;flex:0 0 auto;transition:background .15s}
.sl-sw::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:left .15s}
.sl-sw.on{background:#34c759}.sl-sw.on::after{left:21px}
.sl-note{font-size:12.5px;color:var(--tx2,#9a9aa2);margin:10px 2px 2px}
.sl-close{background:none;border:0;color:var(--tx2,#9a9aa2);font:inherit;font-size:14px;cursor:pointer;padding:4px 6px}
.sl-confirm{position:fixed;inset:0;z-index:2147483500;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;font:15px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--tx,#ececef)}
.sl-cbox{width:min(92vw,380px);background:var(--bg2,#17171a);border:1px solid var(--line,#2c2c31);border-radius:16px;padding:16px}
.sl-cbox h3{margin:0 0 10px;font-size:17px}.sl-cbox p{margin:0 0 12px;color:#cfcfd6;font-size:14px}
.sl-cbox .acts{display:flex;justify-content:flex-end;gap:8px}
@media (max-height:640px){.sl-key{width:64px;height:64px;font-size:26px}.sl-pad{grid-template-columns:repeat(3,64px);gap:10px 20px}.sl-logo{display:none}}
`;
  const st = document.createElement('style'); st.textContent = css; (document.head || root).appendChild(st);

  /* ---------- tiện ích ---------- */
  const te = new TextEncoder();
  const b64 = buf => btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const b64url = buf => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const rnd = n => crypto.getRandomValues(new Uint8Array(n));
  const lsGet = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
  const lsDel = k => { try { localStorage.removeItem(k); } catch (e) { } };
  const el = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const k in (attrs || {})) { const v = attrs[k]; if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'html') e.innerHTML = v; else if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v); }
    kids.flat().forEach(c => c != null && e.append(c.nodeType ? c : document.createTextNode(c)));
    return e;
  };
  const ICO = {
    del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 5H9l-6 7 6 7h12z"/><path d="M17 9l-6 6M11 9l6 6"/></svg>',
    face: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V6a2 2 0 012-2h2M16 4h2a2 2 0 012 2v2M20 16v2a2 2 0 01-2 2h-2M8 20H6a2 2 0 01-2-2v-2"/><path d="M9 9v1.5M15 9v1.5M12 9v4h-1M9.5 16c1.5 1 3.5 1 5 0"/></svg>'
  };
  const hasCrypto = !!(window.crypto && crypto.subtle && window.isSecureContext !== false);

  async function derive(pin, salt, iter) {
    const key = await crypto.subtle.importKey('raw', te.encode(pin), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
  }
  const eq = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; };
  const getData = () => { const d = lsGet(K.data); return d && d.hash && d.salt ? d : null; };
  async function savePin(pin, keep) {
    const salt = rnd(16), hash = await derive(pin, salt, ITER);
    const old = keep ? getData() : null;
    const d = { v: 1, alg: 'PBKDF2-SHA256', iter: ITER, salt: b64(salt), hash: b64(hash), len: pin.length, created: Date.now() };
    if (old && old.cred) d.cred = old.cred;
    if (!lsSet(K.data, d)) throw new Error('Không lưu được (bộ nhớ trình duyệt bị chặn hoặc đầy).');
    lsDel(K.fail);
  }
  async function checkPin(pin) {
    const d = getData(); if (!d) return false;
    return eq(await derive(pin, unb64(d.salt), d.iter || ITER), unb64(d.hash));
  }
  /* sai quá 5 lần → chờ tăng dần: 30 giây, 1, 2, 4, 8… phút (tối đa 1 giờ) */
  const failState = () => lsGet(K.fail) || { n: 0, until: 0 };
  function registerFail() {
    const f = failState(); f.n++;
    if (f.n >= FREE_TRIES) f.until = Date.now() + Math.min(3600, 30 * Math.pow(2, f.n - FREE_TRIES)) * 1000;
    lsSet(K.fail, f); return f;
  }
  const waitLeft = () => Math.max(0, failState().until - Date.now());
  const fmtWait = ms => { const s = Math.ceil(ms / 1000); return s >= 60 ? Math.floor(s / 60) + ' phút ' + String(s % 60).padStart(2, '0') + ' giây' : s + ' giây'; };

  /* ---------- Face ID / Touch ID (WebAuthn, chỉ để mở nhanh – PIN vẫn là dự phòng) ---------- */
  let bioOK = false;
  const bioReady = (async () => {
    try {
      if (!hasCrypto || !window.PublicKeyCredential || !navigator.credentials || !PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return false;
      bioOK = !!(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
    } catch (e) { bioOK = false; }
    return bioOK;
  })();
  const bioOn = () => { const d = getData(); return !!(bioOK && d && d.cred && d.cred.id); };
  async function bioEnroll() {
    const d = getData(); if (!d) throw new Error('Chưa có mã PIN');
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: rnd(32), rp: { name: TITLE, id: location.hostname },
      user: { id: rnd(16), name: NS + '-' + location.hostname, displayName: TITLE },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged', requireResidentKey: false },
      timeout: 60000, attestation: 'none'
    } });
    if (!cred) throw new Error('Đã hủy');
    const c = { id: b64url(cred.rawId) };
    try { const pk = cred.response.getPublicKey && cred.response.getPublicKey(); const alg = cred.response.getPublicKeyAlgorithm && cred.response.getPublicKeyAlgorithm(); if (pk && (alg === -7 || alg === -257)) { c.pk = b64(pk); c.alg = alg; } } catch (e) { }
    d.cred = c; lsSet(K.data, d);
  }
  function derToRaw(der) { // chữ ký ECDSA DER → r||s (64 byte) cho WebCrypto
    let p = 2; if (der[1] & 0x80) p += der[1] & 0x7f;
    const rd = () => { p++; const len = der[p++]; let v = der.slice(p, p + len); p += len; while (v.length > 32 && v[0] === 0) v = v.slice(1); const o = new Uint8Array(32); o.set(v, 32 - v.length); return o; };
    const r = rd(), s = rd(); const out = new Uint8Array(64); out.set(r); out.set(s, 32); return out;
  }
  async function bioUnlock() {
    const d = getData(); if (!d || !d.cred) throw new Error('Chưa bật');
    const challenge = rnd(32);
    const a = await navigator.credentials.get({ publicKey: {
      challenge, rpId: location.hostname, userVerification: 'required', timeout: 60000,
      allowCredentials: [{ type: 'public-key', id: unb64(d.cred.id.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((d.cred.id.length + 3) % 4)), transports: ['internal'] }]
    } });
    if (!a || b64url(a.rawId) !== d.cred.id) throw new Error('Sai thông tin');
    const r = a.response, auth = new Uint8Array(r.authenticatorData), cj = new Uint8Array(r.clientDataJSON);
    const client = JSON.parse(new TextDecoder().decode(cj));
    if (client.type !== 'webauthn.get' || client.challenge !== b64url(challenge)) throw new Error('Sai thử thách');
    if (!(auth[32] & 0x04)) throw new Error('Chưa xác minh người dùng'); // cờ UV
    if (d.cred.pk) { // kiểm tra chữ ký bằng khóa công khai đã lưu
      const sigAlg = d.cred.alg === -7 ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
      const key = await crypto.subtle.importKey('spki', unb64(d.cred.pk), sigAlg, false, ['verify']);
      const hcj = new Uint8Array(await crypto.subtle.digest('SHA-256', cj));
      const msg = new Uint8Array(auth.length + hcj.length); msg.set(auth); msg.set(hcj, auth.length);
      let sig = new Uint8Array(r.signature); if (d.cred.alg === -7) sig = derToRaw(sig);
      const ok = await crypto.subtle.verify(d.cred.alg === -7 ? { name: 'ECDSA', hash: 'SHA-256' } : sigAlg, key, sig, msg);
      if (!ok) throw new Error('Chữ ký không hợp lệ');
    }
    return true;
  }
  const bioDisable = () => { const d = getData(); if (d) { delete d.cred; lsSet(K.data, d); } };

  /* ---------- màn hình PIN ---------- */
  let locked = true, ui = null, unlockFns = [], resolveReady;
  const ready = new Promise(r => (resolveReady = r));

  /* mode: 'unlock' | 'setup' | 'change' (nhập PIN cũ → mới → xác nhận) */
  function pinScreen(mode, opts = {}) {
    if (ui) ui.remove();
    let step = mode === 'unlock' ? 'unlock' : mode === 'change' ? 'old' : 'new';
    let buf = '', first = '', busy = false, timer = 0;
    const d0 = getData();
    const fixedLen = () => step === 'unlock' || step === 'old' ? (getData() || {}).len || 0 : step === 'confirm' ? first.length : 0;
    const logo = ICON ? el('img', { class: 'sl-logo', src: ICON, alt: '' }) : null;
    const tEl = el('div', { class: 'sl-title' }), mEl = el('div', { class: 'sl-msg', role: 'status', 'aria-live': 'polite' }), dots = el('div', { class: 'sl-dots', 'aria-hidden': 'true' });
    const okKey = el('button', { class: 'sl-key fn', type: 'button', 'aria-label': 'Tiếp', onclick: () => submit() }, 'Tiếp');
    const delKey = el('button', { class: 'sl-key fn', type: 'button', 'aria-label': 'Xóa', html: ICO.del, onclick: () => back() });
    const L = ['', 'ABC', 'DEF', 'GHI', 'JKL', 'MNO', 'PQRS', 'TUV', 'WXYZ'];
    const keys = [];
    const pad = el('div', { class: 'sl-pad' });
    for (let i = 1; i <= 9; i++) { const k = el('button', { class: 'sl-key', type: 'button', 'data-d': i, 'aria-label': String(i) }, String(i), L[i - 1] ? el('small', null, L[i - 1]) : el('small', null, '\u00a0')); keys.push(k); pad.append(k); }
    const zero = el('button', { class: 'sl-key', type: 'button', 'data-d': 0, 'aria-label': '0' }, '0', el('small', null, '\u00a0')); keys.push(zero);
    pad.append(okKey, zero, delKey);
    pad.addEventListener('click', e => { const k = e.target.closest('[data-d]'); if (k) press(k.dataset.d); });
    const row = el('div', { class: 'sl-row' });
    const bioBtn = el('button', { class: 'sl-btn', type: 'button', hidden: true, html: '<span style="display:inline-flex;align-items:center;gap:6px">' + ICO.face.replace('<svg', '<svg width="20" height="20"') + 'Face ID / Touch ID</span>', onclick: () => tryBio(true) });
    const cancelBtn = el('button', { class: 'sl-link', type: 'button', hidden: !opts.cancelable, onclick: () => close(false) }, 'Hủy');
    row.append(bioBtn, cancelBtn);
    const hint = el('div', { class: 'sl-hint' });
    const box = el('div', { class: 'sl-box' }, logo, el('div', { class: 'sl-app' }, TITLE), tEl, mEl, dots, pad, row, hint);
    ui = el('div', { class: 'sl-root', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Khóa ứng dụng' }, box);
    (document.body || root).appendChild(ui);

    function render(msg, err) {
      tEl.textContent = { unlock: 'Nhập mã PIN', old: 'Nhập mã PIN hiện tại', new: mode === 'change' ? 'Đặt mã PIN mới' : 'Tạo mã PIN', confirm: 'Nhập lại mã PIN' }[step];
      const n = fixedLen();
      dots.innerHTML = '';
      for (let i = 0; i < (n || MAXLEN); i++) dots.append(el('i', { class: i < buf.length ? 'on' : (!n && i >= MINLEN) ? 'opt' : '' }));
      const def = step === 'new' ? 'Chọn 4–6 chữ số rồi bấm “Tiếp”.' : step === 'confirm' ? 'Nhập lại đúng mã vừa tạo.' : '';
      mEl.textContent = msg != null ? msg : def; mEl.classList.toggle('err', !!err);
      okKey.style.visibility = n ? 'hidden' : 'visible'; okKey.disabled = buf.length < MINLEN || busy;
      delKey.style.visibility = buf.length ? 'visible' : 'hidden';
      const w = (step === 'unlock' || step === 'old') ? waitLeft() : 0;
      keys.forEach(k => (k.disabled = busy || w > 0));
      bioBtn.hidden = !(step === 'unlock' && bioOn());
      hint.textContent = step === 'unlock' ? (bioOn() ? 'Quên mã PIN? Mở bằng Face ID / Touch ID rồi vào ⚙︎ → “Quên PIN”.' : 'Quên mã PIN? Chỉ còn cách xóa dữ liệu trang web của ứng dụng (công thức tự tạo sẽ mất).') : step === 'new' && mode === 'setup' ? 'Mã PIN chỉ lưu dạng đã băm trên máy này. Lần sau mở ứng dụng sẽ cần nhập mã.' : '';
      if (w > 0) { mEl.textContent = 'Sai quá nhiều lần. Thử lại sau ' + fmtWait(w) + '.'; mEl.classList.add('err'); clearTimeout(timer); timer = setTimeout(() => render(), 1000); }
    }
    function shake() { dots.classList.remove('sl-shake'); void dots.offsetWidth; dots.classList.add('sl-shake'); }
    function press(dg) {
      if (busy || ((step === 'unlock' || step === 'old') && waitLeft() > 0)) return;
      if (buf.length >= (fixedLen() || MAXLEN)) return;
      buf += dg; render(fixedLen() ? '' : null);
      if (fixedLen() && buf.length === fixedLen()) setTimeout(submit, 60);
    }
    function back() { if (busy) return; buf = buf.slice(0, -1); render(); }
    async function submit() {
      if (busy || buf.length < MINLEN) return;
      const pin = buf;
      if (step === 'new') { first = pin; buf = ''; step = 'confirm'; render(); return; }
      if (step === 'confirm') {
        if (pin !== first) { buf = ''; first = ''; step = 'new'; shake(); render('Hai lần nhập không khớp. Hãy tạo lại.', true); return; }
        busy = true; render('Đang lưu…');
        try { await savePin(pin, mode === 'change'); } catch (e) { busy = false; buf = ''; render(e.message || 'Không lưu được mã PIN', true); return; }
        busy = false;
        if (mode === 'setup' && (await bioReady)) { offerBio(); return; }
        close(true, mode === 'change' ? 'Đã đổi mã PIN' : null); return;
      }
      // unlock / old
      busy = true; render('Đang kiểm tra…');
      let ok = false; try { ok = await checkPin(pin); } catch (e) { ok = false; }
      busy = false; buf = '';
      if (ok) { lsDel(K.fail); if (step === 'old') { step = 'new'; render(); } else close(true); return; }
      const f = registerFail(); shake();
      const left = FREE_TRIES - f.n;
      render(left > 0 ? 'Sai mã PIN. Còn ' + left + ' lần thử trước khi phải chờ.' : 'Sai mã PIN.', true);
    }
    function offerBio() {
      tEl.textContent = 'Mở nhanh bằng Face ID / Touch ID?'; mEl.classList.remove('err');
      mEl.textContent = 'Chỉ để tiện mở nhanh. Mã PIN vẫn luôn dùng được.';
      dots.innerHTML = ''; pad.style.display = 'none'; hint.textContent = '';
      row.innerHTML = '';
      row.append(el('button', { class: 'sl-btn pri', type: 'button', onclick: async () => { try { await bioEnroll(); close(true, 'Đã bật Face ID / Touch ID'); } catch (e) { close(true, 'Chưa bật được Face ID / Touch ID – có thể bật sau trong ⚙︎'); } } }, 'Bật'), el('button', { class: 'sl-btn', type: 'button', onclick: () => close(true) }, 'Để sau'));
    }
    async function tryBio(manual) {
      if (busy || !bioOn()) return;
      busy = true; render('Đang xác minh…');
      try { await bioUnlock(); busy = false; lsDel(K.fail); close(true); }
      catch (e) { busy = false; render(manual ? 'Không xác minh được. Hãy nhập mã PIN.' : null, !!manual); }
    }
    function onKey(e) {
      if (!ui || !ui.isConnected) return;
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); press(e.key); }
      else if (e.key === 'Backspace') { e.preventDefault(); back(); }
      else if (e.key === 'Enter') { e.preventDefault(); submit(); }
      else if (e.key === 'Escape' && opts.cancelable) close(false);
    }
    document.addEventListener('keydown', onKey, true);
    function close(ok, toastMsg) {
      clearTimeout(timer); document.removeEventListener('keydown', onKey, true);
      if (ui) { ui.remove(); ui = null; }
      if (opts.done) opts.done(ok);
      if (toastMsg) toast(toastMsg);
    }
    render();
    bioReady.then(() => { if (ui && step === 'unlock') render(); });
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) { }
    return { close };
  }

  function toast(t) {
    const x = el('div', { style: 'position:fixed;left:50%;bottom:calc(120px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);background:#2a2a30;color:#fff;padding:10px 16px;border-radius:12px;font:14px -apple-system,BlinkMacSystemFont,sans-serif;z-index:2147483600;max-width:90vw;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.5)' }, t);
    document.body.append(x); setTimeout(() => x.remove(), 2600);
  }
  function confirmBox(title, text, okText, danger) {
    return new Promise(res => {
      const w = el('div', { class: 'sl-confirm' });
      const done = v => { w.remove(); res(v); };
      w.append(el('div', { class: 'sl-cbox' }, el('h3', null, title), el('p', null, text), el('div', { class: 'acts' },
        el('button', { class: 'sl-btn', type: 'button', onclick: () => done(false) }, 'Hủy'),
        el('button', { class: 'sl-btn ' + (danger ? 'danger' : 'pri'), type: 'button', onclick: () => done(true) }, okText))));
      document.body.append(w);
    });
  }

  function lock() {
    if (!getData()) return start();
    locked = true; root.classList.add('sl-locked');
    closeSettings();
    try { const v = document.querySelectorAll('video,audio'); v.forEach(m => { try { m.pause(); } catch (e) { } }); } catch (e) { }
    pinScreen('unlock', { done: ok => { if (ok) unlocked(); } });
  }
  function unlocked() {
    locked = false; root.classList.remove('sl-locked'); lsDel(K.hidden);
    resolveReady(true); unlockFns.forEach(f => { try { f(); } catch (e) { } });
  }
  function start() {
    if (!hasCrypto) { // không có WebCrypto (không phải HTTPS) → không khóa được
      const box = el('div', { class: 'sl-root' }, el('div', { class: 'sl-box' }, el('div', { class: 'sl-title' }, 'Không thể bật khóa'), el('div', { class: 'sl-msg' }, 'Trình duyệt này không hỗ trợ mã hóa (cần HTTPS). Hãy mở ứng dụng qua địa chỉ https.')));
      document.body.append(box); return;
    }
    if (getData()) lock();
    else pinScreen('setup', { done: ok => { if (ok) unlocked(); } });
  }

  /* ---------- tự khóa khi ở nền > 5 phút ---------- */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (!locked) lsSet(K.hidden, Date.now()); }
    else { const t = lsGet(K.hidden); if (!locked && t && Date.now() - t > AUTOLOCK_MS) lock(); else lsDel(K.hidden); }
  });
  window.addEventListener('pageshow', e => { if (e.persisted && !locked) { const t = lsGet(K.hidden); if (t && Date.now() - t > AUTOLOCK_MS) lock(); } });

  /* ---------- cài đặt khóa ---------- */
  let setEl = null;
  function closeSettings() { if (setEl) { setEl.remove(); setEl = null; } }
  async function openSettings() {
    if (locked) return;
    closeSettings();
    await bioReady;
    const sheet = el('div', { class: 'sl-sheet', role: 'dialog', 'aria-label': 'Khóa ứng dụng' });
    setEl = el('div', { class: 'sl-set', onclick: e => { if (e.target === setEl) closeSettings(); } }, sheet);
    const item = (title, sub, onclick, extra, cls) => el('button', { class: 'sl-item' + (cls ? ' ' + cls : ''), type: 'button', onclick }, el('span', null, title, sub ? el('small', null, sub) : null), extra || null);
    const build = () => {
      sheet.innerHTML = '';
      sheet.append(el('h2', null, 'Khóa ứng dụng', el('button', { class: 'sl-close', type: 'button', onclick: closeSettings }, 'Xong')));
      sheet.append(item('Khóa ngay', 'Hiện màn hình mã PIN ngay bây giờ', () => lock()));
      sheet.append(item('Đổi mã PIN', 'Cần nhập mã PIN hiện tại', () => { closeSettings(); pinScreen('change', { cancelable: true }); }));
      if (bioOK) {
        const sw = el('i', { class: 'sl-sw' + (bioOn() ? ' on' : '') });
        sheet.append(item('Mở bằng Face ID / Touch ID', 'Chỉ để tiện; mã PIN vẫn luôn dùng được', async () => {
          if (bioOn()) { bioDisable(); build(); toast('Đã tắt Face ID / Touch ID'); return; }
          try { await bioEnroll(); toast('Đã bật Face ID / Touch ID'); } catch (e) { toast('Chưa bật được Face ID / Touch ID'); }
          build();
        }, sw));
      }
      sheet.append(item('Quên PIN – đặt lại khóa', 'Chỉ xóa dữ liệu khóa; công thức, mô hình và preset vẫn giữ nguyên', async () => {
        const ok = await confirmBox('Đặt lại khóa?', 'Mã PIN và Face ID / Touch ID của ứng dụng trên máy này sẽ bị xóa, rồi bạn tạo mã PIN mới ngay. Ảnh, công thức tự tạo và mô hình đã tải không bị ảnh hưởng.', 'Đặt lại', true);
        if (!ok) return;
        resetLock(); closeSettings();
        locked = true; root.classList.add('sl-locked');
        pinScreen('setup', { done: ok2 => { if (ok2) { unlocked(); toast('Đã đặt mã PIN mới'); } } });
      }, null, 'danger'));
      sheet.append(el('p', { class: 'sl-note' }, 'Khóa này chỉ ngăn người khác mở ứng dụng trên máy này; mã nguồn và các tệp trên GitHub vẫn công khai.'));
    };
    build();
    document.body.append(setEl);
  }
  function resetLock() { [K.data, K.fail, K.hidden].forEach(lsDel); }

  document.addEventListener('click', e => {
    const t = e.target.closest && e.target.closest('[data-lock-now],[data-lock-settings]');
    if (!t) return;
    e.preventDefault();
    if (t.hasAttribute('data-lock-now')) lock(); else openSettings();
  });

  window.StudioLock = { ready, lock, openSettings, resetLock, isLocked: () => locked, onUnlock: f => { unlockFns.push(f); if (!locked) f(); }, ns: NS };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
