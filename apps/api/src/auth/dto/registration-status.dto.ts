import { ApiProperty } from '@nestjs/swagger';

export class RegistrationStatusDto {
  @ApiProperty({ description: 'True when POST /auth/register will accept a new user' })
  declare open: boolean;
}
