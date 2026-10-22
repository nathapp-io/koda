import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { KodaPageQuery } from '../../../common/dto/koda-page.query';

/** The principal kinds `GET /projects/:slug/members` can list. `users` is the default. */
export const MEMBER_PRINCIPAL_FILTERS = ['users', 'all'] as const;
export type MemberPrincipalFilter = (typeof MEMBER_PRINCIPAL_FILTERS)[number];

/** The default page: user rows only, exactly as the route answered before agents shared the list. */
export const DEFAULT_MEMBER_PRINCIPAL_FILTER: MemberPrincipalFilter = 'users';

/**
 * `GET /projects/:slug/members` query. `principals=all` adds the project's agent principals after the
 * user rows; anything else is a validation refusal rather than a silently empty page.
 */
export class ListMembersQuery extends KodaPageQuery {
  @ApiPropertyOptional({
    enum: MEMBER_PRINCIPAL_FILTERS,
    default: DEFAULT_MEMBER_PRINCIPAL_FILTER,
    description: 'users (default): user rows only. all: user rows, then agent rows',
  })
  @IsOptional()
  @IsIn(MEMBER_PRINCIPAL_FILTERS, { message: '$t(common.validation.isEnum)' })
  principals?: MemberPrincipalFilter;
}
