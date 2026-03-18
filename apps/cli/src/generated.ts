/* eslint-disable @typescript-eslint/no-explicit-any */
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
  author?: { id?: string; name: string; slug?: string };
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

export interface Ticket {
  id: string;
  number: number;
  projectId?: string;
  projectKey?: string;
  type: 'bug' | 'enhancement';
  title: string;
  description?: string;
  status: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  assignee?: { id: string; slug: string; name: string } | null;
  createdAt: string;
  updatedAt?: string;
  comments?: Comment[];
}

export class TicketsService {
  static async create(
    client: AxiosInstance,
    data: {
      projectSlug: string;
      type: string;
      title: string;
      description?: string;
      priority?: string;
    }
  ): Promise<{ data: Ticket }> {
    const response = await client.post('/tickets', data);
    return response.data;
  }

  static async list(
    client: AxiosInstance,
    params: Record<string, any>
  ): Promise<{ data: Ticket[]; meta: { total: number; page: number; limit: number } }> {
    const response = await client.get('/tickets', { params });
    return response.data;
  }

  static async show(client: AxiosInstance, ref: string): Promise<{ data: Ticket }> {
    const response = await client.get(`/tickets/${ref}`);
    return response.data;
  }

  static async verify(
    client: AxiosInstance,
    ref: string,
    data: { body: string; type: string }
  ): Promise<{ data: Ticket }> {
    const response = await client.patch(`/tickets/${ref}/verify`, data);
    return response.data;
  }

  static async assign(
    client: AxiosInstance,
    ref: string,
    data: { agentSlug: string }
  ): Promise<{ data: Ticket }> {
    const response = await client.patch(`/tickets/${ref}/assign`, data);
    return response.data;
  }

  static async start(client: AxiosInstance, ref: string): Promise<{ data: Ticket }> {
    const response = await client.patch(`/tickets/${ref}/start`);
    return response.data;
  }

  static async fix(
    client: AxiosInstance,
    ref: string,
    data: { body: string; type: string; gitRef?: string }
  ): Promise<{ data: Ticket }> {
    const response = await client.patch(`/tickets/${ref}/fix`, data);
    return response.data;
  }

  static async verifyFix(
    client: AxiosInstance,
    ref: string,
    data: { body: string; type: string; status: string }
  ): Promise<{ data: Ticket }> {
    const response = await client.patch(`/tickets/${ref}/verify-fix`, data);
    return response.data;
  }

  static async close(client: AxiosInstance, ref: string): Promise<{ data: Ticket }> {
    const response = await client.patch(`/tickets/${ref}/close`);
    return response.data;
  }

  static async reject(
    client: AxiosInstance,
    ref: string,
    data: { body: string; type: string }
  ): Promise<{ data: Ticket }> {
    const response = await client.patch(`/tickets/${ref}/reject`, data);
    return response.data;
  }
}

export class AgentService {
  static async me(client: AxiosInstance): Promise<{ data: Agent }> {
    const response = await client.get('/agents/me');
    return response.data;
  }
}
