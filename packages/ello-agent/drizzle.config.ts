import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/infra/database/schema.ts',
  out: './src/infra/database/migrations',
});
