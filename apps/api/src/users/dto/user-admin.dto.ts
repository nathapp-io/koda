import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserAdminRecord } from '../domain/user-admin.domain';

export class UserAdminDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare email: string;
  @ApiPropertyOptional({ nullable: true, type: String }) declare name: string | null;
  @ApiProperty({ enum: ['MEMBER', 'ADMIN'] }) declare role: string;
  @ApiProperty() declare disabled: boolean;
  @ApiProperty() declare createdAt: Date;
  @ApiProperty() declare updatedAt: Date;

  static from(r: UserAdminRecord): UserAdminDto {
    return {
      id: r.id, email: r.email, name: r.name, role: r.role,
      disabled: r.disabled, createdAt: r.createdAt, updatedAt: r.updatedAt,
    };
  }
}
