import { GoogleGenerativeAI } from '@google/generative-ai';
import { IApplicant } from '../models/Applicant.model';
import { IJob } from '../models/Job.model';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);

export interface SkillGap {
  skill: string;
  coverage: number;          // 0-100 % of shortlisted candidates meeting it
  severity: 'critical' | 'moderate' | 'minor';
  recommendation: string;    // course of action
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
  // NEW — per-candidate intelligence
  shortlistedReason: string;    // why selected (or why not)
  isShortlisted: boolean;
  skillGaps: string[];          // skills this candidate is missing
  growthAreas: string[];        // areas to develop
  courseRecommendations: string[]; // specific courses / certifications to suggest
}

export interface ScreeningWeights {
  skillsMatch: number;
  experienceMatch: number;
  educationMatch: number;
  projectRelevance: number;
  availabilityBonus: number;
}

export interface ScreeningInsights {
  overallSkillGaps: SkillGap[];           // across ALL candidates
  marketRecommendations: string[];         // strategic hiring advice
  pipelineHealth: string;                  // summary of talent pool quality
  topStrengthsAcrossPool: string[];        // what the pool is strong at
  criticalMissingSkills: string[];         // skills nobody has
  hiringRecommendation: string;            // overall recommendation to HR
}

export const DEFAULT_WEIGHTS: ScreeningWeights = {
  skillsMatch: 40,
  experienceMatch: 30,
  educationMatch: 15,
  projectRelevance: 10,
  availabilityBonus: 5,
};

// ─── Profile serialiser ──────────────────────────────────────────────────────
function profileText(a: IApplicant, idx: number): string {
  const p = a.talentProfile;

  const totalExp = p.experience.reduce((acc, e) => {
    try {
      const start = new Date(`${e.startDate}-01`);
      const end   = e.isCurrent ? new Date() : new Date(`${e.endDate}-01`);
      return acc + Math.max(0, (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 365));
    } catch { return acc; }
  }, 0);

  const expDetail = p.experience.map(e =>
    `  • ${e.role} @ ${e.company} (${e.startDate}–${e.isCurrent ? 'Present' : e.endDate})\n` +
    `    Tech: ${(e.technologies || []).join(', ') || '—'}\n` +
    `    ${e.description || ''}`
  ).join('\n');

  const eduDetail = p.education.map(e =>
    `  • ${e.degree} in ${e.fieldOfStudy} — ${e.institution} (${e.startYear}–${e.endYear})`
  ).join('\n');

  const projDetail = (p.projects || []).map(pr =>
    `  • ${pr.name} [${(pr.technologies || []).join(', ')}]: ${pr.description}`
  ).join('\n');

  const certDetail = (p.certifications || []).map(c => `${c.name} by ${c.issuer}`).join(', ') || 'None';
  const langDetail = (p.languages || []).map(l => `${l.name} (${l.proficiency})`).join(', ') || 'Not specified';

  return `
====== CANDIDATE ${idx + 1} ======
ID: ${(a._id as any).toString()}
Name: ${p.firstName} ${p.lastName}
Email: ${p.email}
Headline: ${p.headline || '—'}
Location: ${p.location}
Bio: ${p.bio || '—'}

SKILLS (${p.skills.length}):
${p.skills.map(s => `  • ${s.name}: ${s.level}, ${s.yearsOfExperience}yr(s)`).join('\n') || '  None listed'}

TOTAL EXPERIENCE: ~${totalExp.toFixed(1)} years
WORK HISTORY:
${expDetail || '  None listed'}

EDUCATION:
${eduDetail || '  None listed'}

CERTIFICATIONS: ${certDetail}
LANGUAGES: ${langDetail}

PROJECTS:
${projDetail || '  None listed'}

AVAILABILITY: ${p.availability?.status || '—'} | Preferred type: ${p.availability?.type || '—'}
`;
}

// ─── Main prompt builder ─────────────────────────────────────────────────────
function buildBatchPrompt(
  job: IJob,
  batch: IApplicant[],
  weights: ScreeningWeights,
  shortlistSize: number,
  batchIndex: number,
  totalBatches: number
): string {
  const profiles = batch.map((a, i) => profileText(a, batchIndex * batch.length + i + 1)).join('\n');

  const weightSum = Object.values(weights).reduce((a, b) => a + b, 0);
  const weightNote = weightSum !== 100
    ? `NOTE: Weights sum to ${weightSum} — normalise proportionally when computing the weighted score.`
    : 'Weights sum to 100 ✓';

  return `You are a senior talent intelligence system performing objective, bias-free candidate evaluation.

═══════════════════════════════════════════════════════
JOB SPECIFICATION
═══════════════════════════════════════════════════════
Title:       ${job.title}
Department:  ${job.department}
Location:    ${job.location}
Type:        ${job.type}
Min Exp:     ${job.minimumExperienceYears}+ years
Education:   ${job.educationLevel || "Bachelor's"} minimum

DESCRIPTION:
${job.description}

${job.responsibilities ? `KEY RESPONSIBILITIES:\n${job.responsibilities}\n` : ''}
REQUIRED SKILLS:   ${job.requiredSkills.join(', ') || 'Not specified'}
NICE-TO-HAVE:      ${job.niceToHaveSkills.join(', ') || 'None'}
REQUIREMENTS:      ${(job.requirements || []).join(' | ') || 'See description'}
${job.screeningNotes ? `\nSPECIAL HR INSTRUCTIONS (highest priority):\n${job.screeningNotes}` : ''}

═══════════════════════════════════════════════════════
SCORING WEIGHTS  (${weightNote})
═══════════════════════════════════════════════════════
- skillsMatch       ${weights.skillsMatch}%  — Required skills coverage, depth, and years
- experienceMatch   ${weights.experienceMatch}%  — Years, seniority, and role relevance
- educationMatch    ${weights.educationMatch}%  — Degree level, field alignment
- projectRelevance  ${weights.projectRelevance}%  — Portfolio relevance to this role
- availabilityBonus ${weights.availabilityBonus}%  — Available=100, Open=70, Not Available=30

${batchIndex > 0 ? `[BATCH ${batchIndex + 1} of ${totalBatches}]` : ''}

═══════════════════════════════════════════════════════
CANDIDATES TO EVALUATE (${batch.length} in this batch)
═══════════════════════════════════════════════════════
${profiles}

═══════════════════════════════════════════════════════
EVALUATION INSTRUCTIONS
═══════════════════════════════════════════════════════
1. Evaluate EVERY candidate above with equal rigour and without bias.
2. For each dimension, score 0-100 independently then compute the weighted matchScore.
3. matchScore = (skillsMatch × ${weights.skillsMatch} + experienceMatch × ${weights.experienceMatch} + educationMatch × ${weights.educationMatch} + projectRelevance × ${weights.projectRelevance} + availabilityBonus × ${weights.availabilityBonus}) / ${weightSum}
4. skillScores: score each REQUIRED skill individually (0-100) based on candidate evidence.
5. strengths: minimum 3 specific, evidence-backed bullet points (not generic).
6. gaps: honest gaps vs the role requirements — be specific and constructive.
7. shortlistedReason: 2-3 sentences explaining exactly WHY this candidate is/is not ideal.
8. skillGaps: list required skills the candidate is missing or weak in.
9. growthAreas: top 2-3 areas they should develop to become stronger for roles like this.
10. courseRecommendations: 2-3 concrete courses, certifications or resources that address their gaps (e.g. "AWS Certified Developer Associate — closes cloud infrastructure gap").
11. recommendation: your final professional hiring recommendation for this candidate.
12. Be decisive, specific, and honest — vague assessments help no one.

═══════════════════════════════════════════════════════
ALSO PROVIDE POOL-LEVEL INTELLIGENCE (for this batch)
═══════════════════════════════════════════════════════
Analyse the talent pool holistically and provide:
- overallSkillGaps: which required skills are broadly missing across candidates
- marketRecommendations: 2-3 strategic actions HR should take based on what you see
- pipelineHealth: one paragraph on the overall quality of this talent pool
- topStrengthsAcrossPool: skills/attributes most candidates share
- criticalMissingSkills: required skills that almost nobody in this batch has
- hiringRecommendation: overall advice — should HR proceed, expand sourcing, etc.

═══════════════════════════════════════════════════════
REQUIRED OUTPUT — RETURN ONLY VALID JSON, NO MARKDOWN
═══════════════════════════════════════════════════════
{
  "candidates": [
    {
      "applicantId": "exact_id_from_above",
      "firstName": "string",
      "lastName": "string",
      "email": "string",
      "headline": "string",
      "location": "string",
      "availability": { "status": "string", "type": "string" },
      "matchScore": 0-100,
      "scoreBreakdown": {
        "skillsMatch": 0-100,
        "experienceMatch": 0-100,
        "educationMatch": 0-100,
        "projectRelevance": 0-100,
        "availabilityBonus": 0-100
      },
      "strengths": ["evidence-based strength 1", "strength 2", "strength 3"],
      "gaps": ["specific gap 1", "specific gap 2"],
      "shortlistedReason": "2-3 sentence explanation of selection/rejection decision",
      "isShortlisted": true,
      "skillGaps": ["missing skill 1", "weak area 2"],
      "growthAreas": ["growth area 1", "growth area 2"],
      "courseRecommendations": ["Course name — why it helps", "Certification — gap it closes"],
      "recommendation": "Final professional hiring recommendation",
      "skillScores": [
        { "name": "required skill name", "score": 0-100 }
      ]
    }
  ],
  "poolInsights": {
    "overallSkillGaps": [
      {
        "skill": "skill name",
        "coverage": 0-100,
        "severity": "critical|moderate|minor",
        "recommendation": "what HR should do about this gap"
      }
    ],
    "marketRecommendations": ["action 1", "action 2"],
    "pipelineHealth": "paragraph describing pool quality",
    "topStrengthsAcrossPool": ["strength 1", "strength 2"],
    "criticalMissingSkills": ["skill 1", "skill 2"],
    "hiringRecommendation": "overall strategic recommendation"
  },
  "totalEvaluated": ${batch.length}
}`;
}

// ─── Main screening function ─────────────────────────────────────────────────
export async function runAIScreening(
  job: IJob,
  applicants: IApplicant[],
  weights: ScreeningWeights = DEFAULT_WEIGHTS,
  shortlistSize: number = 10,
  modelName: string = 'gemini-1.5-pro'
): Promise<{
  shortlist: CandidateResult[];
  allCandidates: CandidateResult[];
  insights: ScreeningInsights;
  totalEvaluated: number;
  averageScore: number;
  topScore: number;
}> {

  // No hard batch cap — process all applicants, 15 per batch to stay well under token limits
  const BATCH_SIZE = 15;
  const totalBatches = Math.ceil(applicants.length / BATCH_SIZE);

  let allCandidates: CandidateResult[] = [];
  const allInsights: ScreeningInsights[] = [];

  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0.2,      // low temperature = more consistent scoring
      topP: 0.8,
      maxOutputTokens: 8192,
    },
  });

  for (let i = 0; i < applicants.length; i += BATCH_SIZE) {
    const batch = applicants.slice(i, i + BATCH_SIZE);
    const batchIndex = Math.floor(i / BATCH_SIZE);
    const prompt = buildBatchPrompt(job, batch, weights, shortlistSize, batchIndex, totalBatches);

    let lastError: Error | null = null;

    // Retry up to 3 times per batch
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        let text = result.response.text().trim();

        // Strip any markdown fencing the model might add despite instructions
        text = text.replace(/^```(?:json)?\n?/gm, '').replace(/\n?```$/gm, '').trim();

        // Find the outermost JSON object
        const jsonStart = text.indexOf('{');
        const jsonEnd   = text.lastIndexOf('}');
        if (jsonStart === -1 || jsonEnd === -1) throw new Error('No JSON found in response');
        const jsonStr = text.substring(jsonStart, jsonEnd + 1);

        const parsed = JSON.parse(jsonStr);

        if (parsed.candidates && Array.isArray(parsed.candidates)) {
          allCandidates = [...allCandidates, ...parsed.candidates];
        }

        if (parsed.poolInsights) {
          allInsights.push(parsed.poolInsights as ScreeningInsights);
        }

        lastError = null;
        break; // success — move to next batch
      } catch (err) {
        lastError = err as Error;
        console.warn(`⚠️ Batch ${batchIndex + 1} attempt ${attempt + 1} failed:`, (err as Error).message);
        // Small back-off before retry
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }

    if (lastError) {
      console.error(`❌ Batch ${batchIndex + 1} failed after 3 attempts:`, lastError.message);
      // Don't throw — continue with other batches; partial results are better than none
    }
  }

  // ── Sort all candidates, build shortlist ────────────────────────────────
  allCandidates.sort((a, b) => b.matchScore - a.matchScore);
  const shortlisted = allCandidates.slice(0, shortlistSize).map((c, idx) => ({
    ...c,
    rank: idx + 1,
    isShortlisted: true,
  }));
  const notShortlisted = allCandidates.slice(shortlistSize).map(c => ({
    ...c,
    isShortlisted: false,
  }));
  const finalAllCandidates = [...shortlisted, ...notShortlisted];

  // ── Merge pool insights from all batches ────────────────────────────────
  const mergedInsights: ScreeningInsights = mergeInsights(allInsights, job);

  const scores     = allCandidates.map(c => c.matchScore);
  const avgScore   = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  const topScore   = scores.length > 0 ? Math.max(...scores) : 0;

  return {
    shortlist: shortlisted,
    allCandidates: finalAllCandidates,
    insights: mergedInsights,
    totalEvaluated: applicants.length,
    averageScore: avgScore,
    topScore,
  };
}

// ─── Merge insights from multiple batches into one coherent summary ──────────
function mergeInsights(insights: ScreeningInsights[], job: IJob): ScreeningInsights {
  if (insights.length === 0) {
    return {
      overallSkillGaps: [],
      marketRecommendations: [`Source more candidates with: ${job.requiredSkills.slice(0, 3).join(', ')}`],
      pipelineHealth: 'Insufficient data to assess pipeline health.',
      topStrengthsAcrossPool: [],
      criticalMissingSkills: job.requiredSkills.slice(0, 3),
      hiringRecommendation: 'Run screening with more applicants for a complete assessment.',
    };
  }

  // Merge skill gaps — average coverage where same skill appears multiple times
  const gapMap = new Map<string, { total: number; count: number; severity: string; recommendations: string[] }>();
  for (const ins of insights) {
    for (const g of (ins.overallSkillGaps || [])) {
      const existing = gapMap.get(g.skill);
      if (existing) {
        existing.total += g.coverage;
        existing.count++;
        existing.recommendations.push(g.recommendation);
      } else {
        gapMap.set(g.skill, { total: g.coverage, count: 1, severity: g.severity, recommendations: [g.recommendation] });
      }
    }
  }
  const overallSkillGaps: SkillGap[] = Array.from(gapMap.entries()).map(([skill, d]) => ({
    skill,
    coverage: Math.round(d.total / d.count),
    severity: d.severity as 'critical' | 'moderate' | 'minor',
    recommendation: d.recommendations[0],
  })).sort((a, b) => a.coverage - b.coverage); // worst gaps first

  // Unique merge helpers
  const uniq = (arr: string[][]) => [...new Set(arr.flat())];

  return {
    overallSkillGaps,
    marketRecommendations: uniq(insights.map(i => i.marketRecommendations || [])).slice(0, 4),
    pipelineHealth: insights[insights.length - 1]?.pipelineHealth || 'Good talent pool identified.',
    topStrengthsAcrossPool: uniq(insights.map(i => i.topStrengthsAcrossPool || [])).slice(0, 5),
    criticalMissingSkills: uniq(insights.map(i => i.criticalMissingSkills || [])).slice(0, 5),
    hiringRecommendation: insights[insights.length - 1]?.hiringRecommendation || 'Proceed with the shortlisted candidates.',
  };
}
