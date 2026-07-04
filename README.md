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

Config UI X 의 커스텀 설정 화면(`EnerTalkKm81`)에서 이메일/비밀번호를 입력하고 **"연결 테스트"**
로 확인한 뒤 저장하거나, `config.json` 의 `platforms` 에 아래를 추가합니다.

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
| `email` / `password` | (필수) | 에너톡 앱 로그인 자격증명 |
| `powerSensorName` | `실시간 전력` | 실시간 W 액세서리 이름 |
| `usageSensorName` | `당월 사용량` | 당월 kWh 액세서리 이름 |
| `pollingInterval` | 30 | 실시간 W 조회 주기(초, 권장 30~60) |
| `billingInterval` | 300 | 당월 kWh/요금 조회 주기(초) |
| `exposeOutlet` | false | Eve 그래프용 콘센트 추가(홈 앱에 동작 없는 토글 생김) |
| `name` | `소비전력` | (exposeOutlet 시) 콘센트 액세서리 이름 |
| `clientId` / `clientSecret` | (선택) | 비우면 앱 기본값 사용 |

계정에 연결된 site 가 여러 개면 각각 액세서리 세트로 등록됩니다.

## 동작 방식

1. `POST https://auth2.enertalk.com/token` — `grant_type=password` 로 access_token 발급
   (만료 시 자동 재발급, 401 시 1회 재로그인).
2. `GET https://api2.enertalk.com/sites` — site 목록.
3. 주기적으로 `/sites/{id}/usages/realtime` (실시간) 과 `/usages/billing` (당월 누적) 폴링.

## 보안 메모

- 플러그인이 사용하는 client_id/secret 은 에너톡 앱(APK)에 공개적으로 포함된 값이라
  노출돼도 계정 위험과 무관합니다.
- **에너톡 계정 비밀번호**는 `config.json` 에 평문 저장되니, Homebridge 호스트 접근 권한을
  신뢰할 수 있는 환경에서만 사용하세요.

## 라이선스

MIT
