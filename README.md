# homebridge-enertalk-km81

EnerTalk(Encored) 전력 미터를 Homebridge/HomeKit 으로 노출하는 플러그인 (read-only 모니터링).

에너톡 제조사 앱은 앱스토어에서 내려갔고 개발자 포털(developer.enertalk.com)도 폐쇄됐지만,
기기는 여전히 클라우드로 실시간 데이터를 올리고 있고 `api2.enertalk.com` / `auth2.enertalk.com`
은 살아있습니다. 이 플러그인은 **에너톡 앱 로그인 이메일/비밀번호**만으로 토큰을 발급받아
데이터를 가져옵니다. (별도 개발자 등록 불필요)

> 참고: 에너톡 앱 화면에서 사용량이 0 으로만 보이더라도, 그건 앱의 유료 "베이직 서비스"
> 구독이 만료돼 **앱 UI 만** 가려진 것입니다. 원시 API 는 실시간 값을 그대로 내려줍니다.

## 노출되는 액세서리

기본으로 **각각 독립된 2개 액세서리**가 등록됩니다(홈 앱에서 이름을 따로 지정/변경 가능):

| 액세서리 | HomeKit 표현 | 값 | 원시 필드 |
|---|---|---|---|
| 실시간 전력 | 조도센서(lux) | 현재 소비전력 W (룩스 숫자 = W) | `activePower` /1000 |
| 당월 사용량 | 조도센서(lux) | 당월 누적 kWh (룩스 숫자 = kWh) | `usage` /1e6 |

- HomeKit 에는 전력(W)/전력량(kWh) 표준 특성이 없어, Apple '홈' 앱에서 숫자를 바로 보여주기 위해
  **조도센서(lux) 트릭**을 씁니다. 표시 단위가 "룩스"지만 **숫자 자체가 값**입니다(예: 312룩스 = 312W).
- 두 센서에는 **Eve 커스텀 특성**(실시간 전력 센서: W·V·A / 당월 센서: kWh)도 함께 실려 있어,
  **Eve 앱**에서는 정확한 단위와 값으로 보이고 그래프(히스토리)도 쌓입니다.

### 옵션: Eve 에너지 그래프용 콘센트 (`exposeOutlet`)

`exposeOutlet` 을 켜면 Eve 앱 에너지 그래프 UI 를 위한 **Outlet 액세서리**가 추가됩니다.
Outlet 은 On 스위치 특성이 필수라 홈 앱에 토글이 보이지만 **동작은 없습니다**(read-only).
보통은 꺼두면 되고, 위 두 조도센서만으로 충분합니다.

## 설치

```bash
npm install -g homebridge-enertalk-km81
```

또는 Homebridge Config UI X 의 플러그인 검색에서 `homebridge-enertalk-km81` 설치.

## 설정

Config UI X 의 커스텀 설정 화면(`EnerTalkKm81`)에서 이메일/비밀번호를 입력하고 저장하거나,
`config.json` 의 `platforms` 에 아래를 추가합니다. 정상 연결 여부는 재시작 후 **Homebridge 로그**
의 `[EnerTalk] 로그인 성공 · 실시간 …W` 로 확인됩니다.

```json
{
  "platform": "EnerTalkKm81",
  "email": "you@example.com",
  "password": "your-enertalk-password",
  "powerSensorName": "실시간 전력",
  "usageSensorName": "당월 사용량",
  "pollingInterval": 30,
  "billingInterval": 300,
  "exposeOutlet": false
}
```

| 항목 | 기본 | 설명 |
|---|---|---|
| `email` / `password` | (클라우드 모드 필수) | 에너톡 앱 로그인 자격증명. 로컬 모드만 쓰면 생략 가능 |
| `localMode` | false | 로컬 모드(기기 직수신) 활성화 |
| `localPort` | 5010 | 로컬 모드 TLS 서버 포트 |
| `exposePower` | true | 실시간 전력(W) 액세서리 추가 여부 |
| `powerSensorName` | `실시간 전력` | 실시간 W 액세서리 이름 |
| `exposeUsage` | true | 당월 사용량(kWh) 액세서리 추가 여부 |
| `usageSensorName` | `당월 사용량` | 당월 kWh 액세서리 이름 |
| `pollingInterval` | 30 | 실시간 W 조회 주기(초, 권장 30~60) — 클라우드 모드 |
| `billingInterval` | 300 | 당월 kWh/요금 조회 주기(초) |
| `exposeOutlet` | false | Eve 그래프용 콘센트 추가(홈 앱에 동작 없는 토글 생김) |
| `name` | `소비전력` | (exposeOutlet 시) 콘센트 액세서리 이름 |
| `clientId` / `clientSecret` | (선택) | 비우면 앱 기본값 사용 |

계정에 연결된 site 가 여러 개면 각각 액세서리 세트로 등록됩니다(클라우드 모드).

## 로컬 모드 (클라우드 없이 기기 직접 수신)

에너톡 기기는 집 안 공유기에 붙어 클라우드(`eddie-ext.encoredtech.com:5010`)로
TLS 를 통해 **초당 실시간 전력/전압/전류/누적에너지**를 올립니다. 이 기기는 서버 인증서를
검증하지 않기 때문에, 이 플러그인이 **직접 그 서버 역할을 대신**할 수 있습니다.
클라우드가 완전히 사라져도 실시간 데이터가 유지됩니다.

> **왜 로컬 API 직접 폴링이 아니라 "스트림 가로채기"인가?**
> 이 기기는 정상(집 네트워크) 모드에서 **로컬 데이터 API 를 열지 않습니다.** 설치용 AT 커맨드
> 소켓(TCP 50001)은 SoftAP(설치)모드 전용이고, 포트 80(lwIP HTTP)은 잠긴 설정 서버라
> 실시간 값을 주지 않습니다. 데이터가 기기 밖으로 나가는 통로는 **클라우드 푸시(5010)** 뿐이라,
> 그 스트림을 로컬로 받는 방식이 유일한 로컬 경로입니다.

### 동작 원리

1. `localMode: true` 로 켜면 플러그인이 `localPort`(기본 5010)에 self-signed TLS 서버를 엽니다.
2. 기기가 클라우드 대신 이 호스트로 붙도록 **트래픽을 로컬로 리다이렉트**합니다(아래 두 방법 중 택1).
3. 기기가 붙으면 플러그인이 바이너리 프레임을 디코드해 실시간 전력(W)/전압(V)/전류(A) 를
   노출합니다. (프로토콜은 클라우드 REST 실측값과 교차검증 완료)

### 리다이렉트 방법 (택1)

**방법 1 — ARP 리다이렉트 (라우터 무접촉, 추천: 공유기 DNS 를 못 바꾸거나 싫을 때)**

`enertalk-local/` 폴더의 도커 서비스를 홈브릿지와 **같은 호스트(NAS)** 에서 실행합니다.
대상 기기 1대만 ARP 스푸핑해서 `:5010` 을 로컬로 돌립니다. 라우터/DNS 설정은 건드리지
않습니다. 자세한 설치는 [`enertalk-local/README.md`](enertalk-local/README.md) 참고.

```bash
cd /volume1/docker/enertalk-local        # 이 폴더에 enertalk-local/* 복사
# docker-compose.yml 의 DEVICE_IP / DEVICE_MAC 수정
docker compose up -d --build
```

> 홈브릿지 컨테이너가 `network_mode: host` 면 플러그인 `:5010` 이 호스트에 그대로 떠서
> 리다이렉트가 바로 적용됩니다. 기기를 한 번 재부팅하면 즉시 잡힙니다.

**방법 2 — DNS 오버라이드 (공유기/로컬 DNS 를 바꿀 수 있을 때)**

공유기(또는 Pi-hole/AdGuard 등 로컬 DNS)에서 아래 오버라이드 추가:

```
eddie-ext.encoredtech.com  →  <홈브릿지 호스트 IP>
```

### 설정 방법

- Config UI X 설정 화면에서 **"로컬 모드"** 체크 → SAVE → Homebridge 재시작.
- 위 리다이렉트(방법 1 또는 2) 적용.
- 정상 연결은 로그의 `[EnerTalk][local] 실시간 …W … (기기 직수신)` 로 확인됩니다.

### 자동 폴백 (로컬 ↔ 클라우드)

클라우드 자격증명(email/password)이 **함께** 설정돼 있으면, 로컬을 우선으로 쓰되
**로컬 수신이 끊기면 자동으로 클라우드로 폴백**하고, **로컬이 복구되면 자동으로 원복**합니다.
홈킷에서는 값이 끊기지 않습니다. 전환은 로그로 확인/모니터링할 수 있습니다:

```
[EnerTalk][local] ⤵ 로컬 수신 끊김(약 95초 무수신) → 클라우드로 폴백 [3번째] (복구되면 자동 원복). …
[EnerTalk][local] ⤴ 로컬 복귀 — 클라우드 폴백 42초 만에 회복 (누적 폴백 3회). …
```

- 폴백 임계값은 `localStaleSeconds`(기본 90초) 로 조정합니다.
- **누적 폴백 횟수 / 끊긴 시간**이 로그에 남으므로, 며칠 돌려보면 로컬(리다이렉트) 안정성을
  수치로 확인할 수 있습니다.

### 당월 사용량도 로컬 산출 (클라우드 독립)

기기는 "이번 달 사용량"이라는 값을 직접 주지 않습니다. 기기가 보내는 에너지 값은 **평생 누적
카운터**(positiveEnergy) 하나뿐입니다(자동차 총 주행거리계처럼). 그래서 당월 사용량은
**당월 = 현재 카운터 − 검침일 시작 시점 카운터** 로 산출합니다. 이 계산에 쓰는 값은 **전부
기기 카운터(로컬)** 이고, 검침일마다 자동으로 기준선이 리셋됩니다.

- **클라우드가 살아있을 때**: billing 으로 **검침일과 기준선을 자동 학습·보정**하고, **요금(원)**
  을 함께 표시합니다. (표시되는 kWh 는 로컬 산출값 = 클라우드 값과 일치)
- **클라우드가 죽어도**: 학습해둔 검침일 + 기기 카운터로 **당월이 계속 로컬 산출**됩니다.
  요금(원)만 못 받습니다.
- **처음부터 클라우드 없이** 쓰려면 `meteringDay`(검침일) 을 설정하세요. 그러면 클라우드 없이도
  기기 카운터만으로 당월이 나옵니다.

### 클라우드 ↔ 로컬 전환 (홈킷 재배치 없음)

로컬 모드 액세서리는 클라우드 모드와 **동일한 site 기준 UUID** 를 씁니다. 따라서 모드를
전환해도 홈킷에서 **같은 액세서리로 유지**되어 방 배치/자동화가 그대로입니다. (site 정보는
로컬에 저장되어 클라우드가 죽은 뒤에도 UUID 가 안정적으로 유지됩니다.)

### 그 밖의 참고

- 기기가 TLSv1 / AES256-SHA 를 쓰므로, 호스트 Node 가 TLSv1 을 허용해야 합니다
  (대부분의 Homebridge 환경은 기본 허용). 연결이 안 되면 로그의 TLS 오류를 확인하세요.
- 포트 5010 을 다른 서비스가 쓰고 있으면 `localPort` 를 바꾸고 리다이렉트 대상 포트도 맞추세요.
- ARP 리다이렉트의 네트워크 영향은 **대상 기기 1대**에만 국한됩니다(전체 와이파이 무영향).
  자세한 안전성 메모는 [`enertalk-local/README.md`](enertalk-local/README.md) 참고.

## 동작 방식 (클라우드 모드)

1. `POST https://auth2.enertalk.com/token` — `grant_type=password` 로 access_token 발급
   (만료 시 자동 재발급, 401 시 1회 재로그인).
2. `GET https://api2.enertalk.com/sites` — site 목록.
3. 주기적으로 `/sites/{id}/usages/realtime` (실시간) 과 `/usages/billing` (당월 누적) 폴링.

## 보안 메모

- 플러그인이 사용하는 client_id/secret 은 에너톡 앱(APK)에 공개적으로 포함된 값이라
  노출돼도 계정 위험과 무관합니다.
- **에너톡 계정 비밀번호**는 `config.json` 에 평문 저장되니, Homebridge 호스트 접근 권한을
  신뢰할 수 있는 환경에서만 사용하세요.
- 로컬 모드의 self-signed 인증서는 기기 전용 TLS 종단에만 쓰이며, 자동 생성됩니다.

## 라이선스

MIT
