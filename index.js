/**
 * homebridge-enertalk-km81
 *
 * EnerTalk(Encored) 전력 미터를 Homebridge/HomeKit 으로 노출한다(read-only 모니터링).
 * 제조사 앱/개발자포털이 사실상 종료됐지만, 기기는 여전히 클라우드로 실시간 업로드 중이고
 * api2.enertalk.com 이 살아있어, 앱 번들의 공개 client 자격증명 + password grant 로
 * 이메일/비밀번호만으로 데이터를 끌어온다.
 *
 * 노출(각각 켜고/끌 수 있음):
 *  - 실시간 전력(exposePower, 기본 on): 조도센서(lux=W) + Eve W/V/A + Eve 그래프(fakegato)
 *  - 당월 사용량(exposeUsage, 기본 on): 조도센서(lux=kWh) + Eve kWh
 *  - Eve 에너지 콘센트(exposeOutlet, 기본 off): Eve 그래프 UI 용 Outlet(+동작 없는 On 토글)
 */

'use strict';

const packageJson = require('./package.json');
const EnerTalkApi = require('./lib/EnerTalkApi.js');
const LocalServer = require('./lib/LocalServer.js');
const buildEveCharacteristics = require('./lib/EveCharacteristics.js');

const PLUGIN_NAME = packageJson.name;      // homebridge-enertalk-km81
const PLATFORM_NAME = 'EnerTalkKm81';      // config.schema.json 의 pluginAlias

module.exports = (homebridge) => {
  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, EnerTalkPlatform, true /* dynamic */);
};

class EnerTalkPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.hap = api.hap;
    this.accessories = new Map(); // uuid -> PlatformAccessory (캐시 복원본)
    this.contexts = new Map();    // siteId -> 런타임 상태

    this.Eve = buildEveCharacteristics(this.hap);

    // Eve 그래프용 히스토리 로깅(fakegato-history). 로드 실패해도 값 노출은 계속.
    try {
      this.FakeGato = require('fakegato-history')(this.api);
    } catch (e) {
      this.FakeGato = null;
      this.log.warn('[EnerTalk] fakegato-history 로드 실패 — Eve 그래프 비활성(값 표시는 정상):', e.message);
    }

    this.pollingInterval = Math.max(10, Number(this.config.pollingInterval) || 30);  // 초, 실시간
    this.billingInterval = Math.max(60, Number(this.config.billingInterval) || 300); // 초, 당월 누적

    // 노출 토글 (기본: 실시간·당월 on, 콘센트 off)
    this.exposePower = this.config.exposePower !== false;
    this.exposeUsage = this.config.exposeUsage !== false;
    this.exposeOutlet = this.config.exposeOutlet === true;

    // 로컬 모드: 기기를 클라우드 대신 이 호스트로 직접 받음(DNS 리다이렉트 필요).
    this.localMode = this.config.localMode === true;
    this.localPort = Number(this.config.localPort) || LocalServer.DEFAULT_PORT;

    const hasCloud = !!(this.config.email && this.config.password);
    if (hasCloud) {
      this.client = new EnerTalkApi({
        email: this.config.email,
        password: this.config.password,
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        log: this.log,
      });
    }

    // 로컬 모드면 클라우드 자격증명 없이도 동작. 아니면 email/password 필수.
    if (this.localMode || hasCloud) {
      this.enabled = true;
    } else {
      this.log.error('[EnerTalk] config 에 email/password 가 없습니다(로컬 모드도 꺼짐). 플러그인을 시작하지 않습니다.');
      this.enabled = false;
    }

    if (this.api) {
      this.api.on('didFinishLaunching', () => {
        const boot = this.localMode ? this._startLocal() : this._start();
        boot.catch((e) => this.log.error('[EnerTalk] 시작 실패:', e && e.message ? e.message : e));
      });
      this.api.on('shutdown', () => {
        this._stopAllTimers();
        if (this.localServer) { try { this.localServer.stop(); } catch (e) { /* 무시 */ } }
      });
    }
  }

  /** Homebridge 가 캐시된 액세서리를 복원할 때 호출 */
  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  async _start() {
    if (!this.enabled) return;

    let sites;
    try {
      sites = await this.client.getSites();
    } catch (e) {
      this.log.error('[EnerTalk] site 목록 조회 실패 — 이메일/비밀번호를 확인하세요:', e.message);
      return;
    }
    if (!Array.isArray(sites) || sites.length === 0) {
      this.log.error('[EnerTalk] 연결된 site 가 없습니다.');
      return;
    }
    this.log.info(`[EnerTalk] 로그인 성공 · site ${sites.length}개`);

    const seen = new Set();
    const toRegister = [];
    for (const site of sites) {
      if (!site || !site.id) continue;
      this._setupSite(site, seen, toRegister);
    }
    if (toRegister.length) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRegister);
    }

    // seen 에 없는 캐시 액세서리 정리(체크 해제/콘센트 off 등)
    for (const [uuid, acc] of this.accessories) {
      if (!seen.has(uuid)) {
        this.log.info('[EnerTalk] 사용하지 않는 액세서리 제거:', acc.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
        this.accessories.delete(uuid);
      }
    }
  }

  _ensureAccessory(uuid, name, toRegister) {
    let acc = this.accessories.get(uuid);
    if (!acc) {
      acc = new this.api.platformAccessory(name, uuid);
      this.accessories.set(uuid, acc);
      toRegister.push(acc);
      this.log.info('[EnerTalk] 액세서리 등록:', name);
    }
    return acc;
  }

  _setInfo(acc, site, model) {
    const { Service, Characteristic } = this.hap;
    const info = acc.getService(Service.AccessoryInformation) || acc.addService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, 'Encored / EnerTalk')
      .setCharacteristic(Characteristic.Model, model)
      .setCharacteristic(Characteristic.SerialNumber, String(site.id).slice(0, 16))
      .setCharacteristic(Characteristic.FirmwareRevision, packageJson.version);
  }

  _setupSite(site, seen, toRegister) {
    const { Service, Characteristic } = this.hap;
    const uuidGen = this.api.hap.uuid.generate;

    const powerName = this.config.powerSensorName || '실시간 전력';
    const usageName = this.config.usageSensorName || '당월 사용량';

    let powerLux = null;
    let usageLux = null;
    let outlet = null;
    let history = null;

    // ── 1) 실시간 전력 센서 (조도센서 lux=W + Eve W/V/A + 그래프) ──────
    if (this.exposePower) {
      const pUuid = uuidGen(`${PLUGIN_NAME}:${site.id}:power`);
      seen.add(pUuid);
      const pAcc = this._ensureAccessory(pUuid, powerName, toRegister);
      pAcc.context.siteId = site.id;
      this._setInfo(pAcc, site, 'EnerTalk 실시간 전력(W)');
      powerLux = pAcc.getService(Service.LightSensor) || pAcc.addService(Service.LightSensor, powerName);
      powerLux.setCharacteristic(Characteristic.Name, powerName);
      this._ensureCharacteristic(powerLux, this.Eve.CurrentConsumption);
      this._ensureCharacteristic(powerLux, this.Eve.Voltage);
      this._ensureCharacteristic(powerLux, this.Eve.ElectricCurrent);
      if (this.FakeGato) {
        try {
          history = new this.FakeGato('energy', pAcc, { storage: 'fs', path: this.api.user.storagePath() });
        } catch (e) {
          this.log.warn('[EnerTalk] 히스토리 서비스 생성 실패:', e.message);
        }
      }
    }

    // ── 2) 당월 사용량 센서 (조도센서 lux=kWh + Eve kWh) ───────────────
    if (this.exposeUsage) {
      const uUuid = uuidGen(`${PLUGIN_NAME}:${site.id}:usage`);
      seen.add(uUuid);
      const uAcc = this._ensureAccessory(uUuid, usageName, toRegister);
      uAcc.context.siteId = site.id;
      this._setInfo(uAcc, site, 'EnerTalk 당월 사용량(kWh)');
      usageLux = uAcc.getService(Service.LightSensor) || uAcc.addService(Service.LightSensor, usageName);
      usageLux.setCharacteristic(Characteristic.Name, usageName);
      this._ensureCharacteristic(usageLux, this.Eve.TotalConsumption);
    }

    // ── 3) 옵션: Eve 에너지 그래프용 Outlet(+스위치) ──────────────────
    if (this.exposeOutlet) {
      const outletName = this.config.name || site.name || '소비전력';
      const oUuid = uuidGen(`${PLUGIN_NAME}:${site.id}`);
      seen.add(oUuid);
      const oAcc = this._ensureAccessory(oUuid, outletName, toRegister);
      oAcc.context.siteId = site.id;
      this._setInfo(oAcc, site, 'EnerTalk Energy Meter');
      outlet = oAcc.getService(Service.Outlet) || oAcc.addService(Service.Outlet, outletName);
      outlet.setCharacteristic(Characteristic.Name, outletName);
      outlet.getCharacteristic(Characteristic.On)
        .onGet(() => true)
        .onSet(() => { /* 스위치 아님 — 항상 ON */ });
      outlet.updateCharacteristic(Characteristic.On, true);
      this._ensureCharacteristic(outlet, Characteristic.OutletInUse).onGet(() => true);
      outlet.updateCharacteristic(Characteristic.OutletInUse, true);
      this._ensureCharacteristic(outlet, this.Eve.CurrentConsumption);
      this._ensureCharacteristic(outlet, this.Eve.TotalConsumption);
      this._ensureCharacteristic(outlet, this.Eve.Voltage);
      this._ensureCharacteristic(outlet, this.Eve.ElectricCurrent);
    }

    // ── 폴링 (필요한 것만) ─────────────────────────────────────────
    this._stopTimers(site.id);
    const ctx = { site, powerLux, usageLux, outlet, history, timers: [], loggedRealtime: false, loggedBilling: false };
    this.contexts.set(site.id, ctx);

    const needRealtime = !!(powerLux || outlet);
    const needBilling = !!(usageLux || outlet);

    const pollRealtime = () => this._pollRealtime(site.id).catch((e) =>
      this.log.warn('[EnerTalk] realtime 폴링 오류:', e.message));
    const pollBilling = () => this._pollBilling(site.id).catch((e) =>
      this.log.warn('[EnerTalk] billing 폴링 오류:', e.message));

    if (needRealtime) {
      pollRealtime();
      ctx.timers.push(setInterval(pollRealtime, this.pollingInterval * 1000));
    }
    if (needBilling) {
      pollBilling();
      ctx.timers.push(setInterval(pollBilling, this.billingInterval * 1000));
    }
    if (!needRealtime && !needBilling) {
      this.log.warn(`[EnerTalk] site ${site.id}: 노출할 액세서리가 하나도 선택되지 않았습니다.`);
    }
  }

  _ensureCharacteristic(service, Ctor) {
    if (!service.testCharacteristic(Ctor)) service.addCharacteristic(Ctor);
    return service.getCharacteristic(Ctor);
  }

  async _pollRealtime(siteId) {
    const ctx = this.contexts.get(siteId);
    if (!ctx) return;
    const data = await this.client.getRealtime(ctx.site.id);

    const watts = EnerTalkApi.toWatts(data.activePower);
    const volts = EnerTalkApi.toVolts(data.voltage);
    const amps = EnerTalkApi.toAmps(data.current);

    if (ctx.powerLux) {
      ctx.powerLux.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).updateValue(clampLux(watts));
      ctx.powerLux.getCharacteristic(this.Eve.CurrentConsumption).updateValue(round(watts, 1));
      ctx.powerLux.getCharacteristic(this.Eve.Voltage).updateValue(round(volts, 1));
      ctx.powerLux.getCharacteristic(this.Eve.ElectricCurrent).updateValue(round(amps, 2));
    }
    if (ctx.outlet) {
      ctx.outlet.getCharacteristic(this.Eve.CurrentConsumption).updateValue(round(watts, 1));
      ctx.outlet.getCharacteristic(this.Eve.Voltage).updateValue(round(volts, 1));
      ctx.outlet.getCharacteristic(this.Eve.ElectricCurrent).updateValue(round(amps, 2));
    }
    if (ctx.history) {
      try { ctx.history.addEntry({ time: Math.round(Date.now() / 1000), power: round(watts, 1) }); } catch (e) { /* 무시 */ }
    }

    const msg = `[EnerTalk] 실시간 ${round(watts, 1)}W / ${round(volts, 1)}V / ${round(amps, 2)}A`;
    if (!ctx.loggedRealtime) { this.log.info(`${msg} — 폴링 정상 (이후 갱신은 debug 로그)`); ctx.loggedRealtime = true; }
    else { this.log.debug(msg); }
  }

  async _pollBilling(siteId) {
    const ctx = this.contexts.get(siteId);
    if (!ctx) return;
    const data = await this.client.getBilling(ctx.site.id);

    const kwh = EnerTalkApi.toKwh(data.usage);
    if (ctx.usageLux) {
      ctx.usageLux.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).updateValue(clampLux(kwh));
      ctx.usageLux.getCharacteristic(this.Eve.TotalConsumption).updateValue(round(kwh, 3));
    }
    if (ctx.outlet) {
      ctx.outlet.getCharacteristic(this.Eve.TotalConsumption).updateValue(round(kwh, 3));
    }

    const charge = data && data.bill && data.bill.charge != null ? `${data.bill.charge}원` : 'n/a';
    const msg = `[EnerTalk] 당월 ${round(kwh, 2)}kWh / ${charge}`;
    if (!ctx.loggedBilling) { this.log.info(`${msg} — 폴링 정상 (이후 갱신은 debug 로그)`); ctx.loggedBilling = true; }
    else { this.log.debug(msg); }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  로컬 모드: 기기를 클라우드 대신 이 호스트로 직접 받아 디코딩
  // ══════════════════════════════════════════════════════════════════════

  async _startLocal() {
    if (!this.enabled) return;

    // 1) 로컬 액세서리 준비(기기 접속 전에도 미리 등록해 둠)
    this._setupLocalAccessories();

    // 2) 당월 사용량/요금은 클라우드 billing 이 살아있으면 병행(정확한 '당월' 값).
    //    클라우드가 죽으면 기기 누적 카운터로 대체.
    this._billingSiteId = null;
    if (this.client) {
      try {
        const sites = await this.client.getSites();
        if (Array.isArray(sites) && sites.length && sites[0].id) {
          this._billingSiteId = sites[0].id;
          this.log.info(`[EnerTalk][local] 클라우드 병행 활성 (site ${this._billingSiteId}) — 당월 사용량 + 실시간 자동 폴백`);

          // 당월 사용량/요금 폴링
          const pollBill = () => this._pollLocalBilling().catch((e) =>
            this.log.warn('[EnerTalk][local] billing 오류:', e.message));
          pollBill();
          this.localCtx.timers.push(setInterval(pollBill, this.billingInterval * 1000));

          // 실시간 자동 폴백: 로컬이 끊기면 클라우드로, 복구되면 자동 원복
          const staleMs = Math.max(30, Number(this.config.localStaleSeconds) || 90) * 1000;
          const pollRt = () => this._pollLocalRealtimeFallback(this._billingSiteId, staleMs).catch((e) =>
            this.log.debug('[EnerTalk][local] 실시간 폴백 오류:', e.message));
          this.localCtx.timers.push(setInterval(pollRt, this.pollingInterval * 1000));
        }
      } catch (e) {
        this.log.warn('[EnerTalk][local] 클라우드 병행 사용 불가 — 로컬 전용으로 동작(폴백 없음):', e.message);
      }
    } else {
      this.log.info('[EnerTalk][local] 클라우드 자격증명 없음 — 로컬 전용(당월=기기 누적 카운터, 폴백 없음).');
    }

    // 3) TLS 서버 시작
    this.localServer = new LocalServer({ port: this.localPort, log: this.log });
    this.localServer.on('reading', (r) => {
      try { this._onLocalReading(r); } catch (e) { this.log.debug('[EnerTalk][local] reading 처리 오류:', e.message); }
    });
    try {
      this.localServer.start();
    } catch (e) {
      this.log.error('[EnerTalk][local] TLS 서버 시작 실패:', e && e.message);
    }
  }

  _setupLocalAccessories() {
    const { Service, Characteristic } = this.hap;
    const uuidGen = this.api.hap.uuid.generate;
    const powerName = this.config.powerSensorName || '실시간 전력';
    const usageName = this.config.usageSensorName || '당월 사용량';

    const seen = new Set();
    const toRegister = [];
    let powerLux = null;
    let usageLux = null;
    let history = null;

    if (this.exposePower) {
      const pUuid = uuidGen(`${PLUGIN_NAME}:local:power`);
      seen.add(pUuid);
      const pAcc = this._ensureAccessory(pUuid, powerName, toRegister);
      pAcc.context.siteId = 'local';
      this._setInfo(pAcc, { id: 'local' }, 'EnerTalk 실시간 전력(W) · 로컬');
      powerLux = pAcc.getService(Service.LightSensor) || pAcc.addService(Service.LightSensor, powerName);
      powerLux.setCharacteristic(Characteristic.Name, powerName);
      this._ensureCharacteristic(powerLux, this.Eve.CurrentConsumption);
      this._ensureCharacteristic(powerLux, this.Eve.Voltage);
      this._ensureCharacteristic(powerLux, this.Eve.ElectricCurrent);
      if (this.FakeGato) {
        try {
          history = new this.FakeGato('energy', pAcc, { storage: 'fs', path: this.api.user.storagePath() });
        } catch (e) {
          this.log.warn('[EnerTalk][local] 히스토리 서비스 생성 실패:', e.message);
        }
      }
    }

    if (this.exposeUsage) {
      const uUuid = uuidGen(`${PLUGIN_NAME}:local:usage`);
      seen.add(uUuid);
      const uAcc = this._ensureAccessory(uUuid, usageName, toRegister);
      uAcc.context.siteId = 'local';
      this._setInfo(uAcc, { id: 'local' }, 'EnerTalk 당월/누적 사용량(kWh) · 로컬');
      usageLux = uAcc.getService(Service.LightSensor) || uAcc.addService(Service.LightSensor, usageName);
      usageLux.setCharacteristic(Characteristic.Name, usageName);
      this._ensureCharacteristic(usageLux, this.Eve.TotalConsumption);
    }

    if (toRegister.length) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRegister);
    }
    // 로컬 모드로 전환 시 예전(클라우드) 액세서리 정리
    for (const [uuid, acc] of this.accessories) {
      if (!seen.has(uuid)) {
        this.log.info('[EnerTalk][local] 사용하지 않는 액세서리 제거:', acc.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
        this.accessories.delete(uuid);
      }
    }

    this.localCtx = {
      powerLux, usageLux, history,
      timers: [],
      loggedRealtime: false, loggedBilling: false,
      cloudBilling: false,   // billing 이 채워졌는지
      lastLocalMs: 0,        // 마지막 로컬(기기 직수신) 시각
      source: null,          // 'local' | 'cloud' — 현재 실시간 소스
      fallbackCount: 0,      // 클라우드 폴백 누적 횟수(불안정성 지표)
      fallbackSinceMs: 0,    // 이번 폴백 시작 시각
    };
  }

  /** 실시간 W/V/A 를 로컬 전력 센서 + Eve + 그래프에 반영 (로컬/클라우드 공통). */
  _applyRealtime(watts, volts, amps) {
    const ctx = this.localCtx;
    if (!ctx || !ctx.powerLux) return;
    ctx.powerLux.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).updateValue(clampLux(watts));
    ctx.powerLux.getCharacteristic(this.Eve.CurrentConsumption).updateValue(round(watts, 1));
    ctx.powerLux.getCharacteristic(this.Eve.Voltage).updateValue(round(volts, 1));
    ctx.powerLux.getCharacteristic(this.Eve.ElectricCurrent).updateValue(round(amps, 2));
    if (ctx.history) {
      try { ctx.history.addEntry({ time: Math.round(Date.now() / 1000), power: round(watts, 1) }); } catch (e) { /* 무시 */ }
    }
  }

  _onLocalReading(r) {
    const ctx = this.localCtx;
    if (!ctx) return;

    const watts = r.activePower_mW != null ? r.activePower_mW / 1000 : 0;
    const volts = r.voltage_mV != null ? r.voltage_mV / 1000 : 0;
    const amps = r.current_mA != null ? r.current_mA / 1000 : 0;

    ctx.lastLocalMs = Date.now();
    this._applyRealtime(watts, volts, amps);

    // 클라우드 billing 이 없으면 기기 누적 에너지 카운터로 사용량 표시(누적 kWh).
    if (ctx.usageLux && !ctx.cloudBilling && r.energy_mWh != null) {
      const kwh = r.energy_mWh / 1e6;
      ctx.usageLux.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).updateValue(clampLux(kwh));
      ctx.usageLux.getCharacteristic(this.Eve.TotalConsumption).updateValue(round(kwh, 3));
    }

    const msg = `[EnerTalk][local] 실시간 ${round(watts, 1)}W / ${round(volts, 1)}V / ${round(amps, 2)}A / ${r.freqHz}Hz (기기 직수신)`;
    if (ctx.source !== 'local') {
      if (ctx.source === 'cloud') {
        const outSec = ctx.fallbackSinceMs ? Math.round((Date.now() - ctx.fallbackSinceMs) / 1000) : 0;
        this.log.info(`[EnerTalk][local] ⤴ 로컬 복귀 — 클라우드 폴백 ${outSec}초 만에 회복 (누적 폴백 ${ctx.fallbackCount}회). ${msg}`);
      } else {
        this.log.info(`${msg} — 로컬(기기 직수신) 수신 시작 (이후 갱신은 debug)`);
      }
      ctx.source = 'local';
    } else if (!ctx.loggedRealtime) {
      this.log.info(`${msg} — 로컬 수신 정상 (이후 갱신은 debug 로그)`); ctx.loggedRealtime = true;
    } else { this.log.debug(msg); }
  }

  /**
   * 클라우드 실시간 폴백. 로컬(기기 직수신)이 staleMs 이상 끊겼을 때만 클라우드 값을 반영.
   * 로컬이 살아있으면 아무것도 안 함(로컬 우선). 로컬이 돌아오면 _onLocalReading 이 자동 복귀.
   */
  async _pollLocalRealtimeFallback(siteId, staleMs) {
    const ctx = this.localCtx;
    if (!ctx || !ctx.powerLux || !this.client) return;
    const stale = Date.now() - ctx.lastLocalMs > staleMs;
    if (!stale) return; // 로컬 신선 → 클라우드 폴백 불필요

    const data = await this.client.getRealtime(siteId);
    const watts = EnerTalkApi.toWatts(data.activePower);
    const volts = EnerTalkApi.toVolts(data.voltage);
    const amps = EnerTalkApi.toAmps(data.current);
    this._applyRealtime(watts, volts, amps);

    const msg = `[EnerTalk][local] 실시간 ${round(watts, 1)}W / ${round(volts, 1)}V / ${round(amps, 2)}A (클라우드 폴백)`;
    if (ctx.source !== 'cloud') {
      ctx.fallbackCount += 1;
      ctx.fallbackSinceMs = Date.now();
      const outSec = Math.round((Date.now() - ctx.lastLocalMs) / 1000);
      this.log.warn(`[EnerTalk][local] ⤵ 로컬 수신 끊김(약 ${outSec}초 무수신) → 클라우드로 폴백 [${ctx.fallbackCount}번째] (복구되면 자동 원복). ${msg}`);
      ctx.source = 'cloud';
    } else { this.log.debug(msg); }
  }

  async _pollLocalBilling() {
    const ctx = this.localCtx;
    if (!ctx || !ctx.usageLux || !this._billingSiteId || !this.client) return;
    const data = await this.client.getBilling(this._billingSiteId);
    const kwh = EnerTalkApi.toKwh(data.usage);
    ctx.cloudBilling = true;
    ctx.usageLux.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).updateValue(clampLux(kwh));
    ctx.usageLux.getCharacteristic(this.Eve.TotalConsumption).updateValue(round(kwh, 3));

    const charge = data && data.bill && data.bill.charge != null ? `${data.bill.charge}원` : 'n/a';
    const msg = `[EnerTalk][local] 당월 ${round(kwh, 2)}kWh / ${charge} (클라우드 billing)`;
    if (!ctx.loggedBilling) { this.log.info(`${msg} — 병행 정상`); ctx.loggedBilling = true; }
    else { this.log.debug(msg); }
  }

  _stopTimers(siteId) {
    const ctx = this.contexts.get(siteId);
    if (ctx && ctx.timers) {
      for (const t of ctx.timers) clearInterval(t);
      ctx.timers = [];
    }
  }

  _stopAllTimers() {
    for (const siteId of this.contexts.keys()) this._stopTimers(siteId);
    if (this.localCtx && this.localCtx.timers) {
      for (const t of this.localCtx.timers) clearInterval(t);
      this.localCtx.timers = [];
    }
  }
}

function round(n, digits) {
  const f = Math.pow(10, digits);
  return Math.round(Number(n || 0) * f) / f;
}

/** 조도센서 특성은 0.0001~100000 lux 범위. W/kWh 를 그 안으로 클램프. */
function clampLux(v) {
  const x = Number(v || 0);
  if (x < 0.0001) return 0.0001;
  if (x > 100000) return 100000;
  return round(x, 4);
}
