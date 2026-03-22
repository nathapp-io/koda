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

type Wrapped<T> = { data: { ret: number; data: T } };

export class ProjectsService {
  static async list(client: AxiosInstance): Promise<Wrapped<{ items: Project[]; total: number }>> {
    return client.get('/projects');
  }

  static async show(client: AxiosInstance, slug: string): Promise<Wrapped<Project>> {
    return client.get(`/projects/${slug}`);
  }
}

export class CommentsService {
  static async add(
    client: AxiosInstance,
    ref: string,
    data: { body: string; type?: 'verification' | 'fix_report' | 'review' | 'general' }
  ): Promise<Wrapped<Comment>> {
    return client.post(`/tickets/${ref}/comments`, data);
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
  ): Promise<Wrapped<Ticket>> {
    return client.post('/tickets', data);
  }

  static async list(
    client: AxiosInstance,
    params: Record<string, any>
  ): Promise<Wrapped<{ items: Ticket[]; total: number }>> {
    return client.get('/tickets', { params });
  }

  static async show(client: AxiosInstance, ref: string): Promise<Wrapped<Ticket>> {
    return client.get(`/tickets/${ref}`);
  }

  static async verify(
    client: AxiosInstance,
    ref: string,
    data: { body: string; type: string }
  ): Promise<Wrapped<Ticket>> {
    return client.patch(`/tickets/${ref}/verify`, data);
  }

  static async assign(
    client: AxiosInstance,
    ref: string,
    data: { agentSlug: string }
  ): Promise<Wrapped<Ticket>> {
    return client.patch(`/tickets/${ref}/assign`, data);
  }

  static async start(client: AxiosInstance, ref: string): Promise<Wrapped<Ticket>> {
    return client.patch(`/tickets/${ref}/start`);
  }

  static async fix(
    client: AxiosInstance,
    ref: string,
    data: { body: string; type: string; gitRef?: string }
  ): Promise<Wrapped<Ticket>> {
    return client.patch(`/tickets/${ref}/fix`, data);
  }

  static async verifyFix(
    client: AxiosInstance,
    ref: string,
    data: { body: string; type: string; status: string }
  ): Promise<Wrapped<Ticket>> {
    return client.patch(`/tickets/${ref}/verify-fix`, data);
  }

  static async close(client: AxiosInstance, ref: string): Promise<Wrapped<Ticket>> {
    return client.patch(`/tickets/${ref}/close`);
  }

  static async reject(
    client: AxiosInstance,
    ref: string,
    data: { body: string; type: string }
  ): Promise<Wrapped<Ticket>> {
    return client.patch(`/tickets/${ref}/reject`, data);
  }
}

export class AgentService {
  static async me(client: AxiosInstance): Promise<Wrapped<Agent>> {
    return client.get('/agents/me');
  }
}
