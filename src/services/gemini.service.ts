import { GoogleGenerativeAI } from '@google/generative-ai';
import { IApplicant } from '../models/Applicant.model';
import { IJob } from '../models/Job.model';

if (!process.env.GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY is not set in environment variables!');
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const MODEL_LIST = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-latest',
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

// ─── Test connection ─────────────────────────────────────────────────────────
export async function testGeminiConnection(): Promise<{ ok: boolean; model: string; error?: string }> {
  for (const m of MODEL_LIST) {
    try {
      const model  = genAI.getGenerativeModel({ model: m });
      const result = await model.generateContent('Reply with exactly the word: OK');
      const text   = result.response.text();
      console.log(`✅ Gemini connected — model: ${m}, response: "${text.substring(0, 40)}"`);
      return { ok: true, model: m };
    } catch (err: any) {
      const code = err?.status || err?.response?.status || '?';
      console.warn(`⚠️  ${m} failed [${code}]: ${err?.message?.substring(0, 80)}`);
      // If it's an auth error, no point trying more models
      if (code === 400 || code === 401 || code === 403) {
        return { ok: false, model: '', error: `Auth error [${code}]: ${err?.message}` };
      }
    }
  }
  return { ok: false, model: '', error: 'All models returned 404. Update @google/generative-ai to ^0.21.0 in package.json' };
}

// ─── JSON extractor ──────────────────────────────────────────────────────────
function extractJSON(raw: string): any {
  let text = raw.trim().replace(/```[\w]*\n?/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(text); } catch { /* continue */ }
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s !== -1 && e > s) {
    try { return JSON.parse(text.substring(s, e + 1)); } catch { /* continue */ }
    for (let i = e; i > s; i--)
      if (text[i] === '}') { try { return JSON.parse(text.substring(s, i + 1)); } catch { /* shrink */ } }
  }
  throw new Error(`JSON parse failed. Preview: "${text.substring(0, 200)}"`);
}

// ─── ID remapper ─────────────────────────────────────────────────────────────
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

// ─── Helper to call Gemini with retries across multiple models ───────────────
// NO pre-ping — goes straight to the real call.
async function callWithFallback(prompt: string, label: string): Promise<any> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set. Add it to Render → Environment variables.');
  }

  for (const modelName of MODEL_LIST) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`  🤖 ${label} | ${modelName} | attempt ${attempt}`);
        const model  = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: { temperature: 0.1, topP: 0.8, maxOutputTokens: 8192 },
        });
        const result      = await model.generateContent(prompt);
        const resp        = result.response;
        const finishReason = resp.candidates?.[0]?.finishReason;
        if (finishReason === 'SAFETY') throw new Error('Blocked by safety filter');
        const rawText = resp.text();
        console.log(`  📄 ${rawText.length} chars | finish: ${finishReason || 'STOP'} | model: ${modelName}`);
        if (!rawText || rawText.length < 20) throw new Error(`Response too short (${rawText?.length} chars)`);
        const parsed = extractJSON(rawText);
        console.log(`  ✅ Success with ${modelName}`);
        return parsed;
      } catch (err: any) {
        const code = err?.status || err?.response?.status;
        const msg  = err?.message || String(err);
        console.error(`  ❌ ${modelName} attempt ${attempt}: [${code || '?'}] ${msg.substring(0, 100)}`);
        // Auth errors — no point retrying
        if (code === 400 || code === 401 || code === 403) {
          throw new Error(`Gemini API key error [${code}]: ${msg}. Check GEMINI_API_KEY on Render.`);
        }
        // 404 = model not found — skip to next model immediately
        if (code === 404 || msg.includes('not found') || msg.includes('not supported')) {
          break; // try next model
        }
        // Other errors (429 rate limit, 500 server) — retry with delay
        if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  throw new Error(
    `All Gemini models failed for "${label}". ` +
    `Most likely cause: @google/generative-ai SDK is outdated. ` +
    `Fix: change "@google/generative-ai": "^0.21.0" in package.json and redeploy.`
  );
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
  const exp    = p.experience.slice(0, 2).map(e =>
    `${e.role}@${e.company}(${e.startDate}-${e.isCurrent ? 'now' : e.endDate})[${(e.technologies||[]).join(',')}]: ${(e.description||'').substring(0,100)}`
  ).join(' | ');
  const edu    = p.education.map(e => `${e.degree} ${e.fieldOfStudy}@${e.institution}(${e.endYear})`).join(', ');
  const certs  = (p.certifications||[]).map(c => c.name).join(', ') || 'none';
  const projs  = (p.projects||[]).slice(0,2).map(pr => `${pr.name}[${(pr.technologies||[]).join(',')}]`).join(', ');
  return `--- CANDIDATE_${idx} id:${(a._id as any).toString()} ---
Name:${p.firstName} ${p.lastName} | Email:${p.email} | Location:${p.location}
TotalExp:${totalExp.toFixed(1)}yr | Skills:${skills}
Work:${exp || 'none'}
Edu:${edu || 'none'} | Certs:${certs}
Projects:${projs || 'none'} | Availability:${p.availability?.status || 'unknown'}`;
}

// ─── Prompt: evaluate candidates (no insights — keeps response small) ─────────
function candidatesPrompt(job: IJob, batch: IApplicant[], weights: ScreeningWeights): string {
  const ws       = Object.values(weights).reduce((a, b) => a + b, 0);
  const profiles = batch.map((a, i) => profileText(a, i + 1)).join('\n\n');
  return `Evaluate these ${batch.length} job candidates. Return ONLY valid JSON with no markdown.

JOB: ${job.title} | ${job.department} | Min ${job.minimumExperienceYears}yr exp
REQUIRED SKILLS: ${job.requiredSkills.join(', ')}
NICE TO HAVE: ${(job.niceToHaveSkills||[]).join(', ')}
DESCRIPTION: ${job.description.substring(0, 300)}
${job.screeningNotes ? `HR NOTES: ${job.screeningNotes}` : ''}

SCORING FORMULA:
matchScore = (skillsMatch×${weights.skillsMatch} + experienceMatch×${weights.experienceMatch} + educationMatch×${weights.educationMatch} + projectRelevance×${weights.projectRelevance} + availabilityBonus×${weights.availabilityBonus}) / ${ws}
availabilityBonus: "Immediately"=100, "Open to Opportunities"=70, else 30

CANDIDATES TO EVALUATE:
${profiles}

Return this exact JSON structure for ALL ${batch.length} candidates:
{
  "candidates": [
    {
      "applicantId": "copy the id: field exactly",
      "firstName": "", "lastName": "", "email": "", "location": "", "headline": "",
      "availability": {"status":"","type":""},
      "matchScore": 0,
      "scoreBreakdown": {
        "skillsMatch":0,"experienceMatch":0,"educationMatch":0,
        "projectRelevance":0,"availabilityBonus":0
      },
      "strengths": ["specific strength 1","strength 2","strength 3"],
      "gaps": ["specific gap 1","gap 2"],
      "shortlistedReason": "2 sentence reason why selected or not",
      "skillGaps": ["missing required skill"],
      "growthAreas": ["development area"],
      "courseRecommendations": ["Course name — what gap it closes"],
      "recommendation": "Final hiring recommendation",
      "skillScores": [{"name":"required skill name","score":0}]
    }
  ]
}`;
}

// ─── Prompt: pool insights (separate small call) ──────────────────────────────
function insightsPrompt(job: IJob, candidates: any[]): string {
  const summary = candidates
    .slice(0, 20) // cap at 20 to keep prompt small
    .map(c => `${c.firstName} ${c.lastName}: score=${c.matchScore}, skillsMatch=${c.scoreBreakdown?.skillsMatch}, gaps=${(c.skillGaps||[]).join(',')}`)
    .join('\n');
  return `Analyse this talent pool for: ${job.title}
Required skills: ${job.requiredSkills.join(', ')}

Candidate results:
${summary}

Return ONLY this JSON (no markdown):
{
  "overallSkillGaps": [{"skill":"","coverage":0,"severity":"moderate","recommendation":""}],
  "marketRecommendations": ["action 1","action 2"],
  "pipelineHealth": "one paragraph describing pool quality",
  "topStrengthsAcrossPool": ["common strength 1","strength 2"],
  "criticalMissingSkills": ["skill almost nobody has"],
  "hiringRecommendation": "overall strategic recommendation for HR"
}`;
}

// ─── Main ────────────────────────────────────────────────────────────────────
export async function runAIScreening(
  job: IJob,
  applicants: IApplicant[],
  weights: ScreeningWeights = DEFAULT_WEIGHTS,
  shortlistSize: number = 10,
  _modelName: string = 'gemini-2.0-flash'
): Promise<{
  shortlist: CandidateResult[]; allCandidates: CandidateResult[];
  insights: ScreeningInsights; totalEvaluated: number;
  averageScore: number; topScore: number;
}> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set. Add it in Render → Environment variables.');
  }

  const BATCH_SIZE   = 8;
  const totalBatches = Math.ceil(applicants.length / BATCH_SIZE);
  let allCandidates: any[] = [];
  let failedBatches = 0;

  // ── CALL 1: Evaluate candidates ──────────────────────────────────────────
  for (let i = 0; i < applicants.length; i += BATCH_SIZE) {
    const batch    = applicants.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    console.log(`\n📦 Batch ${batchNum}/${totalBatches} — ${batch.length} candidates`);

    try {
      const parsed = await callWithFallback(
        candidatesPrompt(job, batch, weights),
        `Candidates batch ${batchNum}`
      );

      if (!parsed.candidates || !Array.isArray(parsed.candidates) || parsed.candidates.length === 0) {
        throw new Error(`No candidates array. Keys returned: ${Object.keys(parsed).join(', ')}`);
      }

      console.log(`  📊 ${parsed.candidates.length} candidates in response`);

      const remapped  = remapIds(parsed.candidates, batch);
      const validated = remapped.map((c: any) => ({
        ...c,
        matchScore:  clamp(c.matchScore),
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
      console.log(`  ✅ Batch ${batchNum} done — total so far: ${allCandidates.length}`);

    } catch (err: any) {
      failedBatches++;
      console.error(`❌ Batch ${batchNum} failed after all retries: ${err?.message}`);
      // Re-throw auth errors immediately — no point continuing
      if (err?.message?.includes('key error') || err?.message?.includes('not set')) throw err;
    }
  }

  if (allCandidates.length === 0) {
    throw new Error(
      `Screening produced no results — all ${totalBatches} batch(es) failed. ` +
      `IMPORTANT: Make sure @google/generative-ai is ^0.21.0 in package.json. ` +
      `Then verify GEMINI_API_KEY is set on Render (Environment tab).`
    );
  }

  // ── Sort → build shortlist ────────────────────────────────────────────────
  allCandidates.sort((a, b) => b.matchScore - a.matchScore);
  const sz          = Math.min(shortlistSize, allCandidates.length);
  const shortlisted = allCandidates.slice(0, sz).map((c, i) => ({ ...c, rank: i+1, isShortlisted: true }));
  const rejected    = allCandidates.slice(sz).map(c => ({ ...c, isShortlisted: false }));
  const finalAll    = [...shortlisted, ...rejected];

  console.log(`\n🏆 ${shortlisted.length} shortlisted from ${allCandidates.length}`);
  if (failedBatches > 0) console.warn(`⚠️  ${failedBatches} batch(es) failed — partial results`);

  // ── CALL 2: Pool insights (optional — never kills screening) ─────────────
  let insights: ScreeningInsights = defaultInsights(job);
  try {
    console.log('\n🔍 Generating pool insights…');
    const parsed = await callWithFallback(insightsPrompt(job, allCandidates), 'Pool insights');
    if (parsed.hiringRecommendation || parsed.pipelineHealth) {
      insights = {
        overallSkillGaps:       arr(parsed.overallSkillGaps),
        marketRecommendations:  arr(parsed.marketRecommendations),
        pipelineHealth:         parsed.pipelineHealth        || '',
        topStrengthsAcrossPool: arr(parsed.topStrengthsAcrossPool),
        criticalMissingSkills:  arr(parsed.criticalMissingSkills),
        hiringRecommendation:   parsed.hiringRecommendation  || '',
      };
      console.log('  ✅ Insights ready');
    }
  } catch (err: any) {
    // Non-fatal — candidates already saved
    console.warn(`⚠️  Insights failed (non-fatal): ${err?.message?.substring(0, 80)}`);
  }

  const scores   = allCandidates.map(c => c.matchScore);
  const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  const topScore = scores.length ? Math.max(...scores) : 0;

  return { shortlist: shortlisted, allCandidates: finalAll, insights, totalEvaluated: allCandidates.length, averageScore: avgScore, topScore };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const clamp = (v: any) => Math.min(100, Math.max(0, Math.round(Number(v) || 0)));
const arr   = (v: any) => Array.isArray(v) ? v : [];

function defaultInsights(job: IJob): ScreeningInsights {
  return {
    overallSkillGaps:       [],
    marketRecommendations:  [`Consider sourcing candidates with: ${job.requiredSkills.slice(0,3).join(', ')}`],
    pipelineHealth:         'Screening completed. Review shortlisted candidates for next steps.',
    topStrengthsAcrossPool: [],
    criticalMissingSkills:  [],
    hiringRecommendation:   'Review shortlisted candidates and proceed with interviews.',
  };
}
