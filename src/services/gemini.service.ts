import { GoogleGenerativeAI } from '@google/generative-ai';
import { IApplicant } from '../models/Applicant.model';
import { IJob } from '../models/Job.model';

// ─── Startup check — fail fast if key missing ─────────────────────────────────
if (!process.env.GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY is not set in environment variables!');
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

export interface SkillGap {
  skill: string;
  coverage: number;
  severity: 'critical' | 'moderate' | 'minor';
  recommendation: string;
}

export interface CandidateResult {
  applicantId: string;
  firstName: string;
  lastName: string;
  email: string;
  headline: string;
  location: string;
  availability: { status: string; type: string };
  matchScore: number;
  scoreBreakdown: {
    skillsMatch: number;
    experienceMatch: number;
    educationMatch: number;
    projectRelevance: number;
    availabilityBonus: number;
  };
  strengths: string[];
  gaps: string[];
  recommendation: string;
  skillScores: { name: string; score: number }[];
  shortlistedReason: string;
  isShortlisted: boolean;
  skillGaps: string[];
  growthAreas: string[];
  courseRecommendations: string[];
}

export interface ScreeningWeights {
  skillsMatch: number;
  experienceMatch: number;
  educationMatch: number;
  projectRelevance: number;
  availabilityBonus: number;
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
  skillsMatch: 40,
  experienceMatch: 30,
  educationMatch: 15,
  projectRelevance: 10,
  availabilityBonus: 5,
};

// ─── Quick API key test — call this from a test route ─────────────────────────
export async function testGeminiConnection(): Promise<{ ok: boolean; model: string; error?: string }> {
  const modelsToTry = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro'];
  for (const modelName of modelsToTry) {
    try {
      const model  = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent('Reply with exactly: {"status":"ok"}');
      const text   = result.response.text();
      console.log(`✅ Gemini connected — model: ${modelName}, response: ${text.substring(0, 80)}`);
      return { ok: true, model: modelName };
    } catch (err: any) {
      console.warn(`⚠️  Model ${modelName} failed: ${err?.message}`);
    }
  }
  return { ok: false, model: '', error: 'All models failed — check GEMINI_API_KEY and quota' };
}

// ─── Robust JSON extractor ────────────────────────────────────────────────────
function extractJSON(raw: string): any {
  let text = raw.trim();

  // Strip ALL markdown fences
  text = text.replace(/```[\w]*\n?/gi, '').replace(/```/g, '').trim();

  // Strategy 1: direct parse
  try { return JSON.parse(text); } catch { /* continue */ }

  // Strategy 2: find outermost { ... }
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    const slice = text.substring(start, end + 1);
    try { return JSON.parse(slice); } catch { /* continue */ }

    // Strategy 3: walk backwards — handle truncated JSON
    for (let i = slice.length - 1; i > 0; i--) {
      if (slice[i] === '}') {
        try { return JSON.parse(slice.substring(0, i + 1)); } catch { /* keep shrinking */ }
      }
    }
  }

  throw new Error(`JSON extraction failed. Raw preview: ${text.substring(0, 300)}`);
}

// ─── Re-map applicant IDs from source (never trust AI with IDs) ───────────────
function remapApplicantIds(aiCandidates: any[], batch: IApplicant[]): any[] {
  const byId    = new Map<string, string>();
  const byEmail = new Map<string, string>();
  const byName  = new Map<string, string>();

  for (const a of batch) {
    const id = (a._id as any).toString();
    byId.set(id, id);
    if (a.talentProfile.email)
      byEmail.set(a.talentProfile.email.toLowerCase().trim(), id);
    const key = `${a.talentProfile.firstName.toLowerCase().trim()}|${a.talentProfile.lastName.toLowerCase().trim()}`;
    byName.set(key, id);
  }

  return aiCandidates.map(c => {
    const aiId = String(c.applicantId || '');
    if (byId.has(aiId)) return c;

    const emailKey = (c.email || '').toLowerCase().trim();
    if (emailKey && byEmail.has(emailKey))
      return { ...c, applicantId: byEmail.get(emailKey) };

    const nameKey = `${(c.firstName || '').toLowerCase().trim()}|${(c.lastName || '').toLowerCase().trim()}`;
    if (byName.has(nameKey))
      return { ...c, applicantId: byName.get(nameKey) };

    // partial first name match
    for (const [key, realId] of byName.entries()) {
      const fn = key.split('|')[0];
      if (fn && (c.firstName || '').toLowerCase().includes(fn))
        return { ...c, applicantId: realId };
    }

    console.warn(`  ⚠️  Could not remap ID for "${c.firstName} ${c.lastName}"`);
    return c;
  });
}

// ─── Profile serialiser (compact to save tokens) ──────────────────────────────
function profileText(a: IApplicant, idx: number): string {
  const p = a.talentProfile;

  const totalExp = p.experience.reduce((acc, e) => {
    try {
      const s = new Date(`${e.startDate}-01`);
      const en = e.isCurrent ? new Date() : new Date(`${e.endDate}-01`);
      return acc + Math.max(0, (en.getTime() - s.getTime()) / (1000 * 60 * 60 * 24 * 365));
    } catch { return acc; }
  }, 0);

  const skills = p.skills.map(s => `${s.name}(${s.level},${s.yearsOfExperience}yr)`).join(', ') || 'None';

  const exp = p.experience.slice(0, 3).map(e =>
    `${e.role}@${e.company}(${e.startDate}-${e.isCurrent ? 'now' : e.endDate}): ${(e.technologies || []).join(',')}. ${(e.description || '').substring(0, 120)}`
  ).join(' | ');

  const edu = p.education.map(e =>
    `${e.degree} ${e.fieldOfStudy} @ ${e.institution}(${e.endYear})`
  ).join(', ');

  const proj = (p.projects || []).slice(0, 2).map(pr =>
    `${pr.name}[${(pr.technologies || []).join(',')}]`
  ).join(', ');

  const certs = (p.certifications || []).slice(0, 3).map(c => c.name).join(', ') || 'None';

  return `--- CANDIDATE_${idx} ---
ID: ${(a._id as any).toString()}
NAME: ${p.firstName} ${p.lastName}
EMAIL: ${p.email}
LOCATION: ${p.location}
HEADLINE: ${p.headline || '—'}
TOTAL_EXP: ${totalExp.toFixed(1)}yr
SKILLS: ${skills}
EXPERIENCE: ${exp || 'None'}
EDUCATION: ${edu || 'None'}
PROJECTS: ${proj || 'None'}
CERTS: ${certs}
AVAILABILITY: ${p.availability?.status || '—'}`;
}

// ─── Prompt builder ────────────────────────────────────────────────────────────
function buildPrompt(
  job: IJob,
  batch: IApplicant[],
  weights: ScreeningWeights,
  batchIndex: number,
  totalBatches: number
): string {
  const profiles  = batch.map((a, i) => profileText(a, batchIndex * batch.length + i + 1)).join('\n\n');
  const weightSum = Object.values(weights).reduce((a, b) => a + b, 0);

  return `You are a talent screening system. Evaluate candidates for this job and return JSON only.

JOB: ${job.title} | ${job.department} | ${job.location} | Min ${job.minimumExperienceYears}yr exp
REQUIRED SKILLS: ${job.requiredSkills.join(', ')}
NICE TO HAVE: ${(job.niceToHaveSkills || []).join(', ')}
DESCRIPTION: ${job.description.substring(0, 400)}
${job.screeningNotes ? `HR NOTES: ${job.screeningNotes}` : ''}

WEIGHTS: skillsMatch=${weights.skillsMatch} experienceMatch=${weights.experienceMatch} educationMatch=${weights.educationMatch} projectRelevance=${weights.projectRelevance} availabilityBonus=${weights.availabilityBonus} (total=${weightSum})

matchScore = (skillsMatch*${weights.skillsMatch} + experienceMatch*${weights.experienceMatch} + educationMatch*${weights.educationMatch} + projectRelevance*${weights.projectRelevance} + availabilityBonus*${weights.availabilityBonus}) / ${weightSum}

${totalBatches > 1 ? `BATCH ${batchIndex + 1}/${totalBatches}` : ''}

CANDIDATES:
${profiles}

INSTRUCTIONS:
- Evaluate ALL ${batch.length} candidates above
- Copy the ID field exactly into applicantId
- Return ONLY valid JSON, no markdown, no explanation

REQUIRED JSON:
{
  "candidates": [
    {
      "applicantId": "<copy ID from above exactly>",
      "firstName": "",
      "lastName": "",
      "email": "",
      "headline": "",
      "location": "",
      "availability": {"status": "", "type": ""},
      "matchScore": 0,
      "scoreBreakdown": {"skillsMatch":0,"experienceMatch":0,"educationMatch":0,"projectRelevance":0,"availabilityBonus":0},
      "strengths": ["strength1","strength2","strength3"],
      "gaps": ["gap1","gap2"],
      "shortlistedReason": "why selected or not in 2 sentences",
      "skillGaps": ["missing1"],
      "growthAreas": ["area1"],
      "courseRecommendations": ["course1"],
      "recommendation": "final recommendation",
      "skillScores": [{"name":"skill","score":0}]
    }
  ],
  "poolInsights": {
    "overallSkillGaps": [{"skill":"","coverage":0,"severity":"moderate","recommendation":""}],
    "marketRecommendations": ["rec1"],
    "pipelineHealth": "summary",
    "topStrengthsAcrossPool": ["strength1"],
    "criticalMissingSkills": ["skill1"],
    "hiringRecommendation": "overall recommendation"
  }
}`;
}

// ─── Main screening function ───────────────────────────────────────────────────
export async function runAIScreening(
  job: IJob,
  applicants: IApplicant[],
  weights: ScreeningWeights = DEFAULT_WEIGHTS,
  shortlistSize: number = 10,
  modelName: string = 'gemini-1.5-flash'   // flash = faster, cheaper, more available
): Promise<{
  shortlist: CandidateResult[];
  allCandidates: CandidateResult[];
  insights: ScreeningInsights;
  totalEvaluated: number;
  averageScore: number;
  topScore: number;
}> {
  // Check API key
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY environment variable is not set on the server.');
  }

  const BATCH_SIZE   = 10;  // Reduced from 15 to avoid token limit issues
  const totalBatches = Math.ceil(applicants.length / BATCH_SIZE);

  // Try flash first, fall back to pro if it fails
  const modelsToTry = [
    modelName,
    'gemini-1.5-flash',
    'gemini-1.5-pro',
    'gemini-pro',
  ].filter((v, i, a) => a.indexOf(v) === i); // deduplicate

  let allCandidates: CandidateResult[] = [];
  const allInsights: ScreeningInsights[] = [];
  let failedBatches = 0;
  let workingModel = '';

  for (let i = 0; i < applicants.length; i += BATCH_SIZE) {
    const batch      = applicants.slice(i, i + BATCH_SIZE);
    const batchIndex = Math.floor(i / BATCH_SIZE);
    const batchNum   = batchIndex + 1;

    console.log(`\n📦 Batch ${batchNum}/${totalBatches} — ${batch.length} candidates`);

    const prompt     = buildPrompt(job, batch, weights, batchIndex, totalBatches);
    let batchSuccess = false;
    let lastErr      = '';

    // Try each model + 3 attempts per model
    outer: for (const tryModel of modelsToTry) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          console.log(`  🤖 Model: ${tryModel} | Attempt: ${attempt}/3`);

          const model  = genAI.getGenerativeModel({
            model: tryModel,
            generationConfig: {
              temperature: 0.1,
              topP: 0.8,
              maxOutputTokens: 8192,
            },
          });

          const result = await model.generateContent(prompt);
          const resp   = result.response;

          // Check for safety blocks or empty response
          const finishReason = resp.candidates?.[0]?.finishReason;
          if (finishReason === 'SAFETY') {
            throw new Error(`Response blocked by safety filter (finishReason: SAFETY)`);
          }
          if (finishReason === 'MAX_TOKENS') {
            console.warn(`  ⚠️  Response truncated (MAX_TOKENS) — will attempt JSON extraction anyway`);
          }

          const rawText = resp.text();
          console.log(`  📄 Response: ${rawText.length} chars | finishReason: ${finishReason || 'STOP'}`);

          if (!rawText || rawText.length < 50) {
            throw new Error(`Empty or very short response (${rawText?.length ?? 0} chars)`);
          }

          // Extract + validate JSON
          const parsed = extractJSON(rawText);

          if (!parsed.candidates || !Array.isArray(parsed.candidates) || parsed.candidates.length === 0) {
            console.warn(`  ⚠️  Keys in response: ${Object.keys(parsed).join(', ')}`);
            throw new Error(`Response has no "candidates" array or it is empty`);
          }

          console.log(`  ✅ Got ${parsed.candidates.length} candidates from ${tryModel}`);
          workingModel = tryModel;

          // Re-map IDs, validate scores
          const remapped  = remapApplicantIds(parsed.candidates, batch);
          const validated = remapped.map((c: any) => ({
            ...c,
            matchScore: Math.min(100, Math.max(0, Math.round(Number(c.matchScore) || 0))),
            scoreBreakdown: {
              skillsMatch:       Math.min(100, Math.max(0, Math.round(Number(c.scoreBreakdown?.skillsMatch)       || 0))),
              experienceMatch:   Math.min(100, Math.max(0, Math.round(Number(c.scoreBreakdown?.experienceMatch)   || 0))),
              educationMatch:    Math.min(100, Math.max(0, Math.round(Number(c.scoreBreakdown?.educationMatch)    || 0))),
              projectRelevance:  Math.min(100, Math.max(0, Math.round(Number(c.scoreBreakdown?.projectRelevance)  || 0))),
              availabilityBonus: Math.min(100, Math.max(0, Math.round(Number(c.scoreBreakdown?.availabilityBonus) || 0))),
            },
            strengths:             Array.isArray(c.strengths)             ? c.strengths             : [],
            gaps:                  Array.isArray(c.gaps)                  ? c.gaps                  : [],
            skillGaps:             Array.isArray(c.skillGaps)             ? c.skillGaps             : [],
            growthAreas:           Array.isArray(c.growthAreas)           ? c.growthAreas           : [],
            courseRecommendations: Array.isArray(c.courseRecommendations) ? c.courseRecommendations : [],
            skillScores:           Array.isArray(c.skillScores)           ? c.skillScores           : [],
            shortlistedReason:     c.shortlistedReason    || '',
            recommendation:        c.recommendation       || '',
          }));

          allCandidates = [...allCandidates, ...validated];
          if (parsed.poolInsights) allInsights.push(parsed.poolInsights);

          batchSuccess = true;
          break outer; // ← exit both loops on success

        } catch (err: any) {
          // Log the FULL error — not just message
          lastErr = err?.message || String(err);
          const statusCode = err?.status || err?.response?.status || err?.code || 'unknown';
          console.error(`  ❌ ${tryModel} attempt ${attempt} failed:`, {
            message:    lastErr,
            statusCode,
            errorType:  err?.constructor?.name,
            details:    err?.errorDetails || err?.response?.data || '',
          });

          // Don't retry on auth errors — the key is wrong
          if (statusCode === 400 || statusCode === 401 || statusCode === 403) {
            throw new Error(`Gemini API authentication failed (${statusCode}): ${lastErr}. Check GEMINI_API_KEY.`);
          }

          if (attempt < 3) {
            const delay = 2000 * attempt;
            console.log(`  ⏳ Retrying in ${delay}ms…`);
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }
    }

    if (!batchSuccess) {
      failedBatches++;
      console.error(`❌ Batch ${batchNum} failed on all models. Last error: ${lastErr}`);
    }
  }

  // Throw if nothing came back
  if (allCandidates.length === 0) {
    throw new Error(
      `AI screening produced no results after trying all models. ` +
      `Last error: ${allInsights.length === 0 ? 'All batches failed' : 'Unknown'}. ` +
      `Check: 1) GEMINI_API_KEY is set on Render env vars 2) API quota not exceeded 3) Model availability. ` +
      `Tip: go to Render → Environment and confirm GEMINI_API_KEY is present.`
    );
  }

  if (failedBatches > 0) {
    console.warn(`⚠️  ${failedBatches}/${totalBatches} batches failed — partial results: ${allCandidates.length}/${applicants.length} evaluated`);
  }

  // Sort → shortlist
  allCandidates.sort((a, b) => b.matchScore - a.matchScore);

  const actualSize     = Math.min(shortlistSize, allCandidates.length);
  const shortlisted    = allCandidates.slice(0, actualSize).map((c, idx) => ({ ...c, rank: idx + 1, isShortlisted: true }));
  const notShortlisted = allCandidates.slice(actualSize).map(c => ({ ...c, isShortlisted: false }));
  const finalAll       = [...shortlisted, ...notShortlisted];

  const scores   = allCandidates.map(c => c.matchScore);
  const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  const topScore = scores.length ? Math.max(...scores) : 0;

  console.log(`\n🏆 Done — ${shortlisted.length} shortlisted from ${allCandidates.length} evaluated | model: ${workingModel} | avg: ${avgScore} | top: ${topScore}`);

  return {
    shortlist:      shortlisted,
    allCandidates:  finalAll,
    insights:       mergeInsights(allInsights, job),
    totalEvaluated: allCandidates.length,
    averageScore:   avgScore,
    topScore,
  };
}

// ─── Merge insights ────────────────────────────────────────────────────────────
function mergeInsights(insights: ScreeningInsights[], job: IJob): ScreeningInsights {
  if (!insights.length) return {
    overallSkillGaps:       [],
    marketRecommendations:  [`Source candidates with: ${job.requiredSkills.slice(0, 3).join(', ')}`],
    pipelineHealth:         'Insufficient data.',
    topStrengthsAcrossPool: [],
    criticalMissingSkills:  job.requiredSkills.slice(0, 3),
    hiringRecommendation:   'Add more applicants and re-run screening.',
  };

  const gapMap = new Map<string, { total: number; count: number; severity: string; recommendation: string }>();
  for (const ins of insights) {
    for (const g of (ins.overallSkillGaps || [])) {
      const ex = gapMap.get(g.skill);
      if (ex) { ex.total += g.coverage; ex.count++; }
      else gapMap.set(g.skill, { total: g.coverage, count: 1, severity: g.severity, recommendation: g.recommendation });
    }
  }

  const uniq = (arrs: string[][]) => [...new Set(arrs.flat())];
  return {
    overallSkillGaps:       Array.from(gapMap.entries()).map(([skill, d]) => ({ skill, coverage: Math.round(d.total / d.count), severity: d.severity as any, recommendation: d.recommendation })).sort((a, b) => a.coverage - b.coverage),
    marketRecommendations:  uniq(insights.map(i => i.marketRecommendations || [])).slice(0, 4),
    pipelineHealth:         insights[insights.length - 1]?.pipelineHealth || 'Good pool.',
    topStrengthsAcrossPool: uniq(insights.map(i => i.topStrengthsAcrossPool || [])).slice(0, 5),
    criticalMissingSkills:  uniq(insights.map(i => i.criticalMissingSkills || [])).slice(0, 5),
    hiringRecommendation:   insights[insights.length - 1]?.hiringRecommendation || 'Proceed with shortlisted candidates.',
  };
}
