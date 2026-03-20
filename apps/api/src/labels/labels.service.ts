import { Injectable, HttpStatus } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { AppException } from '../common/app-exception';
import { CreateLabelDto } from './dto/create-label.dto';
import { AssignLabelDto } from './dto/assign-label.dto';

interface CurrentUser {
  sub: string;
  role?: string;
}

@Injectable()
export class LabelsService {
  constructor(private prisma: PrismaService<PrismaClient>) {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get db(): PrismaClient { return (this.prisma as any).client ?? (this.prisma as unknown as PrismaClient); }


  async create(
    projectSlug: string,
    createLabelDto: CreateLabelDto,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    // Only ADMIN users can create labels
    if (actorType !== 'user' || currentUser.role === 'MEMBER') {
      throw new AppException('errors.forbidden', HttpStatus.FORBIDDEN);
    }

    // Validate required fields
    if (!createLabelDto.name) {
      throw new AppException('labels.nameRequired', HttpStatus.BAD_REQUEST);
    }
    if (typeof createLabelDto.name === 'string' && createLabelDto.name.trim().length === 0) {
      throw new AppException('labels.nameEmpty', HttpStatus.BAD_REQUEST);
    }

    // Find project by slug
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new AppException('projects.notFound', HttpStatus.NOT_FOUND);
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

      return label;
    } catch (error) {
      // Check if it's a unique constraint violation (duplicate name in project)
      if (error instanceof Error && error.message.includes('Unique constraint')) {
        throw new AppException('labels.alreadyExists', HttpStatus.BAD_REQUEST);
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
      throw new AppException('projects.notFound', HttpStatus.NOT_FOUND);
    }

    // Find all labels for this project
    const labels = await this.db.label.findMany({
      where: { projectId: project.id },
    });

    return labels;
  }

  async delete(
    projectSlug: string,
    labelId: string,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    // Only ADMIN users can delete labels
    if (actorType !== 'user' || currentUser.role === 'MEMBER') {
      throw new AppException('errors.forbidden', HttpStatus.FORBIDDEN);
    }

    // Find project by slug
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new AppException('projects.notFound', HttpStatus.NOT_FOUND);
    }

    // Find the label
    const label = await this.db.label.findUnique({
      where: { id: labelId },
    });

    if (!label) {
      throw new AppException('labels.notFound', HttpStatus.NOT_FOUND);
    }

    // Verify the label belongs to the project
    if (label.projectId !== project.id) {
      throw new AppException('labels.notFound', HttpStatus.NOT_FOUND);
    }

    // Delete the label
    await this.db.label.delete({
      where: { id: labelId },
    });
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
      throw new AppException('projects.notFound', HttpStatus.NOT_FOUND);
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
      throw new AppException('tickets.notFound', HttpStatus.NOT_FOUND);
    }

    // Find the label
    const label = await this.db.label.findUnique({
      where: { id: assignLabelDto.labelId },
    });

    if (!label) {
      throw new AppException('labels.notFound', HttpStatus.NOT_FOUND);
    }

    // Verify the label belongs to the same project
    if (label.projectId !== project.id) {
      throw new AppException('labels.notInProject', HttpStatus.BAD_REQUEST);
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
          throw new Error('Label already assigned');
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
          throw new AppException('tickets.notFound', HttpStatus.NOT_FOUND);
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
      if (error instanceof AppException) {
        throw error;
      }
      if (error instanceof Error && error.message.includes('already assigned')) {
        throw new AppException('labels.alreadyAssigned', HttpStatus.BAD_REQUEST);
      }
      if (error instanceof Error && error.message.includes('Unique constraint')) {
        throw new AppException('labels.alreadyAssigned', HttpStatus.BAD_REQUEST);
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
      throw new AppException('projects.notFound', HttpStatus.NOT_FOUND);
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
      throw new AppException('tickets.notFound', HttpStatus.NOT_FOUND);
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
      throw new AppException('labels.notAssigned', HttpStatus.NOT_FOUND);
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
        throw new AppException('tickets.notFound', HttpStatus.NOT_FOUND);
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
