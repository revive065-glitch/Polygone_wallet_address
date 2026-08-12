#!/usr/bin/env python3
"""집계 — raw/ 의 원자료를 페이지가 읽는 JSON 으로 만듭니다.

  python build.py

만드는 것 (전부 상위 폴더에):
  dect_top_c.json  DeCT 상위 1500 상세      addr_idx.json  전체 주소 지표
  flow.json        자금흐름                  gas_hub.json   가스비 허브
  sut_src.json     SUT 유입처                sut_hub.json   SUT 공급 허브
  mpc_lock.json    에스크로 잠긴 매물        mpc_esc.json   실제 인도 거래
  meta.json        기준 시각·건수
"""
import json, re, os, time, glob, bisect, collections
import config as C

IDM = re.compile(r'^DeCT,([^,]+),([^,]+),SUT ([\d.]+),(\w+)')
R = C.RAW_DIR
O = C.OUT_DIR
NOW = int(time.time())


def dump(name, obj):
    p = f"{O}/{name}.json"
    json.dump(obj, open(p, "w"), ensure_ascii=False, separators=(",", ":"))
    print(f"  {name}.json  {os.path.getsize(p)/1024:.0f}KB")


# ────────────────── 1. CC2C 입금 (주소별 시간정렬)
def load_pay():
    pay = collections.defaultdict(list)
    n = 0
    for line in open(f"{R}/cc2c.jsonl"):
        d = json.loads(line)
        if d["to"] != C.CC2C:
            continue
        pay[d["from"]].append((d["ts"], d["sym"], d["v"])); n += 1
    for a in pay:
        pay[a].sort()
    print(f"CC2C 입금 {n:,}건 / 입금자 {len(pay):,}명")
    return pay, {a: [x[0] for x in v] for a, v in pay.items()}


# ────────────────── 2. DeCT 집계
def build_dect(pay, paykey):
    acc, seen, tot = {}, set(), 0

    def A(a):
        r = acc.get(a)
        if r is None:
            r = acc[a] = dict(addr=a, dect=0.0, n=0, first=0, last=0,
                              solo_n=0, solo_sut=0.0, paid_n=0, paid_sut=0.0,
                              krw_n=0, krw_sut=0.0, d_kwt=0.0, d_usdt=0.0, d_krw=0.0)
        return r

    for line in open(f"{R}/dect.jsonl"):
        d = json.loads(line)
        m = IDM.match(d["idm"])
        if not m or d["h"] in seen:
            continue
        seen.add(d["h"])
        to, ts, sut, tok = d["to"], d["ts"], float(m.group(3)), m.group(4)
        tot += 1
        a = A(to)
        a["dect"] += sut; a["n"] += 1
        if tok == "KWT": a["d_kwt"] += sut
        elif tok == "USDT": a["d_usdt"] += sut
        else: a["d_krw"] += sut
        if not a["first"] or ts < a["first"]: a["first"] = ts
        if ts > a["last"]: a["last"] = ts
        # 인접 CC2C 입금으로 참여 유형 판정
        ks = paykey.get(to); has_sut = has_pay = False
        if ks:
            i = bisect.bisect_left(ks, ts - C.PAIR_SEC); lst = pay[to]
            while i < len(ks) and ks[i] <= ts + C.PAIR_SEC:
                s = lst[i][1]
                if s == "SUT": has_sut = True
                elif s in ("KWT", "USDT"): has_pay = True
                i += 1
        if has_sut and has_pay: a["paid_n"] += 1; a["paid_sut"] += sut
        elif has_sut:           a["solo_n"] += 1; a["solo_sut"] += sut
        else:                   a["krw_n"] += 1; a["krw_sut"] += sut
    print(f"DeCT IDM {tot:,}건 / 수령주소 {len(acc):,}개")

    for addr, ps in pay.items():
        a = A(addr)
        a["kwt"] = sum(v for _, s, v in ps if s == "KWT")
        a["usdt"] = sum(v for _, s, v in ps if s == "USDT")
        a["sut_in"] = sum(v for _, s, v in ps if s == "SUT")
    rows = []
    for a in acc.values():
        for k in ("kwt", "usdt", "sut_in"): a.setdefault(k, 0.0)
        a["cr_kwt"] = a["kwt"] * C.CREDIT_MULT
        a["cr_usdt"] = a["usdt"] * C.CREDIT_MULT
        a["cr_krw"] = a["cr_kwt"] + a["cr_usdt"] * C.USDT_KRW
        a["kpd"] = ((a["kwt"] + a["usdt"] * C.USDT_KRW) / a["dect"]) if a["dect"] else 0
        rows.append(a)
    rows.sort(key=lambda r: -r["dect"])
    for i, r in enumerate(rows, 1): r["rank"] = i
    top = [r for r in rows if r["dect"] > 0]

    F = ["addr", "dect", "n", "paid_n", "solo_n", "krw_n", "kpd", "first", "last",
         "kwt", "usdt", "sut_in", "cr_kwt", "cr_usdt", "cr_krw", "d_kwt", "d_usdt", "d_krw"]
    def row(r):
        return [r["addr"], round(r["dect"]), r["n"], r["paid_n"], r["solo_n"], r["krw_n"],
                round(r["kpd"]), r["first"], r["last"], round(r["kwt"]), round(r["usdt"]),
                round(r["sut_in"]), round(r["cr_kwt"]), round(r["cr_usdt"]), round(r["cr_krw"]),
                round(r["d_kwt"]), round(r["d_usdt"]), round(r["d_krw"])]
    dump("dect_top_c", {"g": NOW, "n": len(top),
                        "sum": round(sum(r["dect"] for r in top)),
                        "crk": round(sum(r["cr_kwt"] for r in top)),
                        "cru": round(sum(r["cr_usdt"] for r in top)),
                        "idm": tot, "f": F, "r": [row(r) for r in top[:C.TOP_N]]})
    return {r["addr"]: r for r in rows}


# ────────────────── 3. MPC 에스크로
def build_mpc():
    dep, wdr, recv = [], [], collections.Counter()
    for line in open(f"{R}/mpc.jsonl"):
        d = json.loads(line)
        if d["v"] > 0:
            recv[d["to"]] += d["v"]
            if d["to"] == C.ESCROW: dep.append([d["ts"], d["from"], d["v"], 0])
            elif d["from"] == C.ESCROW: wdr.append([d["ts"], d["to"], d["v"], 0])
    dep.sort(); wdr.sort()
    byk, byv = collections.defaultdict(list), collections.defaultdict(list)
    for i, d in enumerate(dep):
        byk[(round(d[2], 6), d[1])].append(i); byv[round(d[2], 6)].append(i)
    # ① 같은 주소끼리 먼저 (맡겼다 도로 찾아감) — 이걸 먼저 안 하면 남의 거래로 오인됩니다
    selfn = 0
    for w in wdr:
        for i in byk.get((round(w[2], 6), w[1]), []):
            if dep[i][3] or dep[i][0] > w[0]: continue
            dep[i][3] = 1; w[3] = 1; selfn += 1; break
    # ② 남은 것끼리 (실제 인도)
    trades = []
    for w in wdr:
        if w[3]: continue
        best = None
        for i in byv.get(round(w[2], 6), []):
            d = dep[i]
            if d[3] or d[0] > w[0] or d[1] == w[1]: continue
            gap = w[0] - d[0]
            if best is None or gap < best[0]: best = (gap, i)
        if best:
            d = dep[best[1]]; d[3] = 1; w[3] = 1
            trades.append((d[0], w[0], d[1], w[1], w[2], best[0]))
    lock, lockn, first = collections.Counter(), collections.Counter(), {}
    for d in dep:
        if d[3]: continue
        lock[d[1]] += d[2]; lockn[d[1]] += 1; first.setdefault(d[1], d[0])
    print(f"에스크로 예치 {len(dep):,} / 방출 {len(wdr):,} / 자기회수 {selfn:,} / 인도 {len(trades)}")
    dump("mpc_lock", {"g": NOW, "total": round(sum(lock.values())), "n": len(lock),
                      "dep": len(dep), "wdr": len(wdr), "selfn": selfn, "tn": len(trades),
                      "f": ["addr", "mpc", "n", "first", "rank"],
                      "r": [[a, round(v), lockn[a], first[a], 0] for a, v in lock.most_common()]})
    dump("mpc_esc", {"g": NOW, "n": len(trades), "mpc": round(sum(t[4] for t in trades)),
                     "selfn": selfn,
                     "f": ["dep_ts", "wdr_ts", "seller", "buyer", "mpc", "gap"],
                     "r": [[t[0], t[1], t[2], t[3], round(t[4], 2), t[5]]
                           for t in sorted(trades, key=lambda x: -x[4])]})
    return recv


# ────────────────── 4. 자금흐름 · 허브
def build_flow(D):
    rows = [json.loads(l) for l in open(f"{R}/flow.jsonl")]
    dump("flow", {"g": NOW, "n": len(rows), "r": rows})

    # 가스비 허브
    sup, who, amt = collections.Counter(), collections.defaultdict(list), collections.Counter()
    for r in rows:
        s2 = set()
        for p in r["pol"]:
            if p[0] == r["addr"] or p[1] < 0.001: continue
            amt[p[0]] += p[1]
            if p[0] in s2: continue
            s2.add(p[0]); sup[p[0]] += 1; who[p[0]].append(r["addr"])
    gh = []
    for a, c in sup.most_common():
        if c < 2: continue
        d = D.get(a)
        gh.append([a, c, round(amt[a], 2), (d["rank"] if d else 0), (round(d["dect"]) if d else 0),
                   (round(d["cr_krw"]) if d else 0), 0, sorted(who[a])[:30]])
    dump("gas_hub", {"g": NOW, "n": len(gh), "traced": len(rows),
                     "f": ["addr", "targets", "pol", "rank", "dect", "credit", "mpc", "to"], "r": gh})

    # SUT 유입처 · 공급 허브 — 자금흐름에서 파생(따로 스캔하지 않습니다)
    src = {}
    for r in rows:
        s = [[a, d["SUT"], 0] for a, d in r["in"] if d.get("SUT")]
        if s: src[r["addr"]] = sorted(s, key=lambda x: -x[1])[:15]
    dump("sut_src", src)
    hub, hubv, hto = collections.Counter(), collections.Counter(), collections.defaultdict(list)
    for a, lst in src.items():
        for s, v, _ in lst:
            if s == a: continue
            hub[s] += 1; hubv[s] += v; hto[s].append([a, round(v)])
    sh = []
    for a, c in hub.most_common(400):
        if c < 3: continue
        d = D.get(a)
        sh.append({"addr": a, "targets": c, "sut": round(hubv[a]), "zero": 0,
                   "rank": (d["rank"] if d else 0), "dect": (round(d["dect"]) if d else 0),
                   "to": sorted(hto[a], key=lambda x: -x[1])[:20]})
    dump("sut_hub", {"g": NOW, "n": len(sh), "traced": len(rows), "r": sh})
    return rows, {g[0]: g[1] for g in gh}


# ────────────────── 5. 통합 주소 인덱스
def build_idx(D, mpc_recv, flows, gas):
    prof = {}
    def P(a):
        r = prof.get(a)
        if r is None: r = prof[a] = [0] * 9
        return r
    for a, d in D.items():
        p = P(a)
        p[0] = d["rank"] if d["dect"] > 0 else 0
        p[1] = round(d["dect"]); p[2] = d["n"]
        p[3] = round(d["kwt"]); p[4] = round(d["usdt"]); p[5] = round(d["sut_in"])
    for a, v in mpc_recv.items(): P(a)[6] = round(v)
    esc = set()
    for line in open(f"{R}/mpc.jsonl"):
        d = json.loads(line)
        if d["to"] == C.ESCROW: esc.add(d["from"])
        elif d["from"] == C.ESCROW: esc.add(d["to"])
    for a in esc: P(a)[7] = 1
    # 가스비만 대는 주소도 반드시 넣습니다 — 안 넣으면 조직을 굴리는 쪽이 검색에서 통째로 빠집니다
    for a, c in gas.items(): P(a)[8] = c
    for x in flows:
        P(x["addr"])
        for p in x.get("pol", []): P(p[0])
        for side in ("in", "out"):
            for y in x.get(side, []): P(y[0])
    rows = [[a] + p for a, p in prof.items()]
    rows.sort(key=lambda r: (-r[2], -r[9]))
    dump("addr_idx", {"g": NOW,
                      "f": ["addr", "rank", "dect", "n", "kwt", "usdt", "sut", "mpc", "esc", "gas"],
                      "r": rows})
    print(f"통합 주소 {len(rows):,}개")
    return len(rows)


if __name__ == "__main__":
    os.makedirs(O, exist_ok=True)
    pay, paykey = load_pay()
    D = build_dect(pay, paykey)
    mpc_recv = build_mpc()
    flows, gas = build_flow(D)
    n = build_idx(D, mpc_recv, flows, gas)
    dump("meta", {"g": NOW, "gen": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(NOW)),
                  "addrs": n, "credit_mult": C.CREDIT_MULT, "usdt_krw": C.USDT_KRW,
                  "pair_sec": C.PAIR_SEC})
    print("\n완료 — 페이지를 새로고침하면 반영됩니다.")
