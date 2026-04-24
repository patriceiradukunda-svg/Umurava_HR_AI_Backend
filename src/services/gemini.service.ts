import { GoogleGenerativeAI } from '@google/generative-ai';
import { IApplicant } from '../models/Applicant.model';
import { IJob } from '../models/Job.model';

if (!process.env.GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY is not set!');
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// ─── Model list — tried in order until one works ───────────────────────────
const MODEL_LIST = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash-latest',
  'gemini-1.5-pro-latest',
];

export interface SkillGap {
  skill: string;
  coverage: number;
  severity: 'critical' | 'moderate' | 'minor';
  recommendation: string;
}
export interface CandidateResult {
  applicantId: string;
  firstName: string; lastName: string; email: string;
  headline: string; location: string;
  availability: { status: string; type: string };
  matchScore: number;
  scoreBreakdown: {
    skillsMatch: number; experienceMatch: number;
    educationMatch: number; projectRelevance: number; availabilityBonus: number;
  };
  strengths: string[]; gaps: string[];
  recommendation: string;
  skillScores: { name: string; score: number }[];
  shortlistedReason: string;
  isShortlisted: boolean;
  skillGaps: string[]; growthAreas: string[];
  courseRecommendations: string[];
}
export interface ScreeningWeights {
  skillsMatch: number; experienceMatch: number;
  educationMatch: number; projectRelevance: number; availabilityBonus: number;
}
export interface ScreeningInsights {
  overallSkillGaps: SkillGap[];
  marketRecommendations: string[];
  pipelineHealth: string;
  topStrengthsAcrossPool: string[];
  criticalMissingSkills: string[];
  hiringRecommendation: string;
}
export const DEFAULT_WEIGHTS: ScreeningWeights = {
  skillsMatch: 40, experienceMatch: 30, educationMatch: 15,
  projectRelevance: 10, availabilityBonus: 5,
};

// ─── Test connection ────────────────────────────────────────────────────────
export async function testGeminiConnection(): Promise<{ ok: boolean; model: string; error?: string }> {
  for (const m of MODEL_LIST) {
    try {
      const model  = genAI.getGenerativeModel({ model: m });
      await model.generateContent('Reply with exactly: {"status":"ok"}');
      console.log(`✅ Gemini OK — model: ${m}`);
      return { ok: true, model: m };
    } catch (err: any) {
      console.warn(`⚠️  ${m}: ${err?.message?.substring(0, 80)}`);
    }
  }
  return { ok: false, model: '', error: 'All models failed — check GEMINI_API_KEY' };
}

// ─── JSON extractor ─────────────────────────────────────────────────────────
function extractJSON(raw: string): any {
  let text = raw.trim().replace(/```[\w]*\n?/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(text); } catch { /* continue */ }
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s !== -1 && e > s) {
    try { return JSON.parse(text.substring(s, e + 1)); } catch { /* continue */ }
    for (let i = e; i > s; i--) {
      if (text[i] === '}') { try { return JSON.parse(text.substring(s, i + 1)); } catch { /* shrink */ } }
    }
  }
  throw new Error(`JSON parse failed. Preview: ${text.substring(0, 200)}`);
}

// ─── ID remapper ────────────────────────────────────────────────────────────
function remapIds(aiCands: any[], batch: IApplicant[]): any[] {
  const byId    = new Map<string, string>();
  const byEmail = new Map<string, string>();
  const byName  = new Map<string, string>();
  for (const a of batch) {
    const id = (a._id as any).toString();
    byId.set(id, id);
    if (a.talentProfile.email) byEmail.set(a.talentProfile.email.toLowerCase(), id);
    byName.set(`${a.talentProfile.firstName.toLowerCase()}|${a.talentProfile.lastName.toLowerCase()}`, id);
  }
  return aiCands.map(c => {
    const aiId = String(c.applicantId || '');
    if (byId.has(aiId)) return c;
    const ek = (c.email || '').toLowerCase();
    if (ek && byEmail.has(ek)) return { ...c, applicantId: byEmail.get(ek) };
    const nk = `${(c.firstName || '').toLowerCase()}|${(c.lastName || '').toLowerCase()}`;
    if (byName.has(nk)) return { ...c, applicantId: byName.get(nk) };
    console.warn(`  ⚠️  Could not remap ID for ${c.firstName} ${c.lastName}`);
    return c;
  });
}

// ─── Get a working model ────────────────────────────────────────────────────
async function getWorkingModel(): Promise<{ model: any; name: string } | null> {
  for (const m of MODEL_LIST) {
    try {
      const model = genAI.getGenerativeModel({
        model: m,
        generationConfig: { temperature: 0.1, topP: 0.8, maxOutputTokens: 8192 },
      });
      // Quick ping
      await model.generateContent('Say OK');
      console.log(`  ✅ Using model: ${m}`);
      return { model, name: m };
    } catch (err: any) {
      console.warn(`  ⚠️  ${m} unavailable: ${err?.message?.substring(0, 60)}`);
    }
  }
  return null;
}

// ─── Call Gemini with retries ───────────────────────────────────────────────
async function callGemini(model: any, modelName: string, prompt: string, label: string): Promise<any> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`  🤖 ${label} | ${modelName} | attempt ${attempt}/3`);
      const result     = await model.generateContent(prompt);
      const resp       = result.response;
      const finishReason = resp.candidates?.[0]?.finishReason;

      if (finishReason === 'SAFETY') throw new Error('Blocked by safety filter');

      const rawText = resp.text();
      console.log(`  📄 ${rawText.length} chars | finish: ${finishReason || 'STOP'}`);

      if (!rawText || rawText.length < 20)
        throw new Error(`Response too short (${rawText?.length} chars)`);

      return extractJSON(rawText);
    } catch (err: any) {
      console.error(`  ❌ ${label} attempt ${attempt} failed: ${err?.message?.substring(0, 120)}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
      else throw err;
    }
  }
}

// ─── Profile text (compact) ─────────────────────────────────────────────────
function profileText(a: IApplicant, idx: number): string {
  const p = a.talentProfile;
  const totalExp = p.experience.reduce((acc, e) => {
    try {
      const s  = new Date(`${e.startDate}-01`);
      const en = e.isCurrent ? new Date() : new Date(`${e.endDate}-01`);
      return acc + Math.max(0, (en.getTime() - s.getTime()) / 31536000000);
    } catch { return acc; }
  }, 0);
  const skills = p.skills.map(s => `${s.name}(${s.level},${s.yearsOfExperience}y)`).join(', ') || 'none';
  const exp    = p.experience.slice(0, 2).map(e =>
    `${e.role}@${e.company}(${e.startDate}-${e.isCurrent ? 'now' : e.endDate})[${(e.technologies||[]).join(',')}]`
  ).join(' | ');
  const edu    = p.education.map(e => `${e.degree} ${e.fieldOfStudy}@${e.institution}(${e.endYear})`).join(', ');
  const certs  = (p.certifications || []).map(c => c.name).join(', ') || 'none';
  const projs  = (p.projects || []).slice(0, 2).map(pr => `${pr.name}[${(pr.technologies||[]).join(',')}]`).join(', ');
  return `--- CANDIDATE_${idx} id:${(a._id as any).toString()} ---
Name:${p.firstName} ${p.lastName} | Email:${p.email} | Location:${p.location}
Exp:${totalExp.toFixed(1)}yr | Skills:${skills}
Work:${exp || 'none'} | Edu:${edu || 'none'}
Certs:${certs} | Projects:${projs || 'none'}
Availability:${p.availability?.status || 'unknown'}`;
}

// ─── CALL 1: Evaluate candidates (no insights) ──────────────────────────────
function buildCandidatesPrompt(
  job: IJob, batch: IApplicant[], weights: ScreeningWeights
): string {
  const ws = Object.values(weights).reduce((a, b) => a + b, 0);
  const profiles = batch.map((a, i) => profileText(a, i + 1)).join('\n\n');
  return `Evaluate these ${batch.length} candidates for the job below. Return ONLY valid JSON.

JOB: ${job.title} | ${job.department} | Min ${job.minimumExperienceYears}yr exp
REQUIRED SKILLS: ${job.requiredSkills.join(', ')}
DESCRIPTION: ${job.description.substring(0, 300)}
${job.screeningNotes ? `HR NOTES: ${job.screeningNotes}` : ''}

SCORING: skillsMatch×${weights.skillsMatch} + experienceMatch×${weights.experienceMatch} + educationMatch×${weights.educationMatch} + projectRelevance×${weights.projectRelevance} + availabilityBonus×${weights.availabilityBonus} / ${ws}

${profiles}

Return this JSON (evaluate ALL ${batch.length} candidates):
{
  "candidates": [
    {
      "applicantId": "<copy id: field exactly>",
      "firstName": "", "lastName": "", "email": "", "location": "",
      "headline": "", "availability": {"status":"","type":""},
      "matchScore": 0,
      "scoreBreakdown": {"skillsMatch":0,"experienceMatch":0,"educationMatch":0,"projectRelevance":0,"availabilityBonus":0},
      "strengths": ["s1","s2","s3"],
      "gaps": ["g1","g2"],
      "shortlistedReason": "2 sentence reason",
      "skillGaps": ["sk1"],
      "growthAreas": ["a1"],
      "courseRecommendations": ["c1"],
      "recommendation": "hiring recommendation",
      "skillScores": [{"name":"skill","score":0}]
    }
  ]
}`;
}

// ─── CALL 2: Pool insights only (separate call, optional) ───────────────────
function buildInsightsPrompt(
  job: IJob, candidates: any[]
): string {
  const summary = candidates.map(c =>
    `${c.firstName} ${c.lastName}: score=${c.matchScore}, skillsMatch=${c.scoreBreakdown?.skillsMatch}`
  ).join('\n');
  const allSkillGaps = [...new Set(candidates.flatMap(c => c.skillGaps || []))].join(', ');
  return `Analyse this talent pool for the job: ${job.title}
Required skills: ${job.requiredSkills.join(', ')}

Candidate scores:
${summary}

Common skill gaps: ${allSkillGaps || 'none identified'}

Return ONLY this JSON:
{
  "overallSkillGaps": [{"skill":"","coverage":0,"severity":"moderate","recommendation":""}],
  "marketRecommendations": ["rec1","rec2"],
  "pipelineHealth": "one paragraph summary",
  "topStrengthsAcrossPool": ["strength1","strength2"],
  "criticalMissingSkills": ["skill1"],
  "hiringRecommendation": "overall strategic recommendation"
}`;
}

// ─── Main function ───────────────────────────────────────────────────────────
export async function runAIScreening(
  job: IJob,
  applicants: IApplicant[],
  weights: ScreeningWeights = DEFAULT_WEIGHTS,
  shortlistSize: number = 10,
  _modelName: string = 'gemini-2.0-flash'
): Promise<{
  shortlist: CandidateResult[];
  allCandidates: CandidateResult[];
  insights: ScreeningInsights;
  totalEvaluated: number;
  averageScore: number;
  topScore: number;
}> {
  if (!process.env.GEMINI_API_KEY)
    throw new Error('GEMINI_API_KEY is not set. Add it to Render → Environment variables.');

  // Find working model
  const modelInfo = await getWorkingModel();
  if (!modelInfo)
    throw new Error('No Gemini model available. Check GEMINI_API_KEY and API quota.');

  const { model, name: modelName } = modelInfo;

  // ── Process candidates in batches of 8 (smaller = safer) ─────────────────
  const BATCH_SIZE   = 8;
  const totalBatches = Math.ceil(applicants.length / BATCH_SIZE);
  let allCandidates: any[] = [];
  let failedBatches = 0;

  for (let i = 0; i < applicants.length; i += BATCH_SIZE) {
    const batch      = applicants.slice(i, i + BATCH_SIZE);
    const batchNum   = Math.floor(i / BATCH_SIZE) + 1;

    console.log(`\n📦 Batch ${batchNum}/${totalBatches} — ${batch.length} candidates`);

    try {
      const prompt = buildCandidatesPrompt(job, batch, weights);
      const parsed = await callGemini(model, modelName, prompt, `Candidates batch ${batchNum}`);

      if (!parsed.candidates || !Array.isArray(parsed.candidates) || parsed.candidates.length === 0)
        throw new Error(`No candidates array in response. Keys: ${Object.keys(parsed).join(', ')}`);

      console.log(`  ✅ ${parsed.candidates.length} candidates evaluated`);

      const remapped  = remapIds(parsed.candidates, batch);
      const validated = remapped.map((c: any) => ({
        ...c,
        matchScore: clamp(c.matchScore),
        scoreBreakdown: {
          skillsMatch:       clamp(c.scoreBreakdown?.skillsMatch),
          experienceMatch:   clamp(c.scoreBreakdown?.experienceMatch),
          educationMatch:    clamp(c.scoreBreakdown?.educationMatch),
          projectRelevance:  clamp(c.scoreBreakdown?.projectRelevance),
          availabilityBonus: clamp(c.scoreBreakdown?.availabilityBonus),
        },
        strengths:             arr(c.strengths),
        gaps:                  arr(c.gaps),
        skillGaps:             arr(c.skillGaps),
        growthAreas:           arr(c.growthAreas),
        courseRecommendations: arr(c.courseRecommendations),
        skillScores:           arr(c.skillScores),
        shortlistedReason:     c.shortlistedReason     || '',
        recommendation:        c.recommendation        || '',
        headline:              c.headline              || '',
        availability:          c.availability          || { status: 'unknown', type: 'Full-time' },
      }));

      allCandidates = [...allCandidates, ...validated];
    } catch (err: any) {
      failedBatches++;
      console.error(`❌ Batch ${batchNum} failed: ${err?.message}`);
    }
  }

  if (allCandidates.length === 0)
    throw new Error(
      `All ${totalBatches} batch(es) failed. ` +
      `Model used: ${modelName}. ` +
      `Verify GEMINI_API_KEY at aistudio.google.com/app/apikey`
    );

  // ── Sort → shortlist ───────────────────────────────────────────────────────
  allCandidates.sort((a, b) => b.matchScore - a.matchScore);
  const sz          = Math.min(shortlistSize, allCandidates.length);
  const shortlisted = allCandidates.slice(0, sz).map((c, i) => ({ ...c, rank: i + 1, isShortlisted: true }));
  const rejected    = allCandidates.slice(sz).map(c => ({ ...c, isShortlisted: false }));
  const finalAll    = [...shortlisted, ...rejected];

  console.log(`\n🏆 ${shortlisted.length} shortlisted from ${allCandidates.length} | model: ${modelName}`);
  if (failedBatches > 0) console.warn(`⚠️  ${failedBatches} batch(es) failed — partial results`);

  // ── CALL 2: Generate insights (optional — never kills the screening) ───────
  let insights: ScreeningInsights = defaultInsights(job);
  try {
    console.log('\n🔍 Generating pool insights…');
    const insightPrompt = buildInsightsPrompt(job, allCandidates);
    const parsed        = await callGemini(model, modelName, insightPrompt, 'Pool insights');
    if (parsed.hiringRecommendation || parsed.pipelineHealth) {
      insights = {
        overallSkillGaps:       arr(parsed.overallSkillGaps),
        marketRecommendations:  arr(parsed.marketRecommendations),
        pipelineHealth:         parsed.pipelineHealth         || '',
        topStrengthsAcrossPool: arr(parsed.topStrengthsAcrossPool),
        criticalMissingSkills:  arr(parsed.criticalMissingSkills),
        hiringRecommendation:   parsed.hiringRecommendation   || '',
      };
      console.log('  ✅ Insights generated');
    }
  } catch (err: any) {
    // Insights failure is non-fatal — candidates are already evaluated
    console.warn(`⚠️  Insights generation failed (non-fatal): ${err?.message}`);
  }

  const scores   = allCandidates.map(c => c.matchScore);
  const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  const topScore = scores.length ? Math.max(...scores) : 0;

  return {
    shortlist:      shortlisted,
    allCandidates:  finalAll,
    insights,
    totalEvaluated: allCandidates.length,
    averageScore:   avgScore,
    topScore,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const clamp = (v: any) => Math.min(100, Math.max(0, Math.round(Number(v) || 0)));
const arr   = (v: any) => Array.isArray(v) ? v : [];

function defaultInsights(job: IJob): ScreeningInsights {
  return {
    overallSkillGaps:       [],
    marketRecommendations:  [`Consider sourcing more candidates with: ${job.requiredSkills.slice(0, 3).join(', ')}`],
    pipelineHealth:         'Screening completed. Review shortlisted candidates for next steps.',
    topStrengthsAcrossPool: [],
    criticalMissingSkills:  [],
    hiringRecommendation:   'Review the shortlisted candidates and proceed with interviews.',
  };
}
