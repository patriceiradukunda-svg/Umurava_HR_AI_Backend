import { Router, Response } from 'express';
import { protect, AuthRequest } from '../middleware/auth.middleware';
import Job from '../models/Job.model';
import Applicant from '../models/Applicant.model';
import ScreeningResult from '../models/ScreeningResult.model';
import Settings from '../models/Settings.model';
import { runAIScreening, ScreeningWeights } from '../services/gemini.service';

const router = Router();
router.use(protect);

// GET /api/screening — list all screening runs
router.get('/', async (req: AuthRequest, res: Response) => {
  const { jobId, status } = req.query;
  const filter: Record<string, unknown> = {};
  if (jobId) filter.jobId = jobId;
  if (status) filter.status = status;

  const results = await ScreeningResult.find(filter)
    .populate('jobId', 'title department location')
    .populate('triggeredBy', 'firstName lastName')
    .sort({ triggeredAt: -1 });

  res.json({ success: true, count: results.length, data: results });
});

// GET /api/screening/latest/:jobId — latest screening result for a job
router.get('/latest/:jobId', async (req: AuthRequest, res: Response) => {
  const result = await ScreeningResult.findOne({
    jobId: req.params.jobId,
    status: 'completed',
  }).sort({ completedAt: -1 });

  if (!result) {
    res.status(404).json({ success: false, message: 'No completed screening found for this job' });
    return;
  }
  res.json({ success: true, data: result });
});

// GET /api/screening/:id — single screening result with full shortlist
router.get('/:id', async (req: AuthRequest, res: Response) => {
  const result = await ScreeningResult.findById(req.params.id)
    .populate('jobId', 'title department location requiredSkills')
    .populate('triggeredBy', 'firstName lastName');
  if (!result) { res.status(404).json({ success: false, message: 'Screening result not found' }); return; }
  res.json({ success: true, data: result });
});

// POST /api/screening/run — MAIN: trigger AI screening for a job
router.post('/run', async (req: AuthRequest, res: Response) => {
  const {
    jobId,
    shortlistSize,
    weights,
  }: {
    jobId: string;
    shortlistSize?: number;
    weights?: ScreeningWeights;
  } = req.body;

  if (!jobId) {
    res.status(400).json({ success: false, message: 'jobId is required' });
    return;
  }

  // Load job
  const job = await Job.findById(jobId);
  if (!job) { res.status(404).json({ success: false, message: 'Job not found' }); return; }

  // Load all pending applicants for this job
  const applicants = await Applicant.find({ jobId, status: { $in: ['pending', 'screened'] } });
  if (applicants.length === 0) {
    res.status(400).json({ success: false, message: 'No applicants to screen for this job' });
    return;
  }

  // Load user settings for model preference
  const settings = await Settings.findOne({ userId: req.user!.id });
  const model = settings?.ai?.model || 'gemini-1.5-pro';
  const finalShortlistSize = shortlistSize || settings?.ai?.defaultShortlistSize || job.shortlistSize || 10;

  const defaultWeights: ScreeningWeights = {
    skillsMatch:       weights?.skillsMatch       ?? 40,
    experienceMatch:   weights?.experienceMatch   ?? 30,
    educationMatch:    weights?.educationMatch     ?? 15,
    projectRelevance:  weights?.projectRelevance  ?? 10,
    availabilityBonus: weights?.availabilityBonus ?? 5,
  };

  // Create a "running" record immediately so frontend can poll
  const screeningRecord = await ScreeningResult.create({
    jobId,
    jobTitle: job.title,
    triggeredBy: req.user!.id,
    triggeredAt: new Date(),
    totalApplicantsEvaluated: applicants.length,
    shortlistSize: finalShortlistSize,
    status: 'running',
    weights: defaultWeights,
    promptVersion: 'v1.2',
    modelUsed: model,
  });

  // Update job status
  await Job.findByIdAndUpdate(jobId, { status: 'screening' });

  // Run AI asynchronously and update record when done
  // (we respond immediately so frontend can show the progress animation)
  setImmediate(async () => {
    try {
      const aiResult = await runAIScreening(job, applicants, defaultWeights, finalShortlistSize, model);

      // Stamp rank and evaluatedAt on each shortlisted candidate
      const shortlistWithRanks = aiResult.shortlist.map((c, idx) => ({
        ...c,
        rank: idx + 1,
        evaluatedAt: new Date(),
      }));

      await ScreeningResult.findByIdAndUpdate(screeningRecord._id, {
        status: 'completed',
        completedAt: new Date(),
        shortlist: shortlistWithRanks,
        totalApplicantsEvaluated: aiResult.totalEvaluated,
      });

      // Mark shortlisted applicants in Applicant collection
      const shortlistedIds = shortlistWithRanks.map(c => c.applicantId);
      await Applicant.updateMany(
        { _id: { $in: shortlistedIds } },
        { status: 'shortlisted' }
      );
      // Mark the rest as screened
      await Applicant.updateMany(
        { jobId, _id: { $nin: shortlistedIds }, status: { $in: ['pending','screened'] } },
        { status: 'screened' }
      );

      // Store AI scores back on applicant records
      for (const c of shortlistWithRanks) {
        await Applicant.findByIdAndUpdate(c.applicantId, {
          aiScore: c.matchScore,
          skillsMatchPct: c.scoreBreakdown.skillsMatch,
          status: 'shortlisted',
        });
      }

      // Restore job status to active
      await Job.findByIdAndUpdate(jobId, { status: 'active' });

    } catch (err) {
      console.error('❌ Gemini screening failed:', err);
      await ScreeningResult.findByIdAndUpdate(screeningRecord._id, {
        status: 'failed',
        errorMessage: (err as Error).message,
      });
      await Job.findByIdAndUpdate(jobId, { status: 'active' });
    }
  });

  res.status(202).json({
    success: true,
    message: 'AI screening started. Poll /api/screening/:id for results.',
    screeningId: screeningRecord._id,
    applicantsCount: applicants.length,
    estimatedSeconds: Math.ceil(applicants.length / 10) * 5,
  });
});

// GET /api/screening/:id/status — lightweight poll endpoint for frontend progress
router.get('/:id/status', async (req: AuthRequest, res: Response) => {
  const result = await ScreeningResult.findById(req.params.id).select(
    'status completedAt totalApplicantsEvaluated shortlistSize shortlist errorMessage'
  );
  if (!result) { res.status(404).json({ success: false, message: 'Not found' }); return; }

  res.json({
    success: true,
    status: result.status,
    shortlistCount: result.shortlist?.length || 0,
    totalEvaluated: result.totalApplicantsEvaluated,
    completedAt: result.completedAt,
    errorMessage: result.errorMessage,
  });
});

// DELETE /api/screening/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  await ScreeningResult.findByIdAndDelete(req.params.id);
  res.json({ success: true, message: 'Screening result deleted' });
});

export default router;
