import { GoogleGenerativeAI } from '@google/generative-ai';
import { IApplicant } from '../models/Applicant.model';
import { IJob } from '../models/Job.model';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);

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

// ─── FIX 1: Robust JSON extractor ─────────────────────────────────────────────
// AI models frequently wrap JSON in markdown, add trailing text, or produce
// minor syntax errors. This function tries multiple strategies before giving up.
function extractJSON(raw: string): any {
  let text = raw.trim();

  // Strip ALL forms of markdown code fences (``` json, ```JSON, ``` etc.)
  text = text.replace(/```[\w]*\n?/gi, '').replace(/```/g, '').trim();

  // Strategy 1: direct parse of the whole cleaned text
  try { return JSON.parse(text); } catch { /* fall through */ }

  // Strategy 2: find the outermost { ... } block
  const firstBrace = text.indexOf('{');
  const lastBrace  = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const slice = text.substring(firstBrace, lastBrace + 1);
    try { return JSON.parse(slice); } catch { /* fall through */ }

    // Strategy 3: the slice itself has a syntax error — try to find the
    // largest valid JSON prefix by walking backwards from the end
    for (let end = slice.length - 1; end > firstBrace; end--) {
      if (slice[end] === '}') {
        try { return JSON.parse(slice.substring(0, end + 1)); } catch { /* keep shrinking */ }
      }
    }
  }

  throw new Error(`Could not extract valid JSON from AI response. Preview: ${text.substring(0, 200)}`);
}

// ─── FIX 2: Remap applicantIds from original batch ────────────────────────────
// AI frequently returns wrong, hallucinated, or re-formatted IDs.
// After parsing the response we ALWAYS re-map IDs from the source applicants
// using name + email matching as the authoritative source. This ensures
// Mongoose can always cast applicantId to ObjectId successfully.
function remapApplicantIds(
  aiCandidates: any[],
  batch: IApplicant[]
): any[] {
  // Build lookup maps
  const byId    = new Map<string, string>() // ai-returned-id  → real _id
  const byEmail = new Map<string, string>() // lowercase email → real _id
  const byName  = new Map<string, string>() // "firstname|lastname" → real _id

  for (const a of batch) {
    const realId = (a._id as any).toString()
    byId.set(realId, realId) // identity — AI returned correct ID
    if (a.talentProfile.email)
      byEmail.set(a.talentProfile.email.toLowerCase().trim(), realId)
    const nameKey = `${a.talentProfile.firstName.toLowerCase().trim()}|${a.talentProfile.lastName.toLowerCase().trim()}`
    byName.set(nameKey, realId)
  }

  return aiCandidates.map(c => {
    // Priority 1: AI returned the exact correct ID
    if (c.applicantId && byId.has(String(c.applicantId))) {
      return c
    }
    // Priority 2: match by email
    const emailKey = (c.email || '').toLowerCase().trim()
    if (emailKey && byEmail.has(emailKey)) {
      console.log(`  🔧 Re-mapped ID for ${c.firstName} ${c.lastName} via email`)
      return { ...c, applicantId: byEmail.get(emailKey) }
    }
    // Priority 3: match by name
    const nameKey = `${(c.firstName || '').toLowerCase().trim()}|${(c.lastName || '').toLowerCase().trim()}`
    if (byName.has(nameKey)) {
      console.log(`  🔧 Re-mapped ID for ${c.firstName} ${c.lastName} via name`)
      return { ...c, applicantId: byName.get(nameKey) }
    }
    // Priority 4: find best partial name match
    for (const [key, realId] of byName.entries()) {
      const [fn, ln] = key.split('|')
      if (fn && c.firstName?.toLowerCase().includes(fn)) {
        console.log(`  🔧 Re-mapped ID for ${c.firstName} ${c.lastName} via partial name match`)
        return { ...c, applicantId: realId }
      }
    }
    // Fallback: keep whatever the AI returned (may fail Mongoose cast — acceptable)
    console.warn(`  ⚠️  Could not re-map ID for "${c.firstName} ${c.lastName}" — keeping AI value: ${c.applicantId}`)
    return c
  })
}

// ─── Profile serialiser ────────────────────────────────────────────────────────
function profileText(a: IApplicant, displayIndex: number): string {
  const p = a.talentProfile

  const totalExp = p.experience.reduce((acc, e) => {
    try {
      const start = new Date(`${e.startDate}-01`)
      const end   = e.isCurrent ? new Date() : new Date(`${e.endDate}-01`)
      return acc + Math.max(0, (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 365))
    } catch { return acc }
  }, 0)

  const expDetail = p.experience.map(e =>
    `  • ${e.role} @ ${e.company} (${e.startDate}–${e.isCurrent ? 'Present' : e.endDate})\n` +
    `    Tech: ${(e.technologies || []).join(', ') || '—'}\n` +
    `    ${e.description || ''}`
  ).join('\n')

  const eduDetail = p.education.map(e =>
    `  • ${e.degree} in ${e.fieldOfStudy} — ${e.institution} (${e.startYear}–${e.endYear})`
  ).join('\n')

  const projDetail = (p.projects || []).map(pr =>
    `  • ${pr.name} [${(pr.technologies || []).join(', ')}]: ${pr.description}`
  ).join('\n')

  const certDetail = (p.certifications || []).map(c => `${c.name} by ${c.issuer}`).join(', ') || 'None'
  const langDetail = (p.languages || []).map(l => `${l.name} (${l.proficiency})`).join(', ') || 'Not specified'

  // ⚠️  IMPORTANT: we use the real MongoDB _id here
  return `
====== CANDIDATE ${displayIndex} ======
CANDIDATE_ID: ${(a._id as any).toString()}
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
`
}

// ─── Prompt builder ────────────────────────────────────────────────────────────
function buildBatchPrompt(
  job: IJob,
  batch: IApplicant[],
  weights: ScreeningWeights,
  shortlistSize: number,
  batchIndex: number,
  totalBatches: number
): string {
  const profiles  = batch.map((a, i) => profileText(a, batchIndex * batch.length + i + 1)).join('\n')
  const weightSum = Object.values(weights).reduce((a, b) => a + b, 0)
  const weightNote = weightSum !== 100
    ? `NOTE: Weights sum to ${weightSum} — normalise by dividing each by ${weightSum} before applying.`
    : 'Weights sum to 100 ✓'

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
- skillsMatch       ${weights.skillsMatch}  — Required skills coverage, depth, years
- experienceMatch   ${weights.experienceMatch}  — Years, seniority, role relevance
- educationMatch    ${weights.educationMatch}  — Degree level, field alignment
- projectRelevance  ${weights.projectRelevance}  — Portfolio relevance to role
- availabilityBonus ${weights.availabilityBonus}  — Available=100, Open=70, NotAvailable=30

${totalBatches > 1 ? `[BATCH ${batchIndex + 1} of ${totalBatches}]` : ''}

═══════════════════════════════════════════════════════
CANDIDATES TO EVALUATE (${batch.length} in this batch)
═══════════════════════════════════════════════════════
${profiles}

═══════════════════════════════════════════════════════
EVALUATION INSTRUCTIONS
═══════════════════════════════════════════════════════
1. Evaluate EVERY candidate above. Do not skip any.
2. For each scoring dimension, assign 0-100 independently, then compute:
   matchScore = (skillsMatch × ${weights.skillsMatch} + experienceMatch × ${weights.experienceMatch} + educationMatch × ${weights.educationMatch} + projectRelevance × ${weights.projectRelevance} + availabilityBonus × ${weights.availabilityBonus}) / ${weightSum}
3. Round matchScore to the nearest integer.
4. strengths: minimum 3 specific, evidence-backed points — no generic statements.
5. gaps: specific gaps vs the requirements — constructive and honest.
6. shortlistedReason: 2-3 sentences explaining WHY this candidate is/is not ideal.
7. skillGaps: required skills this candidate is missing or clearly weak in.
8. growthAreas: top 2-3 areas to develop for roles like this.
9. courseRecommendations: 2-3 concrete certifications/courses that address their gaps.
10. CRITICAL: For the "applicantId" field, copy the CANDIDATE_ID value EXACTLY as shown above.

═══════════════════════════════════════════════════════
POOL-LEVEL INTELLIGENCE
═══════════════════════════════════════════════════════
After evaluating all candidates, provide holistic analysis:
- overallSkillGaps: which required skills are broadly missing
- marketRecommendations: 2-3 strategic actions for HR
- pipelineHealth: one paragraph on pool quality
- topStrengthsAcrossPool: skills most candidates share
- criticalMissingSkills: skills almost nobody has
- hiringRecommendation: overall strategic advice to HR

═══════════════════════════════════════════════════════
OUTPUT FORMAT — CRITICAL RULES
═══════════════════════════════════════════════════════
• Return ONLY a single valid JSON object — no markdown, no code fences, no explanation
• Do NOT wrap in \`\`\`json or any other formatting
• Every candidate in the input MUST appear in the output "candidates" array
• The JSON must be complete and properly closed

{
  "candidates": [
    {
      "applicantId": "COPY_CANDIDATE_ID_EXACTLY_FROM_ABOVE",
      "firstName": "string",
      "lastName": "string",
      "email": "string",
      "headline": "string",
      "location": "string",
      "availability": { "status": "string", "type": "string" },
      "matchScore": 0,
      "scoreBreakdown": {
        "skillsMatch": 0,
        "experienceMatch": 0,
        "educationMatch": 0,
        "projectRelevance": 0,
        "availabilityBonus": 0
      },
      "strengths": ["strength 1", "strength 2", "strength 3"],
      "gaps": ["gap 1", "gap 2"],
      "shortlistedReason": "2-3 sentence explanation",
      "skillGaps": ["missing skill 1"],
      "growthAreas": ["area 1", "area 2"],
      "courseRecommendations": ["Course — why it helps"],
      "recommendation": "Final hiring recommendation",
      "skillScores": [
        { "name": "required skill", "score": 0 }
      ]
    }
  ],
  "poolInsights": {
    "overallSkillGaps": [
      { "skill": "name", "coverage": 0, "severity": "critical", "recommendation": "action" }
    ],
    "marketRecommendations": ["action 1", "action 2"],
    "pipelineHealth": "paragraph",
    "topStrengthsAcrossPool": ["strength 1"],
    "criticalMissingSkills": ["skill 1"],
    "hiringRecommendation": "overall recommendation"
  }
}`
}

// ─── Main screening function ───────────────────────────────────────────────────
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
  const BATCH_SIZE   = 15
  const totalBatches = Math.ceil(applicants.length / BATCH_SIZE)

  let allCandidates: CandidateResult[] = []
  const allInsights: ScreeningInsights[] = []
  let failedBatches = 0

  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0.1,   // very low = deterministic, consistent scoring
      topP: 0.8,
      maxOutputTokens: 8192,
    },
  })

  for (let i = 0; i < applicants.length; i += BATCH_SIZE) {
    const batch      = applicants.slice(i, i + BATCH_SIZE)
    const batchIndex = Math.floor(i / BATCH_SIZE)
    const batchNum   = batchIndex + 1

    console.log(`\n📦 Processing batch ${batchNum}/${totalBatches} (${batch.length} candidates)…`)

    const prompt    = buildBatchPrompt(job, batch, weights, shortlistSize, batchIndex, totalBatches)
    let batchSuccess = false

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`  🤖 Calling Gemini (attempt ${attempt}/3)…`)

        const result   = await model.generateContent(prompt)
        const rawText  = result.response.text()

        console.log(`  📄 Raw response length: ${rawText.length} chars`)
        if (rawText.length < 100) {
          console.warn(`  ⚠️  Response suspiciously short: "${rawText.substring(0, 200)}"`)
          throw new Error(`Response too short (${rawText.length} chars) — likely an API error`)
        }

        // ── FIX 1: Robust JSON extraction ────────────────────────────────────
        const parsed = extractJSON(rawText)

        if (!parsed.candidates || !Array.isArray(parsed.candidates)) {
          console.warn(`  ⚠️  Response has no "candidates" array. Keys: ${Object.keys(parsed).join(', ')}`)
          throw new Error('Response missing "candidates" array')
        }

        console.log(`  ✅ AI returned ${parsed.candidates.length} candidates (expected ${batch.length})`)

        // ── FIX 2: Re-map applicantIds from source applicants ─────────────────
        const remapped = remapApplicantIds(parsed.candidates, batch)

        // Validate scores — clamp to 0-100
        const validated = remapped.map(c => ({
          ...c,
          matchScore:      Math.min(100, Math.max(0, Math.round(Number(c.matchScore)      || 0))),
          scoreBreakdown: {
            skillsMatch:       Math.min(100, Math.max(0, Math.round(Number(c.scoreBreakdown?.skillsMatch)       || 0))),
            experienceMatch:   Math.min(100, Math.max(0, Math.round(Number(c.scoreBreakdown?.experienceMatch)   || 0))),
            educationMatch:    Math.min(100, Math.max(0, Math.round(Number(c.scoreBreakdown?.educationMatch)    || 0))),
            projectRelevance:  Math.min(100, Math.max(0, Math.round(Number(c.scoreBreakdown?.projectRelevance)  || 0))),
            availabilityBonus: Math.min(100, Math.max(0, Math.round(Number(c.scoreBreakdown?.availabilityBonus) || 0))),
          },
          // Ensure arrays exist
          strengths:             Array.isArray(c.strengths)             ? c.strengths             : [],
          gaps:                  Array.isArray(c.gaps)                  ? c.gaps                  : [],
          skillGaps:             Array.isArray(c.skillGaps)             ? c.skillGaps             : [],
          growthAreas:           Array.isArray(c.growthAreas)           ? c.growthAreas           : [],
          courseRecommendations: Array.isArray(c.courseRecommendations) ? c.courseRecommendations : [],
          skillScores:           Array.isArray(c.skillScores)           ? c.skillScores           : [],
        }))

        allCandidates = [...allCandidates, ...validated]

        if (parsed.poolInsights) {
          allInsights.push(parsed.poolInsights as ScreeningInsights)
        }

        batchSuccess = true
        break // success — next batch

      } catch (err) {
        const msg = (err as Error).message
        console.warn(`  ⚠️  Batch ${batchNum} attempt ${attempt} failed: ${msg}`)
        if (attempt < 3) {
          const delay = 3000 * attempt
          console.log(`  ⏳ Waiting ${delay}ms before retry…`)
          await new Promise(r => setTimeout(r, delay))
        }
      }
    }

    if (!batchSuccess) {
      failedBatches++
      console.error(`❌ Batch ${batchNum} failed after 3 attempts — skipping these ${batch.length} candidates`)
    }
  }

  // ── FIX 3: Throw if ALL batches failed ──────────────────────────────────────
  if (allCandidates.length === 0) {
    throw new Error(
      `AI screening produced no results. ${failedBatches}/${totalBatches} batch(es) failed. ` +
      `Check GEMINI_API_KEY, API quota, and Gemini service availability.`
    )
  }

  if (failedBatches > 0) {
    console.warn(`⚠️  ${failedBatches}/${totalBatches} batches failed — partial results (${allCandidates.length}/${applicants.length} candidates evaluated)`)
  }

  // ── Sort by matchScore DESC, then build shortlist ────────────────────────────
  allCandidates.sort((a, b) => b.matchScore - a.matchScore)

  const actualShortlistSize = Math.min(shortlistSize, allCandidates.length)
  const shortlisted    = allCandidates.slice(0, actualShortlistSize).map((c, idx) => ({
    ...c,
    rank:          idx + 1,
    isShortlisted: true,
  }))
  const notShortlisted = allCandidates.slice(actualShortlistSize).map(c => ({
    ...c,
    isShortlisted: false,
  }))
  const finalAllCandidates = [...shortlisted, ...notShortlisted]

  console.log(`\n🏆 Shortlist: ${shortlisted.length} candidates selected from ${allCandidates.length} evaluated`)
  console.log(`   Score range: ${shortlisted[shortlisted.length - 1]?.matchScore ?? 0}–${shortlisted[0]?.matchScore ?? 0}`)

  const scores   = allCandidates.map(c => c.matchScore)
  const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0
  const topScore = scores.length ? Math.max(...scores) : 0

  return {
    shortlist:      shortlisted,
    allCandidates:  finalAllCandidates,
    insights:       mergeInsights(allInsights, job),
    totalEvaluated: allCandidates.length,
    averageScore:   avgScore,
    topScore,
  }
}

// ─── Merge insights from multiple batches ─────────────────────────────────────
function mergeInsights(insights: ScreeningInsights[], job: IJob): ScreeningInsights {
  if (insights.length === 0) {
    return {
      overallSkillGaps: [],
      marketRecommendations: [`Source more candidates with: ${job.requiredSkills.slice(0, 3).join(', ')}`],
      pipelineHealth: 'Insufficient data to assess pipeline health.',
      topStrengthsAcrossPool: [],
      criticalMissingSkills: job.requiredSkills.slice(0, 3),
      hiringRecommendation: 'Run screening with more applicants for a complete assessment.',
    }
  }

  // Average coverage per skill across batches
  const gapMap = new Map<string, { total: number; count: number; severity: string; recommendation: string }>()
  for (const ins of insights) {
    for (const g of (ins.overallSkillGaps || [])) {
      const existing = gapMap.get(g.skill)
      if (existing) {
        existing.total += g.coverage
        existing.count++
      } else {
        gapMap.set(g.skill, { total: g.coverage, count: 1, severity: g.severity, recommendation: g.recommendation })
      }
    }
  }

  const overallSkillGaps: SkillGap[] = Array.from(gapMap.entries())
    .map(([skill, d]) => ({
      skill,
      coverage:       Math.round(d.total / d.count),
      severity:       d.severity as 'critical' | 'moderate' | 'minor',
      recommendation: d.recommendation,
    }))
    .sort((a, b) => a.coverage - b.coverage)

  const uniq = (arrs: string[][]) => [...new Set(arrs.flat())]

  return {
    overallSkillGaps,
    marketRecommendations: uniq(insights.map(i => i.marketRecommendations || [])).slice(0, 4),
    pipelineHealth:        insights[insights.length - 1]?.pipelineHealth || 'Good talent pool identified.',
    topStrengthsAcrossPool:uniq(insights.map(i => i.topStrengthsAcrossPool || [])).slice(0, 5),
    criticalMissingSkills: uniq(insights.map(i => i.criticalMissingSkills || [])).slice(0, 5),
    hiringRecommendation:  insights[insights.length - 1]?.hiringRecommendation || 'Proceed with the shortlisted candidates.',
  }
}
