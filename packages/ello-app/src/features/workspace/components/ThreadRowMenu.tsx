import type { ThreadSummary } from '@ello/agent/protocol';
import {
  Archive,
  ArchiveRestore,
  Download,
  GitBranch,
  MoreHorizontal,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';


import { getAppClient } from '@/client/session';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { IconButton } from '@/components/ui/IconButton';
import { Menu } from '@/components/ui/Menu';
import { toast } from '@/components/ui/Toasts';
import {
  archiveThread,
  deleteThread,
  forkThread,
  unarchiveThread,
} from '@/features/thread';
import { runOperation } from '@/lib/report';

/** 会话行 hover 浮现的 ⋯ 菜单:归档 / 导出 / 派生 / 删除(确认弹窗)。 */
export function ThreadRowMenu(props: { readonly thread: ThreadSummary }) {
  const { thread } = props;
  const [confirmDelete, setConfirmDelete] = useState(false);

  const exportThread = async () => {
    const result = await getAppClient().request('thread/export', {
      threadId: thread.id,
      format: 'markdown',
    });
    if (result.kind === 'inline') {
      await navigator.clipboard.writeText(result.content);
      toast.success('会话已导出为 Markdown', '内容已复制到剪贴板');
      return;
    }
    toast.success('会话已导出', result.artifactId);
  };

  return (
    <>
      <Menu
        placement="bottom-end"
        width={200}
        trigger={({ toggle, ref }) => (
          <span ref={ref}>
            <IconButton
              icon={<MoreHorizontal size={14} />}
              tooltip="会话操作"
              size={24}
              onClick={toggle}
            />
          </span>
        )}
        items={[
          thread.archived
            ? { id: 'unarchive', label: '取消归档', icon: <ArchiveRestore size={14} /> }
            : { id: 'archive', label: '归档', icon: <Archive size={14} /> },
          { id: 'export', label: '导出 Markdown', icon: <Download size={14} /> },
          { id: 'fork', label: '派生分支', icon: <GitBranch size={14} /> },
          { id: 'delete', label: '删除', icon: <Trash2 size={14} />, danger: true },
        ]}
        onSelect={(id) => {
          if (id === 'archive') void runOperation(archiveThread(thread.id));
          if (id === 'unarchive') void runOperation(unarchiveThread(thread.id));
          if (id === 'export') void runOperation(exportThread());
          if (id === 'fork') void runOperation(forkThread(thread.id));
          if (id === 'delete') setConfirmDelete(true);
        }}
      />
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="删除会话"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmDelete(false);
                void runOperation(deleteThread(thread.id));
              }}
            >
              删除
            </Button>
          </>
        }
      >
        会话及其全部回合记录将被永久删除,此操作不可撤销。
      </Dialog>
    </>
  );
}
