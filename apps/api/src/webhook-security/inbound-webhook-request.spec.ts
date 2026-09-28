import 'reflect-metadata';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { parseInboundPayload, signedBytesOf } from './inbound-webhook-request';

class ItemDto {
  @IsString()
  name!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  line?: number;
}

class PayloadDto {
  @IsString()
  event!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ItemDto)
  items!: ItemDto[];
}

async function rejectionOf(promise: Promise<unknown>): Promise<ValidationAppException> {
  try {
    await promise;
  } catch (err) {
    return err as ValidationAppException;
  }
  throw new Error('expected the call to reject');
}

describe('signedBytesOf', () => {
  it('returns the raw bytes when the preParsing hook captured them (KODA-02)', () => {
    const raw = '{ "b": 1,   "a": 2 }';
    expect(signedBytesOf({ rawBody: Buffer.from(raw), body: { a: 2, b: 1 } })).toBe(raw);
  });

  it('falls back to the re-serialized body when there is no rawBody (Express test setups)', () => {
    expect(signedBytesOf({ body: { a: 1 } })).toBe('{"a":1}');
  });

  it('serializes a missing body as {}', () => {
    expect(signedBytesOf({})).toBe('{}');
  });
});

describe('parseInboundPayload', () => {
  it('returns a validated class instance', async () => {
    const result = await parseInboundPayload(PayloadDto, { event: 'e', items: [{ name: 'n', line: 3 }] });
    expect(result).toBeInstanceOf(PayloadDto);
    expect(result.items[0]).toBeInstanceOf(ItemDto);
    expect(result.items[0].line).toBe(3);
  });

  it('coerces a numeric-string line through @Type(() => Number)', async () => {
    const result = await parseInboundPayload(PayloadDto, { event: 'e', items: [{ name: 'n', line: '87' }] });
    expect(result.items[0].line).toBe(87);
  });

  it.each([
    ['a zero line', { event: 'e', items: [{ name: 'n', line: 0 }] }, 'items.0.line'],
    ['a fractional line', { event: 'e', items: [{ name: 'n', line: 1.5 }] }, 'items.0.line'],
    ['a non-numeric line', { event: 'e', items: [{ name: 'n', line: 'abc' }] }, 'items.0.line'],
    ['a missing top-level field', { items: [] }, 'event'],
  ])('rejects %s with a 400 naming the failing path', async (_label, body, path) => {
    const err = await rejectionOf(parseInboundPayload(PayloadDto, body));
    expect(err).toBeInstanceOf(ValidationAppException);
    expect(err.getStatus()).toBe(400);
    expect(err.args).toEqual({ param: path });
  });

  it.each([
    ['an array', []],
    ['null', null],
    ['a string', 'pipeline_failed'],
    ['undefined', undefined],
  ])('rejects %s body with a 400 on "body"', async (_label, body) => {
    const err = await rejectionOf(parseInboundPayload(PayloadDto, body));
    expect(err).toBeInstanceOf(ValidationAppException);
    expect(err.args).toEqual({ param: 'body' });
  });
});
