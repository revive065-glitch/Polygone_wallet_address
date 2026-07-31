/* =====================================================================
   지갑 등록소 — 백엔드 (Google Apps Script)

   [설치 방법]
   1. 구글 스프레드시트를 하나 새로 만듭니다.
   2. 확장 프로그램 > Apps Script 를 엽니다.
   3. 이 파일 내용을 통째로 붙여넣고 저장합니다.
   4. 위쪽 함수 선택란에서 setup 을 고르고 ▶ 실행 (최초 1회, 권한 승인 필요).
   5. 배포 > 새 배포 > 유형 '웹 앱'
        설명      : 지갑 등록소
        실행 계정 : 나
        액세스 권한: 모든 사용자          ← 반드시 '모든 사용자'
   6. 나오는 /exec 주소를 복사해서
        지갑등록소.html 의 API_URL
        폴리곤스캔_이름표.user.js 의 REGISTRY_URL
      두 곳에 붙여넣습니다.

   [코드를 고친 뒤에는]
   배포 > 배포 관리 > 연필(수정) > 버전 '새 버전' > 배포
   (새 배포를 또 만들면 주소가 바뀌므로 기존 배포를 수정해야 합니다.)
   ===================================================================== */

var SHEET_ID = '';            // 스프레드시트 ID. 비워두면 이 스크립트가 붙어 있는 문서를 씁니다.
var MAX_WRITE_PER_HOUR = 80;  // 닉네임 1개당 시간당 쓰기 횟수 제한
var ADMIN_KEY = '';           // 삭제·정정용 관리자 키 (비워두면 관리 기능 잠김)

var SH_E = 'entries', SH_V = 'votes', SH_L = 'lookups';
var HDR_E = ['id', 'ts', 'address', 'name', 'type', 'source', 'period', 'org', 'evidence', 'reporter', 'status'];
var HDR_V = ['ts', 'entry_id', 'voter', 'opinion'];
var HDR_L = ['address', 'count', 'last_ts'];

var RE_ADDR = /^0x[0-9a-f]{40}$/;
/* 개인정보로 보이는 값은 서버에서도 한 번 더 막습니다. */
var RE_PHONE = /01[016789][\s.\-]?\d{3,4}[\s.\-]?\d{4}/;
var RE_JUMIN = /\d{6}\s?[-–]\s?[1-4]\d{6}/;
var RE_LONGNUM = /\d[\d\s.\-]{9,}\d/;

/* ------------------------------------------------------------------ */
/* 최초 1회 실행                                                       */
/* ------------------------------------------------------------------ */
function setup() {
  var ss = book();
  mkSheet(ss, SH_E, HDR_E);
  mkSheet(ss, SH_V, HDR_V);
  mkSheet(ss, SH_L, HDR_L);
  bump();
  return '준비 완료: ' + ss.getUrl();
}

function book() {
  return SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

function mkSheet(ss, name, hdr) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, hdr.length).setValues([hdr]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function sheet(name) {
  var sh = book().getSheetByName(name);
  if (!sh) throw new Error('시트가 없습니다: ' + name + ' — setup 을 먼저 실행하세요.');
  return sh;
}

/* ------------------------------------------------------------------ */
/* 버전 — 바뀐 게 있는지만 확인하는 아주 가벼운 값                      */
/* ------------------------------------------------------------------ */
function ver() {
  return PropertiesService.getScriptProperties().getProperty('ver') || '0';
}

function bump() {
  var p = PropertiesService.getScriptProperties();
  var v = String(Number(p.getProperty('ver') || 0) + 1);
  p.setProperty('ver', v);
  return v;
}

/* ------------------------------------------------------------------ */
/* 응답                                                                */
/* ------------------------------------------------------------------ */
function out(callback, obj) {
  var body = JSON.stringify(obj);
  if (callback && /^[A-Za-z_$][\w$]*$/.test(callback)) {
    return ContentService.createTextOutput(callback + '(' + body + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ */
/* 읽기                                                                */
/* ------------------------------------------------------------------ */
function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.v) return out(p.callback, { ok: true, ver: ver() });          // 바뀌었는지만 확인
    return out(p.callback, { ok: true, ver: ver(), data: payload() });
  } catch (err) {
    return out(p.callback, { ok: false, error: String(err.message || err) });
  }
}

/** 전체 목록. 같은 버전이면 캐시를 재사용해 시트 읽기를 줄입니다. */
function payload() {
  var key = 'payload_' + ver();
  var cache = CacheService.getScriptCache();
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  var er = rows(SH_E), vr = rows(SH_V), lr = rows(SH_L);

  var entries = [];
  for (var i = 0; i < er.length; i++) {
    var r = er[i];
    if (r[10] === 'deleted') continue;
    if (!r[0]) continue;
    entries.push({
      id: String(r[0]), ts: String(r[1]), address: String(r[2]).toLowerCase(),
      name: String(r[3]), type: String(r[4] || 'unknown'), source: String(r[5] || ''),
      period: String(r[6] || ''), org: String(r[7] || ''),
      evidence: String(r[8] || ''), reporter: String(r[9] || '')
    });
  }

  var votes = {};
  for (var j = 0; j < vr.length; j++) {
    var id = String(vr[j][1]); if (!id) continue;
    var v = votes[id] || (votes[id] = { up: 0, down: 0, voters: [] });
    if (String(vr[j][3]) === '반대') v.down++; else v.up++;
    v.voters.push(String(vr[j][2]));
  }

  /* 사람들이 자주 찾아본 '이름 없는 주소' — 수배 목록의 우선순위가 됩니다. */
  var wanted = [];
  for (var k = 0; k < lr.length; k++) {
    if (!lr[k][0]) continue;
    wanted.push({ address: String(lr[k][0]).toLowerCase(), count: Number(lr[k][1] || 0), last: String(lr[k][2] || '') });
  }
  wanted.sort(function (a, b) { return b.count - a.count; });
  wanted = wanted.slice(0, 400);

  var data = { entries: entries, votes: votes, wanted: wanted };
  try { cache.put(key, JSON.stringify(data), 300); } catch (_) { /* 100KB 초과 시 캐시 생략 */ }
  return data;
}

function rows(name) {
  var sh = sheet(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
}

/* ------------------------------------------------------------------ */
/* 쓰기                                                                */
/* ------------------------------------------------------------------ */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (_) { return out(null, { ok: false, error: '지금 접속이 몰려 있습니다. 잠시 뒤 다시 시도해주세요.' }); }
  try {
    var p = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var fn = { submit: aSubmit, bulk: aBulk, vote: aVote, seen: aSeen, remove: aRemove }[p.action];
    if (!fn) throw new Error('알 수 없는 요청입니다.');
    return out(null, fn(p));
  } catch (err) {
    return out(null, { ok: false, error: String(err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (_) { }
  }
}

/* ---- 검증 ---- */
function addr(a) {
  a = String(a || '').trim().toLowerCase();
  if (!RE_ADDR.test(a)) throw new Error('주소 형식이 올바르지 않습니다: ' + a);
  return a;
}

function clean(s, max, what) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max);
  if (RE_PHONE.test(s) || RE_JUMIN.test(s) || RE_LONGNUM.test(s)) {
    throw new Error(what + '에 전화번호·주민번호·계좌번호로 보이는 숫자가 있습니다. 개인정보는 등록할 수 없습니다.');
  }
  return s;
}

function guard(reporter) {
  var c = CacheService.getScriptCache();
  var k = 'rl_' + reporter;
  var n = Number(c.get(k) || 0) + 1;
  if (n > MAX_WRITE_PER_HOUR) throw new Error('한 시간에 등록할 수 있는 횟수를 넘었습니다. 잠시 뒤에 다시 시도해주세요.');
  c.put(k, String(n), 3600);
}

function newId() {
  return 'E' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
}

/* ---- 한 건 등록 ---- */
function aSubmit(p) {
  var a = addr(p.address);
  var reporter = clean(p.reporter, 20, '닉네임');
  var name = clean(p.name, 40, '지갑 이름');
  var evidence = clean(p.evidence, 300, '근거');
  if (!reporter) throw new Error('닉네임을 입력해주세요.');
  if (!name) throw new Error('지갑 이름을 적어주세요.');
  if (evidence.length < 10) throw new Error('근거를 10자 이상 적어주세요.');
  guard(reporter);

  /* 같은 사람이 같은 주소에 같은 이름을 또 올리는 것은 막습니다 (추천으로 유도). */
  var er = rows(SH_E);
  for (var i = 0; i < er.length; i++) {
    if (String(er[i][10]) === 'deleted') continue;
    if (String(er[i][2]).toLowerCase() === a && String(er[i][9]) === reporter && nkey(er[i][3]) === nkey(name)) {
      throw new Error('이미 같은 이름으로 등록하셨습니다. 다른 분 의견에는 추천을 눌러주세요.');
    }
  }

  var id = newId();
  sheet(SH_E).appendRow([id, nowIso(), a, name, String(p.type || 'unknown'),
    String(p.source || ''), clean(p.period, 20, '시점'), clean(p.org, 30, '소속'),
    evidence, reporter, '']);
  unwant([a]);
  bump();
  return { ok: true, id: id };
}

/* ---- 여러 건 한번에 ---- */
function aBulk(p) {
  var reporter = clean(p.reporter, 20, '닉네임');
  var evidence = clean(p.evidence, 300, '근거');
  if (!reporter) throw new Error('닉네임을 입력해주세요.');
  if (evidence.length < 10) throw new Error('근거를 10자 이상 적어주세요.');
  var items = p.items || [];
  if (!items.length) throw new Error('등록할 이름이 없습니다.');
  if (items.length > 60) throw new Error('한 번에 60개까지만 등록할 수 있습니다.');
  guard(reporter);

  var ts = nowIso(), out2 = [], done = {}, hit = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var a = addr(it.address);
    var name = clean(it.name, 40, '지갑 이름');
    if (!name || done[a + '|' + nkey(name)]) continue;
    done[a + '|' + nkey(name)] = 1;
    out2.push([newId(), ts, a, name, String(it.type || 'unknown'),
      String(p.source || ''), clean(p.period, 20, '시점'), clean(p.org, 30, '소속'),
      evidence, reporter, '']);
    hit.push(a);
  }
  if (!out2.length) throw new Error('등록할 이름이 없습니다.');
  var sh = sheet(SH_E);
  sh.getRange(sh.getLastRow() + 1, 1, out2.length, HDR_E.length).setValues(out2);
  unwant(hit);
  bump();
  return { ok: true, added: out2.length };
}

/* ---- 추천 / 아니다 ---- */
function aVote(p) {
  var voter = clean(p.voter, 20, '닉네임');
  var id = String(p.id || '');
  var opinion = String(p.opinion) === '반대' ? '반대' : '찬성';
  if (!voter) throw new Error('닉네임을 입력해주세요.');
  if (!id) throw new Error('대상이 없습니다.');
  guard(voter);

  /* 같은 지갑의 같은 이름은 누가 올렸든 한 묶음으로 보고, 묶음당 한 번만 의견을 받습니다. */
  var er = rows(SH_E), target = null, group = {}, mine = false;
  for (var i = 0; i < er.length; i++) if (String(er[i][0]) === id) { target = er[i]; break; }
  if (!target) throw new Error('이미 삭제된 항목입니다.');
  for (var j = 0; j < er.length; j++) {
    if (String(er[j][10]) === 'deleted') continue;
    if (String(er[j][2]).toLowerCase() === String(target[2]).toLowerCase() && nkey(er[j][3]) === nkey(target[3])) {
      group[String(er[j][0])] = 1;
      if (String(er[j][9]) === voter) mine = true;
    }
  }
  if (mine) throw new Error('본인이 등록한 이름에는 추천할 수 없습니다.');

  var vr = rows(SH_V);
  for (var k = 0; k < vr.length; k++) {
    if (group[String(vr[k][1])] && String(vr[k][2]) === voter) throw new Error('이미 의견을 남기셨습니다.');
  }
  sheet(SH_V).appendRow([nowIso(), id, voter, opinion]);
  bump();
  return { ok: true };
}

/* ---- 찾아본 주소 기록 (수배 목록 우선순위) ----
   한 칸씩 읽고 쓰면 100개일 때 시트 호출이 200번이라 시간 초과가 납니다.
   메모리에서 다 고친 뒤 한 번에 씁니다. */
function aSeen(p) {
  var list = p.addresses || [];
  if (!list.length) return { ok: true };
  if (list.length > 100) list = list.slice(0, 100);

  var sh = sheet(SH_L), lr = rows(SH_L), idx = {};
  for (var i = 0; i < lr.length; i++) idx[String(lr[i][0]).toLowerCase()] = i;

  var ts = nowIso(), add = [], seen = {}, touched = false;
  for (var j = 0; j < list.length; j++) {
    var a;
    try { a = addr(list[j]); } catch (_) { continue; }
    if (seen[a]) continue;
    seen[a] = 1;
    if (idx[a] != null) {
      lr[idx[a]][1] = Number(lr[idx[a]][1] || 0) + 1;
      lr[idx[a]][2] = ts;
      touched = true;
    } else {
      add.push([a, 1, ts]);
    }
  }
  if (touched && lr.length) sh.getRange(2, 1, lr.length, lr[0].length).setValues(lr);
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, HDR_L.length).setValues(add);
  /* 조회 기록은 화면을 다시 그릴 만큼 중요하지 않으므로 버전을 올리지 않습니다. */
  return { ok: true };
}

/** 이름이 붙은 주소는 수배 목록에서 뺍니다. 여러 개를 한 번에 처리합니다. */
function unwant(addrs) {
  if (!addrs || !addrs.length) return;
  var sh = sheet(SH_L), lr = rows(SH_L);
  if (!lr.length) return;

  var kill = {};
  for (var i = 0; i < addrs.length; i++) kill[addrs[i]] = 1;

  var keep = [], changed = false;
  for (var j = 0; j < lr.length; j++) {
    if (kill[String(lr[j][0]).toLowerCase()]) { changed = true; continue; }
    keep.push(lr[j]);
  }
  if (!changed) return;
  sh.getRange(2, 1, lr.length, lr[0].length).clearContent();
  if (keep.length) sh.getRange(2, 1, keep.length, keep[0].length).setValues(keep);
}

/* ---- 삭제 (운영진) ---- */
function aRemove(p) {
  if (!ADMIN_KEY || String(p.key) !== ADMIN_KEY) throw new Error('권한이 없습니다.');
  var sh = sheet(SH_E), er = rows(SH_E);
  for (var i = 0; i < er.length; i++) {
    if (String(er[i][0]) === String(p.id)) {
      sh.getRange(i + 2, HDR_E.length).setValue('deleted');
      bump();
      return { ok: true };
    }
  }
  throw new Error('항목을 찾을 수 없습니다.');
}

/* ------------------------------------------------------------------ */
function nkey(s) { return String(s || '').replace(/[\s()·・\-_.]/g, '').toLowerCase(); }
function nowIso() { return new Date().toISOString(); }
