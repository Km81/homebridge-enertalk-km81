'use strict';

/**
 * Config UI X 커스텀 UI 서버.
 * 설정 화면의 "월별 사용량(최근 1년)" · "일별 사용량(최근 30일)" 조회를 처리한다.
 *
 * 원칙: 조회는 100% 로컬(플러그인이 파일에 쌓은 값)만 읽는다. 클라우드는 절대 호출하지 않는다.
 *       → 즉시 응답, 클라우드가 죽어도/느려도 화면이 멈추지 않는다.
 *       과거 데이터(로컬 기록 이전의 날/달)는 플러그인이 백그라운드에서 클라우드로 로컬 파일에
 *       backfill 해두므로, 여기서는 그 로컬 파일만 읽으면 된다.
 */

const fs = require('fs');
const path = require('path');
const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');

const KST = 9 * 3600 * 1000;

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    // 월별·일별을 한 번의 요청으로 반환(동시 요청 회피). /monthly·/daily 는 하위호환용 유지.
    this.onRequest('/usage', this.getUsage.bind(this));
    this.onRequest('/monthly', this.getMonthly.bind(this));
    this.onRequest('/daily', this.getDaily.bind(this));
    this.ready();
  }

  /** 월별+일별을 한 응답으로. (단일 요청 → Config UI X 동시요청 이슈 회피) */
  async getUsage() {
    return { monthly: await this.getMonthly(), daily: await this.getDaily() };
  }

  /** 플러그인 상태 파일(enertalk-km81-monthly.json) 전체를 읽는다. */
  _readState() {
    try {
      const file = path.join(this.homebridgeStoragePath || '.', 'enertalk-km81-monthly.json');
      return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch (e) { return {}; }
  }

  /** now(KST) 가 속한 검침주기 시작(ms). 플러그인 MonthlyTracker._periodStartFor 와 동일 규칙. */
  _periodStartFor(nowMs, meteringDay) {
    const md = (meteringDay >= 1 && meteringDay <= 31) ? meteringDay : 1;
    const d = new Date(nowMs + KST);
    const y = d.getUTCFullYear(); const m = d.getUTCMonth(); const day = d.getUTCDate();
    const clamp = (yy, mm) => Math.min(md, new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate());
    const thisMd = clamp(y, m);
    if (day >= thisMd) return Date.UTC(y, m, thisMd) - KST;
    return Date.UTC(y, m - 1, clamp(y, m - 1)) - KST;
  }

  /** 당월(현재까지) — 로컬 카운터 산출 우선, 없으면(클라우드 모드) 클라우드 billing 값.
   *  단, 저장된 기준선이 '현재' 검침주기의 것일 때만 사용(다운 중 검침일을 넘겼으면 전월 총량이
   *  당월로 표시되는 것을 방지 — 라이브 플러그인만 롤오버하므로 파일값이 낡을 수 있다). */
  _localMonthCurrent() {
    const st = this._readState();
    if (st.lastCounter_mWh != null && st.periodStartCounter_mWh != null && st.periodStartMs != null) {
      const curStart = this._periodStartFor(Date.now(), st.effectiveMeteringDay);
      if (st.periodStartMs === curStart) {
        const k = (st.lastCounter_mWh - st.periodStartCounter_mWh) / 1e6;
        if (k >= 0) return k;
      }
    }
    return st.cloudMonthCurrent != null ? st.cloudMonthCurrent : null;
  }

  async getMonthly() {
    const round1 = (n) => Math.round((n || 0) * 10) / 10;
    const st = this._readState();
    const merged = {};
    for (const h of (st.history || [])) if (h && h.month) merged[h.month] = h.kwh;
    const cur = this._localMonthCurrent();
    const current = cur != null ? { kwh: round1(cur) } : null;
    // 라벨('최근 1년')에 맞춰 최근 12개월만 반환.
    const months = Object.keys(merged).sort().slice(-12).map((m) => ({ month: m, kwh: round1(merged[m]) }));
    return { months, current };
  }

  /** 오늘(현재까지) — 로컬 카운터 산출 우선, 없으면(클라우드 모드) 클라우드 일별 오늘값. */
  _localToday() {
    const st = this._readState();
    if (st.lastCounter_mWh != null && st.dayStartCounter_mWh != null && st.dayStartMs != null) {
      const d = new Date(Date.now() + KST);
      const curDayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - KST;
      if (st.dayStartMs === curDayStart) {
        const k = (st.lastCounter_mWh - st.dayStartCounter_mWh) / 1e6;
        if (k >= 0) return k;
      }
    }
    return st.cloudToday != null ? st.cloudToday : null;
  }

  async getDaily() {
    const round2 = (n) => Math.round((n || 0) * 100) / 100;
    const st = this._readState();
    const merged = {};
    for (const h of (st.dailyHistory || [])) if (h && h.date) merged[h.date] = h.kwh;
    const t = this._localToday();
    const today = t != null ? { kwh: round2(t) } : null;
    // 라벨('최근 30일')에 맞춰 최근 30일만 반환.
    const days = Object.keys(merged).sort().slice(-30).map((d) => ({ date: d, kwh: round2(merged[d]) }));
    return { days, today };
  }
}

(() => new UiServer())();
