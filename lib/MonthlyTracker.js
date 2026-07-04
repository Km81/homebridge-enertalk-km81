'use strict';

/**
 * 당월(검침 주기) 사용량을 로컬에서 산출/유지한다.
 *
 * 기기 프레임의 누적 에너지 카운터(positiveEnergy, mWh)를 기준으로
 *   당월 kWh = (현재 카운터 - 검침주기 시작 시점의 카운터) / 1e6
 * 로 계산한다. 검침일(검침 시작일)마다 자동으로 기준선을 리셋한다.
 *
 * 클라우드 billing 이 살아있으면 `learnFromCloud()` 로 검침일과 기준선을 정확히
 * 보정한다(= 클라우드 값과 일치). 클라우드가 죽어도 학습해둔 값으로 계속 로컬 산출한다.
 *
 * 상태는 storageDir 에 파일로 영속화되어 재시작/클라우드 종료 후에도 유지된다.
 *   state = { meteringDay, periodStartMs, periodStartCounter_mWh }
 */

const fs = require('fs');
const path = require('path');

class MonthlyTracker {
  constructor({ storageDir, meteringDay, log } = {}) {
    this.log = log || console;
    this.file = path.join(storageDir || '.', 'enertalk-km81-monthly.json');
    this.configMeteringDay = (meteringDay && meteringDay >= 1 && meteringDay <= 31) ? meteringDay : null;
    this.state = this._load() || {};
    if (this.configMeteringDay && !this.state.meteringDay) this.state.meteringDay = this.configMeteringDay;
  }

  _load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { return null; }
  }

  _save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.state)); } catch (e) { this.log.debug('[EnerTalk] monthly 저장 실패:', e.message); }
  }

  meteringDay() {
    return this.state.meteringDay || this.configMeteringDay || 1;
  }

  /** now 기준 현재 검침주기 시작(ms). 검침일 자정(로컬 시간) 기준. */
  _periodStartFor(nowMs) {
    const d = new Date(nowMs);
    const md = this.meteringDay();
    const y = d.getFullYear();
    const m = d.getMonth();
    const day = d.getDate();
    const start = (day >= md) ? new Date(y, m, md, 0, 0, 0, 0) : new Date(y, m - 1, md, 0, 0, 0, 0);
    return start.getTime();
  }

  /**
   * 클라우드 billing 으로 검침일 + 기준선 보정.
   * @param counter_mWh 현재 기기 누적 카운터
   * @param cloudUsage_mWh 클라우드가 보고한 당월 사용량
   * @param cloudStartMs 클라우드 billing 주기 시작 timestamp (검침일 유추용)
   * @param nowMs 현재 시각
   */
  learnFromCloud(counter_mWh, cloudUsage_mWh, cloudStartMs, nowMs) {
    if (cloudStartMs) {
      const md = new Date(cloudStartMs).getDate();
      if (md >= 1 && md <= 31) this.state.meteringDay = md;
    }
    if (counter_mWh != null && cloudUsage_mWh != null) {
      this.state.periodStartMs = this._periodStartFor(nowMs != null ? nowMs : Date.now());
      this.state.periodStartCounter_mWh = counter_mWh - cloudUsage_mWh;
      this._save();
    }
  }

  /**
   * 로컬 당월 kWh. 검침주기가 바뀌었으면(롤오버) 기준선을 현재 카운터로 리셋.
   * @returns kWh (number) 또는 null(카운터 미확보)
   */
  localMonthlyKwh(counter_mWh, nowMs) {
    if (counter_mWh == null) return null;
    const now = nowMs != null ? nowMs : Date.now();
    const curPeriodStart = this._periodStartFor(now);

    const noBase = this.state.periodStartCounter_mWh == null || this.state.periodStartMs == null;
    const rolledOver = !noBase && curPeriodStart > (this.state.periodStartMs || 0) + 60000;

    if (noBase || rolledOver) {
      // 주기 경계의 정확한 카운터를 모르므로 현재 카운터를 기준선으로(첫 주기/롤오버 근사).
      // 클라우드가 살아있으면 learnFromCloud 가 곧 정확히 보정한다.
      this.state.periodStartMs = curPeriodStart;
      this.state.periodStartCounter_mWh = counter_mWh;
      this._save();
      if (rolledOver) this.log.info('[EnerTalk][local] 검침일 도래 — 당월 사용량 기준선 리셋(0부터 재적산).');
    }

    const kwh = (counter_mWh - this.state.periodStartCounter_mWh) / 1e6;
    return kwh >= 0 ? kwh : 0;
  }
}

module.exports = MonthlyTracker;
