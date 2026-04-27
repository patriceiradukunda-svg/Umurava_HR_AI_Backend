import { GoogleGenerativeAI } from '@google/generative-ai';
import { IApplicant } from '../models/Applicant.model';
import { IJob } from '../models/Job.model';

if (!process.env.GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY is not set!');
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// Use only stable, confirmed working models
const MODELS = [
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
          responseMimeType: 'application/json',
          temperature: 0.1,
          maxOutputTokens: 8192,
        },
      });

      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const finishReason = result.response.candidates?.[0]?.finishReason;

      console.log(`  📄 ${text.length} chars | finish: ${finishReason || 'STOP'} | model: ${modelName}`);

      if (!text || text.length < 10) throw new Error('Empty response');

      const parsed = JSON.parse(text);
      console.log(`  ✅ Success with ${modelName}`);
      return parsed;

    } catch (err: any) {
      lastError = err?.message || String(err);
      const status = err?.status || err?.response?.status;
      console.error(`  ❌ ${modelName}: [${status || '?'}] ${lastError.substring(0, 100)}`);

      if (status === 400 || status === 401 || status === 403 ||
          lastError.includes('API_KEY_INVALID') || lastError.includes('API key')) {
        throw new Error(`Gemini API key error: ${lastError}. Check GEMINI_API_KEY on Render.`);
      }

      if (status === 503 || lastError.includes('503')) {
        console.log(`  ⏳ 503 on ${modelName} — waiting 5s then retrying…`);
        await new Promise(r => setTimeout(r, 5000));
        try {
          console.log(`  🔄 Retrying ${modelName} after 503…`);
          const model2 = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 8192 },
          });
          const result2 = await model2.generateContent(prompt);
          const text2 = result2.response.text();
          if (text2 && text2.length > 10) {
            const parsed2 = JSON.parse(text2);
            console.log(`  ✅ Retry succeeded with ${modelName}`);
            return parsed2;
          }
        } catch { /* fall through to next model */ }
      }

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
      const s = new Date(`${e.startDate}-01`);
      const en = e.isCurrent ? new Date() : new Date(`${e.endDate}-01`);
      return acc + Math.max(0, (en.getTime() - s.getTime()) / 31536000000);
    } catch { return acc; }
  }, 0);
  const skills = p.skills.map(s => `${s.name}(${s.level},${s.yearsOfExperience}y)`).join(', ') || 'none';
  const exp = p.experience.slice(0, 2).map(e =>
    `${e.role}@${e.company}(${e.startDate}-${e.isCurrent ? 'now' : e.endDate})[${(e.technologies || []).join(',')}]: ${(e.description || '').substring(0, 100)}`
  ).join(' | ');
  const edu = p.education.map(e => `${e.degree} ${e.fieldOfStudy}@${e.institution}(${e.endYear})`).join(', ');
  const certs = (p.certifications || []).map(c => c.name).join(', ') || 'none';
  const projs = (p.projects || []).slice(0, 2).map(pr => `${pr.name}[${(pr.technologies || []).join(',')}]`).join(', ');
  return `CANDIDATE_${idx} id:${(a._id as any).toString()}
Name:${p.firstName} ${p.lastName} | Email:${p.email} | Location:${p.location}
Exp:${totalExp.toFixed(1)}yr | Skills:${skills}
Work:${exp || 'none'} | Edu:${edu || 'none'}
Certs:${certs} | Projects:${projs || 'none'} | Available:${p.availability?.status || 'unknown'}`;
}

// ─── Prompts ──────────────────────────────────────────────────────────────────
function candidatesPrompt(job: IJob, batch: IApplicant[], w: ScreeningWeights): string {
  const ws = Object.values(w).reduce((a, b) => a + b, 0);
  const profiles = batch.map((a, i) => profileText(a, i + 1)).join('\n\n');
  return `You are an expert technical recruiter. Evaluate these ${batch.length} candidates for the job below.

JOB: ${job.title} | ${job.department} | Min ${job.minimumExperienceYears}yr exp
Required Skills: ${job.requiredSkills.join(', ')}
Nice to have: ${(job.niceToHaveSkills || []).join(', ')}
Description: ${job.description.substring(0, 300)}
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

// Improved insightsPrompt with better instructions
function insightsPrompt(job: IJob, candidates: any[]): string {
  // Handle empty candidates
  if (!candidates || candidates.length === 0) {
    return `You are an expert HR analyst. No candidates available for analysis for role: ${job.title}
Return EXACTLY this JSON:
{
  "overallSkillGaps": [],
  "marketRecommendations": ["Run screenings to get AI-powered recommendations"],
  "pipelineHealth": "No candidates have been screened yet.",
  "topStrengthsAcrossPool": [],
  "criticalMissingSkills": [],
  "hiringRecommendation": "Run an AI screening first to generate recommendations."
}`;
  }

  // Build summary with safe gap handling
  const summary = candidates.slice(0, 15).map(c => {
    const gaps = (c.skillGaps || c.gaps || []);
    const gapText = gaps.length > 0 ? gaps.slice(0, 3).join(', ') : 'No specific gaps';
    const strengths = (c.strengths || []).slice(0, 2).join(', ');
    return `${c.firstName} ${c.lastName}: score=${c.matchScore}, strengths=${strengths || 'none'}, gaps=${gapText}`;
  }).join('\n');

  const requiredSkills = (job.requiredSkills || []).join(', ');
  
  return `You are an expert HR analyst. Analyze this talent pool for the role: ${job.title}

REQUIRED SKILLS: ${requiredSkills}

CANDIDATE SUMMARY:
${summary}

INSTRUCTIONS:
1. Identify which required skills are missing from most candidates
2. Calculate coverage percentage for each missing skill (how many candidates have this skill)
3. Provide actionable recommendations

Return ONLY valid JSON. No markdown, no extra text. Use this exact structure:
{
  "overallSkillGaps": [
    {"skill": "skill name", "coverage": 45, "severity": "critical", "recommendation": "specific actionable recommendation"}
  ],
  "marketRecommendations": ["recommendation 1", "recommendation 2"],
  "pipelineHealth": "one paragraph describing pool quality",
  "topStrengthsAcrossPool": ["common strength 1", "common strength 2"],
  "criticalMissingSkills": ["skill almost nobody has"],
  "hiringRecommendation": "overall strategic recommendation"
}

Severity rules: "critical" if coverage < 40%, "moderate" if 40-70%, "minor" if >70%`;
}

// ─── ID remapper ──────────────────────────────────────────────────────────────
function remapIds(aiCands: any[], batch: IApplicant[]): any[] {
  const byId = new Map<string, string>();
  const byEmail = new Map<string, string>();
  const byName = new Map<string, string>();
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
    throw new Error('GEMINI_API_KEY not set. Add it in Render → Environment variables.');
  }

  const BATCH_SIZE = 8;
  const totalBatches = Math.ceil(applicants.length / BATCH_SIZE);
  let allCandidates: any[] = [];
  let failedBatches = 0;

  for (let i = 0; i < applicants.length; i += BATCH_SIZE) {
    const batch = applicants.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    console.log(`\n📦 Batch ${batchNum}/${totalBatches} — ${batch.length} candidates`);

    try {
      const parsed = await callAI(
        candidatesPrompt(job, batch, weights),
        `Candidates batch ${batchNum}`
      );

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
          skillsMatch: clamp(c.scoreBreakdown?.skillsMatch),
          experienceMatch: clamp(c.scoreBreakdown?.experienceMatch),
          educationMatch: clamp(c.scoreBreakdown?.educationMatch),
          projectRelevance: clamp(c.scoreBreakdown?.projectRelevance),
          availabilityBonus: clamp(c.scoreBreakdown?.availabilityBonus),
        },
        strengths: arr(c.strengths),
        gaps: arr(c.gaps),
        skillGaps: arr(c.skillGaps),
        growthAreas: arr(c.growthAreas),
        courseRecommendations: arr(c.courseRecommendations),
        skillScores: arr(c.skillScores),
        shortlistedReason: c.shortlistedReason || '',
        recommendation: c.recommendation || '',
        headline: c.headline || '',
        availability: {
          status: (c.availability?.status && typeof c.availability.status === 'string' && isNaN(Number(c.availability.status)))
            ? c.availability.status
            : 'Open to Opportunities',
          employmentType: (c.availability?.type && typeof c.availability.type === 'string' && isNaN(Number(c.availability.type)))
            ? c.availability.type
            : (c.availability?.employmentType || 'Full-time'),
        },
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
  const sz = Math.min(shortlistSize, allCandidates.length);
  const shortlisted = allCandidates.slice(0, sz).map((c, i) => ({ ...c, rank: i + 1, isShortlisted: true }));
  const rejected = allCandidates.slice(sz).map(c => ({ ...c, isShortlisted: false }));
  const finalAll = [...shortlisted, ...rejected];

  console.log(`\n🏆 ${shortlisted.length} shortlisted from ${allCandidates.length}`);
  if (failedBatches > 0) console.warn(`⚠️  ${failedBatches} batch(es) failed`);

  // Generate AI Insights
  let insights: ScreeningInsights;

  try {
    console.log('\n🔍 Generating AI-powered insights...');
    console.log(`📊 Total candidates for insights analysis: ${allCandidates.length}`);
    
    if (allCandidates.length === 0) {
      console.warn('⚠️ No candidates available for insights generation');
      throw new Error('No candidates to analyze');
    }
    
    const parsed = await callAI(insightsPrompt(job, allCandidates), 'Pool insights');
    console.log(`📝 Insights response received with keys: ${Object.keys(parsed).join(', ')}`);
    
    if (parsed) {
      insights = {
        overallSkillGaps: (parsed.overallSkillGaps || []).map((g: any) => ({
          skill: g.skill || 'Unknown',
          coverage: typeof g.coverage === 'number' ? g.coverage : 0,
          severity: g.severity || 'moderate',
          recommendation: g.recommendation || 'Review this skill gap',
        })),
        marketRecommendations: parsed.marketRecommendations || [],
        pipelineHealth: parsed.pipelineHealth || 'Screening completed successfully.',
        topStrengthsAcrossPool: parsed.topStrengthsAcrossPool || [],
        criticalMissingSkills: parsed.criticalMissingSkills || [],
        hiringRecommendation: parsed.hiringRecommendation || 'Review shortlisted candidates for interviews.',
      };
      console.log(`  ✅ AI Insights ready! Found ${insights.overallSkillGaps.length} skill gaps`);
    } else {
      throw new Error('Insights response was empty');
    }
  } catch (err: any) {
    console.error(`❌ Insights generation failed: ${err?.message}`);
    console.log('📋 Using generated insights based on candidate data');
    
    // Generate insights from candidate data instead of AI
    insights = generateInsightsFromCandidates(job, allCandidates);
  }

  const scores = allCandidates.map(c => c.matchScore);
  return {
    shortlist: shortlisted,
    allCandidates: finalAll,
    insights,
    totalEvaluated: allCandidates.length,
    averageScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
    topScore: scores.length ? Math.max(...scores) : 0,
  };
}

// Fallback: Generate insights from candidate data without AI
function generateInsightsFromCandidates(job: IJob, candidates: any[]): ScreeningInsights {
  const requiredSkills = job.requiredSkills || [];
  const skillCoverage: Record<string, { count: number; total: number }> = {};
  
  // Initialize skill coverage tracking
  requiredSkills.forEach(skill => {
    skillCoverage[skill] = { count: 0, total: 0 };
  });
  
  // Calculate skill coverage from candidates
  candidates.forEach(candidate => {
    const candidateSkills = (candidate.skillScores || []).map((s: any) => s.name);
    requiredSkills.forEach(skill => {
      skillCoverage[skill].total++;
      if (candidateSkills.includes(skill)) {
        skillCoverage[skill].count++;
      }
    });
  });
  
  // Build skill gaps
  const overallSkillGaps: SkillGap[] = Object.entries(skillCoverage)
    .map(([skill, data]) => {
      const coverage = data.total > 0 ? Math.round((data.count / data.total) * 100) : 0;
      let severity: 'critical' | 'moderate' | 'minor' = 'moderate';
      if (coverage < 40) severity = 'critical';
      else if (coverage > 70) severity = 'minor';
      
      let recommendation = '';
      if (coverage < 40) {
        recommendation = `Critical gap: ${skill} missing in ${100 - coverage}% of candidates. Consider hiring or training.`;
      } else if (coverage < 70) {
        recommendation = `Moderate gap: ${skill} needs improvement. Include in technical assessments.`;
      } else {
        recommendation = `Good coverage of ${skill}. Maintain current standards.`;
      }
      
      return { skill, coverage, severity, recommendation };
    })
    .filter(g => g.coverage < 80) // Only show gaps, not strengths
    .sort((a, b) => a.coverage - b.coverage);
  
  const criticalMissingSkills = overallSkillGaps
    .filter(g => g.severity === 'critical')
    .map(g => g.skill);
  
  const topStrengthsAcrossPool = Object.entries(skillCoverage)
    .filter(([_, data]) => data.total > 0 && (data.count / data.total) > 0.7)
    .map(([skill]) => skill)
    .slice(0, 3);
  
  const marketRecommendations = [
    `Focus on recruiting candidates with ${criticalMissingSkills.slice(0, 2).join(', ')} skills`,
    `Consider training programs for ${overallSkillGaps.slice(0, 2).map(g => g.skill).join(', ')}`,
  ];
  
  const pipelineHealth = `Evaluated ${candidates.length} candidates. Found ${overallSkillGaps.length} skill gaps. ${criticalMissingSkills.length > 0 ? 'Critical gaps identified in ' + criticalMissingSkills.join(', ') + '.' : 'Good skill coverage overall.'}`;
  
  const hiringRecommendation = criticalMissingSkills.length > 0 
    ? `Priority: Hire candidates with ${criticalMissingSkills.slice(0, 2).join(', ')} skills or provide immediate training.`
    : `Proceed with interviews for top ${Math.min(5, candidates.length)} candidates.`;
  
  return {
    overallSkillGaps,
    marketRecommendations,
    pipelineHealth,
    topStrengthsAcrossPool,
    criticalMissingSkills,
    hiringRecommendation,
  };
}

const clamp = (v: any) => Math.min(100, Math.max(0, Math.round(Number(v) || 0)));
const arr = (v: any) => Array.isArray(v) ? v : [];
