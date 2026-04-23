import 'express-async-errors';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
import { connectDB } from './utils/db';
import { errorHandler } from './middleware/errorHandler';

import authRoutes      from './routes/auth.routes';
import jobRoutes       from './routes/job.routes';
import applicantRoutes from './routes/applicant.routes';
import screeningRoutes from './routes/screening.routes';
import dashboardRoutes from './routes/dashboard.routes';
import analyticsRoutes from './routes/analytics.routes';
import settingsRoutes  from './routes/settings.routes';

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 5000;

// ── CORS ─────────────────────────────────────────────────────
// Allow any origin that matches our known domains, plus localhost for dev.
// This handles Vercel preview URLs (*.vercel.app) automatically.
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:3001',
].filter(Boolean) as string[];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Render health checks)
    if (!origin) return callback(null, true);
    // Allow any vercel.app subdomain (covers preview deployments)
    if (origin.endsWith('.vercel.app')) return callback(null, true);
    // Allow exact matches
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200, // Some browsers (IE11) choke on 204
}));

// Handle preflight for ALL routes
app.options('*', cors());

// ── Body / static ────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(morgan('dev'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// ── Health (no auth — used by Render + frontend warm-up ping) ─
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'Umurava TalentAI Backend', timestamp: new Date().toISOString() });
});

// ── Routes ───────────────────────────────────────────────────
app.use('/api/auth',       authRoutes);
app.use('/api/jobs',       jobRoutes);
app.use('/api/applicants', applicantRoutes);
app.use('/api/screening',  screeningRoutes);
app.use('/api/dashboard',  dashboardRoutes);
app.use('/api/analytics',  analyticsRoutes);
app.use('/api/settings',   settingsRoutes);

// ── 404 ──────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// ── Global error handler ─────────────────────────────────────
app.use(errorHandler);

// ── Start ────────────────────────────────────────────────────
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 Umurava TalentAI Backend running on port ${PORT}`);
    console.log(`🌐 CORS allowed origins: ${ALLOWED_ORIGINS.join(', ')} + *.vercel.app`);
    console.log(`🤖 Gemini API: configured`);
    console.log(`📦 MongoDB: connected\n`);
  });
});

export default app;
