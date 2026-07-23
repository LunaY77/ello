import {
  TopBarCenter,
  TopBarLeading,
  TopBarTrailing,
  useOpenSelectedThreadEffect,
} from '../TopBarContent';

import { AppShell, TopBarFrame } from '@/components/layout/AppShell';
import { ApprovalQueue } from '@/features/approval';
import { Composer } from '@/features/composer';
import { WorkingSidebar } from '@/features/files';
import { ChatTimeline } from '@/features/timeline';
import { WorkspaceSidebar } from '@/features/workspace';


/** 主工作台:三栏布局 + 时间线 + 审批队列 + composer。 */
export function WorkbenchRoute() {
  useOpenSelectedThreadEffect();
  return (
    <AppShell
      topBar={
        <TopBarFrame
          leading={<TopBarLeading />}
          center={<TopBarCenter />}
          trailing={<TopBarTrailing />}
        />
      }
      sidebar={<WorkspaceSidebar />}
      rightPanel={<WorkingSidebar />}
    >
      <ChatTimeline />
      <ApprovalQueue />
      <Composer />
    </AppShell>
  );
}
