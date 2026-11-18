import { ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { exceptionResponse } from './dispatch-error';

describe('exceptionResponse', () => {
  it('AC-1: extracts the prefix from a conflict exception', () => {
    expect(exceptionResponse(new ConflictAppException({}, 'fleet.jobs')).prefix).toBe('fleet.jobs');
  });

  it('AC-2: extracts validation arguments', () => {
    expect(exceptionResponse(new ValidationAppException({ reason: 'repo_unavailable' }, 'fleet.jobs')).args?.reason)
      .toBe('repo_unavailable');
  });

  it('AC-3: returns an empty object for a plain Error', () => {
    expect(exceptionResponse(new Error('plain'))).toEqual({});
  });
});
