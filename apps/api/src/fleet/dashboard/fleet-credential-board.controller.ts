import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { CredentialBoardService } from './credential-board.service';
import { CredentialBoardDto, CredentialCellDto, ProfileCellDto } from './dto/credential-board.dto';

/** Fleet S3 §4.4: provider x runner credential grid and profile inventory (global admin). */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiExtraModels(CredentialCellDto, ProfileCellDto)
@Controller('fleet/credential-board')
export class FleetCredentialBoardController {
  constructor(private readonly board: CredentialBoardService) {}

  @Get()
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Credential health per provider and runner, and the profile inventory (global admin)' })
  @ApiResponse({ status: 200, type: CredentialBoardDto })
  async get() {
    return JsonResponse.Ok(await this.board.board(new Date()));
  }
}
