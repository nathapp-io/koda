import { ApiProperty } from '@nestjs/swagger';

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
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static from(user: any): UserResponseDto {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash: _passwordHash, ...result } = user;
    return result as UserResponseDto;
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
