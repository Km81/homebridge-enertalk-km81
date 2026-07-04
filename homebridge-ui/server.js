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
    this.ready();
  }

  /** 플러그인이 매월 마감 시 기록한 로컬 히스토리 {month: kwh}. (로컬 모드에서 누적) */
  _readLocalHistory() {
    const out = {};
    try {
      const file = path.join(this.homebridgeStoragePath || '.', 'enertalk-km81-monthly.json');
      const st = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const h of (st.history || [])) if (h && h.month) out[h.month] = h.kwh;
    } catch (e) { /* 없으면 빈 값 */ }
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
}

(() => new UiServer())();
