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
        this._stopped = true;
        if (this._startRetryTimer) { clearTimeout(this._startRetryTimer); this._startRetryTimer = null; }
        if (this._localRetryTimer) { clearTimeout(this._localRetryTimer); this._localRetryTimer = null; }
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
      this._startRetryTimer = setTimeout(() => this._start(attempt + 1), delay);
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
    this._localStartMs = Date.now();

    // 0) 저장소 + 당월 사용량 로컬 산출기(기기 누적 카운터 기반, 클라우드로 보정)
    this._storageDir = '.';
    try { this._storageDir = this.api.user.storagePath(); } catch (e) { /* 무시 */ }
    this.monthly = new MonthlyTracker({
      storageDir: this._storageDir,
      meteringDay: Number(this.config.meteringDay) || null,
      log: this.log,
    });

    // 1) siteId 확정 — 저장된 값(클라우드 모드와 동일 UUID) 우선. 없으면 'local' 로 시작하되
    //    클라우드가 살아나면 백그라운드에서 실제 siteId 로 승격(#12 churn 최소화).
    this._billingSiteId = null;
    this._localSiteId = this._loadSiteId() || 'local';

    // 2) 로컬 액세서리 준비(클라우드 모드와 동일 UUID)
    this._setupLocalAccessories(this._localSiteId);

    // 3) TLS 서버 시작(먼저 열어 기기 수신 준비)
    this.localServer = new LocalServer({ port: this.localPort, log: this.log });
    this.localServer.on('reading', (r) => {
      try { this._onLocalReading(r); } catch (e) { this.log.debug('[EnerTalk][local] reading 처리 오류:', e.message); }
    });
    try {
      this.localServer.start();
    } catch (e) {
      this.log.error('[EnerTalk][local] TLS 서버 시작 실패:', e && e.message);
    }

    // 4) 클라우드 병행(billing 보정 + 실시간 폴백) — 실패해도 재시도로 세션 내내 살림(#5)
    if (this.client) this._ensureCloudCompanion(0);
    else this.log.info('[EnerTalk][local] 클라우드 없음 — 완전 로컬 (당월=기기 카운터, 검침일=설정값 또는 기본 1일, 폴백 없음).');
  }

  /** 로컬 모드에서 클라우드 site 조회 → billing/폴백 타이머 기동. 실패 시 백오프 재시도. */
  async _ensureCloudCompanion(attempt) {
    if (this._stopped || !this.client || this._billingSiteId) return;
    let siteId = null;
    try {
      const sites = await this.client.getSites();
      if (Array.isArray(sites) && sites.length && sites[0].id) siteId = sites[0].id;
    } catch (e) {
      const delay = Math.min(600, 30 * Math.pow(2, attempt)) * 1000;
      this.log.warn(`[EnerTalk][local] 클라우드 site 조회 실패 — ${Math.round(delay / 1000)}초 후 재시도(로컬은 계속 동작): ${e.message}`);
      this._localRetryTimer = setTimeout(() => this._ensureCloudCompanion(attempt + 1), delay);
      return;
    }
    if (!siteId) return;
    this._billingSiteId = siteId;
    this._saveSiteId(siteId);

    // 최초 부팅이 클라우드 장애와 겹쳐 'local' 로 시작했다면, 실제 siteId 로 액세서리 승격(1회 churn)
    if (this._localSiteId !== siteId) {
      this.log.info(`[EnerTalk][local] 클라우드 복구 — 액세서리 site 승격 (${this._localSiteId} → ${siteId})`);
      this._localSiteId = siteId;
      this._setupLocalAccessories(siteId);
    }

    this.log.info(`[EnerTalk][local] 클라우드 병행 활성 (site ${siteId}) — 검침일/기준선 보정 + 실시간 자동 폴백`);
    const pollBill = () => this._pollLocalBilling().catch((e) =>
      this.log.warn('[EnerTalk][local] billing 오류:', e.message));
    pollBill();
    this.localCtx.timers.push(setInterval(pollBill, this.billingInterval * 1000));

    const staleMs = Math.max(30, Number(this.config.localStaleSeconds) || 90) * 1000;
    const pollRt = () => this._pollLocalRealtimeFallback(this._billingSiteId, staleMs).catch((e) =>
      this.log.debug('[EnerTalk][local] 실시간 폴백 오류:', e.message));
    this.localCtx.timers.push(setInterval(pollRt, this.pollingInterval * 1000));

    // 과거 일별/월별을 클라우드에서 로컬 파일로 backfill(부팅 1회 + 12시간마다).
    // 조회는 100% 로컬만 읽으므로, 이 백그라운드 보정이 로컬에 없는 과거치를 영구 저장한다.
    const backfill = () => this._backfillHistoryFromCloud().catch((e) =>
      this.log.debug('[EnerTalk][local] 히스토리 backfill 오류:', e.message));
    backfill();
    this.localCtx.timers.push(setInterval(backfill, 12 * 3600 * 1000));
  }

  /** 클라우드 과거 일별(최근 35일)·월별(최근 13개월)을 로컬 히스토리에 backfill. 로컬 기록 우선. */
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

  _siteFile() { return require('path').join(this._storageDir || '.', 'enertalk-km81-site.json'); }
  _loadSiteId() {
    try { return JSON.parse(require('fs').readFileSync(this._siteFile(), 'utf8')).siteId || null; }
    catch (e) { return null; }
  }
  _saveSiteId(id) {
    try {
      const fs = require('fs');
      const tmp = this._siteFile() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ siteId: id }));
      fs.renameSync(tmp, this._siteFile());
    } catch (e) { this.log.debug('[EnerTalk][local] site 저장 실패:', e.message); }
  }

  _setupLocalAccessories(siteId) {
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
      deviceId: null,        // 락온한 기기 식별자(다중 기기 오염 방지)
      lastLocalMs: Date.now(), // 마지막 로컬 수신 시각(부팅 직후 허위 폴백/쓰레기 로그 방지 #17)
      source: null,          // 'local' | 'cloud' — 현재 실시간 소스
      fallbackCount: 0,      // 클라우드 폴백 누적 횟수(불안정성 지표)
      fallbackSinceMs: 0,    // 이번 폴백 시작 시각
      // 기기 누적 카운터 — 영속값으로 seed(재시작 직후에도 로컬 산출 즉시 복귀, 프리즈된 클라우드값 노출 방지)
      lastCounter_mWh: (this.monthly && this.monthly.lastCounter()) || null,
      lastCloudBilling: null,// 최근 클라우드 billing {usage, start} (기준선 보정용)
      calibrated: false,     // 이번 세션에서 클라우드로 기준선 보정했는지
      lastHistoryMs: 0,      // fakegato 히스토리 마지막 기록 시각(throttle)
    };
  }

  /** 당월 사용량(kWh)을 로컬 산출값으로 갱신. 기준선이 없으면 클라우드로 seed, 없으면 대기/근사. */
  _updateMonthlyUsage(logInfo) {
    const ctx = this.localCtx;
    if (!ctx || !ctx.usageLux || ctx.lastCounter_mWh == null || !this.monthly) return;
    const now = Date.now();

    // 기준선 확보 전략(잘못된 0 방지)
    if (!this.monthly.hasBaseline()) {
      if (ctx.lastCloudBilling) {
        // 클라우드 값으로 정확히 seed (baseline = counter - 당월usage)
        this.monthly.learnFromCloud(ctx.lastCounter_mWh, ctx.lastCloudBilling.usage, ctx.lastCloudBilling.start, now);
        ctx.calibrated = true;
      } else if (!this.client || (now - (this._localStartMs || now) > 60000)) {
        // 순수 로컬(클라우드 없음) 또는 클라우드 60초 무응답 → 현재 카운터로 근사 seed
        this.monthly.seedBaselineIfEmpty(ctx.lastCounter_mWh, now);
      } else {
        // 클라우드 응답 대기중 → 표시 보류(billing 이 임시로 클라우드값 표시)
        return;
      }
    }

    const kwh = this.monthly.localMonthlyKwh(ctx.lastCounter_mWh, now);
    if (kwh == null) return;
    ctx.usageLux.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).updateValue(clampLux(kwh));
    ctx.usageLux.getCharacteristic(this.Eve.TotalConsumption).updateValue(round(kwh, 3));
    if (logInfo) {
      this.log.info(`[EnerTalk][local] 당월 ${round(kwh, 2)}kWh (로컬 산출) — 정상`);
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

    // 다중 EnerTalk 미터 오염 방지: 첫 기기에 락온하고 다른 기기 프레임은 무시(#4)
    if (r.deviceId) {
      if (!ctx.deviceId) ctx.deviceId = r.deviceId;
      else if (ctx.deviceId !== r.deviceId) {
        if (!ctx._warnedMultiDev) { this.log.warn(`[EnerTalk][local] 다른 기기(${r.deviceId}) 프레임 무시 — 락온: ${ctx.deviceId}`); ctx._warnedMultiDev = true; }
        return;
      }
    }

    const watts = r.activePower_mW != null ? r.activePower_mW / 1000 : NaN;
    const volts = r.voltage_mV != null ? r.voltage_mV / 1000 : NaN;
    const amps = r.current_mA != null ? r.current_mA / 1000 : NaN;

    ctx.lastLocalMs = Date.now();
    this._applyRealtime(watts, volts, amps);

    // 당월 사용량: 기기 누적 카운터로 로컬 산출(클라우드 없이도 동작).
    if (r.energy_mWh != null) {
      ctx.lastCounter_mWh = r.energy_mWh;
      if (this.monthly) {
        this.monthly.recordCounter(r.energy_mWh, ctx.lastLocalMs); // 재시작 대비 영속(~60초 throttle)
        this.monthly.recordDaily(r.energy_mWh, ctx.lastLocalMs);   // 일별 사용량 로컬 기록(KST 자정 경계)
      }
      // 세션당 1회: 카운터+클라우드 billing 둘 다 확보되면 정확히 재보정(오래된 기준선 치유).
      if (this.client && !ctx.calibrated && ctx.lastCloudBilling && this.monthly) {
        this.monthly.learnFromCloud(r.energy_mWh, ctx.lastCloudBilling.usage, ctx.lastCloudBilling.start, Date.now());
        ctx.calibrated = true;
      }
      this._updateMonthlyUsage(false);
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
    // await 도중 로컬이 복귀했으면 클라우드 값으로 덮어쓰지 않음(경쟁조건 #16)
    if (Date.now() - ctx.lastLocalMs <= staleMs) return;

    const watts = EnerTalkApi.toWatts(data.activePower);
    const volts = EnerTalkApi.toVolts(data.voltage);
    const amps = EnerTalkApi.toAmps(data.current);
    if (!Number.isFinite(watts)) return; // 응답 필드 누락 → 폴백 표시 스킵
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

    // 최근 클라우드 billing 보관(기준선 seed/보정용). 검침일·기준선 보정에만 쓰고 표시는 로컬 카운터 우선.
    ctx.lastCloudBilling = { usage: data.usage, start: data.start };

    // 카운터가 있으면 매 폴링마다 검침일+기준선 정확 보정(권위값).
    if (this.monthly && ctx.lastCounter_mWh != null) {
      this.monthly.learnFromCloud(ctx.lastCounter_mWh, data.usage, data.start, Date.now());
      ctx.calibrated = true;
    }

    // 표시: 카운터+기준선 있으면 로컬 산출(클라우드 없어도 동일), 아직이면 클라우드값 임시.
    let kwh = null;
    if (this.monthly && ctx.lastCounter_mWh != null) kwh = this.monthly.localMonthlyKwh(ctx.lastCounter_mWh, Date.now());
    const localOk = kwh != null;
    if (!localOk) kwh = EnerTalkApi.toKwh(data.usage);
    ctx.usageLux.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).updateValue(clampLux(kwh));
    ctx.usageLux.getCharacteristic(this.Eve.TotalConsumption).updateValue(round(kwh, 3));

    const src = localOk ? '로컬 산출·클라우드 보정' : '클라우드(기기 카운터 대기)';
    const msg = `[EnerTalk][local] 당월 ${round(kwh, 2)}kWh (${src})`;
    if (!ctx.loggedBilling) { this.log.info(`${msg} — 정상`); ctx.loggedBilling = true; }
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
