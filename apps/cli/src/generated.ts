// This file is a stub - normally generated from OpenAPI spec
// In production, use: bun run generate

import { AxiosInstance } from 'axios';

export interface Project {
  id: string;
  name: string;
  key: string;
  slug: string;
  description?: string;
}

export interface Comment {
  id: string;
  body: string;
  type: 'verification' | 'fix_report' | 'review' | 'general';
  ticketId: string;
  createdAt: string;
}

export interface Agent {
  id: string;
  name: string;
  slug: string;
  apiKey: string;
}

export class ProjectsService {
  static async list(client: AxiosInstance): Promise<{ data: Project[] }> {
    const response = await client.get('/projects');
    return response.data;
  }

  static async show(client: AxiosInstance, slug: string): Promise<{ data: Project }> {
    const response = await client.get(`/projects/${slug}`);
    return response.data;
  }
}

export class CommentsService {
  static async add(
    client: AxiosInstance,
    ref: string,
    data: { body: string; type?: 'verification' | 'fix_report' | 'review' | 'general' }
  ): Promise<{ data: Comment }> {
    const response = await client.post(`/tickets/${ref}/comments`, data);
    return response.data;
  }
}

export class AgentService {
  static async me(client: AxiosInstance): Promise<{ data: Agent }> {
    const response = await client.get('/agents/me');
    return response.data;
  }
}
