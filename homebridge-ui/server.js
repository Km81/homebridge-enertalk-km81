'use strict';

/**
 * Config UI X 커스텀 UI 서버.
 * 설정 화면에서 "월별 사용량(최근 1년)" 을 조회하는 요청을 처리한다.
 * 폼에 입력된 자격증명(email/password)으로 클라우드 히스토리를 읽어 월별 kWh/요금을 돌려준다.
 */

const fs = require('fs');
const path = require('path');
const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');
const EnerTalkApi = require('../lib/EnerTalkApi.js');

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/monthly', this.getMonthly.bind(this));
    this.onRequest('/daily', this.getDaily.bind(this));
    this.ready();
  }

  /** 플러그인 상태 파일(enertalk-km81-monthly.json) 전체를 읽는다. */
  _readState() {
    try {
      const file = path.join(this.homebridgeStoragePath || '.', 'enertalk-km81-monthly.json');
      return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch (e) { return {}; }
  }

  /** 플러그인이 매월 마감 시 기록한 로컬 히스토리 {month: kwh}. (로컬 모드에서 누적) */
  _readLocalHistory() {
    const out = {};
    const st = this._readState();
    for (const h of (st.history || [])) if (h && h.month) out[h.month] = h.kwh;
    return out;
  }

  async getMonthly(payload) {
    const cfg = payload || {};
    const round1 = (n) => Math.round((n || 0) * 10) / 10;
    const KST = 9 * 3600 * 1000;

    // 1) 로컬 기록(플러그인이 매월 검침일마다 쌓은 값) — 정확·클라우드 독립
    const merged = this._readLocalHistory();

    // 2) 클라우드(자격증명 있으면): 당월(현재까지) + 과거 월(0 아닌 것만 보강)
    let current = null;
    if (cfg.email && cfg.password) {
      try {
        const api = new EnerTalkApi({
          email: cfg.email, password: cfg.password,
          clientId: cfg.clientId || undefined, clientSecret: cfg.clientSecret || undefined,
        });
        const sites = await api.getSites();
        if (!Array.isArray(sites) || !sites.length || !sites[0].id) throw new Error('연결된 site 가 없습니다.');
        const sid = sites[0].id;
        const billing = await api.getBilling(sid).catch(() => null);
        if (billing) current = { kwh: round1((billing.usage || 0) / 1e6) };
        const now = Date.now();
        const periodic = await api.getPeriodic(sid, 'month', now - 395 * 24 * 3600 * 1000, now).catch(() => null);
        for (const it of ((periodic && periodic.items) || [])) {
          const m = new Date((it.timestamp || 0) + KST).toISOString().slice(0, 7);
          const k = round1((it.usage || 0) / 1e6);
          if (k > 0 && merged[m] == null) merged[m] = k; // 로컬 기록이 없는 월만 클라우드로 채움
        }
      } catch (e) {
        // 클라우드 실패해도 로컬 기록은 보여준다. 로컬도 없으면 오류 전달.
        if (!Object.keys(merged).length) throw e;
      }
    }

    const months = Object.keys(merged).sort().map((m) => ({ month: m, kwh: round1(merged[m]) }));
    return { months, current };
  }

  /** 플러그인이 매일 자정(KST) 마감 시 기록한 로컬 일별 히스토리 {date: kwh}. */
  _readLocalDaily() {
    const out = {};
    const st = this._readState();
    for (const h of (st.dailyHistory || [])) if (h && h.date) out[h.date] = h.kwh;
    return out;
  }

  /** 오늘(현재까지) 사용량 — 영속된 카운터로 산출(클라우드 없이도 동작). */
  _localToday() {
    const st = this._readState();
    const KST = 9 * 3600 * 1000;
    if (st.lastCounter_mWh == null || st.dayStartCounter_mWh == null || st.dayStartMs == null) return null;
    const d = new Date(Date.now() + KST);
    const curDayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - KST;
    if (st.dayStartMs !== curDayStart) return null; // 자정 지난 뒤 아직 새 프레임 없음 → 보류
    const k = (st.lastCounter_mWh - st.dayStartCounter_mWh) / 1e6;
    return k >= 0 ? k : null;
  }

  async getDaily(payload) {
    const cfg = payload || {};
    const round2 = (n) => Math.round((n || 0) * 100) / 100;
    const KST = 9 * 3600 * 1000;

    // 1) 로컬 일별 기록 — 클라우드 독립
    const merged = this._readLocalDaily();

    // 2) 오늘(현재까지): 로컬 카운터 우선, 없으면 클라우드 당월/실시간에서는 못 얻으므로 클라우드 일별의 오늘값 사용
    let today = this._localToday();
    today = today != null ? { kwh: round2(today) } : null;

    // 3) 클라우드(자격증명 있으면): 최근 ~35일 일별로 로컬 공백 보강 + 오늘값 폴백
    if (cfg.email && cfg.password) {
      try {
        const api = new EnerTalkApi({
          email: cfg.email, password: cfg.password,
          clientId: cfg.clientId || undefined, clientSecret: cfg.clientSecret || undefined,
        });
        const sites = await api.getSites();
        if (!Array.isArray(sites) || !sites.length || !sites[0].id) throw new Error('연결된 site 가 없습니다.');
        const sid = sites[0].id;
        const now = Date.now();
        const periodic = await api.getPeriodic(sid, 'day', now - 35 * 24 * 3600 * 1000, now).catch(() => null);
        const todayStr = new Date(now + KST).toISOString().slice(0, 10);
        for (const it of ((periodic && periodic.items) || [])) {
          const day = new Date((it.timestamp || 0) + KST).toISOString().slice(0, 10);
          const k = round2((it.usage || 0) / 1e6);
          if (day === todayStr) {
            if (today == null && k > 0) today = { kwh: k }; // 로컬 오늘값 없을 때만 클라우드로
            continue; // 오늘은 히스토리 표에 넣지 않음(별도 '오늘' 행)
          }
          if (k > 0 && merged[day] == null) merged[day] = k; // 로컬 기록 없는 날만 클라우드로 채움
        }
      } catch (e) {
        if (!Object.keys(merged).length && !today) throw e;
      }
    }

    const days = Object.keys(merged).sort().map((d) => ({ date: d, kwh: round2(merged[d]) }));
    return { days, today };
  }
}

(() => new UiServer())();
