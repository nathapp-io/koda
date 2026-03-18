import axios, { AxiosInstance } from 'axios';

export function configureClient(apiUrl: string, token: string): AxiosInstance {
  const client = axios.create({
    baseURL: apiUrl,
    headers: {
      common: {
        Authorization: `Bearer ${token}`,
      },
    },
  });

  return client;
}
