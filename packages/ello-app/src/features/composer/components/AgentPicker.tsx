import { Check, ChevronDown } from 'lucide-react';
import { useEffect } from 'react';

import { loadAgentCatalog } from '../composer';

import { Menu } from '@/components/ui/Menu';
import { setThreadAgent } from '@/features/thread';
import { cn } from '@/lib/cn';
import { runOperation } from '@/lib/report';
import { useAppStore } from '@/store/store';


/** agent 选择器(ActionBar 右侧,文字按钮 + 下拉);仅列可作 primary 的 agent。 */
export function AgentPicker(props: {
  readonly threadId: string;
  readonly cwd: string;
  readonly agent: string;
  readonly disabled?: boolean;
}) {
  const { threadId, cwd, agent, disabled = false } = props;
  const agents = useAppStore((s) => s.entities.catalogs.agents);
  const ready = useAppStore((s) => s.connection.phase === 'ready');

  const primaries = agents.filter(
    (entry) => entry.metadata.runtime === 'primary' && entry.enabled,
  );

  useEffect(() => {
    if (ready && agents.length === 0) {
      void runOperation(loadAgentCatalog(cwd));
    }
  }, [ready, cwd, agents.length]);

  const current = primaries.find((entry) => entry.id === agent);

  return (
    <Menu
      placement="bottom-end"
      width={260}
      trigger={({ toggle, ref }) => (
        <button
          ref={ref as React.Ref<HTMLButtonElement>}
          type="button"
          disabled={disabled}
          onClick={toggle}
          className={cn(
            'flex h-7 max-w-44 cursor-pointer items-center gap-1 rounded-md px-2 text-[12px] text-secondary',
            'transition-colors duration-150 hover:bg-surface-3 hover:text-primary',
            disabled && 'cursor-not-allowed opacity-50',
          )}
        >
          <span className="truncate">{current?.title ?? current?.name ?? agent}</span>
          <ChevronDown size={11} className="shrink-0 text-tertiary" />
        </button>
      )}
      items={primaries.map((entry) => ({
        id: entry.id,
        label: entry.title ?? entry.name,
        hint: entry.id === agent ? '当前' : undefined,
        icon:
          entry.id === agent ? <Check size={13} /> : <span className="w-[13px]" />,
      }))}
      onSelect={(id) => void runOperation(setThreadAgent(threadId, id))}
    />
  );
}
