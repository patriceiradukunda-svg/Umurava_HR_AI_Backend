import { IApplicant } from '../models/Applicant.model';
import { IJob } from '../models/Job.model';

// ─── No SDK — direct REST API call ───────────────────────────────────────────
// This bypasses @google/generative-ai entirely, so SDK version doesn't matter.
// Gemini REST API: POST /v1/models/{model}:generateContent?key={API_KEY}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1/models';
const MODEL_LIST  = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash-8b',       // highest free-tier quota limit
  'gemini-1.5-flash-8b-latest',
  'gemini-2.0-flash-exp',
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

// ─── Raw REST call to Gemini ──────────────────────────────────────────────────
async function callGeminiREST(prompt: string, modelName: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const url  = `${GEMINI_BASE}/${modelName}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature:     0.1,
      topP:            0.8,
      maxOutputTokens: 8192,
    },
  });

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  const data: any = await res.json();

  if (!res.ok) {
    const errMsg = data?.error?.message || data?.error?.status || JSON.stringify(data);
    throw new Error(`HTTP ${res.status}: ${errMsg}`);
  }

  // Check finish reason
  const candidate   = data?.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (finishReason === 'SAFETY') throw new Error('Response blocked by safety filter');

  const text = candidate?.content?.parts?.[0]?.text || '';
  if (!text) throw new Error(`Empty response. finishReason: ${finishReason}, keys: ${Object.keys(data).join(',')}`);

  return text;
}

// ─── Try each model with retries ──────────────────────────────────────────────
async function callWithFallback(prompt: string, label: string): Promise<any> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set. Add it in Render → Environment variables.');
  }

  let lastError = '';

  for (const modelName of MODEL_LIST) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`  🤖 ${label} | ${modelName} | attempt ${attempt}`);
        const rawText = await callGeminiREST(prompt, modelName);
        console.log(`  📄 ${rawText.length} chars | model: ${modelName}`);

        if (rawText.length < 20) throw new Error(`Response too short: "${rawText}"`);

        const parsed = extractJSON(rawText);
        console.log(`  ✅ ${label} succeeded with ${modelName}`);
        return parsed;

      } catch (err: any) {
        lastError = err?.message || String(err);
        console.error(`  ❌ ${modelName} attempt ${attempt}: ${lastError.substring(0, 150)}`);

        // Auth/billing errors — stop immediately
        if (lastError.includes('API_KEY_INVALID') ||
            lastError.includes('HTTP 400') ||
            lastError.includes('HTTP 401') ||
            lastError.includes('HTTP 403')) {
          throw new Error(
            `Gemini API key error. Error: ${lastError}. ` +
            `Get a new key at aistudio.google.com/app/apikey`
          );
        }

        // 429 = rate limited — wait 65 seconds then retry once
        if (lastError.includes('HTTP 429') || lastError.includes('quota')) {
          if (attempt < 2) {
            console.log(`  ⏳ Rate limited (429) — waiting 65s for quota reset…`);
            await new Promise(r => setTimeout(r, 65000));
          } else {
            console.log(`  ⏱️  429 on attempt 2 — skipping to next model`);
          }
          continue;
        }

        // 404 = model not found on this API version — skip immediately
        if (lastError.includes('HTTP 404') || lastError.includes('not found')) {
          break; // next model
        }

        if (attempt < 2) {
          console.log(`  ⏳ Waiting 5s before retry…`);
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }
    // 404 = model not available in this region/plan → try next model
  }

  throw new Error(
    `All models failed for "${label}". Last error: ${lastError}. ` +
    `Check Render logs for per-model errors above.`
  );
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
    byName.set(
      `${a.talentProfile.firstName.toLowerCase()}|${a.talentProfile.lastName.toLowerCase()}`,
      id
    );
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
    `${e.role}@${e.company}(${e.startDate}-${e.isCurrent?'now':e.endDate})[${(e.technologies||[]).join(',')}]: ${(e.description||'').substring(0,100)}`
  ).join(' | ');
  const edu    = p.education.map(e => `${e.degree} ${e.fieldOfStudy}@${e.institution}(${e.endYear})`).join(', ');
  const certs  = (p.certifications||[]).map(c => c.name).join(', ') || 'none';
  const projs  = (p.projects||[]).slice(0,2).map(pr => `${pr.name}[${(pr.technologies||[]).join(',')}]`).join(', ');
  return `--- CANDIDATE_${idx} id:${(a._id as any).toString()} ---
Name:${p.firstName} ${p.lastName} | Email:${p.email} | Location:${p.location}
TotalExp:${totalExp.toFixed(1)}yr | Skills:${skills}
Work:${exp||'none'}
Edu:${edu||'none'} | Certs:${certs}
Projects:${projs||'none'} | Availability:${p.availability?.status||'unknown'}`;
}

// ─── Prompts ──────────────────────────────────────────────────────────────────
function candidatesPrompt(job: IJob, batch: IApplicant[], w: ScreeningWeights): string {
  const ws       = Object.values(w).reduce((a, b) => a + b, 0);
  const profiles = batch.map((a, i) => profileText(a, i + 1)).join('\n\n');
  return `Evaluate these ${batch.length} candidates for this job. Return ONLY valid JSON.

JOB: ${job.title} | ${job.department} | Min ${job.minimumExperienceYears}yr exp
REQUIRED SKILLS: ${job.requiredSkills.join(', ')}
DESCRIPTION: ${job.description.substring(0,300)}
${job.screeningNotes ? `HR NOTES: ${job.screeningNotes}` : ''}

matchScore = (skillsMatch×${w.skillsMatch} + experienceMatch×${w.experienceMatch} + educationMatch×${w.educationMatch} + projectRelevance×${w.projectRelevance} + availabilityBonus×${w.availabilityBonus}) / ${ws}

${profiles}

Return JSON for ALL ${batch.length} candidates (no markdown, no explanation):
{"candidates":[{"applicantId":"copy id: field exactly","firstName":"","lastName":"","email":"","location":"","headline":"","availability":{"status":"","type":""},"matchScore":0,"scoreBreakdown":{"skillsMatch":0,"experienceMatch":0,"educationMatch":0,"projectRelevance":0,"availabilityBonus":0},"strengths":["s1","s2","s3"],"gaps":["g1","g2"],"shortlistedReason":"2 sentence reason","skillGaps":["sk1"],"growthAreas":["a1"],"courseRecommendations":["c1"],"recommendation":"final recommendation","skillScores":[{"name":"skill","score":0}]}]}`;
}

function insightsPrompt(job: IJob, candidates: any[]): string {
  const summary = candidates.slice(0,20).map(c =>
    `${c.firstName} ${c.lastName}: score=${c.matchScore}, gaps=${(c.skillGaps||[]).join(',')}`
  ).join('\n');
  return `Analyse this talent pool for: ${job.title}
Required: ${job.requiredSkills.join(', ')}
Results:\n${summary}

Return ONLY JSON (no markdown):
{"overallSkillGaps":[{"skill":"","coverage":0,"severity":"moderate","recommendation":""}],"marketRecommendations":["rec1","rec2"],"pipelineHealth":"summary paragraph","topStrengthsAcrossPool":["str1"],"criticalMissingSkills":["sk1"],"hiringRecommendation":"overall recommendation"}`;
}

// ─── Test connection ──────────────────────────────────────────────────────────
export async function testGeminiConnection(): Promise<{ ok: boolean; model: string; error?: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, model: '', error: 'GEMINI_API_KEY not set' };

  for (const m of MODEL_LIST) {
    try {
      const text = await callGeminiREST('Reply with exactly: {"status":"ok"}', m);
      console.log(`✅ Gemini REST OK — model: ${m}`);
      return { ok: true, model: m };
    } catch (err: any) {
      console.warn(`⚠️  ${m}: ${err?.message?.substring(0,80)}`);
    }
  }
  return { ok: false, model: '', error: 'All models failed via REST' };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export async function runAIScreening(
  job: IJob,
  applicants: IApplicant[],
  weights: ScreeningWeights = DEFAULT_WEIGHTS,
  shortlistSize: number = 10,
  _modelName = 'gemini-2.0-flash'
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
  let failedBatches        = 0;

  // CALL 1: Evaluate candidates
  for (let i = 0; i < applicants.length; i += BATCH_SIZE) {
    const batch    = applicants.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    console.log(`\n📦 Batch ${batchNum}/${totalBatches} — ${batch.length} candidates`);

    try {
      const parsed = await callWithFallback(
        candidatesPrompt(job, batch, weights),
        `Candidates batch ${batchNum}`
      );
      if (!parsed.candidates || !Array.isArray(parsed.candidates) || !parsed.candidates.length)
        throw new Error(`No candidates array. Keys: ${Object.keys(parsed).join(', ')}`);

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
      `Check Render logs above for the specific error on each model.`
    );
  }

  // Sort → shortlist
  allCandidates.sort((a, b) => b.matchScore - a.matchScore);
  const sz          = Math.min(shortlistSize, allCandidates.length);
  const shortlisted = allCandidates.slice(0, sz).map((c, i) => ({ ...c, rank: i+1, isShortlisted: true }));
  const rejected    = allCandidates.slice(sz).map(c => ({ ...c, isShortlisted: false }));
  const finalAll    = [...shortlisted, ...rejected];

  console.log(`\n🏆 ${shortlisted.length} shortlisted from ${allCandidates.length}`);

  // CALL 2: Insights (non-fatal)
  let insights: ScreeningInsights = defaultInsights(job);
  try {
    console.log('\n🔍 Generating pool insights…');
    const parsed = await callWithFallback(insightsPrompt(job, allCandidates), 'Pool insights');
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

  const scores   = allCandidates.map(c => c.matchScore);
  const avg      = scores.length ? Math.round(scores.reduce((a,b)=>a+b,0)/scores.length) : 0;
  const top      = scores.length ? Math.max(...scores) : 0;

  return {
    shortlist: shortlisted, allCandidates: finalAll, insights,
    totalEvaluated: allCandidates.length, averageScore: avg, topScore: top,
  };
}

const clamp = (v: any) => Math.min(100, Math.max(0, Math.round(Number(v)||0)));
const arr   = (v: any) => Array.isArray(v) ? v : [];

function defaultInsights(job: IJob): ScreeningInsights {
  return {
    overallSkillGaps: [], criticalMissingSkills: [],
    topStrengthsAcrossPool: [],
    marketRecommendations:  [`Source candidates with: ${job.requiredSkills.slice(0,3).join(', ')}`],
    pipelineHealth:         'Screening completed. Review shortlisted candidates.',
    hiringRecommendation:   'Review shortlisted candidates and proceed with interviews.',
  };
}
