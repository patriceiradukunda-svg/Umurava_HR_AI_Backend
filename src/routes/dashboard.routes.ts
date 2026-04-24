import { Router, Response } from 'express';
import { protect, AuthRequest } from '../middleware/auth.middleware';
import Job from '../models/Job.model';
import Applicant from '../models/Applicant.model';
import ScreeningResult from '../models/ScreeningResult.model';

const router = Router();
router.use(protect);

// GET /api/dashboard?from=&to=&days=
router.get('/', async (req: AuthRequest, res: Response) => {
  const { from, to, days } = req.query as Record<string, string>;

  // Build date range
  let rangeStart: Date | undefined;
  let rangeEnd: Date | undefined = new Date();

  if (from) {
    rangeStart = new Date(from);
    rangeEnd   = to ? new Date(new Date(to).setHours(23, 59, 59, 999)) : new Date();
  } else if (days) {
    const n = parseInt(days);
    if (!isNaN(n) && n > 0) rangeStart = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  } else {
    // default: last 7 days for trend counts; all-time for totals
    rangeStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  }

  const dateMatch = rangeStart
    ? { appliedAt: { $gte: rangeStart, $lte: rangeEnd } }
    : {};

  const jobDateMatch = rangeStart
    ? { createdAt: { $gte: rangeStart, $lte: rangeEnd } }
    : {};

  const [
    activeJobs,
    newJobsInRange,
    totalApplicants,
    newApplicantsInRange,
    shortlisted,
    screeningRuns,
    recentJobs,
    recentScreenings,
  ] = await Promise.all([
    Job.countDocuments({ status: 'active' }),
    Job.countDocuments({ status: 'active', ...jobDateMatch }),
    Applicant.countDocuments(),
    Applicant.countDocuments(dateMatch),
    Applicant.countDocuments({ status: 'shortlisted' }),
    ScreeningResult.countDocuments({ status: 'completed' }),
    Job.find()
      .sort({ createdAt: -1 })
      .limit(6)
      .select('title location status applicantCount createdAt department type'),
    ScreeningResult.find({ status: 'completed' })
      .sort({ completedAt: -1 })
      .limit(5)
      .select('jobTitle totalApplicantsEvaluated shortlist completedAt'),
  ]);

  // Screenings per day for the selected range (max 30 points)
  const trendDays = rangeStart
    ? Math.min(Math.ceil((rangeEnd!.getTime() - rangeStart.getTime()) / 86400000), 30)
    : 7;

  const aiActivity = await Promise.all(
    Array.from({ length: trendDays }, async (_, i) => {
      const d = new Date(rangeStart || Date.now());
      d.setDate(d.getDate() + i);
      const dayStart = new Date(d); dayStart.setHours(0, 0, 0, 0);
      const dayEnd   = new Date(d); dayEnd.setHours(23, 59, 59, 999);
      const count = await ScreeningResult.countDocuments({
        triggeredAt: { $gte: dayStart, $lte: dayEnd },
      });
      return {
        label: dayStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        count,
      };
    })
  );

  const shortlistRate = totalApplicants > 0
    ? parseFloat(((shortlisted / totalApplicants) * 100).toFixed(1))
    : 0;

  res.json({
    success: true,
    data: {
      stats: {
        activeJobs,
        newJobsThisWeek: newJobsInRange,
        totalApplicants,
        newApplicantsThisWeek: newApplicantsInRange,
        shortlisted,
        shortlistRate,
        screeningRuns,
      },
      recentJobs,
      recentScreenings,
      aiActivity,
    },
  });
});

export default router;
