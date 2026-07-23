import { createHashRouter, Outlet, RouterProvider } from 'react-router';

import { ConnectionGate } from './ConnectionGate';
import { WorkbenchRoute } from './routes/WorkbenchRoute';

import { ToastHost } from '@/components/ui/Toasts';
import { CommandPalette } from '@/features/command-palette';
import { SettingsPage } from '@/features/settings';
import { SkillsPage } from '@/features/skills';


/** 根布局:页面出口 + 全局浮层(命令面板依赖路由上下文,必须挂在 Router 内)。 */
function RootLayout() {
  return (
    <>
      <Outlet />
      <CommandPalette />
      <ToastHost />
    </>
  );
}

const router = createHashRouter([
  {
    element: <RootLayout />,
    children: [
      {
        path: '/',
        element: (
          <ConnectionGate>
            <WorkbenchRoute />
          </ConnectionGate>
        ),
      },
      {
        path: '/skills',
        element: (
          <ConnectionGate>
            <SkillsPage />
          </ConnectionGate>
        ),
      },
      {
        path: '/settings',
        element: <SettingsPage />,
      },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
