# homebridge-enertalk-km81

EnerTalk(Encored) 전력 미터를 Homebridge/HomeKit 으로 노출하는 플러그인.

에너톡 제조사 앱은 앱스토어에서 내려갔고 개발자 포털(developer.enertalk.com)도 폐쇄됐지만,
기기는 여전히 클라우드로 실시간 데이터를 올리고 있고 `api2.enertalk.com` / `auth2.enertalk.com`
은 살아있습니다. 이 플러그인은 **에너톡 앱 로그인 이메일/비밀번호**만으로 토큰을 발급받아
데이터를 가져옵니다. (별도 개발자 등록 불필요)

> 참고: 에너톡 앱 화면에서 사용량이 0 으로만 보이더라도, 그건 앱의 유료 "베이직 서비스"
> 구독이 만료돼 **앱 UI 만** 가려진 것입니다. 원시 API 는 실시간 값을 그대로 내려줍니다.

## 노출되는 값

기본은 **Outlet 서비스 + Eve 커스텀 특성**으로 노출됩니다. **Eve 앱**에서 확인하세요.

| 특성 | 의미 | 원시 필드 |
|---|---|---|
| Consumption (W) | 실시간 소비전력 | `activePower` /1000 |
| Total Consumption (kWh) | 당월 누적(검침일 기준) | `usage` /1e6 |
| Voltage (V) | 전압 | `voltage` /1000 |
| Electric Current (A) | 전류 | `current` /1000 |

Eve 앱은 실시간 W 를 자동으로 히스토리 그래프로 쌓아줍니다.

### Apple '홈' 앱에서 숫자를 보고 싶다면

홈킷에는 전력 표준 특성이 없어 Apple 기본 '홈' 앱은 위 값을 숫자로 못 보여줍니다.
`exposeLightSensors` 를 켜면 **조도센서(lux) 트릭**으로 실시간 W 와 당월 kWh 를 추가 노출해
홈 앱 기본화면에서 숫자를 볼 수 있습니다 (단위는 lux 로 표시됨).

## 설치

```bash
npm install -g homebridge-enertalk-km81
```

(이 저장소 서브폴더에서 직접 쓰는 경우: `npm install -g ./homebridge-enertalk-km81`)

## 설정

Homebridge UI 의 플러그인 설정 화면(`EnerTalkKm81`)에서 이메일/비밀번호를 입력하거나,
`config.json` 의 `platforms` 에 아래를 추가합니다.

```json
{
  "platform": "EnerTalkKm81",
  "name": "EnerTalk",
  "email": "you@example.com",
  "password": "your-enertalk-password",
  "pollingInterval": 30,
  "billingInterval": 300,
  "exposeLightSensors": false
}
```

| 항목 | 기본 | 설명 |
|---|---|---|
| `email` / `password` | (필수) | 에너톡 앱 로그인 자격증명 |
| `pollingInterval` | 30 | 실시간 W 조회 주기(초) |
| `billingInterval` | 300 | 당월 누적 kWh/요금 조회 주기(초) |
| `exposeLightSensors` | false | 홈 앱용 조도센서 미러 노출 |
| `clientId` / `clientSecret` | (선택) | 비우면 앱 기본값 사용 |

계정에 연결된 site 가 여러 개면 각각 액세서리로 등록됩니다.

## 동작 방식

1. `POST https://auth2.enertalk.com/token` — `grant_type=password` 로 access_token 발급
   (만료 시 자동 재발급, 401 시 1회 재로그인).
2. `GET https://api2.enertalk.com/sites` — site 목록.
3. 주기적으로 `/sites/{id}/usages/realtime` (실시간) 과 `/usages/billing` (당월 누적) 폴링.

## 보안 메모

- 플러그인이 사용하는 client_id/secret 은 에너톡 앱(APK)에 공개적으로 포함된 값이라
  노출돼도 계정 위험과 무관합니다.
- 다만 **에너톡 계정 비밀번호**는 `config.json` 에 평문 저장되니, Homebridge 호스트
  접근 권한을 신뢰할 수 있는 환경에서만 사용하세요.

## 라이선스

MIT
