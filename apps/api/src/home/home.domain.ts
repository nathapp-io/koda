import type { PrismaHomeRepository } from './prisma-home.repository';
import type { HomeApprovalScope, HomeCaller } from './home.types';

/** Read-model port of the home dashboard, so tests can fake the aggregation input. */
export interface IHomeRepository {
  findProjects(caller: HomeCaller): ReturnType<PrismaHomeRepository['findProjects']>;
  findMyTickets(userId: string, projectIds: string[], take: number): ReturnType<PrismaHomeRepository['findMyTickets']>;
  countMyTickets(userId: string, projectIds: string[]): Promise<number>;
  findPendingApprovals(scope: HomeApprovalScope, take: number): ReturnType<PrismaHomeRepository['findPendingApprovals']>;
  countPendingApprovals(scope: HomeApprovalScope): Promise<number>;
  findFailedJobs(projectIds: string[], since: Date, take: number): ReturnType<PrismaHomeRepository['findFailedJobs']>;
  countFailedJobs(projectIds: string[], since: Date): Promise<number>;
  findBlockedJobs(jobIds: string[], take: number): ReturnType<PrismaHomeRepository['findBlockedJobs']>;
  countBlockedJobs(jobIds: string[]): Promise<number>;
  countOpenTicketsByProject(projectIds: string[]): Promise<Map<string, number>>;
  countAttentionJobsByProject(projectIds: string[], since: Date, blockedJobIds: string[]): Promise<Map<string, number>>;
  findRecentActivity(projectIds: string[], takePerTable: number): ReturnType<PrismaHomeRepository['findRecentActivity']>;
}

export const HOME_REPOSITORY = Symbol('HOME_REPOSITORY');
