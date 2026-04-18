import { Router, Response } from 'express';
import { protect, AuthRequest } from '../middleware/auth.middleware';
import Job from '../models/Job.model';
import Applicant from '../models/Applicant.model';

const router = Router();
router.use(protect);

// GET /api/jobs — list all jobs with filters
router.get('/', async (req: AuthRequest, res: Response) => {
  const { status, location, department, search } = req.query;
  const filter: Record<string, unknown> = {};
  if (status && status !== 'all') filter.status = status;
  if (location && location !== 'all') filter.location = { $regex: location, $options: 'i' };
  if (department && department !== 'all') filter.department = { $regex: department, $options: 'i' };
  if (search) filter.title = { $regex: search, $options: 'i' };

  const jobs = await Job.find(filter)
    .populate('createdBy', 'firstName lastName email')
    .sort({ createdAt: -1 });

  res.json({ success: true, count: jobs.length, data: jobs });
});

// GET /api/jobs/stats — counts per status (used by dashboard & sidebar badge)
router.get('/stats', async (_req: AuthRequest, res: Response) => {
  const [active, draft, screening, closed, total] = await Promise.all([
    Job.countDocuments({ status: 'active' }),
    Job.countDocuments({ status: 'draft' }),
    Job.countDocuments({ status: 'screening' }),
    Job.countDocuments({ status: 'closed' }),
    Job.countDocuments(),
  ]);
  res.json({ success: true, data: { total, active, draft, screening, closed } });
});

// GET /api/jobs/:id — single job
router.get('/:id', async (req: AuthRequest, res: Response) => {
  const job = await Job.findById(req.params.id).populate('createdBy', 'firstName lastName');
  if (!job) { res.status(404).json({ success: false, message: 'Job not found' }); return; }
  res.json({ success: true, data: job });
});

// POST /api/jobs — create job
router.post('/', async (req: AuthRequest, res: Response) => {
  const {
    title, department, location, type, description, requirements,
    requiredSkills, niceToHaveSkills, minimumExperienceYears,
    educationLevel, shortlistSize, status, screeningNotes,
  } = req.body;

  if (!title || !department || !location || !description) {
    res.status(400).json({ success: false, message: 'title, department, location, description are required' });
    return;
  }

  const job = await Job.create({
    title, department, location, type, description,
    requirements: requirements || [],
    requiredSkills: requiredSkills || [],
    niceToHaveSkills: niceToHaveSkills || [],
    minimumExperienceYears: minimumExperienceYears || 0,
    educationLevel: educationLevel || "Bachelor's",
    shortlistSize: shortlistSize || 10,
    status: status || 'draft',
    screeningNotes,
    createdBy: req.user!.id,
  });

  res.status(201).json({ success: true, message: 'Job created successfully', data: job });
});

// PUT /api/jobs/:id — update job
router.put('/:id', async (req: AuthRequest, res: Response) => {
  const job = await Job.findByIdAndUpdate(req.params.id, req.body, {
    new: true, runValidators: true,
  });
  if (!job) { res.status(404).json({ success: false, message: 'Job not found' }); return; }
  res.json({ success: true, message: 'Job updated', data: job });
});

// PATCH /api/jobs/:id/status — change job status only
router.patch('/:id/status', async (req: AuthRequest, res: Response) => {
  const { status } = req.body;
  const job = await Job.findByIdAndUpdate(req.params.id, { status }, { new: true });
  if (!job) { res.status(404).json({ success: false, message: 'Job not found' }); return; }
  res.json({ success: true, message: `Job status changed to ${status}`, data: job });
});

// DELETE /api/jobs/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const job = await Job.findById(req.params.id);
  if (!job) { res.status(404).json({ success: false, message: 'Job not found' }); return; }
  await Applicant.deleteMany({ jobId: job._id });
  await job.deleteOne();
  res.json({ success: true, message: 'Job and its applicants deleted' });
});

// GET /api/jobs/:id/applicants — get applicants for a specific job
router.get('/:id/applicants', async (req: AuthRequest, res: Response) => {
  const { status, source } = req.query;
  const filter: Record<string, unknown> = { jobId: req.params.id };
  if (status) filter.status = status;
  if (source) filter.source = source;

  const applicants = await Applicant.find(filter).sort({ appliedAt: -1 });
  res.json({ success: true, count: applicants.length, data: applicants });
});

export default router;
