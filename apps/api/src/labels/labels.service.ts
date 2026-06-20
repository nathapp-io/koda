import { Injectable, Inject } from '@nestjs/common';
import { ValidationAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { CreateLabelDto } from './dto/create-label.dto';
import { UpdateLabelDto } from './dto/update-label.dto';
import { AssignLabelDto } from './dto/assign-label.dto';
import { LabelResponseDto } from './dto/label-response.dto';
import { actorForeignKeys } from '../auth/principal/actor-foreign-keys';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { LABEL_REPOSITORY, ILabelRepository } from './domain/label.domain';

@Injectable()
export class LabelsService {
  constructor(
    @Inject(LABEL_REPOSITORY) private readonly repo: ILabelRepository,
  ) {}

  async create(
    projectSlug: string,
    createLabelDto: CreateLabelDto,
    principal: KodaPrincipal,
  ) {
    if (!createLabelDto.name) {
      throw new ValidationAppException({}, 'labels');
    }
    if (typeof createLabelDto.name === 'string' && createLabelDto.name.trim().length === 0) {
      throw new ValidationAppException({}, 'labels');
    }

    const project = await this.repo.findProjectBySlug(projectSlug);
    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'labels');
    }

    const label = await this.repo.createLabel({
      projectId: project.id,
      name: createLabelDto.name,
      color: createLabelDto.color ?? null,
    });
    return LabelResponseDto.from(label);
  }

  async findByProject(projectSlug: string) {
    const project = await this.repo.findProjectBySlug(projectSlug);
    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'labels');
    }

    const labels = await this.repo.findLabelsByProject(project.id);
    return LabelResponseDto.fromMany(labels);
  }

  async delete(
    projectSlug: string,
    labelId: string,
    principal: KodaPrincipal,
  ) {
    const project = await this.repo.findProjectBySlug(projectSlug);
    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'labels');
    }

    const label = await this.repo.findLabelById(labelId);
    if (!label) {
      throw new NotFoundAppException({}, 'labels');
    }

    if (label.projectId !== project.id) {
      throw new NotFoundAppException({}, 'labels');
    }

    await this.repo.deleteLabel(labelId);
  }

  async update(
    projectSlug: string,
    labelId: string,
    updateLabelDto: UpdateLabelDto,
    principal: KodaPrincipal,
  ) {
    const project = await this.repo.findProjectBySlug(projectSlug);
    if (!project || project.deletedAt) throw new NotFoundAppException();

    const label = await this.repo.findLabelById(labelId);
    if (!label || label.projectId !== project.id) throw new NotFoundAppException();

    return LabelResponseDto.from(
      await this.repo.updateLabel(labelId, {
        ...(updateLabelDto.name !== undefined ? { name: updateLabelDto.name } : {}),
        ...(updateLabelDto.color !== undefined ? { color: updateLabelDto.color } : {}),
      }),
    );
  }

  async assignToTicket(
    projectSlug: string,
    ticketRef: string,
    assignLabelDto: AssignLabelDto,
    principal: KodaPrincipal,
  ) {
    const project = await this.repo.findProjectBySlug(projectSlug);
    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'labels');
    }

    const ticket = await this.repo.findTicketByRef(project.id, ticketRef);
    if (!ticket || ticket.deletedAt) {
      throw new NotFoundAppException({}, 'labels');
    }

    const label = await this.repo.findLabelById(assignLabelDto.labelId);
    if (!label) {
      throw new NotFoundAppException({}, 'labels');
    }

    if (label.projectId !== project.id) {
      throw new ValidationAppException({}, 'labels');
    }

    const result = await this.repo.runInTransaction(async () => {
      const existingAssignment = await this.repo.findTicketLabelAssignment(
        ticket.id,
        assignLabelDto.labelId,
      );

      if (existingAssignment) {
        throw new ValidationAppException();
      }

      await this.repo.assignLabelToTicket(ticket.id, assignLabelDto.labelId);

      const actor = actorForeignKeys(principal, 'actor');
      await this.repo.createTicketActivity({
        ticketId: ticket.id,
        action: 'LABEL_CHANGE',
        field: 'labels',
        newValue: label.name,
        actorUserId: actor.actorUserId ?? null,
        actorAgentId: actor.actorAgentId ?? null,
      });

      const updated = await this.repo.findTicketWithLabels(ticket.id);
      if (!updated) {
        throw new NotFoundAppException({}, 'labels');
      }
      return updated;
    });

    return result;
  }

  async removeFromTicket(
    projectSlug: string,
    ticketRef: string,
    labelId: string,
    principal: KodaPrincipal,
  ) {
    const project = await this.repo.findProjectBySlug(projectSlug);
    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'labels');
    }

    const ticket = await this.repo.findTicketByRef(project.id, ticketRef);
    if (!ticket || ticket.deletedAt) {
      throw new NotFoundAppException({}, 'labels');
    }

    const ticketLabel = await this.repo.findTicketLabelWithLabel(ticket.id, labelId);
    if (!ticketLabel) {
      throw new NotFoundAppException({}, 'labels');
    }

    const result = await this.repo.runInTransaction(async () => {
      await this.repo.removeLabelFromTicket(ticket.id, labelId);

      const actor = actorForeignKeys(principal, 'actor');
      await this.repo.createTicketActivity({
        ticketId: ticket.id,
        action: 'LABEL_CHANGE',
        field: 'labels',
        oldValue: ticketLabel.label.name,
        actorUserId: actor.actorUserId ?? null,
        actorAgentId: actor.actorAgentId ?? null,
      });

      const updated = await this.repo.findTicketWithLabels(ticket.id);
      if (!updated) {
        throw new NotFoundAppException({}, 'labels');
      }
      return updated;
    });

    return result;
  }
}
