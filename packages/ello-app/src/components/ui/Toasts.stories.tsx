import type { Meta, StoryObj } from '@storybook/react';

import { toast, ToastHost } from './Toasts';

import { Button } from '@/components/ui/Button';
import { Padded } from '@/testing/Storybook';


const meta = {
  title: 'UI/Toasts',
  component: ToastHost,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof ToastHost>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 右下角堆叠,最长 5 条;danger 停留 8s,其余 5s。 */
export const Tones: Story = {
  render: () => (
    <Padded>
      <div className="flex items-center gap-2">
        <Button variant="secondary" onClick={() => toast.info('会话已归档')}>
          info
        </Button>
        <Button variant="secondary" onClick={() => toast.success('已复制到剪贴板')}>
          success
        </Button>
        <Button
          variant="secondary"
          onClick={() => toast.warning('上下文使用已超过 80%', '建议尽快收尾当前回合')}
        >
          warning
        </Button>
        <Button
          variant="secondary"
          onClick={() => toast.danger('服务端拒绝了请求', 'turnMismatch: turn 已完成,不能再 steer')}
        >
          danger
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            toast.action('会话已删除', {
              label: '撤销',
              onClick: () => toast.info('已恢复'),
            })
          }
        >
          带撤销
        </Button>
      </div>
      <ToastHost />
    </Padded>
  ),
};
