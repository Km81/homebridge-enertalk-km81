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
const MonthlyTracker = require('./lib/MonthlyTracker.js');
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

    // 노출 토글 (기본: 실시간·당월·오늘 on, 콘센트 off)
    this.exposePower = this.config.exposePower !== false;
    this.exposeUsage = this.config.exposeUsage !== false;
    this.exposeDaily = this.config.exposeDaily !== false;
    this.exposeOutlet = this.config.exposeOutlet === true;

    // 로컬 모드: 기기를 클라우드 대신 이 호스트로 직접 받음(DNS 리다이렉트 필요).
    this.localMode = this.config.localMode === true;
    this.localPort = Number(this.config.localPort) || LocalServer.DEFAULT_PORT;

    const hasCloud = !!(this.config.email && this.config.password);
    // 로컬 모드는 완전 독립 — 클라우드 클라이언트를 아예 만들지 않는다(로그인/폴백/보정 없음).
    // 클라우드 클라이언트는 클라우드 모드(localMode=false)에서만 생성한다.
    if (hasCloud && !this.localMode) {
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
        this._stopped = true;
        if (this._startRetryTimer) { clearTimeout(this._startRetryTimer); this._startRetryTimer = null; }
        if (this._localRetryTimer) { clearTimeout(this._localRetryTimer); this._localRetryTimer = null; }
        if (this._backfillTimer) { clearInterval(this._backfillTimer); this._backfillTimer = null; }
        this._stopAllTimers();
        if (this.localServer) { try { this.localServer.stop(); } catch (e) { /* 무시 */ } }
      });
    }
  }

  /** Homebridge 가 캐시된 액세서리를 복원할 때 호출 */
  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  async _start(attempt = 0) {
    if (!this.enabled || this._stopped) return;

    let sites;
    try {
      sites = await this.client.getSites();
    } catch (e) {
      // 부팅 시점 일시적 실패(네트워크 미준비/타임아웃/5xx)로 영구 사망하지 않도록 백오프 재시도.
      const delay = Math.min(600, 30 * Math.pow(2, attempt)) * 1000;
      this.log.warn(`[EnerTalk] site 목록 조회 실패 — ${Math.round(delay / 1000)}초 후 재시도 (이메일/비밀번호도 확인): ${e.message}`);
      // 재시도의 반환 프로미스를 잡아준다 — setup tail(HAP 등록 등)이 throw 하면
      // unhandledRejection 으로 Homebridge 전체가 죽을 수 있으므로 반드시 .catch.
      this._startRetryTimer = setTimeout(() => {
        this._start(attempt + 1).catch((err) =>
          this.log.error('[EnerTalk] 재시도 시작 실패:', err && err.message ? err.message : err));
      }, delay);
      return;
    }
    if (this._stopped) return; // await 도중 셧다운되면 타이머/등록을 만들지 않음
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

    // 설정 화면 '사용량 보기'(월별·일별)를 클라우드 모드에서도 채운다. UI 는 로컬 파일만 읽으므로,
    // 여기서 클라우드 히스토리를 그 파일에 backfill + 당월/오늘 현재값을 기록한다(부팅 1회 + 12시간).
    this._storageDir = '.';
    try { this._storageDir = this.api.user.storagePath(); } catch (e) { /* 무시 */ }
    this.monthly = new MonthlyTracker({
      storageDir: this._storageDir,
      meteringDay: Number(this.config.meteringDay) || null,
      log: this.log,
    });
    // 클라우드 모드는 로컬 카운터가 없다. 이전에 로컬 모드로 쓰던 상태파일의 로컬 카운터 필드가
    // 남아 있으면 UI '당월/오늘(현재까지)'이 옛 로컬값에 얼어붙으므로 제거(클라우드값만 표시).
    this.monthly.clearLocalCounters();
    this._billingSiteId = sites[0].id;
    const backfill = () => this._backfillHistoryFromCloud().catch((e) =>
      this.log.debug('[EnerTalk] 히스토리 backfill 오류:', e.message));
    backfill();
    this._backfillTimer = setInterval(backfill, 12 * 3600 * 1000);
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
    const dailyName = this.config.dailySensorName || '오늘 사용량';

    let powerLux = null;
    let usageLux = null;
    let dailyLux = null;
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

    // ── 2-1) 오늘 사용량 센서 (조도센서 lux=kWh + Eve kWh) ─────────────
    if (this.exposeDaily) {
      const dUuid = uuidGen(`${PLUGIN_NAME}:${site.id}:daily`);
      seen.add(dUuid);
      const dAcc = this._ensureAccessory(dUuid, dailyName, toRegister);
      dAcc.context.siteId = site.id;
      this._setInfo(dAcc, site, 'EnerTalk 오늘 사용량(kWh)');
      dailyLux = dAcc.getService(Service.LightSensor) || dAcc.addService(Service.LightSensor, dailyName);
      dailyLux.setCharacteristic(Characteristic.Name, dailyName);
      this._ensureCharacteristic(dailyLux, this.Eve.TotalConsumption);
    }

    // ── 3) 옵션: Eve 에너지 그래프용 Outlet(+스위치) ──────────────────
    if (this.exposeOutlet) {
      const outletName = this.config.outletName || site.name || '소비전력';
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
    const ctx = { site, powerLux, usageLux, dailyLux, outlet, history, timers: [], loggedRealtime: false, loggedBilling: false };
    this.contexts.set(site.id, ctx);

    const needRealtime = !!(powerLux || outlet);
    const needBilling = !!(usageLux || dailyLux || outlet);

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

    const watts = clamp0(EnerTalkApi.toWatts(data.activePower));
    const volts = clamp0(EnerTalkApi.toVolts(data.voltage));
    const amps = clamp0(EnerTalkApi.toAmps(data.current));

    // 응답 필드 누락(NaN)이면 갱신 스킵 → 직전 값 유지(허위 0 기록 방지 #3)
    if (ctx.powerLux && Number.isFinite(watts)) {
      ctx.powerLux.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).updateValue(clampLux(watts));
      ctx.powerLux.getCharacteristic(this.Eve.CurrentConsumption).updateValue(round(watts, 1));
      if (Number.isFinite(volts)) ctx.powerLux.getCharacteristic(this.Eve.Voltage).updateValue(round(volts, 1));
      if (Number.isFinite(amps)) ctx.powerLux.getCharacteristic(this.Eve.ElectricCurrent).updateValue(round(amps, 2));
    }
    if (ctx.outlet && Number.isFinite(watts)) {
      ctx.outlet.getCharacteristic(this.Eve.CurrentConsumption).updateValue(round(watts, 1));
      if (Number.isFinite(volts)) ctx.outlet.getCharacteristic(this.Eve.Voltage).updateValue(round(volts, 1));
      if (Number.isFinite(amps)) ctx.outlet.getCharacteristic(this.Eve.ElectricCurrent).updateValue(round(amps, 2));
    }
    if (ctx.history && Number.isFinite(watts)) {
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
    if (Number.isFinite(kwh)) {
      if (ctx.usageLux) {
        ctx.usageLux.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).updateValue(clampLux(kwh));
        ctx.usageLux.getCharacteristic(this.Eve.TotalConsumption).updateValue(round(kwh, 3));
      }
      if (ctx.outlet) {
        ctx.outlet.getCharacteristic(this.Eve.TotalConsumption).updateValue(round(kwh, 3));
      }
      // 설정 화면 '사용량 보기' 당월(현재까지)용 — 클라우드 모드는 기기 카운터가 없으므로 billing 값 사용.
      if (this.monthly) this.monthly.setCloudCurrent(Math.round(kwh * 10) / 10, null);
    }

    const msg = `[EnerTalk] 당월 ${round(kwh, 2)}kWh`;
    if (!ctx.loggedBilling) { this.log.info(`${msg} — 폴링 정상 (이후 갱신은 debug 로그)`); ctx.loggedBilling = true; }
    else { this.log.debug(msg); }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  로컬 모드: 기기를 클라우드 대신 이 호스트로 직접 받아 디코딩
  // ══════════════════════════════════════════════════════════════════════

  async _startLocal() {
    if (!this.enabled) return;

    // 0) 저장소 + 당월 사용량 로컬 산출기(기기 누적 카운터 기반, 완전 로컬)
    this._storageDir = '.';
    try { this._storageDir = this.api.user.storagePath(); } catch (e) { /* 무시 */ }
    this.monthly = new MonthlyTracker({
      storageDir: this._storageDir,
      meteringDay: Number(this.config.meteringDay) || null,
      log: this.log,
    });
    // 로컬 모드는 클라우드 학습이 없으므로 검침일을 반드시 설정해야 한다. 미설정이면 매월 1일로
    // 폴백되어 당월 경계가 어긋나는데(조용한 오류) 이를 로그로 표면화한다.
    if (!(Number(this.config.meteringDay) >= 1)) {
      this.log.warn('[EnerTalk][local] 검침일(meteringDay) 미설정 — 매월 1일 기준으로 당월을 산출합니다. 실제 검침일이 1일이 아니면 설정에서 검침일을 입력하세요.');
    }
    // 로컬 모드는 Eve 콘센트 액세서리를 만들지 않는다(실시간/당월은 조도센서로 노출). 조용히
    // 무시되지 않도록 켜져 있으면 안내.
    if (this.exposeOutlet) {
      this.log.warn('[EnerTalk][local] 로컬 모드에서는 Eve 콘센트 옵션이 지원되지 않아 무시됩니다(실시간·당월은 조도센서 액세서리로 표시).');
    }

    // 1) siteId 확정 — 저장된 값(클라우드 모드와 동일 UUID) 우선. 없으면 'local' 고정.
    this._billingSiteId = null;
    this._localSiteId = this._loadSiteId() || 'local';

    // 2) 로컬 액세서리 준비(클라우드 모드와 동일 UUID)
    this._setupLocalAccessories(this._localSiteId);

    // 3) TLS 서버 시작 — listen 실패(EADDRINUSE 등)는 비동기 'error' 로 오므로 try/catch 로는
    //    못 잡는다. 실패 시 백오프 재시도(매 시도 새 LocalServer). 성공하면 워치독 가동.
    this._startLocalServer(0);

    // 4) 완전 로컬 독립 — 클라우드를 일절 사용하지 않는다(폴백/보정/backfill/교차검증 없음).
    this.log.info('[EnerTalk][local] 완전 로컬 독립 모드 — 클라우드 미사용 (실시간·당월 모두 기기 카운터).');
  }

  /** 로컬 TLS 서버 기동 + listen 실패 시 백오프 재시도. 성공 시 staleness 워치독 가동. */
  _startLocalServer(attempt) {
    if (this._stopped) return;
    const srv = new LocalServer({ port: this.localPort, log: this.log });
    this.localServer = srv;
    srv.on('reading', (r) => {
      try { this._onLocalReading(r); } catch (e) { this.log.debug('[EnerTalk][local] reading 처리 오류:', e.message); }
    });
    srv.once('listening', () => this._startStaleWatchdog());
    srv.once('listen-error', () => {
      try { srv.stop(); } catch (e) { /* 무시 */ }
      if (this._stopped) return;
      const delay = Math.min(600, 15 * Math.pow(2, attempt)) * 1000; // 15s→30s→…→최대 10분
      this.log.error(`[EnerTalk][local] 포트 ${this.localPort} 사용 중/열기 실패 — ${Math.round(delay / 1000)}초 후 재시도.`);
      this._localRetryTimer = setTimeout(() => this._startLocalServer(attempt + 1), delay);
    });
    try { srv.start(); } catch (e) { this.log.error('[EnerTalk][local] TLS 서버 시작 예외:', e && e.message); }
  }

  /**
   * 기기 프레임이 staleMs 이상 끊기면 액세서리를 'No Response' 로 표시(옛 값 영구 표시 방지).
   * 로컬은 push 전용이라 기기 전원/네트워크가 끊기면 마지막 값이 정상처럼 남는 문제를 해소.
   * 첫 수신 전(ctx.started=false)엔 발동하지 않는다. 복귀하면 _onLocalReading 이 정상값으로 덮는다.
   */
  _startStaleWatchdog() {
    const ctx = this.localCtx;
    if (!ctx || ctx._watchdog) return;
    const staleMs = Math.max(60, this.pollingInterval * 4) * 1000;
    const tick = () => {
      const c = this.localCtx;
      if (!c || !c.started || c._stale) return;
      if (Date.now() - c.lastLocalMs <= staleMs) return;
      c._stale = true;
      this.log.warn(`[EnerTalk][local] 기기 무수신 ${Math.round((Date.now() - c.lastLocalMs) / 1000)}초 — 액세서리를 응답없음으로 표시(기기 전원/네트워크 확인).`);
      const err = new Error('EnerTalk device not responding');
      for (const svc of [c.powerLux, c.usageLux, c.dailyLux]) {
        if (!svc) continue;
        try { svc.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).updateValue(err); } catch (e) { /* 무시 */ }
      }
    };
    ctx._watchdog = setInterval(tick, Math.max(30, this.pollingInterval) * 1000);
    ctx.timers.push(ctx._watchdog);
  }

  /** 클라우드 과거 일별(최근 35일)·월별(최근 13개월)을 로컬 히스토리에 backfill. 로컬 기록 우선.
   *  ※ 클라우드 모드(localMode=false)에서 UI '사용량 보기'용으로만 사용. 로컬 모드는 호출 안 함. */
  async _backfillHistoryFromCloud() {
    if (this._stopped || !this.client || !this._billingSiteId || !this.monthly) return;
    const KST = 9 * 3600 * 1000;
    const now = Date.now();
    const sid = this._billingSiteId;

    const dayp = await this.client.getPeriodic(sid, 'day', now - 35 * 86400000, now).catch(() => null);
    if (dayp && Array.isArray(dayp.items)) {
      const todayStr = new Date(now + KST).toISOString().slice(0, 10);
      const entries = dayp.items.map((it) => ({
        date: new Date((it.timestamp || 0) + KST).toISOString().slice(0, 10),
        kwh: Math.round((it.usage || 0) / 1e6 * 100) / 100,
      }));
      this.monthly.backfillDaily(entries, todayStr);
      // 클라우드 모드(기기 카운터 없음)용 오늘(현재까지) 값 — 로컬 모드에선 카운터 산출이 우선.
      const t = entries.find((e) => e.date === todayStr);
      if (t) {
        this.monthly.setCloudCurrent(null, t.kwh);
        // 클라우드 모드 '오늘 사용량' 액세서리 갱신(부팅 1회 + 12시간). 로컬 모드는 프레임마다 갱신.
        const ctx = this.contexts.get(sid);
        if (ctx && ctx.dailyLux) {
          ctx.dailyLux.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).updateValue(clampLux(t.kwh));
          ctx.dailyLux.getCharacteristic(this.Eve.TotalConsumption).updateValue(round(t.kwh, 3));
        }
      }
    }

    const monp = await this.client.getPeriodic(sid, 'month', now - 400 * 86400000, now).catch(() => null);
    if (monp && Array.isArray(monp.items)) {
      const curMonthStr = new Date(now + KST).toISOString().slice(0, 7);
      const entries = monp.items.map((it) => ({
        month: new Date((it.timestamp || 0) + KST).toISOString().slice(0, 7),
        kwh: Math.round((it.usage || 0) / 1e6 * 10) / 10,
      }));
      this.monthly.backfillMonthly(entries, curMonthStr);
    }
  }

  // 로컬 모드 액세서리 UUID 안정화용 siteId. 과거 클라우드 세션이 저장해둔 값이 있으면 재사용,
  // 없으면 'local'(v1.11.4부터 로컬 모드는 클라우드로 siteId 를 승격하지 않는다).
  _siteFile() { return require('path').join(this._storageDir || '.', 'enertalk-km81-site.json'); }
  _loadSiteId() {
    try { return JSON.parse(require('fs').readFileSync(this._siteFile(), 'utf8')).siteId || null; }
    catch (e) { return null; }
  }

  _setupLocalAccessories(siteId) {
    const { Service, Characteristic } = this.hap;
    const uuidGen = this.api.hap.uuid.generate;
    const powerName = this.config.powerSensorName || '실시간 전력';
    const usageName = this.config.usageSensorName || '당월 사용량';
    const dailyName = this.config.dailySensorName || '오늘 사용량';

    const seen = new Set();
    const toRegister = [];
    let powerLux = null;
    let usageLux = null;
    let dailyLux = null;
    let history = null;

    if (this.exposePower) {
      const pUuid = uuidGen(`${PLUGIN_NAME}:${siteId}:power`);
      seen.add(pUuid);
      const pAcc = this._ensureAccessory(pUuid, powerName, toRegister);
      pAcc.context.siteId = siteId;
      this._setInfo(pAcc, { id: siteId }, 'EnerTalk 실시간 전력(W)');
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
      const uUuid = uuidGen(`${PLUGIN_NAME}:${siteId}:usage`);
      seen.add(uUuid);
      const uAcc = this._ensureAccessory(uUuid, usageName, toRegister);
      uAcc.context.siteId = siteId;
      this._setInfo(uAcc, { id: siteId }, 'EnerTalk 당월 사용량(kWh)');
      usageLux = uAcc.getService(Service.LightSensor) || uAcc.addService(Service.LightSensor, usageName);
      usageLux.setCharacteristic(Characteristic.Name, usageName);
      this._ensureCharacteristic(usageLux, this.Eve.TotalConsumption);
    }

    if (this.exposeDaily) {
      const dUuid = uuidGen(`${PLUGIN_NAME}:${siteId}:daily`);
      seen.add(dUuid);
      const dAcc = this._ensureAccessory(dUuid, dailyName, toRegister);
      dAcc.context.siteId = siteId;
      this._setInfo(dAcc, { id: siteId }, 'EnerTalk 오늘 사용량(kWh)');
      dailyLux = dAcc.getService(Service.LightSensor) || dAcc.addService(Service.LightSensor, dailyName);
      dailyLux.setCharacteristic(Characteristic.Name, dailyName);
      this._ensureCharacteristic(dailyLux, this.Eve.TotalConsumption);
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
      powerLux, usageLux, dailyLux, history,
      timers: [],
      loggedRealtime: false, loggedMonthly: false,
      deviceId: null,        // 락온한 기기 식별자(다중 기기 오염 방지)
      lastLocalMs: Date.now(), // 마지막 로컬 수신 시각(부팅 직후 쓰레기 로그 방지 #17)
      started: false,        // 첫 로컬 수신 로그를 한 번만 남기기 위한 플래그
      _stale: false,         // staleness 워치독이 'No Response' 표시 중인지
      // 기기 누적 카운터 — 영속값으로 seed(재시작 직후에도 로컬 산출 즉시 복귀)
      lastCounter_mWh: (this.monthly && this.monthly.lastCounter()) || null,
      lastHistoryMs: 0,      // fakegato 히스토리 마지막 기록 시각(throttle)
    };
  }

  /** 당월 사용량(kWh)을 기기 누적 카운터로 로컬 산출·갱신(클라우드 미사용, 완전 로컬).
   *  usageLux 액세서리가 꺼져 있어도 기준선/롤오버는 항상 유지해야 UI 조회·일별 축적이 정상. */
  _updateMonthlyUsage() {
    const ctx = this.localCtx;
    if (!ctx || ctx.lastCounter_mWh == null || !this.monthly) return;
    const now = Date.now();

    // 기준선을 로컬에서 확정(오늘 자정 카운터 기준). 이미 이 주기에 확정돼 있으면 그대로 유지.
    this.monthly.ensureLocalBaseline(ctx.lastCounter_mWh, now);

    // 오늘 사용량(당일 자정~현재) — 기기 카운터로 로컬 산출.
    if (ctx.dailyLux) {
      const today = this.monthly.todayKwh(ctx.lastCounter_mWh, now);
      if (today != null) {
        ctx.dailyLux.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).updateValue(clampLux(today));
        ctx.dailyLux.getCharacteristic(this.Eve.TotalConsumption).updateValue(round(today, 3));
      }
    }

    const kwh = this.monthly.localMonthlyKwh(ctx.lastCounter_mWh, now);
    if (kwh == null) return;
    if (ctx.usageLux) {
      ctx.usageLux.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).updateValue(clampLux(kwh));
      ctx.usageLux.getCharacteristic(this.Eve.TotalConsumption).updateValue(round(kwh, 3));
    }
    if (!ctx.loggedMonthly) {
      this.log.info(`[EnerTalk][local] 당월 ${round(kwh, 2)}kWh · 오늘 ${round(this.monthly.todayKwh(ctx.lastCounter_mWh, now) || 0, 2)}kWh (로컬 산출) — 정상 (이후 갱신은 debug 로그)`);
      ctx.loggedMonthly = true;
    }
  }

  /**
   * 실시간 W/V/A 를 로컬 전력 센서 + Eve + 그래프에 반영 (로컬/클라우드 공통).
   * 유효 숫자가 아닌 값(NaN/누락)은 갱신을 건너뛰어 직전 값을 유지(허위 0 기록 방지 #3).
   * 음수 전력(역송)은 표시상 0 으로 클램프(Eve minValue:0 위반 방지 #26).
   */
  _applyRealtime(watts, volts, amps) {
    const ctx = this.localCtx;
    if (!ctx || !ctx.powerLux) return;
    const P = clamp0(watts);
    if (Number.isFinite(P)) {
      ctx.powerLux.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).updateValue(clampLux(P));
      ctx.powerLux.getCharacteristic(this.Eve.CurrentConsumption).updateValue(round(P, 1));
    }
    if (Number.isFinite(volts)) ctx.powerLux.getCharacteristic(this.Eve.Voltage).updateValue(round(clamp0(volts), 1));
    if (Number.isFinite(amps)) ctx.powerLux.getCharacteristic(this.Eve.ElectricCurrent).updateValue(round(clamp0(amps), 2));
    // fakegato 히스토리는 ~30초 간격으로만 기록(기기가 초당 푸시 → 매초 기록은 낭비).
    if (ctx.history && Number.isFinite(P)) {
      const now = Date.now();
      if (now - (ctx.lastHistoryMs || 0) >= 30000) {
        ctx.lastHistoryMs = now;
        try { ctx.history.addEntry({ time: Math.round(now / 1000), power: round(P, 1) }); } catch (e) { /* 무시 */ }
      }
    }
  }

  _onLocalReading(r) {
    const ctx = this.localCtx;
    if (!ctx) return;

    // 다중 EnerTalk 미터 오염 방지 + 재접속 견고성(#4):
    //  같은 기기라도 재접속(세션 리셋) 시 deviceId 뒷바이트가 바뀐다(앞 7바이트는 동일 관측).
    //  첫 기기에 락온하되, 다른 deviceId 프레임이 와도 —
    //   (A) 락온 기기가 stale(무수신 임계 초과)이면 = 재접속으로 보고 재락온
    //   (B) 앞 7바이트(안정 프리픽스)가 같으면 = 같은 기기의 세션 변화로 보고 재락온
    //  둘 다 아니면(락온 기기가 살아있는데 프리픽스도 다른) 진짜 다른 미터 → 무시.
    if (r.deviceId) {
      if (!ctx.deviceId) {
        ctx.deviceId = r.deviceId;
      } else if (ctx.deviceId !== r.deviceId) {
        const samePrefix = ctx.deviceId.slice(0, 14) === r.deviceId.slice(0, 14); // 앞 7바이트(=14 hex)
        const staleMs = Math.max(60, this.pollingInterval * 4) * 1000;
        const lockedStale = Date.now() - ctx.lastLocalMs > staleMs;
        if (samePrefix || lockedStale) {
          this.log.info(`[EnerTalk][local] 기기 재접속 감지 — deviceId ${ctx.deviceId} → ${r.deviceId} 재락온(${samePrefix ? '동일 프리픽스' : 'stale'}).`);
          ctx.deviceId = r.deviceId;
          ctx._warnedMultiDev = false;
        } else {
          if (!ctx._warnedMultiDev) { this.log.warn(`[EnerTalk][local] 다른 기기(${r.deviceId}) 프레임 무시 — 락온: ${ctx.deviceId}`); ctx._warnedMultiDev = true; }
          return;
        }
      }
    }

    const watts = r.activePower_mW != null ? r.activePower_mW / 1000 : NaN;
    const volts = r.voltage_mV != null ? r.voltage_mV / 1000 : NaN;
    const amps = r.current_mA != null ? r.current_mA / 1000 : NaN;

    ctx.lastLocalMs = Date.now();
    if (ctx._stale) { // 무수신(No Response) 상태에서 복귀 — 정상 표시로 자동 원복
      ctx._stale = false;
      this.log.info('[EnerTalk][local] 기기 수신 복귀 — 응답없음 해제.');
    }
    this._applyRealtime(watts, volts, amps);

    // 당월 사용량: 기기 누적 카운터로 로컬 산출(완전 로컬, 클라우드 미사용).
    // 손상 프레임(음수/비현실적 거대값)은 당월·일별 오염을 막기 위해 카운터 반영을 건너뛴다
    // (실시간 W/V/A 는 위에서 이미 반영됨). 정상 프레임에서 자동 회복.
    if (r.energy_mWh != null && r.energy_mWh >= 0 && r.energy_mWh < 1e13) {
      ctx.lastCounter_mWh = r.energy_mWh;
      if (this.monthly) {
        this.monthly.recordCounter(r.energy_mWh, ctx.lastLocalMs); // 재시작 대비 영속(~60초 throttle)
        this.monthly.recordDaily(r.energy_mWh, ctx.lastLocalMs);   // 일별 사용량 로컬 기록(KST 자정 경계)
      }
      this._updateMonthlyUsage();
    }

    const msg = `[EnerTalk][local] 실시간 ${round(watts, 1)}W / ${round(volts, 1)}V / ${round(amps, 2)}A / ${r.freqHz}Hz (기기 직수신)`;
    if (!ctx.started) {
      this.log.info(`${msg} — 로컬(기기 직수신) 수신 시작 (이후 갱신은 debug 로그)`);
      ctx.started = true;
    } else { this.log.debug(msg); }
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

/** 음수를 0 으로(역송/노이즈). 유한하지 않으면 그대로 통과(호출부에서 isFinite 로 걸러짐). */
function clamp0(v) {
  return (Number.isFinite(v) && v < 0) ? 0 : v;
}

/** 조도센서 특성은 0.0001~100000 lux 범위. W/kWh 를 그 안으로 클램프. */
function clampLux(v) {
  const x = Number(v || 0);
  if (x < 0.0001) return 0.0001;
  if (x > 100000) return 100000;
  return round(x, 4);
}
