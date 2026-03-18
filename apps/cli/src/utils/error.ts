import { AxiosError } from 'axios';
import { error as outputError } from './output';

export function handleApiError(err: unknown): void {
  if (err instanceof AxiosError) {
    outputError(`API Error: ${err.message}`);
    if (err.response?.data) {
      outputError(JSON.stringify(err.response.data, null, 2));
    }
    process.exit(1);
  } else if (err instanceof Error) {
    outputError(err.message);
    process.exit(1);
  } else {
    outputError('Unknown error occurred');
    process.exit(1);
  }
}
