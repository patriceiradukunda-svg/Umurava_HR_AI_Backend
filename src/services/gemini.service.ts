import { IApplicant } from '../models/Applicant.model';
import { IJob } from '../models/Job.model';

// ─── Provider config ─────────────────────────────────────────────────────────
// Primary: Groq (free, 14,400 req/day, no credit card)
// Fallback: Gemini (if Groq fails)
const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const GEMINI_V1    = 'https://generativelanguage.googleapis.com/v1/models';
const GEMINI_V1BETA = 'https://generativelanguage.googleapis.com/v1beta/models';

const GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'gemma2-9b-it',
];
// Models with their correct API endpoint
// gemini-2.0 → v1 endpoint | gemini-1.5 → v1beta endpoint
const GEMINI_MODELS: { name: string; base: string }[] = [
  { name: 'gemini-2.0-flash',      base: GEMINI_V1    },
  { name: 'gemini-2.0-flash-lite', base: GEMINI_V1    },
  { name: 'gemini-1.5-flash',      base: GEMINI_V1BETA }, // free: 15 RPM, no billing needed
  { name: 'gemini-1.5-pro',        base: GEMINI_V1BETA }, // free: 2 RPM
  { name: 'gemini-1.5-flash-8b',   base: GEMINI_V1BETA }, // free: 15 RPM, highest quota
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

// ─── Groq call (OpenAI-compatible, forces JSON output) ───────────────────────
async function callGroq(prompt: string, modelName: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const res = await fetch(GROQ_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model:           modelName,
      messages:        [{ role: 'user', content: prompt }],
      temperature:     0.1,
      max_tokens:      8000,
      response_format: { type: 'json_object' }, // forces valid JSON output
    }),
  });

  const data: any = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || JSON.stringify(data);
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }

  const text = data?.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('Empty response from Groq');
  return text;
}

// ─── Gemini call (REST, fallback) ────────────────────────────────────────────
async function callGemini(prompt: string, modelName: string, baseUrl: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const res = await fetch(
    `${baseUrl}/${modelName}:generateContent?key=${apiKey}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents:         [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
      }),
    }
  );

  const data: any = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || JSON.stringify(data);
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) throw new Error('Empty response from Gemini');
  return text;
}

// ─── Try all providers ────────────────────────────────────────────────────────
async function callAI(prompt: string, label: string): Promise<any> {
  const hasGroq   = !!process.env.GROQ_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;

  if (!hasGroq && !hasGemini) {
    throw new Error('No API key found. Set GROQ_API_KEY or GEMINI_API_KEY on Render.');
  }

  // Try Groq first (more reliable free tier)
  if (hasGroq) {
    for (const model of GROQ_MODELS) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          console.log(`  🤖 [GROQ] ${label} | ${model} | attempt ${attempt}`);
          const text   = await callGroq(prompt, model);
          const parsed = extractJSON(text);
          console.log(`  ✅ [GROQ] Success with ${model}`);
          return parsed;
        } catch (err: any) {
          const msg  = err?.message || String(err);
          const code = msg.match(/HTTP (\d+)/)?.[1];
          console.error(`  ❌ [GROQ] ${model} attempt ${attempt}: ${msg.substring(0, 100)}`);
          if (code === '401' || code === '403') break; // bad key — skip Groq entirely
          if (code === '429') {
            if (attempt < 2) { await sleep(60000); continue; }
            break; // quota — try next model
          }
          if (attempt < 2) await sleep(3000);
        }
      }
    }
  }

  // Fallback: Gemini
  if (hasGemini) {
    for (const model of GEMINI_MODELS) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          console.log(`  🤖 [GEMINI] ${label} | ${model} | attempt ${attempt}`);
          const text   = await callGemini(prompt, model);
          const parsed = extractJSON(text);
          console.log(`  ✅ [GEMINI] Success with ${model}`);
          return parsed;
        } catch (err: any) {
          const msg  = err?.message || String(err);
          const code = msg.match(/HTTP (\d+)/)?.[1];
          console.error(`  ❌ [GEMINI] ${model} attempt ${attempt}: ${msg.substring(0, 100)}`);
          if (code === '401' || code === '403') break;
          if (code === '429') {
            if (attempt < 2) { await sleep(65000); continue; }
            break;
          }
          if (code === '404') break; // model not found — try next
          if (attempt < 2) await sleep(3000);
        }
      }
    }
  }

  throw new Error(
    `All AI providers failed for "${label}". ` +
    `Set GROQ_API_KEY from console.groq.com (free, no credit card).`
  );
}

// ─── Test connection ─────────────────────────────────────────────────────────
export async function testGeminiConnection(): Promise<{ ok: boolean; model: string; error?: string }> {
  if (process.env.GROQ_API_KEY) {
    for (const m of GROQ_MODELS) {
      try {
        await callGroq('{"test":"ok"}', m);
        return { ok: true, model: `groq/${m}` };
      } catch { /* try next */ }
    }
  }
  if (process.env.GEMINI_API_KEY) {
    for (const m of GEMINI_MODELS) {
      try {
        await callGemini('Reply with exactly: {"status":"ok"}', m.name, m.base);
        return { ok: true, model: `gemini/${m.name}` };
      } catch { /* try next */ }
    }
  }
  return { ok: false, model: '', error: 'All providers failed. Check API keys on Render.' };
}

// ─── JSON extractor ──────────────────────────────────────────────────────────
function extractJSON(raw: string): any {
  // Groq with response_format:json_object returns clean JSON — try direct parse first
  try { return JSON.parse(raw.trim()); } catch { /* continue */ }
  const text = raw.trim().replace(/```[\w]*\n?/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(text); } catch { /* continue */ }
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s !== -1 && e > s) {
    try { return JSON.parse(text.substring(s, e + 1)); } catch { /* continue */ }
    for (let i = e; i > s; i--)
      if (text[i] === '}') { try { return JSON.parse(text.substring(s, i + 1)); } catch { /* shrink */ } }
  }
  throw new Error(`JSON parse failed. Preview: "${raw.substring(0, 200)}"`);
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
    const nk = `${(c.firstName||'').toLowerCase()}|${(c.lastName||'').toLowerCase()}`;
    if (byName.has(nk)) return { ...c, applicantId: byName.get(nk) };
    console.warn(`  ⚠️  Could not remap ID for ${c.firstName} ${c.lastName}`);
    return c;
  });
}

// ─── Profile text ────────────────────────────────────────────────────────────
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
  return `--- CANDIDATE_${idx} id:${(a._id as any).toString()} ---
Name:${p.firstName} ${p.lastName} | Email:${p.email} | Location:${p.location}
TotalExp:${totalExp.toFixed(1)}yr | Skills:${skills}
Work:${exp||'none'}
Edu:${edu||'none'} | Certs:${certs}
Projects:${projs||'none'} | Availability:${p.availability?.status||'unknown'}`;
}

// ─── Prompts ─────────────────────────────────────────────────────────────────
function candidatesPrompt(job: IJob, batch: IApplicant[], w: ScreeningWeights): string {
  const ws       = Object.values(w).reduce((a, b) => a + b, 0);
  const profiles = batch.map((a, i) => profileText(a, i + 1)).join('\n\n');
  return `Evaluate these ${batch.length} job candidates and return a JSON object.

JOB: ${job.title} | ${job.department} | Min ${job.minimumExperienceYears}yr exp
REQUIRED SKILLS: ${job.requiredSkills.join(', ')}
DESCRIPTION: ${job.description.substring(0,300)}
${job.screeningNotes ? `HR NOTES: ${job.screeningNotes}` : ''}

matchScore = (skillsMatch×${w.skillsMatch} + experienceMatch×${w.experienceMatch} + educationMatch×${w.educationMatch} + projectRelevance×${w.projectRelevance} + availabilityBonus×${w.availabilityBonus}) / ${ws}
availabilityBonus: Immediately=100, Open=70, else=30

${profiles}

Return a JSON object with this exact structure for ALL ${batch.length} candidates:
{
  "candidates": [
    {
      "applicantId": "copy id: field exactly as shown",
      "firstName": "", "lastName": "", "email": "", "location": "", "headline": "",
      "availability": {"status":"","type":""},
      "matchScore": 0,
      "scoreBreakdown": {"skillsMatch":0,"experienceMatch":0,"educationMatch":0,"projectRelevance":0,"availabilityBonus":0},
      "strengths": ["strength 1","strength 2","strength 3"],
      "gaps": ["gap 1","gap 2"],
      "shortlistedReason": "2 sentence explanation",
      "skillGaps": ["missing skill"],
      "growthAreas": ["growth area"],
      "courseRecommendations": ["Course — why it helps"],
      "recommendation": "final hiring recommendation",
      "skillScores": [{"name":"required skill","score":0}]
    }
  ]
}`;
}

function insightsPrompt(job: IJob, candidates: any[]): string {
  const summary = candidates.slice(0,15).map(c =>
    `${c.firstName} ${c.lastName}: score=${c.matchScore}, gaps=${(c.skillGaps||[]).join(',')}`
  ).join('\n');
  return `Analyse this talent pool for the job: ${job.title}
Required skills: ${job.requiredSkills.join(', ')}

Candidate results:
${summary}

Return a JSON object:
{
  "overallSkillGaps": [{"skill":"","coverage":0,"severity":"moderate","recommendation":""}],
  "marketRecommendations": ["recommendation 1","recommendation 2"],
  "pipelineHealth": "one paragraph about pool quality",
  "topStrengthsAcrossPool": ["common strength"],
  "criticalMissingSkills": ["skill nobody has"],
  "hiringRecommendation": "overall strategic recommendation"
}`;
}

// ─── Main ────────────────────────────────────────────────────────────────────
export async function runAIScreening(
  job: IJob,
  applicants: IApplicant[],
  weights: ScreeningWeights = DEFAULT_WEIGHTS,
  shortlistSize: number = 10,
  _modelName = 'groq'
): Promise<{
  shortlist: CandidateResult[]; allCandidates: CandidateResult[];
  insights: ScreeningInsights; totalEvaluated: number;
  averageScore: number; topScore: number;
}> {
  if (!process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY) {
    throw new Error('No API key configured. Add GROQ_API_KEY from console.groq.com to Render Environment.');
  }

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
      const parsed = await callAI(candidatesPrompt(job, batch, weights), `Candidates batch ${batchNum}`);

      if (!parsed.candidates || !Array.isArray(parsed.candidates) || !parsed.candidates.length)
        throw new Error(`No candidates in response. Keys: ${Object.keys(parsed).join(', ')}`);

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

  if (allCandidates.length === 0)
    throw new Error(`All ${totalBatches} batch(es) failed. Check Render logs for details.`);

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

const clamp  = (v: any) => Math.min(100, Math.max(0, Math.round(Number(v)||0)));
const arr    = (v: any) => Array.isArray(v) ? v : [];
const sleep  = (ms: number) => new Promise(r => setTimeout(r, ms));

function defaultInsights(job: IJob): ScreeningInsights {
  return {
    overallSkillGaps: [], criticalMissingSkills: [], topStrengthsAcrossPool: [],
    marketRecommendations:  [`Source candidates with: ${job.requiredSkills.slice(0,3).join(', ')}`],
    pipelineHealth:         'Screening completed successfully.',
    hiringRecommendation:   'Review shortlisted candidates and proceed with interviews.',
  };
}
