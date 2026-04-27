import { Router, Response } from 'express';
import { protect, AuthRequest } from '../middleware/auth.middleware';
import Applicant from '../models/Applicant.model';
import Job from '../models/Job.model';

const router = Router();
router.use(protect);

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
        .populate('jobId', 'title department location type status minimumExperienceYears applicationDeadline createdAt')
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
      .populate('jobId', 'title department location type status minimumExperienceYears applicationDeadline createdAt');
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
      .populate('jobId', 'title department location type status minimumExperienceYears applicationDeadline createdAt');

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
