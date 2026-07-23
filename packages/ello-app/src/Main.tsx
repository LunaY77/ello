import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/app/App';

import '@/styles/globals.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root container #root is missing.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
