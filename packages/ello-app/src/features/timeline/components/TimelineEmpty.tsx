import { Bug, MessageSquarePlus, SearchCode, Wand2 } from 'lucide-react';

import { ElloMark } from './TurnView';

import { Button } from '@/components/ui/Button';
import { Kbd } from '@/components/ui/Kbd';
import { newThreadInContext } from '@/features/thread';
import { runOperation } from '@/lib/report';
import {
  useRequestComposerPrefill,
  useSelectedWorkspace,
} from '@/store/store';


const EXAMPLES = [
  { icon: Wand2, text: '给这个仓库的用户登录加上验证码校验' },
  { icon: Bug, text: '排查最近的 CI 失败并修复' },
  { icon: SearchCode, text: '解释这个项目的鉴权流程是怎么串起来的' },
] as const;

/** 空状态:无会话(品牌区)与新会话(引导卡)。 */
export function TimelineEmpty(props: {
  readonly variant: 'no-thread' | 'empty-thread';
}) {
  const workspace = useSelectedWorkspace();

  if (props.variant === 'no-thread') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-5 p-8">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-[#2b9fff] to-[#005a9e] text-[34px] font-bold text-white shadow-2 dark:from-[#60cdff] dark:to-[#106ebe] dark:text-[#0a1a26]">
          e
        </div>
        <div className="text-center">
          <div className="text-xl font-semibold tracking-tight">ello</div>
          <div className="mt-1 text-[13px] text-tertiary">
            你的编码搭档。选择一个会话,或开始一个新任务。
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            icon={<MessageSquarePlus size={15} />}
            onClick={() => void runOperation(newThreadInContext())}
          >
            新建会话
          </Button>
        </div>
        <div className="mt-2 flex items-center gap-4 text-[11px] text-tertiary">
          <span className="flex items-center gap-1.5">
            <Kbd keys="⌘K" /> 命令面板
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd keys="⌘B" /> 侧栏
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd keys="⌘J" /> 工作面板
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 p-8">
      <ElloMark />
      <div className="text-center">
        <div className="text-[15px] font-semibold">开始吧</div>
        <div className="mt-1 text-[12.5px] text-tertiary">
          {workspace !== undefined
            ? `在 ${workspace.kind}/${workspace.name} 中工作 — 描述任务,剩下的交给 ello。`
            : '描述你想要的更改,ello 会完成它。'}
        </div>
      </div>
      <div className="flex w-full max-w-md flex-col gap-2">
        {EXAMPLES.map((example) => (
          <ExampleCard key={example.text} icon={example.icon} text={example.text} />
        ))}
      </div>
      <div className="text-[11px] text-tertiary">
        会话模式决定 ello 的自主权:用 <Kbd keys="⇧Tab" className="mx-0.5" /> 在输入区循环切换。
      </div>
    </div>
  );
}

function ExampleCard(props: {
  readonly icon: typeof Wand2;
  readonly text: string;
}) {
  const requestComposerPrefill = useRequestComposerPrefill();
  return (
    <button
      type="button"
      onClick={() => requestComposerPrefill(props.text)}
      className="flex cursor-pointer items-center gap-3 rounded-lg border border-border-subtle bg-surface-1 px-4 py-3 text-left text-[13px] text-secondary shadow-card transition-colors duration-150 hover:border-card-border-accent hover:text-primary"
    >
      <props.icon size={15} className="shrink-0 text-fluent" />
      {props.text}
    </button>
  );
}
