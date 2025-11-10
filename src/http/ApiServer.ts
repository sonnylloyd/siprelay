import express from 'express';
import cors from 'cors';
import path from 'path';
import nunjucks from 'nunjucks';
import { Logger } from '../logging/Logger';
import { IRecordStore } from '../store';
import { DashboardController } from './controllers';
import { createApiRoutes } from './routes';

export class ApiServer {
  private app = express();
  private port: number;
  private logger: Logger;
  private records: IRecordStore;
  private dashboardController: DashboardController;

  constructor(port: number, logger: Logger, records: IRecordStore) {
    this.port = port;
    this.logger = logger;
    this.records = records;
    this.dashboardController = new DashboardController(records);

    this.setupMiddleware();
    this.setupViewEngine();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(cors()); // Enable CORS
    this.app.use(express.json()); // Enable JSON request parsing
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
    this.app.listen(this.port, () => {
      this.logger.info(`API Server running on port ${this.port} 🖥️`);
    });
  }
}
