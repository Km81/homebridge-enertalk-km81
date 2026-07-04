/**
 * homebridge-enertalk-km81
 *
 * EnerTalk(Encored) 전력 미터를 Homebridge/HomeKit 으로 노출한다.
 * 제조사 앱/개발자포털이 사실상 종료됐지만, 기기는 여전히 클라우드로 실시간 업로드 중이고
 * api2.enertalk.com 이 살아있어, 앱 번들의 공개 client 자격증명 + password grant 로
 * 이메일/비밀번호만으로 데이터를 끌어온다.
 *
 * 노출 방식:
 *  - 기본: Outlet 서비스 + Eve 커스텀 특성
 *      · Consumption(W)       = 실시간 소비전력
 *      · Total Consumption(kWh)= 당월 누적(검침일 기준)
 *      · Voltage(V) / Electric Current(A)
 *    → Eve 앱에서 실시간 W + 전력량 그래프까지 보인다.
 *  - 옵션(exposeLightSensors): Apple '홈' 앱 기본 화면에서 숫자를 보고 싶을 때
 *      조도센서(lux) 트릭으로 실시간 W / 당월 kWh 를 추가 노출한다.
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
    this.contexts = new Map();    // uuid -> { services..., timers } 런타임 상태

    this.Eve = buildEveCharacteristics(this.hap);

    // 설정값
    this.pollingInterval = Math.max(10, Number(this.config.pollingInterval) || 30); // 초, 실시간
    this.billingInterval = Math.max(60, Number(this.config.billingInterval) || 300); // 초, 당월 누적
    this.exposeLightSensors = this.config.exposeLightSensors === true;

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

    const seen = new Set();
    for (const site of sites) {
      if (!site || !site.id) continue;
      const label = this.config.name || site.name || site.id;
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${site.id}`);
      seen.add(uuid);
      this._setupSiteAccessory(uuid, site, label);
    }

    // config 에서 사라졌거나 계정에 없는 캐시 액세서리 정리
    for (const [uuid, acc] of this.accessories) {
      if (!seen.has(uuid)) {
        this.log.info('[EnerTalk] 사용하지 않는 액세서리 제거:', acc.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
        this.accessories.delete(uuid);
      }
    }
  }

  _setupSiteAccessory(uuid, site, label) {
    const { Service, Characteristic } = this.hap;
    let accessory = this.accessories.get(uuid);
    const isNew = !accessory;

    if (isNew) {
      accessory = new this.api.platformAccessory(label, uuid);
      this.accessories.set(uuid, accessory);
    }
    accessory.context.siteId = site.id;

    // AccessoryInformation
    const info = accessory.getService(Service.AccessoryInformation)
      || accessory.addService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, 'Encored / EnerTalk')
      .setCharacteristic(Characteristic.Model, 'EnerTalk Energy Meter')
      .setCharacteristic(Characteristic.SerialNumber, String(site.id).slice(0, 16))
      .setCharacteristic(Characteristic.FirmwareRevision, packageJson.version);

    // ── 메인: Outlet + Eve 특성 ────────────────────────────────
    const outlet = accessory.getService(Service.Outlet)
      || accessory.addService(Service.Outlet, label);
    outlet.setCharacteristic(Characteristic.Name, label);
    // 상시 ON/사용중으로 고정 (전력 미터는 스위치가 아님)
    outlet.getCharacteristic(Characteristic.On)
      .onGet(() => true)
      .onSet(() => { /* 스위치 아님 — 무시하고 항상 ON 유지 */ });
    outlet.updateCharacteristic(Characteristic.On, true);
    this._ensureCharacteristic(outlet, Characteristic.OutletInUse).onGet(() => true);
    outlet.updateCharacteristic(Characteristic.OutletInUse, true);
    this._ensureCharacteristic(outlet, this.Eve.CurrentConsumption);
    this._ensureCharacteristic(outlet, this.Eve.TotalConsumption);
    this._ensureCharacteristic(outlet, this.Eve.Voltage);
    this._ensureCharacteristic(outlet, this.Eve.ElectricCurrent);

    // ── 옵션: 홈 앱 기본화면용 조도센서(lux) 미러 ──────────────
    let powerLux = null;
    let usageLux = null;
    if (this.exposeLightSensors) {
      powerLux = accessory.getServiceById(Service.LightSensor, 'power')
        || accessory.addService(Service.LightSensor, `${label} 실시간전력`, 'power');
      powerLux.setCharacteristic(Characteristic.Name, `${label} 실시간전력(W)`);

      usageLux = accessory.getServiceById(Service.LightSensor, 'usage')
        || accessory.addService(Service.LightSensor, `${label} 당월사용량`, 'usage');
      usageLux.setCharacteristic(Characteristic.Name, `${label} 당월사용량(kWh)`);
    } else {
      // 옵션 껐을 때 이전에 만든 조도센서 제거
      for (const sid of ['power', 'usage']) {
        const s = accessory.getServiceById(Service.LightSensor, sid);
        if (s) accessory.removeService(s);
      }
    }

    if (isNew) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info('[EnerTalk] 액세서리 등록:', label);
    } else {
      this.log.info('[EnerTalk] 액세서리 복원:', label);
    }

    // 런타임 컨텍스트 + 폴링 시작
    this._stopTimers(uuid);
    const ctx = { accessory, site, outlet, powerLux, usageLux, timers: [] };
    this.contexts.set(uuid, ctx);

    const pollRealtime = () => this._pollRealtime(uuid).catch((e) =>
      this.log.debug('[EnerTalk] realtime 폴링 오류:', e.message));
    const pollBilling = () => this._pollBilling(uuid).catch((e) =>
      this.log.debug('[EnerTalk] billing 폴링 오류:', e.message));

    pollRealtime();
    pollBilling();
    ctx.timers.push(setInterval(pollRealtime, this.pollingInterval * 1000));
    ctx.timers.push(setInterval(pollBilling, this.billingInterval * 1000));
  }

  _ensureCharacteristic(service, Ctor) {
    if (!service.testCharacteristic(Ctor)) {
      service.addCharacteristic(Ctor);
    }
    return service.getCharacteristic(Ctor);
  }

  async _pollRealtime(uuid) {
    const ctx = this.contexts.get(uuid);
    if (!ctx) return;
    const data = await this.client.getRealtime(ctx.site.id);

    const watts = EnerTalkApi.toWatts(data.activePower);
    const volts = EnerTalkApi.toVolts(data.voltage);
    const amps = EnerTalkApi.toAmps(data.current);

    ctx.outlet.getCharacteristic(this.Eve.CurrentConsumption).updateValue(round(watts, 1));
    ctx.outlet.getCharacteristic(this.Eve.Voltage).updateValue(round(volts, 1));
    ctx.outlet.getCharacteristic(this.Eve.ElectricCurrent).updateValue(round(amps, 2));

    if (ctx.powerLux) {
      ctx.powerLux.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel)
        .updateValue(clampLux(watts));
    }
    this.log.debug(`[EnerTalk] realtime: ${round(watts, 1)}W / ${round(volts, 1)}V / ${round(amps, 2)}A`);
  }

  async _pollBilling(uuid) {
    const ctx = this.contexts.get(uuid);
    if (!ctx) return;
    const data = await this.client.getBilling(ctx.site.id);

    const kwh = EnerTalkApi.toKwh(data.usage);
    ctx.outlet.getCharacteristic(this.Eve.TotalConsumption).updateValue(round(kwh, 3));

    if (ctx.usageLux) {
      ctx.usageLux.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel)
        .updateValue(clampLux(kwh));
    }
    const charge = data && data.bill && data.bill.charge != null ? `${data.bill.charge}원` : 'n/a';
    this.log.debug(`[EnerTalk] billing: ${round(kwh, 2)}kWh / ${charge}`);
  }

  _stopTimers(uuid) {
    const ctx = this.contexts.get(uuid);
    if (ctx && ctx.timers) {
      for (const t of ctx.timers) clearInterval(t);
      ctx.timers = [];
    }
  }

  _stopAllTimers() {
    for (const uuid of this.contexts.keys()) this._stopTimers(uuid);
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
