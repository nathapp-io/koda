import { FleetPrRulingDto } from './fleet-pr-ruling.dto';

describe('FleetPrRulingDto Swagger metadata', () => {
  it('AC-4 advertises SYSTEM as a ruling actor type', () => {
    const metadata = Reflect.getMetadata('swagger/apiModelProperties', FleetPrRulingDto.prototype, 'actorType') as { enum?: string[] };
    expect(metadata.enum).toEqual(['USER', 'AGENT', 'SYSTEM']);
  });
});
