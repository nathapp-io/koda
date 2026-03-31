import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient, Prisma } from '@prisma/client';
import { ValidationAppException, NotFoundAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { CreateLabelDto } from './dto/create-label.dto';
import { UpdateLabelDto } from './dto/update-label.dto';
import { AssignLabelDto } from './dto/assign-label.dto';
import { LabelResponseDto } from './dto/label-response.dto';

interface CurrentUser {
  id: string;
  sub: string;
  role?: string;
}

@Injectable()
export class LabelsService {
  constructor(private prisma: PrismaService<PrismaClient>) {}
  private get db() { return this.prisma.client; }


  async create(
    projectSlug: string,
    createLabelDto: CreateLabelDto,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    if (actorType !== 'agent' && currentUser.role === 'MEMBER') {
      throw new ForbiddenAppException({}, 'labels');
    }

    // Validate required fields
    if (!createLabelDto.name) {
      throw new ValidationAppException({}, 'labels');
    }
    if (typeof createLabelDto.name === 'string' && createLabelDto.name.trim().length === 0) {
      throw new ValidationAppException({}, 'labels');
    }

    // Find project by slug
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'labels');
    }

    // Create the label
    try {
      const label = await this.db.label.create({
        data: {
          projectId: project.id,
          name: createLabelDto.name,
          color: createLabelDto.color || null,
        },
      });

      return LabelResponseDto.from(label);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ValidationAppException({}, 'labels');
      }
      throw error;
    }
  }

  async findByProject(projectSlug: string) {
    // Find project by slug
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'labels');
    }

    // Find all labels for this project
    const labels = await this.db.label.findMany({
      where: { projectId: project.id },
    });

    return LabelResponseDto.fromMany(labels);
  }

  async delete(
    projectSlug: string,
    labelId: string,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    // ADMIN users and agents can delete labels; MEMBER users cannot
    if (actorType === 'user' && currentUser.role === 'MEMBER') {
      throw new ForbiddenAppException({}, 'labels');
    }

    // Find project by slug
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'labels');
    }

    // Find the label
    const label = await this.db.label.findUnique({
      where: { id: labelId },
    });

    if (!label) {
      throw new NotFoundAppException({}, 'labels');
    }

    // Verify the label belongs to the project
    if (label.projectId !== project.id) {
      throw new NotFoundAppException({}, 'labels');
    }

    // Delete the label
    await this.db.label.delete({
      where: { id: labelId },
    });
  }

  async update(
    projectSlug: string,
    labelId: string,
    updateLabelDto: UpdateLabelDto,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    // ADMIN users and agents can update labels; MEMBER users cannot
    if (actorType === 'user' && currentUser.role === 'MEMBER') {
      throw new ForbiddenAppException({}, 'labels');
    }

    const project = await this.db.project.findUnique({ where: { slug: projectSlug } });
    if (!project || project.deletedAt) throw new NotFoundAppException();

    const label = await this.db.label.findUnique({ where: { id: labelId } });
    if (!label || label.projectId !== project.id) throw new NotFoundAppException();

    try {
      return LabelResponseDto.from(await this.db.label.update({
        where: { id: labelId },
        data: {
          ...(updateLabelDto.name !== undefined ? { name: updateLabelDto.name } : {}),
          ...(updateLabelDto.color !== undefined ? { color: updateLabelDto.color } : {}),
        },
      }));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ValidationAppException({}, 'labels');
      }
      throw error;
    }
  }

  async assignToTicket(
    projectSlug: string,
    ticketRef: string,
    assignLabelDto: AssignLabelDto,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    // Find project by slug
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'labels');
    }

    // Find ticket by ref (KODA-1 or CUID)
    const refPattern = /^([A-Z]+)-(\d+)$/;
    const match = ticketRef.match(refPattern);

    let ticket;

    if (match) {
      // Resolve by composite unique key (projectId, number)
      const number = parseInt(match[2], 10);
      ticket = await this.db.ticket.findUnique({
        where: {
          projectId_number: {
            projectId: project.id,
            number,
          },
        },
        include: { labels: { include: { label: true } } },
      });
    } else {
      // Treat as CUID
      ticket = await this.db.ticket.findUnique({
        where: { id: ticketRef },
        include: { labels: { include: { label: true } } },
      });
    }

    if (!ticket || ticket.deletedAt) {
      throw new NotFoundAppException({}, 'labels');
    }

    // Find the label
    const label = await this.db.label.findUnique({
      where: { id: assignLabelDto.labelId },
    });

    if (!label) {
      throw new NotFoundAppException({}, 'labels');
    }

    // Verify the label belongs to the same project
    if (label.projectId !== project.id) {
      throw new ValidationAppException({}, 'labels');
    }

    // Use transaction to assign label and create activity
    try {
      const result = await this.db.$transaction(async (tx) => {
        // Check if label already assigned
        const existingAssignment = await tx.ticketLabel.findUnique({
          where: {
            ticketId_labelId: {
              ticketId: ticket.id,
              labelId: assignLabelDto.labelId,
            },
          },
        });

        if (existingAssignment) {
          throw new ValidationAppException();
        }

        // Assign the label
        await tx.ticketLabel.create({
          data: {
            ticketId: ticket.id,
            labelId: assignLabelDto.labelId,
          },
        });

        // Create activity record
        await tx.ticketActivity.create({
          data: {
            ticketId: ticket.id,
            action: 'LABEL_CHANGE',
            field: 'labels',
            newValue: label.name,
            actorUserId: actorType === 'user' ? currentUser.sub : null,
            actorAgentId: actorType === 'agent' ? currentUser.sub : null,
          },
        });

        // Return updated ticket with labels
        const updated = await tx.ticket.findUnique({
          where: { id: ticket.id },
          include: { labels: { include: { label: true } } },
        });
        if (!updated) {
          throw new NotFoundAppException({}, 'labels');
        }
        // Transform labels from nested structure to flat array
        interface TicketLabelWithLabel {
          label: { id: string; projectId: string; name: string; color: string | null };
        }
        return {
          ...updated,
          labels: updated.labels.map((tl: TicketLabelWithLabel) => tl.label),
        };
      });

      return result;
    } catch (error) {
      if (error instanceof ValidationAppException || error instanceof NotFoundAppException) {
        throw error;
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        // P2002 = Unique constraint (label already assigned)
        // P2003 = Foreign key constraint (invalid label/ticket)
        if (error.code === 'P2002' || error.code === 'P2003') {
          throw new ValidationAppException({}, 'labels');
        }
      }
      throw error;
    }
  }

  async removeFromTicket(
    projectSlug: string,
    ticketRef: string,
    labelId: string,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    // Find project by slug
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'labels');
    }

    // Find ticket by ref (KODA-1 or CUID)
    const refPattern = /^([A-Z]+)-(\d+)$/;
    const match = ticketRef.match(refPattern);

    let ticket;

    if (match) {
      // Resolve by composite unique key (projectId, number)
      const number = parseInt(match[2], 10);
      ticket = await this.db.ticket.findUnique({
        where: {
          projectId_number: {
            projectId: project.id,
            number,
          },
        },
        include: { labels: { include: { label: true } } },
      });
    } else {
      // Treat as CUID
      ticket = await this.db.ticket.findUnique({
        where: { id: ticketRef },
        include: { labels: { include: { label: true } } },
      });
    }

    if (!ticket || ticket.deletedAt) {
      throw new NotFoundAppException({}, 'labels');
    }

    // Check if label is assigned to ticket
    const ticketLabel = await this.db.ticketLabel.findUnique({
      where: {
        ticketId_labelId: {
          ticketId: ticket.id,
          labelId,
        },
      },
      include: { label: true },
    });

    if (!ticketLabel) {
      throw new NotFoundAppException({}, 'labels');
    }

    // Use transaction to remove label and create activity
    const result = await this.db.$transaction(async (tx) => {
      // Remove the label
      await tx.ticketLabel.delete({
        where: {
          ticketId_labelId: {
            ticketId: ticket.id,
            labelId,
          },
        },
      });

      // Create activity record
      await tx.ticketActivity.create({
        data: {
          ticketId: ticket.id,
          action: 'LABEL_CHANGE',
          field: 'labels',
          oldValue: ticketLabel.label.name,
          actorUserId: actorType === 'user' ? currentUser.sub : null,
          actorAgentId: actorType === 'agent' ? currentUser.sub : null,
        },
      });

      // Return updated ticket with labels
      const updated = await tx.ticket.findUnique({
        where: { id: ticket.id },
        include: { labels: { include: { label: true } } },
      });
      if (!updated) {
        throw new NotFoundAppException({}, 'labels');
      }
      // Transform labels from nested structure to flat array
      interface TicketLabelWithLabel {
        label: { id: string; projectId: string; name: string; color: string | null };
      }
      return {
        ...updated,
        labels: updated.labels.map((tl: TicketLabelWithLabel) => tl.label),
      };
    });

    return result;
  }
}
