'use strict';

/**
 * Config UI X 커스텀 UI 서버.
 * 설정 화면에서 "월별 사용량(최근 1년)" · "일별 사용량(최근 30일)" 을 조회한다.
 *
 * 원칙: 로컬 데이터(플러그인이 파일에 쌓은 값)를 먼저 즉시 반환할 수 있게 하고,
 *       클라우드 보강은 짧은 타임아웃 안에서만 시도한다(느리면 건너뛰고 로컬만 표시).
 *       → 로컬 모드에서 기기가 리다이렉트돼 클라우드가 느려도 화면이 멈추지 않는다.
 */

const fs = require('fs');
const path = require('path');
const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');
const EnerTalkApi = require('../lib/EnerTalkApi.js');

const KST = 9 * 3600 * 1000;
const CLOUD_TIMEOUT_MS = 8000; // 클라우드 보강 총 예산 — 넘으면 로컬만 반환

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

  /** promise 를 ms 안에 못 끝내면 reject. (클라우드가 끝까지 안 오면 로컬로 폴백) */
  _withTimeout(promise, ms) {
    let timer;
    const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('cloud-timeout')), ms); });
    return Promise.race([promise, t]).finally(() => clearTimeout(timer));
  }

  // ── 월별 ──────────────────────────────────────────────────────────
  _readLocalHistory() {
    const out = {};
    for (const h of (this._readState().history || [])) if (h && h.month) out[h.month] = h.kwh;
    return out;
  }

  /** 당월(현재까지) 로컬 산출 — 검침주기 기준선 카운터와 최근 카운터로. 클라우드 불필요. */
  _localMonthCurrent() {
    const st = this._readState();
    if (st.lastCounter_mWh == null || st.periodStartCounter_mWh == null) return null;
    const k = (st.lastCounter_mWh - st.periodStartCounter_mWh) / 1e6;
    return k >= 0 ? k : null;
  }

  async getMonthly(payload) {
    const cfg = payload || {};
    const round1 = (n) => Math.round((n || 0) * 10) / 10;

    // 1) 로컬 먼저 — 과거 월 기록 + 당월(현재까지)
    const merged = this._readLocalHistory();
    const localCur = this._localMonthCurrent();
    let current = localCur != null ? { kwh: round1(localCur) } : null;
    let cloudOk = false;

    // 2) 클라우드 보강(타임아웃 안에서만): 당월 폴백 + 과거 월(0 아닌 것)
    if (cfg.email && cfg.password) {
      await this._withTimeout((async () => {
        const api = new EnerTalkApi({
          email: cfg.email, password: cfg.password,
          clientId: cfg.clientId || undefined, clientSecret: cfg.clientSecret || undefined,
        });
        const sites = await api.getSites();
        if (!Array.isArray(sites) || !sites.length || !sites[0].id) throw new Error('연결된 site 가 없습니다.');
        const sid = sites[0].id;
        const now = Date.now();
        const billing = await api.getBilling(sid).catch(() => null);
        if (billing && current == null) current = { kwh: round1((billing.usage || 0) / 1e6) };
        const periodic = await api.getPeriodic(sid, 'month', now - 395 * 24 * 3600 * 1000, now).catch(() => null);
        for (const it of ((periodic && periodic.items) || [])) {
          const m = new Date((it.timestamp || 0) + KST).toISOString().slice(0, 7);
          const k = round1((it.usage || 0) / 1e6);
          if (k > 0 && merged[m] == null) merged[m] = k;
        }
        cloudOk = true;
      })(), CLOUD_TIMEOUT_MS).catch(() => { /* 느리거나 실패 → 로컬만 */ });
    }

    const months = Object.keys(merged).sort().map((m) => ({ month: m, kwh: round1(merged[m]) }));
    return { months, current, cloudOk };
  }

  // ── 일별 ──────────────────────────────────────────────────────────
  _readLocalDaily() {
    const out = {};
    for (const h of (this._readState().dailyHistory || [])) if (h && h.date) out[h.date] = h.kwh;
    return out;
  }

  /** 오늘(현재까지) 사용량 — 영속된 카운터로 산출(클라우드 없이도 동작). */
  _localToday() {
    const st = this._readState();
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

    // 1) 로컬 먼저 — 일별 기록 + 오늘(현재까지)
    const merged = this._readLocalDaily();
    const localToday = this._localToday();
    let today = localToday != null ? { kwh: round2(localToday) } : null;
    let cloudOk = false;

    // 2) 클라우드 보강(타임아웃 안에서만): 최근 ~35일 일별 + 오늘값 폴백
    if (cfg.email && cfg.password) {
      await this._withTimeout((async () => {
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
            if (today == null && k > 0) today = { kwh: k };
            continue; // 오늘은 별도 행
          }
          if (k > 0 && merged[day] == null) merged[day] = k;
        }
        cloudOk = true;
      })(), CLOUD_TIMEOUT_MS).catch(() => { /* 느리거나 실패 → 로컬만 */ });
    }

    const days = Object.keys(merged).sort().map((d) => ({ date: d, kwh: round2(merged[d]) }));
    return { days, today, cloudOk };
  }
}

(() => new UiServer())();
