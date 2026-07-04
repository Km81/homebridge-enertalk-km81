#!/usr/bin/env python3
"""
EnerTalk 로컬 리다이렉트 서비스.

에너톡 기기가 클라우드(eddie-ext.encoredtech.com:5010)로 올리는 TLS 스트림을,
같은 LAN 의 이 호스트(홈브릿지 플러그인 로컬 서버 :5010)로 돌린다.

방법: 대상 기기 1대에 대해서만 ARP 스푸핑(게이트웨이인 척)해서 그 기기의 트래픽을
이 호스트로 끌어오고, iptables REDIRECT 로 5010 포트를 로컬로 DNAT 한다.
-> DNS/라우터 설정 변경 없이, 기기 1대에만 영향.

환경변수:
  DEVICE_IP   (필수)  대상 에너톡 기기 IP           예: 192.168.1.108
  DEVICE_MAC  (권장)  대상 기기 MAC (없으면 ARP 로 조회)  예: 84:72:07:24:0d:c5
  LOCAL_PORT  (기본 5010)  플러그인 로컬 서버 포트
  GATEWAY_IP  (자동)  기본 게이트웨이 IP (없으면 라우팅에서 감지)
  IFACE       (자동)  사용할 인터페이스
  SPOOF_INTERVAL (기본 2)  ARP 재전송 주기(초)

종료(SIGTERM/SIGINT) 시 ARP 를 원상복구하고 iptables 규칙을 제거한다.
"""
import os
import sys
import time
import signal
import subprocess
import threading

from scapy.all import Ether, ARP, sendp, get_if_hwaddr, conf, getmacbyip


def log(*a):
    print("[enertalk-local]", *a, flush=True)


DEVICE_IP = os.environ.get("DEVICE_IP")
DEVICE_MAC = (os.environ.get("DEVICE_MAC") or "").lower() or None
LOCAL_PORT = int(os.environ.get("LOCAL_PORT", "5010"))
GATEWAY_IP = os.environ.get("GATEWAY_IP") or None
IFACE = os.environ.get("IFACE") or None
INTERVAL = float(os.environ.get("SPOOF_INTERVAL", "2"))

if not DEVICE_IP:
    log("ERROR: DEVICE_IP 환경변수가 필요합니다.")
    sys.exit(1)


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True)


def default_gateway():
    r = sh("ip route | awk '/default/{print $3; exit}'")
    return r.stdout.strip()


conf.verb = 0
if not IFACE:
    IFACE = conf.iface
if not GATEWAY_IP:
    GATEWAY_IP = default_gateway()
conf.iface = IFACE
MY_MAC = get_if_hwaddr(IFACE)


def resolve_mac(ip, tries=6):
    for _ in range(tries):
        try:
            m = getmacbyip(ip)
        except Exception:
            m = None
        if m:
            return m.lower()
        time.sleep(1)
    return None


log("iface=%s my_mac=%s" % (IFACE, MY_MAC))
log("device=%s gateway=%s port=%d" % (DEVICE_IP, GATEWAY_IP, LOCAL_PORT))

if not DEVICE_MAC:
    DEVICE_MAC = resolve_mac(DEVICE_IP)
GATEWAY_MAC = resolve_mac(GATEWAY_IP)
log("device_mac=%s gateway_mac=%s" % (DEVICE_MAC, GATEWAY_MAC))
if not DEVICE_MAC or not GATEWAY_MAC:
    log("ERROR: MAC 확인 실패 — DEVICE_MAC / GATEWAY_IP 를 환경변수로 지정하세요.")
    sys.exit(1)

RULE = "PREROUTING -s %s -p tcp --dport %d -j REDIRECT --to-ports %d" % (
    DEVICE_IP, LOCAL_PORT, LOCAL_PORT)

stop = threading.Event()


def enable_forward():
    sh("sysctl -w net.ipv4.ip_forward=1")


def add_iptables():
    if sh("iptables -t nat -C %s" % RULE).returncode != 0:
        res = sh("iptables -t nat -A %s" % RULE)
        if res.returncode == 0:
            log("iptables REDIRECT 적용")
        else:
            log("WARN iptables 적용 실패:", res.stderr.strip())
            log("  (컨테이너 iptables 백엔드 문제일 수 있음 — README 의 '호스트에서 직접' 방법 참고)")


def del_iptables():
    while sh("iptables -t nat -C %s" % RULE).returncode == 0:
        sh("iptables -t nat -D %s" % RULE)
    log("iptables REDIRECT 제거")


def spoof_loop():
    to_dev = Ether(dst=DEVICE_MAC) / ARP(op=2, psrc=GATEWAY_IP, hwsrc=MY_MAC, pdst=DEVICE_IP, hwdst=DEVICE_MAC)
    to_gw = Ether(dst=GATEWAY_MAC) / ARP(op=2, psrc=DEVICE_IP, hwsrc=MY_MAC, pdst=GATEWAY_IP, hwdst=GATEWAY_MAC)
    n = 0
    # 하트비트 주기(초) — 살아있음 확인용
    hb_every = max(1, int(60 / INTERVAL)) if INTERVAL > 0 else 30
    while not stop.is_set():
        sendp(to_dev, iface=IFACE, verbose=0)
        sendp(to_gw, iface=IFACE, verbose=0)
        n += 1
        if n % 30 == 0:
            add_iptables()  # 혹시 규칙이 사라졌으면 재적용
        if n % hb_every == 0:
            log("정상 동작 중 — ARP %d회 전송, iptables REDIRECT 유지 (기기 %s → 로컬 :%d)" % (n, DEVICE_IP, LOCAL_PORT))
        stop.wait(INTERVAL)


def restore():
    try:
        sendp(Ether(dst=DEVICE_MAC) / ARP(op=2, psrc=GATEWAY_IP, hwsrc=GATEWAY_MAC, pdst=DEVICE_IP, hwdst=DEVICE_MAC),
              iface=IFACE, count=5, verbose=0)
        sendp(Ether(dst=GATEWAY_MAC) / ARP(op=2, psrc=DEVICE_IP, hwsrc=DEVICE_MAC, pdst=GATEWAY_IP, hwdst=GATEWAY_MAC),
              iface=IFACE, count=5, verbose=0)
        log("ARP 원복 완료")
    except Exception as e:
        log("ARP 원복 오류(무시):", e)


def shutdown(*_):
    log("종료 신호 수신 — 정리 중")
    stop.set()


signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)

enable_forward()
add_iptables()
log("리다이렉트 시작 — 기기가 재접속하면 로컬 플러그인(:%d)으로 붙습니다." % LOCAL_PORT)
log("빠른 활성화 팁: 에너톡 기기를 한 번 재부팅(전원 뺐다 꽂기)하면 즉시 잡힙니다.")

th = threading.Thread(target=spoof_loop, daemon=True)
th.start()
stop.wait()
th.join(timeout=3)
del_iptables()
restore()
log("정리 완료 — 기기는 클라우드로 자동 복귀합니다.")
