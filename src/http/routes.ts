import express from 'express';
import { HealthController } from './controllers';

const router = express.Router();

// Define API routes
router.get('/health', HealthController.healthCheck);

export default router;
