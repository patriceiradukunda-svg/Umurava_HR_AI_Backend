# Umurava TalentAI — Backend API

Node.js + TypeScript backend powering the Umurava AI HR Screening Platform.

## Stack
- **Runtime**: Node.js + TypeScript
- **Framework**: Express.js
- **Database**: MongoDB Atlas (Mongoose)
- **AI**: Google Gemini API (`gemini-1.5-pro`)
- **Auth**: JWT (Bearer token)
- **File Parsing**: CSV, XLSX, PDF

---

## Setup

```bash
npm install
cp .env.example .env   # fill in your values
npm run seed           # seed DB with demo users + jobs + applicants
npm run dev            # start dev server on port 5000
```

### Environment Variables
```
PORT=5000
MONGODB_URI=mongodb+srv://...
GEMINI_API_KEY=AIza...
FRONTEND_URL=https://hr-talent-ai-solution-m1dp.vercel.app
JWT_SECRET=your_secret
JWT_EXPIRES_IN=7d
```

### Demo Credentials (after seed)
- **Admin**: admin@umurava.africa / Admin@1234
- **Recruiter**: recruiter@umurava.africa / Recruiter@1234

---

## API Reference

All protected routes require: `Authorization: Bearer <token>`

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register recruiter |
| POST | `/api/auth/login` | Login → returns JWT |
| GET  | `/api/auth/me` | Get current user |

### Dashboard
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/dashboard` | Stats, recent jobs, AI activity chart |

### Jobs
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | `/api/jobs` | List all jobs (filter: status, location, department, search) |
| GET    | `/api/jobs/stats` | Count by status |
| GET    | `/api/jobs/:id` | Single job |
| POST   | `/api/jobs` | Create job |
| PUT    | `/api/jobs/:id` | Update job |
| PATCH  | `/api/jobs/:id/status` | Change status only |
| DELETE | `/api/jobs/:id` | Delete job + its applicants |
| GET    | `/api/jobs/:id/applicants` | Applicants for a specific job |

### Applicants
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | `/api/applicants` | List all (filter: jobId, status, source, search, page, limit) |
| GET    | `/api/applicants/stats` | Count by status |
| GET    | `/api/applicants/:id` | Single applicant |
| POST   | `/api/applicants` | Add one (Umurava platform profile) |
| POST   | `/api/applicants/bulk` | Add many profiles at once |
| POST   | `/api/applicants/upload` | Upload CSV / XLSX / PDF files |
| PATCH  | `/api/applicants/:id/status` | Update status |
| DELETE | `/api/applicants/:id` | Delete applicant |

### AI Screening
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | `/api/screening` | List all screening runs |
| GET    | `/api/screening/latest/:jobId` | Latest completed screening for a job |
| GET    | `/api/screening/:id` | Full screening result with shortlist |
| POST   | `/api/screening/run` | **Trigger AI screening** |
| GET    | `/api/screening/:id/status` | Poll status (running/completed/failed) |
| DELETE | `/api/screening/:id` | Delete result |

#### POST /api/screening/run — body:
```json
{
  "jobId": "...",
  "shortlistSize": 10,
  "weights": {
    "skillsMatch": 40,
    "experienceMatch": 30,
    "educationMatch": 15,
    "projectRelevance": 10,
    "availabilityBonus": 5
  }
}
```
Returns `202 Accepted` immediately with `screeningId`. Poll `/api/screening/:id/status` until `status === "completed"`, then fetch `/api/screening/:id` for full results.

### Analytics
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/analytics` | Full analytics data (score distribution, skill gaps, pipeline) |
| GET | `/api/analytics/pipeline/:jobId` | Kanban pipeline data for one job |

### Settings
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/settings` | Get current user settings |
| PUT | `/api/settings/ai` | Save AI configuration |
| PUT | `/api/settings/organization` | Save org info |

---

## AI Decision Flow

1. Recruiter selects a job and clicks **Run AI Screening**
2. Backend fetches all `pending`/`screened` applicants for that job
3. Applicants are batched (20 per batch) and sent to **Gemini 1.5 Pro**
4. Each batch gets a structured prompt with:
   - Full job requirements and required skills
   - All candidate profiles (skills, experience, education, projects, availability)
   - Scoring weights (skills 40%, experience 30%, education 15%, projects 10%, availability 5%)
5. Gemini returns JSON with ranked candidates, score breakdowns, strengths, gaps, and recommendation
6. Results are merged, sorted by `matchScore`, top N saved to `ScreeningResult` collection
7. Shortlisted applicants get `status: "shortlisted"` in `Applicant` collection
8. Frontend polls `/api/screening/:id/status` and shows results when complete

## Assumptions & Limitations
- PDF parsing is heuristic-based; structured JSON profiles produce more accurate AI scores
- Gemini API rate limits may slow large batches (>100 applicants)
- AI accuracy rating (94%) is illustrative; real accuracy requires recruiter feedback loop
- No real-time WebSocket — frontend polls every 3s for screening status
