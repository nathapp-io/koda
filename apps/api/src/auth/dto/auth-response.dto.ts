import { ApiProperty } from '@nestjs/swagger';
import type { UserDomain } from '../domain/auth.domain';

export class UserResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  role!: string;

  @ApiProperty()
  disabled!: boolean;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  /**
   * Explicit field list: a spread would serialize every extra property the
   * domain row carries (tokenVersion, and historically passwordHash).
   */
  static from(user: UserDomain): UserResponseDto {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      disabled: user.disabled,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}

export class AuthResponseDto {
  @ApiProperty()
  declare accessToken: string;

  @ApiProperty()
  declare refreshToken: string;

  @ApiProperty({ type: UserResponseDto })
  declare user: UserResponseDto;
}
