// ==UserScript==
// @name         폴리곤스캔 지갑 이름표 (커뮤니티 공용)
// @namespace    https://github.com/
// @version      1.0.0
// @description  폴리곤스캔에 뜨는 지갑 주소를 커뮤니티가 등록한 이름으로 보여주고, 그 자리에서 이름을 등록합니다. 주소 사칭도 경고합니다.
// @author       커뮤니티
// @match        https://polygonscan.com/*
// @match        https://www.polygonscan.com/*
// @icon         https://polygonscan.com/favicon.ico
// @updateURL    https://raw.githubusercontent.com/<계정>/<저장소>/main/폴리곤스캔_이름표.user.js
// @downloadURL  https://raw.githubusercontent.com/<계정>/<저장소>/main/폴리곤스캔_이름표.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      raw.githubusercontent.com
// @connect      githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

/* ============================================================
   설정 — 이 두 줄만 본인 것으로 바꾸면 됩니다.
   ============================================================ */
const LABELS_URL   = 'https://raw.githubusercontent.com/revive065-glitch/Polygone_wallet_address/refs/heads/main/labels.json';
const REGISTRY_URL = 'https://script.google.com/macros/s/AKfycbxm5VrjKDvu7cUOJhMWcBy9BsOXdQYMALAXKTBLMvxtjE3fzNDP6RMpl01fhMHY-NAS/exec';   // 구글 Apps Script 웹앱 /exec 주소
/* ============================================================ */

(function () {
  'use strict';

  const REFRESH_MS = 5 * 60 * 1000;          // 이름 목록 갱신 주기
  const RE_ADDR = /\/address\/(0x[0-9a-fA-F]{40})/;

  const TYPE_KO = {
    company: '회사 수금', company_payout: '회사 지급', community: '커뮤니티 대표',
    exchange: '거래소', otc: '환전/OTC', bridge: '브릿지', relay: '경유',
    token: '토큰', contract: '컨트랙트', scam_lookalike: '사칭 주소',
    dust: '더스트', personal: '개인', unknown: '미상'
  };
  const COLOR = {
    company: '#d95926', company_payout: '#d95926', community: '#d95926',
    exchange: '#199e70', bridge: '#199e70', token: '#199e70', contract: '#199e70',
    relay: '#9a7b2f', otc: '#9a7b2f',
    scam_lookalike: '#e04a4a', dust: '#e04a4a',
    personal: '#3987e5', unknown: '#6b7684'
  };

  let NAMES = {};        // 주소 → {name, type, conf, src}
  let PKEY = {};         // 앞4|뒤4 → [주소…]  (사칭 판정용)
  let loaded = false;

  const norm = a => String(a || '').trim().toLowerCase();
  const short = a => a.slice(0, 8) + '…' + a.slice(-6);
  const pkey = a => { a = norm(a); return a.slice(2, 6) + '|' + a.slice(-4); };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------------- 통신 ---------------- */
  function req(opts) {
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        timeout: 30000,
        ...opts,
        onload: r => res(r),
        onerror: () => rej(new Error('네트워크 오류')),
        ontimeout: () => rej(new Error('시간 초과'))
      });
    });
  }

  async function loadNames() {
    const next = {};
    // 1) 확정 라벨
    try {
      const r = await req({ method: 'GET', url: LABELS_URL + '?t=' + Date.now() });
      const j = JSON.parse(r.responseText);
      for (const a in (j.labels || {})) {
        const L = j.labels[a];
        next[norm(a)] = { name: L.name, type: L.type, conf: L.confidence || 'B', src: '확정' };
      }
      for (const a in (j.tokens || {})) {
        if (!next[norm(a)]) next[norm(a)] = { name: j.tokens[a].symbol + ' 컨트랙트', type: 'token', conf: 'A', src: '확정' };
      }
    } catch (e) { console.warn('[이름표] 라벨 불러오기 실패', e); }

    // 2) 커뮤니티 등록분 (투표 순득표 1 이상만 반영)
    if (REGISTRY_URL) {
      try {
        const r = await req({ method: 'GET', url: REGISTRY_URL });
        const j = JSON.parse(r.responseText);
        if (j && j.ok) {
          const best = {};
          (j.data.entries || []).forEach(e => {
            const v = (j.data.votes || {})[e.id] || { up: 0, down: 0 };
            const s = v.up - v.down;
            if (s >= 0 && (!best[e.address] || s > best[e.address].s)) best[e.address] = { e, s, v };
          });
          for (const a in best) {
            if (next[a] && next[a].src === '확정') continue;
            next[a] = {
              name: best[a].e.name, type: best[a].e.type,
              conf: best[a].s >= 5 ? 'B' : 'C',
              src: '제보 ' + best[a].e.reporter + ' (찬성 ' + best[a].v.up + ')'
            };
          }
        }
      } catch (e) { console.warn('[이름표] 등록소 불러오기 실패', e); }
    }

    NAMES = next;
    PKEY = {};
    for (const a in NAMES) (PKEY[pkey(a)] = PKEY[pkey(a)] || []).push(a);
    loaded = true;
    btnDone.clear();
    document.querySelectorAll('.nt-add, .nt-dot, .nt-warn').forEach(el => el.remove());
    document.querySelectorAll('[data-nt]').forEach(el => el.removeAttribute('data-nt'));
    decorate();
    updatePanel();
  }

  /* ---------------- 사칭 판정 ---------------- */
  function lookalikeOf(addr) {
    const g = PKEY[pkey(addr)];
    if (!g) return null;
    const twin = g.find(x => x !== addr && NAMES[x] &&
      NAMES[x].type !== 'scam_lookalike' && NAMES[x].type !== 'dust');
    return twin || null;
  }

  /* ---------------- 화면 덧씌우기 ---------------- */
  const btnDone = new Set();          // 같은 주소에 +이름 버튼이 여러 개 붙지 않게

  function decorate() {
    if (!loaded) return;
    const links = document.querySelectorAll('a[href*="/address/0x"]');
    for (const a of links) {
      if (a.dataset.nt) continue;
      const m = (a.getAttribute('href') || '').match(RE_ADDR);
      if (!m) continue;
      const addr = norm(m[1]);
      a.dataset.nt = '1';
      a.dataset.ntAddr = addr;

      // 원래 글자가 주소(전체/축약)일 때만 이름으로 바꿉니다.
      // 폴리곤스캔이 이미 붙여둔 라벨이나 토큰 이름은 건드리지 않습니다.
      const txt = (a.textContent || '').trim();
      const isAddrText = /^0x[0-9a-fA-F]{4,}(…|\.\.\.)?[0-9a-fA-F]*$/.test(txt.replace(/\s/g, ''));

      const info = NAMES[addr];
      const twin = info ? null : lookalikeOf(addr);

      if (info && isAddrText) {
        const bad = info.type === 'scam_lookalike' || info.type === 'dust';
        a.textContent = (bad ? '⚠ ' : '') + info.name;
        a.style.color = COLOR[info.type] || COLOR.unknown;
        a.style.fontWeight = '600';
        a.title = info.name + '\n' + addr + '\n분류: ' + (TYPE_KO[info.type] || info.type) +
                  '\n신뢰도: ' + info.conf + '등급 (추정)\n출처: ' + (info.src || '');
        a.insertAdjacentHTML('afterend',
          ' <span class="nt-dot" style="background:' + (COLOR[info.type] || COLOR.unknown) + '"></span>');
      } else if (!info) {
        if (twin) {
          a.style.color = COLOR.scam_lookalike;
          a.title = '⚠ 사칭 의심\n' + addr + '\n앞 4자리·뒤 4자리가 아래 주소와 같습니다:\n' +
                    twin + ' (' + NAMES[twin].name + ')';
          a.insertAdjacentHTML('afterend', ' <span class="nt-warn">⚠사칭?</span>');
        }
        if (isAddrText && !btnDone.has(addr)) {
          btnDone.add(addr);
          a.insertAdjacentHTML('afterend',
            ' <button class="nt-add" data-a="' + esc(addr) + '" title="이 지갑에 이름 달기">+이름</button>');
        }
      }
    }
    document.querySelectorAll('.nt-add:not([data-b])').forEach(b => {
      b.dataset.b = '1';
      b.addEventListener('click', ev => {
        ev.preventDefault(); ev.stopPropagation();
        openForm([b.getAttribute('data-a')]);
      });
    });
    banner();
  }

  /** 주소 페이지 맨 위에 "지금 보고 있는 지갑"의 이름을 크게 띄웁니다. */
  function banner() {
    const m = location.pathname.match(/^\/address\/(0x[0-9a-fA-F]{40})/);
    if (!m) return;
    const addr = norm(m[1]);
    let el = document.getElementById('nt-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'nt-banner';
      const host = document.querySelector('main') || document.body;
      host.insertBefore(el, host.firstChild);
    }
    const info = NAMES[addr];
    const twin = info ? null : lookalikeOf(addr);
    if (info) {
      const bad = info.type === 'scam_lookalike' || info.type === 'dust';
      el.style.borderColor = COLOR[info.type] || COLOR.unknown;
      el.innerHTML = '<b style="color:' + (COLOR[info.type] || COLOR.unknown) + '">' +
        (bad ? '⚠ ' : '') + esc(info.name) + '</b>' +
        '<span>' + esc(TYPE_KO[info.type] || info.type) + ' · ' + esc(info.conf) + '등급 <b>추정</b>' +
        ' · ' + esc(info.src || '') + '</span>' +
        '<button class="nt-add" data-a="' + esc(addr) + '">다른 이름 제안</button>';
    } else if (twin) {
      el.style.borderColor = COLOR.scam_lookalike;
      el.innerHTML = '<b style="color:' + COLOR.scam_lookalike + '">⚠ 사칭 의심 주소</b>' +
        '<span>앞 4자리·뒤 4자리가 <b>' + esc(NAMES[twin].name) + '</b>(' + esc(short(twin)) +
        ')와 같지만 다른 주소입니다. 여기로 송금하지 마세요.</span>' +
        '<button class="nt-add" data-a="' + esc(addr) + '">이름 달기</button>';
    } else {
      el.style.borderColor = '#39414c';
      el.innerHTML = '<b style="color:#8b8a80">이름이 등록되지 않은 지갑입니다</b>' +
        '<span>누구 지갑인지 아시면 등록해 주세요. 커뮤니티 전체 화면에 반영됩니다.</span>' +
        '<button class="nt-add" data-a="' + esc(addr) + '">이름 달기</button>';
    }
  }

  /* ---------------- 페이지 주소 모으기 ---------------- */
  function pageAddrs() {
    const out = new Set();
    document.querySelectorAll('a[href*="/address/0x"]').forEach(a => {
      const m = (a.getAttribute('href') || '').match(RE_ADDR);
      if (m) out.add(norm(m[1]));
    });
    return [...out];
  }

  /* ---------------- 등록 폼 ---------------- */
  function openForm(addrs) {
    if (!REGISTRY_URL) { alert('등록소 주소(REGISTRY_URL)가 설정되지 않았습니다.'); return; }
    const nick = GM_getValue('nick', '');
    const rows = addrs.map((a, i) => `
      <div class="nt-row">
        <div class="nt-a">${esc(short(a))}<span class="nt-full">${esc(a)}</span></div>
        <input class="nt-name" data-a="${esc(a)}" placeholder="예: OO지사 총판 / 회사 지급지갑" ${i === 0 ? 'autofocus' : ''}>
        <select class="nt-type" data-a="${esc(a)}">
          <option value="unknown">잘 모르겠음</option>
          <option value="company">회사 수금</option>
          <option value="company_payout">회사 지급</option>
          <option value="community">커뮤니티 대표</option>
          <option value="exchange">거래소</option>
          <option value="otc">환전/OTC</option>
          <option value="personal">개인</option>
          <option value="scam_lookalike">사칭 주소</option>
        </select>
      </div>`).join('');

    const wrap = document.createElement('div');
    wrap.className = 'nt-modal';
    wrap.innerHTML = `
      <div class="nt-box">
        <h3>지갑 이름 등록 <span>${addrs.length}개</span></h3>
        <p class="nt-note">실명·전화번호는 쓰지 마세요. 닉네임이나 직책만 씁니다.
           여기 등록한 이름은 커뮤니티 전체에 <b>추정</b>으로 표시됩니다.</p>
        <label>내 닉네임</label>
        <input id="nt-nick" value="${esc(nick)}" placeholder="카페 닉네임">
        <label>근거 <span class="nt-dim">— 어디서 본 주소인지 (10자 이상, 전체 공통)</span></label>
        <textarea id="nt-ev" placeholder="예: 2026-03-14 공지 캡처에 있던 입금 주소. 제 지갑에서 3번 보냈습니다."></textarea>
        <label>이름 <span class="nt-dim">— 비워두면 그 주소는 등록하지 않습니다</span></label>
        <div class="nt-rows">${rows}</div>
        <div class="nt-btns">
          <button id="nt-ok">등록</button>
          <button id="nt-cancel" class="nt-ghost">취소</button>
          <span id="nt-msg"></span>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const close = () => wrap.remove();
    wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
    wrap.querySelector('#nt-cancel').onclick = close;

    wrap.querySelector('#nt-ok').onclick = async () => {
      const msg = wrap.querySelector('#nt-msg');
      const nickV = wrap.querySelector('#nt-nick').value.trim();
      const evV = wrap.querySelector('#nt-ev').value.trim();
      if (!nickV) { msg.textContent = '닉네임을 입력해주세요.'; return; }
      if (evV.length < 10) { msg.textContent = '근거를 10자 이상 적어주세요.'; return; }
      const items = [];
      wrap.querySelectorAll('.nt-name').forEach(inp => {
        const nm = inp.value.trim();
        if (!nm) return;
        const a = inp.getAttribute('data-a');
        const ty = wrap.querySelector('.nt-type[data-a="' + a + '"]').value;
        items.push({ address: a, name: nm, type: ty });
      });
      if (!items.length) { msg.textContent = '이름을 하나 이상 적어주세요.'; return; }

      GM_setValue('nick', nickV);
      msg.textContent = '등록 중…';
      try {
        const r = await req({
          method: 'POST', url: REGISTRY_URL,
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          data: JSON.stringify({ action: 'bulk', reporter: nickV, evidence: evV, items })
        });
        const j = JSON.parse(r.responseText);
        if (j.ok) {
          msg.textContent = (j.added || items.length) + '건 등록됐습니다.';
          setTimeout(() => { close(); loadNames(); }, 900);
        } else msg.textContent = j.error || '등록 실패';
      } catch (e) { msg.textContent = '전송 실패: ' + e.message; }
    };
  }

  /* ---------------- 하단 패널 ---------------- */
  let panel;
  function updatePanel() {
    if (!panel) return;
    const all = pageAddrs();
    const unnamed = all.filter(a => !NAMES[a]);
    const bad = all.filter(a => (NAMES[a] && (NAMES[a].type === 'scam_lookalike' || NAMES[a].type === 'dust')) || (!NAMES[a] && lookalikeOf(a)));
    panel.querySelector('.nt-stat').innerHTML =
      '이름표 <b>' + (all.length - unnamed.length) + '</b>/' + all.length +
      (bad.length ? ' · <span style="color:#ff8a8a">사칭 의심 ' + bad.length + '</span>' : '');
    const btn = panel.querySelector('.nt-bulk');
    btn.textContent = unnamed.length ? '이름 없는 ' + unnamed.length + '개 한번에 등록' : '이 페이지는 모두 등록됨';
    btn.disabled = !unnamed.length;
  }

  function makePanel() {
    panel = document.createElement('div');
    panel.className = 'nt-panel';
    panel.innerHTML = `
      <span class="nt-title">지갑 이름표</span>
      <span class="nt-stat">불러오는 중…</span>
      <button class="nt-bulk">…</button>
      <button class="nt-reload" title="이름 목록 새로고침">↻</button>
      <button class="nt-hide" title="숨기기">×</button>`;
    document.body.appendChild(panel);
    panel.querySelector('.nt-bulk').onclick = () => {
      const un = pageAddrs().filter(a => !NAMES[a]);
      if (un.length) openForm(un.slice(0, 40));
    };
    panel.querySelector('.nt-reload').onclick = () => {
      panel.querySelector('.nt-stat').textContent = '새로고침 중…';
      loadNames();
    };
    panel.querySelector('.nt-hide').onclick = () => panel.remove();
  }

  /* ---------------- 스타일 ---------------- */
  GM_addStyle(`
    #nt-banner{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:10px 0;padding:10px 14px;
      border:1px solid #39414c;border-left-width:4px;border-radius:9px;background:rgba(127,127,127,.08);
      font:13px/1.5 -apple-system,"Malgun Gothic",sans-serif}
    #nt-banner b{font-size:15px}
    #nt-banner span{color:#8b8a80;font-size:12.5px}
    #nt-banner .nt-add{margin-left:auto}
    .nt-dot{display:inline-block;width:6px;height:6px;border-radius:50%;vertical-align:middle;margin-left:3px;opacity:.8}
    .nt-warn{color:#e04a4a;font-size:10px;font-weight:700;border:1px solid #e04a4a;
      border-radius:9px;padding:0 4px;margin-left:3px;white-space:nowrap}
    .nt-add{font-size:10px;line-height:1.5;padding:0 5px;margin-left:4px;cursor:pointer;
      border:1px solid #9aa5b1;border-radius:9px;background:transparent;color:#7d8794;white-space:nowrap}
    .nt-add:hover{border-color:#3987e5;color:#3987e5}
    .nt-panel{position:fixed;right:14px;bottom:14px;z-index:99999;display:flex;gap:8px;align-items:center;
      background:#1c1f24;color:#e6eaef;border:1px solid #39414c;border-radius:10px;padding:8px 12px;
      font:13px/1.4 -apple-system,"Malgun Gothic",sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35)}
    .nt-panel .nt-title{font-weight:700;color:#8fc0ff}
    .nt-panel .nt-stat{color:#aab3bf}
    .nt-panel button{font:12px/1.4 inherit;padding:4px 9px;border-radius:7px;cursor:pointer;
      border:1px solid #39414c;background:#242932;color:#e6eaef}
    .nt-panel button:hover:not(:disabled){border-color:#3987e5}
    .nt-panel button:disabled{opacity:.45;cursor:default}
    .nt-panel .nt-hide,.nt-panel .nt-reload{padding:4px 8px}
    .nt-modal{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.55);
      display:flex;align-items:center;justify-content:center;padding:20px;
      font:14px/1.6 -apple-system,"Malgun Gothic",sans-serif}
    .nt-box{background:#1c1f24;color:#e6eaef;border:1px solid #39414c;border-radius:12px;
      padding:20px;width:min(720px,100%);max-height:88vh;overflow:auto}
    .nt-box h3{margin:0 0 6px;font-size:17px}
    .nt-box h3 span{color:#8fc0ff;font-size:13px;font-weight:500}
    .nt-note{color:#aab3bf;font-size:12.5px;margin:0 0 14px}
    .nt-box label{display:block;font-size:12px;color:#aab3bf;font-weight:600;margin:12px 0 5px}
    .nt-dim{font-weight:400;color:#7d8794}
    .nt-box input,.nt-box textarea,.nt-box select{width:100%;background:#242932;border:1px solid #39414c;
      color:#e6eaef;border-radius:7px;padding:8px 10px;font:inherit;font-size:13.5px;outline:none}
    .nt-box textarea{min-height:60px;resize:vertical}
    .nt-box input:focus,.nt-box textarea:focus,.nt-box select:focus{border-color:#3987e5}
    .nt-rows{max-height:44vh;overflow:auto;margin-top:4px}
    .nt-row{display:grid;grid-template-columns:150px 1fr 130px;gap:8px;align-items:center;margin-bottom:7px}
    .nt-a{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;color:#aab3bf;position:relative}
    .nt-a .nt-full{display:none;position:absolute;left:0;top:100%;background:#0d0f12;border:1px solid #39414c;
      padding:3px 6px;border-radius:5px;white-space:nowrap;z-index:5}
    .nt-a:hover .nt-full{display:block}
    .nt-btns{display:flex;gap:10px;align-items:center;margin-top:16px}
    .nt-btns button{font:inherit;font-size:13.5px;font-weight:600;padding:8px 18px;border-radius:8px;
      border:0;background:#3987e5;color:#fff;cursor:pointer}
    .nt-btns .nt-ghost{background:transparent;border:1px solid #39414c;color:#aab3bf;font-weight:500}
    #nt-msg{color:#ffb4b4;font-size:12.5px}
    @media(max-width:640px){.nt-row{grid-template-columns:1fr}}
  `);

  /* ---------------- 시작 ---------------- */
  makePanel();
  loadNames();
  setInterval(loadNames, REFRESH_MS);

  // 폴리곤스캔은 표를 나중에 그리므로 변화를 지켜봅니다.
  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => { decorate(); updatePanel(); }, 250);
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
