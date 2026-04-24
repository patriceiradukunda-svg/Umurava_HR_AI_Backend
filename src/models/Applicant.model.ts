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

const ApplicantSchema = new Schema<IApplicant>(
  {
    jobId: {
      type:     Schema.Types.ObjectId,
      ref:      'Job',
      required: true,
    },
    source: {
      type:    String,
      enum:    ['umurava_platform', 'csv_upload', 'pdf_upload', 'manual'],
      default: 'manual',
    },
    status: {
      type:    String,
      enum:    ['pending', 'screened', 'shortlisted', 'rejected'],
      default: 'pending',
    },
    resumeUrl:      { type: String },
    aiScore:        { type: Number },
    skillsMatchPct: { type: Number },

    talentProfile: {
      firstName: { type: String, required: true },
      lastName:  { type: String, required: true },
      email:     { type: String, required: true },
      headline:  { type: String, required: true },
      bio:       { type: String },
      location:  { type: String, required: true },

      skills: [
        {
          name:              { type: String },
          level:             { type: String },
          yearsOfExperience: { type: Number },
        },
      ],

      languages: [
        {
          name:        { type: String },
          proficiency: { type: String },
        },
      ],

      experience: [
        {
          company:      { type: String },
          role:         { type: String },
          startDate:    { type: String },
          endDate:      { type: String },
          description:  { type: String },
          technologies: [{ type: String }],
          isCurrent:    { type: Boolean },
        },
      ],

      education: [
        {
          institution:  { type: String },
          degree:       { type: String },
          fieldOfStudy: { type: String },
          startYear:    { type: Number },
          endYear:      { type: Number },
        },
      ],

      certifications: [
        {
          name:      { type: String },
          issuer:    { type: String },
          issueDate: { type: String },
        },
      ],

      projects: [
        {
          name:         { type: String },
          description:  { type: String },
          technologies: [{ type: String }],
          role:         { type: String },
          link:         { type: String },
          startDate:    { type: String },
          endDate:      { type: String },
        },
      ],

      // ── CRITICAL FIX ────────────────────────────────────────────────────
      // Each sub-field must be wrapped in { type: String } explicitly.
      // If you write `type: String` directly as a key inside an object,
      // Mongoose treats it as a schema type declaration (string field),
      // not a nested object — causing the "Cast to string failed" error.
      availability: {
        status:    { type: String },
        type:      { type: String },
        startDate: { type: String },
      },

      socialLinks: {
        linkedin:  { type: String },
        github:    { type: String },
        portfolio: { type: String },
      },
    },

    appliedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export default mongoose.model<IApplicant>('Applicant', ApplicantSchema);
