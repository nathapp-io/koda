import axios, { AxiosInstance } from 'axios';

/**
 * Configure and return an Axios client with Bearer token authorization.
 * @param baseUrl API base URL (e.g., http://localhost:3100/api)
 * @param apiKey API key for Bearer token
 * @returns Configured AxiosInstance
 */
export function configureClient(baseUrl: string, apiKey: string): AxiosInstance {
  return axios.create({
    baseURL: baseUrl,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
}
