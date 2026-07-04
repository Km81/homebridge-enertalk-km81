/**
 * homebridge-enertalk-km81
 *
 * EnerTalk(Encored) 전력 미터를 Homebridge/HomeKit 으로 노출한다(read-only 모니터링).
 * 제조사 앱/개발자포털이 사실상 종료됐지만, 기기는 여전히 클라우드로 실시간 업로드 중이고
 * api2.enertalk.com 이 살아있어, 앱 번들의 공개 client 자격증명 + password grant 로
 * 이메일/비밀번호만으로 데이터를 끌어온다.
 *
 * 노출 방식:
 *  - 기본: "실시간 전력" / "당월 사용량" 을 각각 독립 조도센서(lux) 액세서리로 노출한다.
 *      Apple '홈' 앱에서 숫자가 바로 보이고(룩스=값), 각 액세서리 이름을 따로 지정/변경할 수 있다.
 *      각 센서에 Eve 특성(W·V·A / kWh)도 함께 실어 Eve 앱에서도 값이 보인다.
 *  - 옵션(exposeOutlet, 기본 off): Eve 에너지 그래프 UI 를 원하면 Outlet+Eve 액세서리를 추가.
 *      (Outlet 은 스위치 특성 On 이 필수라 홈 앱에 토글이 보이지만, 실제 동작은 없다.)
 */

'use strict';

const packageJson = require('./package.json');
const EnerTalkApi = require('./lib/EnerTalkApi.js');
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

    // Eve 그래프용 히스토리 로깅(fakegato-history). 로드 실패해도 플러그인은 값 노출은 계속.
    try {
      this.FakeGato = require('fakegato-history')(this.api);
    } catch (e) {
      this.FakeGato = null;
      this.log.warn('[EnerTalk] fakegato-history 로드 실패 — Eve 그래프 비활성(값 표시는 정상):', e.message);
    }

    this.pollingInterval = Math.max(10, Number(this.config.pollingInterval) || 30);  // 초, 실시간
    this.billingInterval = Math.max(60, Number(this.config.billingInterval) || 300); // 초, 당월 누적
    this.exposeOutlet = this.config.exposeOutlet === true;

    if (!this.config.email || !this.config.password) {
      this.log.error('[EnerTalk] config 에 email/password 가 없습니다. 플러그인을 시작하지 않습니다.');
      this.enabled = false;
    } else {
      this.enabled = true;
      this.client = new EnerTalkApi({
        email: this.config.email,
        password: this.config.password,
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        log: this.log,
      });
    }

    if (this.api) {
      this.api.on('didFinishLaunching', () => this._start().catch((e) => {
        this.log.error('[EnerTalk] 시작 실패:', e && e.message ? e.message : e);
      }));
      this.api.on('shutdown', () => this._stopAllTimers());
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

    // seen 에 없는 캐시 액세서리 정리(콘센트 off 로 바꿨거나 이전 구조의 잔재 등)
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

    // ── 1) 실시간 전력 센서 (독립 액세서리, lux=W) + Eve W/V/A ─────────
    const pUuid = uuidGen(`${PLUGIN_NAME}:${site.id}:power`);
    seen.add(pUuid);
    const pAcc = this._ensureAccessory(pUuid, powerName, toRegister);
    pAcc.context.siteId = site.id;
    this._setInfo(pAcc, site, 'EnerTalk 실시간 전력(W)');
    const powerLux = pAcc.getService(Service.LightSensor) || pAcc.addService(Service.LightSensor, powerName);
    powerLux.setCharacteristic(Characteristic.Name, powerName);
    this._ensureCharacteristic(powerLux, this.Eve.CurrentConsumption);
    this._ensureCharacteristic(powerLux, this.Eve.Voltage);
    this._ensureCharacteristic(powerLux, this.Eve.ElectricCurrent);

    // Eve 그래프용 히스토리 서비스(실시간 전력 액세서리에 부착) — W 를 시계열로 로깅
    let history = null;
    if (this.FakeGato) {
      try {
        history = new this.FakeGato('energy', pAcc, {
          storage: 'fs',
          path: this.api.user.storagePath(),
        });
      } catch (e) {
        this.log.warn('[EnerTalk] 히스토리 서비스 생성 실패:', e.message);
      }
    }

    // ── 2) 당월 사용량 센서 (독립 액세서리, lux=kWh) + Eve kWh ─────────
    const uUuid = uuidGen(`${PLUGIN_NAME}:${site.id}:usage`);
    seen.add(uUuid);
    const uAcc = this._ensureAccessory(uUuid, usageName, toRegister);
    uAcc.context.siteId = site.id;
    this._setInfo(uAcc, site, 'EnerTalk 당월 사용량(kWh)');
    const usageLux = uAcc.getService(Service.LightSensor) || uAcc.addService(Service.LightSensor, usageName);
    usageLux.setCharacteristic(Characteristic.Name, usageName);
    this._ensureCharacteristic(usageLux, this.Eve.TotalConsumption);

    // ── 3) 옵션: Eve 에너지 그래프용 Outlet(+스위치) — 기본 off ─────────
    let outlet = null;
    const outletUuid = uuidGen(`${PLUGIN_NAME}:${site.id}`);
    if (this.exposeOutlet) {
      const outletName = this.config.name || site.name || '소비전력';
      seen.add(outletUuid);
      const oAcc = this._ensureAccessory(outletUuid, outletName, toRegister);
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
    // exposeOutlet off 면 outletUuid 를 seen 에 안 넣었으니 _start 정리 단계에서 제거된다.

    // ── 폴링 ──────────────────────────────────────────────────────
    this._stopTimers(site.id);
    const ctx = { site, powerLux, usageLux, outlet, history, timers: [], loggedRealtime: false, loggedBilling: false };
    this.contexts.set(site.id, ctx);

    const pollRealtime = () => this._pollRealtime(site.id).catch((e) =>
      this.log.warn('[EnerTalk] realtime 폴링 오류:', e.message));
    const pollBilling = () => this._pollBilling(site.id).catch((e) =>
      this.log.warn('[EnerTalk] billing 폴링 오류:', e.message));

    pollRealtime();
    pollBilling();
    ctx.timers.push(setInterval(pollRealtime, this.pollingInterval * 1000));
    ctx.timers.push(setInterval(pollBilling, this.billingInterval * 1000));
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

    // 실시간 전력 센서: 홈 앱용 lux + Eve W/V/A
    ctx.powerLux.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).updateValue(clampLux(watts));
    ctx.powerLux.getCharacteristic(this.Eve.CurrentConsumption).updateValue(round(watts, 1));
    ctx.powerLux.getCharacteristic(this.Eve.Voltage).updateValue(round(volts, 1));
    ctx.powerLux.getCharacteristic(this.Eve.ElectricCurrent).updateValue(round(amps, 2));

    if (ctx.outlet) {
      ctx.outlet.getCharacteristic(this.Eve.CurrentConsumption).updateValue(round(watts, 1));
      ctx.outlet.getCharacteristic(this.Eve.Voltage).updateValue(round(volts, 1));
      ctx.outlet.getCharacteristic(this.Eve.ElectricCurrent).updateValue(round(amps, 2));
    }

    if (ctx.history) {
      try { ctx.history.addEntry({ time: Math.round(Date.now() / 1000), power: round(watts, 1) }); } catch (e) { /* 로깅 실패 무시 */ }
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
    ctx.usageLux.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).updateValue(clampLux(kwh));
    ctx.usageLux.getCharacteristic(this.Eve.TotalConsumption).updateValue(round(kwh, 3));

    if (ctx.outlet) {
      ctx.outlet.getCharacteristic(this.Eve.TotalConsumption).updateValue(round(kwh, 3));
    }

    const charge = data && data.bill && data.bill.charge != null ? `${data.bill.charge}원` : 'n/a';
    const msg = `[EnerTalk] 당월 ${round(kwh, 2)}kWh / ${charge}`;
    if (!ctx.loggedBilling) { this.log.info(`${msg} — 폴링 정상 (이후 갱신은 debug 로그)`); ctx.loggedBilling = true; }
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
