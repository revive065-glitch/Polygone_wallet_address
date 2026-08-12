#!/usr/bin/env python3
"""체인 스캔 — 원자료를 raw/ 에 모읍니다.

  python scan.py dect     DeCT Right 발급 기록 (발급지갑 5곳의 normal tx)
  python scan.py cc2c     CC2C 수금지갑으로 들어온 토큰 전송
  python scan.py mpc      MPC 토큰 전송 전량
  python scan.py flow     주소별 자금흐름 + 가스비 공급자
  python scan.py all      위 넷을 순서대로

  python scan.py _cc2c_part <lo> <hi> <out>    (내부용 — 구간 작업자)
  python scan.py _mpc_part  <lo> <hi> <out>
  python scan.py _flow_part <lo> <hi> <out> <targets.json>
"""
import json, sys, os, time, collections, glob
import config as C
import api


# ────────────────────────────────── DeCT
def scan_dect():
    api.ensure_raw()
    out = f"{C.RAW_DIR}/dect.jsonl"
    total = kept = 0
    with open(out, "w") as f:
        for iss in C.DECT_ISSUERS:
            rows, _ = api.paged(dict(module="account", action="txlist", address=iss))
            for t in rows:
                total += 1
                s = api.txt(t["input"])
                if s and s.startswith("DeCT"):
                    kept += 1
                    f.write(json.dumps({
                        "b": int(t["blockNumber"]), "ts": int(t["timeStamp"]),
                        "h": t["hash"], "i": int(t["transactionIndex"]),
                        "from": t["from"].lower(), "to": (t["to"] or "").lower(),
                        "idm": s}, ensure_ascii=False) + "\n")
            print(f"  {iss[:12]}… tx {len(rows):,} → DeCT {kept:,}", flush=True)
    print(f"DeCT {kept:,}건 / 전체 tx {total:,}")


# ────────────────────────────────── CC2C
def _cc2c_part(lo, hi, out):
    n = 0
    with open(out, "w") as f:
        rows, _ = api.paged(dict(module="account", action="tokentx", address=C.CC2C), lo, hi)
        for t in rows:
            c = t["contractAddress"].lower()
            if c not in C.TOKENS:
                continue
            sym, d = C.TOKENS[c]
            v = api.dec(t["value"], d)
            if v <= 0:
                continue
            n += 1
            f.write(json.dumps({"b": int(t["blockNumber"]), "ts": int(t["timeStamp"]),
                                "h": t["hash"], "from": t["from"].lower(),
                                "to": t["to"].lower(), "sym": sym, "v": v}) + "\n")
    print(f"  구간 {lo}~{hi}: {n:,}건", flush=True)


def scan_cc2c():
    api.ensure_raw()
    head = int(api.get(dict(module="proxy", action="eth_blockNumber")) or 0) if False else _head()
    span = (head + 1) // C.WORKERS
    ranges = [("_cc2c_part", i * span, (i + 1) * span - 1 if i < C.WORKERS - 1 else 99999999,
               f"{C.RAW_DIR}/cc2c_{i}.jsonl") for i in range(C.WORKERS)]
    api.fan_out(__file__, ranges)
    n = api.merge(f"{C.RAW_DIR}/cc2c_*.jsonl", f"{C.RAW_DIR}/cc2c.jsonl", key="h" if False else None)
    print(f"CC2C 입금 {n:,}건")


def _head():
    import urllib.request
    url = f"{C.BASE}?chainid={C.CHAIN_ID}&module=proxy&action=eth_blockNumber&apikey={C.API_KEY}"
    with urllib.request.urlopen(url, timeout=30) as r:
        return int(json.load(r)["result"], 16)


# ────────────────────────────────── MPC
def _mpc_part(lo, hi, out):
    n = 0
    with open(out, "w") as f:
        rows, _ = api.paged(dict(module="account", action="tokentx", contractaddress=C.MPC), lo, hi)
        for t in rows:
            v = api.dec(t["value"], 18)
            n += 1
            f.write(json.dumps({"b": int(t["blockNumber"]), "ts": int(t["timeStamp"]),
                                "h": t["hash"], "from": t["from"].lower(),
                                "to": t["to"].lower(), "v": v}) + "\n")
    print(f"  구간 {lo}~{hi}: {n:,}건", flush=True)


def scan_mpc():
    api.ensure_raw()
    head = _head()
    span = (head - C.MPC_FROM_BLOCK) // C.WORKERS + 1
    ranges = [("_mpc_part", C.MPC_FROM_BLOCK + i * span,
               C.MPC_FROM_BLOCK + (i + 1) * span - 1 if i < C.WORKERS - 1 else 99999999,
               f"{C.RAW_DIR}/mpc_{i}.jsonl") for i in range(C.WORKERS)]
    api.fan_out(__file__, ranges)
    n = api.merge(f"{C.RAW_DIR}/mpc_*.jsonl", f"{C.RAW_DIR}/mpc.jsonl")
    print(f"MPC 전송 {n:,}건")


# ────────────────────────────────── 자금흐름
def _flow_part(lo, hi, out, tfile):
    T = json.load(open(tfile))[lo:hi]
    with open(out, "w") as f:
        for k, a in enumerate(T):
            tx, _ = api.paged(dict(module="account", action="txlist", address=a), cap=2)
            pol = [[t["from"].lower(), round(api.dec(t.get("value", 0), 18), 4), int(t["timeStamp"])]
                   for t in tx
                   if api.dec(t.get("value", 0), 18) > 0 and (t.get("to") or "").lower() == a]
            rows, cut = api.paged(dict(module="account", action="tokentx", address=a), cap=C.PAGE_CAP)
            inn = collections.defaultdict(lambda: collections.defaultdict(float))
            out_ = collections.defaultdict(lambda: collections.defaultdict(float))
            for t in rows:
                c = t["contractAddress"].lower()
                if c not in C.TOKENS:
                    continue
                sym, d = C.TOKENS[c]
                v = api.dec(t["value"], d)
                if v <= 0:
                    continue
                if t["to"].lower() == a:
                    inn[t["from"].lower()][sym] += v
                elif t["from"].lower() == a:
                    out_[t["to"].lower()][sym] += v

            def top(m, nn=12):
                w = lambda d: (d.get("USDT", 0) * C.USDT_KRW + d.get("KWT", 0)
                               + d.get("SUT", 0) * 700 + d.get("MPC", 0) * 500)
                sc = sorted(m.items(), key=lambda kv: -w(kv[1]))
                return [[k2, {s: round(v, 2) for s, v in d2.items()}] for k2, d2 in sc[:nn]]

            f.write(json.dumps({"addr": a, "pol": pol[:8],
                                "first": int(tx[0]["timeStamp"]) if tx else 0,
                                "ntx": len(tx), "in": top(inn), "out": top(out_),
                                "cut": 1 if cut else 0}) + "\n")
            f.flush()
            if k % 20 == 0:
                print(f"  {lo}+{k}/{len(T)}", flush=True)


def scan_flow():
    """대상 = MPC 에스크로 참여자 + DeCT 상위 FLOW_TOP + 가스비 허브."""
    api.ensure_raw()
    targets, seen = [], set()

    def add(a):
        a = a.lower()
        if a not in seen:
            seen.add(a); targets.append(a)

    # 에스크로 참여자
    if os.path.exists(f"{C.RAW_DIR}/mpc.jsonl"):
        for line in open(f"{C.RAW_DIR}/mpc.jsonl"):
            d = json.loads(line)
            if d["to"] == C.ESCROW: add(d["from"])
            elif d["from"] == C.ESCROW: add(d["to"])
    # DeCT 상위
    p = f"{C.OUT_DIR}/dect_top_c.json"
    if os.path.exists(p):
        j = json.load(open(p)); f = {k: i for i, k in enumerate(j["f"])}
        for r in j["r"][:C.FLOW_TOP]: add(r[f["addr"]])
    known = set(x.lower() for x in C.DECT_ISSUERS) | {C.CC2C, C.ESCROW}
    targets = [a for a in targets if a not in known]

    tf = f"{C.RAW_DIR}/flow_targets.json"
    json.dump(targets, open(tf, "w"))
    print(f"자금흐름 대상 {len(targets):,}명")
    span = len(targets) // C.WORKERS + 1
    ranges = [("_flow_part", i * span, (i + 1) * span, f"{C.RAW_DIR}/flow_{i}.jsonl", tf)
              for i in range(C.WORKERS)]
    api.fan_out(__file__, ranges)
    n = api.merge(f"{C.RAW_DIR}/flow_*.jsonl", f"{C.RAW_DIR}/flow.jsonl", key="addr")
    print(f"자금흐름 {n:,}명")


# ────────────────────────────────── 진입점
CMDS = {"dect": scan_dect, "cc2c": scan_cc2c, "mpc": scan_mpc, "flow": scan_flow}
PARTS = {"_cc2c_part": _cc2c_part, "_mpc_part": _mpc_part, "_flow_part": _flow_part}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    cmd = sys.argv[1]
    if cmd in PARTS:
        a = sys.argv[2:]
        PARTS[cmd](*( [int(a[0]), int(a[1])] + a[2:] ))
    elif cmd == "all":
        for k in ("dect", "cc2c", "mpc", "flow"):
            print(f"\n=== {k} ===")
            t = time.time(); CMDS[k](); print(f"  {time.time()-t:.0f}초")
    elif cmd in CMDS:
        CMDS[cmd]()
    else:
        print(__doc__); sys.exit(1)
