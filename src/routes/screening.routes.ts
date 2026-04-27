'use client'
import { useEffect, useState } from 'react'
import { jobsAPI, screeningAPI } from '@/lib/api'
import toast from 'react-hot-toast'
import {
  Play, CheckCircle, Clock, Loader2, ChevronRight, ChevronUp,
  ChevronDown, Briefcase, Users, Star, SlidersHorizontal,
  AlertCircle, RotateCcw, TrendingUp, MapPin, Hash, Search, X,
  CheckSquare,
} from 'lucide-react'
import Link from 'next/link'

const STEPS = [
  { key: 'parse',   label: 'Job Requirements Parsed',   sub: 'Extracting criteria and scoring weights' },
  { key: 'load',    label: 'Candidate Profiles Loaded', sub: 'All profiles ready for evaluation' },
  { key: 'eval',    label: 'Deep Profile Evaluation',   sub: 'Analysing qualifications, skills and experience' },
  { key: 'score',   label: 'Weighted Scoring Applied',  sub: 'Computing match scores across all dimensions' },
  { key: 'explain', label: 'Insights Generated',        sub: 'Strengths, gaps and recommendations per candidate' },
  { key: 'done',    label: 'Shortlist Ready',           sub: 'Top candidates identified and ranked' },
]

const DEFAULT_WEIGHTS = {
  skillsMatch: 40, experienceMatch: 30, educationMatch: 15,
  projectRelevance: 10, availabilityBonus: 5,
}

const WEIGHT_META: Record<string, { label: string; desc: string; color: string }> = {
  skillsMatch:       { label: 'Skills Match',     desc: 'Coverage and depth of required skills',      color: 'bg-sky-500'     },
  experienceMatch:   { label: 'Experience',        desc: 'Years of experience and role relevance',     color: 'bg-indigo-500'  },
  educationMatch:    { label: 'Education',         desc: 'Degree level and field of study alignment',  color: 'bg-violet-500'  },
  projectRelevance:  { label: 'Project Relevance', desc: 'Portfolio projects that match this role',    color: 'bg-teal-500'    },
  availabilityBonus: { label: 'Availability',      desc: 'How soon the candidate can start',           color: 'bg-emerald-500' },
}

// ─── View toggle ──────────────────────────────────────────────────────────────
type ViewMode = 'pending' | 'screened'

function SpinInput({
  value, onChange, min = 1, max = 999, label, sublabel,
}: {
  value: number; onChange: (n: number) => void
  min?: number; max?: number; label?: string; sublabel?: string
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n))
  return (
    <div className="flex flex-col gap-1">
      {label && <span className="text-xs font-bold text-sky-600 uppercase tracking-wide">{label}</span>}
      <div className="flex items-center h-11 border-2 border-sky-200 rounded-xl overflow-hidden focus-within:border-sky-500 transition-colors bg-white">
        <button type="button" onClick={() => onChange(clamp(value - 1))}
          className="w-10 h-full flex items-center justify-center text-sky-400 hover:text-sky-700 hover:bg-sky-50 transition-colors flex-shrink-0 text-lg font-bold">−</button>
        <input type="number" min={min} max={max} value={value}
          onChange={e => onChange(clamp(parseInt(e.target.value) || min))}
          className="flex-1 h-full text-center font-display font-bold text-sky-900 text-lg outline-none bg-transparent" />
        <button type="button" onClick={() => onChange(clamp(value + 1))}
          className="w-10 h-full flex items-center justify-center text-sky-400 hover:text-sky-700 hover:bg-sky-50 transition-colors flex-shrink-0 text-lg font-bold">+</button>
      </div>
      {sublabel && <span className="text-sky-400 text-xs">{sublabel}</span>}
    </div>
  )
}

export default function HRScreeningPage() {
  const [jobs,           setJobs]           = useState<any[]>([])
  const [screenedJobIds, setScreenedJobIds] = useState<string[]>([])
  const [loadingJobs,    setLoadingJobs]    = useState(true)
  const [viewMode,       setViewMode]       = useState<ViewMode>('pending')
  const [selectedJob,    setSelectedJob]    = useState('')
  const [shortlistSize,  setSize]           = useState(10)
  const [weights,        setWeights]        = useState({ ...DEFAULT_WEIGHTS })
  const [showWeights,    setShowWeights]    = useState(false)
  const [running,        setRunning]        = useState(false)
  const [screeningId,    setScreeningId]    = useState('')
  const [currentStep,    setCurrentStep]    = useState(-1)
  const [done,           setDone]           = useState(false)
  const [shortlistCount, setShortlistCount] = useState(0)
  const [totalEvaluated, setTotalEvaluated] = useState(0)
  const [hasInsights,    setHasInsights]    = useState(false)
  const [errMsg,         setErrMsg]         = useState('')
  const [jobSearch,      setJobSearch]      = useState('')

  // ── Load jobs + already-screened job IDs ─────────────────────────────────
  useEffect(() => {
    setLoadingJobs(true)
    Promise.all([
      jobsAPI.list({ status: 'active' }),
      jobsAPI.list({ status: 'closed' }),
      screeningAPI.list({ status: 'completed' }),   // ← get screened job ids
    ]).then(([active, closed, screenings]) => {
      const allJobs = [...(active.data.data || []), ...(closed.data.data || [])]
      setJobs(allJobs)

      // Extract unique jobIds that already have a completed screening
      const screeningList = screenings.data.data || []
      const ids = [...new Set(
        screeningList.map((s: any) =>
          typeof s.jobId === 'object' ? String(s.jobId._id ?? s.jobId) : String(s.jobId)
        )
      )] as string[]
      setScreenedJobIds(ids)
    }).catch(() => {}).finally(() => setLoadingJobs(false))
  }, [])

  const job        = jobs.find(j => j._id === selectedJob)
  const weightTotal       = Object.values(weights).reduce((a, b) => a + b, 0)
  const applicantCount    = job?.applicantCount || 0
  const shortlistTooLarge = applicantCount > 0 && shortlistSize > applicantCount
  const resetWeights = () => setWeights({ ...DEFAULT_WEIGHTS })
  const setWeight    = (key: keyof typeof weights, val: number) =>
    setWeights(w => ({ ...w, [key]: Math.min(100, Math.max(0, val)) }))

  // ── Split jobs into pending and already-screened ──────────────────────────
  const pendingJobs  = jobs.filter(j => !screenedJobIds.includes(String(j._id)))
  const screenedJobs = jobs.filter(j =>  screenedJobIds.includes(String(j._id)))

  // Apply search filter to whichever view is active
  const displayJobs = (viewMode === 'pending' ? pendingJobs : screenedJobs).filter(j => {
    const q = jobSearch.toLowerCase()
    return !q ||
      j.title?.toLowerCase().includes(q)      ||
      j.department?.toLowerCase().includes(q) ||
      j.location?.toLowerCase().includes(q)   ||
      j.type?.toLowerCase().includes(q)
  })

  const runScreening = async () => {
    if (!selectedJob)         { toast.error('Please select a job first');      return }
    if (!job?.applicantCount) { toast.error('This job has no applicants yet'); return }

    // Prevent re-screening a job that already has results without confirmation
    if (screenedJobIds.includes(selectedJob)) {
      const ok = window.confirm(
        `"${job?.title}" has already been screened.\n\nRun a new screening? ` +
        `(Delete the old result first from the Shortlist page to keep things clean.)`
      )
      if (!ok) return
    }

    setRunning(true); setDone(false); setCurrentStep(0); setErrMsg('')

    try {
      const r   = await screeningAPI.run({ jobId: selectedJob, shortlistSize, weights })
      const sid = r.data.screeningId
      setScreeningId(sid)

      const stepMs = Math.max(2000, Math.ceil((job?.applicantCount || 0) / 15) * 1500)
      let step = 0
      const stepInterval = setInterval(() => {
        step = Math.min(step + 1, STEPS.length - 2)
        setCurrentStep(step)
      }, stepMs)

      const poll = setInterval(async () => {
        try {
          const s = await screeningAPI.pollStatus(sid)
          if (s.data.status === 'completed') {
            clearInterval(poll); clearInterval(stepInterval)
            setCurrentStep(STEPS.length - 1); setDone(true); setRunning(false)
            setShortlistCount(s.data.shortlistCount || 0)
            setTotalEvaluated(s.data.totalEvaluated || 0)
            setHasInsights(s.data.hasInsights || false)
            // Mark this job as screened in local state
            setScreenedJobIds(prev => [...new Set([...prev, selectedJob])])
            toast.success(`Screening complete — ${s.data.shortlistCount} candidates shortlisted!`)
          } else if (s.data.status === 'failed') {
            clearInterval(poll); clearInterval(stepInterval)
            setRunning(false); setCurrentStep(-1)
            setErrMsg(s.data.errorMessage || 'Screening failed. Please try again.')
            toast.error('Screening failed')
          }
        } catch { clearInterval(poll); clearInterval(stepInterval); setRunning(false) }
      }, 4000)
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Failed to start screening')
      setRunning(false); setCurrentStep(-1)
    }
  }

  const STATUS_STYLES: Record<string, string> = {
    active: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
    closed: 'bg-slate-100 text-slate-500 border border-slate-200',
  }
  const card = 'bg-white rounded-2xl border-2 border-sky-100 shadow-[0_2px_16px_rgba(14,165,233,0.08)]'

  return (
    <div className="space-y-5 max-w-6xl">
      <div>
        <h1 className="font-display text-xl sm:text-2xl font-bold text-sky-900">Candidate Screening</h1>
        <p className="text-sky-400 text-sm mt-1">Configure and launch intelligent candidate evaluation</p>
      </div>

      <div className="grid lg:grid-cols-5 gap-5">

        {/* ── LEFT — config ─────────────────────────────────────────────── */}
        <div className="lg:col-span-3 space-y-4">

          {/* Step 1 — Select Job */}
          <div className={card}>
            <div className="flex items-center gap-3 px-5 py-4 border-b border-sky-100">
              <div className="w-7 h-7 rounded-full bg-sky-500 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">1</div>
              <div className="flex-1">
                <h2 className="font-display font-bold text-sky-900">Select Job Position</h2>
                <p className="text-sky-400 text-xs">Choose a job to screen candidates for</p>
              </div>
            </div>

            <div className="p-5 space-y-3">

              {/* ── View toggle: Pending / Already Screened ── */}
              <div className="flex items-center gap-1 bg-sky-50 border-2 border-sky-100 rounded-xl p-1">
                <button
                  onClick={() => { setViewMode('pending'); setSelectedJob('') }}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-bold transition-all min-h-[38px] ${
                    viewMode === 'pending'
                      ? 'bg-white text-sky-700 shadow-sm'
                      : 'text-sky-400 hover:text-sky-600'
                  }`}>
                  <Play className="w-3.5 h-3.5" />
                  Not Screened
                  <span className="bg-sky-100 text-sky-600 px-1.5 py-0.5 rounded-full text-[10px]">
                    {pendingJobs.length}
                  </span>
                </button>
                <button
                  onClick={() => { setViewMode('screened'); setSelectedJob('') }}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-bold transition-all min-h-[38px] ${
                    viewMode === 'screened'
                      ? 'bg-white text-emerald-700 shadow-sm'
                      : 'text-sky-400 hover:text-sky-600'
                  }`}>
                  <CheckSquare className="w-3.5 h-3.5" />
                  Already Screened
                  <span className="bg-emerald-100 text-emerald-600 px-1.5 py-0.5 rounded-full text-[10px]">
                    {screenedJobs.length}
                  </span>
                </button>
              </div>

              {/* Info banner for screened view */}
              {viewMode === 'screened' && (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5">
                  <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                  <p className="text-amber-700 text-xs leading-relaxed">
                    These jobs already have screening results. To re-screen with different settings,
                    first <Link href="/hr/shortlist" className="font-bold underline">delete the existing result</Link> from the Shortlist page.
                  </p>
                </div>
              )}

              {/* Search */}
              {jobs.length > 0 && (
                <div className="flex items-center gap-2 border-2 border-sky-200 rounded-xl px-3 h-11 focus-within:border-sky-400 focus-within:ring-4 focus-within:ring-sky-100 bg-white transition-all">
                  <Search className="w-4 h-4 text-sky-400 flex-shrink-0" />
                  <input type="text" placeholder="Search by title, department, location…"
                    value={jobSearch} onChange={e => setJobSearch(e.target.value)}
                    className="flex-1 text-sm text-sky-900 placeholder-sky-300 outline-none bg-transparent font-medium" />
                  {jobSearch && (
                    <button onClick={() => setJobSearch('')}
                      className="text-sky-300 hover:text-sky-600 transition-colors flex-shrink-0">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )}

              {/* Job list */}
              {loadingJobs ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 text-sky-400 animate-spin" />
                </div>
              ) : displayJobs.length === 0 ? (
                <div className="text-center py-8">
                  {viewMode === 'pending' && jobs.length === 0 ? (
                    <p className="text-sky-300 text-sm">No jobs found. <Link href="/hr/jobs" className="underline text-sky-500 font-semibold">Post a job first →</Link></p>
                  ) : viewMode === 'pending' && pendingJobs.length === 0 ? (
                    <div>
                      <p className="text-sky-500 text-sm font-semibold mb-1">All jobs have been screened! 🎉</p>
                      <p className="text-sky-400 text-xs">Switch to "Already Screened" to view results, or delete a result to re-screen.</p>
                    </div>
                  ) : jobSearch ? (
                    <div>
                      <p className="text-sky-400 text-sm font-semibold">No jobs match "{jobSearch}"</p>
                      <button onClick={() => setJobSearch('')} className="text-sky-500 text-xs underline mt-1 font-medium">Clear search</button>
                    </div>
                  ) : (
                    <p className="text-sky-400 text-sm">No screened jobs yet.</p>
                  )}
                </div>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                  {displayJobs.map(j => {
                    const isScreened = screenedJobIds.includes(String(j._id))
                    return (
                      <button key={j._id} onClick={() => setSelectedJob(j._id)}
                        className={`w-full text-left rounded-xl p-4 border-2 transition-all ${
                          selectedJob === j._id
                            ? 'border-sky-500 bg-sky-50'
                            : isScreened
                              ? 'border-emerald-200 hover:border-emerald-300 bg-emerald-50/40'
                              : 'border-sky-100 hover:border-sky-300 bg-white'
                        }`}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${STATUS_STYLES[j.status] || 'bg-sky-100 text-sky-700'}`}>
                                {j.status}
                              </span>
                              {isScreened && (
                                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200 flex items-center gap-1">
                                  <CheckCircle className="w-2.5 h-2.5" /> Screened
                                </span>
                              )}
                              <span className="text-sky-400 text-xs">{j.department}</span>
                            </div>
                            <p className="font-display font-bold text-sky-900 text-sm leading-snug">{j.title}</p>
                            <div className="flex items-center gap-3 mt-1 flex-wrap">
                              <span className="flex items-center gap-1 text-sky-400 text-xs"><MapPin className="w-3 h-3" />{j.location}</span>
                              <span className="flex items-center gap-1 text-sky-400 text-xs"><Briefcase className="w-3 h-3" />{j.type}</span>
                            </div>
                          </div>
                          <div className="flex-shrink-0 text-right">
                            <div className="font-display text-xl font-bold text-sky-500">{j.applicantCount || 0}</div>
                            <div className="text-sky-300 text-[10px]">applicants</div>
                          </div>
                        </div>
                        {Array.isArray(j.requiredSkills) && j.requiredSkills.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {j.requiredSkills.slice(0, 4).map((s: string) => (
                              <span key={s} className="text-xs bg-sky-100 text-sky-600 px-2 py-0.5 rounded-full">{s}</span>
                            ))}
                            {j.requiredSkills.length > 4 && <span className="text-xs text-sky-400">+{j.requiredSkills.length - 4}</span>}
                          </div>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Step 2 — Shortlist Size */}
          <div className={card}>
            <div className="flex items-center gap-3 px-5 py-4 border-b border-sky-100">
              <div className="w-7 h-7 rounded-full bg-sky-500 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">2</div>
              <div>
                <h2 className="font-display font-bold text-sky-900">Shortlist Settings</h2>
                <p className="text-sky-400 text-xs">How many top candidates to select</p>
              </div>
            </div>
            <div className="p-5">
              <div className="flex items-start gap-6 flex-wrap">
                <SpinInput value={shortlistSize} onChange={setSize} min={1}
                  max={job?.applicantCount || 999} label="Shortlist Size"
                  sublabel={`Top ${shortlistSize} candidate${shortlistSize !== 1 ? 's' : ''} will be selected`} />
                <div className="flex-1 min-w-[160px]">
                  <p className="text-xs font-bold text-sky-500 uppercase tracking-wide mb-2">Quick select</p>
                  <div className="flex gap-2 flex-wrap">
                    {[5, 10, 15, 20, 30].map(n => (
                      <button key={n} onClick={() => setSize(n)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold border-2 transition-all min-h-[36px] ${
                          shortlistSize === n
                            ? 'border-sky-500 bg-sky-50 text-sky-700'
                            : 'border-sky-100 text-sky-400 hover:border-sky-300 hover:text-sky-600'
                        }`}>
                        Top {n}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Step 3 — Scoring Weights */}
          <div className={card}>
            <div className="flex items-center gap-3 px-5 py-4 border-b border-sky-100">
              <div className="w-7 h-7 rounded-full bg-sky-500 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">3</div>
              <div className="flex-1">
                <h2 className="font-display font-bold text-sky-900">Scoring Weights</h2>
                <p className="text-sky-400 text-xs">Customise evaluation priorities for this role</p>
              </div>
              <div className={`flex-shrink-0 text-xs font-bold px-3 py-1 rounded-full ${
                weightTotal === 100 ? 'bg-emerald-100 text-emerald-700' :
                weightTotal > 100   ? 'bg-red-100 text-red-600' :
                                      'bg-amber-100 text-amber-700'
              }`}>
                Total: {weightTotal}
              </div>
            </div>
            <div className="p-5">
              {showWeights && (
                <div className="space-y-4 mb-4 bg-sky-50 rounded-xl p-4 border-2 border-sky-100">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold text-sky-500 uppercase tracking-wide">Adjust each weight (0–100)</p>
                    <button onClick={resetWeights}
                      className="flex items-center gap-1 text-xs text-sky-500 hover:text-sky-700 font-semibold min-h-[36px] px-2">
                      <RotateCcw className="w-3 h-3" /> Reset
                    </button>
                  </div>
                  {Object.entries(weights).map(([k, v]) => (
                    <div key={k}>
                      <p className="text-sky-800 text-sm font-semibold mb-0.5">{WEIGHT_META[k]?.label}</p>
                      <p className="text-sky-400 text-xs mb-1">{WEIGHT_META[k]?.desc}</p>
                      <SpinInput value={v} onChange={val => setWeight(k as keyof typeof weights, val)} min={0} max={100} />
                    </div>
                  ))}
                  {weightTotal !== 100 && (
                    <div className={`flex items-center gap-2 text-xs font-semibold p-2 rounded-lg ${
                      weightTotal > 100 ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-600'
                    }`}>
                      <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                      Total is {weightTotal}. Weights will be normalised automatically.
                    </div>
                  )}
                </div>
              )}
              <button onClick={() => setShowWeights(v => !v)}
                className="flex items-center gap-2 text-sm font-semibold text-sky-600 hover:text-sky-800 transition-colors min-h-[36px]">
                <SlidersHorizontal className="w-4 h-4" />
                {showWeights ? 'Hide' : 'Adjust'} Scoring Weights
                {showWeights ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          {/* Run button */}
          <button onClick={runScreening}
            disabled={running || !selectedJob || !job?.applicantCount || shortlistTooLarge}
            className={`w-full flex items-center justify-center gap-3 font-bold py-4 rounded-2xl text-base transition-all min-h-[56px] ${
              running || !selectedJob || !job?.applicantCount
                ? 'bg-sky-100 text-sky-300 cursor-not-allowed'
                : 'bg-sky-500 hover:bg-sky-600 text-white shadow-md hover:shadow-lg active:scale-[0.99]'
            }`}>
            {running
              ? <><Loader2 className="w-5 h-5 animate-spin" /> Screening in Progress…</>
              : <><Play className="w-5 h-5" /> Run Screening</>}
          </button>

          {!selectedJob && !running && (
            <p className="text-center text-sky-400 text-sm">← Select a job above to get started</p>
          )}
          {selectedJob && !job?.applicantCount && !running && (
            <p className="text-center text-amber-500 text-sm">
              This job has no applicants yet.{' '}
              <Link href="/hr/applicants" className="underline font-semibold">Add applicants →</Link>
            </p>
          )}
          {shortlistTooLarge && !running && (
            <div className="flex items-start gap-3 bg-red-50 border-2 border-red-200 rounded-2xl px-4 py-3">
              <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-red-700 font-bold text-sm">
                  Shortlist size exceeds applicant count
                </p>
                <p className="text-red-500 text-xs mt-0.5">
                  You want to shortlist <span className="font-bold">{shortlistSize}</span> candidates but this job only has{' '}
                  <span className="font-bold">{applicantCount}</span> applicant{applicantCount !== 1 ? 's' : ''}.
                  Please reduce the shortlist size to <span className="font-bold">{applicantCount}</span> or fewer.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT — Evaluation Engine ──────────────────────────────────── */}
        <div className="lg:col-span-2">
          <div className={`${card} sticky top-20 overflow-hidden`}>
            <div className="bg-gradient-to-r from-sky-500 to-sky-600 px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center flex-shrink-0">
                  <TrendingUp className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h2 className="font-display font-bold text-white text-base leading-tight">Evaluation Engine</h2>
                  <p className="text-sky-100 text-xs">Intelligent candidate assessment</p>
                </div>
              </div>
            </div>

            <div className="p-5 space-y-4">
              {job && (
                <div className="bg-sky-50 rounded-xl p-3 border-2 border-sky-100">
                  <p className="text-sky-400 text-[10px] font-bold uppercase tracking-wide mb-1">Selected Job</p>
                  <p className="text-sky-900 font-bold text-sm">{job.title}</p>
                  <div className="flex items-center gap-3 mt-1 flex-wrap">
                    <span className="text-sky-500 text-xs flex items-center gap-1"><Users className="w-3 h-3" />{job.applicantCount || 0} candidates</span>
                    <span className="text-sky-500 text-xs flex items-center gap-1"><Star className="w-3 h-3" />Top {shortlistSize}</span>
                    <span className="text-sky-400 text-xs flex items-center gap-1"><Hash className="w-3 h-3" />{String(job._id).slice(-6).toUpperCase()}</span>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                {STEPS.map((step, i) => {
                  const isDone   = done ? true : i < currentStep
                  const isActive = i === currentStep && running && !done
                  return (
                    <div key={step.key}
                      className={`flex items-center gap-3 p-3 rounded-xl border-2 transition-all duration-300 ${
                        isDone   ? 'bg-emerald-50  border-emerald-200' :
                        isActive ? 'bg-sky-50      border-sky-300 shadow-sm' :
                                   'bg-sky-50/50   border-sky-100'
                      }`}>
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
                        isDone ? 'bg-emerald-500' : isActive ? 'bg-sky-500' : 'bg-sky-100'
                      }`}>
                        {isDone   ? <CheckCircle className="w-4 h-4 text-white" /> :
                         isActive ? <Loader2 className="w-3.5 h-3.5 text-white animate-spin" /> :
                                    <Clock className="w-3.5 h-3.5 text-sky-400" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-semibold ${isDone ? 'text-emerald-700' : isActive ? 'text-sky-700' : 'text-sky-400'}`}>{step.label}</p>
                        <p className={`text-xs ${isDone ? 'text-emerald-500' : isActive ? 'text-sky-500' : 'text-sky-300'}`}>{step.sub}</p>
                      </div>
                      {step.key === 'done' && isDone && (
                        <Link href="/hr/shortlist" className="flex-shrink-0">
                          <ChevronRight className="w-4 h-4 text-emerald-500 hover:text-emerald-700 transition-colors" />
                        </Link>
                      )}
                    </div>
                  )
                })}
              </div>

              {errMsg && (
                <div className="bg-red-50 border-2 border-red-200 rounded-xl p-3">
                  <p className="text-red-600 text-xs font-semibold">{errMsg}</p>
                </div>
              )}

              {done && (
                <div className="space-y-3">
                  <div className="bg-emerald-50 border-2 border-emerald-200 rounded-xl p-4">
                    <p className="text-emerald-700 font-bold text-sm mb-1">✓ Screening Complete</p>
                    <p className="text-emerald-600 text-xs">
                      {shortlistCount} candidates shortlisted from {totalEvaluated} evaluated
                    </p>
                    {hasInsights && (
                      <p className="text-emerald-500 text-xs mt-1">Skills gap analysis and recommendations ready</p>
                    )}
                  </div>
                  <Link href="/hr/shortlist"
                    className="w-full flex items-center justify-center gap-2 bg-sky-500 hover:bg-sky-600 text-white font-bold py-3 rounded-xl transition-colors min-h-[48px]">
                    View Shortlist & Insights <ChevronRight className="w-4 h-4" />
                  </Link>
                </div>
              )}

              {running && job && (
                <div className="bg-sky-50 border-2 border-sky-100 rounded-xl p-3 text-center">
                  <p className="text-sky-500 text-xs">
                    Evaluating {job.applicantCount} candidate{job.applicantCount !== 1 ? 's' : ''}
                    {job.applicantCount > 15 && ` in batches`} — this may take a few minutes
                  </p>
                </div>
              )}

              {!running && !done && currentStep === -1 && (
                <div className="bg-sky-50 border-2 border-sky-100 rounded-xl p-4">
                  <p className="text-sky-500 text-xs font-bold uppercase tracking-wide mb-2">What happens next</p>
                  <ul className="space-y-1.5">
                    {[
                      'Every applicant is evaluated individually',
                      'Scores weighted by your custom priorities',
                      'Strengths and skill gaps identified per candidate',
                      'Pool-wide insights generated for HR strategy',
                      'Top candidates ranked and shortlisted',
                    ].map(t => (
                      <li key={t} className="text-sky-500 text-xs flex items-start gap-2">
                        <span className="text-sky-400 flex-shrink-0 mt-0.5">•</span>{t}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}
