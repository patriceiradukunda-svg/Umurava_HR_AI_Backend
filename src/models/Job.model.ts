import mongoose, { Schema, Document } from 'mongoose';

export interface IJob extends Document {
  title: string;
  department: string;
  location: string;
  type: string;
  description: string;
  responsibilities?: string;
  requirements: string[];
  requiredSkills: string[];
  niceToHaveSkills: string[];
  minimumExperienceYears: number;
  educationLevel: string;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency: string;
  applicationDeadline?: Date;
  shortlistSize: number;
  status: 'active' | 'draft' | 'screening' | 'closed';
  screeningNotes?: string;
  createdBy: mongoose.Types.ObjectId;
  applicantCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const JobSchema = new Schema<IJob>({
  title:                  { type: String, required: true, trim: true },
  department:             { type: String, required: true },
  location:               { type: String, required: true },
  type:                   { type: String, default: 'Full-time' },
  description:            { type: String, required: true },
  responsibilities:       { type: String },
  requirements:           [{ type: String }],
  requiredSkills:         [{ type: String }],
  niceToHaveSkills:       [{ type: String }],
  minimumExperienceYears: { type: Number, default: 0 },
  educationLevel:         { type: String, default: "Bachelor's" },
  salaryMin:              { type: Number },
  salaryMax:              { type: Number },
  salaryCurrency:         { type: String, default: 'USD' },
  applicationDeadline:    { type: Date },
  shortlistSize:          { type: Number, default: 10 },
  status:                 { type: String, enum: ['active','draft','screening','closed'], default: 'draft' },
  screeningNotes:         { type: String },
  createdBy:              { type: Schema.Types.ObjectId, ref: 'User', required: true },
  applicantCount:         { type: Number, default: 0 },
}, { timestamps: true });

export default mongoose.model<IJob>('Job', JobSchema);
