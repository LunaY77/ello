import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/storage/database/schema.ts',
  out: './src/storage/migrations',
});
