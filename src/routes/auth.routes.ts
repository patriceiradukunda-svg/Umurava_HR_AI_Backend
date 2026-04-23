import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.model';
import Settings from '../models/Settings.model';
import { protect, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

const signToken = (id: string, email: string, role: string): string =>
  jwt.sign(
    { id, email, role },
    process.env.JWT_SECRET as string,
    { expiresIn: '7d' }
  );

// POST /api/auth/register — public, always creates applicant account
router.post('/register', async (req: Request, res: Response) => {
  const { firstName, lastName, email, password, role, department, organization } = req.body;

  if (!firstName || !lastName || !email || !password) {
    res.status(400).json({ success: false, message: 'All fields are required' });
    return;
  }

  // Security: prevent anyone from self-registering as recruiter or admin
  const safeRole = role === 'recruiter' || role === 'admin' ? 'applicant' : (role || 'applicant');

  const existing = await User.findOne({ email });
  if (existing) {
    res.status(409).json({ success: false, message: 'Email already registered' });
    return;
  }

  const user = await User.create({
    firstName, lastName, email, password,
    role: safeRole,
    department,
    organization,
  });

  await Settings.create({ userId: user._id });

  const token = signToken(user._id.toString(), user.email, user.role);
  res.status(201).json({
    success: true,
    message: 'Account created successfully',
    token,
    user: {
      id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role,
    },
  });
});

// POST /api/auth/register-hr — protected, admin only, creates recruiter/admin accounts
router.post('/register-hr', protect, async (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ success: false, message: 'Only admins can create HR accounts' });
    return;
  }

  const { firstName, lastName, email, password, role, department, organization } = req.body;

  if (!firstName || !lastName || !email || !password) {
    res.status(400).json({ success: false, message: 'All fields are required' });
    return;
  }

  const existing = await User.findOne({ email });
  if (existing) {
    res.status(409).json({ success: false, message: 'Email already registered' });
    return;
  }

  const user = await User.create({
    firstName, lastName, email, password,
    role: role === 'admin' ? 'admin' : 'recruiter',
    department,
    organization,
  });

  await Settings.create({ userId: user._id });

  const token = signToken(user._id.toString(), user.email, user.role);
  res.status(201).json({
    success: true,
    message: 'HR account created successfully',
    token,
    user: {
      id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role,
    },
  });
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ success: false, message: 'Email and password required' });
    return;
  }

  const user = await User.findOne({ email, isActive: true }).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    res.status(401).json({ success: false, message: 'Invalid credentials' });
    return;
  }

  user.lastLoginAt = new Date();
  await user.save({ validateBeforeSave: false });

  const token = signToken(user._id.toString(), user.email, user.role);
  res.json({
    success: true,
    token,
    user: {
      id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role,
      department: user.department,
    },
  });
});

// GET /api/auth/me
router.get('/me', protect, async (req: AuthRequest, res: Response) => {
  const user = await User.findById(req.user?.id).select('-password');
  res.json({ success: true, user });
});

export default router;
