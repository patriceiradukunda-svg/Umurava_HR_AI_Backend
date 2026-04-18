import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import User from '../models/User.model';
import Job from '../models/Job.model';
import Applicant from '../models/Applicant.model';
import Settings from '../models/Settings.model';

const MONGO_URI = process.env.MONGODB_URI as string;

const seedUsers = async () => {
  await User.deleteMany({});
  const admin = await User.create({
    firstName: 'Amina',
    lastName: 'Nzabonimpa',
    email: 'admin@umurava.africa',
    password: 'Admin@1234',
    role: 'admin',
    department: 'HR Operations',
    organization: 'Umurava',
  });
  const recruiter = await User.create({
    firstName: 'Robert',
    lastName: 'Kagabo',
    email: 'recruiter@umurava.africa',
    password: 'Recruiter@1234',
    role: 'recruiter',
    department: 'Talent Acquisition',
    organization: 'Umurava',
  });
  await Settings.create({ userId: admin._id });
  await Settings.create({ userId: recruiter._id });
  console.log('✅ Users seeded: admin@umurava.africa / Admin@1234');
  return { admin, recruiter };
};

const seedJobs = async (createdBy: mongoose.Types.ObjectId) => {
  await Job.deleteMany({});
  const jobs = await Job.insertMany([
    {
      title: 'Senior Backend Engineer',
      department: 'Engineering',
      location: 'Kigali, Rwanda',
      type: 'Full-time',
      description: 'Build and scale core API infrastructure using Node.js and TypeScript.',
      requirements: ['3+ years Node.js', 'TypeScript', 'MongoDB', 'REST API design'],
      requiredSkills: ['Node.js', 'TypeScript', 'MongoDB', 'REST API Design', 'Docker'],
      niceToHaveSkills: ['Redis', 'Gemini API', 'AWS'],
      minimumExperienceYears: 3,
      shortlistSize: 10,
      status: 'active',
      createdBy,
      applicantCount: 0,
    },
    {
      title: 'AI / ML Engineer',
      department: 'Engineering',
      location: 'Kigali, Rwanda (Remote OK)',
      type: 'Full-time',
      description: 'Design AI screening pipelines using Gemini API and LLM prompt engineering.',
      requirements: ['2+ years LLM experience', 'Python', 'Gemini API', 'FastAPI'],
      requiredSkills: ['Python', 'LLM Prompt Engineering', 'Gemini API', 'FastAPI', 'Docker'],
      niceToHaveSkills: ['TensorFlow', 'Node.js', 'MongoDB'],
      minimumExperienceYears: 2,
      shortlistSize: 10,
      status: 'active',
      createdBy,
      applicantCount: 0,
    },
    {
      title: 'Frontend Engineer',
      department: 'Engineering',
      location: 'Kigali, Rwanda',
      type: 'Full-time',
      description: 'Build pixel-perfect recruiter dashboard using Next.js and Tailwind CSS.',
      requirements: ['3+ years React/Next.js', 'TypeScript', 'Tailwind CSS', 'Redux'],
      requiredSkills: ['React', 'Next.js', 'TypeScript', 'Tailwind CSS', 'Redux'],
      niceToHaveSkills: ['Storybook', 'Testing Library', 'Figma'],
      minimumExperienceYears: 3,
      shortlistSize: 10,
      status: 'active',
      createdBy,
      applicantCount: 0,
    },
    {
      title: 'Data Engineer',
      department: 'Data',
      location: 'Kigali, Rwanda (Hybrid)',
      type: 'Full-time',
      description: 'Build ETL pipelines and data warehouse for analytics and AI features.',
      requirements: ['3+ years data engineering', 'Python', 'SQL', 'BigQuery', 'dbt'],
      requiredSkills: ['Python', 'SQL', 'BigQuery', 'dbt', 'Airflow'],
      niceToHaveSkills: ['Kafka', 'Spark', 'Looker'],
      minimumExperienceYears: 3,
      shortlistSize: 10,
      status: 'draft',
      createdBy,
      applicantCount: 0,
    },
    {
      title: 'DevOps Engineer',
      department: 'Engineering',
      location: 'Remote',
      type: 'Full-time',
      description: 'Own infrastructure reliability, Kubernetes clusters, and CI/CD pipelines.',
      requirements: ['3+ years DevOps', 'Kubernetes', 'Docker', 'Terraform', 'AWS'],
      requiredSkills: ['Kubernetes', 'Docker', 'Terraform', 'AWS', 'CI/CD (GitHub Actions)'],
      niceToHaveSkills: ['Prometheus', 'Grafana', 'Linux'],
      minimumExperienceYears: 3,
      shortlistSize: 10,
      status: 'closed',
      createdBy,
      applicantCount: 0,
    },
  ]);
  console.log(`✅ ${jobs.length} jobs seeded`);
  return jobs;
};

const seedApplicants = async (jobs: Awaited<ReturnType<typeof seedJobs>>) => {
  await Applicant.deleteMany({});

  const backendJob = jobs[0];
  const aiJob = jobs[1];
  const frontendJob = jobs[2];

  const applicants = [
    // Backend job applicants
    {
      jobId: backendJob._id, source: 'umurava_platform', status: 'shortlisted', aiScore: 95, skillsMatchPct: 98,
      talentProfile: {
        firstName: 'Alice', lastName: 'Mukamana', email: 'alice.mukamana@gmail.com',
        headline: 'Senior Backend Engineer – Node.js & AI Systems', location: 'Kigali, Rwanda',
        skills: [
          { name: 'Node.js', level: 'Expert', yearsOfExperience: 5 },
          { name: 'TypeScript', level: 'Expert', yearsOfExperience: 4 },
          { name: 'MongoDB', level: 'Advanced', yearsOfExperience: 4 },
          { name: 'Docker', level: 'Intermediate', yearsOfExperience: 2 },
          { name: 'REST API Design', level: 'Expert', yearsOfExperience: 5 },
        ],
        languages: [{ name: 'English', proficiency: 'Fluent' }, { name: 'Kinyarwanda', proficiency: 'Native' }],
        experience: [{
          company: 'Andela', role: 'Senior Backend Engineer',
          startDate: '2022-03', endDate: 'Present',
          description: 'Led backend architecture for 3 client products, REST APIs serving 200k+ daily requests.',
          technologies: ['Node.js', 'TypeScript', 'PostgreSQL', 'Redis', 'AWS'], isCurrent: true,
        }],
        education: [{ institution: 'University of Rwanda', degree: "Bachelor's", fieldOfStudy: 'Computer Science', startYear: 2016, endYear: 2020 }],
        certifications: [{ name: 'AWS Certified Developer', issuer: 'Amazon', issueDate: '2022-07' }],
        projects: [{
          name: 'AI Recruitment System', description: 'AI candidate screening with Gemini API',
          technologies: ['Node.js', 'TypeScript', 'Gemini API', 'MongoDB'],
          role: 'Backend Engineer', link: 'https://github.com/alicemukamana/ai-recruit',
          startDate: '2023-09', endDate: '2024-01',
        }],
        availability: { status: 'Available', type: 'Full-time', startDate: '2024-05-01' },
        socialLinks: { linkedin: 'https://linkedin.com/in/alicemukamana', github: 'https://github.com/alicemukamana' },
      },
    },
    {
      jobId: backendJob._id, source: 'umurava_platform', status: 'shortlisted', aiScore: 78, skillsMatchPct: 72,
      talentProfile: {
        firstName: 'Kevin', lastName: 'Irakoze', email: 'kevin.irakoze@gmail.com',
        headline: 'Backend Engineer – Python & Microservices', location: 'Kigali, Rwanda',
        skills: [
          { name: 'Python', level: 'Expert', yearsOfExperience: 5 },
          { name: 'FastAPI', level: 'Advanced', yearsOfExperience: 3 },
          { name: 'Node.js', level: 'Intermediate', yearsOfExperience: 2 },
          { name: 'Docker', level: 'Advanced', yearsOfExperience: 4 },
          { name: 'PostgreSQL', level: 'Advanced', yearsOfExperience: 4 },
        ],
        languages: [{ name: 'English', proficiency: 'Fluent' }],
        experience: [{
          company: 'Zipline International', role: 'Backend Engineer',
          startDate: '2021-03', endDate: 'Present',
          description: 'Real-time telemetry pipeline processing 500k+ drone events/day.',
          technologies: ['Python', 'FastAPI', 'Kafka', 'PostgreSQL', 'Docker'], isCurrent: true,
        }],
        education: [{ institution: 'African Leadership University', degree: "Bachelor's", fieldOfStudy: 'Software Engineering', startYear: 2015, endYear: 2019 }],
        certifications: [{ name: 'GCP Professional Cloud Architect', issuer: 'Google', issueDate: '2022-12' }],
        projects: [{
          name: 'DroneOps Platform', description: 'Microservices backend for drone fleet monitoring',
          technologies: ['Python', 'FastAPI', 'Kafka', 'gRPC', 'Docker'],
          role: 'Backend Engineer', link: 'https://github.com/kevirakoze/droneops',
          startDate: '2022-09', endDate: '2023-04',
        }],
        availability: { status: 'Open to Opportunities', type: 'Full-time', startDate: '2024-08-01' },
        socialLinks: { linkedin: 'https://linkedin.com/in/kevirakoze', github: 'https://github.com/kevirakoze' },
      },
    },
    {
      jobId: backendJob._id, source: 'umurava_platform', status: 'screened', aiScore: 41, skillsMatchPct: 38,
      talentProfile: {
        firstName: 'Solange', lastName: 'Nyiraneza', email: 'solange.nyiraneza@gmail.com',
        headline: 'Junior Backend Developer – Node.js & APIs', location: 'Huye, Rwanda',
        skills: [
          { name: 'Node.js', level: 'Intermediate', yearsOfExperience: 1 },
          { name: 'JavaScript', level: 'Intermediate', yearsOfExperience: 2 },
          { name: 'PostgreSQL', level: 'Beginner', yearsOfExperience: 1 },
        ],
        languages: [{ name: 'English', proficiency: 'Conversational' }, { name: 'Kinyarwanda', proficiency: 'Native' }],
        experience: [{
          company: 'Umurava', role: 'Backend Developer Intern',
          startDate: '2023-09', endDate: '2024-02',
          description: 'Built REST API endpoints, wrote unit tests.',
          technologies: ['Node.js', 'Express.js', 'PostgreSQL', 'Jest'], isCurrent: false,
        }],
        education: [{ institution: 'National University of Rwanda', degree: "Bachelor's", fieldOfStudy: 'Computer Science', startYear: 2019, endYear: 2023 }],
        certifications: [],
        projects: [{
          name: 'Student Results Portal', description: 'Academic results management system',
          technologies: ['Node.js', 'Express.js', 'PostgreSQL'],
          role: 'Full Stack Developer', link: 'https://github.com/solangenyiraneza/results-portal',
          startDate: '2023-01', endDate: '2023-05',
        }],
        availability: { status: 'Available', type: 'Full-time', startDate: '2024-05-01' },
        socialLinks: { github: 'https://github.com/solangenyiraneza' },
      },
    },
    // AI job applicants
    {
      jobId: aiJob._id, source: 'umurava_platform', status: 'shortlisted', aiScore: 97, skillsMatchPct: 100,
      talentProfile: {
        firstName: 'Grace', lastName: 'Uwase', email: 'grace.uwase@protonmail.com',
        headline: 'AI/ML Engineer – LLM Systems & Prompt Engineering', location: 'Nairobi, Kenya',
        skills: [
          { name: 'Python', level: 'Expert', yearsOfExperience: 6 },
          { name: 'LLM Prompt Engineering', level: 'Expert', yearsOfExperience: 2 },
          { name: 'Gemini API', level: 'Expert', yearsOfExperience: 1 },
          { name: 'FastAPI', level: 'Advanced', yearsOfExperience: 3 },
          { name: 'TensorFlow', level: 'Advanced', yearsOfExperience: 3 },
        ],
        languages: [{ name: 'English', proficiency: 'Native' }, { name: 'Swahili', proficiency: 'Fluent' }],
        experience: [{
          company: 'Safaricom', role: 'AI/ML Engineer',
          startDate: '2022-01', endDate: 'Present',
          description: 'NLP pipeline 94% accuracy. LLM knowledge base for 3000+ employees.',
          technologies: ['Python', 'TensorFlow', 'FastAPI', 'Docker', 'GCP'], isCurrent: true,
        }],
        education: [
          { institution: 'University of Nairobi', degree: "Master's", fieldOfStudy: 'Artificial Intelligence', startYear: 2017, endYear: 2019 },
          { institution: 'Strathmore University', degree: "Bachelor's", fieldOfStudy: 'Computer Science', startYear: 2013, endYear: 2017 },
        ],
        certifications: [
          { name: 'Google Professional ML Engineer', issuer: 'Google', issueDate: '2023-02' },
          { name: 'DeepLearning.AI TensorFlow Developer', issuer: 'DeepLearning.AI', issueDate: '2021-08' },
        ],
        projects: [{
          name: 'LLM Interview Coach', description: 'AI mock interview with Gemini API',
          technologies: ['Python', 'Gemini API', 'FastAPI', 'React'],
          role: 'AI Engineer', link: 'https://github.com/graceuwase/llm-interview-coach',
          startDate: '2023-06', endDate: '2023-10',
        }],
        availability: { status: 'Open to Opportunities', type: 'Full-time', startDate: '2024-07-01' },
        socialLinks: { linkedin: 'https://linkedin.com/in/graceuwase', github: 'https://github.com/graceuwase' },
      },
    },
    // Frontend job applicants
    {
      jobId: frontendJob._id, source: 'umurava_platform', status: 'shortlisted', aiScore: 98, skillsMatchPct: 100,
      talentProfile: {
        firstName: 'Sandrine', lastName: 'Uwimana', email: 'sandrine.uwimana@outlook.com',
        headline: 'Frontend Engineer – Next.js & Design Systems', location: 'Kigali, Rwanda',
        skills: [
          { name: 'Next.js', level: 'Expert', yearsOfExperience: 3 },
          { name: 'React', level: 'Expert', yearsOfExperience: 4 },
          { name: 'TypeScript', level: 'Advanced', yearsOfExperience: 3 },
          { name: 'Tailwind CSS', level: 'Expert', yearsOfExperience: 3 },
          { name: 'Redux Toolkit', level: 'Advanced', yearsOfExperience: 3 },
        ],
        languages: [{ name: 'English', proficiency: 'Fluent' }, { name: 'Kinyarwanda', proficiency: 'Native' }],
        experience: [{
          company: 'Umurava', role: 'Frontend Engineer',
          startDate: '2022-04', endDate: 'Present',
          description: 'Built Competence platform frontend serving 20k+ profiles. Lighthouse score 54→91.',
          technologies: ['Next.js', 'TypeScript', 'Tailwind CSS', 'Redux Toolkit', 'Storybook'], isCurrent: true,
        }],
        education: [{ institution: 'Kepler College', degree: "Bachelor's", fieldOfStudy: 'Computer Science', startYear: 2016, endYear: 2020 }],
        certifications: [{ name: 'Accessibility in Web Design', issuer: 'IDF', issueDate: '2022-02' }],
        projects: [{
          name: 'Umurava UI Library', description: '80+ component library with Tailwind + Storybook',
          technologies: ['React', 'TypeScript', 'Tailwind CSS', 'Storybook'],
          role: 'Lead Frontend Engineer', link: 'https://github.com/sandrineuwimana/umurava-ui',
          startDate: '2023-02', endDate: '2023-09',
        }],
        availability: { status: 'Available', type: 'Full-time', startDate: '2024-05-01' },
        socialLinks: { linkedin: 'https://linkedin.com/in/sandrineuwimana', github: 'https://github.com/sandrineuwimana' },
      },
    },
  ];

  const inserted = await Applicant.insertMany(applicants);

  // Update job applicant counts
  await Job.findByIdAndUpdate(backendJob._id,  { applicantCount: 3 });
  await Job.findByIdAndUpdate(aiJob._id,       { applicantCount: 1 });
  await Job.findByIdAndUpdate(frontendJob._id, { applicantCount: 1 });

  console.log(`✅ ${inserted.length} applicants seeded`);
};

const seed = async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ MongoDB connected for seeding');

    const { admin } = await seedUsers();
    const jobs = await seedJobs(admin._id as mongoose.Types.ObjectId);
    await seedApplicants(jobs);

    console.log('\n🎉 Seed complete!');
    console.log('   Login: admin@umurava.africa / Admin@1234');
    console.log('   Login: recruiter@umurava.africa / Recruiter@1234');
    process.exit(0);
  } catch (err) {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  }
};

seed();
