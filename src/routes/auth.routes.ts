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
  try {
    const { firstName, lastName, email, password, role, department, organization } = req.body;

    if (!firstName || !lastName || !email || !password) {
      res.status(400).json({ success: false, message: 'All fields are required' });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
      return;
    }

    // Security: anyone trying to register as recruiter or admin gets applicant role
    const safeRole = (role === 'recruiter' || role === 'admin') ? 'applicant' : (role || 'applicant');

    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      res.status(409).json({ success: false, message: 'This email is already registered' });
      return;
    }

    const user = await User.create({
      firstName: firstName.trim(),
      lastName:  lastName.trim(),
      email:     email.toLowerCase().trim(),
      password,
      role:      safeRole,
      department:   department   || undefined,
      organization: organization || 'Umurava',
    });

    // Create settings — ignore if already exists
    try {
      await Settings.create({ userId: user._id });
    } catch {
      // Settings already exist — not a problem
    }

    const token = signToken(user._id.toString(), user.email, user.role);

    res.status(201).json({
      success: true,
      message: 'Account created successfully',
      token,
      user: {
        id:        user._id,
        firstName: user.firstName,
        lastName:  user.lastName,
        email:     user.email,
        role:      user.role,
      },
    });

  } catch (err: any) {
    console.error('❌ Register error:', err.message, err);
    if (err.code === 11000) {
      res.status(409).json({ success: false, message: 'This email is already registered' });
      return;
    }
    res.status(500).json({ success: false, message: err.message || 'Registration failed' });
  }
});

// POST /api/auth/register-hr — protected, admin only
router.post('/register-hr', protect, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ success: false, message: 'Only admins can create HR accounts' });
      return;
    }

    const { firstName, lastName, email, password, role, department, organization } = req.body;

    if (!firstName || !lastName || !email || !password) {
      res.status(400).json({ success: false, message: 'All fields are required' });
      return;
    }

    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      res.status(409).json({ success: false, message: 'This email is already registered' });
      return;
    }

    const user = await User.create({
      firstName: firstName.trim(),
      lastName:  lastName.trim(),
      email:     email.toLowerCase().trim(),
      password,
      role:      role === 'admin' ? 'admin' : 'recruiter',
      department:   department   || undefined,
      organization: organization || 'Umurava',
    });

    try {
      await Settings.create({ userId: user._id });
    } catch {
      // Settings already exist — not a problem
    }

    const token = signToken(user._id.toString(), user.email, user.role);

    res.status(201).json({
      success: true,
      message: 'HR account created successfully',
      token,
      user: {
        id:        user._id,
        firstName: user.firstName,
        lastName:  user.lastName,
        email:     user.email,
        role:      user.role,
      },
    });

  } catch (err: any) {
    console.error('❌ Register HR error:', err.message, err);
    if (err.code === 11000) {
      res.status(409).json({ success: false, message: 'This email is already registered' });
      return;
    }
    res.status(500).json({ success: false, message: err.message || 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ success: false, message: 'Email and password required' });
      return;
    }

    const user = await User.findOne({
      email: email.toLowerCase().trim(),
      isActive: true,
    }).select('+password');

    if (!user || !(await user.comparePassword(password))) {
      res.status(401).json({ success: false, message: 'Invalid email or password' });
      return;
    }

    user.lastLoginAt = new Date();
    await user.save({ validateBeforeSave: false });

    const token = signToken(user._id.toString(), user.email, user.role);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id:         user._id,
        firstName:  user.firstName,
        lastName:   user.lastName,
        email:      user.email,
        role:       user.role,
        department: user.department,
      },
    });

  } catch (err: any) {
    console.error('❌ Login error:', err.message, err);
    res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
  }
});

// GET /api/auth/me
router.get('/me', protect, async (req: AuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.user?.id).select('-password');
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }
    res.status(200).json({ success: true, user });
  } catch (err: any) {
    console.error('❌ Me error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get user' });
  }
});

// PATCH /api/auth/change-password
router.patch('/change-password', protect, async (req: AuthRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      res.status(400).json({ success: false, message: 'Both passwords are required' });
      return;
    }

    if (newPassword.length < 6) {
      res.status(400).json({ success: false, message: 'New password must be at least 6 characters' });
      return;
    }

    const user = await User.findById(req.user?.id).select('+password');
    if (!user || !(await user.comparePassword(currentPassword))) {
      res.status(401).json({ success: false, message: 'Current password is incorrect' });
      return;
    }

    user.password = newPassword;
    await user.save();

    res.status(200).json({ success: true, message: 'Password updated successfully' });

  } catch (err: any) {
    console.error('❌ Change password error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update password' });
  }
});

export default router;
