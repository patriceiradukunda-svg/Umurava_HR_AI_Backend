import { GoogleGenerativeAI } from '@google/generative-ai';
import { IApplicant } from '../models/Applicant.model';
import { IJob } from '../models/Job.model';

if (!process.env.GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY is not set!');
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// Preview models have separate quota pools — use these first
const MODELS = [
  'gemini-2.5-flash-preview-04-17',
  'gemini-2.5-pro-preview-03-25',
  'gemini-2.0-flash-thinking-exp',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
];

export interface SkillGap {
  skill: string; coverage: number;
  severity: 'critical' | 'moderate' | 'minor'; recommendation: string;
}
export interface CandidateResult {
  applicantId: string; firstName: string; lastName: string;
  email: string; headline: string; location: string;
  availability: { status: string; type: string };
  matchScore: number;
  scoreBreakdown: {
    skillsMatch: number; experienceMatch: number; educationMatch: number;
    projectRelevance: number; availabilityBonus: number;
  };
  strengths: string[]; gaps: string[]; recommendation: string;
  skillScores: { name: string; score: number }[];
  shortlistedReason: string; isShortlisted: boolean;
  skillGaps: string[]; growthAreas: string[]; courseRecommendations: string[];
}
export interface ScreeningWeights {
  skillsMatch: number; experienceMatch: number; educationMatch: number;
  projectRelevance: number; availabilityBonus: number;
}
export interface ScreeningInsights {
  overallSkillGaps: SkillGap[]; marketRecommendations: string[];
  pipelineHealth: string; topStrengthsAcrossPool: string[];
  criticalMissingSkills: string[]; hiringRecommendation: string;
}
export const DEFAULT_WEIGHTS: ScreeningWeights = {
  skillsMatch: 40, experienceMatch: 30, educationMatch: 15,
  projectRelevance: 10, availabilityBonus: 5,
};

// ─── Get a working model (tries each until one succeeds) ─────────────────────
async function getModel(): Promise<{ model: any; name: string }> {
  for (const name of MODELS) {
    try {
      const model = genAI.getGenerativeModel({
        model: name,
        generationConfig: {
          responseMimeType: 'application/json', // forces clean JSON — no parsing needed
          temperature:      0.1,
          maxOutputTokens:  8192,
        },
      });
      // Quick ping to confirm model is available
      const test = await model.generateContent('{"test":true}');
      test.response.text(); // throws if model unavailable
      console.log(`  ✅ Using model: ${name}`);
      return { model, name };
    } catch (err: any) {
      const code = err?.status || err?.message?.match(/\[(\d+)/)?.[1];
      console.warn(`  ⚠️  ${name} unavailable [${code}]: ${err?.message?.substring(0, 60)}`);
      // Auth error — no point trying more
      if (code === 400 || code === 401 || code === 403) {
        throw new Error(`API key error [${code}]. Check GEMINI_API_KEY on Render.`);
      }
    }
  }
  throw new Error(
    'No Gemini model available. All models returned 404 or 429. ' +
    'Enable the Generative Language API at console.cloud.google.com → APIs & Services.'
  );
}

// ─── Call model with retries ──────────────────────────────────────────────────
async function callModel(model: any, modelName: string, prompt: string, label: string): Promise<any> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`  🤖 ${label} | ${modelName} | attempt ${attempt}`);
      const result = await model.generateContent(prompt);
      const text   = result.response.text();
      console.log(`  📄 ${text.length} chars`);
      if (!text || text.length < 10) throw new Error('Empty response');
      // With responseMimeType:'application/json', response is always valid JSON
      return JSON.parse(text);
    } catch (err: any) {
      console.error(`  ❌ attempt ${attempt}: ${err?.message?.substring(0, 100)}`);
      if (attempt < 2) await sleep(3000);
      else throw err;
    }
  }
}

// ─── Profile text ─────────────────────────────────────────────────────────────
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
  const exp    = p.experience.slice(0,2).map(e =>
    `${e.role}@${e.company}(${e.startDate}-${e.isCurrent?'now':e.endDate})[${(e.technologies||[]).join(',')}]: ${(e.description||'').substring(0,100)}`
  ).join(' | ');
  const edu    = p.education.map(e => `${e.degree} ${e.fieldOfStudy}@${e.institution}(${e.endYear})`).join(', ');
  const certs  = (p.certifications||[]).map(c => c.name).join(', ') || 'none';
  const projs  = (p.projects||[]).slice(0,2).map(pr => `${pr.name}[${(pr.technologies||[]).join(',')}]`).join(', ');
  return `CANDIDATE_${idx} id:${(a._id as any).toString()}
Name:${p.firstName} ${p.lastName} | Email:${p.email} | Location:${p.location}
Exp:${totalExp.toFixed(1)}yr | Skills:${skills}
Work:${exp||'none'} | Edu:${edu||'none'}
Certs:${certs} | Projects:${projs||'none'} | Available:${p.availability?.status||'unknown'}`;
}

// ─── Prompts ──────────────────────────────────────────────────────────────────
function candidatesPrompt(job: IJob, batch: IApplicant[], w: ScreeningWeights): string {
  const ws       = Object.values(w).reduce((a, b) => a + b, 0);
  const profiles = batch.map((a, i) => profileText(a, i + 1)).join('\n\n');
  return `You are an expert technical recruiter. Evaluate these ${batch.length} candidates for the job below.

JOB: ${job.title} | ${job.department} | Min ${job.minimumExperienceYears}yr exp
Required Skills: ${job.requiredSkills.join(', ')}
Nice to have: ${(job.niceToHaveSkills||[]).join(', ')}
Description: ${job.description.substring(0,300)}
${job.screeningNotes ? `HR Notes: ${job.screeningNotes}` : ''}

Scoring: matchScore = (skillsMatch×${w.skillsMatch} + experienceMatch×${w.experienceMatch} + educationMatch×${w.educationMatch} + projectRelevance×${w.projectRelevance} + availabilityBonus×${w.availabilityBonus}) / ${ws}
Availability scoring: Immediately=100, Open to Opportunities=70, else=30

${profiles}

Return a JSON object evaluating ALL ${batch.length} candidates:
{
  "candidates": [
    {
      "applicantId": "copy the id: field exactly",
      "firstName": "", "lastName": "", "email": "", "location": "", "headline": "",
      "availability": {"status": "", "type": ""},
      "matchScore": 0,
      "scoreBreakdown": {
        "skillsMatch": 0, "experienceMatch": 0, "educationMatch": 0,
        "projectRelevance": 0, "availabilityBonus": 0
      },
      "strengths": ["strength 1", "strength 2", "strength 3"],
      "gaps": ["gap 1", "gap 2"],
      "shortlistedReason": "2 sentence explanation",
      "skillGaps": ["missing skill"],
      "growthAreas": ["area to develop"],
      "courseRecommendations": ["Course name — what gap it closes"],
      "recommendation": "final hiring recommendation",
      "skillScores": [{"name": "skill name", "score": 0}]
    }
  ]
}`;
}

function insightsPrompt(job: IJob, candidates: any[]): string {
  const summary = candidates.slice(0,20).map(c =>
    `${c.firstName} ${c.lastName}: score=${c.matchScore}, gaps=${(c.skillGaps||[]).join(',')}`
  ).join('\n');
  return `You are an expert HR analyst. Analyse this talent pool for: ${job.title}
Required skills: ${job.requiredSkills.join(', ')}

Candidate results:
${summary}

Return a JSON object:
{
  "overallSkillGaps": [{"skill": "", "coverage": 0, "severity": "moderate", "recommendation": ""}],
  "marketRecommendations": ["recommendation 1", "recommendation 2"],
  "pipelineHealth": "one paragraph describing pool quality",
  "topStrengthsAcrossPool": ["common strength 1"],
  "criticalMissingSkills": ["skill almost nobody has"],
  "hiringRecommendation": "overall strategic recommendation for HR"
}`;
}

// ─── ID remapper ──────────────────────────────────────────────────────────────
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
    const nk = `${(c.firstName||'').toLowerCase()}|${(c.lastName||'').toLowerCase()}`;
    if (byName.has(nk)) return { ...c, applicantId: byName.get(nk) };
    console.warn(`  ⚠️  Could not remap ID for ${c.firstName} ${c.lastName}`);
    return c;
  });
}

// ─── Test connection ──────────────────────────────────────────────────────────
export async function testGeminiConnection(): Promise<{ ok: boolean; model: string; error?: string }> {
  try {
    const { name } = await getModel();
    return { ok: true, model: name };
  } catch (err: any) {
    return { ok: false, model: '', error: err?.message };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export async function runAIScreening(
  job: IJob,
  applicants: IApplicant[],
  weights: ScreeningWeights = DEFAULT_WEIGHTS,
  shortlistSize: number = 10,
  _modelName = 'gemini-2.5-flash-preview-04-17'
): Promise<{
  shortlist: CandidateResult[]; allCandidates: CandidateResult[];
  insights: ScreeningInsights; totalEvaluated: number;
  averageScore: number; topScore: number;
}> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set. Add it in Render → Environment variables.');
  }

  console.log('\n🔍 Finding available Gemini model…');
  const { model, name: modelName } = await getModel();

  const BATCH_SIZE   = 8;
  const totalBatches = Math.ceil(applicants.length / BATCH_SIZE);
  let allCandidates: any[] = [];
  let failedBatches = 0;

  // CALL 1: Evaluate candidates
  for (let i = 0; i < applicants.length; i += BATCH_SIZE) {
    const batch    = applicants.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    console.log(`\n📦 Batch ${batchNum}/${totalBatches} — ${batch.length} candidates`);

    try {
      const parsed = await callModel(
        model, modelName,
        candidatesPrompt(job, batch, weights),
        `Candidates batch ${batchNum}`
      );

      if (!parsed.candidates || !Array.isArray(parsed.candidates) || !parsed.candidates.length) {
        throw new Error(`No candidates array. Keys: ${Object.keys(parsed).join(', ')}`);
      }

      console.log(`  📊 ${parsed.candidates.length} candidates evaluated`);

      const validated = remapIds(parsed.candidates, batch).map((c: any) => ({
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
        shortlistedReason:     c.shortlistedReason || '',
        recommendation:        c.recommendation    || '',
        headline:              c.headline          || '',
        availability:          c.availability      || { status: 'unknown', type: 'Full-time' },
      }));

      allCandidates = [...allCandidates, ...validated];
      console.log(`  ✅ Batch ${batchNum} done — ${allCandidates.length} total`);

    } catch (err: any) {
      failedBatches++;
      console.error(`❌ Batch ${batchNum} failed: ${err?.message}`);
    }
  }

  if (allCandidates.length === 0) {
    throw new Error(
      `Screening produced no results — all ${totalBatches} batch(es) failed. ` +
      `Model used: ${modelName}. Check Render logs above for details.`
    );
  }

  // Sort → shortlist
  allCandidates.sort((a, b) => b.matchScore - a.matchScore);
  const sz          = Math.min(shortlistSize, allCandidates.length);
  const shortlisted = allCandidates.slice(0, sz).map((c, i) => ({ ...c, rank: i+1, isShortlisted: true }));
  const rejected    = allCandidates.slice(sz).map(c => ({ ...c, isShortlisted: false }));
  const finalAll    = [...shortlisted, ...rejected];

  console.log(`\n🏆 ${shortlisted.length} shortlisted from ${allCandidates.length} | model: ${modelName}`);

  // CALL 2: Pool insights (non-fatal)
  let insights: ScreeningInsights = defaultInsights(job);
  try {
    console.log('\n🔍 Generating pool insights…');
    const parsed = await callModel(model, modelName, insightsPrompt(job, allCandidates), 'Pool insights');
    if (parsed.hiringRecommendation || parsed.pipelineHealth) {
      insights = {
        overallSkillGaps:       arr(parsed.overallSkillGaps),
        marketRecommendations:  arr(parsed.marketRecommendations),
        pipelineHealth:         parsed.pipelineHealth       || '',
        topStrengthsAcrossPool: arr(parsed.topStrengthsAcrossPool),
        criticalMissingSkills:  arr(parsed.criticalMissingSkills),
        hiringRecommendation:   parsed.hiringRecommendation || '',
      };
      console.log('  ✅ Insights ready');
    }
  } catch (err: any) {
    console.warn(`⚠️  Insights failed (non-fatal): ${err?.message?.substring(0,80)}`);
  }

  const scores = allCandidates.map(c => c.matchScore);
  return {
    shortlist: shortlisted, allCandidates: finalAll, insights,
    totalEvaluated: allCandidates.length,
    averageScore:   scores.length ? Math.round(scores.reduce((a,b)=>a+b,0)/scores.length) : 0,
    topScore:       scores.length ? Math.max(...scores) : 0,
  };
}

const clamp = (v: any) => Math.min(100, Math.max(0, Math.round(Number(v)||0)));
const arr   = (v: any) => Array.isArray(v) ? v : [];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function defaultInsights(job: IJob): ScreeningInsights {
  return {
    overallSkillGaps: [], criticalMissingSkills: [], topStrengthsAcrossPool: [],
    marketRecommendations:  [`Source candidates with: ${job.requiredSkills.slice(0,3).join(', ')}`],
    pipelineHealth:         'Screening completed. Review shortlisted candidates.',
    hiringRecommendation:   'Review shortlisted candidates and proceed with interviews.',
  };
}
