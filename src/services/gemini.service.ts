import { GoogleGenerativeAI } from '@google/generative-ai';
import { IApplicant } from '../models/Applicant.model';
import { IJob } from '../models/Job.model';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);

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
}

export interface ScreeningWeights {
  skillsMatch: number;
  experienceMatch: number;
  educationMatch: number;
  projectRelevance: number;
  availabilityBonus: number;
}

const DEFAULT_WEIGHTS: ScreeningWeights = {
  skillsMatch: 40,
  experienceMatch: 30,
  educationMatch: 15,
  projectRelevance: 10,
  availabilityBonus: 5,
};

function buildPrompt(job: IJob, applicants: IApplicant[], weights: ScreeningWeights, shortlistSize: number): string {
  const applicantProfiles = applicants.map((a, idx) => {
    const p = a.talentProfile;
    const totalExp = p.experience.reduce((acc, e) => {
      if (e.isCurrent) {
        const start = new Date(e.startDate + '-01');
        return acc + (new Date().getFullYear() - start.getFullYear());
      }
      const start = new Date(e.startDate + '-01');
      const end = new Date(e.endDate + '-01');
      return acc + Math.max(0, end.getFullYear() - start.getFullYear());
    }, 0);

    return `
--- CANDIDATE ${idx + 1} ---
ID: ${(a._id as unknown as { toString(): string }).toString()}
Name: ${p.firstName} ${p.lastName}
Email: ${p.email}
Headline: ${p.headline}
Location: ${p.location}
Skills: ${p.skills.map(s => `${s.name} (${s.level}, ${s.yearsOfExperience}yrs)`).join(', ')}
Total Experience: ~${totalExp} years
Experience: ${p.experience.map(e => `${e.role} at ${e.company} (${e.startDate}–${e.endDate}) using [${e.technologies.join(', ')}]`).join(' | ')}
Education: ${p.education.map(e => `${e.degree} in ${e.fieldOfStudy} from ${e.institution} (${e.startYear}–${e.endYear})`).join(' | ')}
Certifications: ${(p.certifications || []).map(c => c.name).join(', ') || 'None'}
Projects: ${p.projects.map(pr => `${pr.name}: ${pr.description} [${pr.technologies.join(', ')}]`).join(' | ')}
Availability: ${p.availability.status} – ${p.availability.type}
`;
  }).join('\n');

  return `You are an expert AI recruiter for a technology company. Evaluate ALL candidates below against the job requirements and return a ranked shortlist.

## JOB REQUIREMENTS
Title: ${job.title}
Location: ${job.location}
Type: ${job.type}
Department: ${job.department}
Description: ${job.description}
Required Skills: ${job.requiredSkills.join(', ')}
Nice-to-Have Skills: ${job.niceToHaveSkills.join(', ')}
Minimum Experience: ${job.minimumExperienceYears} years
Education Level Required: ${job.educationLevel}
${job.screeningNotes ? `Special Instructions: ${job.screeningNotes}` : ''}

## SCORING WEIGHTS
- Skills Match: ${weights.skillsMatch}% (how well skills align with required skills)
- Experience Match: ${weights.experienceMatch}% (years and relevance of work experience)
- Education Match: ${weights.educationMatch}% (degree level and field of study)
- Project Relevance: ${weights.projectRelevance}% (portfolio projects matching the role)
- Availability Bonus: ${weights.availabilityBonus}% (Available=100, Open to Opportunities=70, Not Available=30)

## CANDIDATES TO EVALUATE
${applicantProfiles}

## INSTRUCTIONS
1. Evaluate EVERY candidate thoroughly against the job requirements
2. Score each dimension from 0 to 100 based on the weights above
3. Calculate overall matchScore as weighted average
4. Select the TOP ${shortlistSize} candidates by matchScore
5. For each shortlisted candidate, provide specific strengths and gaps
6. Be fair, objective, and explainable in your reasoning
7. Skill scores should be individual scores (0-100) for each required skill

## REQUIRED OUTPUT FORMAT
Return ONLY valid JSON with NO markdown, NO code blocks, NO extra text:
{
  "shortlist": [
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
      "strengths": ["specific strength 1", "specific strength 2", "specific strength 3"],
      "gaps": ["specific gap 1", "specific gap 2"],
      "recommendation": "2-3 sentence final recommendation",
      "skillScores": [
        { "name": "required skill name", "score": 0-100 }
      ]
    }
  ],
  "totalEvaluated": number,
  "averageScore": number,
  "topScore": number
}`;
}

export async function runAIScreening(
  job: IJob,
  applicants: IApplicant[],
  weights: ScreeningWeights = DEFAULT_WEIGHTS,
  shortlistSize: number = 10,
  model: string = 'gemini-1.5-pro'
): Promise<{ shortlist: CandidateResult[]; totalEvaluated: number; averageScore: number; topScore: number }> {

  const BATCH_SIZE = 20;
  let allResults: CandidateResult[] = [];

  // Process in batches to avoid token limits
  for (let i = 0; i < applicants.length; i += BATCH_SIZE) {
    const batch = applicants.slice(i, i + BATCH_SIZE);
    const prompt = buildPrompt(job, batch, weights, Math.min(shortlistSize, batch.length));

    const gemini = genAI.getGenerativeModel({ model });
    const result = await gemini.generateContent(prompt);
    const text = result.response.text().trim();

    // Clean and parse JSON
    const cleaned = text
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    const parsed = JSON.parse(cleaned);
    if (parsed.shortlist && Array.isArray(parsed.shortlist)) {
      allResults = [...allResults, ...parsed.shortlist];
    }
  }

  // Sort all results, take top N
  allResults.sort((a, b) => b.matchScore - a.matchScore);
  const finalShortlist = allResults.slice(0, shortlistSize).map((c, idx) => ({
    ...c,
    rank: idx + 1,
  }));

  const scores = allResults.map(c => c.matchScore);
  const averageScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  const topScore = scores.length > 0 ? Math.max(...scores) : 0;

  return {
    shortlist: finalShortlist,
    totalEvaluated: applicants.length,
    averageScore,
    topScore,
  };
}
