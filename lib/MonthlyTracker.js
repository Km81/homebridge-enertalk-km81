'use strict';

/**
 * 당월(검침 주기) 사용량을 로컬에서 산출/유지한다.
 *
 * 기기 프레임의 누적 에너지 카운터(positiveEnergy, mWh)를 기준으로
 *   당월 kWh = (현재 카운터 - 검침주기 시작 시점의 카운터) / 1e6
 * 로 계산한다. 검침일(검침 시작일)마다 자동으로 기준선을 리셋한다(로컬 롤오버).
 *
 * 완전 로컬 독립: 기준선은 `ensureLocalBaseline()`(오늘 자정 카운터) 또는 검침일 롤오버
 * (정각 카운터)로만 잡는다. 클라우드는 일절 사용하지 않는다.
 *
 * 상태는 storageDir 에 파일로 영속화되어 재시작 후에도 유지된다.
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
    // 유효 검침일을 상태파일에 영속(별도 프로세스인 UI 서버가 주기 경계를 계산하는 데 사용).
    const eff = this.meteringDay();
    if (this.state.effectiveMeteringDay !== eff) { this.state.effectiveMeteringDay = eff; this._save(); }
  }

  _load() {
    let s;
    try { s = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { return null; }
    // 마이그레이션(pre-1.11.4): baselineForPeriodMs 가 없던 상태파일은 유효한 기준선이 있어도
    // ensureLocalBaseline 이 '이 주기 미확정'으로 오판해 오늘치로 재앵커링(월중 누적 붕괴)한다.
    // 기존 기준선 주기를 baselineForPeriodMs 로 백필해 현재 주기면 그대로 보존되게 한다.
    if (s && s.baselineForPeriodMs == null && s.periodStartMs != null && s.periodStartCounter_mWh != null) {
      s.baselineForPeriodMs = s.periodStartMs;
    }
    return s;
  }

  _save() {
    // 원자적 쓰기(temp → rename) — 크래시 중 부분쓰기로 인한 파일 손상 방지
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
      if (this._saveFailWarned) { // v2.1.0 — 실패↔복구 쌍 (라이브 파일과 동일 패턴)
        this._saveFailWarned = false;
        if (this.log.info) this.log.info('[EnerTalk] monthly 상태 저장 복구 — 영속 재개.');
      }
    } catch (e) {
      // v2.1.0 — debug 전용이던 것을 warn 1회 승격: 영속이 조용히 계속 실패하면
      // 재시작 때 당월 기준선·일별 히스토리가 통째로 롤백되는 사각지대였음
      if (!this._saveFailWarned) {
        this._saveFailWarned = true;
        const w = this.log.warn || this.log.debug;
        w.call(this.log, `[EnerTalk] monthly 상태 저장 실패(반복 억제, 복구 시 알림): ${e.message}`);
      }
    }
  }

  meteringDay() {
    // config(사용자 명시 검침일)가 **최우선** — 클라우드 학습값(state)을 덮어쓰지 않고 이긴다.
    // config 가 비어 있을 때만 클라우드 자동학습값(state.meteringDay)을 쓴다.
    return this.configMeteringDay || this.state.meteringDay || 1;
  }

  /** 해당 연/월에 유효한 검침일(그 달 일수를 넘으면 말일로 클램프). */
  _clampDay(year, monthIndex, md) {
    const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    return Math.min(md, daysInMonth);
  }

  /**
   * now 기준 현재 검침주기 시작(ms). 검침일 KST 자정 기준(서버 타임존 무관). 29~31일은 말일 클램프.
   * 일별 경계(_kstDayStart)와 동일하게 KST 고정 — UTC 도커 등에서 검침일 off-by-one 방지.
   */
  _periodStartFor(nowMs) {
    const KST = MonthlyTracker._KST;
    const d = new Date(nowMs + KST);
    const md = this.meteringDay();
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const day = d.getUTCDate();
    const thisMd = this._clampDay(y, m, md);
    if (day >= thisMd) return Date.UTC(y, m, thisMd) - KST;
    const prevMd = this._clampDay(y, m - 1, md);
    return Date.UTC(y, m - 1, prevMd) - KST;
  }

  /**
   * 완전 로컬 기준선 앵커링(클라우드 미사용).
   * 현재 검침주기의 기준선이 아직 '이 주기에 대해 로컬로 확정'되지 않았으면,
   * 로컬에서 가진 가장 신뢰할 수 있는 시점(오늘 자정 KST 카운터, 없으면 현재 카운터)으로 잡는다.
   *   - 오늘 자정 카운터 기준 → 당월이 '오늘치'부터 보이고 이후 카운터와 함께 누적.
   *   - 한 번 확정(baselineForPeriodMs === curStart)하면 다시 건드리지 않는다.
   * 검침일 롤오버 시엔 localMonthlyKwh 가 정각 카운터로 새 기준선을 잡아 이 함수 없이도 정확.
   */
  ensureLocalBaseline(counter_mWh, nowMs) {
    if (counter_mWh == null) return;
    const now = nowMs != null ? nowMs : Date.now();
    const curStart = this._periodStartFor(now);
    if (this.state.baselineForPeriodMs === curStart && this.hasBaseline()) return;
    // 검침일 롤오버가 대기 중이면(기존 기준선이 '이전' 주기) 여기서 손대지 않는다.
    // localMonthlyKwh 가 마감월을 히스토리에 기록한 뒤 정각 카운터로 새 기준선을 잡게 둔다.
    if (this.hasBaseline() && curStart > (this.state.periodStartMs || 0) + 60000) return;
    let anchor = counter_mWh;
    if (this.state.dayStartCounter_mWh != null && this.state.dayStartMs === this._kstDayStart(now)) {
      anchor = this.state.dayStartCounter_mWh;
    }
    this.state.periodStartMs = curStart;
    this.state.periodStartCounter_mWh = anchor;
    this.state.baselineForPeriodMs = curStart;
    // 이 기준선은 주기 정각이 아니라 '주기 도중'(오늘 자정)에 잡힌 부분값이다.
    // 다음 롤오버 때 이 주기를 '한 달 전체'로 히스토리에 기록하면 안 되므로 표식.
    this.state.periodPartial = true;
    this._save();
  }

  /**
   * 클라우드 모드 전환용: 로컬 전용 카운터/기준선 필드를 제거한다.
   * 이게 남아 있으면 UI '당월/오늘(현재까지)'이 전환 직전 로컬 카운터에 얼어붙는다.
   */
  clearLocalCounters() {
    let changed = false;
    for (const k of ['lastCounter_mWh', 'periodStartCounter_mWh', 'periodStartMs',
      'baselineForPeriodMs', 'dayStartCounter_mWh', 'dayStartMs', 'periodPartial']) {
      if (this.state[k] != null) { delete this.state[k]; changed = true; }
    }
    if (changed) this._save();
  }

  /** 기준선이 잡혀 있는지 */
  hasBaseline() {
    return this.state.periodStartCounter_mWh != null && this.state.periodStartMs != null;
  }

  /**
   * 기기 누적 카운터를 영속 기록(재시작 후에도 로컬 산출 즉시 복귀용).
   * 매 프레임(초당) 저장은 낭비이므로 ~60초 간격으로만 파일에 쓴다.
   */
  recordCounter(counter_mWh, nowMs) {
    if (counter_mWh == null) return;
    this.state.lastCounter_mWh = counter_mWh;
    const now = nowMs != null ? nowMs : Date.now();
    if (now - (this._lastCounterSaveMs || 0) >= 60000) {
      this._lastCounterSaveMs = now;
      this._save();
    }
  }

  /** 마지막으로 관측/영속된 기기 누적 카운터(없으면 null). 재시작 직후 seed 용. */
  lastCounter() {
    return this.state.lastCounter_mWh != null ? this.state.lastCounter_mWh : null;
  }

  /**
   * 클라우드 모드용: 기기 카운터가 없어 로컬 산출이 불가능할 때 UI 조회가 쓸 당월/오늘 값을
   * 클라우드 billing/periodic 에서 받아 영속(변경 시에만 저장). 로컬 모드에선 카운터 산출이 우선.
   */
  setCloudCurrent(monthKwh, todayKwh) {
    let changed = false;
    if (monthKwh != null && this.state.cloudMonthCurrent !== monthKwh) { this.state.cloudMonthCurrent = monthKwh; changed = true; }
    if (todayKwh != null && this.state.cloudToday !== todayKwh) { this.state.cloudToday = todayKwh; changed = true; }
    if (changed) this._save();
  }

  // ── 일별 사용량(KST 자정 경계) ────────────────────────────────────
  static _KST = 9 * 3600 * 1000;

  /** nowMs 가 속한 KST 날짜의 자정(실제 epoch ms). 서버 타임존과 무관. */
  _kstDayStart(nowMs) {
    const d = new Date(nowMs + MonthlyTracker._KST);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - MonthlyTracker._KST;
  }

  /** dayStartMs(KST 자정) → 'YYYY-MM-DD'(KST). */
  _kstYmd(dayStartMs) {
    return new Date(dayStartMs + MonthlyTracker._KST).toISOString().slice(0, 10);
  }

  /**
   * 기기 카운터로 일별 사용량을 로컬 기록. 날짜(KST)가 바뀌면 마감된 하루치를
   *   하루 kWh = (현재 카운터 - 그 날 자정 카운터) / 1e6
   * 로 히스토리에 남기고 새 날의 기준을 잡는다. 최근 120일 유지.
   * 여러 날 공백(플러그인 장기 다운) 시엔 뭉치지 않도록 기록 스킵 후 재기준.
   */
  recordDaily(counter_mWh, nowMs) {
    if (counter_mWh == null) return;
    const now = nowMs != null ? nowMs : Date.now();
    const curDayStart = this._kstDayStart(now);
    if (this.state.dayStartMs == null || this.state.dayStartCounter_mWh == null) {
      this.state.dayStartMs = curDayStart;
      this.state.dayStartCounter_mWh = counter_mWh;
      this._save();
      return;
    }
    if (curDayStart > this.state.dayStartMs + 60000) {
      const endedKwh = (counter_mWh - this.state.dayStartCounter_mWh) / 1e6;
      const spanDays = (curDayStart - this.state.dayStartMs) / 86400000;
      // 하루(±)만 정상 기록. 카운터 역행(기기 리셋)·장기 공백은 재기준만.
      if (endedKwh >= 0 && spanDays <= 1.5) {
        this._recordDaily(this._kstYmd(this.state.dayStartMs), Math.round(endedKwh * 100) / 100);
      }
      this.state.dayStartMs = curDayStart;
      this.state.dayStartCounter_mWh = counter_mWh;
      this._save();
    } else if (counter_mWh < this.state.dayStartCounter_mWh) {
      // v2.1.0 — 기기 리셋(카운터 역행)이 낮에 일어나면 '오늘'이 자정까지 동결되던 것 →
      // 즉시 재앵커 (당월 localMonthlyKwh의 재기준과 대칭. 그날 이전 사용분은 복원 불가라 0부터)
      this.state.dayStartCounter_mWh = counter_mWh;
      this._save();
    }
  }

  _recordDaily(date, kwh) {
    if (!Array.isArray(this.state.dailyHistory)) this.state.dailyHistory = [];
    const i = this.state.dailyHistory.findIndex((h) => h.date === date);
    if (i >= 0) this.state.dailyHistory[i].kwh = kwh;
    else this.state.dailyHistory.push({ date, kwh });
    this.state.dailyHistory.sort((a, b) => (a.date < b.date ? -1 : 1));
    if (this.state.dailyHistory.length > 120) this.state.dailyHistory = this.state.dailyHistory.slice(-120);
  }

  dailyHistory() { return Array.isArray(this.state.dailyHistory) ? this.state.dailyHistory : []; }

  /** 오늘(현재까지) 사용량 kWh. 오늘 자정 기준 카운터가 있어야 함. */
  todayKwh(counter_mWh, nowMs) {
    const now = nowMs != null ? nowMs : Date.now();
    if (counter_mWh == null || this.state.dayStartCounter_mWh == null) return null;
    if (this.state.dayStartMs !== this._kstDayStart(now)) return null;
    const k = (counter_mWh - this.state.dayStartCounter_mWh) / 1e6;
    return k >= 0 ? k : null;
  }

  /**
   * 클라우드 과거 일별을 로컬 히스토리에 backfill.
   * 로컬이 이미 가진 날은 건드리지 않고(로컬 우선), 없는 과거 날만 채운다. 오늘은 제외.
   * 변경이 있을 때만 저장. → 7/3·7/4 처럼 로컬 기록 이전의 날을 영구 보존.
   */
  backfillDaily(entries, todayStr) {
    if (!Array.isArray(entries)) return;
    if (!Array.isArray(this.state.dailyHistory)) this.state.dailyHistory = [];
    let changed = false;
    for (const e of entries) {
      if (!e || !e.date || e.date === todayStr || !(e.kwh > 0)) continue;
      if (this.state.dailyHistory.some((h) => h.date === e.date)) continue;
      this.state.dailyHistory.push({ date: e.date, kwh: e.kwh });
      changed = true;
    }
    if (changed) {
      this.state.dailyHistory.sort((a, b) => (a.date < b.date ? -1 : 1));
      if (this.state.dailyHistory.length > 120) this.state.dailyHistory = this.state.dailyHistory.slice(-120);
      this._save();
    }
  }

  /** 클라우드 과거 월별을 로컬 히스토리에 backfill(로컬 없는 월만, 당월 제외). */
  backfillMonthly(entries, curMonthStr) {
    if (!Array.isArray(entries)) return;
    if (!Array.isArray(this.state.history)) this.state.history = [];
    let changed = false;
    for (const e of entries) {
      if (!e || !e.month || e.month === curMonthStr || !(e.kwh > 0)) continue;
      if (this.state.history.some((h) => h.month === e.month)) continue;
      this.state.history.push({ month: e.month, kwh: e.kwh });
      changed = true;
    }
    if (changed) {
      this.state.history.sort((a, b) => (a.month < b.month ? -1 : 1));
      if (this.state.history.length > 36) this.state.history = this.state.history.slice(-36);
      this._save();
    }
  }

  /** 마감된 월(검침주기) 사용량을 히스토리에 누적(같은 월은 갱신). 최근 36개월 유지. */
  _recordHistory(month, kwh) {
    if (!Array.isArray(this.state.history)) this.state.history = [];
    const i = this.state.history.findIndex((h) => h.month === month);
    if (i >= 0) this.state.history[i].kwh = kwh;
    else this.state.history.push({ month, kwh });
    this.state.history.sort((a, b) => (a.month < b.month ? -1 : 1));
    if (this.state.history.length > 36) this.state.history = this.state.history.slice(-36);
  }

  history() { return Array.isArray(this.state.history) ? this.state.history : []; }

  /**
   * 로컬 당월 kWh.
   * - 기준선이 없으면 null 을 반환한다(여기서 임의로 잡지 않는다 → 잘못된 0 방지).
   *   기준선은 ensureLocalBaseline() 또는 검침일 롤오버로만 설정된다.
   * - 검침주기가 바뀌면(롤오버) 현재 카운터로 기준선을 리셋(0부터 재적산).
   * - 카운터가 기준선보다 작아지면(기기 교체/리셋) 재기준.
   * @returns kWh (number) 또는 null(기준선/카운터 미확보)
   */
  localMonthlyKwh(counter_mWh, nowMs) {
    if (counter_mWh == null || !this.hasBaseline()) return null;
    const now = nowMs != null ? nowMs : Date.now();
    const curPeriodStart = this._periodStartFor(now);

    if (curPeriodStart > (this.state.periodStartMs || 0) + 60000) {
      // 검침일 도래(롤오버) — 마감된 주기의 사용량을 히스토리에 기록 후 기준선 리셋.
      const endedKwh = (counter_mWh - this.state.periodStartCounter_mWh) / 1e6;
      const KST = 9 * 3600 * 1000;
      const endedMonth = new Date((this.state.periodStartMs || now) + KST).toISOString().slice(0, 7);
      // 기록은 '깨끗한 마감'일 때만. 오염 케이스는 스킵(과대·유실 귀속 방지):
      //  - partial   : 기준선이 주기 도중(오늘 자정)에 잡힌 부분값 → 한 달 전체로 기록 금지.
      //  - multiSpan : 다운이 2개+ 주기에 걸침 → 중간 월들이 한 엔트리로 뭉침.
      //  - lateWake  : 검침일 한참 뒤 복귀 → 신규 주기 초반 사용량이 마감월로 흡수.
      const prevPeriodStart = this._periodStartFor(curPeriodStart - 60000);
      const partial = this.state.periodPartial === true;
      const multiSpan = (this.state.periodStartMs || 0) < prevPeriodStart - 60000;
      const lateWake = (now - curPeriodStart) > 1.5 * 86400000;
      if (endedKwh > 0 && !partial && !multiSpan && !lateWake) {
        this._recordHistory(endedMonth, Math.round(endedKwh * 10) / 10);
        this.log.info(`[EnerTalk][local] 검침일 도래 — ${endedMonth} 사용량 ${Math.round(endedKwh * 10) / 10}kWh 기록, 새 주기 0부터 재적산.`);
      } else {
        this.log.warn(`[EnerTalk][local] 검침일 도래(${endedMonth}) — 부분/장기공백 마감으로 히스토리 기록 스킵(과대·유실 방지), 새 주기 재기준. [partial=${partial} multiSpan=${multiSpan} lateWake=${lateWake}]`);
      }
      this.state.periodStartMs = curPeriodStart;
      this.state.periodStartCounter_mWh = counter_mWh;
      // 새 주기는 검침일 정각에 기기 카운터로 직접 기준선을 잡으므로 100% 로컬·정확(부분값 아님).
      this.state.baselineForPeriodMs = curPeriodStart;
      this.state.periodPartial = false;
      this._save();
    }

    let kwh = (counter_mWh - this.state.periodStartCounter_mWh) / 1e6;
    if (kwh < 0) {
      // 카운터가 기준선보다 작음(기기 교체/카운터 리셋) → 주기 도중 재기준(부분값 표식).
      this.state.periodStartMs = curPeriodStart;
      this.state.periodStartCounter_mWh = counter_mWh;
      this.state.baselineForPeriodMs = curPeriodStart;
      this.state.periodPartial = true;
      this._save();
      kwh = 0;
    }
    return kwh;
  }
}

module.exports = MonthlyTracker;
