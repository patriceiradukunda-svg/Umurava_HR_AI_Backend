import mongoose, { Schema, Document } from 'mongoose';
export interface IScreeningResult extends Document {
  jobId: mongoose.Types.ObjectId;
  jobTitle: string;
  triggeredBy: mongoose.Types.ObjectId;
  triggeredAt: Date;
  completedAt?: Date;
  totalApplicantsEvaluated: number;
  shortlistSize: number;
  status: 'running' | 'completed' | 'failed';
  weights: {
    skillsMatch: number; experienceMatch: number;
    educationMatch: number; projectRelevance: number; availabilityBonus: number;
  };
  shortlist: CandidateEntry[];
  allCandidates?: CandidateEntry[];
  insights?: {
    overallSkillGaps: { skill: string; coverage: number; severity: string; recommendation: string }[];
    marketRecommendations: string[];
    pipelineHealth: string;
    topStrengthsAcrossPool: string[];
    criticalMissingSkills: string[];
    hiringRecommendation: string;
  };
  promptVersion: string;
  modelUsed: string;
  errorMessage?: string;
}
interface CandidateEntry {
  rank?: number;
  applicantId: mongoose.Types.ObjectId;
  firstName: string; lastName: string; email: string;
  headline: string; location: string;
  availability: { status: string; type: string };
  matchScore: number;
  scoreBreakdown: {
    skillsMatch: number; experienceMatch: number;
    educationMatch: number; projectRelevance: number; availabilityBonus: number;
  };
  strengths: string[];
  gaps: string[];
  recommendation: string;
  shortlistedReason?: string;
  isShortlisted?: boolean;
  skillGaps?: string[];
  growthAreas?: string[];
  courseRecommendations?: string[];
  skillScores?: { name: string; score: number }[];
  evaluatedAt?: Date;
}
const CandidateSchema = {
  rank:        Number,
  applicantId: { type: Schema.Types.ObjectId, ref: 'Applicant' },
  firstName: String, lastName: String, email: String,
  headline: String, location: String,
  availability: { status: String, type: String },
  matchScore: Number,
  scoreBreakdown: {
    skillsMatch: Number, experienceMatch: Number,
    educationMatch: Number, projectRelevance: Number, availabilityBonus: Number,
  },
  strengths: [String],
  gaps: [String],
  recommendation: String,
  shortlistedReason: String,
  isShortlisted: Boolean,
  skillGaps: [String],
  growthAreas: [String],
  courseRecommendations: [String],
  skillScores: [{ name: String, score: Number }],
  evaluatedAt: { type: Date, default: Date.now },
};
const ScreeningResultSchema = new Schema<IScreeningResult>({
  jobId:       { type: Schema.Types.ObjectId, ref: 'Job', required: true },
  jobTitle:    { type: String, required: true },
  triggeredBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  triggeredAt: { type: Date, default: Date.now },
  completedAt: { type: Date },
  totalApplicantsEvaluated: { type: Number, default: 0 },
  shortlistSize:            { type: Number, default: 10 },
  status: { type: String, enum: ['running','completed','failed'], default: 'running' },
  weights: {
    skillsMatch:       { type: Number, default: 40 },
    experienceMatch:   { type: Number, default: 30 },
    educationMatch:    { type: Number, default: 15 },
    projectRelevance:  { type: Number, default: 10 },
    availabilityBonus: { type: Number, default: 5 },
  },
  shortlist:     [CandidateSchema],
  allCandidates: [CandidateSchema],
  insights: {
    overallSkillGaps: [{
      skill: String, coverage: Number, severity: String, recommendation: String,
    }],
    marketRecommendations: [String],
    pipelineHealth: String,
    topStrengthsAcrossPool: [String],
    criticalMissingSkills: [String],
    hiringRecommendation: String,
  },
  promptVersion: { type: String, default: 'v2.0' },
  modelUsed:     { type: String, default: 'gemini-1.5-pro' },
  errorMessage:  { type: String },
}, { timestamps: true });
export default mongoose.model<IScreeningResult>('ScreeningResult', ScreeningResultSchema);
