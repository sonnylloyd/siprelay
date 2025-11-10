import express from 'express';
import { HealthController } from './controllers';
import { IRecordStore } from '../store';

export const createApiRoutes = (records: IRecordStore): express.Router => {
  const router = express.Router();

  router.get('/health', HealthController.healthCheck);

  router.get('/routes', (_req, res) => {
    const routes = Object.entries(records.getAllRecords()).map(([host, record]) => ({
      host,
      ip: record.ip,
      udpPort: record.udpPort ?? null,
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
