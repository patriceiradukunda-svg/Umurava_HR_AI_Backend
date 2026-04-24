import { Router, Response } from 'express';
import { protect, AuthRequest } from '../middleware/auth.middleware';
import Settings from '../models/Settings.model';

const router = Router();
router.use(protect);

// GET /api/settings — get current user's settings
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    let settings = await Settings.findOne({ userId: req.user?.id });

    // Auto-create defaults if not found
    if (!settings) {
      settings = await Settings.create({ userId: req.user?.id });
    }

    res.json({ success: true, data: settings });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err });
  }
});

// PATCH /api/settings — update current user's settings
router.patch('/', async (req: AuthRequest, res: Response) => {
  try {
    const allowed = [
      'emailNotifications',
      'autoScreening',
      'screeningThreshold',
      'defaultShortlistSize',
      'timezone',
      'language',
    ];

    const updates: Record<string, unknown> = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const settings = await Settings.findOneAndUpdate(
      { userId: req.user?.id },
      { $set: updates },
      { new: true, upsert: true, runValidators: true }
    );

    res.json({ success: true, data: settings });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err });
  }
});

// DELETE /api/settings — reset settings to defaults
router.delete('/', async (req: AuthRequest, res: Response) => {
  try {
    await Settings.findOneAndDelete({ userId: req.user?.id });
    const settings = await Settings.create({ userId: req.user?.id });
    res.json({ success: true, message: 'Settings reset to defaults', data: settings });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err });
  }
});

export default router;
