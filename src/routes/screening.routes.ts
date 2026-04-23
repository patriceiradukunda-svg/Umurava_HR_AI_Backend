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

// GET /api/screening/latest/:jobId
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

// GET /api/screening/:id
router.get('/:id', async (req: AuthRequest, res: Response) => {
  const result = await ScreeningResult.findById(req.params.id)
    .populate('jobId', 'title department location requiredSkills')
    .populate('triggeredBy', 'firstName lastName');
  if (!result) { res.status(404).json({ success: false, message: 'Not found' }); return; }
  res.json({ success: true, data: result });
});

// POST /api/screening/run — trigger screening (no applicant limit, batched internally)
router.post('/run', async (req: AuthRequest, res: Response) => {
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
  if (!job) { res.status(404).json({ success: false, message: 'Job not found' }); return; }

  // Include ALL applicants — no status filter so HR can re-screen after adding more
  const applicants = await Applicant.find({ jobId });
  if (applicants.length === 0) {
    res.status(400).json({ success: false, message: 'No applicants found for this job. Add applicants first.' });
    return;
  }

  const finalSize = shortlistSize || job.shortlistSize || 10;
  const finalWeights: ScreeningWeights = {
    skillsMatch:       weights?.skillsMatch       ?? DEFAULT_WEIGHTS.skillsMatch,
    experienceMatch:   weights?.experienceMatch   ?? DEFAULT_WEIGHTS.experienceMatch,
    educationMatch:    weights?.educationMatch    ?? DEFAULT_WEIGHTS.educationMatch,
    projectRelevance:  weights?.projectRelevance  ?? DEFAULT_WEIGHTS.projectRelevance,
    availabilityBonus: weights?.availabilityBonus ?? DEFAULT_WEIGHTS.availabilityBonus,
  };

  // Create running record — respond immediately
  const screeningRecord = await ScreeningResult.create({
    jobId,
    jobTitle: job.title,
    triggeredBy: req.user!.id,
    triggeredAt: new Date(),
    totalApplicantsEvaluated: applicants.length,
    shortlistSize: finalSize,
    status: 'running',
    weights: finalWeights,
    promptVersion: 'v2.0',
    modelUsed: 'gemini-1.5-pro',
  });

  await Job.findByIdAndUpdate(jobId, { status: 'screening' });

  // Run asynchronously — no limit on applicant count
  setImmediate(async () => {
    try {
      const aiResult = await runAIScreening(job, applicants, finalWeights, finalSize, 'gemini-1.5-pro');

      const shortlistWithMeta = aiResult.shortlist.map((c, idx) => ({
        ...c,
        rank: idx + 1,
        evaluatedAt: new Date(),
      }));

      const allWithMeta = aiResult.allCandidates.map(c => ({
        ...c,
        evaluatedAt: new Date(),
      }));

      await ScreeningResult.findByIdAndUpdate(screeningRecord._id, {
        status: 'completed',
        completedAt: new Date(),
        shortlist: shortlistWithMeta,
        allCandidates: allWithMeta,
        insights: aiResult.insights,
        totalApplicantsEvaluated: aiResult.totalEvaluated,
      });

      // Update applicant statuses + scores
      const shortlistedIds = shortlistWithMeta.map(c => c.applicantId);
      await Applicant.updateMany({ _id: { $in: shortlistedIds } }, { status: 'shortlisted' });
      await Applicant.updateMany(
        { jobId, _id: { $nin: shortlistedIds } },
        { status: 'screened' }
      );

      for (const c of shortlistWithMeta) {
        await Applicant.findByIdAndUpdate(c.applicantId, {
          aiScore: c.matchScore,
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
        status: 'failed',
        errorMessage: (err as Error).message,
      });
      await Job.findByIdAndUpdate(jobId, { status: 'active' });
    }
  });

  res.status(202).json({
    success: true,
    message: 'Screening started. Poll for progress.',
    screeningId: screeningRecord._id,
    applicantsCount: applicants.length,
    estimatedSeconds: Math.ceil(applicants.length / 15) * 20,
  });
});

// GET /api/screening/:id/status — polling endpoint
router.get('/:id/status', async (req: AuthRequest, res: Response) => {
  const result = await ScreeningResult.findById(req.params.id)
    .select('status completedAt totalApplicantsEvaluated shortlistSize shortlist errorMessage insights');
  if (!result) { res.status(404).json({ success: false, message: 'Not found' }); return; }

  res.json({
    success: true,
    status: result.status,
    shortlistCount: result.shortlist?.length || 0,
    totalEvaluated: result.totalApplicantsEvaluated,
    completedAt: result.completedAt,
    errorMessage: result.errorMessage,
    hasInsights: !!(result.insights?.hiringRecommendation),
  });
});

// DELETE /api/screening/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  await ScreeningResult.findByIdAndDelete(req.params.id);
  res.json({ success: true, message: 'Screening result deleted' });
});

export default router;
ENDOFFILE
Output

exit code 0
Done
Now the frontend — screening page:


Write the new screening page
Write the new screening page
Now the shortlist page with full AI reasoning, skill gaps, and recommendations:


Write the complete new shortlist page
Write the complete new shortlist page

Write the complete new shortlist page
bash

cat > /home/claude/project/frontend/frontend/src/app/hr/shortlist/page.tsx << 'ENDOFFILE'
'use client'
import { useEffect, useState } from 'react'
import { screeningAPI, jobsAPI } from '@/lib/api'
import {
  Star, Trophy, X, ChevronRight, CheckCircle, AlertTriangle,
  TrendingUp, TrendingDown, BookOpen, Users, BarChart2,
  Award, Target, Lightbulb, Filter, Download, Eye,
  ArrowUpRight, Minus, ChevronDown, ChevronUp,
} from 'lucide-react'
import Link from 'next/link'

// ─── Helpers ─────────────────────────────────────────────────────────────────
function scoreColor(s: number) {
  if (s >= 80) return { text: 'text-emerald-600', bg: 'bg-emerald-50', bar: '#10b981', ring: '#10b981' }
  if (s >= 60) return { text: 'text-sky-600',     bg: 'bg-sky-50',     bar: '#0ea5e9', ring: '#0ea5e9' }
  if (s >= 40) return { text: 'text-amber-600',   bg: 'bg-amber-50',   bar: '#f59e0b', ring: '#f59e0b' }
  return             { text: 'text-red-500',       bg: 'bg-red-50',     bar: '#ef4444', ring: '#ef4444' }
}

function ScoreRing({ score, size = 56 }: { score: number; size?: number }) {
  const r = size * 0.38; const c = 2 * Math.PI * r
  const col = scoreColor(score)
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size/2} cy={size/2} r={r} strokeWidth={4} className="stroke-sky-100 fill-none" />
        <circle cx={size/2} cy={size/2} r={r} strokeWidth={4} fill="none"
          stroke={col.ring} strokeLinecap="round"
          strokeDasharray={`${(score/100)*c} ${c}`} />
      </svg>
      <span className={`absolute inset-0 flex items-center justify-center font-display font-bold ${col.text}`}
        style={{ fontSize: size * 0.22 }}>{score}</span>
    </div>
  )
}

function exportCSV(rows: any[], filename: string) {
  if (!rows.length) return
  const h = Object.keys(rows[0])
  const csv = [h.join(','), ...rows.map(r => h.map(k => JSON.stringify(r[k] ?? '')).join(','))].join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  a.download = filename; a.click()
}

const rankStyle = (rank: number) => {
  if (rank === 1) return 'bg-amber-100 border-amber-300 text-amber-700'
  if (rank === 2) return 'bg-slate-100 border-slate-300 text-slate-600'
  if (rank === 3) return 'bg-orange-100 border-orange-300 text-orange-600'
  return 'bg-sky-50 border-sky-200 text-sky-600'
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function HRShortlistPage() {
  const [jobs, setJobs]               = useState<any[]>([])
  const [selectedJob, setSelectedJob] = useState('')
  const [result, setResult]           = useState<any>(null)
  const [selected, setSelected]       = useState<any>(null)
  const [loading, setLoading]         = useState(false)
  const [tab, setTab]                 = useState<'shortlisted' | 'all' | 'insights'>('shortlisted')
  const [showExport, setShowExport]   = useState(false)

  useEffect(() => {
    jobsAPI.list().then(r => setJobs(r.data.data || [])).catch(() => {})
  }, [])

  useEffect(() => {
    if (!selectedJob) return
    setLoading(true)
    screeningAPI.latest(selectedJob)
      .then(r => setResult(r.data.data))
      .catch(() => setResult(null))
      .finally(() => setLoading(false))
  }, [selectedJob])

  const shortlist    = result?.shortlist     || []
  const allCandidates = result?.allCandidates || []
  const insights     = result?.insights      || null
  const displayList  = tab === 'all' ? allCandidates : shortlist

  const handleExport = () => {
    const rows = displayList.map((c: any) => ({
      Rank:          c.rank || '—',
      Name:          `${c.firstName} ${c.lastName}`,
      Email:         c.email,
      Location:      c.location,
      Score:         c.matchScore,
      'Skills Match':      c.scoreBreakdown?.skillsMatch,
      'Experience Match':  c.scoreBreakdown?.experienceMatch,
      'Education Match':   c.scoreBreakdown?.educationMatch,
      'Project Relevance': c.scoreBreakdown?.projectRelevance,
      Shortlisted:   c.isShortlisted ? 'Yes' : 'No',
      Recommendation: c.recommendation,
    }))
    exportCSV(rows, `shortlist-${result?.jobTitle?.replace(/\s+/g, '-')}-${new Date().toISOString().split('T')[0]}.csv`)
    setShowExport(false)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl font-bold text-sky-950">Shortlists & Results</h1>
          <p className="text-sky-400 text-sm mt-1">Ranked candidates with evaluation details and recommendations</p>
        </div>
        {result && (
          <div className="flex items-center gap-2">
            <div className="relative">
              <button onClick={() => setShowExport(v => !v)}
                className="flex items-center gap-2 border border-sky-200 bg-white text-sky-600 text-sm font-semibold px-4 py-2 rounded-xl hover:bg-sky-50 transition-colors">
                <Download className="w-4 h-4" /> Export
              </button>
              {showExport && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setShowExport(false)} />
                  <div className="absolute right-0 top-full mt-2 bg-white border border-sky-100 rounded-2xl shadow-xl z-30 w-48 py-2">
                    <button onClick={handleExport}
                      className="w-full text-left px-4 py-2.5 text-sm text-sky-700 hover:bg-sky-50 flex items-center gap-2">
                      <BarChart2 className="w-4 h-4 text-sky-400" /> Export CSV
                    </button>
                  </div>
                </>
              )}
            </div>
            <Link href="/hr/screening"
              className="flex items-center gap-2 bg-sky-600 text-white text-sm font-semibold px-4 py-2 rounded-xl hover:bg-sky-700 transition-colors">
              Run New Screening
            </Link>
          </div>
        )}
      </div>

      {/* Job selector */}
      <div className="bg-white rounded-2xl border border-sky-100 p-4" style={{ boxShadow: '0 1px 4px rgba(14,165,233,0.06)' }}>
        <div className="flex items-center gap-3 flex-wrap">
          <Filter className="w-4 h-4 text-sky-400 flex-shrink-0" />
          <select value={selectedJob} onChange={e => { setSelectedJob(e.target.value); setTab('shortlisted') }}
            className="flex-1 min-w-[200px] bg-sky-50 border border-sky-200 rounded-xl px-4 h-10 text-sm text-sky-700 outline-none">
            <option value="">Select a job to view its shortlist…</option>
            {jobs.map(j => <option key={j._id} value={j._id}>{j.title} — {j.department}</option>)}
          </select>
        </div>
      </div>

      {/* Empty states */}
      {!selectedJob && (
        <div className="bg-white rounded-2xl p-16 text-center border border-sky-50">
          <Star className="w-12 h-12 text-sky-200 mx-auto mb-4" />
          <h3 className="font-display text-xl font-bold text-sky-900 mb-2">Select a job above</h3>
          <p className="text-sky-400 text-sm">Choose a job to view its screened candidates and insights.</p>
        </div>
      )}

      {selectedJob && loading && (
        <div className="grid md:grid-cols-2 gap-4">
          {[...Array(4)].map((_, i) => <div key={i} className="bg-white rounded-2xl h-56 animate-pulse bg-sky-50" />)}
        </div>
      )}

      {selectedJob && !loading && !result && (
        <div className="bg-white rounded-2xl p-16 text-center border border-sky-50">
          <Trophy className="w-12 h-12 text-sky-200 mx-auto mb-4" />
          <h3 className="font-display text-xl font-bold text-sky-900 mb-2">No screening run yet</h3>
          <p className="text-sky-400 mb-6 text-sm">Run a screening for this job to see ranked candidates.</p>
          <Link href="/hr/screening" className="inline-flex items-center gap-2 bg-sky-600 text-white font-semibold px-5 py-2.5 rounded-xl hover:bg-sky-700 transition-colors">
            Go to Screening
          </Link>
        </div>
      )}

      {result && (
        <>
          {/* Hero stats bar */}
          <div className="bg-sky-950 rounded-2xl p-5 flex flex-wrap items-center gap-6">
            <div className="flex items-center gap-4">
              <Trophy className="w-10 h-10 text-sky-400 flex-shrink-0" />
              <div>
                <h2 className="font-display text-lg font-bold text-white">{result.jobTitle}</h2>
                <p className="text-sky-400 text-xs">Latest screening results</p>
              </div>
            </div>
            <div className="flex gap-6 ml-auto flex-wrap">
              {[
                { label: 'Evaluated',  value: result.totalApplicantsEvaluated, color: 'text-sky-300' },
                { label: 'Shortlisted',value: shortlist.length,                 color: 'text-emerald-400' },
                { label: 'Top Score',  value: shortlist[0]?.matchScore || 0,    color: 'text-amber-400' },
                { label: 'Avg Score',  value: shortlist.length ? Math.round(shortlist.reduce((a: number, c: any) => a + c.matchScore, 0) / shortlist.length) : 0, color: 'text-sky-300' },
              ].map(s => (
                <div key={s.label} className="text-center">
                  <div className={`font-display text-2xl font-bold ${s.color}`}>{s.value}</div>
                  <div className="text-sky-500 text-xs uppercase tracking-wide">{s.label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-1 bg-sky-50 border border-sky-100 rounded-xl p-1 w-fit">
            {[
              { key: 'shortlisted', label: `Shortlisted (${shortlist.length})` },
              { key: 'all',         label: `All Evaluated (${allCandidates.length || result.totalApplicantsEvaluated})` },
              { key: 'insights',    label: `Insights${insights ? ' ✦' : ''}` },
            ].map(t => (
              <button key={t.key} onClick={() => setTab(t.key as any)}
                className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                  tab === t.key ? 'bg-white text-sky-700 shadow-sm' : 'text-sky-500 hover:text-sky-700'
                }`}>
                {t.label}
              </button>
            ))}
          </div>

          {/* ── INSIGHTS TAB ── */}
          {tab === 'insights' && (
            <div className="space-y-5">
              {!insights ? (
                <div className="bg-white rounded-2xl p-12 text-center border border-sky-50">
                  <Lightbulb className="w-10 h-10 text-sky-200 mx-auto mb-3" />
                  <p className="text-sky-400">No insights available for this screening run.</p>
                </div>
              ) : (
                <>
                  {/* Overall recommendation */}
                  <div className="bg-sky-950 rounded-2xl p-6 border border-sky-800">
                    <div className="flex items-start gap-4">
                      <div className="w-10 h-10 rounded-xl bg-sky-700 flex items-center justify-center flex-shrink-0">
                        <Target className="w-5 h-5 text-sky-200" />
                      </div>
                      <div>
                        <p className="text-sky-400 text-xs font-bold uppercase tracking-wide mb-2">Overall Hiring Recommendation</p>
                        <p className="text-white leading-relaxed">{insights.hiringRecommendation}</p>
                      </div>
                    </div>
                  </div>

                  <div className="grid lg:grid-cols-2 gap-5">
                    {/* Pipeline health */}
                    <div className="bg-white rounded-2xl border border-sky-100 p-5">
                      <div className="flex items-center gap-2 mb-4">
                        <TrendingUp className="w-4 h-4 text-sky-500" />
                        <h3 className="font-display font-bold text-sky-900">Pipeline Health</h3>
                      </div>
                      <p className="text-sky-700 text-sm leading-relaxed">{insights.pipelineHealth}</p>
                    </div>

                    {/* Pool strengths */}
                    <div className="bg-white rounded-2xl border border-sky-100 p-5">
                      <div className="flex items-center gap-2 mb-4">
                        <Star className="w-4 h-4 text-emerald-500" />
                        <h3 className="font-display font-bold text-sky-900">Pool Strengths</h3>
                      </div>
                      <div className="space-y-2">
                        {(insights.topStrengthsAcrossPool || []).map((s: string, i: number) => (
                          <div key={i} className="flex items-start gap-2">
                            <CheckCircle className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                            <p className="text-sky-700 text-sm">{s}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Skill gaps */}
                  {(insights.overallSkillGaps || []).length > 0 && (
                    <div className="bg-white rounded-2xl border border-sky-100 p-5">
                      <div className="flex items-center gap-2 mb-5">
                        <AlertTriangle className="w-4 h-4 text-amber-500" />
                        <h3 className="font-display font-bold text-sky-900">Skills Gap Analysis</h3>
                        <span className="text-sky-400 text-xs ml-1">— required skills missing across the talent pool</span>
                      </div>
                      <div className="space-y-4">
                        {insights.overallSkillGaps.map((g: any, i: number) => (
                          <div key={i} className={`rounded-xl p-4 border ${
                            g.severity === 'critical' ? 'bg-red-50 border-red-200' :
                            g.severity === 'moderate' ? 'bg-amber-50 border-amber-200' :
                            'bg-sky-50 border-sky-200'
                          }`}>
                            <div className="flex items-start justify-between gap-4 mb-2">
                              <div>
                                <p className="font-semibold text-sky-900">{g.skill}</p>
                                <span className={`text-xs font-bold px-2 py-0.5 rounded-full capitalize ${
                                  g.severity === 'critical' ? 'bg-red-100 text-red-600' :
                                  g.severity === 'moderate' ? 'bg-amber-100 text-amber-700' :
                                  'bg-sky-100 text-sky-600'
                                }`}>{g.severity}</span>
                              </div>
                              <div className="text-right flex-shrink-0">
                                <div className="font-display font-bold text-lg text-sky-900">{g.coverage}%</div>
                                <div className="text-sky-400 text-xs">coverage</div>
                              </div>
                            </div>
                            <div className="h-2 bg-white/60 rounded-full overflow-hidden mb-3">
                              <div className="h-full rounded-full transition-all"
                                style={{ width: `${g.coverage}%`, background: g.severity === 'critical' ? '#ef4444' : g.severity === 'moderate' ? '#f59e0b' : '#0ea5e9' }} />
                            </div>
                            <div className="flex items-start gap-2">
                              <Lightbulb className="w-3.5 h-3.5 text-sky-500 flex-shrink-0 mt-0.5" />
                              <p className="text-sky-700 text-xs leading-relaxed">{g.recommendation}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Market recommendations */}
                  {(insights.marketRecommendations || []).length > 0 && (
                    <div className="bg-white rounded-2xl border border-sky-100 p-5">
                      <div className="flex items-center gap-2 mb-4">
                        <Lightbulb className="w-4 h-4 text-indigo-500" />
                        <h3 className="font-display font-bold text-sky-900">Strategic Recommendations for HR</h3>
                      </div>
                      <div className="space-y-3">
                        {insights.marketRecommendations.map((r: string, i: number) => (
                          <div key={i} className="flex items-start gap-3 bg-indigo-50 rounded-xl p-3 border border-indigo-100">
                            <div className="w-6 h-6 rounded-full bg-indigo-200 text-indigo-700 text-xs font-bold flex items-center justify-center flex-shrink-0">{i + 1}</div>
                            <p className="text-indigo-800 text-sm leading-relaxed">{r}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Critical missing skills */}
                  {(insights.criticalMissingSkills || []).length > 0 && (
                    <div className="bg-red-50 rounded-2xl border border-red-200 p-5">
                      <div className="flex items-center gap-2 mb-3">
                        <AlertTriangle className="w-4 h-4 text-red-500" />
                        <h3 className="font-display font-bold text-red-800">Critical Missing Skills</h3>
                        <span className="text-red-400 text-xs">— almost nobody in this pool has these</span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {insights.criticalMissingSkills.map((s: string) => (
                          <span key={s} className="text-xs font-semibold bg-red-100 text-red-700 border border-red-200 px-3 py-1 rounded-full">{s}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── CANDIDATES TAB (Shortlisted OR All) ── */}
          {(tab === 'shortlisted' || tab === 'all') && (
            <>
              {displayList.length === 0 ? (
                <div className="bg-white rounded-2xl p-12 text-center border border-sky-50">
                  <Users className="w-10 h-10 text-sky-200 mx-auto mb-3" />
                  <p className="text-sky-400">No candidates in this view.</p>
                </div>
              ) : (
                <div className="grid md:grid-cols-2 gap-4">
                  {displayList.map((c: any) => {
                    const col = scoreColor(c.matchScore)
                    return (
                      <div key={c.applicantId || c._id}
                        onClick={() => setSelected(c)}
                        className={`bg-white rounded-2xl border-2 cursor-pointer transition-all hover:shadow-md hover:-translate-y-0.5 relative overflow-hidden ${
                          c.isShortlisted !== false ? 'border-sky-100' : 'border-slate-100 opacity-80'
                        }`}>
                        {/* Top accent line for shortlisted */}
                        {c.rank && c.rank <= 3 && <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-sky-400 to-sky-600" />}

                        <div className="p-5">
                          {/* Header row */}
                          <div className="flex items-start gap-3 mb-3">
                            {/* Rank */}
                            {c.rank ? (
                              <div className={`w-9 h-9 rounded-full border-2 flex items-center justify-center font-display font-bold text-sm flex-shrink-0 ${rankStyle(c.rank)}`}>
                                {c.rank}
                              </div>
                            ) : (
                              <div className="w-9 h-9 rounded-full border-2 border-slate-200 flex items-center justify-center flex-shrink-0">
                                <Minus className="w-3 h-3 text-slate-400" />
                              </div>
                            )}
                            {/* Avatar */}
                            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-500 to-sky-600 text-white font-bold flex items-center justify-center flex-shrink-0 shadow-sm">
                              {c.firstName?.[0]}{c.lastName?.[0]}
                            </div>
                            {/* Name */}
                            <div className="flex-1 min-w-0">
                              <h3 className="font-display font-bold text-sky-900 truncate">{c.firstName} {c.lastName}</h3>
                              <p className="text-sky-400 text-xs truncate">{c.headline}</p>
                              <p className="text-sky-300 text-xs">{c.location}</p>
                            </div>
                            {/* Score ring */}
                            <ScoreRing score={c.matchScore} size={50} />
                          </div>

                          {/* Shortlist status badge */}
                          <div className="flex items-center gap-2 mb-3 flex-wrap">
                            {c.isShortlisted !== false ? (
                              <span className="inline-flex items-center gap-1 text-xs font-semibold bg-emerald-100 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded-full">
                                <CheckCircle className="w-3 h-3" /> Shortlisted
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-xs font-semibold bg-slate-100 text-slate-500 border border-slate-200 px-2 py-0.5 rounded-full">
                                Not Shortlisted
                              </span>
                            )}
                            <span className="text-sky-400 text-xs">{c.availability?.status}</span>
                          </div>

                          {/* Score breakdown mini bars */}
                          <div className="space-y-1.5 mb-3">
                            {Object.entries(c.scoreBreakdown || {}).slice(0, 3).map(([k, v]: any) => (
                              <div key={k} className="flex items-center gap-2">
                                <span className="text-sky-500 text-[11px] w-24 flex-shrink-0 capitalize">
                                  {k.replace(/([A-Z])/g, ' $1').trim()}
                                </span>
                                <div className="flex-1 h-1.5 bg-sky-50 rounded-full overflow-hidden">
                                  <div className="h-full rounded-full" style={{ width: `${v}%`, background: scoreColor(v).bar }} />
                                </div>
                                <span className="text-sky-500 text-[11px] w-7 text-right font-bold">{v}</span>
                              </div>
                            ))}
                          </div>

                          {/* Strengths tags */}
                          <div className="flex flex-wrap gap-1 mb-3">
                            {(c.strengths || []).slice(0, 2).map((s: string, i: number) => (
                              <span key={i} className="text-xs bg-emerald-50 text-emerald-600 border border-emerald-200 px-2 py-0.5 rounded-full">
                                ✓ {s.substring(0, 35)}{s.length > 35 ? '…' : ''}
                              </span>
                            ))}
                          </div>

                          {/* Shortlisted reason excerpt */}
                          {c.shortlistedReason && (
                            <div className="bg-sky-50 border-l-4 border-sky-400 rounded-r-xl p-2.5 mb-3">
                              <p className="text-sky-700 text-xs line-clamp-2">{c.shortlistedReason}</p>
                            </div>
                          )}

                          <div className="flex items-center justify-between text-xs">
                            <span className="text-sky-400">{c.location}</span>
                            <span className="text-sky-500 font-semibold flex items-center gap-1">
                              Full profile <ChevronRight className="w-3 h-3" />
                            </span>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ── Candidate Detail Modal ── */}
      {selected && (
        <div className="fixed inset-0 bg-sky-950/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl w-full max-w-2xl max-h-[92vh] overflow-y-auto shadow-2xl">
            {/* Modal header */}
            <div className="sticky top-0 bg-white border-b border-sky-100 px-8 py-5 flex items-center justify-between rounded-t-3xl z-10">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-sky-500 to-sky-600 text-white font-bold text-lg flex items-center justify-center flex-shrink-0">
                  {selected.firstName?.[0]}{selected.lastName?.[0]}
                </div>
                <div>
                  <h2 className="font-display text-xl font-bold text-sky-900">{selected.firstName} {selected.lastName}</h2>
                  <p className="text-sky-400 text-sm">
                    {selected.rank ? `Rank #${selected.rank} · ` : ''}Score {selected.matchScore}/100
                    {selected.isShortlisted !== false
                      ? <span className="ml-2 text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-semibold">✓ Shortlisted</span>
                      : <span className="ml-2 text-xs bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full font-semibold">Not Shortlisted</span>}
                  </p>
                </div>
              </div>
              <button onClick={() => setSelected(null)} className="text-sky-400 hover:text-sky-700 w-8 h-8 flex items-center justify-center rounded-xl hover:bg-sky-50">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-8 space-y-6">
              {/* Score overview */}
              <div className="flex items-center gap-5 bg-sky-50 rounded-2xl p-5 border border-sky-100">
                <ScoreRing score={selected.matchScore} size={64} />
                <div className="flex-1">
                  <p className="font-bold text-sky-900 text-lg">Overall Match Score</p>
                  <p className={`text-sm font-semibold ${scoreColor(selected.matchScore).text}`}>
                    {selected.matchScore >= 80 ? '⭐ Highly recommended' :
                     selected.matchScore >= 60 ? '👍 Good match' :
                     selected.matchScore >= 40 ? '⚠ Borderline' : '❌ Below threshold'}
                  </p>
                </div>
              </div>

              {/* Score breakdown */}
              <div>
                <h3 className="font-display font-bold text-sky-900 mb-3">Score Breakdown</h3>
                <div className="space-y-3">
                  {Object.entries(selected.scoreBreakdown || {}).map(([k, v]: any) => (
                    <div key={k} className="flex items-center gap-3">
                      <span className="text-sky-600 text-sm capitalize w-40 flex-shrink-0">{k.replace(/([A-Z])/g, ' $1').trim()}</span>
                      <div className="flex-1 h-2.5 bg-sky-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{ width: `${v}%`, background: scoreColor(v).bar }} />
                      </div>
                      <span className={`font-bold text-sm w-10 text-right ${scoreColor(v).text}`}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Why shortlisted / not */}
              {selected.shortlistedReason && (
                <div className="bg-sky-50 border-l-4 border-sky-500 rounded-r-2xl p-5">
                  <p className="text-sky-500 text-xs font-bold uppercase tracking-wide mb-2">
                    {selected.isShortlisted !== false ? '✓ Why Shortlisted' : '✗ Why Not Shortlisted'}
                  </p>
                  <p className="text-sky-800 text-sm leading-relaxed">{selected.shortlistedReason}</p>
                </div>
              )}

              {/* Strengths & Gaps */}
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-emerald-50 rounded-2xl p-4 border border-emerald-100">
                  <p className="text-emerald-600 text-xs font-bold uppercase tracking-wide mb-3 flex items-center gap-1.5">
                    <TrendingUp className="w-3.5 h-3.5" /> Strengths
                  </p>
                  <ul className="space-y-2">
                    {(selected.strengths || []).map((s: string, i: number) => (
                      <li key={i} className="text-emerald-800 text-xs flex gap-2 leading-relaxed">
                        <span className="flex-shrink-0 text-emerald-500">✓</span> {s}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="bg-amber-50 rounded-2xl p-4 border border-amber-100">
                  <p className="text-amber-600 text-xs font-bold uppercase tracking-wide mb-3 flex items-center gap-1.5">
                    <TrendingDown className="w-3.5 h-3.5" /> Gaps / Risks
                  </p>
                  <ul className="space-y-2">
                    {(selected.gaps || []).map((g: string, i: number) => (
                      <li key={i} className="text-amber-800 text-xs flex gap-2 leading-relaxed">
                        <span className="flex-shrink-0 text-amber-500">⚠</span> {g}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Skill scores */}
              {(selected.skillScores || []).length > 0 && (
                <div>
                  <h3 className="font-display font-bold text-sky-900 mb-3">Skill-by-Skill Scores</h3>
                  <div className="space-y-2">
                    {selected.skillScores.map((s: any) => (
                      <div key={s.name} className="flex items-center gap-3">
                        <span className="text-sky-600 text-sm w-36 flex-shrink-0">{s.name}</span>
                        <div className="flex-1 h-2 bg-sky-100 rounded-full overflow-hidden">
                          <div className="h-full rounded-full transition-all" style={{ width: `${s.score}%`, background: scoreColor(s.score).bar }} />
                        </div>
                        <span className={`font-bold text-sm w-8 text-right ${scoreColor(s.score).text}`}>{s.score}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Skill gaps */}
              {(selected.skillGaps || []).length > 0 && (
                <div className="bg-red-50 rounded-2xl p-4 border border-red-200">
                  <p className="text-red-600 text-xs font-bold uppercase tracking-wide mb-3 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5" /> Missing / Weak Skills
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {selected.skillGaps.map((g: string) => (
                      <span key={g} className="text-xs bg-red-100 text-red-700 border border-red-200 px-2.5 py-1 rounded-full font-medium">{g}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Growth areas */}
              {(selected.growthAreas || []).length > 0 && (
                <div>
                  <h3 className="font-display font-bold text-sky-900 mb-3 flex items-center gap-2">
                    <ArrowUpRight className="w-4 h-4 text-sky-500" /> Growth Areas
                  </h3>
                  <ul className="space-y-2">
                    {selected.growthAreas.map((a: string, i: number) => (
                      <li key={i} className="flex items-start gap-2 text-sky-700 text-sm">
                        <span className="w-5 h-5 rounded-full bg-sky-100 text-sky-600 text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">{i + 1}</span>
                        {a}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Course recommendations */}
              {(selected.courseRecommendations || []).length > 0 && (
                <div className="bg-indigo-50 rounded-2xl p-5 border border-indigo-100">
                  <h3 className="font-display font-bold text-indigo-900 mb-3 flex items-center gap-2">
                    <BookOpen className="w-4 h-4 text-indigo-500" /> Recommended Learning Path
                  </h3>
                  <ul className="space-y-2.5">
                    {selected.courseRecommendations.map((r: string, i: number) => (
                      <li key={i} className="flex items-start gap-3">
                        <Award className="w-4 h-4 text-indigo-400 flex-shrink-0 mt-0.5" />
                        <p className="text-indigo-800 text-sm leading-relaxed">{r}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Final recommendation */}
              {selected.recommendation && (
                <div className="bg-sky-950 rounded-2xl p-5 text-white">
                  <p className="text-sky-400 text-xs font-bold uppercase tracking-wide mb-2">Final Recommendation</p>
                  <p className="text-sky-100 text-sm leading-relaxed">{selected.recommendation}</p>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex gap-3 pt-2">
                <button onClick={() => setSelected(null)} className="flex-1 bg-sky-600 hover:bg-sky-700 text-white font-semibold px-4 py-2.5 rounded-xl transition-colors">
                  ✓ Move to Interview
                </button>
                <button onClick={() => setSelected(null)} className="flex-1 bg-red-50 text-red-500 font-semibold px-4 py-2.5 rounded-xl hover:bg-red-100 transition-colors">
                  ✗ Not Selected
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
