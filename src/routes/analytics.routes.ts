import { Router, Response } from 'express';
import { protect, AuthRequest } from '../middleware/auth.middleware';
import Applicant from '../models/Applicant.model';
import ScreeningResult from '../models/ScreeningResult.model';
import Job from '../models/Job.model';
import mongoose from 'mongoose';

const router = Router();
router.use(protect);

// ─── Helper: build date filter from query params ──────────────────────────────
function dateFilter(from?: string, to?: string, days?: string) {
  const filter: Record<string, Date> = {};
  if (from) filter.$gte = new Date(from);
  if (to)   filter.$lte = new Date(new Date(to).setHours(23, 59, 59, 999));
  if (!from && !to && days) {
    const n = parseInt(days);
    if (!isNaN(n) && n > 0) filter.$gte = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  }
  return Object.keys(filter).length > 0 ? filter : undefined;
}

// GET /api/analytics — filterable analytics data
router.get('/', async (req: AuthRequest, res: Response) => {
  const { jobId, department, from, to, days } = req.query as Record<string, string>;

  // ── Build applicant filter ──────────────────────────────────────────────────
  const appFilter: Record<string, any> = {};
  const df = dateFilter(from, to, days);
  if (df) appFilter.appliedAt = df;

  if (jobId && jobId !== 'all') {
    appFilter.jobId = new mongoose.Types.ObjectId(jobId);
  } else if (department && department !== 'all') {
    // Get all jobs in that dept, then filter by their IDs
    const deptJobs = await Job.find({ department }).select('_id');
    appFilter.jobId = { $in: deptJobs.map(j => j._id) };
  }

  // ── Screening filter (to match the date range) ──────────────────────────────
  const screenFilter: Record<string, any> = { status: 'completed' };
  if (df) screenFilter.completedAt = df;
  if (jobId && jobId !== 'all') screenFilter.jobId = new mongoose.Types.ObjectId(jobId);
  else if (department && department !== 'all') {
    const deptJobs = await Job.find({ department }).select('_id');
    screenFilter.jobId = { $in: deptJobs.map(j => j._id) };
  }

  const [
    totalApplicants,
    shortlisted,
    allScreenings,
  ] = await Promise.all([
    Applicant.countDocuments(appFilter),
    Applicant.countDocuments({ ...appFilter, status: 'shortlisted' }),
    ScreeningResult.find(screenFilter).select('shortlist totalApplicantsEvaluated completedAt triggeredAt jobId insights'),
  ]);

  // ── All AI scores ───────────────────────────────────────────────────────────
  const allScores: number[] = allScreenings.flatMap(s =>
    (s.shortlist || []).map((c: any) => c.matchScore)
  );

  // ── Score distribution ──────────────────────────────────────────────────────
  const buckets = [
    { label: '0–40',   min: 0,  max: 40,  count: 0 },
    { label: '41–55',  min: 41, max: 55,  count: 0 },
    { label: '56–70',  min: 56, max: 70,  count: 0 },
    { label: '71–80',  min: 71, max: 80,  count: 0 },
    { label: '81–90',  min: 81, max: 90,  count: 0 },
    { label: '91–100', min: 91, max: 100, count: 0 },
  ];
  allScores.forEach(score => {
    const b = buckets.find(b => score >= b.min && score <= b.max);
    if (b) b.count++;
  });

  // ── Top candidates ──────────────────────────────────────────────────────────
  const topCandidates = allScreenings
    .flatMap(s => (s.shortlist || []).slice(0, 3))
    .sort((a: any, b: any) => b.matchScore - a.matchScore)
    .slice(0, 5);

  // ── Skill gaps (from shortlist skillScores) ─────────────────────────────────
  const skillGapMap: Record<string, { present: number; total: number }> = {};
  allScreenings.forEach(s => {
    (s.shortlist || []).forEach((c: any) => {
      (c.skillScores || []).forEach((sk: any) => {
        if (!skillGapMap[sk.name]) skillGapMap[sk.name] = { present: 0, total: 0 };
        skillGapMap[sk.name].total++;
        if (sk.score >= 60) skillGapMap[sk.name].present++;
      });
    });
  });
  const topSkillGaps = Object.entries(skillGapMap)
    .map(([name, { present, total }]) => ({
      name,
      coverageRate: total > 0 ? Math.round((present / total) * 100) : 0,
    }))
    .sort((a, b) => a.coverageRate - b.coverageRate) // worst first
    .slice(0, 8);

  // ── AI skill-gap recommendations from screening insights ────────────────────
  // Pull from stored insights across all matched screenings
  const skillGapInsights: {
    skill: string; coverage: number; severity: string; recommendation: string; jobTitle?: string;
  }[] = [];

  const marketRecs: string[] = [];
  const hiringRecs: string[] = [];

  allScreenings.forEach(s => {
    const ins = (s as any).insights;
    if (!ins) return;
    (ins.overallSkillGaps || []).forEach((g: any) => {
      skillGapInsights.push({ ...g, jobId: s.jobId });
    });
    (ins.marketRecommendations || []).forEach((r: string) => {
      if (!marketRecs.includes(r)) marketRecs.push(r);
    });
    if (ins.hiringRecommendation && !hiringRecs.includes(ins.hiringRecommendation)) {
      hiringRecs.push(ins.hiringRecommendation);
    }
  });

  // ── Pipeline summary ────────────────────────────────────────────────────────
  const pipelineSummary = await Applicant.aggregate([
    { $match: appFilter },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  // ── Trend: applicants per day for last 7 or 30 days ────────────────────────
  const trendDays = parseInt(days || '7') || 7;
  const trendBuckets = Math.min(trendDays, 30);
  const trendData = await Promise.all(
    Array.from({ length: trendBuckets }, async (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (trendBuckets - 1 - i));
      const start = new Date(d); start.setHours(0, 0, 0, 0);
      const end   = new Date(d); end.setHours(23, 59, 59, 999);
      const matchFilter: any = { appliedAt: { $gte: start, $lte: end } };
      if (appFilter.jobId) matchFilter.jobId = appFilter.jobId;
      const count = await Applicant.countDocuments(matchFilter);
      return {
        label: start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        count,
      };
    })
  );

  const avgScore = allScores.length > 0
    ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length)
    : 0;
  const topScore = allScores.length > 0 ? Math.max(...allScores) : 0;

  res.json({
    success: true,
    data: {
      summary: {
        avgScore,
        topScore,
        totalApplicants,
        shortlisted,
        shortlistRate: totalApplicants > 0
          ? parseFloat(((shortlisted / totalApplicants) * 100).toFixed(1)) : 0,
        screeningRuns: allScreenings.length,
      },
      scoreDistribution: buckets,
      topSkillGaps,
      skillGapInsights,
      marketRecommendations: marketRecs.slice(0, 5),
      hiringRecommendations: hiringRecs.slice(0, 3),
      pipelineSummary,
      topCandidates,
      trendData,
    },
  });
});

// GET /api/analytics/pipeline/:jobId
router.get('/pipeline/:jobId', async (req: AuthRequest, res: Response) => {
  const { jobId } = req.params;

  const [applied, screened, shortlisted, rejected] = await Promise.all([
    Applicant.find({ jobId, status: 'pending' })
      .select('talentProfile.firstName talentProfile.lastName talentProfile.location appliedAt')
      .limit(10),
    Applicant.find({ jobId, status: 'screened' })
      .select('talentProfile.firstName talentProfile.lastName aiScore')
      .limit(10),
    Applicant.find({ jobId, status: 'shortlisted' })
      .select('talentProfile.firstName talentProfile.lastName aiScore skillsMatchPct')
      .sort({ aiScore: -1 })
      .limit(10),
    Applicant.find({ jobId, status: 'rejected' })
      .select('talentProfile.firstName talentProfile.lastName aiScore')
      .limit(10),
  ]);

  const counts = await Applicant.aggregate([
    { $match: { jobId: new mongoose.Types.ObjectId(jobId) } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  res.json({
    success: true,
    data: {
      applied:     { candidates: applied,     count: counts.find(c => c._id === 'pending')?.count     || 0 },
      screened:    { candidates: screened,    count: counts.find(c => c._id === 'screened')?.count    || 0 },
      shortlisted: { candidates: shortlisted, count: counts.find(c => c._id === 'shortlisted')?.count || 0 },
      rejected:    { candidates: rejected,    count: counts.find(c => c._id === 'rejected')?.count    || 0 },
    },
  });
});

// GET /api/analytics/filter-options — jobs + departments for filter dropdowns
router.get('/filter-options', async (_req: AuthRequest, res: Response) => {
  const jobs = await Job.find({ applicantCount: { $gt: 0 } })
    .select('title department status')
    .sort({ createdAt: -1 });

  const departments = [...new Set(jobs.map(j => j.department).filter(Boolean))];

  res.json({
    success: true,
    data: { jobs, departments },
  });
});

export default router;
