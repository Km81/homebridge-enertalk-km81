/*
 * Homebridge Custom UI 서버 (ESM).
 *
 * 설정 화면에서 '연결 테스트' 버튼을 누르면, 입력한 이메일/비밀번호로 EnerTalk 클라우드에
 * 로그인해 site 목록과 현재 실시간값/당월 누적을 조회해 돌려준다. 실제 인증이 되는지,
 * 어느 site 가 잡히는지 저장 전에 바로 확인할 수 있다.
 *
 * @homebridge/plugin-ui-utils v2 는 ESM 전용이라 이 파일도 ESM 으로 작성한다
 * (homebridge-ui/package.json 의 "type":"module"). 본체 플러그인(index.js/lib)은
 * CommonJS 이며 createRequire 로 지연 로드한다.
 */

import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function round(n, d) {
  const f = Math.pow(10, d);
  return Math.round(Number(n || 0) * f) / f;
}

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/test', this.handleTest.bind(this));
    this.ready();
  }

  async handleTest(payload) {
    const { email, password, clientId, clientSecret } = payload || {};
    if (!email || !password) {
      return { ok: false, error: '이메일과 비밀번호를 입력하세요.' };
    }
    try {
      // require 실패까지 포함해 어떤 예외든 항상 응답을 돌려준다(클라이언트 무한대기 방지).
      const EnerTalkApi = require('../lib/EnerTalkApi.js');
      const client = new EnerTalkApi({ email, password, clientId, clientSecret });
      await client.login();

      const sitesRaw = await client.getSites();
      const sites = Array.isArray(sitesRaw)
        ? sitesRaw.map((s) => ({ id: s.id, name: s.name || s.id }))
        : [];

      let realtime = null;
      let billing = null;
      if (sites.length) {
        try {
          const rt = await client.getRealtime(sites[0].id);
          realtime = {
            watts: round(EnerTalkApi.toWatts(rt.activePower), 1),
            volts: round(EnerTalkApi.toVolts(rt.voltage), 1),
            amps: round(EnerTalkApi.toAmps(rt.current), 2),
          };
        } catch (e) { /* 실시간 실패는 치명적이지 않음 */ }
        try {
          const b = await client.getBilling(sites[0].id);
          billing = {
            kwh: round(EnerTalkApi.toKwh(b.usage), 2),
            charge: b && b.bill ? b.bill.charge : null,
          };
        } catch (e) { /* billing 실패도 무시 */ }
      }

      return { ok: true, sites, realtime, billing };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }
}

(() => new UiServer())();
