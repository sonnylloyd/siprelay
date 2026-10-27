import { Request, Response } from 'express';

export class HealthController {
  public static healthCheck(_req: Request, res: Response): void {
    res.status(200).json({ status: 'ok', message: 'SIP Proxy is healthy' });
  }
}
