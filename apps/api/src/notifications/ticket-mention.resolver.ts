import { Injectable } from '@nestjs/common';

/**
 * Fleet S4a §2.3 seam. Part A ships no mention parsing: every call returns no ids. Part C (slice 3)
 * replaces the body with `@[label](user:<id>)` parsing filtered to project members and global admins,
 * keeping this signature.
 */
@Injectable()
export class TicketMentionResolver {
  async mentionedUserIds(_projectId: string, _text: string | null): Promise<readonly string[]> {
    return [];
  }
}
