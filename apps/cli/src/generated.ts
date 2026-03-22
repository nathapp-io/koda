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

  static async create(
    client: AxiosInstance,
    data: { name: string; slug: string; key: string; description?: string }
  ): Promise<Wrapped<Project>> {
    return client.post('/projects', data);
  }

  static async delete(client: AxiosInstance, slug: string): Promise<Wrapped<null>> {
    return client.delete(`/projects/${slug}`);
  }
}

export class CommentsService {
  static async add(
    client: AxiosInstance,
    projectSlug: string,
    ref: string,
    data: { body: string; type?: 'verification' | 'fix_report' | 'review' | 'general' }
  ): Promise<Wrapped<Comment>> {
    return client.post(`/projects/${projectSlug}/tickets/${ref}/comments`, data);
  }
}

export interface Ticket {
  id: string;
  number: number;
  ref?: string;
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
    projectSlug: string,
    data: {
      type: string;
      title: string;
      description?: string;
      priority?: string;
    }
  ): Promise<Wrapped<Ticket>> {
    return client.post(`/projects/${projectSlug}/tickets`, data);
  }

  static async list(
    client: AxiosInstance,
    params: {
      projectSlug: string;
      status?: string;
      type?: string;
      priority?: string;
      assignedTo?: string;
      unassigned?: boolean;
      limit?: number;
      page?: number;
    }
  ): Promise<Wrapped<{ items: Ticket[]; total: number }>> {
    const { projectSlug, ...rest } = params;
    return client.get(`/projects/${projectSlug}/tickets`, { params: rest });
  }

  static async show(client: AxiosInstance, projectSlug: string, ref: string): Promise<Wrapped<Ticket>> {
    return client.get(`/projects/${projectSlug}/tickets/${ref}`);
  }

  static async verify(
    client: AxiosInstance,
    projectSlug: string,
    ref: string,
    data: { body: string; type?: string }
  ): Promise<Wrapped<Ticket>> {
    return client.post(`/projects/${projectSlug}/tickets/${ref}/verify`, data);
  }

  static async assign(
    client: AxiosInstance,
    projectSlug: string,
    ref: string,
    data: { agentSlug: string }
  ): Promise<Wrapped<Ticket>> {
    return client.post(`/projects/${projectSlug}/tickets/${ref}/assign`, data);
  }

  static async start(client: AxiosInstance, projectSlug: string, ref: string): Promise<Wrapped<Ticket>> {
    return client.post(`/projects/${projectSlug}/tickets/${ref}/start`);
  }

  static async fix(
    client: AxiosInstance,
    projectSlug: string,
    ref: string,
    data: { body: string; type?: string; gitRef?: string }
  ): Promise<Wrapped<Ticket>> {
    return client.post(`/projects/${projectSlug}/tickets/${ref}/fix`, data);
  }

  static async verifyFix(
    client: AxiosInstance,
    projectSlug: string,
    ref: string,
    data: { body: string; type?: string; status: string }
  ): Promise<Wrapped<Ticket>> {
    const approve = data.status === 'closed';
    return client.post(`/projects/${projectSlug}/tickets/${ref}/verify-fix?approve=${approve}`, data);
  }

  static async close(client: AxiosInstance, projectSlug: string, ref: string): Promise<Wrapped<Ticket>> {
    return client.post(`/projects/${projectSlug}/tickets/${ref}/close`);
  }

  static async reject(
    client: AxiosInstance,
    projectSlug: string,
    ref: string,
    data: { body: string; type?: string }
  ): Promise<Wrapped<Ticket>> {
    return client.post(`/projects/${projectSlug}/tickets/${ref}/reject`, data);
  }

  static async update(
    client: AxiosInstance,
    projectSlug: string,
    ref: string,
    data: { title?: string; description?: string; priority?: string }
  ): Promise<Wrapped<Ticket>> {
    return client.patch(`/projects/${projectSlug}/tickets/${ref}`, data);
  }

  static async delete(client: AxiosInstance, projectSlug: string, ref: string): Promise<Wrapped<null>> {
    return client.delete(`/projects/${projectSlug}/tickets/${ref}`);
  }
}

export class AgentService {
  static async me(client: AxiosInstance): Promise<Wrapped<Agent>> {
    return client.get('/agents/me');
  }
}

export interface Label {
  id: string;
  name: string;
  color?: string;
  projectId: string;
}

export class LabelsService {
  static async create(
    client: AxiosInstance,
    data: { projectSlug: string; name: string; color?: string }
  ): Promise<Wrapped<Label>> {
    return client.post(`/projects/${data.projectSlug}/labels`, { name: data.name, color: data.color });
  }

  static async list(
    client: AxiosInstance,
    projectSlug: string
  ): Promise<Wrapped<{ items: Label[]; total: number }>> {
    return client.get(`/projects/${projectSlug}/labels`);
  }

  static async delete(
    client: AxiosInstance,
    projectSlug: string,
    id: string
  ): Promise<Wrapped<null>> {
    return client.delete(`/projects/${projectSlug}/labels/${id}`);
  }

  static async addToTicket(
    client: AxiosInstance,
    projectSlug: string,
    ref: string,
    labelId: string
  ): Promise<Wrapped<null>> {
    return client.post(`/projects/${projectSlug}/tickets/${ref}/labels`, { labelId });
  }

  static async removeFromTicket(
    client: AxiosInstance,
    projectSlug: string,
    ref: string,
    labelId: string
  ): Promise<Wrapped<null>> {
    return client.delete(`/projects/${projectSlug}/tickets/${ref}/labels/${labelId}`);
  }
}
