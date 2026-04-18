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
  if (!applicant) { res.status(404).json({ success: false, message: 'Applicant not found' }); return; }
  res.json({ success: true, data: applicant });
});

// POST /api/applicants — add single applicant (Umurava platform profile / manual)
router.post('/', async (req: AuthRequest, res: Response) => {
  const { jobId, source, talentProfile } = req.body;
  if (!jobId || !talentProfile) {
    res.status(400).json({ success: false, message: 'jobId and talentProfile are required' });
    return;
  }
  const job = await Job.findById(jobId);
  if (!job) { res.status(404).json({ success: false, message: 'Job not found' }); return; }

  // Check duplicate by email + jobId
  const exists = await Applicant.findOne({ jobId, 'talentProfile.email': talentProfile.email });
  if (exists) {
    res.status(409).json({ success: false, message: 'Applicant with this email already exists for this job' });
    return;
  }

  const applicant = await Applicant.create({
    jobId,
    source: source || 'umurava_platform',
    talentProfile,
  });

  await Job.findByIdAndUpdate(jobId, { $inc: { applicantCount: 1 } });
  res.status(201).json({ success: true, message: 'Applicant added', data: applicant });
});

// POST /api/applicants/bulk — add many Umurava profiles at once (array)
router.post('/bulk', async (req: AuthRequest, res: Response) => {
  const { jobId, profiles } = req.body;
  if (!jobId || !Array.isArray(profiles) || profiles.length === 0) {
    res.status(400).json({ success: false, message: 'jobId and profiles[] are required' });
    return;
  }
  const job = await Job.findById(jobId);
  if (!job) { res.status(404).json({ success: false, message: 'Job not found' }); return; }

  const docs = profiles.map(p => ({
    jobId,
    source: 'umurava_platform',
    talentProfile: p,
  }));

  const inserted = await Applicant.insertMany(docs, { ordered: false });
  await Job.findByIdAndUpdate(jobId, { $inc: { applicantCount: inserted.length } });

  res.status(201).json({
    success: true,
    message: `${inserted.length} applicants added`,
    count: inserted.length,
  });
});

// POST /api/applicants/upload — upload CSV / XLSX / PDF
router.post('/upload', upload.array('files', 20), async (req: AuthRequest, res: Response) => {
  const { jobId } = req.body;
  if (!jobId) { res.status(400).json({ success: false, message: 'jobId is required' }); return; }

  const job = await Job.findById(jobId);
  if (!job) { res.status(404).json({ success: false, message: 'Job not found' }); return; }

  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) {
    res.status(400).json({ success: false, message: 'No files uploaded' });
    return;
  }

  const results: { file: string; added: number; errors: string[] }[] = [];
  let totalAdded = 0;

  for (const file of files) {
    const fileType = getFileType(file.originalname);
    const fileResult = { file: file.originalname, added: 0, errors: [] as string[] };

    try {
      let parsed: Awaited<ReturnType<typeof parseCSV>> = [];

      if (fileType === 'csv') parsed = parseCSV(file.path);
      else if (fileType === 'xlsx') parsed = parseXLSX(file.path);
      else if (fileType === 'pdf') {
        const single = await parsePDF(file.path);
        parsed = [single];
      } else {
        fileResult.errors.push('Unsupported file type');
      }

      const source = fileType === 'pdf' ? 'pdf_upload' : 'csv_upload';

      for (const profile of parsed) {
        if (!profile.email) { fileResult.errors.push(`Row skipped: missing email`); continue; }
        const exists = await Applicant.findOne({ jobId, 'talentProfile.email': profile.email });
        if (exists) { fileResult.errors.push(`${profile.email} already exists`); continue; }

        await Applicant.create({
          jobId,
          source,
          resumeUrl: fileType === 'pdf' ? `/uploads/${file.filename}` : undefined,
          talentProfile: {
            ...profile,
            certifications: [],
          },
        });
        fileResult.added++;
        totalAdded++;
      }
    } catch (err) {
      fileResult.errors.push(`Parse error: ${(err as Error).message}`);
    }

    // Cleanup temp file
    try { fs.unlinkSync(file.path); } catch { /* ignore */ }
    results.push(fileResult);
  }

  await Job.findByIdAndUpdate(jobId, { $inc: { applicantCount: totalAdded } });

  res.json({
    success: true,
    message: `${totalAdded} applicants added from ${files.length} file(s)`,
    totalAdded,
    results,
  });
});

// PATCH /api/applicants/:id/status
router.patch('/:id/status', async (req: AuthRequest, res: Response) => {
  const { status } = req.body;
  const validStatuses = ['pending', 'screened', 'shortlisted', 'rejected'];
  if (!validStatuses.includes(status)) {
    res.status(400).json({ success: false, message: 'Invalid status' });
    return;
  }
  const applicant = await Applicant.findByIdAndUpdate(
    req.params.id, { status }, { new: true }
  );
  if (!applicant) { res.status(404).json({ success: false, message: 'Applicant not found' }); return; }
  res.json({ success: true, message: 'Status updated', data: applicant });
});

// DELETE /api/applicants/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const applicant = await Applicant.findById(req.params.id);
  if (!applicant) { res.status(404).json({ success: false, message: 'Applicant not found' }); return; }
  await Job.findByIdAndUpdate(applicant.jobId, { $inc: { applicantCount: -1 } });
  await applicant.deleteOne();
  res.json({ success: true, message: 'Applicant deleted' });
});

export default router;
