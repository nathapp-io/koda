import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLabelDto } from './dto/create-label.dto';
import { AssignLabelDto } from './dto/assign-label.dto';

interface CurrentUser {
  sub: string;
  role?: string;
}

@Injectable()
export class LabelsService {
  constructor(private prisma: PrismaService) {}

  async create(
    projectSlug: string,
    createLabelDto: CreateLabelDto,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    // Only ADMIN users can create labels
    if (actorType !== 'user' || currentUser.role === 'MEMBER') {
      throw new ForbiddenException('Only admin users can create labels');
    }

    // Validate required fields
    if (!createLabelDto.name) {
      throw new BadRequestException('Name is required');
    }
    if (typeof createLabelDto.name === 'string' && createLabelDto.name.trim().length === 0) {
      throw new BadRequestException('Name must not be empty');
    }

    // Find project by slug
    const project = await this.prisma.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundException('Project not found');
    }

    // Create the label
    try {
      const label = await this.prisma.label.create({
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
        throw new BadRequestException('Label already exists in this project');
      }
      throw error;
    }
  }

  async findByProject(projectSlug: string) {
    // Find project by slug
    const project = await this.prisma.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundException('Project not found');
    }

    // Find all labels for this project
    const labels = await this.prisma.label.findMany({
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
      throw new ForbiddenException('Only admin users can delete labels');
    }

    // Find project by slug
    const project = await this.prisma.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundException('Project not found');
    }

    // Find the label
    const label = await this.prisma.label.findUnique({
      where: { id: labelId },
    });

    if (!label) {
      throw new NotFoundException('Label not found');
    }

    // Verify the label belongs to the project
    if (label.projectId !== project.id) {
      throw new NotFoundException('Label not found');
    }

    // Delete the label
    await this.prisma.label.delete({
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
    const project = await this.prisma.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundException('Project not found');
    }

    // Find ticket by ref (KODA-1 or CUID)
    const refPattern = /^([A-Z]+)-(\d+)$/;
    const match = ticketRef.match(refPattern);

    let ticket;

    if (match) {
      // Resolve by composite unique key (projectId, number)
      const number = parseInt(match[2], 10);
      ticket = await this.prisma.ticket.findUnique({
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
      ticket = await this.prisma.ticket.findUnique({
        where: { id: ticketRef },
        include: { labels: { include: { label: true } } },
      });
    }

    if (!ticket || ticket.deletedAt) {
      throw new NotFoundException('Ticket not found');
    }

    // Find the label
    const label = await this.prisma.label.findUnique({
      where: { id: assignLabelDto.labelId },
    });

    if (!label) {
      throw new NotFoundException('Label not found');
    }

    // Verify the label belongs to the same project
    if (label.projectId !== project.id) {
      throw new BadRequestException('Label not in project');
    }

    // Use transaction to assign label and create activity
    try {
      const result = await this.prisma.$transaction(async (tx) => {
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
          throw new NotFoundException('Ticket not found after update');
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
      if (error instanceof Error && error.message.includes('already assigned')) {
        throw new BadRequestException('Label already assigned to this ticket');
      }
      if (error instanceof Error && error.message.includes('Unique constraint')) {
        throw new BadRequestException('Label already assigned to this ticket');
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
    const project = await this.prisma.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundException('Project not found');
    }

    // Find ticket by ref (KODA-1 or CUID)
    const refPattern = /^([A-Z]+)-(\d+)$/;
    const match = ticketRef.match(refPattern);

    let ticket;

    if (match) {
      // Resolve by composite unique key (projectId, number)
      const number = parseInt(match[2], 10);
      ticket = await this.prisma.ticket.findUnique({
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
      ticket = await this.prisma.ticket.findUnique({
        where: { id: ticketRef },
        include: { labels: { include: { label: true } } },
      });
    }

    if (!ticket || ticket.deletedAt) {
      throw new NotFoundException('Ticket not found');
    }

    // Check if label is assigned to ticket
    const ticketLabel = await this.prisma.ticketLabel.findUnique({
      where: {
        ticketId_labelId: {
          ticketId: ticket.id,
          labelId,
        },
      },
      include: { label: true },
    });

    if (!ticketLabel) {
      throw new NotFoundException('Label not assigned to ticket');
    }

    // Use transaction to remove label and create activity
    const result = await this.prisma.$transaction(async (tx) => {
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
        throw new NotFoundException('Ticket not found after removal');
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
