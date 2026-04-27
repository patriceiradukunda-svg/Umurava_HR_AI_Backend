# Umurava AI Screening — Backend

AI-powered HR screening platform backend built with Node.js, Express, TypeScript, MongoDB, and the Gemini API.

## Live API
```
https://umurava-hr-ai-backend-1.onrender.com
```

## Tech Stack
- **Runtime**: Node.js 20 + TypeScript
- **Framework**: Express.js
- **Database**: MongoDB (Mongoose)
- **AI Layer**: Google Gemini API (`gemini-3-flash-preview`)
- **Auth**: JWT + bcryptjs
- **Hosting**: Render

## AI Layer (Gemini API)
The core intelligence is powered by Google Gemini and handles:
- **Job-to-candidate matching** — evaluates each candidate against job requirements using a weighted scoring formula
- **Candidate scoring and ranking** — produces a `matchScore` (0–100) with a full breakdown across 5 dimensions: skills, experience, education, project relevance, and availability
- **Natural-language reasoning** — generates per-candidate strengths, gaps, shortlisting rationale, course recommendations, and pool-level insights

```
matchScore = (skillsMatch×40 + experienceMatch×30 + educationMatch×15 + projectRelevance×10 + availabilityBonus×5) / 100
```

## Project Structure
```
src/
├── index.ts                  # Entry point
├── models/
│   ├── User.model.ts
│   ├── Job.model.ts
│   ├── Applicant.model.ts
│   └── ScreeningResult.model.ts
├── routes/
│   ├── auth.routes.ts
│   ├── job.routes.ts
│   ├── applicant.routes.ts
│   ├── screening.routes.ts
│   ├── dashboard.routes.ts
│   ├── analytics.routes.ts
│   └── settings.routes.ts
├── services/
│   └── gemini.service.ts     # AI screening engine
└── middleware/
    └── auth.middleware.ts
```

## API Endpoints

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | HR login |
| GET | `/api/auth/me` | Current user |

### Jobs
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/jobs` | List all jobs |
| POST | `/api/jobs` | Create job |
| PATCH | `/api/jobs/:id` | Update job |
| DELETE | `/api/jobs/:id` | Delete job |
| GET | `/api/jobs/stats` | Job statistics |

### Applicants
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/applicants` | List applicants (filterable) |
| POST | `/api/applicants` | Add applicant |
| PATCH | `/api/applicants/:id/status` | Update status |
| GET | `/api/applicants/stats` | Applicant statistics |

### AI Screening
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/screening/run` | Trigger AI screening |
| GET | `/api/screening/latest/:jobId` | Latest result for a job |
| GET | `/api/screening/:id/status` | Poll screening progress |
| GET | `/api/screening/test` | Test Gemini connection |

### Dashboard & Analytics
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/dashboard` | Dashboard summary |
| GET | `/api/analytics` | Hiring analytics |

## Environment Variables
```env
MONGODB_URI=your_mongodb_connection_string
JWT_SECRET=your_jwt_secret
GEMINI_API_KEY=your_gemini_api_key
PORT=5000
```

## Local Setup
```bash
git clone https://github.com/patriceiradukunda-svg/Umurava_HR_AI_Backend
cd Umurava_HR_AI_Backend
npm install
cp .env.example .env   # fill in your values
npm run dev
```

## How Screening Works
1. HR selects a job and triggers screening from the dashboard
2. Backend fetches all applicants for that job from MongoDB
3. Applicants are sent to Gemini in batches of 8
4. Gemini evaluates each candidate and returns structured JSON with scores, strengths, gaps, and recommendations
5. Results are ranked by `matchScore` and saved to MongoDB
6. HR views the shortlist instantly on the frontend
7. HR can send email notifications (Shortlisted / Interview / Written Test / Hired / Not Selected) directly from the shortlist page

## Screening Result Structure
```json
{
  "shortlist": [...],
  "allCandidates": [...],
  "insights": {
    "overallSkillGaps": [...],
    "pipelineHealth": "...",
    "hiringRecommendation": "..."
  },
  "totalEvaluated": 7,
  "averageScore": 74,
  "topScore": 99
}
```
