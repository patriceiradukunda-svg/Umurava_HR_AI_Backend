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
  availability: { status: string; employmentType: string }; // renamed type→employmentType
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

const CandidateSchema = new Schema({
  rank:        { type: Number },
  applicantId: { type: Schema.Types.ObjectId, ref: 'Applicant' },
  firstName:   { type: String },
  lastName:    { type: String },
  email:       { type: String },
  headline:    { type: String },
  location:    { type: String },
  // ⚠️  'type' is a reserved Mongoose keyword — use nested explicit schema
  availability: {
    status:         { type: String, default: 'Open to Opportunities' },
    employmentType: { type: String, default: 'Full-time' },
  },
  matchScore: { type: Number },
  scoreBreakdown: {
    skillsMatch:       { type: Number },
    experienceMatch:   { type: Number },
    educationMatch:    { type: Number },
    projectRelevance:  { type: Number },
    availabilityBonus: { type: Number },
  },
  strengths:             [{ type: String }],
  gaps:                  [{ type: String }],
  recommendation:        { type: String },
  shortlistedReason:     { type: String },
  isShortlisted:         { type: Boolean },
  skillGaps:             [{ type: String }],
  growthAreas:           [{ type: String }],
  courseRecommendations: [{ type: String }],
  skillScores: [{
    name:  { type: String },
    score: { type: Number },
  }],
  evaluatedAt: { type: Date, default: Date.now },
}, { _id: false });

const ScreeningResultSchema = new Schema<IScreeningResult>({
  jobId:       { type: Schema.Types.ObjectId, ref: 'Job',  required: true },
  jobTitle:    { type: String, required: true },
  triggeredBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  triggeredAt: { type: Date, default: Date.now },
  completedAt: { type: Date },
  totalApplicantsEvaluated: { type: Number, default: 0 },
  shortlistSize:            { type: Number, default: 10 },
  status: { type: String, enum: ['running', 'completed', 'failed'], default: 'running' },
  weights: {
    skillsMatch:       { type: Number, default: 40 },
    experienceMatch:   { type: Number, default: 30 },
    educationMatch:    { type: Number, default: 15 },
    projectRelevance:  { type: Number, default: 10 },
    availabilityBonus: { type: Number, default: 5  },
  },
  shortlist:     [CandidateSchema],
  allCandidates: [CandidateSchema],
  insights: {
    overallSkillGaps: [{
      skill:          { type: String },
      coverage:       { type: Number },
      severity:       { type: String },
      recommendation: { type: String },
    }],
    marketRecommendations:  [{ type: String }],
    pipelineHealth:         { type: String },
    topStrengthsAcrossPool: [{ type: String }],
    criticalMissingSkills:  [{ type: String }],
    hiringRecommendation:   { type: String },
  },
  promptVersion: { type: String, default: 'v3.0' },
  modelUsed:     { type: String, default: 'gemini-3-flash-preview' },
  errorMessage:  { type: String },
}, { timestamps: true });

export default mongoose.model<IScreeningResult>('ScreeningResult', ScreeningResultSchema);
