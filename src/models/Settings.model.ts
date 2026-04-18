import mongoose, { Schema, Document } from 'mongoose';

export interface ISettings extends Document {
  userId: mongoose.Types.ObjectId;
  ai: {
    model: string;
    maxCandidatesPerBatch: number;
    defaultShortlistSize: number;
    temperature: number;
  };
  organization: {
    name: string;
    adminEmail: string;
    defaultLocation: string;
  };
}

const SettingsSchema = new Schema<ISettings>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  ai: {
    model:                  { type: String, default: 'gemini-1.5-pro' },
    maxCandidatesPerBatch:  { type: Number, default: 50 },
    defaultShortlistSize:   { type: Number, default: 10 },
    temperature:            { type: Number, default: 0.2 },
  },
  organization: {
    name:            { type: String, default: 'Umurava' },
    adminEmail:      { type: String, default: 'admin@umurava.africa' },
    defaultLocation: { type: String, default: 'Kigali, Rwanda' },
  },
}, { timestamps: true });

export default mongoose.model<ISettings>('Settings', SettingsSchema);
