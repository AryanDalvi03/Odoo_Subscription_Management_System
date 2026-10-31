import axios from 'axios';
export const errorMessage = (error: unknown) =>
  axios.isAxiosError(error)
    ? (error.response?.data?.error?.message ?? 'Could not connect. Please try again.')
    : error instanceof Error
      ? error.message
      : 'Something went wrong';
