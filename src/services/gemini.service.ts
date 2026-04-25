import { GoogleGenerativeAI } from '@google/generative-ai';
import { IApplicant } from '../models/Applicant.model';
import { IJob } from '../models/Job.model';

if (!process.env.GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY is not set!');
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// gemini-3-flash-preview was your original working model — keep it first
const MODELS = [
  'gemini-3-flash-preview',
  'gemini-2.5-flash-preview-04-17',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
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

// ─── Call AI — NO pre-ping, go straight to real call ─────────────────────────
async function callAI(prompt: string, label: string): Promise<any> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not set on Render.');
  }

  let lastError = '';

  for (const modelName of MODELS) {
    try {
      console.log(`  🤖 ${label} | ${modelName}`);

      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          responseMimeType: 'application/json', // forces clean JSON — no parsing errors
          temperature:      0.1,
          maxOutputTokens:  8192,
        },
      });

      const result      = await model.generateContent(prompt);
      const text        = result.response.text();
      const finishReason = result.response.candidates?.[0]?.finishReason;

      console.log(`  📄 ${text.length} chars | finish: ${finishReason || 'STOP'} | model: ${modelName}`);

      if (!text || text.length < 10) throw new Error('Empty response');

      const parsed = JSON.parse(text); // responseMimeType guarantees valid JSON
      console.log(`  ✅ Success with ${modelName}`);
      return parsed;

    } catch (err: any) {
      lastError = err?.message || String(err);
      const status = err?.status || err?.response?.status;
      console.error(`  ❌ ${modelName}: [${status || '?'}] ${lastError.substring(0, 100)}`);

      // Auth error — stop immediately
      if (status === 400 || status === 401 || status === 403 ||
          lastError.includes('API_KEY_INVALID') || lastError.includes('API key')) {
        throw new Error(`Gemini API key error: ${lastError}. Check GEMINI_API_KEY on Render.`);
      }

      // 503 = temporary server overload — wait 5s and retry same model
      if (status === 503 || lastError.includes('503')) {
        console.log(`  ⏳ 503 on ${modelName} — waiting 5s then retrying…`);
        await new Promise(r => setTimeout(r, 5000));
        try {
          console.log(`  🔄 Retrying ${modelName} after 503…`);
          const model2 = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 8192 },
          });
          const result2  = await model2.generateContent(prompt);
          const text2    = result2.response.text();
          if (text2 && text2.length > 10) {
            const parsed2 = JSON.parse(text2);
            console.log(`  ✅ Retry succeeded with ${modelName}`);
            return parsed2;
          }
        } catch { /* fall through to next model */ }
      }

      // 429 or 404 — try next model
      continue;
    }
  }

  throw new Error(
    `All Gemini models failed for "${label}". Last error: ${lastError}. ` +
    `Check that GEMINI_API_KEY is valid at aistudio.google.com/app/apikey`
  );
}

// ─── Test connection ──────────────────────────────────────────────────────────
export async function testGeminiConnection(): Promise<{ ok: boolean; model: string; error?: string }> {
  try {
    // Use the simplest possible prompt that forces JSON
    for (const modelName of MODELS) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: { responseMimeType: 'application/json' },
        });
        const result = await model.generateContent('Return {"status":"ok"}');
        result.response.text();
        return { ok: true, model: modelName };
      } catch (err: any) {
        const status = err?.status;
        if (status === 400 || status === 401 || status === 403)
          return { ok: false, model: '', error: `API key error: ${err?.message}` };
        continue;
      }
    }
    return { ok: false, model: '', error: 'All models unavailable' };
  } catch (err: any) {
    return { ok: false, model: '', error: err?.message };
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

matchScore = (skillsMatch×${w.skillsMatch} + experienceMatch×${w.experienceMatch} + educationMatch×${w.educationMatch} + projectRelevance×${w.projectRelevance} + availabilityBonus×${w.availabilityBonus}) / ${ws}
Availability: Immediately=100, Open to Opportunities=70, else=30

${profiles}

Return a JSON object for ALL ${batch.length} candidates:
{
  "candidates": [
    {
      "applicantId": "copy the id: field exactly as shown above",
      "firstName": "", "lastName": "", "email": "", "location": "", "headline": "",
      "availability": {"status":"","type":""},
      "matchScore": 0,
      "scoreBreakdown": {"skillsMatch":0,"experienceMatch":0,"educationMatch":0,"projectRelevance":0,"availabilityBonus":0},
      "strengths": ["strength 1","strength 2","strength 3"],
      "gaps": ["gap 1","gap 2"],
      "shortlistedReason": "2 sentence explanation of selection decision",
      "skillGaps": ["missing required skill"],
      "growthAreas": ["area to develop"],
      "courseRecommendations": ["Course name — gap it closes"],
      "recommendation": "final hiring recommendation",
      "skillScores": [{"name":"required skill","score":0}]
    }
  ]
}`;
}

function insightsPrompt(job: IJob, candidates: any[]): string {
  const summary = candidates.slice(0,20).map(c =>
    `${c.firstName} ${c.lastName}: score=${c.matchScore}, gaps=${(c.skillGaps||[]).join(',')}`
  ).join('\n');
  return `You are an expert HR analyst. Analyse this talent pool for the role: ${job.title}
Required skills: ${job.requiredSkills.join(', ')}

Candidate results:
${summary}

Return a JSON object:
{
  "overallSkillGaps": [{"skill":"","coverage":0,"severity":"moderate","recommendation":""}],
  "marketRecommendations": ["recommendation 1","recommendation 2"],
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
    const ek = (c.email||'').toLowerCase();
    if (ek && byEmail.has(ek)) return { ...c, applicantId: byEmail.get(ek) };
    const nk = `${(c.firstName||'').toLowerCase()}|${(c.lastName||'').toLowerCase()}`;
    if (byName.has(nk)) return { ...c, applicantId: byName.get(nk) };
    console.warn(`  ⚠️  Could not remap ID for ${c.firstName} ${c.lastName}`);
    return c;
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export async function runAIScreening(
  job: IJob,
  applicants: IApplicant[],
  weights: ScreeningWeights = DEFAULT_WEIGHTS,
  shortlistSize: number = 10,
  _modelName = 'gemini-3-flash-preview'
): Promise<{
  shortlist: CandidateResult[]; allCandidates: CandidateResult[];
  insights: ScreeningInsights; totalEvaluated: number;
  averageScore: number; topScore: number;
}> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not set. Add it in Render → Environment variables.');
  }

  const BATCH_SIZE   = 8;
  const totalBatches = Math.ceil(applicants.length / BATCH_SIZE);
  let allCandidates: any[] = [];
  let failedBatches = 0;

  for (let i = 0; i < applicants.length; i += BATCH_SIZE) {
    const batch    = applicants.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    console.log(`\n📦 Batch ${batchNum}/${totalBatches} — ${batch.length} candidates`);

    try {
      const parsed = await callAI(
        candidatesPrompt(job, batch, weights),
        `Candidates batch ${batchNum}`
      );

      // Model may return array directly OR wrapped in {candidates:[...]}
      const candidateList = Array.isArray(parsed)
        ? parsed
        : (parsed.candidates || parsed.results || parsed.data || []);

      if (!Array.isArray(candidateList) || candidateList.length === 0)
        throw new Error(`No candidates found. Keys: ${Object.keys(parsed).join(', ')}`);

      parsed.candidates = candidateList;

      console.log(`  📊 ${parsed.candidates.length} candidates in response`);

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
      const msg = err?.message || String(err);
      console.error(`❌ Batch ${batchNum} failed: ${msg}`);
      if (msg.includes('API key') || msg.includes('not set')) throw err;
    }
  }

  if (allCandidates.length === 0) {
    throw new Error(
      `Screening produced no results — all ${totalBatches} batch(es) failed. ` +
      `Check Render logs above for per-model errors.`
    );
  }

  allCandidates.sort((a, b) => b.matchScore - a.matchScore);
  const sz          = Math.min(shortlistSize, allCandidates.length);
  const shortlisted = allCandidates.slice(0, sz).map((c, i) => ({ ...c, rank: i+1, isShortlisted: true }));
  const rejected    = allCandidates.slice(sz).map(c => ({ ...c, isShortlisted: false }));
  const finalAll    = [...shortlisted, ...rejected];

  console.log(`\n🏆 ${shortlisted.length} shortlisted from ${allCandidates.length}`);
  if (failedBatches > 0) console.warn(`⚠️  ${failedBatches} batch(es) failed`);

  // Insights (non-fatal)
  let insights: ScreeningInsights = defaultInsights(job);
  try {
    console.log('\n🔍 Generating insights…');
    const parsed = await callAI(insightsPrompt(job, allCandidates), 'Pool insights');
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

function defaultInsights(job: IJob): ScreeningInsights {
  return {
    overallSkillGaps: [], criticalMissingSkills: [], topStrengthsAcrossPool: [],
    marketRecommendations:  [`Source candidates with: ${job.requiredSkills.slice(0,3).join(', ')}`],
    pipelineHealth:         'Screening completed. Review shortlisted candidates.',
    hiringRecommendation:   'Review shortlisted candidates and proceed with interviews.',
  };
}
