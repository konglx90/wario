export type RiskLevel = 'L1' | 'L2' | 'L3';
export type Verdict = 'approve' | 'reject' | 'comment';
export type ReviewStatus = 'pending' | 'decided';
export type ContentType = 'requirement' | 'plan' | 'code';
export type ReviewerKind = 'claude' | 'codex';

export interface Project {
  id: string;
  slug: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RiskFinding {
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: string;
  description: string;
  location?: string;
  suggestion?: string;
}

export interface ResumeRound {
  question: string;
  answer: string;
  findings?: RiskFinding[];
  at: string;
}

export interface RiskReport {
  byAgent: ReviewerKind;
  reviewSessionId: string;
  riskLevel: RiskLevel;
  summary: string;
  findings: RiskFinding[];
  resumeRounds?: ResumeRound[];
  createdAt: string;
}

export interface ReviewDecision {
  reviewer: string;
  verdict: Verdict;
  comment?: string;
  decidedAt: string;
}

export interface ReviewContext {
  title: string;
  description?: string;
  diff?: string;
  tags?: string[];
  source?: string;
  sourceRef?: string;
}

export interface ReviewRequest {
  id: string;
  projectId: string;
  pushedBy: string;
  sessionId: string;
  context: ReviewContext;
  selfAssessedRisk?: RiskLevel;
  contentType?: ContentType;
  status: ReviewStatus;
  preReview?: RiskReport;
  reviewSessionId?: string;
  decision?: ReviewDecision;
  createdAt: string;
  decidedAt?: string;
}

export interface PushReviewInput {
  projectSlug: string;
  pushedBy: string;
  sessionId: string;
  title: string;
  description?: string;
  diff?: string;
  tags?: string[];
  source?: string;
  sourceRef?: string;
  selfAssessedRisk?: RiskLevel;
  contentType?: ContentType;
}

export interface ListReviewFilter {
  projectSlug: string;
  status?: ReviewStatus;
  limit?: number;
}

export interface DecideReviewInput {
  reviewId: string;
  reviewer: string;
  verdict: Verdict;
  comment?: string;
}