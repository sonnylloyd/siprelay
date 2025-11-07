"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const events_1 = require("events");
const timers_1 = require("timers");
const vitest_1 = require("vitest");
const TlsProxy_1 = require("../src/proxies/TlsProxy");
const store_1 = require("../src/store");
const utils_1 = require("./utils");
class FakeTLSSocket extends events_1.EventEmitter {
    constructor(name) {
        super();
        this.name = name;
        this.writes = [];
        this.destroyed = false;
    }
    write(payload) {
        const text = typeof payload === 'string' ? payload : payload.toString();
        this.writes.push(text);
        return true;
    }
    setKeepAlive(_value) {
        // no-op for tests
    }
    destroy() {
        this.destroyed = true;
        this.emit('close');
    }
    emitData(payload) {
        this.emit('data', Buffer.from(payload));
    }
}
class FakeTlsServer {
    listen(_port, _host, cb) {
        cb === null || cb === void 0 ? void 0 : cb();
        return this;
    }
    setListener(listener) {
        this.listener = listener;
    }
    accept(socket) {
        var _a;
        (_a = this.listener) === null || _a === void 0 ? void 0 : _a.call(this, socket);
    }
}
const createSipRequest = (host, callId = 'call-1') => [
    `INVITE sip:${host} SIP/2.0`,
    'Via: SIP/2.0/TLS 198.51.100.20:5092;branch=z9hG4bK-client;rport',
    'From: <sip:alice@example.com>;tag=abc',
    'To: <sip:bob@example.com>',
    `Call-ID: ${callId}`,
    'CSeq: 1 INVITE',
    'Contact: <sip:alice@198.51.100.20>',
    'Content-Length: 0',
    '',
    '',
].join('\r\n');
const createSipResponse = (callId = 'call-1') => [
    'SIP/2.0 200 OK',
    'Via: SIP/2.0/TLS 203.0.113.5:5061;branch=z9hG4bK-proxy',
    'From: <sip:alice@example.com>;tag=abc',
    'To: <sip:bob@example.com>;tag=xyz',
    `Call-ID: ${callId}`,
    'CSeq: 1 INVITE',
    'Content-Length: 0',
    '',
    '',
].join('\r\n');
const flushAsync = () => new Promise((resolve) => (0, timers_1.setImmediate)(resolve));
(0, vitest_1.describe)('TlsProxy', () => {
    let clientSocket;
    let upstreamSocket;
    let fakeServer;
    let tlsProxy;
    let logger;
    let config;
    (0, vitest_1.beforeEach)(() => {
        clientSocket = new FakeTLSSocket('client');
        clientSocket.remoteAddress = '198.51.100.20';
        clientSocket.remotePort = 5092;
        upstreamSocket = new FakeTLSSocket('upstream');
        fakeServer = new FakeTlsServer();
        logger = (0, utils_1.createTestLogger)();
        config = (0, utils_1.createTestConfig)({ SIP_TLS_PORT: 5061, PROXY_IP: '203.0.113.5' });
        const serverFactory = vitest_1.vi.fn((_options, listener) => {
            fakeServer.setListener(listener);
            return fakeServer;
        });
        const tlsConnect = vitest_1.vi.fn((_options) => {
            (0, timers_1.setImmediate)(() => upstreamSocket.emit('secureConnect'));
            return upstreamSocket;
        });
        const records = new store_1.MemoryStore();
        records.addRecord('pbx.internal', { ip: '10.0.0.50', tlsPort: 5071 });
        tlsProxy = new TlsProxy_1.TlsProxy(records, config, logger, {
            tlsOptions: { key: Buffer.from('key'), cert: Buffer.from('cert') },
            serverFactory,
            tlsConnect,
        });
        tlsProxy.start();
        fakeServer.accept(clientSocket);
    });
    (0, vitest_1.it)('buffers chunked client data and forwards complete messages upstream', () => __awaiter(void 0, void 0, void 0, function* () {
        const request = createSipRequest('pbx.internal');
        clientSocket.emit('data', Buffer.from(request.slice(0, 40)));
        yield flushAsync();
        clientSocket.emit('data', Buffer.from(request.slice(40)));
        yield flushAsync();
        (0, vitest_1.expect)(upstreamSocket.writes).toHaveLength(1);
        (0, vitest_1.expect)(upstreamSocket.writes[0]).toContain('SIP/2.0/TLS 203.0.113.5:5061');
        const storedClient = tlsProxy.clientMap.get('call-1');
        (0, vitest_1.expect)(storedClient === null || storedClient === void 0 ? void 0 : storedClient.socket).toBe(clientSocket);
    }));
    (0, vitest_1.it)('forwards upstream SIP responses back to the client transport', () => __awaiter(void 0, void 0, void 0, function* () {
        const request = createSipRequest('pbx.internal');
        clientSocket.emitData(request);
        yield flushAsync();
        const response = createSipResponse();
        upstreamSocket.emitData(response);
        yield flushAsync();
        (0, vitest_1.expect)(clientSocket.writes).toHaveLength(1);
        (0, vitest_1.expect)(clientSocket.writes[0]).toContain('SIP/2.0/TLS 198.51.100.20:5092');
    }));
});
