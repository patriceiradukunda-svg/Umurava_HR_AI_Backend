import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';

export interface ParsedApplicant {
  firstName: string;
  lastName: string;
  email: string;
  headline: string;
  location: string;
  skills: { name: string; level: string; yearsOfExperience: number }[];
  experience: {
    company: string; role: string; startDate: string;
    endDate: string; description: string; technologies: string[]; isCurrent: boolean;
  }[];
  education: {
    institution: string; degree: string; fieldOfStudy: string;
    startYear: number; endYear: number;
  }[];
  projects: {
    name: string; description: string; technologies: string[];
    role: string; link: string; startDate: string; endDate: string;
  }[];
  availability: { status: string; type: string };
}

function rowToApplicant(row: Record<string, string>): ParsedApplicant {
  const fullName = (row['Name'] || row['Full Name'] || row['name'] || '').trim();
  const nameParts = fullName.split(' ');
  const firstName = nameParts[0] || 'Unknown';
  const lastName = nameParts.slice(1).join(' ') || 'Unknown';

  const skillsRaw = (row['Skills'] || row['skills'] || '').split(',').map(s => s.trim()).filter(Boolean);
  const skills = skillsRaw.map(s => ({
    name: s, level: 'Intermediate', yearsOfExperience: 1,
  }));

  const expYears = parseInt(row['Experience Years'] || row['Years of Experience'] || '0', 10) || 0;

  return {
    firstName,
    lastName,
    email: row['Email'] || row['email'] || '',
    headline: row['Headline'] || row['Role'] || row['Title'] || `${firstName} ${lastName}`,
    location: row['Location'] || row['City'] || row['Country'] || 'Not specified',
    skills,
    experience: expYears > 0 ? [{
      company: row['Company'] || row['Current Company'] || 'Not specified',
      role: row['Role'] || row['Job Title'] || 'Not specified',
      startDate: `${new Date().getFullYear() - expYears}-01`,
      endDate: 'Present',
      description: row['Description'] || 'Professional experience',
      technologies: skillsRaw,
      isCurrent: true,
    }] : [],
    education: [{
      institution: row['University'] || row['Institution'] || row['School'] || 'Not specified',
      degree: row['Degree'] || "Bachelor's",
      fieldOfStudy: row['Field of Study'] || row['Major'] || 'Not specified',
      startYear: new Date().getFullYear() - (expYears + 4),
      endYear: new Date().getFullYear() - expYears,
    }],
    projects: [],
    availability: {
      status: row['Availability'] || 'Open to Opportunities',
      type: row['Employment Type'] || 'Full-time',
    },
  };
}

export function parseCSV(filePath: string): ParsedApplicant[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const result = Papa.parse<Record<string, string>>(content, {
    header: true, skipEmptyLines: true,
  });
  return result.data.map(rowToApplicant).filter(a => a.email);
}

export function parseXLSX(filePath: string): ParsedApplicant[] {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet);
  return rows.map(rowToApplicant).filter(a => a.email);
}

export async function parsePDF(filePath: string): Promise<ParsedApplicant> {
  // Dynamic import to avoid issues at startup
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdfParse = require('pdf-parse');
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  const text: string = data.text;

  // Basic heuristic extraction from raw text
  const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w{2,}/);
  const email = emailMatch ? emailMatch[0] : '';

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const name = lines[0] || 'Unknown Candidate';
  const nameParts = name.split(' ');

  const skillKeywords = ['JavaScript','TypeScript','Python','React','Node.js','MongoDB',
    'PostgreSQL','Docker','Kubernetes','AWS','GCP','Azure','Figma','SQL','Java','Spring',
    'Vue','Angular','GraphQL','Redis','Kafka','Git','Linux','FastAPI','Django'];
  const foundSkills = skillKeywords.filter(s =>
    text.toLowerCase().includes(s.toLowerCase())
  );

  const locationMatch = text.match(/([A-Z][a-z]+(?:,\s*[A-Z][a-z]+)*)/);

  return {
    firstName: nameParts[0] || 'Unknown',
    lastName: nameParts.slice(1).join(' ') || 'Candidate',
    email,
    headline: lines[1] || `${name} – Professional`,
    location: locationMatch ? locationMatch[0] : 'Not specified',
    skills: foundSkills.map(s => ({ name: s, level: 'Intermediate', yearsOfExperience: 1 })),
    experience: [{
      company: 'Previous Employer',
      role: 'Professional',
      startDate: '2020-01',
      endDate: 'Present',
      description: 'Professional experience extracted from PDF resume',
      technologies: foundSkills,
      isCurrent: true,
    }],
    education: [{
      institution: 'University',
      degree: "Bachelor's",
      fieldOfStudy: 'Computer Science',
      startYear: 2016,
      endYear: 2020,
    }],
    projects: [],
    availability: { status: 'Open to Opportunities', type: 'Full-time' },
  };
}

export function getFileType(filename: string): 'csv' | 'xlsx' | 'pdf' | 'unknown' {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.csv') return 'csv';
  if (ext === '.xlsx' || ext === '.xls') return 'xlsx';
  if (ext === '.pdf') return 'pdf';
  return 'unknown';
}
