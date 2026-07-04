'use strict';

/**
 * Elgato Eve 커스텀 특성 정의.
 *
 * HomeKit 에는 "전력(W)/전력량(kWh)" 표준 특성이 없어서, Eve 앱이 읽는
 * Elgato 커스텀 UUID 를 그대로 쓴다. Eve 앱에서 실시간 W 와 kWh 그래프(히스토리)까지 보인다.
 *
 * 반환: { CurrentConsumption, TotalConsumption, Voltage, ElectricCurrent }
 * homebridge 의 hap(Characteristic/Formats/Perms)을 넘겨 호출한다.
 */
module.exports = function buildEveCharacteristics(hap) {
  const { Characteristic, Formats, Perms } = hap;

  class CurrentConsumption extends Characteristic {
    constructor() {
      super('Consumption', CurrentConsumption.UUID, {
        format: Formats.FLOAT,
        unit: 'W',
        minValue: 0,
        maxValue: 1000000,
        minStep: 0.1,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }
  CurrentConsumption.UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52';

  class TotalConsumption extends Characteristic {
    constructor() {
      super('Total Consumption', TotalConsumption.UUID, {
        format: Formats.FLOAT,
        unit: 'kWh',
        minValue: 0,
        maxValue: 1000000000,
        minStep: 0.001,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }
  TotalConsumption.UUID = 'E863F10C-079E-48FF-8F27-9C2605A29F52';

  class Voltage extends Characteristic {
    constructor() {
      super('Voltage', Voltage.UUID, {
        format: Formats.FLOAT,
        unit: 'V',
        minValue: 0,
        maxValue: 1000,
        minStep: 0.1,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }
  Voltage.UUID = 'E863F10A-079E-48FF-8F27-9C2605A29F52';

  class ElectricCurrent extends Characteristic {
    constructor() {
      super('Electric Current', ElectricCurrent.UUID, {
        format: Formats.FLOAT,
        unit: 'A',
        minValue: 0,
        maxValue: 1000,
        minStep: 0.01,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }
  ElectricCurrent.UUID = 'E863F126-079E-48FF-8F27-9C2605A29F52';

  return { CurrentConsumption, TotalConsumption, Voltage, ElectricCurrent };
};
