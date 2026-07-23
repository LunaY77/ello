import { Check, ChevronDown } from 'lucide-react';
import { useEffect } from 'react';

import { loadModelCatalog, modelDisplayName } from '../composer';

import { Menu } from '@/components/ui/Menu';
import { setThreadModel } from '@/features/thread';
import { cn } from '@/lib/cn';
import { runOperation } from '@/lib/report';
import { useAppStore } from '@/store/store';


/** 模型选择器(ActionBar 右侧,文字按钮 + 下拉)。 */
export function ModelPicker(props: {
  readonly threadId: string;
  readonly cwd: string;
  readonly model: string;
  readonly disabled?: boolean;
}) {
  const { threadId, cwd, model, disabled = false } = props;
  const models = useAppStore((s) => s.entities.catalogs.models);
  const ready = useAppStore((s) => s.connection.phase === 'ready');

  useEffect(() => {
    if (ready && models.length === 0) {
      void runOperation(loadModelCatalog(cwd));
    }
  }, [ready, cwd, models.length]);

  const current = models.find((entry) => entry.id === model || entry.name === model);

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
          <span className="truncate">{modelDisplayName(current, model)}</span>
          <ChevronDown size={11} className="shrink-0 text-tertiary" />
        </button>
      )}
      items={models.map((entry) => ({
        id: entry.id,
        label: modelDisplayName(entry, entry.name),
        hint: entry.id === model ? '当前' : undefined,
        icon:
          entry.id === model ? <Check size={13} /> : <span className="w-[13px]" />,
      }))}
      onSelect={(id) => void runOperation(setThreadModel(threadId, id))}
    />
  );
}
