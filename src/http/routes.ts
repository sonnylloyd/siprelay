import express from 'express';
import { HealthController } from './controllers';
import { IRecordStore } from '../store';

export const createApiRoutes = (records: IRecordStore, storageHealthy = () => true): express.Router => {
  const router = express.Router();

  router.get('/health', HealthController.healthCheck);
  router.get('/ready', (_req, res) => {
    const healthy = storageHealthy();
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ready' : 'degraded' });
  });

  router.get('/routes', (_req, res) => {
    const routes = Object.entries(records.getAllRecords()).map(([host, record]) => ({
      host,
      ip: record.ip,
      udpPort: record.udpPort ?? null,
      tcpPort: record.tcpPort ?? null,
      tlsPort: record.tlsPort ?? null,
    }));

    res.json({
      total: routes.length,
      routes,
    });
  });

  return router;
};

export default createApiRoutes;
