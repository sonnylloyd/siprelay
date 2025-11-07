"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const UdpProxy_1 = require("../src/proxies/UdpProxy");
const store_1 = require("../src/store");
const utils_1 = require("./utils");
class FakeUdpSocket {
    constructor() {
        this.bind = vitest_1.vi.fn((_port, cb) => {
            cb === null || cb === void 0 ? void 0 : cb();
        });
        this.send = vitest_1.vi.fn((_buffer, _port, _address) => { });
        this.handlers = {};
    }
    on(event, handler) {
        this.handlers[event] = handler;
        return this;
    }
    emit(event, ...args) {
        var _a, _b;
        (_b = (_a = this.handlers)[event]) === null || _b === void 0 ? void 0 : _b.call(_a, ...args);
    }
}
const createSipRequest = (host, callId = 'abc123') => [
    `INVITE sip:${host} SIP/2.0`,
    'Via: SIP/2.0/UDP 198.51.100.10:5090;branch=z9hG4bK-12345;rport',
    'Max-Forwards: 70',
    'From: <sip:alice@example.com>;tag=abc',
    'To: <sip:bob@example.com>',
    `Call-ID: ${callId}`,
    'CSeq: 1 INVITE',
    'Contact: <sip:alice@198.51.100.10>',
    'Content-Length: 0',
    '',
    '',
].join('\r\n');
const createSipResponse = (statusLine, callId = 'abc123') => [
    statusLine,
    'Via: SIP/2.0/UDP 203.0.113.5:15060;branch=z9hG4bK-proxy',
    'From: <sip:alice@example.com>;tag=abc',
    'To: <sip:bob@example.com>;tag=xyz',
    `Call-ID: ${callId}`,
    'CSeq: 1 INVITE',
    'Content-Length: 0',
    '',
    '',
].join('\r\n');
(0, vitest_1.describe)('UdpProxy', () => {
    let socket;
    let proxy;
    let records;
    let config;
    let logger;
    (0, vitest_1.beforeEach)(() => {
        socket = new FakeUdpSocket();
        records = new store_1.MemoryStore();
        logger = (0, utils_1.createTestLogger)();
        config = (0, utils_1.createTestConfig)({ SIP_UDP_PORT: 15060, PROXY_IP: '203.0.113.5' });
        proxy = new UdpProxy_1.UdpProxy(records, config, logger, socket);
        proxy.start();
    });
    (0, vitest_1.it)('forwards SIP requests to the resolved PBX record and stores client info', () => {
        records.addRecord('pbx.internal', { ip: '10.0.0.50', udpPort: 5090 });
        const sip = createSipRequest('pbx.internal');
        const clientInfo = { address: '198.51.100.10', port: 5090, family: 'IPv4', size: sip.length };
        socket.emit('message', Buffer.from(sip), clientInfo);
        (0, vitest_1.expect)(socket.send).toHaveBeenCalledTimes(1);
        const [buffer, port, address] = socket.send.mock.calls[0];
        (0, vitest_1.expect)(port).toBe(5090);
        (0, vitest_1.expect)(address).toBe('10.0.0.50');
        (0, vitest_1.expect)(buffer.toString()).toContain('SIP/2.0/UDP 203.0.113.5:15060');
        const storedClient = proxy.clientMap.get('abc123');
        (0, vitest_1.expect)(storedClient).toMatchObject({ address: '198.51.100.10', port: 5090 });
    });
    (0, vitest_1.it)('forwards SIP responses back to the original client', () => {
        records.addRecord('pbx.internal', { ip: '10.0.0.50', udpPort: 5090 });
        const request = createSipRequest('pbx.internal');
        const clientInfo = { address: '198.51.100.10', port: 5090, family: 'IPv4', size: request.length };
        socket.emit('message', Buffer.from(request), clientInfo);
        socket.send.mockClear();
        const response = createSipResponse('SIP/2.0 200 OK');
        const pbxInfo = { address: '10.0.0.50', port: 5090, family: 'IPv4', size: response.length };
        socket.emit('message', Buffer.from(response), pbxInfo);
        (0, vitest_1.expect)(socket.send).toHaveBeenCalledTimes(1);
        const [buffer, port, address] = socket.send.mock.calls[0];
        (0, vitest_1.expect)(address).toBe('198.51.100.10');
        (0, vitest_1.expect)(port).toBe(5090);
        (0, vitest_1.expect)(buffer.toString()).toContain('SIP/2.0/UDP 198.51.100.10:5090');
    });
});
