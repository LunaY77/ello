import { ArrowLeft, Check, Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { APP_VERSION, startSession } from '@/client/session';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { cn } from '@/lib/cn';
import { runOperation } from '@/lib/report';
import type { ThemePreference } from '@/lib/theme/theme';
import { useAppStore, useSetEnterToSend, useSetTheme } from '@/store/store';

const SECTIONS = [
  { id: 'appearance', label: '外观' },
  { id: 'editor', label: '编辑器' },
  { id: 'connection', label: '连接' },
  { id: 'about', label: '关于' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

/** 设置整页路由:分类导航 + 主题预览卡 + 连接信息。 */
export function SettingsPage() {
  const navigate = useNavigate();
  const [section, setSection] = useState<SectionId>('appearance');

  return (
    <div className="flex h-full flex-col bg-canvas">
      <header className="drag-region flex h-14 shrink-0 items-center gap-2 border-b border-border-subtle pr-4 pl-[76px]">
        <IconButton
          icon={<ArrowLeft size={16} />}
          tooltip="返回工作台"
          className="no-drag"
          onClick={() => void navigate('/')}
        />
        <h1 className="text-[15px] font-semibold">设置</h1>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="w-44 shrink-0 border-r border-border-subtle p-2">
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setSection(entry.id)}
              className={cn(
                'flex h-8 w-full cursor-pointer items-center rounded-md px-2.5 text-[13px] transition-colors duration-150',
                section === entry.id
                  ? 'bg-sidebar-active font-medium text-primary'
                  : 'text-secondary hover:bg-sidebar-hover',
              )}
            >
              {entry.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-xl px-8 py-6">
            {section === 'appearance' && <AppearanceSection />}
            {section === 'editor' && <EditorSection />}
            {section === 'connection' && <ConnectionSection />}
            {section === 'about' && <AboutSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionTitle(props: { readonly title: string; readonly description: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-[16px] font-semibold">{props.title}</h2>
      <p className="mt-0.5 text-[12px] text-tertiary">{props.description}</p>
    </div>
  );
}

function AppearanceSection() {
  const theme = useAppStore((s) => s.preferences.theme);
  return (
    <>
      <SectionTitle title="外观" description="主题切换即时生效,所有组件零硬编码色值。" />
      <div className="grid grid-cols-3 gap-3">
        <ThemeCard
          id="light"
          label="浅色"
          icon={<Sun size={16} />}
          selected={theme === 'light'}
          previewClass="bg-[#f3f3f3]"
          surfaceClass="bg-white"
          textClass="bg-[#1a1a1a]"
        />
        <ThemeCard
          id="dark"
          label="深色"
          icon={<Moon size={16} />}
          selected={theme === 'dark'}
          previewClass="bg-[#202020]"
          surfaceClass="bg-[#2b2b2b]"
          textClass="bg-white"
        />
        <ThemeCard
          id="system"
          label="跟随系统"
          icon={<Monitor size={16} />}
          selected={theme === 'system'}
          previewClass="bg-gradient-to-br from-[#f3f3f3] from-50% to-[#202020] to-50%"
          surfaceClass="bg-[#8a8a8a]"
          textClass="bg-[#444]"
        />
      </div>
    </>
  );
}

function ThemeCard(props: {
  readonly id: ThemePreference;
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly selected: boolean;
  readonly previewClass: string;
  readonly surfaceClass: string;
  readonly textClass: string;
}) {
  const setTheme = useSetTheme();
  return (
    <button
      type="button"
      onClick={() => setTheme(props.id)}
      className={cn(
        'cursor-pointer rounded-xl border-2 p-2 text-left transition-colors duration-150',
        props.selected
          ? 'border-card-border-accent'
          : 'border-border-subtle hover:border-border-default',
      )}
    >
      <div className={cn('flex h-16 flex-col gap-1 rounded-lg p-2', props.previewClass)}>
        <div className={cn('h-2.5 w-3/4 rounded-sm', props.surfaceClass)} />
        <div className={cn('h-1.5 w-1/2 rounded-sm', props.textClass, 'opacity-70')} />
        <div className={cn('h-1.5 w-2/3 rounded-sm', props.textClass, 'opacity-40')} />
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 px-0.5 text-[12px] text-secondary">
        {props.icon}
        {props.label}
        {props.selected && <Check size={12} className="ml-auto text-fluent" />}
      </div>
    </button>
  );
}

function EditorSection() {
  const enterToSend = useAppStore((s) => s.preferences.enterToSend);
  const setEnterToSend = useSetEnterToSend();
  return (
    <>
      <SectionTitle title="编辑器" description="输入与发送行为。" />
      <div className="flex items-center justify-between rounded-lg border border-border-subtle bg-surface-1 px-4 py-3">
        <div>
          <div className="text-[13px] text-primary">Enter 发送消息</div>
          <div className="text-[11.5px] text-tertiary">
            开启:Enter 发送,Shift+Enter 换行;关闭:⌘Enter 发送。
          </div>
        </div>
        <Switch checked={enterToSend} onChange={setEnterToSend} />
      </div>
    </>
  );
}

function ConnectionSection() {
  const connection = useAppStore((s) => s.connection);
  return (
    <>
      <SectionTitle title="连接" description="ello-app 与 ello-agent sidecar 的 JSON-RPC 连接。" />
      <div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-1 px-4 py-3 text-[12.5px]">
        <Row label="状态" value={connection.phase} />
        <Row label="服务端" value={connection.serverInfo?.name ?? '—'} />
        <Row label="服务端版本" value={connection.serverInfo?.version ?? '—'} />
        {connection.fatalError !== null && (
          <div className="rounded-md bg-danger-subtle px-2.5 py-2 font-mono text-[11.5px] text-danger">
            {connection.fatalError}
          </div>
        )}
        <div className="pt-1">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void runOperation(startSession())}
          >
            重新连接
          </Button>
        </div>
      </div>
    </>
  );
}

function AboutSection() {
  return (
    <>
      <SectionTitle title="关于" description="版本信息。" />
      <div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-1 px-4 py-3 text-[12.5px]">
        <Row label="ello" value={APP_VERSION} />
        <Row label="协议版本" value="1" />
      </div>
    </>
  );
}

function Row(props: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-tertiary">{props.label}</span>
      <span className="font-mono text-[12px] text-primary">{props.value}</span>
    </div>
  );
}

function Switch(props: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      onClick={() => props.onChange(!props.checked)}
      className={cn(
        'relative h-5.5 w-10 cursor-pointer rounded-full transition-colors duration-200',
        props.checked ? 'bg-fluent' : 'bg-surface-3 border border-border-default',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow-1 transition-transform duration-200',
          props.checked ? 'translate-x-5' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
