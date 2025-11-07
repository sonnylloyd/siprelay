"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTestLogger = exports.createTestConfig = void 0;
const vitest_1 = require("vitest");
const createTestConfig = (overrides = {}) => (Object.assign({ SIP_UDP_PORT: 15060, SIP_TLS_PORT: 15061, HTTP_PORT: 18080, SIP_TLS_KEY_PATH: '/tmp/server.key', SIP_TLS_CERT_PATH: '/tmp/server.crt', PROXY_IP: '203.0.113.5' }, overrides));
exports.createTestConfig = createTestConfig;
const createTestLogger = () => ({
    info: vitest_1.vi.fn(),
    warn: vitest_1.vi.fn(),
    error: vitest_1.vi.fn(),
});
exports.createTestLogger = createTestLogger;
