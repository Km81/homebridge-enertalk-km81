'use strict';

/**
 * EnerTalk(Encored) 기기 ↔ 클라우드(eddie-ext.encoredtech.com:5010) 사이의
 * 바이너리 프로토콜 파서/인코더.
 *
 * MITM 캡처(로컬)로 역분석한 프레임 구조. 클라우드 REST API 실측값과 교차검증 완료.
 *
 * 메시지 프레이밍 (TLS 위에 얹힘):
 *   [0]      0x03            프로토콜 버전
 *   [1]      type            0x00=제어/헬로, 0x40=텔레메트리(기기→서버), 0x80=서버 ack
 *   [2..3]   length (BE)     이 4바이트 헤더를 포함한 전체 길이
 *   [4..]    payload
 *
 * 텔레메트리 프레임(type=0x40, 예: 312B) 레이아웃:
 *   [4]      opcode-ish (ack 는 이 값 +0x20 을 echo)
 *   [20..21] 주파수 ×100 (5997 = 59.97Hz)
 *   [24..31] 타임스탬프 ms (u64 BE)
 *   [32..35] 서브샘플 개수 n (예: 15)
 *   [40..43] 전압 mV (u32)       → V = /1000
 *   [44..47] 전류 mA (u32)       → A = /1000
 *   [48..55] 누적 유효에너지 mWh (u64) → kWh = /1e6
 *   [72..]   16B 서브샘플 × n:
 *              [0..3]  유효전력 mW (u32)   → W = /1000
 *              [4..7]  무효전력 var (s32, 부호있음)
 *              [8..9]  c (미상, ~290)
 *              [10..11] d (미상, ~168)
 *              [12..15] 0
 *   서브샘플 시작 offset = 전체길이 - 16*n (312-240=72).
 */

const VERSION = 0x03;
const TYPE_CONTROL = 0x00;   // 헬로/등록
const TYPE_TELEMETRY = 0x40; // 실시간 데이터
const TYPE_ACK = 0x80;       // 서버 → 기기 ack
const KNOWN_TYPES = new Set([TYPE_CONTROL, TYPE_TELEMETRY, TYPE_ACK]);
const MAX_FRAME = 8192;      // 관측상 최대 312B. 여유롭게 상한.
const MAX_BUF = 65536;       // reader 버퍼 상한(폭주 방지)

/** 스트림에서 프레임 경계를 재조립. TLS 소켓 data 이벤트 버퍼를 push 하면 완성된 메시지 배열을 돌려준다. */
class FrameReader {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  /** @returns {Buffer[]} 완성된 메시지들 */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    // 버퍼 폭주 방지(오염/미완 프레임 누적) — 상한 초과 시 마지막 MAX_BUF 만 유지하며 재동기.
    if (this.buf.length > MAX_BUF) {
      const idx = this.buf.indexOf(VERSION, this.buf.length - MAX_BUF);
      this.buf = idx === -1 ? Buffer.alloc(0) : this.buf.subarray(idx);
    }
    const out = [];
    while (this.buf.length >= 4) {
      // 버전(0x03) + 알려진 타입만 프레임 시작으로 인정 → 오정렬 길이필드로 인한 프레임 삼킴 방지
      if (this.buf[0] !== VERSION || !KNOWN_TYPES.has(this.buf[1])) {
        const idx = this.buf.indexOf(VERSION, 1);
        if (idx === -1) { this.buf = Buffer.alloc(0); break; }
        this.buf = this.buf.subarray(idx);
        continue;
      }
      const len = this.buf.readUInt16BE(2);
      if (len < 4 || len > MAX_FRAME) { // 비정상 길이 — 1바이트 버리고 재동기
        this.buf = this.buf.subarray(1);
        continue;
      }
      if (this.buf.length < len) break; // 아직 다 안 옴
      out.push(this.buf.subarray(0, len));
      this.buf = this.buf.subarray(len);
    }
    return out;
  }
}

function frameType(msg) {
  return msg.length >= 2 ? msg[1] : -1;
}

/**
 * 기기 메시지에 대한 서버 ack 생성.
 * - 관측: ack[4] = req[4] + 0x20.
 * - 첫 텔레메트리(type=0x40) 프레임엔 클라우드가 16B(서버 ms echo) ack 를 1회 보냈고,
 *   이후/그 외에는 8B ack 를 보냄. 그 동작을 그대로 재현한다.
 * @param {Buffer} msg 기기가 보낸 원본 메시지
 * @param {{first16?:boolean, nowMs?:number}} opt
 */
function buildAck(msg, opt = {}) {
  const corr = ((msg.length >= 5 ? msg[4] : 0) + 0x20) & 0xff;
  if (opt.first16) {
    const b = Buffer.alloc(16);
    b[0] = VERSION; b[1] = TYPE_ACK; b.writeUInt16BE(16, 2);
    b[4] = corr; // [5..7] = 0
    const now = BigInt(Math.floor(opt.nowMs != null ? opt.nowMs : Date.now()));
    b.writeBigUInt64BE(now & 0xffffffffffffn, 8);
    return b;
  }
  const b = Buffer.alloc(8);
  b[0] = VERSION; b[1] = TYPE_ACK; b.writeUInt16BE(8, 2);
  b[4] = corr; // [5..7] = 0
  return b;
}

/**
 * 텔레메트리 프레임(type=0x40) 디코드.
 * @returns {null | {ts, freqHz, voltage_mV, current_mA, energy_mWh, sampleCount,
 *                   activePower_mW, reactivePower_var, samples}}
 */
function parseTelemetry(msg) {
  if (msg.length < 56 || msg[1] !== TYPE_TELEMETRY) return null;
  const total = msg.length;
  // 기기 식별자([6:16]) — 다중 기기 라우팅/락에 사용
  const deviceId = msg.subarray(6, 16).toString('hex');
  const freqHz = msg.readUInt16BE(20) / 100;
  const ts = Number(msg.readBigUInt64BE(24));
  const n = msg.readUInt32BE(32);
  const voltage_mV = msg.readUInt32BE(40);
  const current_mA = msg.readUInt32BE(44);
  const energy_mWh = Number(msg.readBigUInt64BE(48));

  const recStart = total - 16 * n;
  const samples = [];
  if (n > 0 && recStart >= 56 && recStart + 16 * n <= total) {
    for (let i = 0; i < n; i++) {
      const o = recStart + 16 * i;
      samples.push({
        // 유효전력은 부호있는 값(역송/음수 가능) — unsigned 로 읽으면 소량 음수가 ~4.29e9 로 튐
        active_mW: msg.readInt32BE(o),
        reactive_var: msg.readInt32BE(o + 4),
        c: msg.readUInt16BE(o + 8),
        d: msg.readUInt16BE(o + 10),
      });
    }
  }
  const activePower_mW = samples.length
    ? Math.round(samples.reduce((s, x) => s + x.active_mW, 0) / samples.length)
    : null;
  const reactivePower_var = samples.length
    ? Math.round(samples.reduce((s, x) => s + x.reactive_var, 0) / samples.length)
    : null;

  return {
    ts, freqHz, voltage_mV, current_mA, energy_mWh, deviceId,
    sampleCount: n, activePower_mW, reactivePower_var, samples,
  };
}

module.exports = {
  VERSION, TYPE_CONTROL, TYPE_TELEMETRY, TYPE_ACK,
  FrameReader, frameType, buildAck, parseTelemetry,
};
