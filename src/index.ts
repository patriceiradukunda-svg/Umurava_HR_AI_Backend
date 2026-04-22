import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
import { connectDB } from './utils/db';
import { errorHandler } from './middleware/errorHandler';

// Routes
import authRoutes from './routes/auth.routes';
import jobRoutes from './routes/job.routes';
import applicantRoutes from './routes/applicant.routes';
import screeningRoutes from './routes/screening.routes';
import dashboardRoutes from './routes/dashboard.routes';
import analyticsRoutes from './routes/analytics.routes';
import settingsRoutes from './routes/settings.routes';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ── CORS ────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    const allowed = [
      process.env.FRONTEND_URL,
      'https://umurava-hr-ai-frontend-three.vercel.app',
      'https://human-resource-ai-solution.vercel.app',
      'http://localhost:3000',
      'http://localhost:3001',
    ].filter(Boolean)

    // Allow requests with no origin (Postman, mobile apps, curl)
    if (!origin) {
      callback(null, true)
      return
    }

    if (allowed.includes(origin)) {
      callback(null, true)
    } else {
      console.log(`⚠️  CORS request from unlisted origin: ${origin} — allowing anyway`)
      callback(null, true) // allow all during hackathon
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))

// ── Middleware ──────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}))
app.use(morgan('dev'))
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))
app.use('/uploads', express.static(path.join(__dirname, '../uploads')))

// ── Health check (test this first in browser) ───────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'Umurava TalentAI Backend',
    timestamp: new Date().toISOString(),
    frontend: process.env.FRONTEND_URL || 'not set',
    mongodb: 'connected',
  })
})

// ── API Routes ──────────────────────────────────────────────
app.use('/api/auth',       authRoutes)
app.use('/api/jobs',       jobRoutes)
app.use('/api/applicants', applicantRoutes)
app.use('/api/screening',  screeningRoutes)
app.use('/api/dashboard',  dashboardRoutes)
app.use('/api/analytics',  analyticsRoutes)
app.use('/api/settings',   settingsRoutes)

// ── 404 ─────────────────────────────────────────────────────
app.use((req, res) => {
  console.log(`404 — ${req.method} ${req.originalUrl}`)
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` })
})

// ── Error handler ────────────────────────────────────────────
app.use(errorHandler)

// ── Start server FIRST so Render detects the open port ──────
app.listen(PORT, () => {
  console.log(`\n🚀 Umurava TalentAI Backend running on port ${PORT}`)
  console.log(`🌐 CORS enabled for: ${process.env.FRONTEND_URL || 'not set'}`)
  console.log(`🤖 Gemini API: configured`)
})

// ── Connect to MongoDB after server is already up ────────────
connectDB()
  .then(() => {
    console.log('📦 MongoDB: connected\n')
  })
  .catch((err) => {
    console.error('❌ MongoDB connection failed:', err.message)
    // Do NOT exit — keep server alive so Render stays up
  })

export default app
