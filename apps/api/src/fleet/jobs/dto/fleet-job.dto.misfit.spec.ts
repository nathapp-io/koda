import 'reflect-metadata';
import { MISFIT_REASONS } from '../../dashboard/dashboard.types';
import { PlacementMisfitDto } from './fleet-job.dto';

/**
 * US-005: a new placement misfit has to reach both places the clients read it from — the dashboard's reason list
 * (`MISFIT_REASONS`, which the dashboard and credential-board DTOs publish) and the placement summary's own enum
 * (`PlacementMisfitDto`, the `FleetJobDto` misfit reason the job page renders).
 */

/** `@nestjs/swagger`'s ApiProperty stores its options under this metadata key on the prototype. */
const SWAGGER_MODEL_PROPERTIES = 'swagger/apiModelProperties';

const placementMisfitEnum = (): string[] => {
  const metadata = Reflect.getMetadata(SWAGGER_MODEL_PROPERTIES, PlacementMisfitDto.prototype, 'reason') as { enum?: string[] } | undefined;
  return metadata?.enum ?? [];
};

describe('fleet misfit reason lists (US-005)', () => {
  it("AC-12: the dashboard's misfit reason list includes agents_run", () => {
    expect(MISFIT_REASONS).toContain('agents_run');
  });

  it('AC-12: the PlacementMisfitDto enum includes agents_run', () => {
    // Guard the probe itself: an empty enum would make the assertion below vacuous.
    expect(placementMisfitEnum()).toContain('capacity');
    expect(placementMisfitEnum()).toContain('agents_run');
  });
});
