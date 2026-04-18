import mongoose, { Schema, Document } from 'mongoose';

export interface IApplicant extends Document {
  jobId: mongoose.Types.ObjectId;
  source: 'umurava_platform' | 'csv_upload' | 'pdf_upload' | 'manual';
  status: 'pending' | 'screened' | 'shortlisted' | 'rejected';
  resumeUrl?: string;
  aiScore?: number;
  skillsMatchPct?: number;
  talentProfile: {
    firstName: string;
    lastName: string;
    email: string;
    headline: string;
    bio?: string;
    location: string;
    skills: { name: string; level: string; yearsOfExperience: number }[];
    languages?: { name: string; proficiency: string }[];
    experience: {
      company: string;
      role: string;
      startDate: string;
      endDate: string;
      description: string;
      technologies: string[];
      isCurrent: boolean;
    }[];
    education: {
      institution: string;
      degree: string;
      fieldOfStudy: string;
      startYear: number;
      endYear: number;
    }[];
    certifications?: { name: string; issuer: string; issueDate: string }[];
    projects: {
      name: string;
      description: string;
      technologies: string[];
      role: string;
      link?: string;
      startDate: string;
      endDate: string;
    }[];
    availability: { status: string; type: string; startDate?: string };
    socialLinks?: { linkedin?: string; github?: string; portfolio?: string };
  };
  appliedAt: Date;
}

const ApplicantSchema = new Schema<IApplicant>({
  jobId:         { type: Schema.Types.ObjectId, ref: 'Job', required: true },
  source:        { type: String, enum: ['umurava_platform','csv_upload','pdf_upload','manual'], default: 'manual' },
  status:        { type: String, enum: ['pending','screened','shortlisted','rejected'], default: 'pending' },
  resumeUrl:     { type: String },
  aiScore:       { type: Number },
  skillsMatchPct:{ type: Number },
  talentProfile: {
    firstName: { type: String, required: true },
    lastName:  { type: String, required: true },
    email:     { type: String, required: true },
    headline:  { type: String, required: true },
    bio:       { type: String },
    location:  { type: String, required: true },
    skills: [{
      name: String, level: String, yearsOfExperience: Number
    }],
    languages: [{ name: String, proficiency: String }],
    experience: [{
      company: String, role: String, startDate: String, endDate: String,
      description: String, technologies: [String], isCurrent: Boolean
    }],
    education: [{
      institution: String, degree: String, fieldOfStudy: String,
      startYear: Number, endYear: Number
    }],
    certifications: [{ name: String, issuer: String, issueDate: String }],
    projects: [{
      name: String, description: String, technologies: [String],
      role: String, link: String, startDate: String, endDate: String
    }],
    availability: { status: String, type: String, startDate: String },
    socialLinks: { linkedin: String, github: String, portfolio: String },
  },
  appliedAt: { type: Date, default: Date.now },
}, { timestamps: true });

export default mongoose.model<IApplicant>('Applicant', ApplicantSchema);
