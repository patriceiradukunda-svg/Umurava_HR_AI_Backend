import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { protect, AuthRequest } from '../middleware/auth.middleware';
import Applicant from '../models/Applicant.model';
import Job from '../models/Job.model';
import { parseCSV, parseXLSX, parsePDF, getFileType } from '../services/fileParser.service';

const router = Router();
router.use(protect);

// ── Multer config ────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(__dirname, '../../uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.csv', '.xlsx', '.xls', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only CSV, Excel, and PDF files are allowed'));
  },
});

// GET /api/applicants — list all with filters
router.get('/', async (req: AuthRequest, res: Response) => {
  const { jobId, status, source, search, page = 1, limit = 50 } = req.query;
  const filter: Record<string, unknown> = {};
  if (jobId) filter.jobId = jobId;
  if (status && status !== 'all') filter.status = status;
  if (source && source !== 'all') filter.source = source;
  if (search) {
    filter.$or = [
      { 'talentProfile.firstName': { $regex: search, $options: 'i' } },
      { 'talentProfile.lastName':  { $regex: search, $options: 'i' } },
      { 'talentProfile.email':     { $regex: search, $options: 'i' } },
    ];
  }

  const skip = (Number(page) - 1) * Number(limit);
  const [applicants, total] = await Promise.all([
    Applicant.find(filter).sort({ appliedAt: -1 }).skip(skip).limit(Number(limit)),
    Applicant.countDocuments(filter),
  ]);

  res.json({
    success: true,
    count: applicants.length,
    total,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
    data: applicants,
  });
});

// GET /api/applicants/stats — counts for dashboard badges
router.get('/stats', async (_req: AuthRequest, res: Response) => {
  const [total, pending, screened, shortlisted, rejected] = await Promise.all([
    Applicant.countDocuments(),
    Applicant.countDocuments({ status: 'pending' }),
    Applicant.countDocuments({ status: 'screened' }),
    Applicant.countDocuments({ status: 'shortlisted' }),
    Applicant.countDocuments({ status: 'rejected' }),
  ]);
  res.json({ success: true, data: { total, pending, screened, shortlisted, rejected } });
});

// GET /api/applicants/:id — single applicant
router.get('/:id', async (req: AuthRequest, res: Response) => {
  const applicant = await Applicant.findById(req.params.id).populate('jobId', 'title department');
  
