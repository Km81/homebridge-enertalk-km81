'use strict';

/**
 * EnerTalk 기기를 클라우드 대신 직접 받는 로컬 TLS 서버.
 *
 * 라우터에서 `eddie-ext.encoredtech.com` 을 이 호스트로 DNS 리다이렉트하면,
 * 기기가 클라우드 대신 여기로 붙는다. 기기는 서버 인증서를 검증하지 않으므로(실측 확인)
 * self-signed 인증서로 TLS 를 종단하고, 기기가 기대하는 ack 를 돌려준 뒤
 * 텔레메트리 프레임을 디코드해 'reading' 이벤트로 흘려준다.
 *
 *   server.on('reading', (r) => ...)   // r = parseTelemetry() 결과
 *
 * 기기는 옛 TLS(TLSv1 / AES256-SHA)를 쓰므로 minVersion/ciphers 를 낮춰야 한다.
 */

const tls = require('tls');
const EventEmitter = require('events');
const F = require('./EnerTalkFrame.js');

const DEFAULT_PORT = 5010;
const DEFAULT_HOST = 'eddie-ext.encoredtech.com';

class LocalServer extends EventEmitter {
  constructor({ port = DEFAULT_PORT, log = console, cert = null, key = null } = {}) {
    super();
    this.port = port;
    this.log = log;
    this._cert = cert;
    this._key = key;
    this.server = null;
    this._conns = new Set();
  }

  _ensureCert() {
    if (this._cert && this._key) return { cert: this._cert, key: this._key };
    // selfsigned(순수 JS)로 self-signed 인증서 생성. 기기가 검증 안 하므로 CN/SAN 은 형식상.
    const selfsigned = require('selfsigned');
    const pems = selfsigned.generate(
      [{ name: 'commonName', value: DEFAULT_HOST }],
      {
        keySize: 2048,
        days: 3650,
        algorithm: 'sha256',
        extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: DEFAULT_HOST }] }],
      }
    );
    this._cert = pems.cert;
    this._key = pems.private;
    return { cert: this._cert, key: this._key };
  }

  start() {
    const { cert, key } = this._ensureCert();
    const opts = {
      cert,
      key,
      // 기기가 TLSv1 / 구형 cipher 를 씀 → 허용치 낮춤
      minVersion: 'TLSv1',
      ciphers: 'AES256-SHA:AES128-SHA:DEFAULT:@SECLEVEL=0',
      honorCipherOrder: false,
      requestCert: false,
    };
    this._listening = false;
    this.server = tls.createServer(opts, (sock) => this._onConn(sock));
    this.server.on('tlsClientError', (e) => this.log.debug('[EnerTalk][local] TLS 오류:', e && e.message));
    this.server.on('error', (e) => {
      if (!this._listening) {
        // listen 실패(EADDRINUSE 등)는 동기 예외가 아니라 이 이벤트로 온다 → 상위가 재시도하도록 알림.
        this.log.error(`[EnerTalk][local] TLS 서버 listen 실패 :${this.port} — ${(e && e.code) || ''} ${e && e.message}`);
        this.emit('listen-error', e);
      } else {
        this.log.warn('[EnerTalk][local] 서버 오류:', e && e.message);
      }
    });
    this.server.listen(this.port, () => {
      this._listening = true;
      this.emit('listening');
      this.log.info(`[EnerTalk][local] TLS 서버 대기 :${this.port} — DNS 로 ${DEFAULT_HOST} 를 이 호스트로 돌리면 기기가 붙습니다.`);
    });
    return this;
  }

  _onConn(sock) {
    const peer = `${sock.remoteAddress}:${sock.remotePort}`;
    // v2.1.0 — 동시 연결 상한: LAN 노출 포트에 다수 연결로 소켓·버퍼 점유 방지 (기기는 1대)
    if (this._conns.size >= 4) {
      this.log.warn(`[EnerTalk][local] 동시 연결 상한(4) 초과 — ${peer} 거절`);
      try { sock.destroy(); } catch (_) { /* 무시 */ }
      return;
    }
    const reader = new F.FrameReader();
    let firstData = true;
    this._conns.add(sock);
    this.log.debug(`[EnerTalk][local] 기기 연결 ${peer}`);
    sock.setTimeout(120000); // 기기는 초당 전송 — 2분 무통신이면 정리

    sock.on('data', (chunk) => {
      let msgs;
      try { msgs = reader.push(chunk); } catch (e) { this.log.debug('[EnerTalk][local] 파싱 오류:', e.message); return; }
      for (const msg of msgs) {
        const type = F.frameType(msg);
        if (type === F.TYPE_TELEMETRY) {
          const first16 = firstData;
          firstData = false;
          try { sock.write(F.buildAck(msg, { first16 })); } catch (e) { /* 무시 */ }
          const r = F.parseTelemetry(msg);
          if (r) this.emit('reading', r, { peer });
        } else {
          // 헬로/제어 → 8B ack
          try { sock.write(F.buildAck(msg, { first16: false })); } catch (e) { /* 무시 */ }
        }
      }
    });

    const cleanup = (why) => {
      if (this._conns.delete(sock)) this.log.debug(`[EnerTalk][local] 연결 종료 ${peer} (${why})`);
      try { sock.destroy(); } catch (e) { /* 무시 */ }
    };
    sock.on('timeout', () => cleanup('timeout'));
    sock.on('error', (e) => cleanup('err:' + (e && e.message)));
    sock.on('close', () => cleanup('close'));
  }

  stop() {
    this._listening = false;
    for (const s of this._conns) { try { s.destroy(); } catch (e) { /* 무시 */ } }
    this._conns.clear();
    if (this.server) { try { this.server.close(); } catch (e) { /* 무시 */ } this.server = null; }
  }
}

module.exports = LocalServer;
module.exports.DEFAULT_PORT = DEFAULT_PORT;
module.exports.DEFAULT_HOST = DEFAULT_HOST;
