# Umurava AI Talent Screening Platform - Backend

Backend server for the **Umurava AI Hackathon Challenge**. It handles the data, security, and the "AI Brain" that powers our candidate screening system.

## Tech Stack
- **Server**: Node.js + TypeScript
- **Database**: MongoDB Atlas 
- **AI**: Google Gemini API 
- **Hosting**: Deployed on **Render**.

## Local Setup
**Install dependencies**:
    ```
    npm install
    ```

**Build and Run**:
    ```
    npm run build
    npm start
    ```
##  Live API
The backend is live and accessible at:
**<a href="https://umurava-hr-ai-backend-1.onrender.com/api" target="_blank">Backend</a>**


##  AI Decision Flow
Our system follows a clear 8-step process to find the best talent:

1. **Start:** The recruiter chooses a job and clicks "Run AI Screening."
2. **Gathering:** The system collects all the applicants waiting for review.
3. **Grouping:** Candidates are put into small groups so the AI can analyze them efficiently.
4. **Instructions:** The AI is given the job requirements and the scoring rules (weights).
   - Full job requirements and required skills
   - All candidate profiles (skills, experience, education, projects, availability)
   - Scoring weights (skills 40%, experience 30%, education 15%, projects 10%, availability 5%)
5. **AI Analysis:** The AI evaluates each person and identifies their **Strengths** and **Gaps**.
6. **Ranking:** The system combines all scores and ranks the candidates from best to worst.
7. **Tagging:** The top candidates are automatically updated to "Shortlisted" in the database.
8. **Display:** The dashboard updates to show the recruiter the final ranked list and the AI’s reasoning.

##  Deployment
- **Platform**: Deployed on **Render**.
- **Database**: Hosted on **MongoDB Atlas**.
- **AI Connectivity**: Securely connected to Google AI Studio.

  
  *Built with ❤️ by Sentarecy team.*
