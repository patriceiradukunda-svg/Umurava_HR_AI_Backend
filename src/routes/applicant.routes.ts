import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { protect, AuthRequest } from '../middleware/auth.middleware';
import Applicant from '../models/Applicant.model';
import Job from '../models/Job.model';
import { parseCSV, parseXLSX, parsePDF, getFileType, ParsedApplicant } from '../services/fileParser.service';

const router = Router();
router.use(protect);

// ── Multer config ────────────────────────────────────────────────────────────
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
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.csv', '.xlsx', '.xls', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only CSV, Excel, and PDF files are allowed'));
  },
});

// ── GET /api/applicants ──────────────────────────────────────────────────────
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { jobId, status, source, search, page = 1, limit = 50 } = req.query;

    const filter: Record<string, unknown> = {};
    if (jobId)                      filter.jobId  = jobId;
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
      Applicant.find(filter)
        .populate('jobId', 'title department location type status minimumExperienceYears')
        .sort({ appliedAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      Applicant.countDocuments(filter),
    ]);

    res.json({
      success: true,
      count:   applicants.length,
      total,
      page:    Number(page),
      pages:   Math.ceil(total / Number(limit)),
      data:    applicants,
    });
  } catch (err: any) {
    console.error('❌ GET /applicants error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load applicants' });
  }
});

// ── GET /api/applicants/stats ────────────────────────────────────────────────
router.get('/stats', async (_req: AuthRequest, res: Response) => {
  try {
    const [total, pending, screened, shortlisted, rejected] = await Promise.all([
      Applicant.countDocuments(),
      Applicant.countDocuments({ status: 'pending' }),
      Applicant.countDocuments({ status: 'screened' }),
      Applicant.countDocuments({ status: 'shortlisted' }),
      Applicant.countDocuments({ status: 'rejected' }),
    ]);
    res.json({ success: true, data: { total, pending, screened, shortlisted, rejected } });
  } catch (err: any) {
    console.error('❌ GET /applicants/stats error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load stats' });
  }
});

// ── GET /api/applicants/:id ──────────────────────────────────────────────────
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const applicant = await Applicant.findById(req.params.id)
      .populate('jobId', 'title department location type status minimumExperienceYears');
    if (!applicant) {
      res.status(404).json({ success: false, message: 'Applicant not found' });
      return;
    }
    res.json({ success: true, data: applicant });
  } catch (err: any) {
    console.error('❌ GET /applicants/:id error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load applicant' });
  }
});

// ── POST /api/applicants ─────────────────────────────────────────────────────
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { jobId, talentProfile, source = 'umurava_platform' } = req.body;

    if (!jobId || !talentProfile) {
      res.status(400).json({ success: false, message: 'jobId and talentProfile are required' });
      return;
    }

    const job = await Job.findById(jobId);
    if (!job) {
      res.status(404).json({ success: false, message: 'Job not found' });
      return;
    }

    // Prevent duplicate application from the same email for the same job
    const existing = await Applicant.findOne({
      jobId,
      'talentProfile.email': talentProfile.email?.toLowerCase?.() || talentProfile.email,
    });
    if (existing) {
      res.status(409).json({ success: false, message: 'You have already applied to this position' });
      return;
    }

    const applicant = await Applicant.create({ jobId, talentProfile, source });
    await Job.findByIdAndUpdate(jobId, { $inc: { applicantCount: 1 } });

    // Return with populated jobId so frontend can display job title immediately
    const populated = await Applicant.findById(applicant._id)
      .populate('jobId', 'title department location type status minimumExperienceYears');

    res.status(201).json({ success: true, data: populated });
  } catch (err: any) {
    console.error('❌ POST /applicants error:', err.message);
    if (err.name === 'ValidationError') {
      res.status(400).json({ success: false, message: err.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to submit application' });
  }
});

// ── POST /api/applicants/bulk-upload ─────────────────────────────────────────
router.post('/bulk-upload', upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: 'No file uploaded' });
      return;
    }

    const { jobId } = req.body;
    if (!jobId) {
      fs.unlinkSync(req.file.path);
      res.status(400).json({ success: false, message: 'jobId is required' });
      return;
    }

    const job = await Job.findById(jobId);
    if (!job) {
      fs.unlinkSync(req.file.path);
      res.status(404).json({ success: false, message: 'Job not found' });
      return;
    }

    const fileType = getFileType(req.file.originalname);
    let profiles: ParsedApplicant[] = [];

    if (fileType === 'csv')       profiles = await parseCSV(req.file.path);
    else if (fileType === 'xlsx') profiles = await parseXLSX(req.file.path);
    else if (fileType === 'pdf')  profiles = [await parsePDF(req.file.path)];
    else {
      fs.unlinkSync(req.file.path);
      res.status(400).json({ success: false, message: 'Unsupported file type' });
      return;
    }

    fs.unlinkSync(req.file.path);

    if (!profiles.length) {
      res.status(400).json({ success: false, message: 'No valid records found in file' });
      return;
    }

    const docs = profiles.map(profile => ({
      jobId,
      talentProfile: profile,
      source: 'bulk_upload',
    }));

    const inserted = await Applicant.insertMany(docs, { ordered: false });
    await Job.findByIdAndUpdate(jobId, { $inc: { applicantCount: inserted.length } });

    res.status(201).json({
      success: true,
      message: `${inserted.length} applicant(s) uploaded successfully`,
      count:   inserted.length,
    });
  } catch (err: any) {
    console.error('❌ POST /applicants/bulk-upload error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to upload applicants' });
  }
});

// ── PATCH /api/applicants/:id/status ─────────────────────────────────────────
router.patch('/:id/status', async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.body;
    const allowed = ['pending', 'screened', 'shortlisted', 'rejected', 'hired'];

    if (!allowed.includes(status)) {
      res.status(400).json({ success: false, message: `Status must be one of: ${allowed.join(', ')}` });
      return;
    }

    const applicant = await Applicant.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true, runValidators: true }
    ).populate('jobId', 'title department location type status');

    if (!applicant) {
      res.status(404).json({ success: false, message: 'Applicant not found' });
      return;
    }

    res.json({ success: true, data: applicant });
  } catch (err: any) {
    console.error('❌ PATCH /applicants/:id/status error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update status' });
  }
});

// ── PATCH /api/applicants/:id ────────────────────────────────────────────────
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const applicant = await Applicant.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true }
    ).populate('jobId', 'title department location type status');

    if (!applicant) {
      res.status(404).json({ success: false, message: 'Applicant not found' });
      return;
    }

    res.json({ success: true, data: applicant });
  } catch (err: any) {
    console.error('❌ PATCH /applicants/:id error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update applicant' });
  }
});

// ── DELETE /api/applicants/:id ───────────────────────────────────────────────
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const applicant = await Applicant.findByIdAndDelete(req.params.id);
    if (!applicant) {
      res.status(404).json({ success: false, message: 'Applicant not found' });
      return;
    }
    await Job.findByIdAndUpdate(applicant.jobId, { $inc: { applicantCount: -1 } });
    res.json({ success: true, message: 'Applicant deleted successfully' });
  } catch (err: any) {
    console.error('❌ DELETE /applicants/:id error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete applicant' });
  }
});

export default router;
