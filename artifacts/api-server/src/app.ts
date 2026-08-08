import express from 'express';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { logger } from './lib/logger.js';
import apiRouter from './routes/index.js';

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/health' } }));

app.use('/api', apiRouter);

// Frontend is deployed separately on Vercel — this server only handles
// /api/* routes and WebSocket connections. No static file serving.
app.get('/', (_req, res) => res.json({ name: 'Apex Meme Trader API', status: 'running' }));

export default app;
