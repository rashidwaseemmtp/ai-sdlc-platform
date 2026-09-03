/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // The dashboard talks only to the API — never directly to the database or Temporal (docs/01 §6).
  env: { API_BASE: process.env.API_BASE ?? 'http://localhost:3001/api/v1' },
};
