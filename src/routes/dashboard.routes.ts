import { Router, Response } from 'express';
import { protect, AuthRequest } from '../middleware/auth.middleware';
import Job from '../models/Job.model';
import Applicant from '../models/Applicant.model';
import ScreeningResult from '../models/ScreeningResult.model';

const router = Router();
router.use(protect);

// GET /api/dashboard — everything the dashboard page needs in one call
router.get('/', async (_req: AuthRequest, res: Response) => {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [
    activeJobs,
    newJobsThisWeek,
    totalApplicants,
    newApplicantsThisWeek,
    shortlisted,
    screeningRuns,
    recentJobs,
    recentScreenings,
  ] = await Promise.all([
    Job.countDocuments({ status: 'active' }),
    Job.countDocuments({ status: 'active', createdAt: { $gte: weekAgo } }),
    Applicant.countDocuments(),
    Applicant.countDocuments({ appliedAt: { $gte: weekAgo } }),
    Applicant.countDocuments({ status: 'shortlisted' }),
    ScreeningResult.countDocuments({ status: 'completed' }),
    Job.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select('title location status applicantCount createdAt department'),
    ScreeningResult.find({ status: 'completed' })
      .sort({ completedAt: -1 })
      .limit(5)
      .select('jobTitle totalApplicantsEvaluated shortlist completedAt'),
  ]);

  // AI activity chart: screenings per day for last 7 days
  const aiActivity = await Promise.all(
    Array.from({ length: 7 }, async (_, i) => {
      const day = new Date(now);
      day.setDate(day.getDate() - (6 - i));
      const dayStart = new Date(day.setHours(0, 0, 0, 0));
      const dayEnd   = new Date(day.setHours(23, 59, 59, 999));
      const count = await ScreeningResult.countDocuments({
        triggeredAt: { $gte: dayStart, $lte: dayEnd },
      });
      return {
        label: dayStart.toLocaleDateString('en-US', { weekday: 'short' }),
        count,
      };
    })
  );

  // Shortlist rate
  const shortlistRate = totalApplicants > 0
    ? parseFloat(((shortlisted / totalApplicants) * 100).toFixed(1))
    : 0;

  res.json({
    success: true,
    data: {
      stats: {
        activeJobs,
        newJobsThisWeek,
        totalApplicants,
        newApplicantsThisWeek,
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
