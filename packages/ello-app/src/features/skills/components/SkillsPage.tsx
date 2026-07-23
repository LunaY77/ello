import { ArrowLeft, RefreshCw, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import { refreshSkills, reloadSkills, resolveSkillsCwd, type SkillEntry } from '../skills';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/IconButton';
import { Spinner } from '@/components/ui/Spinner';
import { cn } from '@/lib/cn';
import { reportError } from '@/lib/report';
import { useAppStore } from '@/store/store';


/** 技能管理整页:目录网格 + 启停状态 + skills/changed 事件驱动重载。 */
export function SkillsPage() {
  const navigate = useNavigate();
  const skills = useAppStore((s) => s.entities.catalogs.skills);
  const revision = useAppStore((s) => s.entities.skillsRevision);
  const [cwd] = useState<string | null>(() => resolveSkillsCwd());
  const [loadedRevision, setLoadedRevision] = useState<number | null>(null);
  const [failure, setFailure] = useState<{ readonly revision: number; readonly message: string } | null>(null);

  const ready = useAppStore((s) => s.connection.phase === 'ready');

  useEffect(() => {
    if (cwd === null || !ready) return;
    let cancelled = false;
    void refreshSkills(cwd).then(
      () => {
        if (!cancelled) setLoadedRevision(revision);
      },
      (reason: unknown) => {
        reportError(reason);
        if (!cancelled) {
          setLoadedRevision(null);
          setFailure({
            revision,
            message: reason instanceof Error ? reason.message : String(reason),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ready, cwd, revision]);

  const error = failure?.revision === revision ? failure.message : null;
  const loading = ready && cwd !== null && loadedRevision !== revision && error === null;

  return (
    <div className="flex h-full flex-col bg-canvas">
      <header className="drag-region flex h-14 shrink-0 items-center gap-2 border-b border-border-subtle pr-4 pl-[76px]">
        <IconButton
          icon={<ArrowLeft size={16} />}
          tooltip="返回工作台"
          className="no-drag"
          onClick={() => void navigate('/')}
        />
        <h1 className="text-[15px] font-semibold">技能</h1>
        <div className="flex-1" />
        {cwd !== null && (
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw size={13} />}
            className="no-drag"
            onClick={() => {
              setFailure(null);
              void reloadSkills(cwd).catch((reason: unknown) => {
                reportError(reason);
                setLoadedRevision(null);
                setFailure({
                  revision,
                  message: reason instanceof Error ? reason.message : String(reason),
                });
              });
            }}
          >
            重新扫描
          </Button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-6 py-6">
          {loading && (
            <div className="flex h-40 items-center justify-center">
              <Spinner size={18} />
            </div>
          )}
          {!loading && error !== null && (
            <EmptyState
              icon={<Sparkles size={20} />}
              title="无法加载技能目录"
              description={error}
            />
          )}
          {!loading && error === null && cwd === null && (
            <EmptyState
              icon={<Sparkles size={20} />}
              title="需要工作目录"
              description="技能按项目解析。先打开一个会话或工作区,再回到这里。"
            />
          )}
          {!loading && error === null && cwd !== null && skills.length === 0 && (
            <EmptyState
              icon={<Sparkles size={20} />}
              title="没有发现技能"
              description={`在 ${cwd} 及其全局目录下没有找到技能定义。`}
            />
          )}
          {!loading && error === null && skills.length > 0 && (
            <div className="grid grid-cols-2 gap-3">
              {skills.map((skill) => (
                <SkillCard key={skill.id} skill={skill} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SkillCard(props: { readonly skill: SkillEntry }) {
  const { skill } = props;
  return (
    <div
      className={cn(
        'rounded-xl border border-card-border bg-card-bg p-4 shadow-card transition-colors duration-150',
        'hover:border-card-border-accent',
        !skill.enabled && 'opacity-60',
      )}
    >
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-fluent-subtle text-fluent">
          <Sparkles size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium text-primary">
            {skill.title ?? skill.name}
          </div>
          <div className="truncate font-mono text-[11px] text-tertiary">{skill.name}</div>
        </div>
        <Badge tone={skill.enabled ? 'success' : 'neutral'}>
          {skill.enabled ? '已启用' : '已停用'}
        </Badge>
      </div>
      {skill.description !== undefined && (
        <p className="mt-2 line-clamp-2 text-[12px] leading-5 text-secondary">
          {skill.description}
        </p>
      )}
      <div className="mt-2 font-mono text-[10.5px] text-disabled">{skill.id}</div>
    </div>
  );
}
