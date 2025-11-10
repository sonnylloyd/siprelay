import { Request, Response } from 'express';
import { IRecordStore } from '../../store';

export class DashboardController {
  constructor(private readonly records: IRecordStore) {}

  public render(_req: Request, res: Response): void {
    const recordEntries = Object.entries(this.records.getAllRecords());
    const routes = recordEntries
      .map(([host, value]) => ({
        host,
        ip: value.ip,
        udpPort: value.udpPort ?? '—',
        tlsPort: value.tlsPort ?? '—',
      }))
      .sort((a, b) => a.host.localeCompare(b.host));

    res.render('dashboard.njk', {
      stats: {
        totalRoutes: routes.length,
        generatedAt: new Date().toISOString(),
      },
      routes,
    });
  }
}
