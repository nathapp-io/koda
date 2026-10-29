import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseBody } from '../approvals/route/parse-body';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { CreateMemoryDto } from './dto/create-memory.dto';
import { ExtractEventDto } from './dto/extract-event.dto';
import { RecordDecisionDto } from './dto/record-decision.dto';
import { MemoryWriteService } from './memory-write.service';

function routeBody(input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {};
  const source = input as Record<string, unknown>;
  return Object.hasOwn(source, key) ? source[key] : {};
}

export const MEMORY_ROUTE_VARIANTS = {
  create: 'rest:memory.create',
  recordDecision: 'rest:memory.decisions.record',
  extract: 'rest:memory.extract',
} as const;

interface CreateInput { memory: CreateMemoryDto }
interface DecisionInput { decision: RecordDecisionDto }
interface ExtractInput { event: ExtractEventDto }

@Injectable()
export class MemoryRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly memoryWrites: MemoryWriteService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<CreateInput, Awaited<ReturnType<MemoryWriteService['create']>>>({
      key: 'memory.create', variant: MEMORY_ROUTE_VARIANTS.create,
      parse: (input) => ({ memory: parseBody(CreateMemoryDto, routeBody(input, 'memory')) }),
      run: (principal, input) => this.memoryWrites.create(principal, input.memory),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<DecisionInput, Awaited<ReturnType<MemoryWriteService['recordDecision']>>>({
      key: 'memory.decision.record', variant: MEMORY_ROUTE_VARIANTS.recordDecision,
      parse: (input) => ({ decision: parseBody(RecordDecisionDto, routeBody(input, 'decision')) }),
      run: (principal, input) => this.memoryWrites.recordDecision(principal, input.decision),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<ExtractInput, Awaited<ReturnType<MemoryWriteService['extract']>>>({
      key: 'memory.extract', variant: MEMORY_ROUTE_VARIANTS.extract,
      parse: (input) => ({ event: parseBody(ExtractEventDto, routeBody(input, 'event')) }),
      run: (principal, input) => this.memoryWrites.extract(principal, input.event),
      toResult: (result) => result,
    }, this.loader));
  }
}
