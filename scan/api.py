"""Etherscan V2 호출 공통부 — 재시도·페이지네이션·병렬 실행"""
import json, os, sys, time, urllib.request, subprocess
import config as C


def get(params, tries=8):
    """한 번의 API 호출. 결과가 list 면 그대로, 없으면 빈 list.

    주의: message 가 NOTOK 이라고 해서 '끝'이 아닙니다. rate limit 일 때도
    NOTOK 이 오므로, 여기서 끝으로 오인하면 데이터가 통째로 잘립니다.
    """
    q = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{C.BASE}?chainid={C.CHAIN_ID}&apikey={C.API_KEY}&{q}"
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                d = json.load(r)
        except Exception:
            time.sleep(2)
            continue
        res = d.get("result")
        if isinstance(res, list):
            return res
        if "No transactions" in str(res) or "No records" in str(d.get("message")):
            return []
        time.sleep(2)          # rate limit 등 — 쉬었다 다시
    return []


def paged(params, lo=0, hi=99999999, cap=None):
    """블록을 이어받으며 전량 수집. cap 페이지에서 끊습니다(잘리면 두 번째 값이 True)."""
    out, start, pg = [], lo, 0
    while True:
        p = dict(params); p["startblock"] = start; p["endblock"] = hi
        p["page"] = 1; p["offset"] = 1000; p["sort"] = "asc"
        r = get(p)
        if not r:
            break
        out += r
        pg += 1
        if len(r) < 1000:
            break
        if cap and pg >= cap:
            return out, True
        last = int(r[-1]["blockNumber"])
        start = last + 1 if last == start else last
    return out, False


def txt(hexstr):
    """input data 를 UTF-8 로. DeCT IDM 은 여기 평문으로 들어 있습니다."""
    try:
        return bytes.fromhex((hexstr or "0x")[2:]).decode("utf-8")
    except Exception:
        return None


def dec(value, decimals):
    return int(value) / (10 ** decimals)


def ensure_raw():
    os.makedirs(C.RAW_DIR, exist_ok=True)


def fan_out(script, ranges):
    """같은 스크립트를 구간별로 나눠 동시에 돌립니다.

    단일 프로세스로는 CC2C 391만 건에 몇 시간이 걸립니다. 구간을 쪼개
    6개까지 동시에 돌리면 5배쯤 빨라집니다(그 이상은 rate limit).
    """
    procs = []
    for args in ranges:
        cmd = [sys.executable, script] + [str(a) for a in args]
        procs.append(subprocess.Popen(cmd))
    for p in procs:
        p.wait()


def merge(pattern, out, key=None):
    """구간별 jsonl 을 하나로 합칩니다. key 를 주면 그 필드로 중복을 없앱니다."""
    import glob
    seen, n = set(), 0
    with open(out, "w") as w:
        for f in sorted(glob.glob(pattern)):
            for line in open(f):
                if key:
                    k = json.loads(line)[key]
                    if k in seen:
                        continue
                    seen.add(k)
                w.write(line); n += 1
    return n
