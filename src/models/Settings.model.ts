import mongoose, { Schema, Document } from 'mongoose';

export interface ISettings extends Document {
  userId:               mongoose.Types.ObjectId;
  emailNotifications:   boolean;
  autoScreening:        boolean;
  screeningThreshold:   number;
  defaultShortlistSize: number;
  timezone:             string;
  language:             string;
  createdAt:            Date;
  updatedAt:            Date;
}

const SettingsSchema = new Schema<ISettings>(
  {
    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
      unique:   true,
    },
    emailNotifications:   { type: Boolean, default: true },
    autoScreening:        { type: Boolean, default: false },
    screeningThreshold:   { type: Number,  default: 70, min: 0, max: 100 },
    defaultShortlistSize: { type: Number,  default: 10, min: 1 },
    timezone:             { type: String,  default: 'Africa/Kigali' },
    language:             { type: String,  default: 'en' },
  },
  { timestamps: true }
);

export default mongoose.model<ISettings>('Settings', SettingsSchema);
