import { Injectable, HttpStatus } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { AppException } from '../../common/app-exception';
import {
  TicketStatus,
  CommentType,
  ActivityType,
  Ticket,
  Comment,
  TicketActivity,
  PrismaClient,
} from '@prisma/client';
import { validateTransition } from './ticket-transitions';

export interface CurrentUser {
  sub: string;
}

export interface TransitionResultWithComment {
  ticket: Ticket;
  comment: Comment;
  activity: TicketActivity;
}

export interface TransitionResultWithoutComment {
  ticket: Ticket;
  activity: TicketActivity;
}

export type TransitionResult = TransitionResultWithComment | TransitionResultWithoutComment;

@Injectable()
export class TicketTransitionsService {
  constructor(private prisma: PrismaService<PrismaClient>) {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get db(): PrismaClient { return (this.prisma as any).client ?? (this.prisma as unknown as PrismaClient); }


  /**
   * Transition CREATED → VERIFIED
   */
  async verify(
    projectSlug: string,
    ticketRef: string,
    commentBody: string,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ): Promise<TransitionResultWithComment> {
    return this.executeTransition(
      projectSlug,
      ticketRef,
      TicketStatus.VERIFIED,
      CommentType.VERIFICATION,
      commentBody,
      currentUser,
      actorType,
    ) as Promise<TransitionResultWithComment>;
  }

  /**
   * Transition VERIFIED → IN_PROGRESS (no comment required)
   */
  async start(
    projectSlug: string,
    ticketRef: string,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ): Promise<TransitionResultWithoutComment> {
    return this.executeTransition(
      projectSlug,
      ticketRef,
      TicketStatus.IN_PROGRESS,
      undefined,
      undefined,
      currentUser,
      actorType,
    ) as Promise<TransitionResultWithoutComment>;
  }

  /**
   * Transition IN_PROGRESS → VERIFY_FIX
   */
  async fix(
    projectSlug: string,
    ticketRef: string,
    commentBody: string,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ): Promise<TransitionResultWithComment> {
    return this.executeTransition(
      projectSlug,
      ticketRef,
      TicketStatus.VERIFY_FIX,
      CommentType.FIX_REPORT,
      commentBody,
      currentUser,
      actorType,
    ) as Promise<TransitionResultWithComment>;
  }

  /**
   * Transition VERIFY_FIX → CLOSED (approve=true) or IN_PROGRESS (approve=false)
   */
  async verifyFix(
    projectSlug: string,
    ticketRef: string,
    commentBody: string,
    approve: boolean,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ): Promise<TransitionResultWithComment> {
    const toStatus = approve ? TicketStatus.CLOSED : TicketStatus.IN_PROGRESS;
    return this.executeTransition(
      projectSlug,
      ticketRef,
      toStatus,
      CommentType.REVIEW,
      commentBody,
      currentUser,
      actorType,
    ) as Promise<TransitionResultWithComment>;
  }

  /**
   * Transition to CLOSED from any valid status (no comment required)
   * Bypasses normal transition rules to allow closing from multiple states
   */
  async close(
    projectSlug: string,
    ticketRef: string,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ): Promise<TransitionResultWithoutComment> {
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });
    if (!project || project.deletedAt) {
      throw new AppException('errors.notFound', HttpStatus.NOT_FOUND);
    }

    const ticket = await this.findTicketByRef(projectSlug, ticketRef);
    if (!ticket) {
      throw new AppException('errors.notFound', HttpStatus.NOT_FOUND);
    }

    // Validate that CLOSED is reachable from current status
    if (
      ticket.status === TicketStatus.CLOSED ||
      ticket.status === TicketStatus.CREATED ||
      ticket.status === TicketStatus.REJECTED
    ) {
      throw new AppException('errors.invalidTransition', HttpStatus.BAD_REQUEST);  // i18n key for invalid ticket transition
    }

    // Execute transition without comment requirement
    const transaction = await this.db.$transaction(async (tx) => {
      const actorUserId = actorType === 'user' ? currentUser.sub : null;
      const actorAgentId = actorType === 'agent' ? currentUser.sub : null;

      // Update ticket status
      const updatedTicket = await tx.ticket.update({
        where: { id: ticket.id },
        data: { status: TicketStatus.CLOSED },
      });

      // Create activity record
      const activity = await tx.ticketActivity.create({
        data: {
          ticketId: ticket.id,
          action: ActivityType.STATUS_CHANGE,
          fromStatus: ticket.status,
          toStatus: TicketStatus.CLOSED,
          actorUserId,
          actorAgentId,
        },
      });

      return {
        ticket: updatedTicket,
        activity,
      };
    });

    return transaction;
  }

  /**
   * Transition CREATED or VERIFIED → REJECTED
   */
  async reject(
    projectSlug: string,
    ticketRef: string,
    commentBody: string,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ): Promise<TransitionResultWithComment> {
    return this.executeTransition(
      projectSlug,
      ticketRef,
      TicketStatus.REJECTED,
      CommentType.GENERAL,
      commentBody,
      currentUser,
      actorType,
    ) as Promise<TransitionResultWithComment>;
  }

  /**
   * Core transition execution logic with validation and transaction handling
   */
  private async executeTransition(
    projectSlug: string,
    ticketRef: string,
    toStatus: TicketStatus,
    commentType: CommentType | undefined,
    commentBody: string | undefined,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ): Promise<TransitionResult> {
    // Find project
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });
    if (!project || project.deletedAt) {
      throw new AppException('errors.notFound', HttpStatus.NOT_FOUND);
    }

    // Find ticket
    const ticket = await this.findTicketByRef(projectSlug, ticketRef);
    if (!ticket) {
      throw new AppException('errors.notFound', HttpStatus.NOT_FOUND);
    }

    // Validate transition
    validateTransition(ticket.status, toStatus, commentType);

    // Execute transition in transaction
    return this.db.$transaction(async (tx) => {
      const actorUserId = actorType === 'user' ? currentUser.sub : null;
      const actorAgentId = actorType === 'agent' ? currentUser.sub : null;

      // Create comment if needed
      let comment = null;
      if (commentType && commentBody) {
        comment = await tx.comment.create({
          data: {
            ticketId: ticket.id,
            body: commentBody,
            type: commentType,
            authorUserId: actorUserId,
            authorAgentId: actorAgentId,
          },
        });
      }

      // Update ticket status
      const updatedTicket = await tx.ticket.update({
        where: { id: ticket.id },
        data: { status: toStatus },
      });

      // Create activity record
      const activity = await tx.ticketActivity.create({
        data: {
          ticketId: ticket.id,
          action: ActivityType.STATUS_CHANGE,
          fromStatus: ticket.status,
          toStatus,
          actorUserId,
          actorAgentId,
        },
      });

      if (comment) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return {
          ticket: updatedTicket,
          comment,
          activity,
        } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return {
        ticket: updatedTicket,
        activity,
      } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    });
  }

  /**
   * Helper to find ticket by ref (supports both KODA-1 format and CUID)
   */
  private async findTicketByRef(projectSlug: string, ref: string) {
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project) {
      return null;
    }

    // Try KODA-42 format first
    const refPattern = /^([A-Z]+)-(\d+)$/;
    const match = ref.match(refPattern);

    if (match) {
      const number = parseInt(match[2], 10);
      return this.db.ticket.findUnique({
        where: {
          projectId_number: {
            projectId: project.id,
            number,
          },
        },
      });
    }

    // Try as CUID
    return this.db.ticket.findUnique({
      where: { id: ref },
    });
  }
}
