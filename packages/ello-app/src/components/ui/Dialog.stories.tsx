import type { Meta, StoryObj } from '@storybook/react';
import { fn } from '@storybook/test';
import { useState } from 'react';

import { Dialog } from './Dialog';

import { Button } from '@/components/ui/Button';
import { Padded } from '@/testing/Storybook';


const meta = {
  title: 'UI/Dialog',
  component: Dialog,
  args: { open: false, onClose: fn(), title: 'Dialog', children: null },
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

function DestructiveConfirmStory(props: { readonly onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Padded>
      <Button variant="danger" onClick={() => setOpen(true)}>
        删除会话
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          props.onClose();
        }}
        title="删除会话"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button variant="danger" onClick={() => setOpen(false)}>
              删除
            </Button>
          </>
        }
      >
        会话及其全部回合记录将被永久删除,此操作不可撤销。
      </Dialog>
    </Padded>
  );
}

function LongContentStory(props: { readonly onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Padded>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        启用 bypass 模式
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          props.onClose();
        }}
        title="启用 bypass 模式"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button variant="danger" onClick={() => setOpen(false)}>
              启用 bypass
            </Button>
          </>
        }
      >
        bypass 模式下 ello 将自动执行所有命令与文件修改,不再请求你的许可。
        这包括读取、写入、删除工作区内的任何文件,以及以你的身份运行任意
        shell 命令。仅在你完全信任当前任务且已经审阅过计划时启用。
      </Dialog>
    </Padded>
  );
}

/** 模态只用于低频不可逆操作;Esc 或点击 scrim 关闭。 */
export const DestructiveConfirm: Story = {
  args: { onClose: fn() },
  render: (args) => <DestructiveConfirmStory onClose={args.onClose} />,
};

export const LongContent: Story = {
  args: { onClose: fn() },
  render: (args) => <LongContentStory onClose={args.onClose} />,
};
