'use strict';

/**
 * EnerTalk cloud API client.
 *
 * 인증은 앱(kr.encored.enertalk) 번들에 박혀 있는 공개 client 자격증명 + password grant 를
 * 그대로 사용한다. 개발자 포털(developer.enertalk.com)이 폐쇄됐어도 auth2/api2 는 살아있어
 * 이메일/비밀번호만으로 access_token 을 발급받을 수 있다.
 *
 *   POST https://auth2.enertalk.com/token
 *     Authorization: Basic base64(clientId:clientSecret)
 *     { "grant_type": "password", "credentials": { "email", "password" } }
 *
 * 데이터:
 *   GET https://api2.enertalk.com/sites
 *   GET https://api2.enertalk.com/sites/{siteId}/usages/realtime   (accept-version: 2.0.0)
 *   GET https://api2.enertalk.com/sites/{siteId}/usages/billing    (accept-version: 2.0.0)
 *
 * 원시 값 단위(실측 확인):
 *   activePower / billingActivePower : mW   → W  = /1000
 *   voltage                          : mV   → V  = /1000
 *   current                          : mA   → A  = /1000
 *   billing.usage / positiveEnergy   : mWh  → kWh= /1e6
 *   bill.charge                      : KRW (원, 정수)
 */

const DEFAULT_CLIENT_ID = 'a29hbnNhbmdAZ21haWwuY29tX0VuZXJ0YWxrS3I=';
const DEFAULT_CLIENT_SECRET = 'ak1bb5bh00s48d8hz5zw9r882b5bf36y34x6mk1';
const AUTH_BASE = 'https://auth2.enertalk.com';
const API_BASE = 'https://api2.enertalk.com';

class EnerTalkApi {
  constructor({ email, password, clientId, clientSecret, log } = {}) {
    if (!email || !password) {
      throw new Error('EnerTalkApi: email 과 password 는 필수입니다.');
    }
    this.email = email;
    this.password = password;
    this.clientId = clientId || DEFAULT_CLIENT_ID;
    this.clientSecret = clientSecret || DEFAULT_CLIENT_SECRET;
    this.log = log || console;

    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0;
    this._authPromise = null;
    this._failCount = 0;        // 연속 로그인 실패 수
    this._cooldownUntil = 0;    // 이 시각 전엔 재로그인 금지(백오프)
  }

  _basicAuth() {
    return 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
  }

  async _fetch(url, opts = {}, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  _applyToken(data) {
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token || this.refreshToken || null;
    const expiresIn = Number(data.expires_in) || 3600;
    this.expiresAt = Date.now() + Math.max(60, expiresIn - 60) * 1000;
    this._failCount = 0;
    this._cooldownUntil = 0;
  }

  _noteAuthFailure() {
    this._failCount += 1;
    // 지수 백오프(최소 30초, 최대 10분) — 연속 실패 시 로그인 폭주/계정잠금 방지
    const backoff = Math.min(600, 30 * Math.pow(2, this._failCount - 1)) * 1000;
    this._cooldownUntil = Date.now() + backoff;
  }

  /** refresh_token 으로 access_token 갱신. 실패하면 password grant 로 폴백. */
  async _refresh() {
    if (!this.refreshToken) return this.login();
    const res = await this._fetch(`${AUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Authorization': this._basicAuth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: this.refreshToken }),
    }).catch(() => null);
    if (res && res.ok) {
      const data = await res.json().catch(() => null);
      if (data && data.access_token) { this._applyToken(data); return data; }
    }
    // refresh 실패 → 전체 로그인
    this.refreshToken = null;
    return this.login();
  }

  /** password grant 로 새 토큰 발급. 동시 호출은 하나로 합친다. 연속 실패 시 백오프. */
  async login() {
    if (this._authPromise) return this._authPromise;
    if (Date.now() < this._cooldownUntil) {
      const sec = Math.ceil((this._cooldownUntil - Date.now()) / 1000);
      throw new Error(`EnerTalk 로그인 백오프 중(연속 실패 ${this._failCount}회, ${sec}초 후 재시도 허용)`);
    }
    this._authPromise = (async () => {
      const res = await this._fetch(`${AUTH_BASE}/token`, {
        method: 'POST',
        headers: {
          'Authorization': this._basicAuth(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'password',
          credentials: { email: this.email, password: this.password },
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this._noteAuthFailure();
        throw new Error(`EnerTalk 로그인 실패: HTTP ${res.status} ${text}`.trim());
      }
      const data = await res.json();
      if (!data || !data.access_token) {
        this._noteAuthFailure();
        throw new Error('EnerTalk 로그인 응답에 access_token 이 없습니다.');
      }
      this._applyToken(data);
      return data;
    })().finally(() => { this._authPromise = null; });
    return this._authPromise;
  }

  async _ensureToken() {
    if (!this.accessToken || Date.now() >= this.expiresAt) {
      // 만료면 refresh 우선(가능 시) → password grant 폭주 감소
      if (this.accessToken && this.refreshToken) await this._refresh();
      else await this.login();
    }
  }

  async _apiGet(path) {
    await this._ensureToken();
    const doRequest = () => this._fetch(`${API_BASE}${path}`, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'accept-version': '2.0.0',
      },
    });

    let res = await doRequest();
    if (res.status === 401) {
      // 토큰 무효 → refresh(가능 시)/재로그인 후 1회 재시도. 백오프 중이면 login()이 throw.
      this.expiresAt = 0;
      await this._refresh();
      res = await doRequest();
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`EnerTalk API ${path} 실패: HTTP ${res.status} ${text}`.trim());
    }
    return res.json();
  }

  /** 계정에 연결된 site 목록. [{ id, name, ... }] */
  getSites() {
    return this._apiGet('/sites');
  }

  /** 실시간 사용량(원시 단위). */
  getRealtime(siteId) {
    return this._apiGet(`/sites/${encodeURIComponent(siteId)}/usages/realtime`);
  }

  /** 검침일 기준 당월 누적 사용량 + 요금. */
  getBilling(siteId) {
    return this._apiGet(`/sites/${encodeURIComponent(siteId)}/usages/billing`);
  }

  // ── 단위 변환 헬퍼 ───────────────────────────────────────────────
  static toWatts(raw) { return Number(raw || 0) / 1000; }
  static toVolts(raw) { return Number(raw || 0) / 1000; }
  static toAmps(raw) { return Number(raw || 0) / 1000; }
  static toKwh(rawMilliWh) { return Number(rawMilliWh || 0) / 1e6; }
}

EnerTalkApi.DEFAULT_CLIENT_ID = DEFAULT_CLIENT_ID;
EnerTalkApi.DEFAULT_CLIENT_SECRET = DEFAULT_CLIENT_SECRET;

module.exports = EnerTalkApi;
