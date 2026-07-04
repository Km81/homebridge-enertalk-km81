# enertalk-local — 로컬 리다이렉트 (라우터 무접촉)

에너톡 기기가 클라우드(`eddie-ext.encoredtech.com:5010`)로 올리는 실시간 스트림을,
**DNS/라우터 설정 변경 없이** 같은 LAN 의 홈브릿지 호스트(플러그인 로컬 서버 `:5010`)로
돌려주는 작은 서비스입니다. `homebridge-enertalk-km81` 의 **로컬 모드**와 짝으로 씁니다.

## 동작 원리

- 대상 **기기 1대**에 대해서만 ARP 스푸핑(게이트웨이인 척)해서 그 기기의 트래픽을
  이 호스트로 끌어옵니다. **다른 기기·전체 와이파이는 건드리지 않습니다.**
- `iptables REDIRECT` 로 그 기기의 `:5010` 트래픽만 로컬 플러그인으로 DNAT 합니다.
- 기기는 서버 인증서를 검증하지 않으므로, 플러그인의 self-signed TLS 로 그대로 붙어
  실시간 데이터를 올립니다.

## 사전 요구

- 홈브릿지에 `homebridge-enertalk-km81` **로컬 모드**가 켜져 있고 `:5010` 리스닝 중일 것.
  (홈브릿지 컨테이너가 `network_mode: host` 면 그대로 호스트 `:5010` 에 뜹니다.)
- 이 서비스는 **홈브릿지와 같은 호스트(NAS)** 에서 실행.

## 설치 (UGREEN/시놀로지 등 Docker)

```bash
# 예: /volume1/docker/enertalk-local 에 이 폴더(redirect.py, Dockerfile, docker-compose.yml) 복사
cd /volume1/docker/enertalk-local

# docker-compose.yml 의 DEVICE_IP / DEVICE_MAC 를 본인 기기값으로 수정
#   DEVICE_IP  = 에너톡 기기 IP
#   DEVICE_MAC = 에너톡 기기 MAC

docker compose up -d --build
docker compose logs -f
```

로그에 다음이 보이면 정상입니다:

```
[enertalk-local] iptables REDIRECT 적용
[enertalk-local] 리다이렉트 시작 — 기기가 재접속하면 로컬 플러그인(:5010)으로 붙습니다.
```

## 활성화 (즉시 잡기)

기기는 기존 클라우드 연결을 물고 있으면 한동안 재접속을 안 해서 바로 안 잡힐 수 있습니다.
**에너톡 기기를 한 번 재부팅(전원 뺐다 꽂기)** 하면, 부팅하며 새로 접속할 때 깔끔하게 잡힙니다.
그 뒤 홈브릿지 로그에 `[EnerTalk][local] … (기기 직수신)` 이 뜨면 성공입니다.

## 정지 / 원복

```bash
docker compose down
```

컨테이너가 내려가면 ARP 를 원상복구하고 iptables 규칙을 제거합니다.
기기는 자동으로 클라우드 연결로 복귀합니다(무해).

## 안전성 메모

- ARP 스푸핑은 **대상 기기 1대 ↔ 게이트웨이** 이 한 쌍에만 적용됩니다. 다른 기기/전체
  네트워크에는 영향이 없습니다.
- 이 서비스가 멈추면 그 기기만 잠깐 끊겼다가 클라우드로 자동 복귀합니다.
- 플러그인의 **자동 폴백**(로컬 끊김 → 클라우드 → 복구 시 원복)이 순간 블립을 덮어주므로,
  홈킷에서는 값이 끊기지 않습니다. 홈브릿지 로그의 `⤵ 폴백 / ⤴ 복귀` 로 안정성을
  수치(횟수·끊긴 시간)로 확인할 수 있습니다.

## 문제 해결

- **`iptables 적용 실패`** 로그가 뜨면, 컨테이너의 iptables 백엔드(nft/legacy)가 호스트와
  다를 수 있습니다. 그 경우 호스트(NAS SSH, root)에서 직접 규칙을 넣으세요:
  ```bash
  sysctl -w net.ipv4.ip_forward=1
  iptables -t nat -A PREROUTING -s <DEVICE_IP> -p tcp --dport 5010 -j REDIRECT --to-ports 5010
  ```
  (컨테이너는 ARP 스푸핑만 담당하게 됩니다. 제거는 `-A` 를 `-D` 로.)
- **MAC 확인 실패**: `DEVICE_MAC` 을 명시하고, 필요하면 `GATEWAY_IP` 도 지정하세요.
- **기기가 안 잡힘**: 기기 재부팅으로 강제 재접속을 유도하세요.
