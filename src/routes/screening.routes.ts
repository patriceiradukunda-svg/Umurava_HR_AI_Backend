import { Router, Response } from 'express';
import { protect, AuthRequest } from '../middleware/auth.middleware';
import Job from '../models/Job.model';
import Applicant from '../models/Applicant.model';
import ScreeningResult from '../models/ScreeningResult.model';
import { runAIScreening, ScreeningWeights, DEFAULT_WEIGHTS } from '../services/gemini.service';

const router = Router();
router.use(protect);

// GET /api/screening
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { jobId, status } = req.query;
    const filter: Record<string, unknown> = {};
    if (jobId)  filter.jobId  = jobId;
    if (status) filter.status = status;

    const results = await ScreeningResult.find(filter)
      .populate('jobId',       'title department location')
      .populate('triggeredBy', 'firstName lastName')
      .sort({ triggeredAt: -1 });

    res.json({ success: true, count: results.length, data: results });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err });
  }
});

// GET /api/screening/latest/:jobId
router.get('/latest/:jobId', async (req: AuthRequest, res: Response) => {
  try {
    const result = await ScreeningResult.findOne({
      jobId:  req.params.jobId,
      status: 'completed',
    }).sort({ completedAt: -1 });

    if (!result) {
      res.status(404).json({ success: false, message: 'No completed screening found for this job' });
      return;
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err });
  }
});

// GET /api/screening/:id
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await ScreeningResult.findById(req.params.id)
      .populate('jobId',       'title department location requiredSkills')
      .populate('triggeredBy', 'firstName lastName');

    if (!result) {
      res.status(404).json({ success: false, message: 'Not found' });
      return;
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err });
  }
});

// POST /api/screening/run
router.post('/run', async (req: AuthRequest, res: Response) => {
  try {
    const { jobId, shortlistSize, weights }: {
      jobId: string;
      shortlistSize?: number;
      weights?: ScreeningWeights;
    } = req.body;

    if (!jobId) {
      res.status(400).json({ success: false, message: 'jobId is required' });
      return;
    }

    const job = await Job.findById(jobId);
    if (!job) {
      res.status(404).json({ success: false, message: 'Job not found' });
      return;
    }

    const applicants = await Applicant.find({ jobId });
    if (applicants.length === 0) {
      res.status(400).json({
        success: false,
        message: 'No applicants found for this job. Add applicants first.',
      });
      return;
    }

    const finalSize: number = shortlistSize || job.shortlistSize || 10;
    const finalWeights: ScreeningWeights = {
      skillsMatch:       weights?.skillsMatch       ?? DEFAULT_WEIGHTS.skillsMatch,
      experienceMatch:   weights?.experienceMatch   ?? DEFAULT_WEIGHTS.experienceMatch,
      educationMatch:    weights?.educationMatch    ?? DEFAULT_WEIGHTS.educationMatch,
      projectRelevance:  weights?.projectRelevance  ?? DEFAULT_WEIGHTS.projectRelevance,
      availabilityBonus: weights?.availabilityBonus ?? DEFAULT_WEIGHTS.availabilityBonus,
    };

    // Create running record — respond immediately (202)
    const screeningRecord = await ScreeningResult.create({
      jobId,
      jobTitle:                  job.title,
      triggeredBy:               req.user!.id,
      triggeredAt:               new Date(),
      totalApplicantsEvaluated:  applicants.length,
      shortlistSize:             finalSize,
      status:                    'running',
      weights:                   finalWeights,
      promptVersion:             'v2.0',
      modelUsed:                 'gemini-1.5-pro',
    });

    await Job.findByIdAndUpdate(jobId, { status: 'screening' });

    // Run AI asynchronously — no blocking
    setImmediate(async () => {
      try {
        const aiResult = await runAIScreening(job, applicants, finalWeights, finalSize, 'gemini-1.5-pro');

        const shortlistWithMeta = aiResult.shortlist.map((c, idx) => ({
          ...c,
          rank:        idx + 1,
          evaluatedAt: new Date(),
        }));

        const allWithMeta = aiResult.allCandidates.map(c => ({
          ...c,
          evaluatedAt: new Date(),
        }));

        await ScreeningResult.findByIdAndUpdate(screeningRecord._id, {
          status:                   'completed',
          completedAt:              new Date(),
          shortlist:                shortlistWithMeta,
          allCandidates:            allWithMeta,
          insights:                 aiResult.insights,
          totalApplicantsEvaluated: aiResult.totalEvaluated,
        });

        // Update applicant statuses
        const shortlistedIds = shortlistWithMeta.map(c => c.applicantId);
        await Applicant.updateMany({ _id: { $in: shortlistedIds } }, { status: 'shortlisted' });
        await Applicant.updateMany(
          { jobId, _id: { $nin: shortlistedIds } },
          { status: 'screened' }
        );

        // Persist AI scores on shortlisted
        for (const c of shortlistWithMeta) {
          await Applicant.findByIdAndUpdate(c.applicantId, {
            aiScore:       c.matchScore,
            skillsMatchPct: c.scoreBreakdown.skillsMatch,
          });
        }
        // Also store scores on non-shortlisted for reference
        for (const c of allWithMeta.filter(c => !c.isShortlisted)) {
          await Applicant.findByIdAndUpdate(c.applicantId, { aiScore: c.matchScore });
        }

        await Job.findByIdAndUpdate(jobId, { status: 'active' });
        console.log(`✅ Screening complete: ${shortlistWithMeta.length} shortlisted from ${aiResult.totalEvaluated}`);

      } catch (err) {
        console.error('❌ Screening failed:', (err as Error).message);
        await ScreeningResult.findByIdAndUpdate(screeningRecord._id, {
          status:       'failed',
          errorMessage: (err as Error).message,
        });
        await Job.findByIdAndUpdate(jobId, { status: 'active' });
      }
    });

    res.status(202).json({
      success:          true,
      message:          'Screening started. Poll for progress.',
      screeningId:      screeningRecord._id,
      applicantsCount:  applicants.length,
      estimatedSeconds: Math.ceil(applicants.length / 15) * 20,
    });

  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err });
  }
});

// GET /api/screening/:id/status
router.get('/:id/status', async (req: AuthRequest, res: Response) => {
  try {
    const result = await ScreeningResult.findById(req.params.id)
      .select('status completedAt totalApplicantsEvaluated shortlistSize shortlist errorMessage insights');

    if (!result) {
      res.status(404).json({ success: false, message: 'Not found' });
      return;
    }

    res.json({
      success:        true,
      status:         result.status,
      shortlistCount: result.shortlist?.length || 0,
      totalEvaluated: result.totalApplicantsEvaluated,
      completedAt:    result.completedAt,
      errorMessage:   result.errorMessage,
      hasInsights:    !!(result.insights?.hiringRecommendation),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err });
  }
});

// DELETE /api/screening/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await ScreeningResult.findByIdAndDelete(req.params.id);
    if (!result) {
      res.status(404).json({ success: false, message: 'Not found' });
      return;
    }
    res.json({ success: true, message: 'Screening result deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err });
  }
});

export default router;
