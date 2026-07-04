'use strict';

/**
 * Config UI X 커스텀 UI 서버.
 * 설정 화면에서 "월별 사용량(최근 1년)" 을 조회하는 요청을 처리한다.
 * 폼에 입력된 자격증명(email/password)으로 클라우드 히스토리를 읽어 월별 kWh/요금을 돌려준다.
 */

const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');
const EnerTalkApi = require('../lib/EnerTalkApi.js');

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/monthly', this.getMonthly.bind(this));
    this.ready();
  }

  async getMonthly(payload) {
    const cfg = payload || {};
    if (!cfg.email || !cfg.password) {
      throw new Error('이메일/비밀번호를 먼저 입력하세요.');
    }
    const api = new EnerTalkApi({
      email: cfg.email,
      password: cfg.password,
      clientId: cfg.clientId || undefined,
      clientSecret: cfg.clientSecret || undefined,
    });

    const sites = await api.getSites();
    if (!Array.isArray(sites) || !sites.length || !sites[0].id) {
      throw new Error('연결된 site 가 없습니다.');
    }
    const sid = sites[0].id;

    const now = Date.now();
    const start = now - 395 * 24 * 3600 * 1000; // 약 13개월
    const periodic = await api.getPeriodic(sid, 'month', start, now);
    const billing = await api.getBilling(sid).catch(() => null);

    const KST = 9 * 3600 * 1000;
    const months = ((periodic && periodic.items) || []).map((it) => ({
      month: new Date((it.timestamp || 0) + KST).toISOString().slice(0, 7),
      kwh: Math.round(((it.usage || 0) / 1e6) * 10) / 10,
      charge: (it.bill && it.bill.charge != null) ? it.bill.charge : null,
    })).filter((m) => m.kwh > 0 || m.charge != null);

    const current = billing ? {
      kwh: Math.round(((billing.usage || 0) / 1e6) * 10) / 10,
      charge: (billing.bill && billing.bill.charge != null) ? billing.bill.charge : null,
    } : null;

    return { months, current };
  }
}

(() => new UiServer())();
