import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateProjectDto } from './update-project.dto';

describe('UpdateProjectDto — graphify-kb-cc graphifyEnabled field', () => {
  // AC4: graphifyEnabled: true must pass class-validator
  it('accepts graphifyEnabled: true without validation errors', async () => {
    const dto = plainToInstance(UpdateProjectDto, { graphifyEnabled: true });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  // AC4 (false variant): graphifyEnabled: false must also pass
  it('accepts graphifyEnabled: false without validation errors', async () => {
    const dto = plainToInstance(UpdateProjectDto, { graphifyEnabled: false });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  // AC4 (omitted variant): graphifyEnabled omitted — dto is still valid
  it('accepts a payload omitting graphifyEnabled entirely', async () => {
    const dto = plainToInstance(UpdateProjectDto, { name: 'Some Name' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  // AC5: graphifyEnabled: 'notabool' must fail class-validator
  it('rejects graphifyEnabled: "notabool" with a validation error', async () => {
    const dto = plainToInstance(UpdateProjectDto, { graphifyEnabled: 'notabool' });
    const errors = await validate(dto);
    const fieldErrors = errors.filter((e) => e.property === 'graphifyEnabled');
    expect(fieldErrors.length).toBeGreaterThan(0);
  });

  // AC5 (number variant): numeric non-boolean must also fail
  it('rejects graphifyEnabled: 1 (number) with a validation error', async () => {
    const dto = plainToInstance(UpdateProjectDto, { graphifyEnabled: 1 });
    const errors = await validate(dto);
    const fieldErrors = errors.filter((e) => e.property === 'graphifyEnabled');
    expect(fieldErrors.length).toBeGreaterThan(0);
  });
});
