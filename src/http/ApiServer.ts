import express from 'express';
import cors from 'cors';
import path from 'path';
import nunjucks from 'nunjucks';
import { Logger } from '../logging/Logger';
import { IRecordStore } from '../store';
import { DashboardController } from './controllers';
import { createApiRoutes } from './routes';
import { Config } from '../configurations';

export class ApiServer {
  private app = express();
  private config: Config;
  private logger: Logger;
  private records: IRecordStore;
  private dashboardController: DashboardController;

  constructor(config: Config, logger: Logger, records: IRecordStore) {
    this.config = config;
    this.logger = logger;
    this.records = records;
    this.dashboardController = new DashboardController(records);

    this.setupMiddleware();
    this.setupViewEngine();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    if (this.config.HTTP_CORS_ORIGINS.length > 0) {
      this.app.use(
        cors({
          origin: this.config.HTTP_CORS_ORIGINS,
        })
      );
    }
    this.app.use(express.json()); // Enable JSON request parsing
    const staticPath = path.join(__dirname, '..', 'images');
    this.app.use('/static', express.static(staticPath));
  }

  private setupViewEngine(): void {
    const viewsPath = path.join(__dirname, 'views');
    this.app.set('views', viewsPath);
    this.app.set('view engine', 'njk');

    nunjucks.configure(viewsPath, {
      autoescape: true,
      express: this.app,
    });
  }

  private setupRoutes(): void {
    this.app.get('/', this.dashboardController.render.bind(this.dashboardController));
    this.app.use('/api', createApiRoutes(this.records));
  }

  public start(): void {
    this.app.listen(this.config.HTTP_PORT, () => {
      this.logger.info(`API Server running on port ${this.config.HTTP_PORT} 🖥️`);
    });
  }
}
