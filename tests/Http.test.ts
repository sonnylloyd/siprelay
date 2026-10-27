import { flushAsync } from './fixtures/sip';
import express, { Request, Response } from 'express';
import http from 'http';
import nunjucks from 'nunjucks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiServer } from '../src/http/ApiServer';
import { createApiRoutes } from '../src/http/routes';
import { DashboardController, HealthController } from '../src/http/controllers';
import { MemoryStore } from '../src/store';
import { createTestConfig, createTestLogger } from './utils';

function dispatch(path: string, records = new MemoryStore()) {
  const json = vi.fn(); const status = vi.fn().mockReturnThis(); const next = vi.fn();
  const request = { method: 'GET', url: path, headers: {} } as Request;
  const response = { json, status } as unknown as Response;
  createApiRoutes(records)(request, response, next);
  return { json, status, next };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('HTTP API routes and dashboard', () => {
  it('returns liveness without requiring any discovered PBX', () => {
    const { json, status } = dispatch('/health');
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ status: 'ok', message: 'SIP Proxy is healthy' });
  });

  it('returns an empty route list and passes unmatched paths to the caller', async () => {
    expect(dispatch('/routes').json).toHaveBeenCalledWith({ total: 0, routes: [] });
    const missing = dispatch('/missing'); expect(missing.json).not.toHaveBeenCalled();
    await flushAsync(); expect(missing.next).toHaveBeenCalledTimes(1);
  });

  it('serializes discovered route endpoints with explicit nulls for absent transports', () => {
    const records = new MemoryStore();
    records.addRecord('one.internal', { ip: '10.0.0.1', udpPort: 5060 });
    records.addRecord('two.internal', { ip: '10.0.0.2', tlsPort: 5061 });
    expect(dispatch('/routes', records).json).toHaveBeenCalledWith({ total: 2, routes: [
      { host: 'one.internal', ip: '10.0.0.1', udpPort: 5060, tcpPort: null, tlsPort: null },
      { host: 'two.internal', ip: '10.0.0.2', udpPort: null, tcpPort: null, tlsPort: 5061 },
    ] });
  });

  it('renders sorted dashboard routes and generation metadata', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T09:00:00Z'));
    const records = new MemoryStore();
    records.addRecord('z.internal', { ip: '10.0.0.2', tlsPort: 5061 });
    records.addRecord('a.internal', { ip: '10.0.0.1', udpPort: 5060 });
    const render = vi.fn(); new DashboardController(records).render({} as Request, { render } as unknown as Response);
    expect(render).toHaveBeenCalledWith('dashboard.njk', {
      stats: { totalRoutes: 2, generatedAt: '2026-10-27T09:00:00.000Z' },
      routes: [
        { host: 'a.internal', ip: '10.0.0.1', udpPort: 5060, tcpPort: '—', tlsPort: '—' },
        { host: 'z.internal', ip: '10.0.0.2', udpPort: '—', tcpPort: '—', tlsPort: 5061 },
      ],
    });
  });

  it('keeps HTML escaping enabled and installs configured CORS and dashboard routes', () => {
    const configure = vi.spyOn(nunjucks, 'configure');
    const use = vi.spyOn(express.application, 'use');
    const get = vi.spyOn(express.application, 'get');
    const logger = createTestLogger();
    const listen = vi.spyOn(express.application, 'listen').mockImplementation(((port: number, callback: () => void) => {
      expect(port).toBe(18080); callback(); return {} as http.Server;
    }) as typeof express.application.listen);
    const api = new ApiServer(createTestConfig({ HTTP_CORS_ORIGINS: ['https://dashboard.example'] }), logger, new MemoryStore());
    api.start();
    const router = use.mock.calls.find(call => call[0] === '/api')![1] as express.Router;
    router({ method: 'GET', url: '/ready', headers: {} } as Request, { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response, vi.fn());
    expect(configure).toHaveBeenCalledWith(expect.stringContaining('views'), expect.objectContaining({ autoescape: true }));
    expect(use.mock.calls.some(call => call[0] === '/api')).toBe(true);
    expect(get.mock.calls.some(call => call[0] === '/')).toBe(true);
    expect(listen).toHaveBeenCalledTimes(1); expect(logger.info).toHaveBeenCalled();
  });

  it('constructs the API with CORS disabled and the health handler ignores request contents', () => {
    expect(() => new ApiServer(createTestConfig({ HTTP_CORS_ORIGINS: [] }), createTestLogger(), new MemoryStore())).not.toThrow();
    const json = vi.fn(); const status = vi.fn(() => ({ json }));
    HealthController.healthCheck({} as Request, { status } as unknown as Response);
    expect(status).toHaveBeenCalledWith(200);
  });
});

it.each([true, false])('reports push storage readiness as %s without exposing credentials', healthy => {
  const status = vi.fn().mockReturnThis(), json = vi.fn();
  createApiRoutes(new MemoryStore(), () => healthy)({ method: 'GET', url: '/ready', headers: {} } as Request, { status, json } as unknown as Response, vi.fn());
  expect(status).toHaveBeenCalledWith(healthy ? 200 : 503);
  expect(json).toHaveBeenCalledWith({ status: healthy ? 'ready' : 'degraded' });
});


it('defaults readiness to healthy for standalone route consumers', () => {
  expect(dispatch('/ready').status).toHaveBeenCalledWith(200);
});
