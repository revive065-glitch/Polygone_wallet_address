"""폴리곤 지갑 등록소 — 스캔 설정

바꿀 일이 있는 값은 전부 여기 모아 뒀습니다.
API 키는 환경변수 POLYSCAN_KEY 가 있으면 그것을 먼저 씁니다.
"""
import os

# Etherscan V2 (폴리곤 = chainid 137). 무료 키는 초당 5회 제한입니다.
API_KEY = os.environ.get("POLYSCAN_KEY", "6R1X469D26ZTGUEMIVP599PPNXDIBBASE6")
CHAIN_ID = 137
BASE = "https://api.etherscan.io/v2/api"

# ---- 주소 ----
CC2C = "0xaaa4d5dd26eb1a2afe5fd5fb529fc24cee89cc2c"   # 참여금이 모이는 회사 수금지갑
ESCROW = "0x958eed8b9c77f79420c3cde1998df4efb27e5972"  # MPC 개인거래 에스크로

# DeCT Right(외매권) 발급지갑 — 값 0 트랜잭션 input 에 평문을 적어 보냅니다.
# 하나만 보면 15%밖에 안 잡히므로 전부 훑어야 합니다.
DECT_ISSUERS = [
    "0xf11d0da941625c2e6df119c6b30df9d42ad0a964",  # 회사 지급지갑 #1
    "0x31c9342baf01f941d9eeeed11eb09815602f747b",
    "0xe6e7ec8dfbacc0dbfc8e838ff2a49a252ab4ff85",  # 회사 지급지갑 #2 / 멀티샌드
    "0x3fbebfb25c4b9d8a2a6b37640f4c59d407fa0484",
    "0xdc7f40a3244ca87d82c065204360b9fb5ba65069",
]

# ---- 토큰 ----
TOKENS = {
    "0x98965474ecbec2f532f1f780ee37b0b05f77ca55": ("SUT", 18),
    "0x435001af7fc65b621b0043df99810b2f30860c5d": ("KWT", 6),
    "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": ("USDT", 6),
    "0x2d854416d2749b1f0eb8a4b2ab9027989f2ba262": ("MPC", 18),
}
SUT = "0x98965474ecbec2f532f1f780ee37b0b05f77ca55"
USDT = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f"
MPC = "0x2d854416d2749b1f0eb8a4b2ab9027989f2ba262"

# ---- 스캔 범위 ----
MPC_FROM_BLOCK = 85_700_000     # MPC 는 2026-04-20 발행이라 그 앞은 볼 것이 없습니다
WORKERS = 6                     # 동시 프로세스. 6을 넘기면 rate limit 에 걸립니다
PAGE_CAP = 40                   # 한 주소당 tokentx 최대 페이지(4만 건). 대형 지갑 무한 대기 방지

# ---- 판정 규칙 ----
PAIR_SEC = 2400                 # IDM 과 CC2C 입금을 같은 참여로 볼 시간창(초)
CREDIT_MULT = 2.4               # 앱의 "신용매매 결제대금" ÷ 실제 낸 결제대금
USDT_KRW = 1400                 # USDT 원화 환산 (config.json 과 같이 유지하세요)
FREE_KPD = 5000                 # DeCT 1당 낸 돈이 이 밑이면 "자기돈 거의 없음"
BOT_N = 1000                    # 발급 건수가 이 이상이면 "초고빈도"

# ---- 산출물 ----
OUT_DIR = ".."                  # scan/ 기준 상위 = 페이지와 같은 폴더
RAW_DIR = "raw"                 # 원자료(jsonl) 보관
TOP_N = 1500                    # dect_top_c.json 에 담을 상위 개수
FLOW_TOP = 700                  # 자금흐름을 훑을 DeCT 상위 인원
