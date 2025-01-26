import express from 'express';
import cors from 'cors';
import { Logger } from '../logging/Logger';
import routes from './routes';

export class ApiServer {
  private app = express();
  private port: number;
  private logger: Logger;

  constructor(port: number, logger: Logger) {
    this.port = port;
    this.logger = logger;

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(cors()); // Enable CORS
    this.app.use(express.json()); // Enable JSON request parsing
  }

  private setupRoutes(): void {
    this.app.use('/api', routes);
  }

  public start(): void {
    this.app.listen(this.port, () => {
      this.logger.info(`API Server running on port ${this.port} 🖥️`);
    });
  }
}