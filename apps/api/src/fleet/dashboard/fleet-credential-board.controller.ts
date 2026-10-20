import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { CredentialBoardService } from './credential-board.service';
import { CredentialBoardDto, CredentialCellDto, ProfileCellDto } from './dto/credential-board.dto';

/**
 * Fleet S3 §4.4: provider x runner credential grid and profile inventory, migrated onto permission
 * keys by permissions P1d (US-008). `fleet.credential.read` is a global key, checked with no project.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiExtraModels(CredentialCellDto, ProfileCellDto)
@Controller('fleet/credential-board')
export class FleetCredentialBoardController {
  constructor(private readonly board: CredentialBoardService) {}

  @Get()
  @UseGuards(RequiresGuard)
  @Requires('fleet.credential.read')
  @ApiOperation({ summary: 'Credential health per provider and runner, and the profile inventory (fleet.credential.read, global)' })
  @ApiResponse({ status: 200, type: CredentialBoardDto })
  @ApiResponse({ status: 403, description: 'fleet.credential.read is missing globally' })
  async get() {
    return JsonResponse.Ok(await this.board.board(new Date()));
  }
}
