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

  /** 당월(현재까지) — 검침주기 기준선 카운터와 최근 카운터로 로컬 산출. */
  _localMonthCurrent() {
    const st = this._readState();
    if (st.lastCounter_mWh == null || st.periodStartCounter_mWh == null) return null;
    const k = (st.lastCounter_mWh - st.periodStartCounter_mWh) / 1e6;
    return k >= 0 ? k : null;
  }

  async getMonthly() {
    const round1 = (n) => Math.round((n || 0) * 10) / 10;
    const st = this._readState();
    const merged = {};
    for (const h of (st.history || [])) if (h && h.month) merged[h.month] = h.kwh;
    const cur = this._localMonthCurrent();
    const current = cur != null ? { kwh: round1(cur) } : null;
    const months = Object.keys(merged).sort().map((m) => ({ month: m, kwh: round1(merged[m]) }));
    return { months, current };
  }

  /** 오늘(현재까지) — 오늘 자정 기준 카운터와 최근 카운터로 로컬 산출. */
  _localToday() {
    const st = this._readState();
    if (st.lastCounter_mWh == null || st.dayStartCounter_mWh == null || st.dayStartMs == null) return null;
    const d = new Date(Date.now() + KST);
    const curDayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - KST;
    if (st.dayStartMs !== curDayStart) return null; // 자정 지난 뒤 아직 새 프레임 없음 → 보류
    const k = (st.lastCounter_mWh - st.dayStartCounter_mWh) / 1e6;
    return k >= 0 ? k : null;
  }

  async getDaily() {
    const round2 = (n) => Math.round((n || 0) * 100) / 100;
    const st = this._readState();
    const merged = {};
    for (const h of (st.dailyHistory || [])) if (h && h.date) merged[h.date] = h.kwh;
    const t = this._localToday();
    const today = t != null ? { kwh: round2(t) } : null;
    const days = Object.keys(merged).sort().map((d) => ({ date: d, kwh: round2(merged[d]) }));
    return { days, today };
  }
}

(() => new UiServer())();
