import { Router, Response } from 'express';
import { protect, AuthRequest } from '../middleware/auth.middleware';
import Settings from '../models/Settings.model';

const router = Router();
router.use(protect);

// GET /api/settings
router.get('/', async (req: AuthRequest, res: Response) => {
  let settings = await Settings.findOne({ userId: req.user!.id });
  if (!settings) {
    settings = await Settings.create({ userId: req.user!.id });
  }
  res.json({ success: true, data: settings });
});

// PUT /api/settings/ai — save AI configuration
router.put('/ai', async (req: AuthRequest, res: Response) => {
  const { model, maxCandidatesPerBatch, defaultShortlistSize, temperature } = req.body;
  const settings = await Settings.findOneAndUpdate(
    { userId: req.user!.id },
    { $set: { ai: { model, maxCandidatesPerBatch, defaultShortlistSize, temperature } } },
    { new: true, upsert: true }
  );
  res.json({ success: true, message: 'AI settings saved', data: settings });
});

// PUT /api/settings/organization — save org settings
router.put('/organization', async (req: AuthRequest, res: Response) => {
  const { name, adminEmail, defaultLocation } = req.body;
  const settings = await Settings.findOneAndUpdate(
    { userId: req.user!.id },
    { $set: { organization: { name, adminEmail, defaultLocation } } },
    { new: true, upsert: true }
  );
  res.json({ success: true, message: 'Organization settings saved', data: settings });
});

export default router;
